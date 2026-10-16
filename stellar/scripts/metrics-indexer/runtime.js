// Poll scheduling and health reporting.
//
// Two guarantees this module exists to provide:
//
//   1. Polls never overlap. The loop awaits each run before scheduling the
//      next, and `runOnce` refuses to start a second run while one is in
//      flight. A slow poll therefore delays the next tick instead of stacking
//      concurrent RPC work.
//   2. Failures are visible but bounded. Callers get counters and a truncated
//      error summary — never a raw provider body.

import { truncate } from './redact.js';

const DEFAULT_ERROR_LENGTH = 200;

/**
 * Turn any thrown value into a short, bounded, log-safe string.
 *
 * @param {unknown} error
 * @param {number} [maxLength]
 * @returns {string}
 */
export function summarizeError(error, maxLength = DEFAULT_ERROR_LENGTH) {
  if (error === null || error === undefined) {
    return 'unknown error';
  }
  if (typeof error === 'string') {
    return truncate(error, maxLength);
  }
  const name = error.name || 'Error';
  const message = error.message === undefined ? String(error) : String(error.message);
  return `${name}: ${truncate(message, maxLength)}`;
}

/**
 * Derive the public health snapshot from poll stats.
 *
 * `healthy` requires a recent successful poll with no failures. Partial
 * failures, staleness, or a single total failure surface as `degraded`;
 * reaching the failure threshold is `unhealthy`.
 *
 * @param {object} input
 * @returns {object}
 */
export function deriveHealthState({
  now,
  startedAt,
  stats,
  lastFailures = 0,
  lastError = null,
  staleAfterMs,
  failureThreshold,
  rpcHost,
  pollIntervalMs,
}) {
  const hasSucceeded = Number.isFinite(stats.lastSuccessAt);
  const stale = !hasSucceeded || now - stats.lastSuccessAt > staleAfterMs;

  let status = 'healthy';
  if (stats.consecutiveFailures >= failureThreshold) {
    status = 'unhealthy';
  } else if (stats.consecutiveFailures > 0 || lastFailures > 0 || stale) {
    status = 'degraded';
  }

  return {
    status,
    stale,
    uptimeMs: Math.max(0, now - startedAt),
    pollIntervalMs,
    rpcHost,
    lastSuccessAt: hasSucceeded ? stats.lastSuccessAt : null,
    lastError: lastError ?? null,
    consecutiveFailures: stats.consecutiveFailures,
    polls: {
      total: stats.polls,
      failed: stats.failures,
      skipped: stats.skipped,
      lastDurationMs: stats.lastDurationMs,
    },
  };
}

/**
 * Create a serialized poller.
 *
 * @param {object} options
 * @param {number} options.intervalMs Target gap between poll *starts*.
 * @param {() => Promise<unknown>} options.run The poll body.
 * @param {() => number} [options.now] Injectable clock (tests).
 * @param {(ms: number) => Promise<void>} [options.sleep] Injectable wait.
 * @param {(error: unknown) => void} [options.onError] Failure observer.
 */
export function createPoller({ intervalMs, run, now = () => Date.now(), sleep, onError } = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('createPoller requires a run function');
  }

  const stats = {
    polls: 0,
    failures: 0,
    skipped: 0,
    consecutiveFailures: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    lastSuccessAt: null,
    lastErrorAt: null,
  };

  let inFlight = false;
  let loopRunning = false;
  let stopped = false;
  let loopPromise = null;
  let wakeUp = null;

  async function runOnce() {
    if (inFlight) {
      stats.skipped += 1;
      return { skipped: true };
    }

    inFlight = true;
    const startedAt = now();
    stats.polls += 1;
    stats.lastStartedAt = startedAt;

    try {
      const result = await run();
      stats.lastSuccessAt = now();
      stats.consecutiveFailures = 0;
      return { skipped: false, result };
    } catch (error) {
      stats.failures += 1;
      stats.consecutiveFailures += 1;
      stats.lastErrorAt = now();
      stats.lastError = error;
      if (onError) {
        onError(error);
      }
      return { skipped: false, error };
    } finally {
      inFlight = false;
      stats.lastFinishedAt = now();
      stats.lastDurationMs = stats.lastFinishedAt - startedAt;
    }
  }

  function wait(ms) {
    if (typeof sleep === 'function') {
      return sleep(ms);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async function loop() {
    while (!stopped) {
      await runOnce();
      if (stopped) {
        break;
      }
      // Measure the gap from the poll's start so a slow run eats into (rather
      // than stacks on top of) the interval.
      await wait(Math.max(0, intervalMs - (stats.lastDurationMs ?? 0)));
      wakeUp = null;
    }
    loopRunning = false;
  }

  function start() {
    if (loopRunning) {
      return false;
    }
    stopped = false;
    loopRunning = true;
    loopPromise = loop();
    return true;
  }

  async function stop() {
    stopped = true;
    if (wakeUp) {
      wakeUp();
      wakeUp = null;
    }
    await loopPromise;
  }

  return {
    start,
    stop,
    runOnce,
    stats,
    get inFlight() {
      return inFlight;
    },
    get running() {
      return loopRunning;
    },
  };
}

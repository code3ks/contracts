import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { redactUrl, truncate } from './redact.js';
import { createPoller, deriveHealthState, summarizeError } from './runtime.js';

const baseStats = {
  polls: 4,
  failures: 0,
  skipped: 0,
  consecutiveFailures: 0,
  lastDurationMs: 12,
  lastSuccessAt: 9_000,
};

describe('createPoller', () => {
  it('never overlaps two polls and skips concurrent manual runs', async () => {
    let active = 0;
    let maxActive = 0;

    const run = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    };

    const poller = createPoller({ intervalMs: 1, run, sleep: () => Promise.resolve() });

    const [first, second] = await Promise.all([poller.runOnce(), poller.runOnce()]);

    assert.equal(maxActive, 1);
    assert.equal(poller.stats.polls, 1);
    assert.equal(poller.stats.skipped, 1);
    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
  });

  it('serializes scheduled polls and shuts down cleanly', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;

    const poller = createPoller({
      intervalMs: 5,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });

    assert.equal(poller.start(), true);
    assert.equal(poller.start(), false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await poller.stop();

    assert.ok(runs >= 1);
    assert.equal(maxActive, 1);
    assert.equal(poller.running, false);
    assert.equal(poller.inFlight, false);
  });

  it('counts failures and clears the streak on the next success', async () => {
    let shouldFail = true;
    const poller = createPoller({
      intervalMs: 1,
      run: async () => {
        if (shouldFail) {
          throw new Error('rpc down');
        }
        return 'ok';
      },
      sleep: () => Promise.resolve(),
    });

    await poller.runOnce();
    await poller.runOnce();
    assert.equal(poller.stats.consecutiveFailures, 2);
    assert.equal(poller.stats.failures, 2);

    shouldFail = false;
    await poller.runOnce();
    assert.equal(poller.stats.consecutiveFailures, 0);
    assert.equal(poller.stats.failures, 2);
  });
});

describe('deriveHealthState', () => {
  const shared = {
    now: 10_000,
    startedAt: 0,
    staleAfterMs: 5_000,
    failureThreshold: 3,
    rpcHost: 'https://rpc.example.com',
    pollIntervalMs: 1000,
  };

  it('reports healthy after a recent successful poll', () => {
    const health = deriveHealthState({ ...shared, stats: { ...baseStats }, lastFailures: 0 });

    assert.equal(health.status, 'healthy');
    assert.equal(health.stale, false);
    assert.equal(health.lastSuccessAt, 9_000);
    assert.equal(health.rpcHost, 'https://rpc.example.com');
    assert.deepEqual(health.polls, { total: 4, failed: 0, skipped: 0, lastDurationMs: 12 });
    assert.equal(health.lastError, null);
  });

  it('reports degraded when the last success is stale', () => {
    const health = deriveHealthState({
      ...shared,
      stats: { ...baseStats, lastSuccessAt: 1_000 },
      lastFailures: 0,
    });

    assert.equal(health.status, 'degraded');
    assert.equal(health.stale, true);
  });

  it('reports degraded on a partial contract failure', () => {
    const health = deriveHealthState({
      ...shared,
      stats: { ...baseStats, lastSuccessAt: 9_500 },
      lastFailures: 1,
      lastError: { message: 'RpcTimeoutError: RPC getEvents timed out after 10000ms', at: 9_600 },
    });

    assert.equal(health.status, 'degraded');
    assert.ok(health.lastError.message.length < 200);
  });

  it('reports unhealthy once the failure threshold is reached', () => {
    const health = deriveHealthState({
      ...shared,
      stats: { ...baseStats, failures: 3, consecutiveFailures: 3, lastSuccessAt: 1_000 },
      lastFailures: 2,
    });

    assert.equal(health.status, 'unhealthy');
    assert.equal(health.consecutiveFailures, 3);
    assert.equal(health.polls.failed, 3);
  });

  it('reports degraded before the very first success', () => {
    const health = deriveHealthState({
      ...shared,
      stats: { ...baseStats, polls: 0, lastSuccessAt: null },
      lastFailures: 0,
    });

    assert.equal(health.status, 'degraded');
    assert.equal(health.lastSuccessAt, null);
  });
});

describe('redaction and truncation', () => {
  it('drops credentials, path secrets, query, and fragment from URLs', () => {
    assert.equal(
      redactUrl('https://user:pass@rpc.example.com/v1/secret-key?api_key=abc#frag'),
      'https://rpc.example.com'
    );
    assert.equal(redactUrl('http://localhost:9090'), 'http://localhost:9090');
    assert.equal(redactUrl('not a url'), '<invalid-url>');
    assert.equal(redactUrl(''), '<unset>');
    assert.equal(redactUrl(undefined), '<unset>');
  });

  it('bounds long strings', () => {
    const out = truncate('a'.repeat(1000), 100);
    assert.ok(out.startsWith('a'.repeat(100)));
    assert.ok(out.length < 200);
  });

  it('summarizes errors without exposing unbounded messages', () => {
    const long = new Error('z'.repeat(5000));
    const summary = summarizeError(long);
    assert.ok(summary.startsWith('Error: zzz'));
    assert.ok(summary.length < 400);
    assert.equal(summarizeError(null), 'unknown error');
  });
});

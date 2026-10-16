import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nativeToScVal, xdr, scValToNative } from '@stellar/stellar-sdk';

import {
  RpcAbortError,
  RpcHttpError,
  RpcProtocolError,
  RpcResponseTooLargeError,
  RpcTimeoutError,
  createRpcClient,
} from './rpc-client.js';

function jsonResponse(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const symbol = (value) => xdr.ScVal.scvSymbol(value).toXDR('base64');

// A WraithMetricEvent-shaped value: vec[i128, vec[vec[symbol, i128]]].
function encodedMetricValue(value, dimensions) {
  const encodedValue = nativeToScVal(value, { type: 'i128' });
  const entries = dimensions.map(([key, val]) =>
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(key), nativeToScVal(val, { type: 'i128' })])
  );
  return xdr.ScVal.scvVec([encodedValue, xdr.ScVal.scvVec(entries)]).toXDR('base64');
}

describe('createRpcClient', () => {
  it('decodes base64 ScVal topics and values into native events', async () => {
    const value = encodedMetricValue(3, [['scheme_id', 1]]);
    const raw = {
      latestLedger: 42,
      events: [
        {
          type: 'contract',
          ledger: 41,
          contractId: 'C'.repeat(56),
          id: '0000000001',
          topic: [symbol('metric'), symbol('st_reg'), symbol('reg_cnt')],
          value,
        },
      ],
    };

    let captured;
    const client = createRpcClient({
      url: 'https://rpc.example.com/v1/secret?api_key=abc',
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return jsonResponse(raw);
      },
      sleep: async () => {},
    });

    const response = await client.getEvents({ filters: [], cursor: '5', limit: 100 });

    assert.equal(response.latestLedger, 42);
    assert.deepEqual(response.events[0].topic, ['metric', 'st_reg', 'reg_cnt']);
    assert.equal(String(response.events[0].value[0]), '3');
    assert.equal(response.events[0].value[1][0][0], 'scheme_id');

    const body = JSON.parse(captured.init.body);
    assert.equal(body.method, 'getEvents');
    assert.deepEqual(body.params.pagination, { cursor: '5', limit: 100 });
    assert.equal(captured.init.method, 'POST');
  });

  it('aborts a hung request at the timeout and retries up to the budget', async () => {
    let attempts = 0;
    const delays = [];

    const client = createRpcClient({
      url: 'https://rpc.example.com',
      timeoutMs: 20,
      maxAttempts: 3,
      retryBaseMs: 5,
      retryMaxMs: 5,
      random: () => 1,
      fetchImpl: (url, init) => {
        attempts += 1;
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await assert.rejects(client.getLatestLedger(), (error) => {
      assert.ok(error instanceof RpcTimeoutError);
      assert.equal(error.retryable, true);
      return true;
    });

    assert.equal(attempts, 3);
    assert.equal(delays.length, 2);
  });

  it('retries transient failures with bounded jittered backoff, then succeeds', async () => {
    let attempts = 0;
    const delays = [];

    const client = createRpcClient({
      url: 'https://rpc.example.com',
      maxAttempts: 5,
      retryBaseMs: 100,
      retryMaxMs: 1000,
      random: () => 0.5,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response('overloaded', { status: 503 });
        }
        return jsonResponse({ status: 'healthy' });
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.getLatestLedger();

    assert.equal(result.status, 'healthy');
    assert.equal(attempts, 3);
    // Full jitter: floor(0.5 * 100) then floor(0.5 * 200); never above the cap.
    assert.deepEqual(delays, [50, 100]);
    assert.ok(delays.every((delay) => delay <= 1000));
  });

  it('does not retry a non-retryable client error', async () => {
    let attempts = 0;

    const client = createRpcClient({
      url: 'https://rpc.example.com',
      fetchImpl: async () => {
        attempts += 1;
        return new Response('bad request', { status: 400 });
      },
      sleep: async () => {
        throw new Error('sleep should not be called for a non-retryable error');
      },
    });

    await assert.rejects(client.getLatestLedger(), (error) => {
      assert.ok(error instanceof RpcHttpError);
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      return true;
    });

    assert.equal(attempts, 1);
  });

  it('refuses to read an unbounded provider body', async () => {
    const client = createRpcClient({
      url: 'https://rpc.example.com',
      maxResponseBytes: 32,
      fetchImpl: async () => new Response('x'.repeat(4096), { status: 200 }),
      sleep: async () => {},
    });

    await assert.rejects(client.getLatestLedger(), (error) => {
      assert.ok(error instanceof RpcResponseTooLargeError);
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController();
    let attempts = 0;

    const client = createRpcClient({
      url: 'https://rpc.example.com',
      timeoutMs: 10_000,
      maxAttempts: 5,
      fetchImpl: (url, init) => {
        attempts += 1;
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
      sleep: async () => {},
    });

    const pending = client.getLatestLedger({ signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof RpcAbortError);
      return true;
    });
    assert.equal(attempts, 1);
  });

  it('truncates error bodies instead of echoing them whole', async () => {
    const client = createRpcClient({
      url: 'https://rpc.example.com',
      fetchImpl: async () => new Response('y'.repeat(10_000), { status: 500 }),
      sleep: async () => {},
      maxAttempts: 1,
    });

    await assert.rejects(client.getLatestLedger(), (error) => {
      assert.ok(error instanceof RpcHttpError);
      assert.ok(error.bodyPreview.length < 400);
      return true;
    });
  });

  it('rejects a 200 response that carries neither result nor error', async () => {
    // Regression: `{"jsonrpc":"2.0","id":1}` used to resolve to `undefined`,
    // which became a successful empty page and let /health stay healthy while
    // no events were ever indexed.
    let attempts = 0;
    const client = createRpcClient({
      url: 'https://rpc.example.com',
      fetchImpl: async () => {
        attempts += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });

    await assert.rejects(client.getEvents({ filters: [] }), (error) => {
      assert.ok(error instanceof RpcProtocolError);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(attempts, 1);
  });

  it('rejects a response whose id does not match the request', async () => {
    const client = createRpcClient({
      url: 'https://rpc.example.com',
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 99, result: { events: [] } }), {
          status: 200,
        }),
      sleep: async () => {},
    });

    await assert.rejects(client.getLatestLedger(), (error) => {
      assert.ok(error instanceof RpcProtocolError);
      return true;
    });
  });

  it('rejects a non-JSON 200 body instead of treating it as empty', async () => {
    const client = createRpcClient({
      url: 'https://rpc.example.com',
      fetchImpl: async () => new Response('<html>origin error</html>', { status: 200 }),
      sleep: async () => {},
    });

    await assert.rejects(client.getEvents({ filters: [] }), (error) => {
      assert.ok(error instanceof RpcProtocolError);
      return true;
    });
  });

  it('rejects a getEvents result without an events array', async () => {
    const client = createRpcClient({
      url: 'https://rpc.example.com',
      fetchImpl: async () => jsonResponse({ latestLedger: 7 }),
      sleep: async () => {},
    });

    await assert.rejects(client.getEvents({ filters: [] }), (error) => {
      assert.ok(error instanceof RpcProtocolError);
      return true;
    });
  });

  it('rejects a getEvents result without a latestLedger', async () => {
    const client = createRpcClient({
      url: 'https://rpc.example.com',
      fetchImpl: async () => jsonResponse({ events: [] }),
      sleep: async () => {},
    });

    await assert.rejects(client.getEvents({ filters: [] }), (error) => {
      assert.ok(error instanceof RpcProtocolError);
      return true;
    });
  });

  it('rejects an event whose ScVal cannot be decoded', async () => {
    const client = createRpcClient({
      url: 'https://rpc.example.com',
      fetchImpl: async () =>
        jsonResponse({
          latestLedger: 7,
          events: [{ topic: ['not-base64!!'], value: symbol('metric') }],
        }),
      sleep: async () => {},
    });

    await assert.rejects(client.getEvents({ filters: [] }), (error) => {
      assert.ok(error instanceof RpcProtocolError);
      return true;
    });
  });

  it('scValToNative round-trips the encoded value used in tests', () => {
    // Guards the fixture itself so a bad encoder cannot mask a decode bug.
    const encoded = encodedMetricValue(7, [['asset_address', 2]]);
    const native = scValToNative(xdr.ScVal.fromXDR(encoded, 'base64'));
    assert.equal(String(native[0]), '7');
    assert.equal(native[1][0][0], 'asset_address');
  });
});

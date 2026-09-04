/**
 * The rate limits — the thing standing between a passcode and somebody with a
 * script, and between the search endpoints and somebody else's Google bill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { callerOf, limit } from '../src/limits.js';

/** A request and response pair small enough to see all of. */
function exchange(ip = '1.2.3.4', method = 'POST') {
  const headers = {};
  const res = {
    statusCode: 200, body: null, headers,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  return { req: { method, path: '/api/session', ip, headers: {}, socket: {} }, res };
}

const run = (mw, ip) => new Promise((resolve) => {
  const { req, res } = exchange(ip);
  mw(req, res, () => resolve({ passed: true, res }));
  if (res.statusCode !== 200) resolve({ passed: false, res });
  else setImmediate(() => resolve({ passed: res.body === null, res }));
});

test('lets the allowance through and refuses the one after', async () => {
  const mw = limit({ name: `t-${Math.random()}`, windowMs: 60_000, max: 3 });
  for (let i = 1; i <= 3; i += 1) {
    const { passed } = await run(mw, '10.0.0.1');
    assert.equal(passed, true, `request ${i} of 3 should pass`);
  }
  const { passed, res } = await run(mw, '10.0.0.1');
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'too_many_requests');
  assert.ok(res.body.retryAfter > 0, 'says how long to wait');
  assert.ok(res.headers['retry-after'], 'and says it in the header too');
});

test('one caller running out does not lock anybody else out', async () => {
  const mw = limit({ name: `t-${Math.random()}`, windowMs: 60_000, max: 1 });
  assert.equal((await run(mw, '10.0.0.2')).passed, true);
  assert.equal((await run(mw, '10.0.0.2')).passed, false, 'the same caller is now over');
  assert.equal((await run(mw, '10.0.0.3')).passed, true, 'a different caller is not');
});

test('the window ends and the allowance comes back', async () => {
  const mw = limit({ name: `t-${Math.random()}`, windowMs: 40, max: 1 });
  assert.equal((await run(mw, '10.0.0.4')).passed, true);
  assert.equal((await run(mw, '10.0.0.4')).passed, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await run(mw, '10.0.0.4')).passed, true, 'a new window');
});

test('a preflight is never counted', async () => {
  const mw = limit({ name: `t-${Math.random()}`, windowMs: 60_000, max: 1 });
  for (let i = 0; i < 5; i += 1) {
    const { req, res } = exchange('10.0.0.5', 'OPTIONS');
    await new Promise((resolve) => mw(req, res, resolve));
    assert.equal(res.statusCode, 200);
  }
  assert.equal((await run(mw, '10.0.0.5')).passed, true, 'the allowance was never spent');
});

test('the caller is the client, not Railway', () => {
  // Behind a proxy every request has the same `socket.remoteAddress`, so
  // reading the wrong one would put the whole internet in one bucket.
  assert.equal(callerOf({ headers: { 'x-forwarded-for': '203.0.113.7, 10.1.1.1' }, ip: '10.1.1.1', socket: {} }), '203.0.113.7');
  assert.equal(callerOf({ headers: {}, ip: '198.51.100.9', socket: {} }), '198.51.100.9');
  assert.equal(callerOf({ headers: {}, socket: { remoteAddress: '192.0.2.5' } }), '192.0.2.5');
  assert.equal(callerOf({ headers: {}, socket: {} }), 'unknown');
});

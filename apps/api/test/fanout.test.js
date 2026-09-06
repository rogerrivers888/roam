/**
 * The fan-out, where a spinner and somebody's money meet.
 *
 * A search asks every source at once and has to decide when it has waited long
 * enough. Getting that wrong is not a crash — it is a screen that takes three
 * seconds for an answer it had in half of one, or a screen that gives up on the
 * only source that had anything. Neither shows up in a stack trace.
 *
 * Overpass is the case the rules exist for. Measured on production, 6 Sep 2026:
 * it answered three tries in five, at 5.0s, 7.2s and 9.8s, and ran out its cap
 * on the other two — while returning a hundred and twenty restaurants in central
 * Manchester where Google returns seven. Too slow to wait for, too good to drop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { settleBy } from '../src/sources/index.js';

const venue = (name) => ({ name, lat: 51.5, lng: -0.12 });
const useful = (v) => v.lat != null;

/** A source that answers after `ms`. */
const answers = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));
/** A source that never answers within the test's lifetime. */
const never = () => new Promise(() => {});

const took = async (fn) => { const t = Date.now(); const out = await fn(); return { out, ms: Date.now() - t }; };

test('a slow source does not hold the answer once the others are in', async () => {
  const sources = [{ key: 'google' }, { key: 'osm', slow: true }];
  const started = [answers(20, [venue('Dishoom')]), never()];

  const { out, ms } = await took(() => settleBy(sources, started, 6000, useful));

  // The point of the whole exercise: not the 2.5s grace, and nowhere near the
  // 6s deadline.
  assert.ok(ms < 300, `answered in ${ms}ms, should not have waited for the slow source`);
  assert.equal(out[0].status, 'fulfilled');
  assert.equal(out[1].status, 'rejected');
  assert.equal(out[1].reason.slow, true, 'the slow one is recorded as still looking, not as broken');
});

test('a merely late source still gets its grace', async () => {
  // Not marked slow — an events API having a bad second. It must not be cut off
  // the instant Google answers, which is the thing a shorter global grace broke.
  const sources = [{ key: 'google' }, { key: 'ticketmaster' }];
  const started = [answers(20, [venue('Dishoom')]), answers(400, [venue('A gig')])];

  const { out, ms } = await took(() => settleBy(sources, started, 6000, useful));

  assert.equal(out[1].status, 'fulfilled', 'a late source that is not slow by nature is waited for');
  assert.deepEqual(out[1].value, [venue('A gig')]);
  assert.ok(ms >= 400, `answered in ${ms}ms, before the late source had spoken`);
});

test('when only the slow source has anything, it is waited for properly', async () => {
  // The household with no Google key. Here slow is the whole service, and
  // answering early would mean answering empty.
  const sources = [{ key: 'google' }, { key: 'osm', slow: true }];
  const started = [answers(10, []), answers(700, [venue('A pub OSM knows about')])];

  const out = await settleBy(sources, started, 6000, useful);

  assert.equal(out[1].status, 'fulfilled');
  assert.deepEqual(out[1].value, [venue('A pub OSM knows about')]);
});

test('a source that fails counts as settled, and does not hold the rest', async () => {
  // A refusal is an answer. If a failure did not decrement the count, one dead
  // source would make every search wait out the full deadline.
  const sources = [{ key: 'google' }, { key: 'seatgeek' }, { key: 'osm', slow: true }];
  const started = [answers(20, [venue('Dishoom')]), Promise.reject(new Error('401')), never()];
  started[1].catch(() => null);

  const { out, ms } = await took(() => settleBy(sources, started, 6000, useful));

  assert.ok(ms < 300, `answered in ${ms}ms; a failing source should not extend the wait`);
  assert.equal(out[1].status, 'rejected');
  assert.match(String(out[1].reason.message), /401/);
});

test('with no deadline the caller wants everything, however long it takes', async () => {
  // The background paths — filling a cache, a sweep — have nowhere to be, and
  // must not inherit a rule written for a screen.
  const sources = [{ key: 'google' }, { key: 'osm', slow: true }];
  const started = [answers(10, [venue('Dishoom')]), answers(300, [venue('The other hundred')])];

  const out = await settleBy(sources, started, null, useful);

  assert.equal(out[1].status, 'fulfilled', 'no deadline means wait for the slow one too');
});

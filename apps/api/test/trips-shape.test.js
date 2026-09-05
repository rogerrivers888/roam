/**
 * The two rules the Trips and Places redesign turns on (handover, 5 Sep 2026).
 *
 * Neither is arithmetic anybody would notice being wrong until a screen is
 * already showing the wrong thing: a holiday filed under Day trips, or a hotel
 * filed under Activities.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_OF, nightsOf } from '../src/routes/trips.js';

test('a night away is what makes a holiday, whatever the trip calls itself', () => {
  // A day out has no dates at all — it is a departure and a return time.
  assert.equal(nightsOf({ start_date: null, end_date: null }), 0);
  // A "trip" that starts and ends on the same day is still a day out.
  assert.equal(nightsOf({ start_date: '2026-09-12', end_date: '2026-09-12' }), 0);
  assert.equal(nightsOf({ start_date: '2026-10-11', end_date: '2026-10-12' }), 1);
  assert.equal(nightsOf({ start_date: '2025-08-09', end_date: '2025-08-17' }), 8);
});

test('nights are counted in days, not in hours, so British Summer Time cannot lose one', () => {
  // The clocks go back on 25 October 2026: a naive hour count gives 7.04 days.
  assert.equal(nightsOf({ start_date: '2026-10-24', end_date: '2026-10-31' }), 7);
  // And forward on 29 March: a naive count gives 6.96.
  assert.equal(nightsOf({ start_date: '2026-03-27', end_date: '2026-04-03' }), 7);
});

test('which of the three lists a place belongs in', () => {
  assert.equal(GROUP_OF('hotel', null), 'stay');
  assert.equal(GROUP_OF('lodging', null), 'stay');
  // Claimed as somewhere to stay before anybody said what kind of place it is.
  assert.equal(GROUP_OF(null, 'stay'), 'stay');
  for (const c of ['restaurant', 'cafe', 'pub', 'bar']) assert.equal(GROUP_OF(c, null), 'eat');
  assert.equal(GROUP_OF(null, 'food'), 'eat');
  assert.equal(GROUP_OF('attraction', null), 'do');
  assert.equal(GROUP_OF('event', null), 'do');
  // Nothing known about it at all is a thing to do, not a blank row.
  assert.equal(GROUP_OF(null, null), 'do');
});

/**
 * Whether two names are the same place.
 *
 * A wrong match is worse than none: it puts another business's phone number,
 * hours and menu on this one's card, and the household has no way to tell. Two
 * of them got through on 6 Sep 2026 — Sunningdale Bistro Bar was matched to
 * Sunningdale Pharmacy, and before that to Sunningdale railway station — both
 * because the noise list takes "bistro" and "bar" out of a name, leaving
 * "sunningdale", which is the first word of every business in the village.
 *
 * So the town is passed in as a word that proves nothing, and the words the
 * noise list removed are read back in when they are all there is to go on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { kindDisagrees, nameScore, normalise, placeWords } from '../src/sources/openMatch.js';

/** What `matchOsm` accepts. Below this, the place is left unmatched. */
const MATCHED = 0.6;
const score = (a, b, town) => nameScore(a, b, town ? [town] : []);

test('sharing the town’s name is not being the same place', () => {
  assert.ok(score('Sunningdale Bistro Bar', 'Sunningdale Pharmacy', 'Sunningdale') < MATCHED);
  assert.ok(score('Sunningdale Bistro Bar', 'Sunningdale Railway Station', 'Sunningdale') < MATCHED);
  assert.ok(score('Sunningdale Bistro Bar', 'Sunningdale', 'Sunningdale') < MATCHED);
  assert.ok(score('Bath Abbey', 'Bath Cricket Club', 'Bath') < MATCHED);
});

test('the same place, written two ways, still matches', () => {
  assert.equal(score('Sunningdale Bistro Bar', 'Sunningdale Bistro Bar', 'Sunningdale'), 1);
  assert.ok(score('Sunningdale Bistro Bar', 'Sunningdale Bistro', 'Sunningdale') >= MATCHED);
  assert.ok(score('Kokoro Windsor', 'KOKORO', 'Windsor and Maidenhead') >= MATCHED);
  assert.ok(score('The Ivy', 'Ivy Restaurant', 'Windsor and Maidenhead') >= MATCHED);
  assert.ok(score("Megan's", 'Megans by the Crown', 'Windsor and Maidenhead') >= MATCHED);
});

test('two different places in one town are still two places', () => {
  assert.ok(score('Windsor Castle', 'Windsor Great Park', 'Windsor and Maidenhead') < MATCHED);
  assert.ok(score('Roman Baths', 'Brooks Road', 'Bath') < MATCHED);
});

test('the village is in the address; the district is all the household row has', () => {
  // "Windsor and Maidenhead" is what the atlas calls the area, and it is not
  // the word a Sunningdale business shares with the shop next door.
  const dull = placeWords('Windsor and Maidenhead', '43 Chobham Road, Sunningdale, SL5 0DS');
  assert.deepEqual(dull, ['Windsor and Maidenhead', 'Sunningdale']);
  assert.ok(nameScore('Sunningdale Bistro Bar', 'Sunningdale Pharmacy', dull) < MATCHED);
  assert.ok(nameScore('Sunningdale Bistro Bar', 'Sunningdale Bistro', dull) >= MATCHED);
  // The street is not a place word: a business named after the road it is on
  // must still be able to match itself.
  assert.ok(!placeWords('Bath', '12 Brooks Road, Bath, BA1 2AA').includes('12 Brooks Road'));
});

test('with no town given, nothing changes about how names are read', () => {
  assert.equal(score('The Ivy', 'Ivy Restaurant'), 1);
  assert.ok(score('Kokoro Windsor', 'KOKORO') >= MATCHED);
});

test('the noise list is only skipped when the whole name is noise', () => {
  // Normalising still strips what it always stripped.
  assert.equal(normalise('The Ivy Restaurant'), 'ivy');
  assert.equal(normalise('The Ivy Restaurant', { noise: false }), 'the ivy restaurant');
});

test('a restaurant is not the chemist next door, whatever it is called', () => {
  assert.equal(kindDisagrees('cafe', { amenity: 'pharmacy' }), true);
  assert.equal(kindDisagrees('cafe', { shop: 'chemist' }), true);
  // A railway station is already turned away for being transport, before the
  // kind is looked at at all (`matchOsm`).
  assert.equal(kindDisagrees('cafe', { amenity: 'cafe' }), false);
  assert.equal(kindDisagrees('restaurant', { amenity: 'fast_food' }), false);
  assert.equal(kindDisagrees('hotel', { tourism: 'hotel' }), false);
  // A place the map has not classified is left to the name to decide, and an
  // attraction can be almost anything.
  assert.equal(kindDisagrees('restaurant', {}), false);
  assert.equal(kindDisagrees('attraction', { amenity: 'pharmacy' }), false);
});

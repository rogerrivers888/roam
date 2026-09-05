/**
 * Which shelf a place lands on — the decision the owner objected to, pinned.
 *
 * "Currently, on the homepage under the adrenaline section, it's showing
 * football stadiums. That's not what I consider adrenaline" (5 Sep 2026), and
 * then, once they had moved to Fun: "Sports stadiums are not really normal days
 * out. You go book your football tickets."
 *
 * The things that has to mean are all silent failures if they regress: a
 * stadium is Sport, a circuit is Adrenaline, a pool is Active, and nothing
 * lands on four shelves at once. None of them shows up as an error — the home
 * screen just quietly fills a shelf with the wrong places again.
 *
 * Everything here is pure: no database, no rules table, the rules handed in by
 * hand exactly as `repositories/shelfRules.js` shapes them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  MAX_SHELVES, MOOD_KEYS, NO_RULES, SHELF_FLOOR, drawn, shelvesForAtlas, shelvesForVenue,
} = await import('../src/domain/moods.js');

/** The shape `rules()` hands over, from a plain list. */
const rulesOf = (...rows) => {
  const out = { place: new Map(), kind: new Map(), category: new Map(), experience: new Map() };
  for (const r of rows) out[r.scope].set(r.subject, r);
  return out;
};

const STADIUM = { scope: 'kind', subject: 'Q1154710', subject_label: 'association football venue', weights: { sport: 1, fun: 0.4 } };
const CIRCUIT = { scope: 'kind', subject: 'Q2338524', subject_label: 'motorsport racing track', weights: { adrenaline: 1, fun: 0.7 } };

test('a football ground is Sport — a ticket for a fixture, not a thrill', () => {
  const { shelves } = shelvesForAtlas(
    { ref: 'wikidata:Q642313', category: 'active', kinds: ['Q1049757', 'Q1154710'] },
    rulesOf(STADIUM),
  );
  assert.deepEqual(shelves, ['sport']);
});

test('a motorsport circuit is exactly what adrenaline means', () => {
  const { shelves, weights } = shelvesForAtlas(
    { ref: 'wikidata:Q193364', category: 'active', kinds: ['Q2338524'] },
    rulesOf(CIRCUIT),
  );
  assert.ok(shelves.includes('adrenaline'));
  assert.equal(weights.adrenaline, 1);
});

test('an untaught sports venue lands on Sport, and nowhere near Adrenaline or Fun', () => {
  // The whole complaint in one assertion, in both its rounds: `active` on its
  // own must not put a place on the Adrenaline shelf (5 Sep, first ask), and it
  // must not fall through to Fun either, where forty-seven stadiums buried the
  // days out (5 Sep, second ask).
  const { shelves, weights } = shelvesForAtlas({ category: 'active', kinds: ['Q999999'] }, NO_RULES);
  assert.deepEqual(shelves, ['sport']);
  assert.ok(weights.adrenaline > 0 && weights.adrenaline < SHELF_FLOOR);
  assert.ok(weights.fun > 0 && weights.fun < SHELF_FLOOR);
});

test('the narrowest rule wins outright, and does not blend with the type', () => {
  const { shelves, because } = shelvesForAtlas(
    { ref: 'wikidata:Q1', category: 'active', kinds: ['Q1154710'] },
    rulesOf(STADIUM, {
      scope: 'place', subject: 'wikidata:Q1', subject_label: 'the one that is different',
      weights: { adrenaline: 1 },
    }),
  );
  assert.deepEqual(shelves, ['adrenaline']);
  assert.equal(because.length, 1);
  assert.equal(because[0].scope, 'place');
});

test('several types speak for the shelves each knows about', () => {
  // Alexandra Palace is an event venue and a theatre building at once. Taking
  // the strongest claim per shelf lets both be true; averaging would sink both.
  const { weights } = shelvesForAtlas(
    { category: 'active', kinds: ['Q18674739', 'Q24354'] },
    rulesOf(
      { scope: 'kind', subject: 'Q18674739', weights: { fun: 0.9, culture: 0.6 } },
      { scope: 'kind', subject: 'Q24354', weights: { culture: 1 } },
    ),
  );
  assert.equal(weights.fun, 0.9);
  assert.equal(weights.culture, 1);
});

test('a place never appears on more than two shelves', () => {
  const everything = Object.fromEntries(MOOD_KEYS.map((k) => [k, 1]));
  assert.equal(drawn(everything).length, MAX_SHELVES);
  const { shelves } = shelvesForAtlas(
    { ref: 'wikidata:Q2', category: 'outdoors', kinds: [] },
    rulesOf({ scope: 'place', subject: 'wikidata:Q2', weights: everything }),
  );
  assert.equal(shelves.length, MAX_SHELVES);
});

test('a weight below the floor is true and not shown', () => {
  assert.deepEqual(drawn({ fun: 1, adrenaline: SHELF_FLOOR - 0.01 }), ['fun']);
  assert.deepEqual(drawn({ fun: 1, adrenaline: SHELF_FLOOR }), ['fun', 'adrenaline']);
});

test('a rule may not invent a shelf', () => {
  const { weights, shelves } = shelvesForAtlas(
    { ref: 'wikidata:Q3', category: 'museum', kinds: [] },
    rulesOf({ scope: 'place', subject: 'wikidata:Q3', weights: { adventurous: 1, culture: 0.8 } }),
  );
  assert.deepEqual(Object.keys(weights), ['culture']);
  assert.deepEqual(shelves, ['culture']);
});

test('somewhere to eat is Food and nothing else', () => {
  assert.deepEqual(shelvesForVenue({ category: 'restaurant', experiences: ['park'] }, NO_RULES).shelves, ['food']);
});

test('a place the map said nothing about is still a day out', () => {
  const { shelves, because } = shelvesForVenue({ category: 'attraction', experiences: [] }, NO_RULES);
  assert.deepEqual(shelves, ['fun']);
  assert.match(because[0].reason, /no tags|nothing about/i);
});

test('watching a match is Sport in the live pool too', () => {
  assert.deepEqual(shelvesForVenue({ category: 'attraction', experiences: ['sports-game'] }, NO_RULES).shelves, ['sport']);
});

test('Sport and Active are two shelves, not two names for one', () => {
  // Watching and doing are different afternoons (owner, 5 Sep 2026). A club you
  // belong to is Sport; a pool you turn up at is Active; and neither is the
  // other, or the distinction was pointless.
  const club = shelvesForAtlas({ category: 'active', kinds: ['Q2022036'] },
    rulesOf({ scope: 'kind', subject: 'Q2022036', weights: { sport: 0.9, activity: 0.5 } }));
  const pool = shelvesForAtlas({ category: 'active', kinds: ['Q1501'] },
    rulesOf({ scope: 'kind', subject: 'Q1501', weights: { activity: 0.9, fun: 0.5 } }));
  assert.deepEqual(club.shelves, ['sport']);
  assert.deepEqual(pool.shelves, ['activity']);
});

test('the atlas category `active` and the shelf `activity` are different words', () => {
  // Keyed apart on purpose: one says what a place is, the other what a day
  // there is like. If these ever collapse into one key, an atlas category will
  // start setting a shelf weight by accident.
  assert.ok(MOOD_KEYS.includes('activity'));
  assert.ok(!MOOD_KEYS.includes('active'));
});

test('an experience rule reaches the live pool', () => {
  const { shelves } = shelvesForVenue(
    { source: 'osm', sourcePlaceId: 'way/1', category: 'attraction', experiences: ['boat-trip'] },
    rulesOf({ scope: 'experience', subject: 'boat-trip', weights: { adrenaline: 0.9, outdoors: 0.8 } }),
  );
  assert.deepEqual(shelves, ['adrenaline', 'outdoors']);
});

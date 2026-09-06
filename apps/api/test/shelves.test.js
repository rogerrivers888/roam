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
  vocabularyOf, winner,
} = await import('../src/domain/moods.js');

/**
 * A small taxonomy, in the shape `shelfTaxonomy.taxonomy()` hands over: two
 * drawers in different cabinets, which is all it takes to prove that a drawer
 * names its cabinet and cannot be shown under another one.
 */
const VOCAB = vocabularyOf(
  [{ key: 'fun' }, { key: 'food' }, { key: 'culture' }, { key: 'sport' },
   { key: 'activity' }, { key: 'adrenaline' }, { key: 'relaxing' }, { key: 'outdoors' }],
  [{ key: 'castles', category_key: 'culture' },
   { key: 'gardens', category_key: 'relaxing' },
   { key: 'parks', category_key: 'outdoors' },
   { key: 'football', category_key: 'sport' }],
);

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

test('a place appears under exactly one category, however it is taught', () => {
  // The owner, 5 Sep 2026: "I don't want any duplication between categories."
  // Weighting everything at 1 is the worst case, and it still draws once.
  const everything = Object.fromEntries(MOOD_KEYS.map((k) => [k, 1]));
  assert.equal(drawn(everything).length, MAX_SHELVES);
  assert.equal(MAX_SHELVES, 1);
  const { shelves, category } = shelvesForAtlas(
    { ref: 'wikidata:Q2', category: 'outdoors', kinds: [] },
    rulesOf({ scope: 'place', subject: 'wikidata:Q2', weights: everything }),
  );
  assert.deepEqual(shelves, [category]);
});

test('the strongest claim wins, and a weak one still lands somewhere', () => {
  // No floor on placement: a place has to be filed, and hiding a weakly-placed
  // one would lose it from the home screen rather than file it imperfectly.
  assert.equal(winner({ fun: 1, adrenaline: 0.9 }), 'fun');
  assert.equal(winner({ adrenaline: 0.2 }), 'adrenaline');
  const weak = shelvesForAtlas(
    { ref: 'wikidata:Q11', category: 'active', kinds: [] },
    rulesOf({ scope: 'place', subject: 'wikidata:Q11', weights: { fun: 0.4 } }),
  );
  assert.deepEqual(weak.shelves, ['fun']);
  // Filed, but nobody would defend it — which is what the back office lists.
  assert.equal(weak.confident, false);
  assert.ok(SHELF_FLOOR > 0.4);
});

test('a drawer names its cabinet', () => {
  // A rule with a subcategory and no weights is a complete answer: `castles`
  // belongs to Culture, so the place is Culture. This is how migration 054
  // files most of the atlas.
  const { category, subcategory, shelves } = shelvesForAtlas(
    { category: 'heritage', kinds: ['Q23413'] },
    rulesOf({ scope: 'kind', subject: 'Q23413', subject_label: 'castle', weights: {}, subcategory: 'castles' }),
    VOCAB,
  );
  assert.equal(category, 'culture');
  assert.equal(subcategory, 'castles');
  assert.deepEqual(shelves, ['culture']);
});

test('a drawer moves the shelf with it', () => {
  // The garden case: the atlas calls it outdoors, the drawer says Relaxing, and
  // the drawer wins because a drawer belongs to exactly one cabinet.
  const { category, subcategory } = shelvesForAtlas(
    { category: 'outdoors', kinds: ['Q1107656'] },
    rulesOf({ scope: 'kind', subject: 'Q1107656', weights: {}, subcategory: 'gardens' }),
    VOCAB,
  );
  assert.equal(category, 'relaxing');
  assert.equal(subcategory, 'gardens');
});

test('a drawer that disagrees with the winning category is dropped, not shown', () => {
  // A place rule says Outdoors; a broader type rule says the Gardens drawer,
  // which belongs to Relaxing. The narrower rule wins the category and the
  // inconsistent drawer is dropped — never "filed under Gardens, shown on
  // Outdoors".
  const { category, subcategory } = shelvesForAtlas(
    { ref: 'wikidata:Q9', category: 'outdoors', kinds: ['Q1107656'] },
    rulesOf(
      { scope: 'place', subject: 'wikidata:Q9', weights: { outdoors: 1 } },
      { scope: 'kind', subject: 'Q1107656', weights: {}, subcategory: 'gardens' },
    ),
    VOCAB,
  );
  assert.equal(category, 'outdoors');
  assert.equal(subcategory, null);
});

test('a drawer survives a narrower rule that agrees with it', () => {
  const { category, subcategory } = shelvesForAtlas(
    { ref: 'wikidata:Q10', category: 'active', kinds: ['Q1154710'] },
    rulesOf(
      { scope: 'place', subject: 'wikidata:Q10', weights: { sport: 1 } },
      { scope: 'kind', subject: 'Q1154710', weights: {}, subcategory: 'football' },
    ),
    VOCAB,
  );
  assert.equal(category, 'sport');
  assert.equal(subcategory, 'football');
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
  assert.deepEqual(shelves, ['adrenaline']);
});

test('a place rule beats "somewhere to eat is Food"', () => {
  // Food short-circuits everything by design, but not a rule about this one
  // restaurant — otherwise the quick edit on the shelves page could never move
  // a place that the map happens to call a café.
  const { category } = shelvesForVenue(
    { source: 'osm', sourcePlaceId: 'way/2', category: 'cafe', experiences: [] },
    rulesOf({ scope: 'place', subject: 'osm:way/2', weights: { culture: 1 } }),
  );
  assert.equal(category, 'culture');
});

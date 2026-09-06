/**
 * Literals that more than one module needs, in one place.
 *
 * The estate's engineering standard, rule 4: constants live in their own file
 * rather than scattered as literals across modules. The set below had four
 * copies — `domain/pace.js`, `domain/options.js`, `routes/tastes.js` and
 * `routes/places.js` each wrote out the same four words, two of them in a
 * different order — and four copies of a rule is three chances to disagree
 * about whether a bar is somewhere you eat.
 *
 * Not everything belongs here. A prompt, a regex that reads one screen's words,
 * a deadline only one file waits on: those live with the code that uses them.
 * This file is for the ones that are shared, or that would drift if they were
 * not.
 */

/** Where a household eats, as opposed to somewhere they go and do something. */
export const FOOD_CATEGORY_LIST = ['restaurant', 'cafe', 'pub', 'bar'];
export const FOOD_CATEGORIES = new Set(FOOD_CATEGORY_LIST);
export const isFoodCategory = (category) => FOOD_CATEGORIES.has(category);

/**
 * The three-way take, in the order the `take` enum declares them
 * (migration 002). Anything not one of these is not a take.
 */
export const TAKES = ['loved', 'fine', 'not_for_me'];

/**
 * The sources that cannot send a bill, whatever we ask of them.
 *
 * Roam's household ceiling exists "so one household cannot run up an unbounded
 * bill" (Technical Constraints §14), and it was counting every row in
 * `provider_calls` — including the open map, the encyclopedias and the address
 * lookup, which are free. One afternoon of research put a household over three
 * thousand calls on about fifteen hundred free ones, and the first thing it
 * cost them was reading a menu (owner, 6 Sep 2026: "Count only what can cost
 * money").
 *
 * Attribution is unchanged: every call is still recorded, whoever it went to.
 * This is only about which of them the money guard counts.
 */
export const FREE_SOURCES = new Set([
  'osm', 'overpass', 'osm-overpass', 'nominatim', 'osm-nominatim', 'photon',
  'wikipedia', 'wikidata', 'wikimedia', 'commons',
  'tfl', 'postcodes', 'fixtures',
]);

/**
 * Whether a `provider_calls` row could have cost anything.
 *
 * A search names every source it asked ("fixtures+osm+google"), so a row counts
 * if any one of them bills. A row that names nobody counts, because an unknown
 * source is not a free one.
 */
export function canBill(provider) {
  const parts = String(provider ?? '').split('+').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.some((p) => !FREE_SOURCES.has(p)) : true;
}

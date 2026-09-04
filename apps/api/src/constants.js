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

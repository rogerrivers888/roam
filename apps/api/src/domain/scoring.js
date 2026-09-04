// What Roam thinks of a place, as one number that is ours (owner, 4 Sep 2026).
//
// > "If we're not storing anything about the Google rating, but it is a
// > percentage of our overall score, and then we go back 3 months later and we
// > ask for the new rating, how do we know how to change our overall score
// > unless we know what the original rating was?"
//
// The answer this module implements: nothing is ever *changed*. `score()` is a
// pure function of the evidence in front of it, so every sweep recomputes from
// scratch and no sweep needs to remember what the last one was told. The
// licensed figure goes in one side, a band and a composite come out the other,
// and the figure is never written down.
//
// Three rules hold this together:
//
//   1. A band is a judgement, a figure is theirs. `crowdBand` maps a wide range
//      of ratings onto four words, so the band cannot be read backwards into
//      the rating. A normalised 0–1 sub-score would be the rating with a linear
//      transform on it, which would be kidding ourselves, so there isn't one.
//   2. The score must survive the source going away. `owned` is computed from
//      open data and our own reading alone, and is stored beside the composite.
//      If the key dies, the ranking stands.
//   3. Volume damps a rating, so the crowd figure is pulled towards the mean
//      when few people have spoken. A 5.0 from eleven diners is not better than
//      a 4.6 from two thousand, and a raw sort says it is.

/** Ratings barely move on a mature place, so this is where the mean sits. */
const PRIOR = 4.15;
/** Reviews needed before a rating speaks mostly for itself. */
const PRIOR_WEIGHT = 150;

/**
 * The crowd signal, as one of four words.
 *
 * Called with the licensed figures and never returns them: this is the only
 * place in Roam where a rating is touched, and what leaves is a word.
 */
export function crowdBand(rating, count) {
  if (!Number.isFinite(rating) || rating <= 0) return null;
  const n = Number.isFinite(count) ? count : 0;
  // Bayesian shrink towards the mean: few voices count for less.
  const weight = n / (n + PRIOR_WEIGHT);
  const adjusted = rating * weight + PRIOR * (1 - weight);
  if (adjusted >= 4.55) return 'top';
  if (adjusted >= 4.3) return 'high';
  if (adjusted >= 4.0) return 'good';
  return 'mixed';
}

/**
 * How many people have spoken, coarsely.
 *
 * This is the change detector rather than the rating. A place with two thousand
 * reviews at 4.6 will read 4.6 next quarter and the one after — the rating is
 * too damped to move. The count is not: a jump means the place is having a
 * moment, and a flatline across two sweeps often means it has closed.
 */
export function countBand(count) {
  const n = Number.isFinite(count) ? count : 0;
  if (n >= 2000) return 'thousands';
  if (n >= 500) return 'many';
  if (n >= 100) return 'hundreds';
  return 'few';
}

const CROWD_POINTS = { top: 1, high: 0.75, good: 0.45, mixed: 0.15 };
const COUNT_POINTS = { thousands: 1, many: 0.85, hundreds: 0.6, few: 0.25 };

/**
 * What an accolade is worth. These are the independent judgements the owner
 * asked for — "maybe we can find independent reviews" — and unlike a rating
 * they are facts about who said what, published to be quoted, and ours to keep.
 */
export const ACCOLADE_POINTS = {
  'michelin-star': 1,
  'michelin-bib': 0.8,
  'michelin-listed': 0.6,
  'good-food-guide': 0.7,
  'aa-rosette': 0.6,
  'top-100-gastropub': 0.6,
  'national-restaurant-award': 0.7,
  'hardens': 0.4,
  'squaremeal': 0.35,
  'camra': 0.4,
  'wikipedia': 0.3,          // an article at all is a kind of standing
};

/** 0–1: how much of a real, particular restaurant this is, from what we own. */
function substanceOf({ menuItems = 0, cuisines = [], website = null, summary = null, openingHours = null }) {
  let n = 0;
  // A menu we could actually read is the strongest thing we own about a place.
  if (menuItems >= 40) n += 0.45;
  else if (menuItems >= 15) n += 0.35;
  else if (menuItems > 0) n += 0.2;
  // A named cuisine is a place that knows what it is; "restaurant" is not one.
  if (cuisines.length) n += 0.2;
  if (website) n += 0.15;
  if (summary) n += 0.1;
  if (openingHours) n += 0.1;
  return Math.min(1, n);
}

/**
 * The composite, 0–10, and the same thing without the licensed input.
 *
 * `crowd` is passed as bands, not figures: the caller does the banding at the
 * moment of the fetch so the figures never travel further than that call.
 */
export function score({ crowd = null, count = null, accolades = [], menuItems = 0, cuisines = [], website = null, summary = null, openingHours = null } = {}) {
  const substance = substanceOf({ menuItems, cuisines, website, summary, openingHours });
  // Accolades stack, with diminishing returns: two rosettes and a Bib is a very
  // good restaurant, not three times a good one.
  const accolade = Math.min(1, (accolades || []).reduce((n, a) => n + (ACCOLADE_POINTS[a] ?? 0), 0) * 0.7);

  const crowdPoints = crowd ? (CROWD_POINTS[crowd] ?? 0) * 0.8 + (COUNT_POINTS[count] ?? 0) * 0.2 : null;

  // Weights. The crowd is the best single signal of whether ordinary people
  // enjoyed themselves, so it leads — but not so heavily that the number
  // collapses without it, which is what `owned` proves.
  const owned = (accolade * 0.6 + substance * 0.4) * 10;
  const composite = crowdPoints == null
    ? owned
    : (crowdPoints * 0.5 + accolade * 0.3 + substance * 0.2) * 10;

  const round = (x) => Math.round(x * 10) / 10;
  return { roamScore: round(composite), ownedScore: round(owned), substance: round(substance), accolade: round(accolade) };
}

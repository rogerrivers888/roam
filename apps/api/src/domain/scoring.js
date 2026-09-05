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

import { CHAIN_WEIGHT } from './chains.js';

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
export function score({ crowd = null, count = null, accolades = [], menuItems = 0, cuisines = [], website = null, summary = null, openingHours = null, chainScale = 'independent' } = {}) {
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

  // Being a group is a weight on the end, not a filter at the start (owner,
  // 5 Sep 2026). It multiplies rather than subtracts so that a chain people
  // genuinely rate keeps most of what it earned, and a chain nobody rates has
  // little to lose in the first place.
  const w = CHAIN_WEIGHT[chainScale] ?? 1;

  const round = (x) => Math.round(x * 10) / 10;
  return { roamScore: round(composite * w), ownedScore: round(owned * w), substance: round(substance), accolade: round(accolade), chainWeight: w };
}

// ---------------------------------------------------------------------------
// attractions
// ---------------------------------------------------------------------------
//
// Owner, 5 Sep 2026: "I want the same 4 wide bands as the restaurant, but then
// layer in the World Heritage and Green Flag, etc., because that's of real
// value and significantly differs from restaurant."
//
// Both halves live here rather than in the harvest, so that the one place in
// Roam that decides what a place is worth is one file.
//
// What differs from a restaurant is worth saying plainly. A restaurant's score
// leans on a licensed crowd rating that has to be banded at the moment of the
// fetch and thrown away. An attraction has no such input and needs none: how
// many people read about it, how many went, and who has designated it are all
// facts we own outright. The attraction number is the stronger of the two, and
// it survives every provider going dark.

/**
 * What a designation is worth.
 *
 * The attraction's answer to `ACCOLADE_POINTS`, and the same argument: a rating
 * is a licensed figure we may not keep, but that somewhere is a World Heritage
 * Site or holds a Green Flag is a fact about who said what, published in order
 * to be quoted, and ours for good.
 *
 * Matched on the English label Wikidata returns rather than on a QID, because
 * the labels are stable and the QIDs are a thousand guesses waiting to be
 * wrong. Ordered most-specific first: "Grade II* listed" must not be read as
 * "Grade II listed", which is worth half as much.
 */
export const DESIGNATION_POINTS = [
  ['world-heritage', 1.0, /\bworld heritage\b/i],
  ['national-park', 0.85, /\bnational park\b/i],
  ['museum-of-the-year', 0.85, /\bmuseum of the year\b/i],
  ['geopark', 0.8, /\bgeopark\b/i],
  ['biosphere-reserve', 0.75, /\bbiosphere reserve\b/i],
  ['grade-i', 0.7, /\bgrade i\b(?!i)/i],
  ['national-landscape', 0.65, /\b(?:area of outstanding natural beauty|national landscape)\b/i],
  ['dark-sky', 0.6, /\bdark[- ]sky\b/i],
  ['scheduled-monument', 0.6, /\bscheduled (?:ancient )?monument\b/i],
  ['heritage-coast', 0.5, /\bheritage coast\b/i],
  ['grade-ii-star', 0.5, /\bgrade ii\*/i],
  ['green-flag', 0.5, /\bgreen flag\b/i],
  ['blue-flag', 0.5, /\bblue flag\b/i],
  ['national-nature-reserve', 0.5, /\bnational nature reserve\b/i],
  ['accredited-museum', 0.5, /\baccredited museum\b/i],
  ['registered-park-garden', 0.45, /\bregistered (?:park|historic park)\b|\bpark and garden\b/i],
  ['ramsar', 0.4, /\bramsar\b/i],
  ['category-a-listed', 0.6, /\bcategory a listed\b/i],
  ['category-b-listed', 0.4, /\bcategory b listed\b/i],
  ['sssi', 0.3, /\bsite of special scientific interest\b/i],
  ['conservation-area', 0.25, /\bconservation area\b/i],
  ['grade-ii', 0.25, /\bgrade ii\b(?!\*)/i],
  ['listed-building', 0.25, /\blisted building\b/i],
];

/**
 * Wikidata's designation and award labels, as Roam's accolades.
 *
 * A place carries several — Leeds Castle is a Grade I listed building *and* a
 * Grade II* listed park and garden — and migration 036 kept only the first and
 * dropped the rest. Both are worth having, so both are kept, and the label is
 * kept beside the key because a drawer says "World Heritage Site", never
 * "world-heritage".
 */
export function accoladesFrom(designations = []) {
  const out = [];
  for (const d of designations) {
    const label = typeof d === 'string' ? d : d?.label;
    if (!label) continue;
    const hit = DESIGNATION_POINTS.find(([, , re]) => re.test(label));
    if (!hit || out.some((a) => a.key === hit[0])) continue;
    out.push({ key: hit[0], label, source: typeof d === 'string' ? 'wikidata' : (d.kind ?? 'wikidata') });
  }
  return out;
}

/** 0–1, stacking with the same diminishing returns a restaurant's accolades do. */
export function acclaimOf(accolades = []) {
  const points = (key) => DESIGNATION_POINTS.find(([k]) => k === key)?.[1] ?? 0;
  return Math.min(1, accolades.reduce((n, a) => n + points(a.key ?? a), 0) * 0.7);
}

/**
 * The shared vocabulary: the same four words `crowdBand` gives a restaurant.
 *
 * The thresholds are not round numbers because they are not guesses. An
 * attraction's score is region-relative (see `scoreOf`), so across the whole
 * atlas it lands in a narrow band around the middle — the published rows sit at
 * 0.40 / 0.43 / 0.46 / 0.56 / 0.66 at the tenth, quarter, half, three-quarter
 * and ninetieth. Cutting on round tenths would put four fifths of everything in
 * one word and say nothing. These cuts put roughly a tenth in `top`, a quarter
 * in `high` and the long middle in `good`, which is what the words have to mean
 * if the list is to be worth sorting.
 */
export function bandOf(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 0.62) return 'top';
  if (score >= 0.52) return 'high';
  if (score >= 0.43) return 'good';
  return 'mixed';
}

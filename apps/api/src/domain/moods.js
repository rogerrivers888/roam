/**
 * What a day is about — the words the Inspire screen leads with, and how a
 * place ends up under one of them.
 *
 * This is a CLOSED SET, and deliberately so. It is the vocabulary the home
 * screen shows as chips, the vocabulary voice is interpreted against, and the
 * vocabulary one retrieved pool is sorted into. Adding a mood is adding a chip;
 * it never adds a provider call, because nothing here fetches — it reads the
 * `experiences` and `category` a search already returned and says which shelves
 * that place belongs on (Requirements: options are composed from one pool).
 *
 * **Shelves have weights, and only the strongest two are drawn.** A place used
 * to carry a flat list of moods, so anything arguably two things appeared
 * twice. The owner, 5 Sep 2026: "something could be adrenaline and it also
 * could be fun, we probably need to have some weighting around which category
 * it should sit in, because we don't want to have lots of duplication between
 * the categories, and that will also annoy people." So each shelf now carries a
 * number from 0 to 1: 1 is what the place is *for*, `SHELF_FLOOR` and above is
 * genuinely also this, and below the floor is true but not worth a card. A
 * climbing wall is Adrenaline 1 and Active 0.8 and appears on both; a football
 * ground is Sport 1 and Adrenaline 0.2 and appears on one.
 *
 * **The mapping is taught, not guessed.** The tables below are only where a
 * place starts. Anything in `shelf_rules` — a rule about one place, about a
 * Wikidata type, about an atlas category or about an experience — wins over
 * them, narrowest first, and the back office's Shelves screen is where those
 * rules are written. That exists because the coarse tables were wrong in a way
 * no amount of re-guessing fixes: the atlas has eight words for what a thing
 * *is*, and `active` covers a Formula One circuit and a football ground alike,
 * so Adrenaline near London was Wembley, Stamford Bridge, Twickenham and the
 * Royal Military Academy Sandhurst. The owner: "That's not what I consider
 * adrenaline."
 */

/** The chips, in the order they are drawn. */
export const MOODS = [
  { key: 'fun', label: 'Fun' },
  { key: 'food', label: 'Food' },
  { key: 'culture', label: 'Culture' },
  // Sport and Active are two shelves and not one, because watching and doing
  // are two different afternoons (owner, 5 Sep 2026): "Sports stadiums are not
  // really normal days out. You go book your football tickets or your rugby
  // tickets. Wentworth Golf, you have to have a membership for those. Those are
  // different things… the leisure centre is active."
  //
  // Sport is the ticket and the membership — a fixture, a race meeting, a club
  // you belong to. Active is what you can turn up and do. Adrenaline stays for
  // the thrill, which is a third thing again.
  { key: 'sport', label: 'Sport' },
  // Keyed `activity` rather than `active` on purpose. The atlas has its own
  // category called `active` (sources/wikimedia.js ATTRACTION_ROOTS) and the two
  // mean different things — one is what a place *is*, the other is what a day
  // there is like. Two vocabularies sharing a word is how they get conflated.
  { key: 'activity', label: 'Active' },
  { key: 'adrenaline', label: 'Adrenaline' },
  { key: 'relaxing', label: 'Relaxing' },
  { key: 'outdoors', label: 'Outdoors' },
];

export const MOOD_KEYS = MOODS.map((m) => m.key);
const RANK = Object.fromEntries(MOOD_KEYS.map((k, i) => [k, i]));

/**
 * How strong a shelf has to be before a card is drawn on it, and how many
 * shelves one place may occupy.
 *
 * Two, not three: the home screen is six shelves deep and a place on four of
 * them is the duplication the owner objected to. A third genuine shelf loses to
 * the two stronger ones, which is the right thing to lose.
 */
export const SHELF_FLOOR = 0.6;
export const MAX_SHELVES = 2;

/** Somewhere you eat or drink. Food is decided by what a place *is*, not by a tag. */
const EATING = new Set(['restaurant', 'cafe', 'pub', 'bar']);

/**
 * Where each experience starts, over the closed experience vocabulary in
 * `domain/concepts.js`. An experience the vocabulary does not list contributes
 * nothing rather than guessing.
 */
export const BY_EXPERIENCE = {
  museum: { culture: 1 },
  'art-gallery': { culture: 1 },
  aquarium: { fun: 1, culture: 0.6 },
  zoo: { fun: 1, outdoors: 0.7 },
  park: { outdoors: 1, relaxing: 0.8 },
  playground: { fun: 1, outdoors: 0.7 },
  walk: { outdoors: 1, relaxing: 0.8 },
  beach: { outdoors: 1, relaxing: 0.8 },
  // A swimming pool is a swim, not a thrill. The white-water and wake-boarding
  // end of water is a different thing and comes in as its own place rule.
  // A lido is a day out and a leisure-centre pool is exercise, and the map
  // calls both of them this. It leads with Fun (owner: "the Lido… more like
  // fun") and the pools that are really exercise are named as types below.
  swimming: { fun: 0.9, activity: 0.5, relaxing: 0.3 },
  cinema: { fun: 1, relaxing: 0.7 },
  theatre: { culture: 1 },
  'live-music': { culture: 1, fun: 0.8 },
  comedy: { fun: 1 },
  // Watching sport is Sport, and it is not Adrenaline: the adrenaline belongs
  // to whoever is playing.
  'sports-game': { sport: 1, fun: 0.5, adrenaline: 0.2 },
  bowling: { fun: 1, activity: 0.4 },
  'mini-golf': { fun: 1, activity: 0.4 },
  climbing: { adrenaline: 1, activity: 0.8, fun: 0.5 },
  trampoline: { fun: 1, adrenaline: 0.8, activity: 0.5 },
  'ice-skating': { fun: 1, activity: 0.7, adrenaline: 0.5 },
  cycling: { outdoors: 1, activity: 0.9, adrenaline: 0.4 },
  'boat-trip': { outdoors: 1, relaxing: 0.7 },
  market: { relaxing: 1, outdoors: 0.7 },
  shopping: { relaxing: 1 },
  bookshop: { relaxing: 1, culture: 0.7 },
  arcade: { fun: 1 },
  'escape-room': { fun: 1, adrenaline: 0.6 },
  castle: { culture: 1, outdoors: 0.6 },
  history: { culture: 1 },
  viewpoint: { outdoors: 1, relaxing: 0.8 },
  farm: { fun: 1, outdoors: 0.8 },
  festival: { fun: 1, outdoors: 0.7 },
  'theme-park': { fun: 1, adrenaline: 0.9 },
};

/**
 * Where each atlas category starts.
 *
 * The atlas has its own eight words for what a place is (sources/wikimedia.js
 * ATTRACTION_ROOTS) because they answer a different question — what kind of
 * thing is this — from the six the home screen asks, which is what a day spent
 * there is like. A castle is `heritage` in one vocabulary and Culture in the
 * other, and a country park is `outdoors` in one and both Outdoors and Relaxing
 * in the other.
 *
 * These eight are the *coarsest* thing that can be said about a place, so they
 * are deliberately timid: `active` leads with Sport and keeps Adrenaline at
 * 0.2, which puts a sports venue nobody has taught us about on the Sport shelf
 * and nowhere near the Adrenaline one. Getting it onto Adrenaline is a rule
 * about the type, and types are what the back office teaches.
 *
 * Food is deliberately unreachable from here. The atlas holds no restaurants —
 * the owner: "I don't care about restaurant images… with restaurants it's more
 * about reviews and the menus" — so no atlas place can land on the Food shelf.
 */
export const BY_ATLAS_CATEGORY = {
  museum: { culture: 1 },
  arts: { culture: 1 },
  heritage: { culture: 1, outdoors: 0.3 },
  landmark: { culture: 0.9, outdoors: 0.3 },
  outdoors: { outdoors: 1, relaxing: 0.7 },
  animals: { fun: 1, outdoors: 0.7 },
  family: { fun: 1 },
  // `active` is the atlas's word for anything under "sports venue" or "race
  // track", which is overwhelmingly somewhere a fixture happens. An untaught
  // one lands on Sport rather than on Fun, where forty-seven stadiums and
  // racecourses were burying the days out.
  active: { sport: 0.9, fun: 0.4, adrenaline: 0.2 },
};

/** What an atlas place falls back to when its category is not one of the eight. */
const ATLAS_UNKNOWN = { culture: 0.9 };

/** The shape `rulesFor` hands over, and what an empty teaching table looks like. */
export const NO_RULES = { place: new Map(), kind: new Map(), category: new Map(), experience: new Map() };

/**
 * Several rules, one set of weights: the strongest claim on each shelf wins.
 *
 * A place is often several types at once — Alexandra Palace is an event venue
 * *and* a theatre building — and taking the maximum per shelf lets each type
 * speak for the shelf it knows about without any of them cancelling another
 * out. Averaging would let a vague type drag a specific one below the floor.
 */
function combine(matches) {
  const weights = {};
  for (const m of matches) {
    for (const [key, value] of Object.entries(m?.weights ?? {})) {
      if (!(key in RANK)) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      weights[key] = Math.max(weights[key] ?? 0, Math.min(1, n));
    }
  }
  return weights;
}

/** The shelves actually drawn: above the floor, strongest first, at most two. */
export function drawn(weights) {
  return Object.entries(weights)
    .filter(([, v]) => v >= SHELF_FLOOR)
    .sort((a, b) => b[1] - a[1] || RANK[a[0]] - RANK[b[0]])
    .slice(0, MAX_SHELVES)
    .map(([key]) => key)
    .sort((a, b) => RANK[a] - RANK[b]);
}

/**
 * Walk the rules from narrowest to broadest and stop at the first level that
 * says anything.
 *
 * Narrowest wins outright rather than blending: somebody who has said "this
 * particular place is Adrenaline" has said something more specific than any
 * type rule, and a blend would let the type quietly outvote them.
 */
function taught(rules, chain) {
  for (const [scope, subjects] of chain) {
    const hits = subjects.filter(Boolean).map((s) => rules?.[scope]?.get(String(s))).filter(Boolean);
    if (hits.length) return { weights: combine(hits), because: hits };
  }
  return null;
}

/**
 * The shelves an atlas attraction belongs on, and why.
 *
 * `kinds` is the raw list of Wikidata types the harvest kept on the row, which
 * is the whole reason it was kept: it is the only signal fine enough to tell a
 * motorsport circuit from a football ground, and both arrive here as `active`.
 */
export function shelvesForAtlas({ ref, category, kinds = [] } = {}, rules = NO_RULES) {
  const hit = taught(rules, [
    ['place', [ref]],
    ['kind', kinds],
    ['category', [category]],
  ]);
  const weights = hit?.weights ?? (BY_ATLAS_CATEGORY[category] ?? ATLAS_UNKNOWN);
  const because = hit?.because ?? [{
    scope: 'default',
    subject: category ?? null,
    subject_label: category ? `the atlas calls this ${category}` : 'the atlas has no word for this',
    weights,
    reason: 'Nothing has been taught about this place or its type, so it sits where its atlas category starts.',
  }];
  return { weights, shelves: drawn(weights), because };
}

/**
 * The shelves a place from the live look-around belongs on, and why.
 *
 * A place to eat is Food and only Food: a restaurant that also has a terrace is
 * still somewhere you go to eat, and putting it under Relaxing would make that
 * shelf useless. Somewhere to go that the map gave no tags for is Fun — the
 * broadest shelf and the honest one, because "Chobham Adventure Farm" with no
 * tags is still a day out, and hiding it because OpenStreetMap was terse would
 * lose real places.
 */
export function shelvesForVenue(venue, rules = NO_RULES) {
  const ref = venue?.source && venue?.sourcePlaceId ? `${venue.source}:${venue.sourcePlaceId}` : null;
  const hit = taught(rules, [
    ['place', [ref]],
    ['experience', venue?.experiences ?? []],
  ]);
  if (hit) return { weights: hit.weights, shelves: drawn(hit.weights), because: hit.because };

  if (EATING.has(venue?.category)) {
    const weights = { food: 1 };
    return {
      weights,
      shelves: ['food'],
      because: [{
        scope: 'default', subject: venue.category, subject_label: `somewhere you ${venue.category === 'cafe' ? 'have a coffee' : 'eat or drink'}`,
        weights, reason: 'Somewhere to eat is Food and nothing else.',
      }],
    };
  }

  const weights = combine((venue?.experiences ?? []).map((e) => ({ weights: BY_EXPERIENCE[e] })));
  const shelves = drawn(weights);
  if (!shelves.length) {
    const fallback = { fun: 1 };
    return {
      weights: fallback,
      shelves: ['fun'],
      because: [{
        scope: 'default', subject: null, subject_label: 'no tags',
        weights: fallback,
        reason: 'The map said nothing about this place. Somewhere to go with no tags is still a day out, so it goes on the broadest shelf rather than none.',
      }],
    };
  }
  return {
    weights,
    shelves,
    because: (venue?.experiences ?? []).filter((e) => BY_EXPERIENCE[e]).map((e) => ({
      scope: 'default', subject: e, subject_label: e, weights: BY_EXPERIENCE[e],
      reason: 'Where this experience starts before anybody teaches it.',
    })),
  };
}

/** The shelves alone, for callers that do not care why. */
export const moodsFor = (venue, rules) => shelvesForVenue(venue, rules).shelves;
export const moodsForAtlas = (place, rules) => shelvesForAtlas(place, rules).shelves;

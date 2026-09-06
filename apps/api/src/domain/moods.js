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
 * **One category per place, and one drawer inside it.** The owner, 5 Sep 2026:
 * "I don't want any duplication between categories, and I'd actually like to
 * have subcategories under each." So a place appears exactly once on the home
 * screen. The weights are still how that is decided — they used to say *how
 * many* shelves a place drew on and now they say *which one* — and the losing
 * claims are kept rather than thrown away, because "why is this under Sport"
 * is the question the back office exists to answer.
 *
 * **The drawer names the shelf.** A rule that says "castles" has said Culture
 * as well, because `shelf_subcategories.key` is unique across the whole table
 * and so a drawer belongs to exactly one cabinet. That is the no-duplication
 * rule at the second level, and it is enforced by the database rather than
 * remembered by whoever writes the next rule.
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
 * How many categories a place may appear under. One, and the owner's words are
 * the whole reason: "I don't want any duplication between categories."
 */
export const MAX_SHELVES = 1;

/**
 * Not a threshold any more — a confidence mark.
 *
 * It used to decide whether a shelf drew a card. Now the strongest claim always
 * wins, however weak it is, because a place has to be somewhere. What the floor
 * still says is whether anybody would defend the answer: a place whose best
 * claim is 0.4 is sitting where it is because nothing better was said about it,
 * and the back office lists those as the ones worth teaching.
 */
export const SHELF_FLOOR = 0.6;

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
function combine(matches, rank = RANK) {
  const weights = {};
  for (const m of matches) {
    for (const [key, value] of Object.entries(m?.weights ?? {})) {
      // A category the vocabulary does not have is a category somebody deleted
      // or mistyped; it contributes nothing rather than becoming a shelf.
      if (!(key in rank)) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      weights[key] = Math.max(weights[key] ?? 0, Math.min(1, n));
    }
  }
  return weights;
}

/**
 * The vocabulary as the resolver needs it: which cabinet each drawer is in, and
 * what order the chips are drawn in.
 *
 * Defaults to the eight in this file, so every pure caller — the tests, a
 * script, anything that has not read the table — still works without one.
 */
export const NO_VOCAB = { parentOf: new Map(), rank: RANK };
export const vocabularyOf = (categories, subcategories) => ({
  parentOf: new Map((subcategories ?? []).map((s) => [s.key, s.category_key])),
  rank: Object.fromEntries((categories ?? MOODS).map((c, i) => [c.key, i])),
});

/**
 * The one category a set of weights earns: the strongest claim, ties broken by
 * the order the chips are in.
 *
 * There is no floor here on purpose. A place has to be somewhere, and hiding a
 * weakly-placed one would make the home screen quietly lose places rather than
 * file them imperfectly. How confident the answer is comes back separately.
 */
export function winner(weights, rank = RANK) {
  const entries = Object.entries(weights ?? {});
  if (!entries.length) return null;
  return entries.sort((a, b) => b[1] - a[1] || (rank[a[0]] ?? 99) - (rank[b[0]] ?? 99))[0][0];
}

/** The old shape — one category, in a list — for callers that draw shelves. */
export const drawn = (weights, rank = RANK) => {
  const top = winner(weights, rank);
  return top ? [top] : [];
};

/**
 * Walk the rules from narrowest to broadest and stop at the first level that
 * says anything.
 *
 * Narrowest wins outright rather than blending: somebody who has said "this
 * particular place is Adrenaline" has said something more specific than any
 * type rule, and a blend would let the type quietly outvote them.
 *
 * "Says anything" means weights or a drawer. A rule may carry only a drawer —
 * most of migration 054 does — and that is a complete answer, because the
 * drawer names the cabinet.
 */
function taught(rules, chain) {
  for (const [scope, subjects] of chain) {
    const hits = subjects.filter(Boolean)
      .map((s) => rules?.[scope]?.get(String(s)))
      .filter((r) => r && (r.subcategory || Object.keys(r.weights ?? {}).length));
    if (hits.length) return { scope, hits };
  }
  return null;
}

/**
 * Where a place goes, and why — the whole decision in one place.
 *
 * Order of resolution:
 *   1. the narrowest level of rule that says anything at all;
 *   2. if a rule at that level names a drawer, the drawer's cabinet is the
 *      category and there is nothing to argue about;
 *   3. otherwise the strongest weight at that level wins;
 *   4. a drawer from any level is kept if — and only if — it belongs to the
 *      category that won. A place cannot be filed under Gardens and shown on
 *      Outdoors, so an inconsistent drawer is dropped rather than shown.
 */
function place(chain, rules, vocab, fallback) {
  const rank = vocab?.rank ?? RANK;
  const parentOf = vocab?.parentOf ?? new Map();
  const hit = taught(rules, chain);

  const weights = hit ? combine(hit.hits, rank) : fallback.weights;
  const because = hit ? hit.hits : [fallback.because];

  // The drawer, from the narrowest rule that names one, at any level.
  let drawer = hit?.hits.find((r) => r.subcategory)?.subcategory ?? null;
  if (!drawer) {
    for (const [scope, subjects] of chain) {
      const found = subjects.filter(Boolean)
        .map((s) => rules?.[scope]?.get(String(s)))
        .find((r) => r?.subcategory);
      if (found) { drawer = found.subcategory; break; }
    }
  }

  const named = drawer ? parentOf.get(drawer) ?? null : null;
  // A drawer at the winning level names the cabinet; otherwise the weights do,
  // and the drawer only survives if it agrees with them.
  const fromDrawer = hit?.hits.some((r) => r.subcategory) ? named : null;
  const category = fromDrawer ?? winner(weights, rank) ?? named;
  const subcategory = drawer && parentOf.get(drawer) === category ? drawer : null;

  return {
    category,
    subcategory,
    weights,
    because,
    // Whether anybody would defend this. Used by the back office to list the
    // places worth teaching, never to hide one.
    confident: (weights?.[category] ?? 0) >= SHELF_FLOOR || Boolean(subcategory),
    // The shape the screens already draw: one category, in a list.
    shelves: category ? [category] : [],
  };
}

/**
 * Where an atlas attraction goes, and why.
 *
 * `kinds` is the raw list of Wikidata types the harvest kept on the row, which
 * is the whole reason it was kept: it is the only signal fine enough to tell a
 * motorsport circuit from a football ground, and both arrive here as `active`.
 */
export function shelvesForAtlas({ ref, category, kinds = [] } = {}, rules = NO_RULES, vocab = NO_VOCAB) {
  const weights = BY_ATLAS_CATEGORY[category] ?? ATLAS_UNKNOWN;
  return place(
    [['place', [ref]], ['kind', kinds], ['category', [category]]],
    rules,
    vocab,
    {
      weights,
      because: {
        scope: 'default',
        subject: category ?? null,
        subject_label: category ? `the atlas calls this ${category}` : 'the atlas has no word for this',
        weights,
        subcategory: null,
        reason: 'Nothing has been taught about this place or its type, so it sits where its atlas category starts.',
      },
    },
  );
}

/**
 * Where a place from the live look-around goes, and why.
 *
 * A place to eat is Food and only Food: a restaurant that also has a terrace is
 * still somewhere you go to eat, and putting it under Relaxing would make that
 * shelf useless. Somewhere to go that the map gave no tags for is Fun — the
 * broadest shelf and the honest one, because "Chobham Adventure Farm" with no
 * tags is still a day out, and hiding it because OpenStreetMap was terse would
 * lose real places.
 */
export function shelvesForVenue(venue, rules = NO_RULES, vocab = NO_VOCAB) {
  const ref = venue?.source && venue?.sourcePlaceId ? `${venue.source}:${venue.sourcePlaceId}` : null;
  const chain = [['place', [ref]], ['experience', venue?.experiences ?? []]];

  if (EATING.has(venue?.category) && !taught(rules, [['place', [ref]]])) {
    const weights = { food: 1 };
    return place(chain, rules, vocab, {
      weights,
      because: {
        scope: 'default', subject: venue.category,
        subject_label: `somewhere you ${venue.category === 'cafe' ? 'have a coffee' : 'eat or drink'}`,
        weights, subcategory: null, reason: 'Somewhere to eat is Food and nothing else.',
      },
    });
  }

  // Where the experiences it was tagged with start, before anybody teaches it.
  const started = combine((venue?.experiences ?? []).map((e) => ({ weights: BY_EXPERIENCE[e] })), vocab?.rank ?? RANK);
  const any = Object.keys(started).length > 0;
  return place(chain, rules, vocab, {
    weights: any ? started : { fun: 1 },
    because: any
      ? {
        scope: 'default',
        subject: (venue?.experiences ?? []).find((e) => BY_EXPERIENCE[e]) ?? null,
        subject_label: (venue?.experiences ?? []).filter((e) => BY_EXPERIENCE[e]).join(', ') || 'what the map tagged it',
        weights: started, subcategory: null,
        reason: 'Where the experiences this place is tagged with start, before anybody teaches it.',
      }
      : {
        scope: 'default', subject: null, subject_label: 'no tags',
        weights: { fun: 1 }, subcategory: null,
        reason: 'The map said nothing about this place. Somewhere to go with no tags is still a day out, so it goes on the broadest shelf rather than none.',
      },
  });
}

/** The category alone, in a list, for callers that only draw shelves. */
export const moodsFor = (venue, rules, vocab) => shelvesForVenue(venue, rules, vocab).shelves;
export const moodsForAtlas = (p, rules, vocab) => shelvesForAtlas(p, rules, vocab).shelves;

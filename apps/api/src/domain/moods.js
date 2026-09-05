/**
 * What a day is about — the six words the Inspire screen leads with.
 *
 * This is a CLOSED SET, and deliberately so. It is the vocabulary the home
 * screen shows as chips, the vocabulary voice is interpreted against, and the
 * vocabulary one retrieved pool is sorted into. Adding a mood is adding a chip;
 * it never adds a provider call, because nothing here fetches — it reads the
 * `experiences` and `category` a search already returned and says which shelves
 * that place belongs on (Requirements: options are composed from one pool).
 *
 * A place may belong to several. A country park is Outdoors and Relaxing; a
 * climbing wall is Fun and Adrenaline. That is right: the chips are a way of
 * looking at the same pool, not a taxonomy of places.
 */

/** The chips, in the order they are drawn. */
export const MOODS = [
  { key: 'fun', label: 'Fun' },
  { key: 'food', label: 'Food' },
  { key: 'culture', label: 'Culture' },
  { key: 'adrenaline', label: 'Adrenaline' },
  { key: 'relaxing', label: 'Relaxing' },
  { key: 'outdoors', label: 'Outdoors' },
];

export const MOOD_KEYS = MOODS.map((m) => m.key);

/** Somewhere you eat or drink. Food is decided by what a place *is*, not by a tag. */
const EATING = new Set(['restaurant', 'cafe', 'pub', 'bar']);

/**
 * Which moods each experience belongs to, over the closed experience
 * vocabulary in `domain/concepts.js`. An experience the vocabulary does not
 * list contributes nothing rather than guessing.
 */
const BY_EXPERIENCE = {
  museum: ['culture'],
  'art-gallery': ['culture'],
  aquarium: ['fun', 'culture'],
  zoo: ['fun', 'outdoors'],
  park: ['outdoors', 'relaxing'],
  playground: ['fun', 'outdoors'],
  walk: ['outdoors', 'relaxing'],
  beach: ['outdoors', 'relaxing'],
  swimming: ['fun', 'adrenaline'],
  cinema: ['fun', 'relaxing'],
  theatre: ['culture'],
  'live-music': ['culture', 'fun'],
  comedy: ['fun'],
  'sports-game': ['fun', 'adrenaline'],
  bowling: ['fun'],
  'mini-golf': ['fun'],
  climbing: ['adrenaline', 'fun'],
  trampoline: ['adrenaline', 'fun'],
  'ice-skating': ['adrenaline', 'fun'],
  cycling: ['adrenaline', 'outdoors'],
  'boat-trip': ['outdoors', 'adrenaline'],
  market: ['relaxing', 'outdoors'],
  shopping: ['relaxing'],
  bookshop: ['relaxing', 'culture'],
  arcade: ['fun'],
  'escape-room': ['fun', 'adrenaline'],
  castle: ['culture', 'outdoors'],
  history: ['culture'],
  viewpoint: ['outdoors', 'relaxing'],
  farm: ['fun', 'outdoors'],
  festival: ['fun', 'outdoors'],
  'theme-park': ['fun', 'adrenaline'],
};

/**
 * The moods a place belongs to.
 *
 * A place to eat is Food and only Food: a restaurant that also has a terrace is
 * still somewhere you go to eat, and putting it under Relaxing would make that
 * shelf useless. Somewhere to go that the map gave no tags for is Fun — the
 * broadest shelf and the honest one, because "Chobham Adventure Farm" with no
 * tags is still a day out, and hiding it because OpenStreetMap was terse would
 * lose real places.
 */
export function moodsFor(venue) {
  if (EATING.has(venue?.category)) return ['food'];
  const out = new Set();
  for (const e of venue?.experiences ?? []) for (const m of BY_EXPERIENCE[e] ?? []) out.add(m);
  if (!out.size) out.add('fun');
  return MOOD_KEYS.filter((k) => out.has(k));
}

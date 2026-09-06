/**
 * Roam's addresses, in one place.
 *
 * Every page has one, every layer inside a page has one, and both directions —
 * an address read into a route, a route written back into an address — live
 * here so they cannot drift apart. `test/routes.test.ts` walks every shape both
 * ways.
 *
 *   /                                  the home screen
 *   /inspire                           what there is to do near you
 *   /inspire/search                       …the where-search, open
 *   /inspire/culture                      …one shelf, opened out
 *   /inspire?place=<ref>                  …a place's drawer, over either
 *   /plan                              the conversational planner
 *   /places                            the atlas: near home, the UK, abroad
 *   /places/home                          …everything close to home
 *   /places/GB                            …one country: its areas, its trips
 *   /places/GB/London                     …one area
 *   /places/GB/London?place=<ref>         …a place's drawer
 *   /trips                             the trips
 *   /trips/new                            …the new-trip form
 *   /trips/<id>                           …one trip
 *   /trips/<id>/places                    …on one of its tabs
 *   /trips/<id>/day/<dayId>               …on one day of it
 *   /household                         the family
 *   /household/<memberId>                 …one person
 *   /settings, /settings/providers     settings, and its two halves
 *   /prototypes, /prototypes/trips     the mock-ups, filed by part of the app
 *   /admin/<screen>                    the back office
 *   /join/<token>                      somebody else's door into one trip
 *
 * The query string is never the page — it is how the page is set: which filter,
 * which sort, which drawer is open over it. That split is what keeps one page
 * from having a dozen spellings.
 */

import type { MoodKey } from './api';

// ---------------------------------------------------------------------------
// Addresses, as strings
// ---------------------------------------------------------------------------
// Pure, and here rather than in router.tsx, so that what an address means can
// be tested without a React tree behind it (test/routes.test.ts).

/** "/a/b?x=1" → "/a/b", ["a","b"], {x:1}. Segments come back decoded. */
export function splitHref(href: string): { path: string; segments: string[]; query: URLSearchParams } {
  const cut = href.indexOf('?');
  const path = cut === -1 ? href : href.slice(0, cut);
  const query = new URLSearchParams(cut === -1 ? '' : href.slice(cut + 1));
  const segments = path.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  return { path, segments, query };
}

/** ["places","GB","Lake District"] + {kind:"eat"} → "/places/GB/Lake%20District?kind=eat". */
export function buildHref(segments: (string | null | undefined)[], query?: URLSearchParams | Record<string, string | null | undefined>): string {
  const path = `/${segments.filter((s): s is string => !!s).map((s) => encodeURIComponent(s)).join('/')}`;
  const q = query instanceof URLSearchParams ? query : toParams(query ?? {});
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * One address changed in part: "/places/home?kind=eat" + {type: null} keeps the
 * kind and drops the type. An empty or missing value means "not in the address"
 * — the default is never written down — and the path is left alone unless
 * `base` says otherwise, which is what the taps that move *and* set a filter
 * need ("/places/GB/London?kind=eat" from a chip on another page).
 *
 * It composes, which is the point: a handler that changes two things is two
 * calls, and the second must start from what the first wrote.
 */
export function withQuery(href: string, patch: Record<string, string | null | undefined>, base?: string): string {
  const { path, query } = splitHref(href);
  const q = new URLSearchParams(query);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') q.delete(k); else q.set(k, v);
  }
  const rest = q.toString();
  const on = base ?? path;
  return rest ? `${on}?${rest}` : on;
}

function toParams(o: Record<string, string | null | undefined>): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') q.set(k, v);
  return q;
}


export type Tab = 'inspire' | 'plan' | 'places' | 'trips' | 'household' | 'settings' | 'prototypes';

export const MOODS: MoodKey[] = ['fun', 'food', 'culture', 'sport', 'activity', 'adrenaline', 'relaxing', 'outdoors'];

/**
 * A trip's tabs. The first three are the ones on the segmented control
 * (handover, 5 Sep 2026: "Itinerary | Places · n | Map"); the rest are the
 * working surfaces, which moved into the ⋯ menu rather than being taken away.
 */
export type TripSection = 'itinerary' | 'places' | 'map' | 'find' | 'shortlist' | 'day' | 'stay' | 'group' | 'data';
export const TRIP_SECTIONS: TripSection[] = ['itinerary', 'places', 'map', 'find', 'shortlist', 'day', 'stay', 'group', 'data'];
/**
 * The tabs the segmented control draws; the others are reached from the ⋯ menu.
 *
 * Group is one of them (owner, 5 Sep 2026: "We've lost the group tab… can you
 * please add group into the boxes at the top?"). It is not a working surface
 * like Find or the shortlist — it is other people, waiting on you — so putting
 * it behind a menu made it something you had to remember to go and look at.
 */
export const TRIP_TABS: TripSection[] = ['itinerary', 'places', 'map', 'group'];

export type SettingsSection = 'preferences' | 'providers';
export const SETTINGS_SECTIONS: SettingsSection[] = ['preferences', 'providers'];

export type PrototypeSection = 'plan' | 'places' | 'trips' | 'household' | 'settings';
export const PROTOTYPE_SECTIONS: PrototypeSection[] = ['plan', 'places', 'trips', 'household', 'settings'];

export type AdminScreen =
  | 'overview' | 'accounts' | 'households' | 'activity' | 'reporting'
  | 'coverage' | 'places' | 'library' | 'shelves' | 'scout' | 'roles' | 'plans' | 'audit' | 'how';
export const ADMIN_SCREENS: AdminScreen[] = [
  'overview', 'accounts', 'households', 'activity', 'reporting', 'coverage', 'places', 'library', 'shelves', 'scout', 'roles', 'plans', 'audit', 'how',
];

/**
 * Where the atlas is pointed: nowhere yet, close to home, one country, or one
 * area inside it. A country is a page now — its areas and its trips (handover,
 * 5 Sep 2026) — so it has an address of its own.
 */
export type PlacesScope = null | { home: true } | { country: string; city: string | null };

export type Route =
  | { name: 'inspire'; searching: boolean; shelf: MoodKey | null }
  | { name: 'plan' }
  | { name: 'places'; scope: PlacesScope }
  | { name: 'trips'; creating: boolean; tripId: string | null; section: TripSection | null; dayId: string | null }
  | { name: 'household'; memberId: string | null }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'prototypes'; section: PrototypeSection | null }
  | { name: 'admin'; screen: AdminScreen }
  | { name: 'join'; token: string }
  | { name: 'unknown'; path: string };

const oneOf = <T extends string>(all: readonly T[], v: string | undefined): T | null =>
  (v != null && (all as readonly string[]).includes(v) ? (v as T) : null);

/**
 * An address, read.
 *
 * Unknown paths come back as `unknown` rather than quietly becoming the home
 * screen: a mistyped or dead link should say so, not pretend it worked.
 */
export function parseRoute(path: string): Route {
  const { segments } = splitHref(path);
  const [head, a, b, c] = segments;

  if (!head) return { name: 'inspire', searching: false, shelf: null };

  switch (head) {
    case 'inspire': {
      if (!a) return { name: 'inspire', searching: false, shelf: null };
      if (a === 'search') return { name: 'inspire', searching: true, shelf: null };
      const shelf = oneOf(MOODS, a);
      // Food is a door into Places, never a shelf, so it has no address here.
      return shelf && shelf !== 'food'
        ? { name: 'inspire', searching: false, shelf }
        : { name: 'unknown', path };
    }

    case 'plan':
      return a ? { name: 'unknown', path } : { name: 'plan' };

    case 'places': {
      if (!a) return { name: 'places', scope: null };
      if (a === 'home') return { name: 'places', scope: { home: true } };
      // A country is a page: the areas in it, and the trips that went there.
      if (!b) return { name: 'places', scope: { country: a.toUpperCase(), city: null } };
      return { name: 'places', scope: { country: a.toUpperCase(), city: b } };
    }

    case 'trips': {
      if (!a) return { name: 'trips', creating: false, tripId: null, section: null, dayId: null };
      if (a === 'new') return { name: 'trips', creating: true, tripId: null, section: null, dayId: null };
      const section = oneOf(TRIP_SECTIONS, b);
      if (b && !section) return { name: 'unknown', path };
      return { name: 'trips', creating: false, tripId: a, section, dayId: section === 'day' ? c ?? null : null };
    }

    case 'household':
      return { name: 'household', memberId: a ?? null };

    case 'settings': {
      if (!a) return { name: 'settings', section: 'preferences' };
      const section = oneOf(SETTINGS_SECTIONS, a);
      return section ? { name: 'settings', section } : { name: 'unknown', path };
    }

    case 'prototypes': {
      if (!a) return { name: 'prototypes', section: null };
      const section = oneOf(PROTOTYPE_SECTIONS, a);
      return section ? { name: 'prototypes', section } : { name: 'unknown', path };
    }

    case 'admin': {
      const screen = oneOf(ADMIN_SCREENS, a ?? 'overview');
      return screen ? { name: 'admin', screen } : { name: 'unknown', path };
    }

    case 'join':
      return a ? { name: 'join', token: a } : { name: 'unknown', path };

    default:
      return { name: 'unknown', path };
  }
}

/** A route, written. The inverse of `parseRoute`, and the only place hrefs are spelled. */
export function hrefOf(route: Route): string {
  switch (route.name) {
    case 'inspire':
      return route.searching ? '/inspire/search' : route.shelf ? buildHref(['inspire', route.shelf]) : '/inspire';
    case 'plan': return '/plan';
    case 'places':
      return route.scope == null ? '/places'
        : 'home' in route.scope ? '/places/home'
          : buildHref(['places', route.scope.country, route.scope.city]);
    case 'trips':
      return route.creating ? '/trips/new'
        : route.tripId == null ? '/trips'
          : buildHref(['trips', route.tripId, route.section, route.section === 'day' ? route.dayId : null]);
    case 'household': return buildHref(['household', route.memberId]);
    case 'settings': return route.section === 'preferences' ? '/settings' : buildHref(['settings', route.section]);
    case 'prototypes': return buildHref(['prototypes', route.section]);
    case 'admin': return buildHref(['admin', route.screen]);
    case 'join': return buildHref(['join', route.token]);
    case 'unknown': return route.path;
  }
}

/** The addresses screens link to, spelled once. */
export const paths = {
  inspire: () => '/inspire',
  inspireSearch: () => '/inspire/search',
  inspireShelf: (mood: MoodKey) => buildHref(['inspire', mood]),
  plan: () => '/plan',
  places: () => '/places',
  placesHome: () => '/places/home',
  placesCountry: (country: string) => buildHref(['places', country]),
  placesCity: (country: string, city: string) => buildHref(['places', country, city]),
  trips: () => '/trips',
  newTrip: () => '/trips/new',
  trip: (id: string, section?: TripSection | null, dayId?: string | null) =>
    buildHref(['trips', id, section, section === 'day' ? dayId : null]),
  household: (memberId?: string | null) => buildHref(['household', memberId]),
  settings: (section?: SettingsSection) => (section && section !== 'preferences' ? buildHref(['settings', section]) : '/settings'),
  prototypes: (section?: PrototypeSection | null) => buildHref(['prototypes', section]),
  admin: (screen: AdminScreen) => buildHref(['admin', screen]),
  join: (token: string) => buildHref(['join', token]),
};

/** Which tab in the shell a route belongs under, so the rail can light up. */
export function tabOf(route: Route): Tab | null {
  switch (route.name) {
    case 'inspire': return 'inspire';
    case 'plan': return 'plan';
    case 'places': return 'places';
    case 'trips': return 'trips';
    case 'household': return 'household';
    case 'settings': return 'settings';
    case 'prototypes': return 'prototypes';
    default: return null;
  }
}

/** One layer up, for a Back that has no history behind it (a link somebody was sent). */
export function parentOf(route: Route): string {
  switch (route.name) {
    case 'inspire': return route.searching || route.shelf ? '/inspire' : '/inspire';
    case 'places':
      if (!route.scope) return '/inspire';
      if ('home' in route.scope) return '/places';
      return route.scope.city ? paths.placesCountry(route.scope.country) : '/places';
    case 'trips':
      if (route.dayId) return paths.trip(route.tripId!, 'day');
      if (route.section) return paths.trip(route.tripId!);
      if (route.tripId || route.creating) return '/trips';
      return '/inspire';
    case 'household': return route.memberId ? '/household' : '/inspire';
    case 'admin': return route.screen === 'overview' ? '/inspire' : '/admin/overview';
    default: return '/inspire';
  }
}

/**
 * What the browser tab says. A window full of Roam tabs is otherwise seven
 * identical ones, and the address is only half of being able to find your way
 * back to a page.
 */
export function titleOf(route: Route): string {
  const roam = (s?: string) => (s ? `${s} · Roam` : 'Roam');
  switch (route.name) {
    case 'inspire': return roam(route.searching ? 'Where should we go?' : route.shelf ? `${route.shelf[0].toUpperCase()}${route.shelf.slice(1)}` : 'Inspire');
    case 'plan': return roam('Plan');
    case 'places':
      return roam(route.scope == null ? 'Places' : 'home' in route.scope ? 'Close to home' : route.scope.city ?? route.scope.country);
    case 'trips': return roam(route.creating ? 'A new trip' : route.tripId ? 'Trip' : 'Trips');
    case 'household': return roam('Household');
    case 'settings': return roam('Settings');
    case 'prototypes': return roam('Prototypes');
    case 'admin': return roam(`Back office — ${route.screen}`);
    case 'join': return roam('Your trip');
    case 'unknown': return roam('Not a page');
  }
}

/**
 * The addresses Roam used to have (`?tab=trips&trip=…&section=…`, `?join=…`),
 * turned into the ones it has now.
 *
 * The owner keeps these on his phone and group invites went out to people who
 * have never heard of Roam, so an old link has to keep working — it is answered
 * once, with a replace, and the new address is what stays in the bar.
 */
export function legacyHref(path: string, query: URLSearchParams): string | null {
  if (path !== '/' && path !== '') return null;
  const join = query.get('join');
  if (join) return paths.join(join);
  const tab = query.get('tab');
  if (!tab) return null;
  const keep = new URLSearchParams();
  // A magic link is redeemed by the Gate before any of this and is taken out of
  // the bar there, so it travels across the redirect rather than being dropped.
  const signin = query.get('signin');
  if (signin) keep.set('signin', signin);
  const q = keep.toString();
  const withQuery = (href: string) => (q ? `${href}${href.includes('?') ? '&' : '?'}${q}` : href);

  if (tab === 'trips') {
    const trip = query.get('trip');
    const section = oneOf(TRIP_SECTIONS, query.get('section') ?? undefined);
    return withQuery(trip ? paths.trip(trip, section) : paths.trips());
  }
  const known: Record<string, string> = {
    inspire: paths.inspire(), plan: paths.plan(), places: paths.places(),
    household: paths.household(), settings: paths.settings(), prototypes: paths.prototypes(),
  };
  return known[tab] ? withQuery(known[tab]) : null;
}

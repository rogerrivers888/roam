/**
 * What may be written to the device, and what may not.
 *
 * This is the licence, in code. Technical Constraints §4: a place identifier
 * may be kept for ever, a Google coordinate for thirty days, and a provider's
 * display content — name, hours, reviews, photos, price — not at all. A phone
 * in a pocket is somewhere we cannot reach to delete anything from, so the rule
 * here is stricter than the rule on the server: nothing rented goes to a device
 * at all, whatever its expiry would have been.
 *
 * That leaves plenty, because the owned layer exists (api/src/sources/own.js):
 * OpenStreetMap, each venue's own published details and the open encyclopedias,
 * researched when the household shortlisted, saved or visited the place. Those
 * do not expire, so they can travel.
 *
 * Every answer the app receives passes through `storable`. An endpoint that is
 * not named here is not saved — a new one has to be thought about rather than
 * inherited, which is the only way this stays true as the app grows.
 */

/** Sources whose content we may keep: open data, or our own fixtures. */
const OPEN = new Set(['osm', 'fixtures']);
export const isOpenSource = (venueRef?: string | null) => OPEN.has(String(venueRef ?? '').split(':')[0]);

const path = (full: string) => full.split('?')[0];
const isTripDetail = (p: string) => /^\/api\/trips\/[^/]+$/.test(p);
const isJourney = (p: string) => /^\/api\/trips\/[^/]+\/journey$/.test(p);
const isDirections = (p: string) => /^\/api\/trips\/[^/]+\/directions$/.test(p);
const isVisit = (p: string) => /^\/api\/visits\/[^/]+$/.test(p);
const isJoin = (p: string) => /^\/api\/join\/[^/]+$/.test(p);

/**
 * A place row carries a `venue` snapshot. For an open source that snapshot is
 * ours to keep; for a licensed one the atlas merges in what it fetched this
 * session (routes/atlas.js `taxonomyKept`), and that must not be written down.
 */
function cleanPlaceRow<T extends { venueRef?: string; venue?: unknown }>(row: T): T {
  return isOpenSource(row.venueRef) ? row : { ...row, venue: null };
}

/**
 * The body to save for this path, or null to save nothing.
 *
 * Never mutates what it is given: the app goes on using the full answer for as
 * long as it is on screen. Only the return value is written down.
 */
export function storable(fullPath: string, body: any): any | null {
  const p = path(fullPath);
  if (!body || typeof body !== 'object') return null;

  // --- the household's own, in full -------------------------------------
  if (p === '/api/household' || p === '/api/household/learned') return body;
  if (p === '/api/concepts/browse') return body;
  if (p === '/api/visits' || isVisit(p)) return body;
  if (p === '/api/sources') return body;
  if (p === '/api/offline/manifest') return body;

  // --- the owned layer: researched by us, under licences that do not run out ---
  if (p === '/api/offline/records' || p === '/api/places/record') return body;

  // --- the atlas: household rows, with any rented taxonomy stripped ------
  if (p === '/api/atlas') return body;
  if (p === '/api/atlas/places') {
    return { ...body, places: (body.places ?? []).map(cleanPlaceRow) };
  }

  // The map a search is drawn on: a country's coast from Natural Earth and
  // administrative boundaries from OpenStreetMap, both open data and neither of
  // them about a venue. Keeping it means the sketch draws at once the second
  // time, and draws at all on a phone with no signal.
  if (p === '/api/atlas/sketch') return body;

  // --- trips: the household's plan, with the same strip on the shortlist --
  if (p === '/api/trips') return body;
  if (isTripDetail(p)) {
    return {
      ...body,
      shortlist: (body.shortlist ?? []).map(cleanPlaceRow),
    };
  }

  // --- a group trip: the participant's own list, and never the roster ----
  // Someone in a group is often the person with the worst signal — a car park,
  // a stadium, a coach — and what they need is their own three things, the
  // addresses and the dates. The organiser's view (/api/trips/:id/group) holds
  // every other participant's payment and booking state and is deliberately
  // absent from this file: it is a live read, and another person's money is not
  // written to anybody's phone. `expecting` is the list of names the organiser
  // added and is dropped for the same reason.
  if (isJoin(p)) return { ...body, expecting: [] };

  // --- the day itself, when the times in it are our own -----------------
  // A journey worked out from straight-line distance is Roam's own arithmetic
  // and is ours to keep, so the day someone is actually on is on their phone.
  // The same journey with real times in it is Google Routes' answer, which is
  // not, so that one is left behind and recomputed when there is signal.
  if (isJourney(p)) return body.estimated === true ? body : null;
  if (isDirections(p)) return body.estimated === true ? body : null;

  // --- a place's drawer: our side of it only -----------------------------
  // `venue` is the provider's record and never lands. `menu` is the live look
  // at their site and is not kept either — the menu address we researched
  // ourselves is on `ours` and that is the copy that stays.
  if (p === '/api/places/detail') {
    return {
      venueRef: body.venueRef,
      venue: isOpenSource(body.venueRef) ? body.venue : null,
      household: body.household ?? null,
      visits: body.visits ?? [],
      ours: body.ours ?? null,
      menu: null,
      sourceError: null,
    };
  }

  // Where the device says the household is standing (/api/places/where) falls
  // through here on purpose. The map's name for a point is open data and could
  // be kept, but a fix is not a fact about a place — it is a fact about a
  // person, this minute. It is used and dropped, never written down.
  //
  // Everything else — every search, every plan, every photo, every route — is
  // a provider's answer to a question asked once, and is not ours to write down.
  return null;
}

/** Whether an answer for this path could ever have been saved. */
export const isStorablePath = (fullPath: string) => storable(fullPath, { probe: true }) !== null;

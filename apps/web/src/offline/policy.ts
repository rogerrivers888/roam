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
const isTripPlaces = (p: string) => /^\/api\/trips\/[^/]+\/places$/.test(p);
const isJourney = (p: string) => /^\/api\/trips\/[^/]+\/journey$/.test(p);
const isDirections = (p: string) => /^\/api\/trips\/[^/]+\/directions$/.test(p);
const isVisit = (p: string) => /^\/api\/visits\/[^/]+$/.test(p);
const isJoin = (p: string) => /^\/api\/join\/[^/]+$/.test(p);

/**
 * A place row carries a `venue` snapshot. For an open source that snapshot is
 * ours to keep; for a licensed one the atlas merges in what it fetched this
 * session (routes/atlas.js `taxonomyKept`), and that must not be written down.
 *
 * `photos` goes the same way, and unconditionally. It is the provider's own
 * photograph, sent only for rows we own no picture of (sources/rentedPhoto.js),
 * and it is rented in the strictest sense there is: a reference Google reissues,
 * under a retention allowance of none. On the network it fills a tile that would
 * otherwise be a mint square; on a device it would be a licence breach we could
 * not reach to undo. So the card draws its category icon offline, which is the
 * honest thing for it to draw — we do not have that picture, we were only
 * allowed to look at it.
 */
function cleanPlaceRow<T extends { venueRef?: string; venue?: unknown; photos?: unknown }>(row: T): T {
  if (row.photos !== undefined) row = { ...row, photos: undefined };
  // `image` deliberately survives this. It is not a provider's photograph: it is
  // an id into our own library, and every row in there is something we are
  // allowed to keep — a Commons photograph, a CC BY-SA street-level frame, or a
  // business's own mark (sources/placePicture.js). The bytes are not in this
  // body anyway; they are `/api/images/…`, which the service worker holds as the
  // ordinary immutable files they are.
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

  // The atlas of attractions: the UK's counties, and the top fifteen to twenty
  // things to do in each. Kept in full, and deliberately, because every field
  // in it came from Wikidata (CC0), Wikipedia (CC BY-SA) or Wikimedia Commons —
  // licences that grant the right to keep and republish, with a credit that
  // travels on the row. Nothing rented is in this answer, so the rule that
  // sends nothing licensed to a device does not bite here.
  //
  // It is also the one part of Roam where holding a copy is the *point*: an
  // 18-row county with its placeholders is about 25KB, so a phone in a lane
  // with no signal still has somewhere to go. The photographs themselves are
  // not here — they are `/api/images/…`, cached by the service worker as
  // ordinary immutable files, which is what they are.
  if (p === '/api/atlas/regions' || /^\/api\/atlas\/regions\/[^/]+$/.test(p)) return body;

  // --- trips: the household's plan, with the same strip on the shortlist --
  if (p === '/api/trips') return body;
  if (isTripDetail(p)) {
    return {
      ...body,
      shortlist: (body.shortlist ?? []).map(cleanPlaceRow),
    };
  }
  // Every place a trip touched. Each row is a place the household put on this
  // trip and a name the household wrote (repositories/trips.js placesOfTrip);
  // no provider's record is carried, so there is nothing here to strip. It goes
  // to the device because a trip you are on is exactly the thing to be looking
  // at with no signal.
  if (isTripPlaces(p)) return body;

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
  // The home screen is deliberately not here either. `/api/inspire/near` is the
  // first thing Roam draws, so it is the first thing somebody will want on a
  // train — but it is a provider search, carrying their names, photos and
  // ratings, and being the home screen does not change whose they are. With no
  // signal it says so, and the household's own atlas (above) is what is there.
  //
  // Everything else — every search, every plan, every photo, every route — is
  // a provider's answer to a question asked once, and is not ours to write down.
  return null;
}

/** Whether an answer for this path could ever have been saved. */
export const isStorablePath = (fullPath: string) => storable(fullPath, { probe: true }) !== null;

// ---------------------------------------------------------------------------
// the other direction: what may wait on the device to be sent
// ---------------------------------------------------------------------------

/**
 * Whether a write that could not be sent may be kept and sent later.
 *
 * The read rule above is about a licence. This one is about time: a queued
 * write arrives minutes or hours after it was made, so the only writes that may
 * queue are the ones that still mean the same thing when they land. A rating
 * given in a restaurant with no signal means exactly what it meant an hour
 * later. A planning session's answer does not — the session lives ten hours and
 * the ideas in it are the provider's, so replaying one is at best a 404.
 *
 * Same discipline as `storable`: a path that is not named here is not queued.
 * The household is told either way (nothing is ever silently dropped), but only
 * these are promised to arrive on their own.
 */
export function queueable(method: string, fullPath: string): boolean {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return false;
  const p = path(fullPath);

  // What the household said about a place they went to: the point of the app,
  // and the thing most likely to be typed somewhere with no signal.
  if (p === '/api/visits' || isVisit(p)) return true;
  if (/^\/api\/visits\/[^/]+\/takes$/.test(p)) return true;

  // Claiming a place — shortlisted, saved, been, a favourite — and the notes on it.
  if (p === '/api/atlas/places' || /^\/api\/atlas\/places\//.test(p)) return true;
  if (/^\/api\/places\/[^/]+\/(note|verdict|special)$/.test(p)) return true;

  // The household itself: who is in it, what they cannot eat, what they dislike.
  if (p === '/api/household' || p.startsWith('/api/household/')) return true;

  // A trip's own shape: its days, its stops, its shortlist, who is coming.
  // Not `/api/trips/:id/shortlist/search` — that is a search, and a search run
  // late is a different search.
  if (/\/search(\/|$)/.test(p)) return false;
  if (p === '/api/trips' || /^\/api\/trips\/[^/]+/.test(p)) return true;

  // What was ordered and what each person thought of each dish.
  if (p === '/api/orders' || p.startsWith('/api/orders/')) return true;

  // A group participant ticking something off behind their invite link. They
  // are often the person with the worst signal — a car park, a stadium, a coach
  // — and "paid" means the same thing when it lands ten minutes later.
  //
  // Joining itself is not on the list: the answer to that one carries the
  // participant's own token, which their device needs to have before it can do
  // anything else. A join that went later, unanswered, would be a second person
  // in the group rather than the same one.
  if (/^\/api\/join\/[^/]+\/items\//.test(p)) return true;

  // Everything else — planning sessions, menu reads, provider searches, signing
  // in — is either bound to a session that expires or costs money to repeat.
  return false;
}

// Places the household can find, has been to, and has opinions about.
//
//   /api/places   — search the world (rented layer) and see what we think of it
//   /api/visits   — the owned record: we went, who came, what everyone thought
//
// A visit is the join between rented and owned data (Requirements §5, §8): a
// venue identifier plus a household-written label, date, attendees, note and
// takes. Everything on it survives even if the source's record goes away.

import { Router } from 'express';
import { withTransaction } from '../db.js';
import * as visitsRepo from '../repositories/visits.js';
import { searchAllSources, enabledSources, recallVenue, optInFrom } from '../sources/index.js';
import { geocode, reverseGeocode, providerCalls as geocodeCalls } from '../sources/geocode.js';
import { searchAreas, AREA_ATTRIBUTION, providerCalls as areaCalls } from '../sources/areas.js';
import { findMenuUrl } from '../sources/menuLink.js';
import { resolveConcept, conceptByKey } from '../domain/concepts.js';
import { kmBetween } from '../domain/travel.js';
import { contentsOf, groundsRadiusKm, researchInside } from '../sources/inside.js';
import { researchRestrictions, restrictionsEnabled } from '../sources/restrictions.js';
import { currentHousehold, loadMembers } from './household.js';
import { upsertHouseholdPlace } from './atlas.js';
import { googleSource } from '../sources/google.js';
import { claimPlace, ownedRecord, ownedRecords, enrich } from '../sources/own.js';
// Somewhere you eat, where the menu is the thing you want on the way in; and
// the three words a take may be.
import { FOOD_CATEGORIES as EATING, TAKES } from '../constants.js';

// ---------------------------------------------------------------------------
// A ride is not a day out (owner, 4 Sep 2026: "Saw the Ride… is a ride in
// Thorpe Park… the rides can't be mixed in with actual other events like
// Chertsey Museum or Staines Park").
//
// Some places have grounds: a theme park, a zoo, a water park, an aquarium.
// Anything the sources return from inside those grounds is something to do
// while you are there, not somewhere else to go, so it is marked with the place
// it belongs to. The list drops them; that place's own drawer shows them.
// ---------------------------------------------------------------------------
const GROUNDS = { 'theme-park': 1.2, zoo: 1.0, 'water-park': 0.8, aquarium: 0.4 };
const hasGrounds = (v) => (v.experiences || []).reduce((r, e) => Math.max(r, GROUNDS[e] ?? 0), 0);

export function markContained(venues) {
  const parents = venues
    .map((v) => ({ v, radiusKm: hasGrounds(v) }))
    .filter((p) => p.radiusKm > 0 && (p.v.ratingCount ?? 0) >= 200)
    .sort((a, b) => (b.v.ratingCount ?? 0) - (a.v.ratingCount ?? 0));
  if (!parents.length) return venues;
  for (const v of venues) {
    if (hasGrounds(v) > 0) continue; // a park inside a park is still its own place
    const home = parents.find((p) => p.v !== v && kmBetween(p.v, v) <= p.radiusKm);
    if (!home) continue;
    v.insideRef = home.v.venueRef ?? `${home.v.source}:${home.v.sourcePlaceId}`;
    v.insideName = home.v.name;
  }
  return venues;
}

export const places = Router();

/**
 * What is inside a place with grounds — the rides in a theme park, the animals
 * in a zoo (owner, 4 Sep 2026). Held in our own tables from sources we may keep,
 * so this is a read once a park has been researched, and researching it is one
 * open-map query rather than anything billable.
 *
 * GET /api/places/inside?ref=osm:way/123&lat=&lng=&kind=theme-park[&refresh=1]
 */
// Who may ride is a separate question with a separate bill: one model call per
// park, ever, started in the background the first time a household opens it.
const asking = new Set();
function askWhoCanRide(ref, name, website) {
  if (!restrictionsEnabled() || asking.has(ref)) return asking.has(ref);
  asking.add(ref);
  researchRestrictions({ parentRef: ref, parentName: name ?? null, website: website ?? null })
    .catch((err) => console.warn(`restrictions ${ref}: ${err.message}`))
    .finally(() => asking.delete(ref));
  return true;
}

places.get('/inside', async (req, res, next) => {
  try {
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref_required' });
    const experiences = String(req.query.experiences || req.query.kind || '').split(',').map((e) => e.trim()).filter(Boolean);
    const radiusKm = Number(req.query.radiusKm) || groundsRadiusKm(experiences);
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const held = await contentsOf(ref);
    // Nothing to research without somewhere to look, and nothing worth
    // researching for a place that has no grounds.
    if (held.length && !req.query.refresh) {
      return res.json({ ref, items: held, researched: false, askingWhoCanRide: askWhoCanRide(ref, req.query.name, req.query.website) });
    }
    if (!radiusKm || !Number.isFinite(lat) || !Number.isFinite(lng)) return res.json({ ref, items: held, researched: false });
    const items = await researchInside({ parentRef: ref, name: req.query.name ?? null, lat, lng, radiusKm, force: Boolean(req.query.refresh) });
    res.json({ ref, items, researched: true, askingWhoCanRide: askWhoCanRide(ref, req.query.name, req.query.website) });
  } catch (err) {
    next(err);
  }
});
export const visits = Router();


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function homeOf(household) {
  return household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null;
}

/**
 * The country the household lives in. Stored when home is set; a household that
 * set its home before the column existed has it looked up once, from the map,
 * and written down — so every search after the first knows which country to put
 * first without asking anybody anything.
 */
async function homeCountryOf(household) {
  if (household.home_country_code) return { code: household.home_country_code, name: household.home_country ?? null };
  if (household.home_lat == null) return null;
  const hit = await reverseGeocode(household.home_lat, household.home_lng, { zoom: 8 }).catch(() => null);
  if (!hit?.countryCode) return null;
  await visitsRepo.rememberHomeCountry(household.id, hit.countryCode, hit.country ?? null);
  household.home_country_code = hit.countryCode;
  household.home_country = hit.country ?? null;
  return { code: hit.countryCode, name: hit.country ?? null };
}

/** "near" may be "lat,lng", free text, or absent (home). */
async function resolveNear(nearParam, household) {
  const home = await homeOf(household);
  if (!nearParam) return home ? { ...home, how: 'home' } : null;
  const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(nearParam);
  if (m) return { label: nearParam, lat: Number(m[1]), lng: Number(m[3]), how: 'coords' };
  if (/^home$/i.test(nearParam.trim()) && home) return { ...home, how: 'home' };
  const [hit] = await geocode(nearParam, { limit: 1, near: home });
  return hit ? { ...hit, how: 'geocoded' } : null;
}

/** The household's relationship with a set of venue refs, in one query each. */
export async function householdStatus(householdId, refs) {
  if (!refs.length) return {};
  const { visitRows, ledgerRows } = await visitsRepo.statusForRefs(householdId, refs);
  const out = {};
  for (const r of visitRows) out[r.venue_ref] = { visits: r.visits, lastOn: r.last_on, loved: r.loved, notForMe: r.not_for_me };
  for (const r of ledgerRows) out[r.venue_ref] = { ...(out[r.venue_ref] || {}), ledger: r.status };
  return out;
}

/** The concept a whole-visit take attaches to: what kind of place it was. */
function visitConcept(venue) {
  if (venue?.experiences?.length) return conceptByKey(`experience:${venue.experiences[0]}`) ?? null;
  if (venue?.cuisines?.length) {
    for (const c of venue.cuisines) {
      const hit = conceptByKey(`cuisine:${c}`) ?? resolveConcept(c, { kinds: ['cuisine'] });
      if (hit) return hit;
    }
  }
  if (venue?.category && ['pub', 'bar', 'cafe'].includes(venue.category)) return conceptByKey(`cuisine:${venue.category}`);
  return null;
}

/** A score out of 5 in halves, or null. */
const cleanScore = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0.5 || n > 5 || Math.round(n * 2) !== n * 2) return null;
  return n;
};
/**
 * The two directions of the same scale, and the only place either is decided.
 *
 * The browser used to work both of these out and send the answer, which meant
 * the rule lived in two codebases and would drift the first time either moved.
 * Business logic belongs in the backend (the estate's engineering standard,
 * rule 7), so the app now sends what the person actually did — the stars they
 * tapped, or the word they chose — and this decides the rest.
 */
export const takeFromScore = (score) => (score >= 4 ? 'loved' : score <= 2 ? 'not_for_me' : 'fine');
const SCORE_FOR_TAKE = { loved: 5, fine: 3, not_for_me: 1 };
export const scoreFromTake = (take) => SCORE_FOR_TAKE[take] ?? null;

async function writeTakes(client, visitId, takes, venue) {
  for (const t of takes || []) {
    const given = cleanScore(t.score);
    const take = TAKES.includes(t.take) ? t.take : given != null ? takeFromScore(given) : null;
    if (!take) continue;
    // A word on its own still gives the row a number, so a one-tap "everyone
    // loved it" ranks beside a visit somebody gave four stars.
    const score = given ?? scoreFromTake(take);
    const subject = (t.subject || 'visit').trim();
    let concept = null;
    if (subject === 'visit') concept = visitConcept(venue);
    else concept = t.conceptKey ? conceptByKey(t.conceptKey) : resolveConcept(subject, { kinds: ['dish', 'experience'] });
    await visitsRepo.insertRating(visitId, {
      memberId: t.memberId, subject, take, comment: t.comment?.trim() || null, conceptKey: concept?.key ?? null, score,
    }, client);
  }
}

async function visitPayload(id) {
  const v = await visitsRepo.visitById(id);
  if (!v) return null;
  const { attendees, takes } = await visitsRepo.visitDetail(id);
  return {
    id: v.id,
    venueRef: v.venue_ref,
    venueLabel: v.venue_label,
    category: v.category,
    lat: v.lat,
    lng: v.lng,
    visitedOn: v.visited_on,
    note: v.note,
    country: v.country,
    countryCode: v.country_code,
    locality: v.locality,
    tripId: v.trip_id,
    stopId: v.stop_id,
    attendees,
    takes: takes.map((t) => ({
      id: t.id, memberId: t.member_id, member: t.member_name, subject: t.subject, take: t.take, comment: t.comment, score: t.score == null ? null : Number(t.score),
      conceptKey: t.concept_key, concept: conceptByKey(t.concept_key)?.label ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// /api/places
// ---------------------------------------------------------------------------

/**
 * GET /api/places/geocode?q=London&near=lat,lng&country=IT — for pickers (home,
 * trip location, "near", where we're staying). With `near`, matches inside that
 * area come first and the search never leaves `country`.
 */
places.get('/geocode', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(String(req.query.near || ''));
    const near = m ? { lat: Number(m[1]), lng: Number(m[3]) } : await homeOf(household);
    const countryCode = /^[A-Za-z]{2}$/.test(String(req.query.country || '')) ? String(req.query.country).toUpperCase() : null;
    const kind = req.query.kind === 'lodging' ? 'lodging' : req.query.kind === 'area' ? 'area' : null;
    const limit = Math.min(24, Number(req.query.limit) || 6);
    // Both sources answer from a short memory of what they have just been asked,
    // so a row is only written when a request actually went out.
    const before = { osm: geocodeCalls(), photon: areaCalls() };
    const [results, home] = await Promise.all([
      kind === 'area'
        ? searchAreas(String(req.query.q || ''), { limit, near, countryCode })
        : geocode(String(req.query.q || ''), { limit, near, countryCode, within: Boolean(m), kind }),
      kind === 'area' ? homeCountryOf(household) : null,
    ]);
    const made = [
      areaCalls() > before.photon ? 'photon' : null,
      geocodeCalls() > before.osm ? 'osm-nominatim' : null,
    ].filter(Boolean);
    for (const provider of made) {
      await visitsRepo.recordProviderCall(household.id, provider, kind === 'area' ? 'places.areas' : 'places.geocode');
    }
    res.json({ results, home: home ?? undefined, attribution: kind === 'area' ? AREA_ATTRIBUTION : '© OpenStreetMap contributors' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/places/where?at=51.5194,-0.1270 — the address a pair of coordinates
 * sits at, for "where I am". The device gives the fix (the browser asks the
 * household first, and only when they tap); the name comes from OpenStreetMap,
 * the same map every other place here is resolved against, so what comes back
 * is a Place a picker can hold like any other.
 *
 * Nothing is stored: a fix is where somebody is standing this minute, not a
 * fact about them. It is logged as a provider call because a request went out.
 */
places.get('/where', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(String(req.query.at || ''));
    if (!m) return res.status(400).json({ error: 'at_required', message: 'Say where, as "lat,lng".' });
    const lat = Number(m[1]);
    const lng = Number(m[3]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'at_invalid', message: 'That is not a point on the map.' });
    }
    // Street zoom, not building zoom: standing outside a parade of shops, the
    // honest answer is the street, not whichever shopfront the map happened to
    // tag nearest — we do not know they are inside it. If the map has nothing
    // there at all (mid-Atlantic, a new estate), the point itself is still a
    // usable starting place.
    const hit = await reverseGeocode(lat, lng, { zoom: 17 });
    await visitsRepo.recordProviderCall(household.id, 'osm-nominatim', 'places.where');
    // The street and the bit of town, and no more: a picker prints this line
    // above the town, region and postcode, so the full postal address would
    // just say everything twice. "Great Court, Bloomsbury", not "Great Court,
    // Bloomsbury, London, England, WC1B 3DG, United Kingdom".
    const near = hit ? [hit.address?.line1, hit.address?.area].filter(Boolean).join(', ') : '';
    const place = hit
      ? { ...hit, lat, lng, label: near || hit.label, formatted: near || hit.label || hit.formatted }
      : { label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, formatted: null, lat, lng, country: null, countryCode: null, locality: null, address: null };
    res.json({ place, named: Boolean(hit), attribution: '© OpenStreetMap contributors' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/places/search?q=&near=&categories=food,things&radiusKm=3
 * Real places near somewhere, with what the household already thinks of them.
 */
places.get('/search', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const near = await resolveNear(req.query.near ? String(req.query.near) : null, household);
    if (!near) return res.status(400).json({ error: 'near_required', message: 'Say where to look, or set a home address first.' });
    const categories = req.query.categories ? String(req.query.categories).split(',').filter(Boolean) : [];
    const radiusKm = Math.min(25, Number(req.query.radiusKm) || 3);
    const q = String(req.query.q || '').trim();
    const sources = optInFrom(req.query.sources);

    // Somebody is watching a spinner: give the sources a few seconds and show
    // what has arrived (owner, 4 Sep 2026 — "sushi in Windsor took more than a
    // minute"; Google had answered in a second and the wait was OpenStreetMap
    // running out its own clock). Nothing is lost: settleBy still waits
    // properly when not one source has found anything.
    const deadlineMs = Math.min(20_000, Math.max(2_000, Number(req.query.deadlineMs) || 6_000));
    const { venues, degraded, sourcesQueried, units } = await searchAllSources({
      center: { lat: near.lat, lng: near.lng }, radiusKm, categories, query: q, includeEvents: false, sources, deadlineMs,
    });
    await visitsRepo.recordProviderCall(household.id, sourcesQueried.join('+') || 'none', 'places.search', units);

    // A name is not a place on the map: searching "Sebastian's" from home must
    // not throw the restaurant away for being 10.75 km out when the radius says
    // 10 (owner, 4 Sep 2026). A browse is still fenced by the radius; a named
    // search is only ranked by distance.
    const fence = q ? Math.max(radiusKm, 40) : radiusKm;

    // Food & drink must mean food and drink. A source is asked for a kind of
    // place but is free to answer with anything the words matched, and the
    // licensed text search takes no type at all — so searching "Sunningdale" on
    // Food & drink came back with care homes, a pharmacy and barber shops
    // (owner, 4 Sep 2026). Whatever the sources hand over, the segment is kept
    // here, where no source can talk its way past it.
    const FOOD = new Set(['restaurant', 'cafe', 'pub', 'bar']);
    const THINGS = new Set(['attraction', 'event']);
    const wants = new Set(categories);
    const asked = wants.has('food') || wants.has('things') || [...wants].some((c) => FOOD.has(c) || THINGS.has(c));
    const isWanted = (v) => {
      if (!asked) return true;
      if ((wants.has('food') || [...wants].some((c) => FOOD.has(c))) && FOOD.has(v.category)) return true;
      if ((wants.has('things') || [...wants].some((c) => THINGS.has(c))) && THINGS.has(v.category)) return true;
      return false;
    };

    const inRange = venues
      .map((v) => ({ ...v, distanceKm: Number(kmBetween(near, v).toFixed(2)) }))
      .filter((v) => v.distanceKm <= fence && isWanted(v))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    const status = await householdStatus(household.id, inRange.map((v) => `${v.source}:${v.sourcePlaceId}`));
    const shown = inRange.slice(0, 120).map((v) => ({ ...v, venueRef: `${v.source}:${v.sourcePlaceId}`, household: status[`${v.source}:${v.sourcePlaceId}`] ?? null }));
    // A ride belongs to its park, not to the list beside it.
    markContained(shown);

    res.json({
      near: { label: near.label, lat: near.lat, lng: near.lng, how: near.how },
      radiusKm,
      results: shown,
      sourcesQueried,
      degradedSources: degraded,
      attribution: [...new Set(inRange.map((v) => v.attribution).filter(Boolean))],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/places/suggest?q=&near=lat,lng&session= — predictions as you type.
 * One cheap call per keystroke-burst; nothing is fetched until one is chosen,
 * and the point only biases the ranking.
 */
places.get('/suggest', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ suggestions: [] });
    const near = await resolveNear(req.query.near ? String(req.query.near) : null, household);
    // Somewhere already in the atlas comes first: searching "Sebastian's" the
    // week after you went there must not put a charity of the same name above
    // your own restaurant (owner, 4 Sep 2026).
    const mine = await visitsRepo.knownPlacesMatching(household.id, q);
    const ours = mine.map((r) => ({
      venueRef: r.venue_ref, placeId: String(r.venue_ref).startsWith('google:') ? String(r.venue_ref).slice(7) : null,
      name: r.label, where: [r.postcode, r.locality].filter(Boolean).join(' · ') || null,
      kind: r.been ? 'In your places · been' : 'In your places', mine: true, types: [], category: r.category ?? null,
    }));

    const meter = {};
    // Wide enough that a place in the next town still counts — Sebastian's is
    // 10.75 km from home — and tight enough that another county does not.
    const askedRadius = Math.min(50, Number(req.query.radiusKm) || 15);
    const ask = (only) => googleSource.suggest(q, {
      near: near ? { lat: near.lat, lng: near.lng } : null,
      radiusKm: Math.max(askedRadius, 30),
      sessionToken: String(req.query.session || '') || null,
      meter, only, restrict: Boolean(near),
    });

    // The provider returns five predictions, ranked by how well known a place
    // is. Typing "Sunningdale" spent all five on the town, its station car park,
    // its park and two golf clubs; Sunningdale Bistro Bar, which is what he
    // meant, never got a slot (owner, 4 Sep 2026). The kinds are not
    // interchangeable, so when none of the five is the kind being looked for,
    // ask again for that kind alone and put those first.
    // What the provider may be asked for: at most five primary types, and a
    // primary type is exact — a steakhouse is `steak_house`, not `restaurant`.
    const ASK_FOOD = ['restaurant', 'cafe', 'bar', 'pub', 'bakery'];
    const ASK_THINGS = ['tourist_attraction', 'museum', 'park', 'art_gallery', 'performing_arts_theater'];
    // What counts as that kind once it has answered: the whole type list, which
    // is forgiving where the primary type is not. A hair salon has none of these.
    const FOOD_TYPES = new Set(['restaurant', 'cafe', 'bar', 'pub', 'bakery', 'food', 'meal_takeaway', 'meal_delivery', 'coffee_shop', 'ice_cream_shop', 'sandwich_shop', 'steak_house', 'bar_and_grill', 'wine_bar', 'deli', 'pizzeria', 'fast_food_restaurant', 'dessert_shop', 'tea_house', 'juice_shop', 'donut_shop', 'bagel_shop', 'brunch_restaurant', 'breakfast_restaurant']);
    const THING_TYPES = new Set(['tourist_attraction', 'museum', 'park', 'art_gallery', 'performing_arts_theater', 'amusement_park', 'zoo', 'aquarium', 'historical_landmark', 'national_park', 'stadium', 'movie_theater', 'shopping_mall', 'church', 'place_of_worship', 'library', 'visitor_center', 'hiking_area', 'garden', 'monument', 'castle', 'concert_hall', 'night_club', 'bowling_alley', 'water_park']);
    const kind = ['do', 'eat'].includes(String(req.query.kind)) ? String(req.query.kind) : 'all';
    const isFood = (p) => (p.types || []).some((t) => FOOD_TYPES.has(t) || /_restaurant$/.test(t));
    const isThing = (p) => (p.types || []).some((t) => THING_TYPES.has(t));
    const GEO = new Set(['locality', 'postal_town', 'route', 'street_address', 'premise', 'sublocality', 'postal_code', 'administrative_area_level_1', 'administrative_area_level_2', 'country', 'geocode', 'neighborhood', 'intersection', 'plus_code']);
    const isPlace = (p) => (p.types || []).some((t) => !GEO.has(t));
    const merge = (a, b) => { const seen = new Set(a.map((p) => p.placeId)); return [...a, ...b.filter((p) => !seen.has(p.placeId))]; };

    let suggestions;
    if (kind === 'all') {
      // Nothing has been narrowed, so the open question first; food is what a
      // household looks for most, so that is the one worth asking twice for.
      suggestions = await ask(null);
      if (suggestions.filter(isFood).length < 2) {
        try { suggestions = merge(await ask(ASK_FOOD), suggestions); } catch { /* the first answer stands */ }
      }
    } else {
      // A segment is a promise: on Food & drink nothing but food is offered, so
      // no hair salon can appear there whatever the words matched (owner,
      // 4 Sep 2026). Ask for the kind first; only widen if that came back thin.
      const of = kind === 'eat' ? isFood : isThing;
      suggestions = await ask(kind === 'eat' ? ASK_FOOD : ASK_THINGS).catch(() => []);
      if (suggestions.length < 3) {
        try { suggestions = merge(suggestions, await ask(null)); } catch { /* what we have stands */ }
      }
      suggestions = suggestions.filter(of);
    }
    // Somewhere you can walk into comes before the map it sits on.
    suggestions = suggestions.map((p, i) => ({ p, i })).sort((a, b) => (isPlace(b.p) ? 1 : 0) - (isPlace(a.p) ? 1 : 0) || a.i - b.i).map((x) => x.p);
    await visitsRepo.recordProviderCall(household.id, 'google', 'places.suggest', JSON.stringify(meter)).catch(() => null);
    // Your own places obey the segment as well: a museum you saved does not
    // belong in a list of somewhere to eat.
    const FOOD_CATS = new Set(['restaurant', 'cafe', 'pub', 'bar']);
    const oursHere = ours.filter((o) => {
      if (kind === 'all' || !o.category) return true;
      return kind === 'eat' ? FOOD_CATS.has(o.category) : !FOOD_CATS.has(o.category);
    });
    const seen = new Set(oursHere.map((o) => o.placeId).filter(Boolean));
    res.json({ suggestions: [...oursHere, ...suggestions.filter((x) => !seen.has(x.placeId)).map((x) => ({ ...x, venueRef: `google:${x.placeId}`, mine: false }))] });
  } catch (err) { next(err); }
});

/** Venue refs are "source:id" and OSM ids contain a slash, so they travel as a query parameter. */
function splitRef(ref) {
  const [source, ...rest] = String(ref || '').split(':');
  return { source, id: rest.join(':') };
}

/** GET /api/places/detail?ref=osm:node/123 — one place, plus the household's history there. */
places.get('/detail', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { source, id } = splitRef(req.query.ref);
    if (!source || !id) return res.status(400).json({ error: 'ref_required' });
    const ref = `${source}:${id}`;
    // A ref the household already holds may be opened whatever the search opted into.
    const src = enabledSources({ includeOptIn: true }).find((s) => s.key === source);
    let venue = recallVenue(ref);
    let sourceError = null;
    if (!venue && src?.get) {
      const meter = {};
      try { venue = await src.get(id, { meter }); } catch (err) { sourceError = String(err?.message || err); }
      // A detail fetch is a provider call too (Google: one Place Details request; Tripadvisor: two billable entities).
      if (Object.keys(meter).length) await visitsRepo.recordProviderCall(household.id, source, 'places.detail', meter);
    }
    // The menu address, found now by following the website the source gave us:
    // one request to the restaurant's own page, free, and only for somewhere
    // you eat (owner, 4 Sep 2026). It runs beside our own records, so it costs
    // the drawer nothing it was not already waiting for.
    const menuLookup = venue?.website && EATING.has(venue.category)
      ? findMenuUrl({ website: venue.website, name: venue.name, locality: venue.locality ?? null, address: typeof venue.address === 'string' ? venue.address : venue.address?.line1 ?? null }).catch((err) => ({ url: null, label: null, how: null, why: `Could not reach their site (${String(err?.message || err).slice(0, 80)}).`, checkedAt: new Date().toISOString() }))
      : Promise.resolve(null);

    const visitRows = await visitsRepo.visitIdsAt(household.id, ref);
    const [history, status, menu, ours] = await Promise.all([
      Promise.all(visitRows.map((r) => visitPayload(r.id))),
      householdStatus(household.id, [ref]),
      menuLookup,
      // Our own record of this place, if the household has claimed it: open-data
      // and own-page facts that we may keep, and that the device may keep too.
      // It is what the drawer falls back to when the source is unreachable, and
      // the only part of this response that survives on a phone with no signal.
      ownedRecord(ref).catch(() => null),
    ]);
    res.json({ venueRef: ref, venue: venue ? { ...venue, venueRef: ref } : null, household: status[ref] ?? null, visits: history, menu, ours, sourceError });
  } catch (err) {
    next(err);
  }
});

/** POST /api/places/save { ref, status } — remember a place for later (or dismiss it). */
places.post('/save', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { source, id } = splitRef(req.body?.ref);
    if (!source || !id) return res.status(400).json({ error: 'ref_required' });
    const status = ['saved', 'dismissed', 'special'].includes(req.body?.status) ? req.body.status : 'saved';
    // Special is the household's own mark and comes from nowhere else — no
    // source has an opinion about it — and it is what you say after you have
    // been (owner, 4 Sep 2026). Somewhere you have not been can be saved to
    // try; it cannot be special yet.
    if (status === 'special') {
      if (!await visitsRepo.hasVisited(household.id, `${source}:${id}`)) {
        return res.status(409).json({ error: 'not_been', message: 'Special comes after you have been. Record the visit first, then mark it special.' });
      }
    }
    await visitsRepo.recordLedger(household.id, source, id, status);
    if (status !== 'dismissed') await upsertHouseholdPlace(null, household.id, { venueRef: `${source}:${id}`, label: req.body?.label, venue: req.body?.venue, category: req.body?.category, lat: req.body?.lat, lng: req.body?.lng, note: req.body?.note, country: req.body?.country, countryCode: req.body?.countryCode, locality: req.body?.locality });
    // Saving it is the household saying this one matters: our own research on it
    // starts now, behind the response (sources/own.js).
    if (status !== 'dismissed') {
      claimPlace(household.id, `${source}:${id}`, status === 'special' ? 'special' : 'saved',
        { name: req.body?.label ?? null, category: req.body?.category ?? null, lat: req.body?.lat ?? null, lng: req.body?.lng ?? null, website: req.body?.venue?.website ?? null });
    }
    res.json({ venueRef: `${source}:${id}`, status });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/places/record?ref=osm:node/123 (or ?refs=a,b,c) — what Roam owns
 * about a place: the research done when the household claimed it. No provider
 * is called and nothing here expires, so this is the endpoint a device can keep.
 */
places.get('/record', async (req, res, next) => {
  try {
    const refs = String(req.query.refs || req.query.ref || '').split(',').map((r) => r.trim()).filter(Boolean);
    if (!refs.length) return res.status(400).json({ error: 'ref_required' });
    const records = await ownedRecords(refs);
    res.json({ records, missing: refs.filter((r) => !records[r]) });
  } catch (err) { next(err); }
});

/** POST /api/places/record { ref, force } — research it again now (Settings, and the drawer's "look again"). */
places.post('/record', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const ref = String(req.body?.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref_required' });
    const result = await enrich(ref, { householdId: household.id, force: req.body?.force !== false, seed: req.body?.seed ?? {} });
    res.json({ ...result, record: await ownedRecord(ref) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// /api/visits
// ---------------------------------------------------------------------------

/**
 * POST /api/visits
 * { venueRef, venueLabel, category, lat, lng, visitedOn, attendeeIds, note, clientId,
 *   venue?: {experiences,cuisines,category}, takes?: [{memberId, subject, take, comment}] , tripId?, stopId? }
 */
visits.post('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const b = req.body || {};
    if (!b.venueRef || !b.venueLabel) return res.status(400).json({ error: 'venue_required' });
    const visitedOn = b.visitedOn || new Date().toISOString().slice(0, 10);

    // Same client id twice must not make two visits (Epic 6 C5).
    if (b.clientId) {
      const already = await visitsRepo.visitByClientId(b.clientId);
      if (already) return res.json({ visit: await visitPayload(already.id), deduplicated: true });
    }

    let where = { country: b.country ?? null, countryCode: b.countryCode ?? null, locality: b.locality ?? null };
    if (!where.countryCode && b.lat != null && b.lng != null) {
      try {
        const r = await reverseGeocode(b.lat, b.lng);
        if (r) where = { country: r.country, countryCode: r.countryCode, locality: r.locality };
      } catch { /* leave unknown */ }
    }

    const members = await loadMembers(household.id);
    const attendeeIds = (Array.isArray(b.attendeeIds) && b.attendeeIds.length ? b.attendeeIds : members.map((m) => m.id))
      .filter((id) => members.some((m) => m.id === id));

    const visitId = await withTransaction(async (client) => {
      const id = await visitsRepo.insertVisit(household.id, {
        clientId: b.clientId, tripId: b.tripId, stopId: b.stopId, venueRef: b.venueRef, venueLabel: b.venueLabel,
        category: b.category, lat: b.lat, lng: b.lng, visitedOn, note: b.note?.trim() || null, ...where,
      }, client);
      for (const memberId of attendeeIds) await visitsRepo.addAttendee(id, memberId, client);
      await writeTakes(client, id, b.takes, b.venue ?? { category: b.category });
      const [source, ...rest] = b.venueRef.split(':');
      await visitsRepo.recordLedger(household.id, source, rest.join(':'), 'visited', client);
      await upsertHouseholdPlace(client, household.id, { venueRef: b.venueRef, label: b.venueLabel, category: b.category, lat: b.lat, lng: b.lng, venue: b.venue, ...where });
      return id;
    });

    // "We visited it" is the strongest claim there is: research it now and keep
    // it for good, whatever happens to the source's record afterwards.
    claimPlace(household.id, b.venueRef, 'visited', { name: b.venueLabel, category: b.category ?? null, lat: b.lat ?? null, lng: b.lng ?? null, website: b.venue?.website ?? null });

    res.status(201).json({ visit: await visitPayload(visitId) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/visits?country=GB&q=&memberId=&take=loved — the household's history. */
visits.get('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { country, q, memberId, take } = req.query;
    const params = [household.id];
    const rows = await visitsRepo.visitsFor(household.id, { country, q, memberId, take }, TAKES);
    const facets = await visitsRepo.visitCountries(household.id);
    res.json({
      visits: rows.map((v) => ({
        id: v.id, venueRef: v.venue_ref, venueLabel: v.venue_label, category: v.category, lat: v.lat, lng: v.lng,
        visitedOn: v.visited_on, note: v.note, country: v.country, countryCode: v.country_code, locality: v.locality,
        tripId: v.trip_id, attendees: v.attendees ?? [], visitTakes: v.visit_takes ?? [], itemTakes: v.item_takes,
      })),
      countries: facets.map((f) => ({ code: f.country_code, name: f.country, visits: f.visits })),
    });
  } catch (err) {
    next(err);
  }
});

visits.get('/:id', async (req, res, next) => {
  try {
    const v = await visitPayload(req.params.id);
    if (!v) return res.status(404).json({ error: 'visit_not_found' });
    res.json({ visit: v });
  } catch (err) {
    next(err);
  }
});

visits.patch('/:id', async (req, res, next) => {
  try {
    const { note, visitedOn, venueLabel } = req.body || {};
    await visitsRepo.updateVisit(req.params.id, { note, visitedOn, venueLabel });
    res.json({ visit: await visitPayload(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/visits/:id/takes — replace what everyone thought. Body: { takes: [...], venue? } */
visits.put('/:id/takes', async (req, res, next) => {
  try {
    const visit = await visitsRepo.visitById(req.params.id);
    if (!visit) return res.status(404).json({ error: 'visit_not_found' });
    const venue = req.body?.venue ?? { category: visit.category };
    await withTransaction(async (client) => {
      await visitsRepo.clearRatings(req.params.id, client);
      await writeTakes(client, req.params.id, req.body?.takes, venue);
    });
    res.json({ visit: await visitPayload(req.params.id) });
  } catch (err) {
    next(err);
  }
});

visits.delete('/:id', async (req, res, next) => {
  try {
    if (!await visitsRepo.deleteVisit(req.params.id)) return res.status(404).json({ error: 'visit_not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { visitPayload };

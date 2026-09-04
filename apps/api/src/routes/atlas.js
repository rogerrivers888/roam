// The atlas: countries → cities → the household's places, across every trip.
//
//   GET /api/atlas                      countries and cities with counts
//   GET /api/atlas/places?country=&city=  places there: been / saved / special, with what everyone thought
//   GET /api/atlas/sketch?lat=&lng=      the map a search is drawn on while it runs
//
// Every visit, save, special or shortlist entry lands here (upsertHouseholdPlace),
// so going back somewhere makes the list longer, and a trip to that city starts
// from everything already known.

import { Router } from 'express';
import { withTransaction } from '../db.js';
import * as atlasRepo from '../repositories/atlas.js';
import { reverseGeocode, geocode } from '../sources/geocode.js';
import { searchAreas } from '../sources/areas.js';
import { recallVenue } from '../sources/index.js';
import { currentHousehold } from './household.js';
import { fillWhere } from '../sources/where.js';
import { fillTaxonomy, needsTaxonomy, taxonomyKept } from '../sources/taxonomy.js';
import { countryOutline, sketchFor, SKETCH_ATTRIBUTION } from '../sources/sketch.js';

export const atlas = Router();

// One background fill per household at a time.
const whereRunning = new Set();
const kindOfCategory = (c) => (['restaurant', 'cafe', 'pub', 'bar'].includes(c) ? 'food' : ['attraction', 'event'].includes(c) ? 'activity' : 'other');

// Reverse-geocoding is rate-limited; nearby points share a result.
const localityCache = new Map();
async function localityFor(lat, lng) {
  if (lat == null || lng == null) return null;
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (localityCache.has(key)) return localityCache.get(key);
  try {
    const r = await reverseGeocode(lat, lng);
    const v = r ? { country: r.country, countryCode: r.countryCode, locality: r.locality } : null;
    localityCache.set(key, v);
    return v;
  } catch { return null; }
}

/**
 * Record (or refresh) a place in the atlas.
 *
 * The judgement is here and the statement is in the repository. What a snapshot
 * may hold is the judgement that matters: only an open source's own facts are
 * ever written down, because a licensed provider's name, hours or rating must
 * never reach `household_places` (Technical Constraints §13.10).
 *
 * `client` is a transaction client, or null to use the pool.
 */
export async function upsertHouseholdPlace(client, householdId, p) {
  const venue = p.venue ?? recallVenue(p.venueRef) ?? null;
  const category = p.category ?? venue?.category ?? null;
  const lat = p.lat ?? venue?.lat ?? null;
  const lng = p.lng ?? venue?.lng ?? null;
  let where = { country: p.country ?? null, countryCode: p.countryCode ?? null, locality: p.locality ?? null };
  if (!where.countryCode) where = (await localityFor(lat, lng)) ?? where;
  const snapshot = venue && ['osm', 'fixtures'].includes(String(p.venueRef).split(':')[0])
    ? { category: venue.category, cuisines: venue.cuisines, experiences: venue.experiences, dietaryOptions: venue.dietaryOptions, address: venue.address, website: venue.website, openingHours: venue.openingHours }
    : null;
  await atlasRepo.upsertHouseholdPlace(client, householdId, {
    venueRef: p.venueRef,
    label: p.label ?? venue?.name ?? p.venueRef,
    kind: p.kind ?? kindOfCategory(category),
    category, lat, lng,
    country: where.country, countryCode: where.countryCode, locality: where.locality,
    venue: snapshot, note: p.note ?? null,
  });
}

/** GET /api/atlas — countries → cities with counts of places, visits and trips. */
atlas.get('/', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const rows = await atlasRepo.countryCityCounts(household.id);
    // Cities the household created on purpose, and cities its trips are in,
    // appear even before they have places.
    const { created, tripCities } = await atlasRepo.citiesWithoutPlaces(household.id);
    const countries = new Map();
    const ensure = (code, name) => { if (!countries.has(code)) countries.set(code, { code, name, places: 0, been: 0, cities: [] }); return countries.get(code); };
    const cityOf = (c, name) => { let ci = c.cities.find((x) => x.name === name); if (!ci) { ci = { name, places: 0, been: 0, special: 0, trips: 0, lastSeen: null, lat: null, lng: null, created: false }; c.cities.push(ci); } return ci; };
    for (const r of rows) {
      const c = ensure(r.country_code, r.country);
      c.places += r.places; c.been += r.been;
      Object.assign(cityOf(c, r.locality ?? 'Elsewhere'), { places: r.places, been: r.been, special: r.special, trips: r.trips, lastSeen: r.last_seen });
    }
    for (const r of created) { const ci = cityOf(ensure(r.country_code, r.country), r.locality); ci.created = true; ci.lat ??= r.lat; ci.lng ??= r.lng; }
    for (const r of tripCities) { const ci = cityOf(ensure(r.country_code, r.country), r.locality ?? 'Elsewhere'); ci.trips = Math.max(ci.trips, r.trips); ci.lat ??= r.lat; ci.lng ??= r.lng; }
    // Give place-derived cities a centre from their places, for "add a place here".
    const centres = await atlasRepo.cityCentres(household.id);
    for (const r of centres) { const c = countries.get(r.country_code); const ci = c?.cities.find((x) => x.name === r.locality); if (ci) { ci.lat ??= Number(r.lat); ci.lng ??= Number(r.lng); } }
    const unplaced = await atlasRepo.unplacedCount(household.id);

    // Close to home: everything within the household's radius of the front
    // door, whichever city it files under. Not a city — a standing view.
    let home = null;
    if (household.home_lat != null && household.home_lng != null) {
      const radiusMiles = household.home_radius_miles ?? 10;
      const near = await atlasRepo.nearHomeCounts(household.id, household.home_lat, household.home_lng, radiusMiles);
      home = { label: household.home_label, lat: household.home_lat, lng: household.home_lng, radiusMiles, ...near };
    }
    res.json({ countries: [...countries.values()].sort((a, b) => b.places - a.places), unplaced, home });
  } catch (err) { next(err); }
});

/** GET /api/atlas/places?country=GB&city=London&kind=food&status=been|saved|special */
atlas.get('/places', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { country, city, kind, status, q, nearHome } = req.query;
    // "Close to home" cuts across cities: everything within the radius, wherever it files.
    if (nearHome && (household.home_lat == null || household.home_lng == null)) return res.json({ places: [], wherePending: 0 });
    const rows = await atlasRepo.placesIn(
      household.id,
      { country, city, kind, q, nearHome: Boolean(nearHome) },
      { lat: household.home_lat, lng: household.home_lng, radiusMiles: household.home_radius_miles ?? 10 },
    );
    let places = rows.map((r) => ({
      venueRef: r.venue_ref, name: r.known_label ?? r.label, unnamed: (r.known_label ?? r.label) === r.venue_ref, kind: r.category ? kindOfCategory(r.category) : r.kind, category: r.category, lat: r.lat, lng: r.lng,
      country: r.country, countryCode: r.country_code, locality: r.locality, venue: r.venue, note: r.note,
      visits: r.visits, lastOn: r.last_on, takes: r.takes ?? [], ledger: r.ledger, onTrips: (r.on_trips ?? []).filter(Boolean),
      status: r.visits > 0 ? 'been' : r.ledger === 'special' ? 'special' : 'saved',
      special: r.ledger === 'special',
      scores: r.scores ?? [],
      postcode: r.postcode ?? null, station: r.station ?? null, stationLines: r.station_lines ?? [], stationKind: r.station_kind ?? null,
      stationDistanceM: r.station_distance_m ?? null, whereChecked: r.where_checked ?? null,
      loved: (r.takes ?? []).filter((t) => t.take === 'loved').length,
      notForMe: (r.takes ?? []).filter((t) => t.take === 'not_for_me').length,
    }));
    // A licensed source's kind of place is rented, so it is never stored: what
    // has been fetched since the service started is held in memory and merged in here.
    places = places.map((p) => {
      const kinds = taxonomyKept(p.venueRef);
      return kinds ? { ...p, venue: { ...(p.venue ?? {}), cuisines: kinds.cuisines, experiences: kinds.experiences } } : p;
    });
    if (status) places = places.filter((p) => (status === 'special' ? p.special : p.status === status));
    // Where a place is, and what kind of place it is, are looked up lazily a few
    // rows per read, after the response has gone; the web asks again shortly
    // while any row is still waiting.
    const pending = rows.filter((r) => r.lat != null && r.lng != null && !r.where_checked).length
      + rows.filter(needsTaxonomy).length;
    res.json({ places, wherePending: pending });
    if (pending && !whereRunning.has(household.id)) {
      whereRunning.add(household.id);
      Promise.resolve()
        .then(() => fillWhere(household.id, rows))
        .then(() => fillTaxonomy(household.id, rows))
        .catch(() => null)
        .finally(() => whereRunning.delete(household.id));
    }
  } catch (err) { next(err); }
});


/** PATCH /api/atlas/places { venueRef, label } — name a place that was only ever held by its identifier. */
atlas.patch('/places', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { venueRef, label } = req.body || {};
    if (!venueRef || !String(label || '').trim()) return res.status(400).json({ error: 'label_required' });
    await atlasRepo.nameUnnamedPlace(household.id, venueRef, String(label).trim());
    res.json({ venueRef, label: String(label).trim() });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/atlas/places { venueRef } — take a place out of the atlas
 * (owner, 4 Sep 2026: "I need to be able to delete stuff… manage my list, and
 * curate it"). The saved and dismissed marks go with it, so it does not walk
 * back in; a visit is a fact and is kept, so somewhere the household has
 * actually been reappears rather than being quietly erased.
 */
atlas.delete('/places', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const venueRef = String(req.body?.venueRef || '').trim();
    if (!venueRef) return res.status(400).json({ error: 'venue_ref_required' });
    if (await atlasRepo.visitCountFor(household.id, venueRef)) {
      return res.status(409).json({ error: 'has_visits', message: "You've been here, so it stays in your atlas. Delete the visit first if it was a mistake." });
    }
    await withTransaction((client) => atlasRepo.removePlace(client, household.id, venueRef));
    res.status(204).end();
  } catch (err) { next(err); }
});

/** POST /api/atlas/cities { placeText | place } — create a city on purpose. */
atlas.post('/cities', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const b = req.body || {};
    let place = b.place?.lat != null ? b.place : null;
    // Typed rather than picked: it is still a city or a region that is wanted, so ask the source that only knows those.
    if (!place && b.placeText) [place] = await searchAreas(b.placeText, { limit: 1 });
    if (!place) return res.status(404).json({ error: 'city_not_found', message: `Couldn't find "${b.placeText}". Try the city and country, e.g. "Lisbon, Portugal".` });
    // A city search returns the city itself; its locality is its own name.
    const locality = place.locality || place.label.split(',')[0];
    if (!place.countryCode) return res.status(400).json({ error: 'country_unknown', message: 'That place has no country in the map data.' });
    // A country is not a destination (owner, 3 Sep 2026): "United Kingdom" typed here used to become a city called United Kingdom.
    if (place.country && locality.trim().toLowerCase() === String(place.country).trim().toLowerCase()) {
      return res.status(400).json({ error: 'country_not_city', message: `${place.country} is a country — type a city or a region in it, like "Bath" or "Lake District".` });
    }
    await atlasRepo.upsertCity(household.id, { country: place.country, countryCode: place.countryCode, locality, lat: place.lat, lng: place.lng });
    res.status(201).json({ city: { name: locality, country: place.country, countryCode: place.countryCode, lat: place.lat, lng: place.lng } });
  } catch (err) { next(err); }
});

atlas.delete('/cities', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { countryCode, locality } = req.body || {};
    await atlasRepo.deleteCity(household.id, countryCode, locality);
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * GET /api/atlas/sketch?lat=&lng=&radiusKm=&country=GB
 *
 * The map a search is drawn on while it runs (owner, 4 Sep 2026; mock-up
 * /mockups/waiting-options.html): the country's coast, the named areas around
 * the point, and the ground the search covers. All of it open data and all of
 * it kept — see sources/sketch.js.
 *
 * It answers from what is stored, so it never holds a search up. The first
 * search in a new town gets the country and the one area the centre sits in;
 * the neighbours are filled in behind it and are there the next time.
 */
atlas.get('/sketch', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'point_required', message: 'lat and lng are required' });
    }
    const radiusKm = Math.min(50, Math.max(0.5, Number(req.query.radiusKm) || 3));
    let code = req.query.country ? String(req.query.country) : null;
    if (!code) code = (await localityFor(lat, lng))?.countryCode ?? null;
    const { place, areas, complete } = await sketchFor({ lat, lng, radiusKm });
    res.json({
      centre: { lat, lng }, radiusKm, place, areas, complete,
      country: countryOutline(code),
      attribution: SKETCH_ATTRIBUTION,
    });
  } catch (err) { next(err); }
});

// Trips: a day out or a fortnight abroad — same shape, different number of days
// (docs/trip-planner-design.md). Trip → days → stops in slots; a per-trip
// shortlist of researched places; a base to come back to.

import { Router } from 'express';
import { withTransaction } from '../db.js';
import * as trips from '../repositories/trips.js';
import { computeBudget, INTENSITY_TARGETS } from '../domain/budget.js';
import { TRAVEL_MODES } from '../domain/travel.js';
import { dayAsTrip, datesBetween, slotFor } from '../domain/days.js';
import { geocode, reverseGeocode } from '../sources/geocode.js';
import { searchAreas } from '../sources/areas.js';
import { optInFrom, enabledSources } from '../sources/index.js';
import { searchCached } from '../sources/cache.js';
import { bedsNear, OSM_ATTRIBUTION } from '../sources/stays.js';
import { rankStays, middleOf } from '../domain/stays.js';
import { kmBetween } from '../domain/travel.js';
import { currentHousehold } from './household.js';
import { visitPayload, householdStatus } from './places.js';
import { upsertHouseholdPlace } from './atlas.js';
import { claimPlace } from '../sources/own.js';

const router = Router();
const SLOTS = ['morning', 'afternoon', 'evening'];
const KINDS = ['food', 'activity', 'other'];
export const SHORTLIST_STATUSES = ['to_call', 'booked', 'no_booking', 'full', 'set_aside'];
export const LEG_MODES = ['walking', 'transit', 'driving', 'taxi'];

async function loadTrip(tripId) {
  const trip = await trips.tripById(tripId);
  if (!trip) { const err = new Error('Trip not found'); err.status = 404; err.code = 'trip_not_found'; throw err; }
  return trip;
}

export function publicTrip(t) {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    notes: t.notes,
    place: t.place_label ? { label: t.place_label } : null,
    startDate: t.start_date,
    endDate: t.end_date,
    dayStart: t.day_start?.slice(0, 5),
    dayEnd: t.day_end?.slice(0, 5),
    base: t.base_lat != null ? { label: t.base_label, lat: t.base_lat, lng: t.base_lng, kind: t.base_kind, checkIn: t.base_check_in, checkOut: t.base_check_out } : null,
    hasCar: t.has_car,
    sources: Array.isArray(t.sources) && t.sources.length ? t.sources : null,
    origin: { label: t.origin_label, lat: t.origin_lat, lng: t.origin_lng },
    destination: t.destination_label ? { label: t.destination_label, lat: t.destination_lat, lng: t.destination_lng } : null,
    departAt: t.depart_at,
    returnAt: t.return_at,
    travelMode: t.travel_mode,
    intensity: t.intensity,
    country: t.country,
    countryCode: t.country_code,
    locality: t.locality,
    timezone: t.timezone ?? null,
  };
}

export async function ensureDays(client, trip) {
  if (!trip.start_date || !trip.end_date) return;
  for (const date of datesBetween(trip.start_date, trip.end_date)) await trips.addDay(trip.id, date, client);
  await trips.trimDaysToRange(trip.id, trip.start_date, trip.end_date, client);
}

export async function placeTrip(client, tripId, point) {
  try {
    const r = await reverseGeocode(point.lat, point.lng);
    if (r) await trips.setTripPlace(tripId, r, client);
  } catch { /* unknown is acceptable */ }
}

export async function tripPayload(tripId) {
  const trip = await loadTrip(tripId);
  const household = await currentHousehold();
  const [days, stops, attendees, visitRows, shortlist] = await Promise.all([
    trips.daysOf(tripId), trips.stopsOf(tripId), trips.attendeesOf(tripId), trips.visitIdsOf(tripId), trips.shortlistOf(tripId),
  ]);
  const visitsByStop = new Map();
  for (const v of visitRows) if (v.stop_id) visitsByStop.set(v.stop_id, await visitPayload(v.id));
  const scheduledRefs = new Set(stops.map((s) => s.venue_ref));

  const dayPayloads = days.map((d) => {
    const virtual = dayAsTrip(trip, d);
    const dayStops = stops.filter((s) => s.day_id === d.id);
    const slotOrder = (s) => SLOTS.indexOf(s.slot || 'morning');
    dayStops.sort((a, b) => slotOrder(a) - slotOrder(b) || a.position - b.position);
    const budget = computeBudget({ trip: virtual, stops: dayStops.map((s, i) => ({ ...s, position: i + 1 })), household });
    return {
      id: d.id,
      date: d.date,
      intensity: virtual.intensity,
      travelMode: virtual.travel_mode,
      startTime: virtual.depart_at,
      endTime: virtual.return_at,
      notes: d.notes,
      slots: SLOTS.map((slot) => ({
        slot,
        stops: dayStops.filter((s) => (s.slot || 'morning') === slot).map((s) => ({
          id: s.id, position: s.position, venueRef: s.venue_ref, name: s.venue_name, lat: s.lat, lng: s.lng,
          dwellMinutes: s.dwell_minutes, startTime: s.start_time?.slice(0, 5) ?? null, visit: visitsByStop.get(s.id) ?? null,
          bookingStatus: s.booking_status ?? null, bookingRef: s.booking_ref ?? null, legMode: s.leg_mode ?? null,
        })),
      })),
      budget,
    };
  });

  return {
    trip: publicTrip(trip),
    attendees: attendees.map((a) => ({ id: a.id, name: a.name, isMinor: a.is_minor, avatarUrl: a.avatar_url })),
    days: dayPayloads,
    shortlist: shortlist.map((s) => ({
      id: s.id, venueRef: s.venue_ref, name: s.venue_label, kind: s.kind, category: s.category, lat: s.lat, lng: s.lng,
      venue: s.venue, note: s.note, mustDo: s.must_do, preferredDayId: s.preferred_day_id, scheduled: scheduledRefs.has(s.venue_ref),
      // The working state (owner, 3 Sep 2026): booking status, order, length, way of travelling to it.
      status: s.status ?? 'to_call', bookedTime: s.booked_time?.slice(0, 5) ?? null, partySize: s.party_size ?? null, bookingRef: s.booking_ref ?? null,
      statusNote: s.status_note ?? null, statusOn: s.status_on ?? null, position: s.position ?? null, dwellMinutes: s.dwell_minutes ?? null, legMode: s.leg_mode ?? null, dayId: s.day_id ?? null,
    })),
    // Legacy single-window view for outings (the Plan screen and older clients).
    stops: stops.map((s) => ({ id: s.id, position: s.position, venueRef: s.venue_ref, name: s.venue_name, lat: s.lat, lng: s.lng, dwellMinutes: s.dwell_minutes, visit: visitsByStop.get(s.id) ?? null })),
    budget: computeBudget({ trip, stops, household }),
  };
}

// ---------------------------------------------------------------------------
// List / create / update
// ---------------------------------------------------------------------------

/** GET /api/trips?country=GB&when=upcoming|past&kind=trip|outing&q= */
router.get('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { country, when, q, kind } = req.query;
    const unplaced = await trips.unplacedTrips(household.id);
    for (const t of unplaced) await placeTrip(null, t.id, { lat: t.base_lat ?? t.destination_lat ?? t.origin_lat, lng: t.base_lng ?? t.destination_lng ?? t.origin_lng });

    const rows = await trips.tripsFor(household.id, { country, kind, when, q });
    const facets = await trips.tripCountries(household.id);
    res.json({
      trips: rows.map((t) => ({
        ...publicTrip(t), dayCount: t.day_count, stopCount: t.stop_count, shortlistCount: t.shortlist_count, visitCount: t.visit_count, ratingCount: t.rating_count,
        attendees: t.attendees ?? [], isPast: new Date(t.end_date ?? t.return_at) < new Date(new Date().toDateString()),
      })),
      countries: facets.map((f) => ({ code: f.country_code, name: f.country, trips: f.trips })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/trips
 * Trip:   { kind:'trip', title, place|placeText, startDate, endDate, base|baseText, baseKind, hasCar, travelMode?, intensity?, dayStart?, dayEnd?, attendingMemberIds?, notes? }
 * Outing: { kind:'outing', origin|originText, destination|destinationText, departAt, returnAt, travelMode, intensity, attendingMemberIds }
 */
router.post('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const b = req.body || {};
    const home = household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null;
    const kind = b.kind === 'trip' ? 'trip' : 'outing';
    const travelMode = b.travelMode ?? (b.hasCar === false ? 'transit' : 'driving');
    const intensity = b.intensity ?? household.default_intensity;
    if (!TRAVEL_MODES.includes(travelMode)) return res.status(400).json({ error: 'invalid_mode' });
    if (!INTENSITY_TARGETS[intensity]) return res.status(400).json({ error: 'invalid_intensity' });
    const ids = async (client) => (Array.isArray(b.attendingMemberIds) && b.attendingMemberIds.length
      ? b.attendingMemberIds
      : trips.householdMemberIds(household.id, client));

    if (kind === 'trip') {
      if (!b.startDate || !b.endDate || b.endDate < b.startDate) return res.status(400).json({ error: 'dates_required', message: 'Start and end dates are needed, end on or after start.' });
      let place = b.place?.lat != null ? b.place : null;
      // Typed rather than picked: a trip is to a city or a region, never to a street.
      if (!place && b.placeText) [place] = await searchAreas(b.placeText, { limit: 1 });
      let base = b.base?.lat != null ? b.base : null;
      if (!base && b.baseText) [base] = await geocode(b.baseText, { limit: 1, near: place, countryCode: place?.countryCode ?? null, within: Boolean(place), kind: 'lodging' });
      if (!base && (b.baseKind === 'home' || (!place && home))) base = home;
      // Nowhere to stay yet. A trip still needs a point to search from, so the
      // middle of the city stands in — but it is marked as a stand-in, not as
      // somewhere they are staying, or the Stay tab would think it was booked.
      let unbooked = false;
      if (!base && place) { base = { ...place, label: `${place.label} (centre)` }; unbooked = true; }
      if (!base) return res.status(400).json({ error: 'place_required', message: 'Say where the trip is — a city or region — or where you are staying.' });

      const trip = await withTransaction(async (client) => {
        const created = await trips.insertTrip(household.id, {
          title: b.title?.trim() || null, notes: b.notes?.trim() || null,
          placeLabel: place?.label ?? b.placeText ?? base.label, startDate: b.startDate, endDate: b.endDate,
          baseLabel: base.label, baseLat: base.lat, baseLng: base.lng,
          baseKind: unbooked ? 'centre' : (b.baseKind ?? (base === home ? 'home' : 'hotel')),
          checkIn: b.checkIn ?? null, checkOut: b.checkOut ?? null, hasCar: b.hasCar !== false,
          dayStart: b.dayStart ?? '09:30', dayEnd: b.dayEnd ?? '21:00',
          travelMode, intensity, timezone: household.timezone || 'Europe/London',
        }, client);
        if (!unbooked) claimBase(household.id, base, b.baseKind ?? (base === home ? 'home' : 'hotel'));
        for (const memberId of await ids(client)) await trips.addAttendee(created.id, memberId, client);
        await ensureDays(client, created);
        await placeTrip(client, created.id, place ?? base);
        // Start from everything the household already knows in this city (atlas).
        if (b.seedFromAtlas !== false) {
          const loc = await trips.tripPlace(created.id, client);
          if (loc?.country_code) await trips.seedShortlistFromAtlas(created.id, household.id, loc.country_code, loc.locality, client);
        }
        return created;
      });
      return res.status(201).json(await tripPayload(trip.id));
    }

    // Outing (one day, base = origin, optional destination)
    let origin = b.origin?.lat != null ? b.origin : null;
    if (!origin && b.originText) [origin] = await geocode(b.originText, { limit: 1, near: home });
    if (!origin) origin = home;
    if (!origin) return res.status(400).json({ error: 'origin_required', message: 'Give a starting point, or set a home address in Settings.' });
    let destination = b.destination?.lat != null ? b.destination : null;
    if (!destination && b.destinationText) [destination] = await geocode(b.destinationText, { limit: 1, near: home });
    if (!b.departAt || !b.returnAt) return res.status(400).json({ error: 'window_required' });
    if (new Date(b.returnAt) <= new Date(b.departAt)) return res.status(400).json({ error: 'invalid_window' });

    const trip = await withTransaction(async (client) => {
      const created = await trips.insertOuting(household.id, {
        title: b.title?.trim() || null, notes: b.notes?.trim() || null,
        originLabel: origin.label, originLat: origin.lat, originLng: origin.lng,
        destinationLabel: destination?.label ?? null, destinationLat: destination?.lat ?? null, destinationLng: destination?.lng ?? null,
        departAt: b.departAt, returnAt: b.returnAt, travelMode, intensity,
        hasCar: b.hasCar !== false, timezone: household.timezone || 'Europe/London',
      }, client);
      for (const memberId of await ids(client)) await trips.addAttendee(created.id, memberId, client);
      await ensureDays(client, created);
      await trips.setDayDefaults(created.id, { intensity, travelMode }, client);
      await placeTrip(client, created.id, destination ?? origin);
      return created;
    });
    res.status(201).json(await tripPayload(trip.id));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => { try { res.json(await tripPayload(req.params.id)); } catch (err) { next(err); } });
/** What this trip's searches and plans have cost, by provider, so the picker can show the bill it is running up. */
router.get('/:id/spend', async (req, res, next) => {
  try {
    const rows = await trips.tripSpend(req.params.id);
    res.json({ calls: rows.reduce((n, r) => n + r.calls, 0), costUsd: rows.reduce((n, r) => n + r.cost_usd, 0), byProvider: rows });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const trip = await loadTrip(req.params.id);
    const b = req.body || {};
    if (b.travelMode && !TRAVEL_MODES.includes(b.travelMode)) return res.status(400).json({ error: 'invalid_mode' });
    if (b.intensity && !INTENSITY_TARGETS[b.intensity]) return res.status(400).json({ error: 'invalid_intensity' });
    let base = b.base?.lat != null ? b.base : null;
    if (!base && b.baseText) [base] = await geocode(b.baseText, { limit: 1, near: { lat: trip.base_lat ?? trip.origin_lat, lng: trip.base_lng ?? trip.origin_lng }, countryCode: trip.country_code ?? null, within: true, kind: 'lodging' });
    claimBase(trip.household_id, base, b.baseKind ?? 'hotel');
    await withTransaction(async (client) => {
      const updated = await trips.updateTrip(trip.id, { ...b, baseLabel: base?.label ?? null, baseLat: base?.lat ?? null, baseLng: base?.lng ?? null }, client);
      // Which place sources this trip's searches and plans may use; null means the default set.
      if ('sources' in b) {
        await trips.setTripSources(trip.id, Array.isArray(b.sources) ? b.sources.map(String).filter(Boolean) : null, client);
      }
      await ensureDays(client, updated);
    });
    res.json(await tripPayload(trip.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try { if (!await trips.deleteTrip(req.params.id)) return res.status(404).json({ error: 'trip_not_found' }); res.status(204).end(); } catch (err) { next(err); }
});

router.put('/:id/attendees', async (req, res, next) => {
  try {
    const { memberIds = [] } = req.body || {};
    await withTransaction(async (client) => {
      await trips.clearAttendees(req.params.id, client);
      for (const memberId of memberIds) await trips.addAttendee(req.params.id, memberId, client);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

router.patch('/:id/days/:dayId', async (req, res, next) => {
  try {
    const b = req.body || {};
    const { intensity, travelMode, startTime, endTime, notes } = b;
    if (intensity && !INTENSITY_TARGETS[intensity]) return res.status(400).json({ error: 'invalid_intensity' });
    if (travelMode && !TRAVEL_MODES.includes(travelMode)) return res.status(400).json({ error: 'invalid_mode' });
    if (!await trips.updateDay(req.params.id, req.params.dayId, { intensity, travelMode, startTime, endTime, notes })) {
      return res.status(404).json({ error: 'day_not_found' });
    }
    // Where the day starts and ends: a place, or null to go back to the rule (home to home).
    const point = (p) => (p && p.lat != null && p.lng != null ? JSON.stringify({ label: p.label ?? null, lat: Number(p.lat), lng: Number(p.lng), kind: p.kind ?? 'custom' }) : null);
    if ('startPoint' in b) await trips.setDayEndpoint(req.params.id, req.params.dayId, 'start', point(b.startPoint));
    if ('endPoint' in b) await trips.setDayEndpoint(req.params.id, req.params.dayId, 'end', point(b.endPoint));
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Shortlist
// ---------------------------------------------------------------------------

const kindOfCategory = (c) => (['restaurant', 'cafe', 'pub', 'bar'].includes(c) ? 'food' : ['attraction', 'event'].includes(c) ? 'activity' : 'other');

// What Find fetched is kept for hours (owner, 3 Sep 2026): going back to the
// Find tab must not hit the sources again, and a place already looked around
// from the Plan screen's Inspire me opens here at once (sources/cache.js).

/**
 * The work behind both search routes: the plain one, which answers once, and
 * the streaming one, which says what is happening while it happens. `onProgress`
 * is handed each source as it answers (sources/index.js) and is never allowed to
 * affect the result.
 */
async function runShortlistSearch(req, { onProgress = null } = {}) {
  const started = Date.now();
  const household = await currentHousehold();
  const trip = await loadTrip(req.params.id);
  let center = { lat: trip.base_lat ?? trip.origin_lat, lng: trip.base_lng ?? trip.origin_lng, label: trip.base_label ?? trip.origin_label };
  if (req.query.near) {
    const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(String(req.query.near));
    if (m) center = { lat: Number(m[1]), lng: Number(m[3]), label: 'chosen point' };
    else { const [hit] = await geocode(String(req.query.near), { limit: 1, near: center }); if (hit) center = hit; }
  }
  const radiusKm = Math.min(25, Number(req.query.radiusKm) || 3);
  const categories = req.query.categories ? String(req.query.categories).split(',').filter(Boolean) : [];
  // The search form's picker wins; otherwise the trip's saved sources; otherwise the default set.
  // Find asks the event listings too (owner, 4 Sep 2026): "What's on is different from Things to
  // do — Things to do are always there, What's on is for local events". A place search is not a
  // substitute for one, so the listings run here and What's on fills. The local scout is left out
  // of the default set — it can run past the proxy's ninety-second cut-off and costs money for
  // every place and day — but it runs when it is picked by name in Find's source filter.
  const asked = req.query.sources != null ? optInFrom(req.query.sources) : (Array.isArray(trip.sources) ? trip.sources : []);
  const sources = asked.length ? asked : enabledSources().filter((src) => src.key !== 'scout').map((src) => src.key);
  const q = String(req.query.q || '').trim();
  const have = new Set(await trips.shortlistRefs(trip.id));
  const withFlags = (list) => list.map((v) => ({ ...v, onShortlist: have.has(v.venueRef) }));
  // A clear answer before the proxy's own cut-off: better "took too long" than a blank failure.
  const deadline = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('The sources took too long to answer. Try again, or fetch from fewer sources.'), { status: 504, code: 'sources_timeout' })), 75_000));
  // What's on covers the whole time away: on a night away that is every day of
  // the trip, on a day out it is that day. The scout needs the place in words
  // and who is asking, or it stays quiet rather than searching anonymously.
  const { venues, degraded, sourcesQueried, units, cached, fetchedAt, fetched } = await Promise.race([searchCached(
    {
      center, radiusKm, categories, query: q, sources, locality: trip.locality ?? null,
      includeEvents: true, outingStart: trip.depart_at, outingEnd: trip.return_at,
      placeLabel: trip.base_label ?? trip.origin_label, timezone: trip.timezone ?? null,
      householdId: household.id,
    },
    { refresh: req.query.refresh === '1', onProgress },
  ), deadline]);
  if (fetched) await trips.recordProviderCall(household.id, sourcesQueried.join('+') || 'none', 'trip.shortlist.search', units);
  const byDistance = (a, b) => a.distanceKm - b.distanceKm;
  const inRadius = venues.map((v) => ({ ...v, venueRef: `${v.source}:${v.sourcePlaceId}`, distanceKm: Number(kmBetween(center, v).toFixed(2)) }))
    .filter((v) => v.distanceKm <= radiusKm).sort(byDistance);
  // Places and listings are capped separately. One cap over both, taken
  // nearest first, empties What's on in any city dense enough to fill it with
  // pubs before the first event: central London returns 400 places inside
  // three kilometres, and every one of them is nearer than a theatre.
  const results = [
    ...inRadius.filter((v) => v.category !== 'event').slice(0, 120),
    ...inRadius.filter((v) => v.category === 'event').slice(0, 80),
  ].sort(byDistance);
  return { near: center, radiusKm, results: withFlags(results), degradedSources: degraded, sourcesQueried, cached, fetchedAt, tookMs: Date.now() - started };
}

/**
 * GET /api/trips/:id/stays?radiusKm=2&near=plans|centre&mode=walking
 *
 * Somewhere to sleep, ranked by how much of the shortlist is on foot from the
 * front door (domain/stays.js). Open map only: beds, addresses and the star
 * rating an operator is allowed to advertise. No prices and no availability —
 * those need a booking provider with a key and a cap, which is the owner's.
 */
router.get('/:id/stays', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    // What they mean to do, from the shortlist: the places with a point on the map.
    const plans = await trips.shortlistAnchors(trip.id);
    const anchors = plans.map((p) => ({ label: p.venue_label, lat: Number(p.lat), lng: Number(p.lng), venueRef: p.venue_ref }));
    // The city itself: where the trip is, which for a trip away is its origin.
    const centre = { lat: trip.base_lat ?? trip.origin_lat, lng: trip.base_lng ?? trip.origin_lng };
    if (centre.lat == null) return res.status(400).json({ error: 'no_centre', message: 'This trip has no place on the map yet.' });
    // Always the same patch of map, so the answer is the one already held: the
    // shortlist moves the order, not the search. Where the middle of the plans
    // is only matters for saying how near a bed is to them.
    const heart = anchors.length ? middleOf(anchors) : centre;
    const radiusKm = Math.min(15, Math.max(0.5, Number(req.query.radiusKm) || 2));
    // No car means everything is a walk; a car makes a mile nothing at all.
    const mode = req.query.mode === 'driving' || (req.query.mode == null && trip.has_car) ? 'driving' : 'walking';

    let beds; let cached;
    try { ({ beds, cached } = await bedsNear(centre, radiusKm)); }
    catch (err) {
      // The open map's servers are shared and sometimes busy. Say so in words
      // somebody can act on rather than passing on a timeout code.
      return res.status(504).json({ error: 'map_busy', message: 'The open map took too long to answer. Try again in a moment — or say where you are staying and we will work around it.' });
    }
    const ranked = rankStays(beds, { anchors, centre: anchors.length ? heart : centre, mode })
      .filter((s) => s.distanceKm == null || s.distanceKm <= radiusKm + 1)
      .slice(0, 40);
    const status = await householdStatus(household.id, ranked.map((s) => s.venueRef));
    if (!cached) await trips.recordProviderCall(household.id, 'osm', 'trip.stays');
    res.json({
      near: { ...(anchors.length ? heart : centre), label: anchors.length ? 'the middle of your plans' : (trip.locality ?? trip.place_label ?? 'the centre') },
      radiusKm,
      mode,
      anchors: anchors.map((a) => ({ label: a.label, lat: a.lat, lng: a.lng })),
      results: ranked.map((s) => ({ ...s, household: status[s.venueRef] ?? null })),
      cached,
      attribution: OSM_ATTRIBUTION,
    });
  } catch (err) { next(err); }
});

/** GET /api/trips/:id/shortlist/search?q=&categories=food|things&radiusKm=&near=lat,lng&refresh=1 — near the base by default. */
router.get('/:id/shortlist/search', async (req, res, next) => {
  try { res.json(await runShortlistSearch(req)); } catch (err) { next(err); }
});

/**
 * GET /api/trips/:id/shortlist/search/stream — the same search, said out loud.
 *
 * The screen draws a map while this runs (SearchSketch), and the only way for
 * that map to be honest is for it to be told what has actually happened: which
 * sources were asked, which have answered and with how many, and where those
 * places are. Anything else is a progress bar making things up.
 *
 * Server-sent events, one line at a time, ending with the same payload the
 * plain route returns. Coordinates are sent, names are not: until the pool is
 * ranked there is nothing to show, and a provider's names are rented.
 */
router.get('/:id/shortlist/search/stream', async (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    // A stream is never a document to keep: no-store also keeps EventSource's
    // own reconnect from being answered out of the browser's cache.
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    // Railway's proxy buffers by default, which would hold every event back
    // until the search finished and defeat the whole point.
    'x-accel-buffering': 'no',
  });
  const send = (type, data) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  // Every five seconds, so a source that has gone quiet is visible as quiet
  // rather than as nothing happening.
  const beat = setInterval(() => send('waiting', { at: Date.now() }), 5_000);
  try {
    const payload = await runShortlistSearch(req, { onProgress: (e) => send(e.type, e) });
    send('done', payload);
  } catch (err) {
    // Not 'failed': that is one source giving up, and this is the whole search.
    send('fault', { error: String(err?.message || err), status: err?.status ?? 500 });
  } finally {
    clearInterval(beat);
    res.end();
  }
});

/**
 * Where you are staying is a place too (owner, 4 Sep 2026: "the hotels, the
 * activities, the restaurants").
 *
 * A base is picked through the geocoder rather than a place search, so it is
 * stored as a label and a point and its identifier was thrown away. Nominatim
 * is OpenStreetMap, so that identifier is an OSM one and the hotel can be
 * researched and owned exactly like anywhere else — its address, its phone
 * number and its check-in hours are then on the phone when the family arrives
 * in a city with no signal, which is the moment they need them.
 *
 * Only somewhere you sleep: home is not researched, and a city centre used as a
 * stand-in base is not a place at all.
 */
function claimBase(householdId, base, baseKind) {
  if (!base || baseKind === 'home' || base.source !== 'osm' || !base.sourcePlaceId) return;
  if (/ \(centre\)$/.test(String(base.label ?? ''))) return;
  claimPlace(householdId, `osm:${base.sourcePlaceId}`, 'stay', {
    name: base.name ?? base.label, category: 'hotel', lat: base.lat, lng: base.lng, website: base.website ?? null,
  });
}

/** One place onto a trip's shortlist (and into the atlas): the POST route and the Plan screen's Inspire me both come through here. */
export async function addShortlistItem(trip, household, b) {
  const kind = KINDS.includes(b.kind) ? b.kind : kindOfCategory(b.category);
  const snapshot = b.venue && ['osm', 'fixtures'].includes(String(b.venueRef).split(':')[0]) ? b.venue : null;
  await trips.upsertShortlistItem(trip.id, {
    venueRef: b.venueRef, venueLabel: b.venueLabel, kind, category: b.category ?? null,
    lat: b.lat ?? null, lng: b.lng ?? null, venue: snapshot, note: b.note?.trim() || null,
    mustDo: b.mustDo, preferredDayId: b.preferredDayId ?? null,
  });
  // The atlas is what the household chose, not what Roam proposed (owner,
  // 4 Sep 2026: "you have added stuff that I did not add… I want to see stuff
  // that I like, that I've curated, not random stuff"). A suggestion lives on
  // the trip's shortlist until someone keeps it; only then does it file here.
  if (!b.suggested) {
    await upsertHouseholdPlace(null, household.id, { venueRef: b.venueRef, label: b.venueLabel, kind, category: b.category, lat: b.lat, lng: b.lng, venue: b.venue, note: b.note, country: trip.country, countryCode: trip.country_code, locality: trip.locality });
  }
  // Shortlisting is the household saying this one matters, which is what starts
  // our own research (sources/own.js). It runs behind the response: the answer
  // is the trip, not the record.
  claimPlace(household.id, b.venueRef, 'shortlisted', { name: b.venueLabel, category: b.category ?? null, lat: b.lat ?? null, lng: b.lng ?? null, website: b.venue?.website ?? null });
}

router.post('/:id/shortlist', async (req, res, next) => {
  try {
    const trip = await loadTrip(req.params.id);
    const b = req.body || {};
    if (!b.venueRef || !b.venueLabel) return res.status(400).json({ error: 'venue_required' });
    await addShortlistItem(trip, await currentHousehold(), b);
    res.status(201).json(await tripPayload(trip.id));
  } catch (err) { next(err); }
});

router.patch('/:id/shortlist/:itemId', async (req, res, next) => {
  try {
    const { note, mustDo, preferredDayId, kind, status, bookedTime, partySize, bookingRef, statusNote, statusOn, dwellMinutes, legMode, dayId } = req.body || {};
    if (status != null && !SHORTLIST_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });
    if (legMode != null && legMode !== '' && !LEG_MODES.includes(legMode)) return res.status(400).json({ error: 'invalid_mode' });
    await trips.updateShortlistItem(req.params.id, req.params.itemId, {
      note, mustDo, preferredDayId, kind: KINDS.includes(kind) ? kind : null,
      status, bookedTime: bookedTime ? String(bookedTime).slice(0, 5) : null,
      partySize, bookingRef, statusNote, statusOn, dwellMinutes, legMode, dayId,
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

router.delete('/:id/shortlist/:itemId', async (req, res, next) => {
  try { await trips.deleteShortlistItem(req.params.id, req.params.itemId); res.json(await tripPayload(req.params.id)); } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Stops (on a day, in a slot)
// ---------------------------------------------------------------------------

/** POST /api/trips/:id/days/:dayId/stops { venueRef, name, lat, lng, dwellMinutes?, slot?, startTime?, shortlistId? } */
router.post('/:id/days/:dayId/stops', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const day = await trips.dayOfTrip(req.params.dayId, trip.id);
    if (!day) return res.status(404).json({ error: 'day_not_found' });
    const b = req.body || {};
    let stop = b;
    if (b.shortlistId) {
      const item = await trips.shortlistItem(b.shortlistId, trip.id);
      if (!item) return res.status(404).json({ error: 'shortlist_item_not_found' });
      stop = { venueRef: item.venue_ref, name: item.venue_label, lat: item.lat, lng: item.lng, category: item.category, ...b };
    }
    if (!stop.venueRef || !stop.name) return res.status(400).json({ error: 'venue_required' });
    const slot = SLOTS.includes(b.slot) ? b.slot : b.startTime ? (Number(b.startTime.slice(0, 2)) < 12 ? 'morning' : Number(b.startTime.slice(0, 2)) < 17 ? 'afternoon' : 'evening') : 'morning';
    const position = await trips.nextStopPosition(day.id);
    const dwell = b.dwellMinutes ?? (['restaurant', 'pub'].includes(stop.category) ? household.default_visit_minutes : ['cafe', 'bar'].includes(stop.category) ? 45 : 120);
    await trips.insertStop(trip.id, day.id, {
      slot, startTime: b.startTime ?? null, position,
      venueRef: stop.venueRef, name: stop.name, lat: stop.lat ?? null, lng: stop.lng ?? null, dwellMinutes: dwell,
    });
    res.status(201).json(await tripPayload(trip.id));
  } catch (err) { next(err); }
});

/** Move or retime a stop: { dayId?, slot?, startTime?, dwellMinutes?, position? } */
router.patch('/:id/stops/:stopId', async (req, res, next) => {
  try {
    const { dayId, slot, startTime, dwellMinutes, position } = req.body || {};
    if (slot && !SLOTS.includes(slot)) return res.status(400).json({ error: 'invalid_slot' });
    if (!await trips.updateStop(req.params.id, req.params.stopId, { dayId, slot, startTime, dwellMinutes, position })) {
      return res.status(404).json({ error: 'stop_not_found' });
    }
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

router.delete('/:id/stops/:stopId', async (req, res, next) => {
  try {
    if (!await trips.deleteStop(req.params.id, req.params.stopId)) return res.status(404).json({ error: 'stop_not_found' });
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

/** Reorder within a day: { stopIds } */
router.post('/:id/days/:dayId/reorder', async (req, res, next) => {
  try {
    const { stopIds = [] } = req.body || {};
    await withTransaction(async (client) => {
      for (let i = 0; i < stopIds.length; i += 1) await trips.setStopPosition(req.params.dayId, stopIds[i], i + 1, client);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

/** "We went" on a stop (Epic 7 C1). Body: { visitedOn?, note?, venue? } */
router.post('/:id/stops/:stopId/visit', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const stop = await trips.stopWithDate(req.params.stopId, trip.id);
    if (!stop) return res.status(404).json({ error: 'stop_not_found' });
    const existing = await trips.visitForStop(stop.id);
    if (existing) return res.json({ visit: await visitPayload(existing.id), deduplicated: true });
    const b = req.body || {};
    const attendees = await trips.attendeeIds(trip.id);
    const visitId = await withTransaction(async (client) => {
      const id = await trips.insertVisitForStop(household.id, trip, stop, {
        category: b.venue?.category ?? null,
        visitedOn: b.visitedOn || stop.day_date || trip.start_date,
        note: b.note?.trim() || null,
      }, client);
      for (const a of attendees) await trips.addVisitAttendee(id, a.member_id, client);
      await trips.recordLedger(household.id, stop.venue_ref, 'visited', client);
      await upsertHouseholdPlace(client, household.id, { venueRef: stop.venue_ref, label: stop.venue_name, category: b.venue?.category, lat: stop.lat, lng: stop.lng, venue: b.venue, country: trip.country, countryCode: trip.country_code, locality: trip.locality });
      return id;
    });
    res.status(201).json({ visit: await visitPayload(visitId), tripId: trip.id });
  } catch (err) { next(err); }
});

export default router;

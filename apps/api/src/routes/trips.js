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
import { optInFrom, enabledSources, pointsAlong, resolveVenues } from '../sources/index.js';
import { searchCached } from '../sources/cache.js';
import { bedsNear, OSM_ATTRIBUTION, LITEAPI_ATTRIBUTION } from '../sources/stays.js';
import { stationsNear } from '../sources/where.js';
import { rankStays, middleOf, partyForStay } from '../domain/stays.js';
import { occupanciesFor, liteapiEnabled, liteapiKeyKind } from '../sources/liteapi.js';
import { kmBetween, detourMinutes, estimateTravelMinutes, reachRadiusKm } from '../domain/travel.js';
import { currentHousehold } from './household.js';
import { visitPayload, householdStatus } from './places.js';
import { upsertHouseholdPlace, ownedImage } from './atlas.js';
import * as atlasRepo from '../repositories/atlas.js';
import * as ownedRepo from '../repositories/ownedPlaces.js';
import { heroesForPlaces } from '../repositories/library.js';
import { claimPlace } from '../sources/own.js';
import { matchOsm } from '../sources/openMatch.js';
import { mirrorHealth as overpassHealth } from '../sources/overpass.js';

const router = Router();
const SLOTS = ['morning', 'afternoon', 'evening'];
const EATING = ['restaurant', 'cafe', 'pub', 'bar'];
const SLEEPING = ['hotel', 'lodging'];
/** Which of an area's three lists a place belongs in: somewhere to stay, somewhere to eat, or something to do. */
export const GROUP_OF = (category, atlasKind) =>
  (SLEEPING.includes(category) || atlasKind === 'stay' ? 'stay'
    : EATING.includes(category) || (!category && atlasKind === 'food') ? 'eat'
      : 'do');
const KINDS = ['food', 'activity', 'other'];
export const SHORTLIST_STATUSES = ['to_call', 'booked', 'no_booking', 'full', 'set_aside'];
export const LEG_MODES = ['walking', 'transit', 'driving', 'taxi'];

/**
 * How many nights a trip is away for. A day out is 0 whatever it calls itself,
 * and that is the line the Trips list is divided on: Day trips | Holidays.
 */
export function nightsOf(t) {
  if (!t.start_date || !t.end_date) return 0;
  const a = new Date(`${String(t.start_date).slice(0, 10)}T12:00:00Z`);
  const b = new Date(`${String(t.end_date).slice(0, 10)}T12:00:00Z`);
  return Math.max(0, Math.round((+b - +a) / 86400000));
}

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

    // A picture of somewhere this trip actually went, from the pictures we own.
    // One statement for the whole list: the atlas already knows a representative
    // place per area, and a trip is a date range in one of those areas.
    const areaRefs = await atlasRepo.areaPictureRefs(household.id);
    const heroes = await heroesForPlaces(areaRefs.map((r) => r.venue_ref));
    const heroFor = (t) => {
      const here = areaRefs.filter((r) => r.country_code === t.country_code && r.locality === (t.locality ?? 'Elsewhere'));
      // A photograph before a mark: a trip card wants a picture of where they
      // went, and a restaurant's logo is not one.
      const found = here.map((r) => heroes.get(r.venue_ref)).filter(Boolean);
      const row = found.find((h) => h.source !== 'logo') ?? found[0]
        // Nothing saved in that town yet: anywhere in the same country beats a blank tile.
        ?? areaRefs.filter((r) => r.country_code === t.country_code).map((r) => heroes.get(r.venue_ref)).filter(Boolean).find((h) => h.source !== 'logo');
      return ownedImage(row ?? null);
    };

    res.json({
      trips: rows.map((t) => ({
        ...publicTrip(t), dayCount: t.day_count, stopCount: t.stop_count, shortlistCount: t.shortlist_count, visitCount: t.visit_count, ratingCount: t.rating_count,
        placeCount: t.place_count ?? 0, unratedCount: t.unrated_count ?? 0,
        attendees: t.attendees ?? [], isPast: new Date(t.end_date ?? t.return_at) < new Date(new Date().toDateString()),
        // A night away is what makes a holiday a holiday rather than a day out
        // (the rule the handover left open; stated here so it can be changed in
        // one place). `nights` is 0 for a day out, whatever its `kind` says.
        nights: nightsOf(t),
        // The one red thing on the list: a trip with dates and nowhere to sleep.
        needsStay: t.kind === 'trip' && nightsOf(t) > 0 && (!t.base_lat || t.base_kind === 'centre'),
        image: heroFor(t),
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
      /**
       * The place the day is *for* goes on the day.
       *
       * It used to go on the shortlist instead, as a must-do, and the trip's
       * own day stayed empty — so Wembley Stadium was both where the trip was
       * going and a suggestion for it (owner, 6 Sep 2026: "Wembley Stadium is
       * in my trip. That's where I'm going, but when I click on shortlist,
       * Wembley Stadium's there… It can't be in both"). Worse, the timeline
       * only drew the destination while the day was empty, so adding a
       * restaurant made the reason for the trip disappear from it.
       *
       * A destination that is a venue — something with an identifier, tapped on
       * a card — is a stop, and it is the anchor the rest of the day is planned
       * around. A destination that is only a place, a city typed into the form,
       * is not: nobody "visits" Bath at half past two, and a county on the
       * household's list of places would be nonsense. That one is still drawn
       * as the middle of the day and belongs to no source.
       */
      if (destination?.ref) {
        const day = await trips.firstDayOf(created.id, client);
        if (day) {
          await trips.insertStop(created.id, day.id, {
            slot: 'afternoon', startTime: null, position: 1,
            venueRef: destination.ref, name: destination.label,
            lat: destination.lat, lng: destination.lng,
            // The reason for the day gets the day: what is left of the window
            // once the driving is paid for, so a stop added on the way is seen
            // to come out of it rather than to be free.
            dwellMinutes: Math.max(
              60,
              Math.round((new Date(b.returnAt) - new Date(b.departAt)) / 60_000)
                - 2 * estimateTravelMinutes(origin, destination, travelMode),
            ),
          }, client);
        }
      }
      return created;
    });
    res.status(201).json(await tripPayload(trip.id));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => { try { res.json(await tripPayload(req.params.id)); } catch (err) { next(err); } });
/**
 * GET /api/trips/:id/places — every place this trip touched.
 *
 * Grouped the way the handover asks (5 Sep 2026): Hotels, Activities, Food &
 * drink, each row carrying the day it happened and what the household thought
 * of it — or the red Rate nudge where nobody has said yet.
 *
 * One read, no provider call: a place is here because the household put it on
 * this trip, and its name is the household's own.
 */
router.get('/:id/places', async (req, res, next) => {
  try {
    const trip = await loadTrip(req.params.id);
    const rows = await trips.placesOfTrip(trip.id);
    const heroes = await heroesForPlaces(rows.map((r) => r.venue_ref));
    const fmtDay = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }) : null);

    const places = rows.map((r) => {
      const category = r.category ?? r.atlas_category ?? null;
      const scores = (r.scores ?? []).filter((x) => x.score != null);
      return {
        venueRef: r.venue_ref,
        name: r.label === r.venue_ref ? null : r.label,
        category,
        group: GROUP_OF(category, r.atlas_kind),
        lat: r.lat, lng: r.lng,
        firstOn: r.first_on, lastOn: r.last_on,
        day: fmtDay(r.first_on),
        dwellMinutes: r.dwell_minutes ?? null,
        visited: r.visited, scheduled: r.scheduled, shortlisted: r.shortlisted,
        bookingStatus: r.booking_status ?? null,
        /** The number to ring ahead on, where the owned record has one (§7). */
        phone: r.phone ?? null,
        scores,
        // The household's own mark out of five: the average of what everybody
        // who scored it said. Null is not "nought" — it is nobody has said, and
        // that is what the red Rate nudge is for.
        score: scores.length ? Math.round((scores.reduce((n, x) => n + Number(x.score), 0) / scores.length) * 10) / 10 : null,
        image: ownedImage(heroes.get(r.venue_ref) ?? null),
      };
    });

    // Somewhere they slept is a place this trip touched even when nobody put it
    // on a day. A day out's "base" is the town it went to, not a hotel, so it
    // is only a row where there was a night in it.
    if (nightsOf(trip) > 0 && trip.base_lat != null && trip.base_kind !== 'centre' && trip.base_kind !== 'home' && !places.some((p) => p.name === trip.base_label)) {
      places.unshift({
        venueRef: `base:${trip.id}`, name: trip.base_label, category: 'hotel', group: 'stay',
        lat: trip.base_lat, lng: trip.base_lng, firstOn: trip.base_check_in ?? trip.start_date, lastOn: trip.base_check_out ?? trip.end_date,
        day: fmtDay(trip.base_check_in ?? trip.start_date), dwellMinutes: null,
        visited: false, scheduled: false, shortlisted: false, bookingStatus: 'booked', scores: [], score: null, image: null,
      });
    }

    res.json({
      places,
      counts: {
        all: places.length,
        do: places.filter((p) => p.group === 'do').length,
        eat: places.filter((p) => p.group === 'eat').length,
        stay: places.filter((p) => p.group === 'stay').length,
      },
    });
  } catch (err) { next(err); }
});

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
  const live = [
    ...inRadius.filter((v) => v.category !== 'event').slice(0, 120),
    ...inRadius.filter((v) => v.category === 'event').slice(0, 80),
  ].sort(byDistance);
  // Find is never blank (owner, 5 Sep 2026: "surely you could just leave the
  // placeholders that I saw there so that they're always available, because the
  // moment it is completely empty"). Whatever the rented sources managed, the
  // places this household already owns near this point are added underneath —
  // they cost nothing, they cannot go stale and they cannot go down. On a good
  // afternoon they are a handful of familiar names at the bottom of a long
  // list; on the afternoon Overpass times out and Google's daily quota is spent
  // they are the whole of Things to do and Places to eat.
  const known = new Set(live.map((v) => v.venueRef));
  const stored = (await ownedRepo.ownedNear(household.id, center.lat, center.lng, radiusKm).catch(() => []))
    .filter((r) => !known.has(r.venue_ref))
    .map((r) => ({
      venueRef: r.venue_ref, source: 'own', sourcePlaceId: String(r.venue_ref).split(':').slice(1).join(':'),
      name: r.name, category: r.category ?? 'attraction', lat: Number(r.lat), lng: Number(r.lng),
      cuisines: r.cuisines ?? [], experiences: r.experiences ?? [], dietaryOptions: r.dietary_options ?? [],
      address: r.address ?? null, website: r.website ?? null, openingHours: r.opening_hours ?? null,
      summary: r.summary ?? null, goodForChildren: r.good_for_children ?? null, photos: r.image_url ? [{ url: r.image_url }] : [],
      rating: null, ratingCount: null, priceLevel: null,
      attribution: r.attribution ?? [], distanceKm: Number(Number(r.km).toFixed(2)),
      household: { visits: r.visits ?? 0 },
      // The card says where this came from: it is the family's own record, not
      // a provider's answer, and it is here because the provider had none.
      stored: true,
    }));
  const results = [...live, ...stored];
  return { near: center, radiusKm, results: withFlags(results), storedCount: stored.length, degradedSources: degraded, sourcesQueried, cached, fetchedAt, tookMs: Date.now() - started };
}

/**
 * GET /api/trips/:id/along?kind=food|things&maxDetourMin=15&around=lat,lng&q=
 *
 * Everywhere you could stop **along the way** — the map-first trip screen's
 * Browse mode (design handoff, 6 Sep 2026, screens 03–05).
 *
 * The whole design turns on one measurement: not "how far is this from home",
 * which nobody cares about once they are in the car, but "how much longer does
 * the day get if we stop here". That is `detourMinutes` — the drive via this
 * place, less the drive straight there — and it is what every row leads with.
 *
 * **It is estimated, on purpose** (owner, 6 Sep 2026: "As long as the detour
 * route minutes are roughly correct, I think that's okay… once the user adds it
 * to their actual trip, not in a shortlist, then we can recalculate the actual
 * correct number"). A browse is six to thirty candidates and the filters change
 * with every tap; routing all of them each time would spend a day's Google
 * quota in minutes and buy nothing, because nobody has chosen anything yet. So
 * this endpoint asks Google for nothing at all, and `estimated: true` travels
 * on the answer so the screen can say so. The real number is fetched for the
 * one place somebody adds, when they add it (`POST /:id/day/stops`).
 *
 * The corridor is a bias, not a fence: everything found is returned with its
 * detour on it, and `maxDetourMin` only decides what the list leads with.
 */
router.get('/:id/along', async (req, res, next) => {
  const started = Date.now();
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const mode = trip.travel_mode || 'driving';
    const origin = { lat: trip.base_lat ?? trip.origin_lat, lng: trip.base_lng ?? trip.origin_lng, label: trip.base_label ?? trip.origin_label };
    // Where the day is *for*: the destination on a day out, the town on a trip.
    const destination = trip.destination_lat != null
      ? { lat: trip.destination_lat, lng: trip.destination_lng, label: trip.destination_label }
      : null;
    if (origin.lat == null) return res.status(400).json({ error: 'no_origin', message: 'This trip has no starting point yet.' });

    const kind = req.query.kind === 'food' ? 'food' : 'things';
    const maxDetourMin = Math.min(60, Math.max(5, Number(req.query.maxDetourMin) || 15));
    const q = String(req.query.q || '').trim();
    /**
     * Somewhere on the map you have tapped, and want to look around.
     *
     * This replaces the handoff's "By the park" scope chip, at the owner's
     * suggestion (6 Sep 2026): "When I select the destination, if I search for
     * activities after clicking on the destination, then it will search for
     * activities and food and drink around that area. If not, then it will just
     * search all the way along the route."
     *
     * He is right that it is more intuitive. A chip called "near the end" asks
     * somebody to hold a mental model of the route; tapping the place you mean
     * asks nothing at all, and it generalises — any stop on the day can be the
     * thing you look around, not only the far end.
     */
    const around = (() => {
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(req.query.around || ''));
      return m ? { lat: Number(m[1]), lng: Number(m[2]), label: String(req.query.aroundName || '').trim() || null } : null;
    })();

    const reach = reachRadiusKm(mode, maxDetourMin);
    const journeyKm = destination ? kmBetween(origin, destination) : 0;

    /**
     * How wide the corridor is.
     *
     * The detour budget buys a certain amount of extra driving, and a place
     * beside the route costs roughly twice its distance from the line — out and
     * back again. So half of what the budget reaches is the width.
     *
     * That alone is too tight on a long run (owner, 6 Sep 2026: twenty miles to
     * Crystal Palace, one restaurant and nothing to do). A straight line is a
     * crude stand-in for a road, and the longer the drive the further the road
     * wanders from it: over 38km the A308 and the A3 are four or five
     * kilometres off the chord for most of their length, and a band under two
     * kilometres wide was describing a road nobody drives. So the width also
     * grows with the journey — about a tenth of it — which leaves the short
     * runs exactly as they were. That matters, because the short run is where
     * the constraint was needed: Chobham Common is 2.4km off a 7.9km drive to
     * Thorpe Park, and it is still 2.4km off a band 1.9km wide.
     */
    const corridorKm = destination
      ? Math.min(8, Math.max(1, reach / 2, journeyKm * 0.12))
      : Math.max(1, reach / 2);

    /**
     * Where to look.
     *
     * This was one search, centred on the midpoint, with a radius wide enough
     * to reach both ends — and that is not a search along a route, it is a
     * search of a county. Every source answers a circle with the best of what
     * is in it, and Google's nearby search stops at twenty whatever the radius:
     * on the run to Crystal Palace those twenty were the Science Museum, the
     * Natural History Museum and Holland Park, none of them on the road and
     * none of them within ten kilometres of where the day was going. The
     * corridor then threw all twenty away, correctly, and the screen said
     * nothing was on the way.
     *
     * So the road is sampled instead: a few circles strung along it, each one
     * small enough that twenty answers is a fair picture of what is actually
     * there, and overlapping its neighbours so nothing falls between them. The
     * far end is always one of them, because a meal near where you are going is
     * the most on-the-way thing there is.
     *
     * The circles are sized from the corridor, not guessed: a radius half again
     * the width, spaced so that consecutive circles still overlap by the width
     * at their join. Four to six searches for a long drive, two for a short
     * one, each cached for twelve hours and shared with every other screen
     * asking the same thing — a browse still composes from one pool.
     */
    const spots = (() => {
      if (around) return [{ center: { ...around }, radiusKm: Math.min(40, Math.max(2, reach)) }];
      if (!destination) return [{ center: { ...origin }, radiusKm: Math.min(40, Math.max(2, reach)) }];
      const sampleRadius = Math.min(20, Math.max(reach, corridorKm * 1.5));
      const samples = Math.max(2, Math.min(5, Math.ceil(journeyKm / (sampleRadius * 1.4))));
      return [...pointsAlong(origin, destination, samples), { lat: destination.lat, lng: destination.lng }]
        .map((c) => ({ center: { lat: c.lat, lng: c.lng }, radiusKm: sampleRadius }));
    })();

    const sources = Array.isArray(trip.sources) && trip.sources.length
      ? trip.sources
      : enabledSources().filter((src) => src.key !== 'scout').map((src) => src.key);
    const deadline = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('The sources took too long to answer.'), { status: 504, code: 'sources_timeout' })), 60_000));
    const answers = await Promise.race([Promise.all(spots.map((spot) => searchCached(
      {
        center: spot.center, radiusKm: spot.radiusKm, categories: [kind], query: q, sources,
        locality: trip.locality ?? null, householdId: household.id,
        placeLabel: trip.base_label ?? trip.origin_label, timezone: trip.timezone ?? null,
      },
      { refresh: req.query.refresh === '1' },
    ))), deadline]);

    // One pool out of the several circles. The overlaps are the point, so the
    // same place found twice has to become one place — and twice from two
    // different sources, which is the same fold `searchAllSources` already does
    // inside one circle, run again across them.
    const pooled = [];
    const degraded = [];
    const queried = new Set();
    const units = {};
    let cached = true;
    let fetched = false;
    let fetchedAt = null;
    for (const a of answers) {
      pooled.push(...a.venues);
      for (const dg of a.degraded ?? []) if (!degraded.some((x) => x.source === dg.source)) degraded.push(dg);
      for (const k of a.sourcesQueried ?? []) queried.add(k);
      for (const [k, v] of Object.entries(a.units || {})) units[k] = (units[k] || 0) + v;
      if (!a.cached) cached = false;
      if (a.fetched) fetched = true;
      if (a.fetchedAt && (!fetchedAt || a.fetchedAt > fetchedAt)) fetchedAt = a.fetchedAt;
    }
    const venues = spots.length > 1 ? resolveVenues(pooled) : pooled;
    const sourcesQueried = [...queried];
    if (fetched) await trips.recordProviderCall(household.id, sourcesQueried.join('+') || 'none', 'trip.along', units);

    const have = new Set(await trips.shortlistRefs(trip.id));
    const onDay = new Set((await trips.stopsOf(trip.id)).map((s) => s.venue_ref));

    /**
     * How far along the route a place sits: 0 at the origin, 1 at the
     * destination. Flat earth, which is exact enough over a drive.
     *
     * The detour on its own is not enough of a test, and the owner found where
     * it breaks (6 Sep 2026): "it's also coming up with activities that are in
     * the opposite direction from my home, like Chobham Common". Chobham really
     * is only about ten minutes extra by the arithmetic — go back past the
     * house, out the other side, and round — but nobody would call it on the
     * way to Thorpe Park, and a corridor that says so is not describing a
     * corridor. So a place must also be *between*, give or take.
     */
    const track = (v) => {
      if (!destination) return { t: 0.5, offKm: 0 };
      const kx = Math.cos((origin.lat * Math.PI) / 180);
      const ax = (destination.lng - origin.lng) * kx;
      const ay = destination.lat - origin.lat;
      const bx = (v.lng - origin.lng) * kx;
      const by = v.lat - origin.lat;
      const len2 = ax * ax + ay * ay;
      if (len2 === 0) return { t: 0.5, offKm: 0 };
      const t = (ax * bx + ay * by) / len2;
      // Where it would sit if it were on the line, and how far it is from
      // there. Measured with the same haversine as everything else rather than
      // by turning degrees into kilometres by hand.
      const clamped = Math.max(0, Math.min(1, t));
      const foot = {
        lat: origin.lat + (destination.lat - origin.lat) * clamped,
        lng: origin.lng + (destination.lng - origin.lng) * clamped,
      };
      return { t, offKm: kmBetween(foot, v) };
    };

    // The corridor's width is settled above, before the road is sampled: the
    // circles searched are sized from it, so what is looked for and what is
    // kept describe the same band. The numbers it has to respect are from the
    // run to Thorpe Park — Wentworth, Thorpe Lakes and Penton Hook are 0.8km,
    // 0.2km and 0.4km off the line and belong; Chobham Common at 2.4km and
    // Windsor Great Park at 4.0km, on a journey 7.9km end to end, do not.

    /**
     * The destination is not a thing to stop at on the way to the destination,
     * and neither is anything standing inside it.
     *
     * Owner, 6 Sep 2026: "When I look for activities, it's bringing up Thorpe
     * Park and then rides within Thorpe Park, which is also really weird… When
     * I select Thorpe Park and add it as an activity, and I search for
     * activities again, it comes up with Thorpe Park again." A theme park is
     * one node on the map and forty more inside its fence, and every one of
     * them answers a search for things to do near the middle of it.
     *
     * Six hundred metres for something to do, because that is the size of the
     * grounds; a hundred and fifty for somewhere to eat, because a café at the
     * gates is a genuine answer and a ride is not.
     */
    const insideDestination = (v) => {
      if (!destination) return false;
      const m = kmBetween(destination, v) * 1000;
      return m <= (kind === 'food' ? 150 : 600);
    };

    const rows = venues.map((v) => {
      const venueRef = `${v.source}:${v.sourcePlaceId}`;
      // Straight-line arithmetic, ours, free and instant. Never a routing call.
      // Anchored, the number is simply how far it is from the place you tapped.
      // Unanchored, it is what the stop adds to the day.
      const detour = around
        ? estimateTravelMinutes(around, v, mode)
        : destination
          ? detourMinutes({ origin, destination, venue: v, mode })
          : estimateTravelMinutes(origin, v, mode);
      const from = around ?? origin;
      return {
        venueRef, source: v.source, name: v.name, category: v.category ?? 'attraction',
        /** Kept off the answer; only here so the filter below can read it. */
        ...(() => { const k = track(v); return { _t: k.t, _off: k.offKm }; })(),
        _inside: insideDestination(v),
        lat: v.lat, lng: v.lng,
        cuisines: v.cuisines ?? [], experiences: v.experiences ?? [],
        rating: v.rating ?? null, ratingCount: v.ratingCount ?? null, priceLevel: v.priceLevel ?? null,
        openingHours: v.openingHours ?? null, phone: v.phone ?? null, website: v.website ?? null,
        address: typeof v.address === 'string' ? v.address : v.address?.line1 ?? null,
        photos: (v.photos ?? []).slice(0, 1),
        attribution: v.attribution ?? null,
        detourMinutes: detour,
        /** Miles, in brackets, is what the row shows beside the minutes. */
        detourMiles: Number((kmBetween(from, v) * 0.621371).toFixed(1)),
        /** Worked out from the distance, not asked of Google. The row says so. */
        estimated: true,
        onShortlist: have.has(venueRef),
        onDay: onDay.has(venueRef),
      };
    });

    /**
     * The corridor is a fence here, not a bias.
     *
     * It began as a bias — everything found, ordered by detour — on the reading
     * of Requirements §4 that a corridor should never silently throw a place
     * away. On a map that is simply wrong, and the owner said so on seeing it
     * (6 Sep 2026): "it should be within a 10-15-minute drive of the final
     * destination or from the route itself. I shouldn't have any going in the
     * opposite direction from my home, for example. That doesn't make any
     * sense." He is right: a list is a list, but a pin an hour the wrong way is
     * a claim about where you could stop, and it is a false one. Nothing is
     * hidden — the detour budget is a chip on screen, and widening it is one
     * tap.
     */
    /**
     * Inside the corridor, the order is the detour *banded* and then how well
     * regarded the place is.
     *
     * Sorting on the raw detour looks right and is useless in a town: every
     * restaurant in Bath is five minutes off a route that starts and ends in
     * Bath, so the sort was a coin toss and the two hundred unrated
     * OpenStreetMap rows came first by accident of arrival — which is what the
     * owner saw (6 Sep 2026: "There are no reviews and no stars in any of the
     * listings. That's not okay"). Google's seventeen rated ones were below the
     * fold the whole time.
     *
     * Three-minute bands, because nobody chooses between eight minutes and
     * nine, and everybody chooses between a 4.6 with three thousand reviews and
     * a name on a map. Inside a band the better-known place wins; between bands
     * the nearer one still does.
     */
    const standing = (r) => (r.rating ?? 0) * Math.log10((r.ratingCount ?? 0) + 10);
    const judged = (r) => (r.rating != null && (r.ratingCount ?? 0) >= 5 ? 1 : 0);
    const within = rows
      .filter((r) => r.detourMinutes != null && r.detourMinutes <= maxDetourMin)
      // Not the destination, and not standing inside it.
      .filter((r) => !r._inside)
      /**
       * And beside the line, between its two ends: a little way back past home,
       * a little way beyond the destination, and within the corridor's width of
       * the road between them. Without a destination there is no line to be
       * beside and the detour is simply how far away it is, so neither applies.
       */
      // Anchored: simply near the thing you tapped. Unanchored: beside the line.
      .filter((r) => (around
        ? kmBetween(around, r) <= reach
        : !destination || (r._t >= -0.05 && r._t <= 1.3 && r._off <= corridorKm)))
      /**
       * Food & drink means somewhere you eat or drink. It was letting through
       * anything the sources filed under food, which on the road to Thorpe Park
       * was a Sainsbury's — fixed at source in google.js too, and fenced here
       * as well because a source we have not met yet will make the same mistake.
       */
      .filter((r) => kind !== 'food' || EATING.includes(r.category))
      /**
       * Somewhere you can judge, first.
       *
       * The detour and the corridor have already done the work of "is this on
       * the way" — everything left is inside both. Within that, the question is
       * which of them is any good, and a place with five hundred reviews
       * answers it while a name on the open map does not.
       *
       * This was banded detour first, in three-minute steps, and the bands were
       * too fine for the distances involved: on a short run everything is five
       * to eight minutes off, so a four-minute unrated node beat a five-minute
       * place with four thousand reviews on a rounding. OpenStreetMap answers
       * with two hundred names when it answers at all, and they buried Google's
       * seventeen. Unrated places still come, underneath — they are the whole
       * list on the afternoon Google's quota is gone.
       */
      .sort((a, b) => judged(b) - judged(a)
        || (judged(a) ? standing(b) - standing(a) : 0)
        || (a.detourMinutes ?? 999) - (b.detourMinutes ?? 999));

    res.json({
      origin, destination, mode, kind, maxDetourMin,
      /** What was tapped, echoed back so the screen can name it on a chip. */
      around: around ? { lat: around.lat, lng: around.lng, label: around.label } : null,
      /**
       * Whether there is a route at all. A trip away has a base and no
       * destination, so "off route" is meaningless there and the row says "from
       * Bath" instead — the same number, named for what it actually is.
       */
      hasRoute: !!destination,
      places: within.slice(0, 60).map(({ _t, _off, _inside, ...p }) => p),
      counts: { route: within.length },
      /** How many were found and left out, so the screen can offer a wider detour honestly. */
      beyond: rows.length - within.length,
      /** How far off the road a place may be and still count as on the way. */
      corridorKm: destination ? Number(corridorKm.toFixed(1)) : null,
      estimated: true,
      degradedSources: degraded, sourcesQueried, cached, fetchedAt, tookMs: Date.now() - started,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/trips/:id/stays?radiusKm=2&mode=walking&rooms=1&adults=2&children=8,11
 *
 * Somewhere to sleep, ranked by how much of the shortlist is on foot from the
 * front door (domain/stays.js), and priced for the nights this trip is away.
 *
 * The ranking is the half only Roam can do: it is the only thing that holds the
 * shortlist, so it is the only thing that can say "eight minutes from four of
 * your five plans". The price is the half everybody else can do and Roam could
 * not, until LiteAPI (sources/liteapi.js). Both are needed — a hotel on the
 * doorstep at £600 a night is not an answer either.
 *
 * `rooms`, `adults` and `children` override what the trip's attendees imply.
 * The answer always says what it asked for, including any age it had to assume,
 * so the screen can show it rather than the household discovering it at a desk.
 *
 * Nothing licensed is written down here. LiteAPI's names, scores, photographs
 * and prices are fetched for this one screen; the row's own reference stays the
 * open map's wherever the two agree, and offline/policy.ts does not save this
 * path to a device.
 */
/**
 * "Type of place" (Hotels 2 §18) against what the sources actually call things.
 *
 * The wizard asks in household words — a house or a flat, a farm stay, a villa
 * with a pool — and the open map answers in `tourism=` values. One word does
 * not map to one value: a flat is `apartment` or `chalet`, and a villa is a
 * name and a pool rather than a tag at all. So the match is a small table
 * rather than a string comparison, which is what it used to be — and which
 * quietly returned nothing for every option but Hotel.
 */
const STAY_KINDS = {
  'hotel': ['hotel', 'motel', 'resort', 'inn'],
  'house or flat': ['apartment', 'chalet', 'hut', 'house', 'flat', 'cottage', 'villa'],
  'b&b': ['guest house', 'guesthouse', 'bed and breakfast', 'b&b', 'bnb'],
  'farm stay': ['farm', 'farm stay', 'agriturismo', 'masseria'],
  'villa with pool': ['villa', 'masseria', 'chalet'],
};
export function stayKindMatches(stayKind, want) {
  const kind = String(stayKind || 'hotel').toLowerCase();
  return want.some((w) => (STAY_KINDS[w.toLowerCase()] ?? [w.toLowerCase()]).some((v) => kind.includes(v)));
}

router.get('/:id/stays', async (req, res, next) => {
  const started = Date.now();
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

    // The nights. A day out has none, and a trip with no dates yet has none
    // either — in both cases there are still beds to show, just no prices.
    const checkin = trip.start_date ? String(trip.start_date).slice(0, 10) : null;
    const checkout = trip.end_date ? String(trip.end_date).slice(0, 10) : null;
    const nights = nightsOf(trip);

    // Who the room is for: the people on this trip, unless the screen says
    // otherwise. A child's age changes the price, so it is asked for by age.
    const derived = partyForStay(await trips.partyOf(trip.id), { on: checkin });
    const asked = {
      adults: Math.max(1, Math.min(20, Number(req.query.adults) || derived.adults)),
      childAges: req.query.children != null
        ? String(req.query.children).split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n >= 0 && n < 18)
        : derived.childAges,
      rooms: Math.max(1, Math.min(9, Number(req.query.rooms) || 1)),
    };
    const occupancies = occupanciesFor({ adults: asked.adults, childAges: asked.childAges, rooms: asked.rooms });

    /**
     * Where you want to be (design handoff, 6 Sep 2026, screen 16). Three
     * answers, and they are genuinely different questions rather than three
     * sorts of the same one:
     *
     *   plans    — best placed for the days already planned. The default, and
     *              the only one only Roam can answer, because it is the only
     *              thing that holds the shortlist.
     *   town     — near a centre, when the plans are thin or scattered.
     *   station  — happy to be further out if the train is a short walk, which
     *              is usually much cheaper. Ranked on the walk to the platform
     *              first and the journey from it second.
     */
    let placement = ['plans', 'town', 'station'].includes(req.query.placement) ? req.query.placement : 'plans';
    /**
     * The town "Near {town}" means, when it is not the trip's own area. The
     * tile is swappable (§16: "Your trip's area · change the town") and the
     * answer is a point, so it can come back as one rather than as a name the
     * server would have to geocode again.
     */
    const townPoint = (() => {
      const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(String(req.query.townAt || ''));
      return m ? { lat: Number(m[1]), lng: Number(m[3]) } : null;
    })();
    const town = townPoint ?? centre;

    /**
     * Where to look, which is not always where the trip is. Swapping the town
     * on §16's middle tile has to move the search as well as the ranking —
     * otherwise picking Bath from a Windsor trip filters a list of Windsor beds
     * by their distance from Bath and finds nothing, which reads as broken.
     */
    const lookAt = placement === 'town' && townPoint ? townPoint : centre;
    let look;
    try {
      look = await bedsNear(lookAt, radiusKm, {
        stay: nights > 0 && checkin && checkout ? { checkin, checkout, occupancies } : null,
      });
    } catch (err) {
      // The open map's servers are shared and sometimes busy. Say so in words
      // somebody can act on rather than passing on a timeout code.
      return res.status(504).json({ error: 'map_busy', message: 'The open map took too long to answer. Try again in a moment — or say where you are staying and we will work around it.' });
    }
    const maxAvgMin = Math.min(120, Math.max(5, Number(req.query.maxAvgMin) || 20));
    const maxWalkMin = Math.min(40, Math.max(3, Number(req.query.maxWalkMin) || 10));
    const maxTrainMin = Math.min(120, Math.max(5, Number(req.query.maxTrainMin) || 25));
    const townMin = Math.min(90, Math.max(3, Number(req.query.townMin) || 15));
    const budgetMin = Number(req.query.budgetMin) || 0;
    // The top of the slider is "and above", so a ceiling at the maximum is no ceiling.
    const budgetMax = Number(req.query.budgetMax) >= 400 ? Infinity : Number(req.query.budgetMax) || Infinity;
    const wantTypes = String(req.query.types || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    /**
     * Must-haves and nice-to-haves (Hotels 2 §18), and they are deliberately
     * two different mechanisms because the screen says they are: "Must have"
     * filters, "Nice to have · reorders, doesn't filter".
     *
     * What a bed has comes from the open map's tags (sources/osm.js
     * `stayAmenities`), which are sparse: a mapper says there is a pool, never
     * that there is not one.
     *
     * So a must-have filters **only where somebody has answered it**. If no bed
     * around here has been tagged with parking at all, the word carries no
     * information and the filter does not apply — the alternative is a control
     * that empties the list everywhere OSM is thin, which is most places, and
     * an empty list is not a truer answer than a full one. Where some beds do
     * say it, they are the answer and the untagged ones are left out.
     *
     * The wizard's live count is what makes either behaviour honest: tick Pool
     * and the button says how many are left before anybody taps it.
     */
    const wantMust = String(req.query.must || '').split(',').map((t) => t.trim()).filter(Boolean);
    const wantNice = String(req.query.nice || '').split(',').map((t) => t.trim()).filter(Boolean);
    const has = (st, want) => (st.amenities ?? []).some((a) => a.toLowerCase() === want.toLowerCase());

    /**
     * Are the plans spread out? Screen 19: when the days are an hour apart from
     * each other, no single one of them is worth being near, and a bed by a
     * station beats all of them. Measured between the two furthest apart.
     */
    let spread = null;
    if (anchors.length >= 2) {
      let worst = { minutes: 0, a: null, b: null };
      for (let i = 0; i < anchors.length; i += 1) {
        for (let j = i + 1; j < anchors.length; j += 1) {
          const minutes = estimateTravelMinutes(anchors[i], anchors[j], 'driving');
          if (minutes > worst.minutes) worst = { minutes, a: anchors[i], b: anchors[j] };
        }
      }
      if (worst.minutes >= 45) {
        spread = {
          minutes: worst.minutes,
          between: [worst.a.label, worst.b.label],
          places: anchors.map((a) => a.label),
        };
      }
    }

    /**
     * Plans an hour apart have no middle worth being near (§20), so unless
     * somebody has said otherwise the ranking moves to the stations by itself
     * rather than offering a link and hoping. An explicit `placement` in the
     * query always wins — this only fires on the default.
     */
    if (spread && req.query.placement == null) placement = 'station';

    /**
     * The three placements above answer "what should this be ranked by". They
     * are not three boxes a household has to choose between (owner, 6 Sep 2026:
     * "I want to have a place that's less than 20 minutes' travel to the centre
     * of whatever town, and I want it to be less than a 10-minute walk to the
     * train station"). That is one bed satisfying two conditions, and until now
     * each condition only applied when its own tile happened to be selected.
     *
     * So a condition applies when it was **asked for** — named in the query —
     * and, as before, when the placement implies it. Ranking stays the
     * placement's job; the conditions are independent of it and of each other,
     * and any number of them can hold at once.
     */
    // `asked` is already the party on this handler; this one is about the query.
    const wasAsked = (name) => req.query[name] != null && req.query[name] !== '';
    let wantsStationWalk = placement === 'station' || wasAsked('maxWalkMin');
    let wantsTrain = placement === 'station' || wasAsked('maxTrainMin');
    const wantsTownMinutes = placement === 'town' || wasAsked('townMin');
    const wantsPlanMinutes = anchors.length > 0 && (placement === 'plans' || wasAsked('maxAvgMin'));

    // Stations, only when something actually asks about them: it is an Overpass
    // call and nothing else on this screen wants it.
    let stations = [];
    // Whether we could ask at all, which is not the same as whether there are
    // any. `stationsNear` used to swallow every error and return an empty list,
    // and the empty list then failed every bed's walk test — so an Overpass
    // outage read on screen as "nowhere near here is by a station" and the
    // whole list vanished. It throws now, and this is where that is decided.
    let stationsUnavailable = null;
    let stationSource = null;
    if (wantsStationWalk || wantsTrain) {
      // Reads the held table (repositories/transit.js); only an area nobody has
      // harvested touches the network at all, and even then a failure hands
      // back whatever we hold rather than throwing.
      // Which kinds count as "a station" here. All four by default — a tram
      // stop in Manchester is as much a way to get about as a platform is
      // (owner, 6 Sep 2026: "add trams as well") — and narrowable for somebody
      // who means a train and only a train.
      const stationKinds = String(req.query.stationKinds || '').split(',').map((k) => k.trim()).filter((k) => ['rail', 'subway', 'tram', 'light_rail'].includes(k));
      const got = await stationsNear(centre.lat, centre.lng, Math.round(Math.min(15, radiusKm + 6) * 1000), { kinds: stationKinds.length ? stationKinds : null })
        .catch((err) => ({ stops: [], source: 'error', error: String(err?.message || err) }));
      stations = got.stops;
      stationSource = got.source;
      // Only genuinely unknown when we hold nothing *and* could not ask. An
      // area we have harvested and found nothing in is a real answer.
      if (!stations.length && got.source !== 'held') stationsUnavailable = got.error ?? 'the map could not be reached';
    }
    // A condition we could not evaluate is not a condition every bed fails.
    // Dropped, and said out loud — the same rule the must-haves already follow
    // when nobody around here has mapped the word.
    if (stationsUnavailable) { wantsStationWalk = false; wantsTrain = false; }
    const nearestStation = (bed) => {
      if (!stations.length) return null;
      let best = null;
      for (const st of stations) {
        const km = kmBetween(bed, st);
        if (!best || km < best.km) best = { ...st, km };
      }
      // On foot at 4.8 km/h, which is what `walking` means everywhere else.
      // `kind` and `network` travel with it so a row can say "6 min walk to
      // Piccadilly Gardens (Metrolink tram)" rather than calling it a station.
      return best ? { ...best, walkMinutes: Math.max(1, Math.round((best.km / 4.8) * 60)) } : null;
    };

    /**
     * What "how far" is measured from, which is the same point the search was
     * made around. Swapping the town to Bath looked around Bath and then threw
     * every answer away, because `distanceKm` was still measured from Windsor
     * and the radius test dropped anything over a hundred miles from it
     * (deployed, 6 Sep 2026).
     */
    const from = placement === 'town' ? town : (anchors.length ? heart : centre);
    let ranked = rankStays(look.beds, { anchors, centre: from, mode, availabilityFirst: look.priced })
      .filter((s) => s.distanceKm == null || s.distanceKm <= radiusKm + 1);

    // The walk to the platform and the train from it are facts about a bed, not
    // a mode of the screen: worked out whenever anything asks about them, so a
    // list ranked by the plans can still be filtered down to the ones by a
    // station.
    if (stations.length) {
      ranked = ranked.map((s) => {
        const st = nearestStation(s);
        const legs = anchors.map((a) => (st ? estimateTravelMinutes(st, a, 'transit') : null)).filter((n) => n != null);
        const typicalTrain = legs.length ? [...legs].sort((x, y) => x - y)[Math.floor((legs.length - 1) / 2)] : null;
        return { ...s, station: st, typicalTrainMinutes: typicalTrain };
      });
    }

    if (placement === 'station') {
      ranked = ranked
        .map((s) => {
          const st = s.station ?? nearestStation(s);
          // From the platform, by train, to each planned place.
          const legs = anchors.map((a) => (st ? estimateTravelMinutes(st, a, 'transit') : null)).filter((n) => n != null);
          const typicalTrain = legs.length ? [...legs].sort((x, y) => x - y)[Math.floor((legs.length - 1) / 2)] : null;
          return { ...s, station: st, typicalTrainMinutes: typicalTrain };
        })
        .sort((a, b) => {
          const aw = a.station?.walkMinutes ?? 999;
          const bw = b.station?.walkMinutes ?? 999;
          // Inside the walk you said you would do, the train time decides.
          const aOk = aw <= maxWalkMin, bOk = bw <= maxWalkMin;
          if (aOk !== bOk) return aOk ? -1 : 1;
          if (aOk && (a.typicalTrainMinutes ?? 999) !== (b.typicalTrainMinutes ?? 999)) return (a.typicalTrainMinutes ?? 999) - (b.typicalTrainMinutes ?? 999);
          return aw - bw;
        });
    } else if (placement === 'town') {
      ranked = [...ranked].sort((a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99));
    }

    /**
     * What was asked for, applied — and each of these is a filter rather than a
     * nudge, because somebody who says "under twenty minutes" and is shown
     * twenty-five has been ignored.
     *
     * A place with no price is never filtered out by a budget: not knowing what
     * something costs is not the same as it costing too much, and on the
     * afternoon the price source is quiet that rule is the difference between a
     * list and an empty screen.
     */
    // Which must-haves anybody around here has actually answered. A word no
    // bed in the pool carries is a word we know nothing about, not a word every
    // bed fails.
    const mustKnown = wantMust.filter((m) => ranked.some((st) => has(st, m)));

    ranked = ranked.filter((st) => {
      // Each of these holds if it was asked for, whatever the list is ranked
      // by. "Twenty minutes from the middle of town and ten from a platform" is
      // two of them at once, which is the whole point.
      if (wantsPlanMinutes && st.typicalMinutes != null && st.typicalMinutes > maxAvgMin) return false;
      if (wantsTownMinutes && estimateTravelMinutes(town, st, mode) > townMin) return false;
      // A bed with no station within reach fails a walk condition; it cannot
      // pass one by having nothing to measure against.
      if (wantsStationWalk && (st.station?.walkMinutes ?? 999) > maxWalkMin) return false;
      if (wantsTrain && st.typicalTrainMinutes != null && st.typicalTrainMinutes > maxTrainMin) return false;
      const night = st.offer?.perNight ?? null;
      if (night != null && (night < budgetMin || night > budgetMax)) return false;
      if (wantTypes.length && !stayKindMatches(st.stayKind, wantTypes)) return false;
      if (mustKnown.length && !mustKnown.every((m) => has(st, m))) return false;
      return true;
    });

    // The nice-to-haves reorder what survived: how many of them a bed has, and
    // the ranking it already had settles the rest.
    if (wantNice.length) {
      ranked = ranked
        .map((st, i) => ({ st, i, hits: wantNice.filter((n) => has(st, n)).length }))
        .sort((a, b) => b.hits - a.hits || a.i - b.i)
        .map((x) => x.st);
    }

    ranked = ranked.slice(0, 40);
    const status = await householdStatus(household.id, ranked.map((s) => s.venueRef));
    // Every outbound call is attributed (Technical Constraints §2). LiteAPI is
    // free to search — they earn on the booking — so the units are requests and
    // the cost line stays at zero, but the row is written all the same.
    if (!look.cached) await trips.recordProviderCall(household.id, 'osm', 'trip.stays');
    if (look.calls) await trips.recordProviderCall(household.id, 'liteapi', 'trip.stays.rates', { liteapi: look.calls });
    res.json({
      near: {
        ...from,
        label: placement === 'town' && townPoint ? 'the town you chose'
          : anchors.length ? 'the middle of your plans'
            : (trip.locality ?? trip.place_label ?? 'the centre'),
      },
      radiusKm,
      mode,
      anchors: anchors.map((a) => ({ label: a.label, lat: a.lat, lng: a.lng })),
      placement,
      spread,
      /** What was asked for, echoed back so the sheet can show it rather than its defaults. */
      /**
       * What was asked for, echoed back — and `mustUnanswered` says which of the
       * must-haves nobody around here has mapped, so the screen can say "the map
       * does not know about parking here" rather than pretending it filtered.
       */
      criteria: {
        maxAvgMin, townMin, maxTrainMin, maxWalkMin,
        /**
         * Which conditions were actually applied, as opposed to which controls
         * have a value. The sheet has a number in every box whether or not it
         * is doing anything, and a household reading "20 min" beside a list
         * that was never filtered by it has been misled.
         */
        /** Set when a station condition was asked for and the map could not be reached. */
        stationsUnavailable,
        /** 'held' — from our own table; 'live' — an area nobody had harvested yet. */
        stationSource,
        applied: [
          ...(wantsPlanMinutes ? [{ key: 'plans', label: `within ${maxAvgMin} min of your plans` }] : []),
          ...(wantsTownMinutes ? [{ key: 'town', label: `within ${townMin} min of the centre` }] : []),
          ...(wantsStationWalk ? [{ key: 'stationWalk', label: `${maxWalkMin} min walk of a station` }] : []),
          ...(wantsTrain ? [{ key: 'train', label: `${maxTrainMin} min by train` }] : []),
        ],
        budget: [budgetMin, Number.isFinite(budgetMax) ? budgetMax : null],
        types: wantTypes, must: wantMust, nice: wantNice,
        mustUnanswered: wantMust.filter((m) => !mustKnown.includes(m)),
      },
      results: ranked.map((s, i) => ({
        ...s,
        household: status[s.venueRef] ?? null,
        rank: i + 1,
        /**
         * The green line on the row: why this one, in the terms the placement
         * was chosen on. Written here rather than on the screen because it is
         * the same sentence the ranking was made from, and the two must not be
         * able to disagree.
         */
        fit: placement === 'station' && s.station
          ? [`${s.station.walkMinutes} min walk to ${s.station.name}`, s.typicalTrainMinutes != null ? `plans about ${s.typicalTrainMinutes} min by train` : null].filter(Boolean).join(' · ')
          : placement === 'town'
            ? `${estimateTravelMinutes(town, s, mode)} min ${mode === 'driving' ? 'drive' : 'walk'} from the centre`
            : s.plansTotal
              ? `${s.typicalMinutes} min ${mode === 'driving' ? 'drive' : 'walk'} to your ${s.plansTotal} planned place${s.plansTotal === 1 ? '' : 's'}${s.plansNear ? ` · ${s.plansNear} on foot` : ''}`
              : 'Nothing planned yet — this is the middle of town',
      })),
      cached: look.cached,
      // What was asked of the price source, and what came back — enough for the
      // screen to say "for 2 adults and 2 children, 1 room, 3 nights" and to be
      // corrected, rather than showing a number nobody can account for.
      pricing: {
        on: liteapiEnabled(),
        priced: look.priced,
        // A sandbox key answers with invented hotels at invented prices. Shown,
        // never hidden: a made-up price with nothing saying so is a lie.
        sandbox: look.sandbox,
        environment: liteapiKeyKind(),
        currency: look.currency,
        nights,
        checkIn: checkin,
        checkOut: checkout,
        rooms: asked.rooms,
        adults: asked.adults,
        childAges: asked.childAges,
        // Whose age we had to take a view on, so the screen can offer to fix it.
        assumedAges: derived.assumed,
        withPrice: ranked.filter((s) => s.offer).length,
        reason: look.reason,
        degraded: look.degraded,
      },
      // Milliseconds per source, and the whole thing. "The Stay tab is slow" is
      // otherwise unanswerable without a deploy, and the answer is rarely the
      // source anybody suspects.
      tookMs: { total: Date.now() - started, ...look.timings },
      mirrors: overpassHealth(),
      attributions: [OSM_ATTRIBUTION, ...(look.sources.includes('liteapi') ? [LITEAPI_ATTRIBUTION] : [])],
      attribution: OSM_ATTRIBUTION,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/trips/:id/stay — this is where we are staying.
 *
 * Picking a bed off the list is the household claiming a place, and a claim is
 * where the owned layer starts (CLAUDE.md, Technical Constraints §13.10). So
 * this is not a plain "set the base to whatever the row said":
 *
 *  - An open row (OpenStreetMap) is already ours to keep. Its name and its
 *    reference go straight in and sources/own.js researches it, so the address
 *    and the check-in time are on the phone when the family arrives.
 *  - A licensed row — a hotel LiteAPI has and the map does not — is looked for
 *    in the open map by name and point (sources/openMatch.js). Found, it is
 *    stored as the open place it turns out to be, and the rented record is
 *    discarded.
 *  - Not found, we keep the point and the household's own words for it. What
 *    is never done is writing a provider's name into a trip that syncs to a
 *    phone; that is the line `trip_stops.venue_name` already sits on.
 */
router.post('/:id/stay', async (req, res, next) => {
  try {
    const trip = await loadTrip(req.params.id);
    const b = req.body || {};
    const lat = Number(b.lat); const lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'point_required' });
    const ref = String(b.venueRef ?? '');
    const [prefix, ...rest] = ref.split(':');
    const openRef = ['osm', 'fixtures'].includes(prefix) ? rest.join(':') : null;

    let base = { label: String(b.label ?? '').trim() || 'Where we are staying', lat, lng, source: prefix === 'osm' ? 'osm' : null, sourcePlaceId: prefix === 'osm' ? openRef : null };
    let named = openRef ? 'open' : 'household';
    let how = null;

    if (!openRef && b.label) {
      // One Overpass lookup, and only on the one place they chose — not on the
      // forty on the list. This is the same call every claimed place makes.
      const match = await matchOsm({ name: String(b.label), lat, lng }).catch(() => null);
      if (match && match.confidence >= 0.6) {
        base = { label: match.matchedName, lat: match.lat, lng: match.lng, source: 'osm', sourcePlaceId: match.ref };
        named = 'open';
        how = match.how;
      }
    }

    claimBase(trip.household_id, base, 'hotel');
    await withTransaction(async (client) => {
      await trips.updateTrip(trip.id, {
        baseKind: 'hotel', baseLabel: base.label, baseLat: base.lat, baseLng: base.lng,
        ...(b.checkIn != null ? { checkIn: b.checkIn } : {}), ...(b.checkOut != null ? { checkOut: b.checkOut } : {}),
      }, client);
    });
    res.json({ ...(await tripPayload(trip.id)), stay: { named, how } });
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

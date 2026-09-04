// Trips: a day out or a fortnight abroad — same shape, different number of days
// (docs/trip-planner-design.md). Trip → days → stops in slots; a per-trip
// shortlist of researched places; a base to come back to.

import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { computeBudget, INTENSITY_TARGETS } from '../domain/budget.js';
import { TRAVEL_MODES } from '../domain/travel.js';
import { dayAsTrip, datesBetween, slotFor } from '../domain/days.js';
import { geocode, reverseGeocode } from '../sources/geocode.js';
import { optInFrom, enabledSources } from '../sources/index.js';
import { searchCached } from '../sources/cache.js';
import { kmBetween } from '../domain/travel.js';
import { currentHousehold } from './household.js';
import { visitPayload } from './places.js';
import { upsertHouseholdPlace } from './atlas.js';
import { claimPlace } from '../sources/own.js';

const router = Router();
const SLOTS = ['morning', 'afternoon', 'evening'];
const KINDS = ['food', 'activity', 'other'];
export const SHORTLIST_STATUSES = ['to_call', 'booked', 'no_booking', 'full', 'set_aside'];
export const LEG_MODES = ['walking', 'transit', 'driving', 'taxi'];

async function loadTrip(tripId) {
  const { rows } = await query('select * from trips where id = $1', [tripId]);
  if (!rows[0]) { const err = new Error('Trip not found'); err.status = 404; err.code = 'trip_not_found'; throw err; }
  return rows[0];
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
  for (const date of datesBetween(trip.start_date, trip.end_date)) {
    await client.query('insert into trip_days (trip_id, date) values ($1, $2) on conflict do nothing', [trip.id, date]);
  }
  // Days outside the new range lose their stops (cascade) — deliberate: the dates changed.
  await client.query('delete from trip_days where trip_id = $1 and (date < $2 or date > $3)', [trip.id, trip.start_date, trip.end_date]);
}

export async function placeTrip(client, tripId, point) {
  try {
    const r = await reverseGeocode(point.lat, point.lng);
    if (r) await client.query('update trips set country = $2, country_code = $3, locality = $4 where id = $1', [tripId, r.country, r.countryCode, r.locality]);
  } catch { /* unknown is acceptable */ }
}

export async function tripPayload(tripId) {
  const trip = await loadTrip(tripId);
  const household = await currentHousehold();
  const [{ rows: days }, { rows: stops }, { rows: attendees }, { rows: visitRows }, { rows: shortlist }] = await Promise.all([
    query('select * from trip_days where trip_id = $1 order by date', [tripId]),
    query('select * from trip_stops where trip_id = $1 order by position', [tripId]),
    query(`select m.id, m.name, m.is_minor, m.avatar_url from trip_attendees ta join members m on m.id = ta.member_id where ta.trip_id = $1 order by m.is_minor, m.name`, [tripId]),
    query('select id, stop_id from visits where trip_id = $1', [tripId]),
    query('select * from trip_shortlist where trip_id = $1 order by position nulls last, must_do desc, added_at', [tripId]),
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
    const { rows: unplaced } = await query('select id, base_lat, base_lng, origin_lat, origin_lng, destination_lat, destination_lng from trips where household_id = $1 and country_code is null limit 3', [household.id]);
    for (const t of unplaced) await placeTrip({ query }, t.id, { lat: t.base_lat ?? t.destination_lat ?? t.origin_lat, lng: t.base_lng ?? t.destination_lng ?? t.origin_lng });

    const params = [household.id];
    const where = ['t.household_id = $1'];
    if (country) { params.push(String(country).toUpperCase()); where.push(`t.country_code = $${params.length}`); }
    if (kind) { params.push(String(kind)); where.push(`t.kind = $${params.length}`); }
    if (when === 'upcoming') where.push('coalesce(t.end_date, t.return_at::date) >= current_date');
    if (when === 'past') where.push('coalesce(t.end_date, t.return_at::date) < current_date');
    if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`(lower(coalesce(t.title,'')) like $${params.length} or lower(coalesce(t.place_label,'')) like $${params.length} or lower(coalesce(t.base_label,'')) like $${params.length} or lower(coalesce(t.locality,'')) like $${params.length})`); }

    const { rows } = await query(
      `select t.*,
              (select count(*)::int from trip_days d where d.trip_id = t.id) as day_count,
              (select count(*)::int from trip_stops s where s.trip_id = t.id) as stop_count,
              (select count(*)::int from trip_shortlist s where s.trip_id = t.id) as shortlist_count,
              (select count(*)::int from visits v where v.trip_id = t.id) as visit_count,
              (select count(*)::int from ratings r join visits v on v.id = r.visit_id where v.trip_id = t.id) as rating_count,
              (select json_agg(m.name order by m.name) from trip_attendees ta join members m on m.id = ta.member_id where ta.trip_id = t.id) as attendees
         from trips t where ${where.join(' and ')}
        order by coalesce(t.start_date, t.depart_at::date) desc`,
      params,
    );
    const { rows: facets } = await query(`select country_code, country, count(*)::int as trips from trips where household_id = $1 and country_code is not null group by country_code, country order by trips desc`, [household.id]);
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
    const ids = async (client) => (Array.isArray(b.attendingMemberIds) && b.attendingMemberIds.length ? b.attendingMemberIds : (await client.query('select id from members where household_id = $1', [household.id])).rows.map((r) => r.id));

    if (kind === 'trip') {
      if (!b.startDate || !b.endDate || b.endDate < b.startDate) return res.status(400).json({ error: 'dates_required', message: 'Start and end dates are needed, end on or after start.' });
      let place = b.place?.lat != null ? b.place : null;
      if (!place && b.placeText) [place] = await geocode(b.placeText, { limit: 1 });
      let base = b.base?.lat != null ? b.base : null;
      if (!base && b.baseText) [base] = await geocode(b.baseText, { limit: 1, near: place, countryCode: place?.countryCode ?? null, within: Boolean(place), kind: 'lodging' });
      if (!base && (b.baseKind === 'home' || (!place && home))) base = home;
      if (!base && place) base = { ...place, label: `${place.label} (centre)` };
      if (!base) return res.status(400).json({ error: 'place_required', message: 'Say where the trip is — a city or region — or where you are staying.' });

      const trip = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `insert into trips (household_id, kind, title, notes, place_label, start_date, end_date,
                              base_label, base_lat, base_lng, base_kind, base_check_in, base_check_out, has_car, day_start, day_end,
                              origin_label, origin_lat, origin_lng, depart_at, return_at, travel_mode, intensity, timezone)
           values ($1,'trip',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$7,$8,$9,($5::date + $14::time), ($6::date + $15::time),$16,$17,$18) returning *`,
          [household.id, b.title?.trim() || null, b.notes?.trim() || null, place?.label ?? b.placeText ?? base.label, b.startDate, b.endDate,
           base.label, base.lat, base.lng, b.baseKind ?? (base === home ? 'home' : 'hotel'), b.checkIn ?? null, b.checkOut ?? null, b.hasCar !== false,
           b.dayStart ?? '09:30', b.dayEnd ?? '21:00', travelMode, intensity, household.timezone || 'Europe/London'],
        );
        const created = rows[0];
        for (const memberId of await ids(client)) await client.query('insert into trip_attendees (trip_id, member_id) values ($1, $2) on conflict do nothing', [created.id, memberId]);
        await ensureDays(client, created);
        await placeTrip(client, created.id, place ?? base);
        // Start from everything the household already knows in this city (atlas).
        if (b.seedFromAtlas !== false) {
          const { rows: placed } = await client.query('select country_code, locality from trips where id = $1', [created.id]);
          const loc = placed[0];
          if (loc?.country_code) {
            await client.query(
              `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, venue, note)
               select $1, hp.venue_ref, hp.label, coalesce(hp.kind, 'other'), hp.category, hp.lat, hp.lng, hp.venue, hp.note
                 from household_places hp
                where hp.household_id = $2 and hp.country_code = $3 and coalesce(hp.locality, '') = coalesce($4, '')
                  and not exists (select 1 from place_ledger l where l.household_id = $2 and l.source || ':' || l.source_place_id = hp.venue_ref and l.status = 'dismissed' and l.created_at > hp.last_seen)
               on conflict (trip_id, venue_ref) do nothing`,
              [created.id, household.id, loc.country_code, loc.locality],
            );
          }
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
      const { rows } = await client.query(
        `insert into trips (household_id, kind, title, notes, origin_label, origin_lat, origin_lng, destination_label, destination_lat, destination_lng,
                            depart_at, return_at, travel_mode, intensity, start_date, end_date, base_label, base_lat, base_lng, base_kind, has_car, day_start, day_end, timezone)
         values ($1,'outing',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,($10::timestamptz at time zone $15)::date,($11::timestamptz at time zone $15)::date,$4,$5,$6,'home',$14,($10::timestamptz at time zone $15)::time,($11::timestamptz at time zone $15)::time,$15) returning *`,
        [household.id, b.title?.trim() || null, b.notes?.trim() || null, origin.label, origin.lat, origin.lng,
         destination?.label ?? null, destination?.lat ?? null, destination?.lng ?? null, b.departAt, b.returnAt, travelMode, intensity, b.hasCar !== false, household.timezone || 'Europe/London'],
      );
      const created = rows[0];
      for (const memberId of await ids(client)) await client.query('insert into trip_attendees (trip_id, member_id) values ($1, $2) on conflict do nothing', [created.id, memberId]);
      await ensureDays(client, created);
      await client.query('update trip_days set intensity = $2, travel_mode = $3 where trip_id = $1', [created.id, intensity, travelMode]);
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
    const { rows } = await query(
      `select pc.provider, count(*)::int as calls, coalesce(sum(pc.estimated_cost_usd), 0)::float as cost_usd
         from provider_calls pc join plan_sessions ps on ps.id = pc.session_id
        where ps.trip_id = $1 group by pc.provider order by cost_usd desc, calls desc`,
      [req.params.id],
    );
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
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `update trips set
           title = coalesce($2, title), notes = coalesce($3, notes), start_date = coalesce($4, start_date), end_date = coalesce($5, end_date),
           has_car = coalesce($6, has_car), travel_mode = coalesce($7, travel_mode), intensity = coalesce($8, intensity),
           day_start = coalesce($9::time, day_start), day_end = coalesce($10::time, day_end),
           base_label = coalesce($11, base_label), base_lat = coalesce($12, base_lat), base_lng = coalesce($13, base_lng), base_kind = coalesce($14, base_kind),
           base_check_in = coalesce($15, base_check_in), base_check_out = coalesce($16, base_check_out),
           depart_at = coalesce($17, depart_at), return_at = coalesce($18, return_at)
         where id = $1 returning *`,
        [trip.id, b.title ?? null, b.notes ?? null, b.startDate ?? null, b.endDate ?? null, b.hasCar ?? null, b.travelMode ?? null, b.intensity ?? null,
         b.dayStart ?? null, b.dayEnd ?? null, base?.label ?? null, base?.lat ?? null, base?.lng ?? null, b.baseKind ?? null, b.checkIn ?? null, b.checkOut ?? null,
         b.departAt ?? null, b.returnAt ?? null],
      );
      // Which place sources this trip's searches and plans may use; null means the default set.
      if ('sources' in b) {
        const list = Array.isArray(b.sources) ? b.sources.map(String).filter(Boolean) : null;
        await client.query('update trips set sources = $2 where id = $1', [trip.id, list && list.length ? JSON.stringify(list) : null]);
      }
      await ensureDays(client, rows[0]);
    });
    res.json(await tripPayload(trip.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try { const { rowCount } = await query('delete from trips where id = $1', [req.params.id]); if (!rowCount) return res.status(404).json({ error: 'trip_not_found' }); res.status(204).end(); } catch (err) { next(err); }
});

router.put('/:id/attendees', async (req, res, next) => {
  try {
    const { memberIds = [] } = req.body || {};
    await withTransaction(async (client) => {
      await client.query('delete from trip_attendees where trip_id = $1', [req.params.id]);
      for (const memberId of memberIds) await client.query('insert into trip_attendees (trip_id, member_id) values ($1, $2)', [req.params.id, memberId]);
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
    const { rowCount } = await query(
      `update trip_days set intensity = coalesce($3, intensity), travel_mode = coalesce($4, travel_mode), start_time = coalesce($5::time, start_time), end_time = coalesce($6::time, end_time), notes = coalesce($7, notes)
        where id = $2 and trip_id = $1`,
      [req.params.id, req.params.dayId, intensity ?? null, travelMode ?? null, startTime ?? null, endTime ?? null, notes ?? null],
    );
    if (!rowCount) return res.status(404).json({ error: 'day_not_found' });
    // Where the day starts and ends: a place, or null to go back to the rule (home to home).
    const point = (p) => (p && p.lat != null && p.lng != null ? JSON.stringify({ label: p.label ?? null, lat: Number(p.lat), lng: Number(p.lng), kind: p.kind ?? 'custom' }) : null);
    if ('startPoint' in b) await query('update trip_days set start_point = $3 where id = $2 and trip_id = $1', [req.params.id, req.params.dayId, point(b.startPoint)]);
    if ('endPoint' in b) await query('update trip_days set end_point = $3 where id = $2 and trip_id = $1', [req.params.id, req.params.dayId, point(b.endPoint)]);
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

/** GET /api/trips/:id/shortlist/search?q=&categories=food|things&radiusKm=&near=lat,lng&refresh=1 — near the base by default. */
router.get('/:id/shortlist/search', async (req, res, next) => {
  try {
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
    const { rows: existing } = await query('select venue_ref from trip_shortlist where trip_id = $1', [trip.id]);
    const have = new Set(existing.map((r) => r.venue_ref));
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
      { refresh: req.query.refresh === '1' },
    ), deadline]);
    if (fetched) await query('insert into provider_calls (household_id, provider, purpose, units) values ($1, $2, $3, $4)', [household.id, sourcesQueried.join('+') || 'none', 'trip.shortlist.search', units]);
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
    res.json({ near: center, radiusKm, results: withFlags(results), degradedSources: degraded, sourcesQueried, cached, fetchedAt, tookMs: Date.now() - started });
  } catch (err) { next(err); }
});

/** One place onto a trip's shortlist (and into the atlas): the POST route and the Plan screen's Inspire me both come through here. */
export async function addShortlistItem(trip, household, b) {
  const kind = KINDS.includes(b.kind) ? b.kind : kindOfCategory(b.category);
  const snapshot = b.venue && ['osm', 'fixtures'].includes(String(b.venueRef).split(':')[0]) ? b.venue : null;
  await query(
    `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, venue, note, must_do, preferred_day_id, status, position)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, case when $5 in ('attraction','cafe') or $4 = 'other' then 'no_booking' else 'to_call' end,
             (select coalesce(max(position), 0) + 1 from trip_shortlist where trip_id = $1))
     on conflict (trip_id, venue_ref) do update set note = coalesce(excluded.note, trip_shortlist.note), must_do = excluded.must_do, preferred_day_id = coalesce(excluded.preferred_day_id, trip_shortlist.preferred_day_id)`,
    [trip.id, b.venueRef, b.venueLabel, kind, b.category ?? null, b.lat ?? null, b.lng ?? null, snapshot ? JSON.stringify(snapshot) : null, b.note?.trim() || null, Boolean(b.mustDo), b.preferredDayId ?? null],
  );
  await upsertHouseholdPlace({ query }, household.id, { venueRef: b.venueRef, label: b.venueLabel, kind, category: b.category, lat: b.lat, lng: b.lng, venue: b.venue, note: b.note, country: trip.country, countryCode: trip.country_code, locality: trip.locality });
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
    await query(`update trip_shortlist set note = coalesce($3, note), must_do = coalesce($4, must_do), preferred_day_id = coalesce($5, preferred_day_id), kind = coalesce($6, kind),
                   status = coalesce($7, status),
                   booked_time = case when $7 is not null and $7 <> 'booked' then null else coalesce($8::time, booked_time) end,
                   party_size = coalesce($9, party_size), booking_ref = coalesce($10, booking_ref), status_note = coalesce($11, status_note),
                   status_on = case when $7 in ('full', 'set_aside') then coalesce($12::date, current_date) when $7 is not null then null else status_on end,
                   dwell_minutes = coalesce($13, dwell_minutes), leg_mode = case when $14 = '' then null else coalesce($14, leg_mode) end, day_id = coalesce($15, day_id)
                 where id = $2 and trip_id = $1`,
      [req.params.id, req.params.itemId, note ?? null, mustDo ?? null, preferredDayId ?? null, KINDS.includes(kind) ? kind : null,
       status ?? null, bookedTime ? String(bookedTime).slice(0, 5) : null, partySize ?? null, bookingRef ?? null, statusNote ?? null, statusOn ?? null, dwellMinutes ?? null, legMode ?? null, dayId ?? null]);
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

router.delete('/:id/shortlist/:itemId', async (req, res, next) => {
  try { await query('delete from trip_shortlist where id = $2 and trip_id = $1', [req.params.id, req.params.itemId]); res.json(await tripPayload(req.params.id)); } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Stops (on a day, in a slot)
// ---------------------------------------------------------------------------

/** POST /api/trips/:id/days/:dayId/stops { venueRef, name, lat, lng, dwellMinutes?, slot?, startTime?, shortlistId? } */
router.post('/:id/days/:dayId/stops', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const { rows: days } = await query('select * from trip_days where id = $1 and trip_id = $2', [req.params.dayId, trip.id]);
    if (!days[0]) return res.status(404).json({ error: 'day_not_found' });
    const b = req.body || {};
    let stop = b;
    if (b.shortlistId) {
      const { rows } = await query('select * from trip_shortlist where id = $1 and trip_id = $2', [b.shortlistId, trip.id]);
      if (!rows[0]) return res.status(404).json({ error: 'shortlist_item_not_found' });
      stop = { venueRef: rows[0].venue_ref, name: rows[0].venue_label, lat: rows[0].lat, lng: rows[0].lng, category: rows[0].category, ...b };
    }
    if (!stop.venueRef || !stop.name) return res.status(400).json({ error: 'venue_required' });
    const slot = SLOTS.includes(b.slot) ? b.slot : b.startTime ? (Number(b.startTime.slice(0, 2)) < 12 ? 'morning' : Number(b.startTime.slice(0, 2)) < 17 ? 'afternoon' : 'evening') : 'morning';
    const { rows: mx } = await query('select coalesce(max(position), 0) as max from trip_stops where day_id = $1', [days[0].id]);
    const dwell = b.dwellMinutes ?? (['restaurant', 'pub'].includes(stop.category) ? household.default_visit_minutes : ['cafe', 'bar'].includes(stop.category) ? 45 : 120);
    await query(
      `insert into trip_stops (trip_id, day_id, slot, start_time, position, venue_ref, venue_name, lat, lng, dwell_minutes) values ($1,$2,$3,$4::time,$5,$6,$7,$8,$9,$10)`,
      [trip.id, days[0].id, slot, b.startTime ?? null, Number(mx[0].max) + 1, stop.venueRef, stop.name, stop.lat ?? null, stop.lng ?? null, dwell],
    );
    res.status(201).json(await tripPayload(trip.id));
  } catch (err) { next(err); }
});

/** Move or retime a stop: { dayId?, slot?, startTime?, dwellMinutes?, position? } */
router.patch('/:id/stops/:stopId', async (req, res, next) => {
  try {
    const { dayId, slot, startTime, dwellMinutes, position } = req.body || {};
    if (slot && !SLOTS.includes(slot)) return res.status(400).json({ error: 'invalid_slot' });
    const { rowCount } = await query(
      `update trip_stops set day_id = coalesce($3, day_id), slot = coalesce($4, slot), start_time = coalesce($5::time, start_time), dwell_minutes = coalesce($6, dwell_minutes), position = coalesce($7, position)
        where id = $2 and trip_id = $1`,
      [req.params.id, req.params.stopId, dayId ?? null, slot ?? null, startTime ?? null, dwellMinutes ?? null, position ?? null],
    );
    if (!rowCount) return res.status(404).json({ error: 'stop_not_found' });
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

router.delete('/:id/stops/:stopId', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from trip_stops where id = $1 and trip_id = $2', [req.params.stopId, req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'stop_not_found' });
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

/** Reorder within a day: { stopIds } */
router.post('/:id/days/:dayId/reorder', async (req, res, next) => {
  try {
    const { stopIds = [] } = req.body || {};
    await withTransaction(async (client) => {
      for (let i = 0; i < stopIds.length; i += 1) await client.query('update trip_stops set position = $3 where id = $2 and day_id = $1', [req.params.dayId, stopIds[i], i + 1]);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

/** "We went" on a stop (Epic 7 C1). Body: { visitedOn?, note?, venue? } */
router.post('/:id/stops/:stopId/visit', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const { rows: stops } = await query('select s.*, d.date as day_date from trip_stops s left join trip_days d on d.id = s.day_id where s.id = $1 and s.trip_id = $2', [req.params.stopId, trip.id]);
    if (!stops[0]) return res.status(404).json({ error: 'stop_not_found' });
    const stop = stops[0];
    const { rows: existing } = await query('select id from visits where stop_id = $1', [stop.id]);
    if (existing[0]) return res.json({ visit: await visitPayload(existing[0].id), deduplicated: true });
    const b = req.body || {};
    const { rows: attendees } = await query('select member_id from trip_attendees where trip_id = $1', [trip.id]);
    const visitId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into visits (household_id, trip_id, stop_id, venue_ref, venue_label, category, lat, lng, visited_on, note, country, country_code, locality)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [household.id, trip.id, stop.id, stop.venue_ref, stop.venue_name, b.venue?.category ?? null, stop.lat, stop.lng,
         b.visitedOn || stop.day_date || trip.start_date, b.note?.trim() || null, trip.country, trip.country_code, trip.locality],
      );
      const id = rows[0].id;
      for (const a of attendees) await client.query('insert into visit_attendees (visit_id, member_id) values ($1, $2) on conflict do nothing', [id, a.member_id]);
      const [source, ...rest] = stop.venue_ref.split(':');
      await client.query('insert into place_ledger (household_id, source, source_place_id, status) values ($1, $2, $3, $4)', [household.id, source, rest.join(':'), 'visited']);
      await upsertHouseholdPlace(client, household.id, { venueRef: stop.venue_ref, label: stop.venue_name, category: b.venue?.category, lat: stop.lat, lng: stop.lng, venue: b.venue, country: trip.country, countryCode: trip.country_code, locality: trip.locality });
      return id;
    });
    res.status(201).json({ visit: await visitPayload(visitId), tripId: trip.id });
  } catch (err) { next(err); }
});

export default router;

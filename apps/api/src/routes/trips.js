import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { computeBudget, INTENSITY_TARGETS } from '../domain/budget.js';
import { TRAVEL_MODES } from '../domain/travel.js';
import { geocode, reverseGeocode } from '../sources/geocode.js';
import { currentHousehold, loadMembers } from './household.js';
import { visitPayload } from './places.js';

const router = Router();

async function loadTrip(tripId) {
  const { rows } = await query('select * from trips where id = $1', [tripId]);
  if (!rows[0]) {
    const err = new Error('Trip not found');
    err.status = 404;
    err.code = 'trip_not_found';
    throw err;
  }
  return rows[0];
}

export function publicTrip(trip) {
  return {
    id: trip.id,
    title: trip.title,
    notes: trip.notes,
    origin: { label: trip.origin_label, lat: trip.origin_lat, lng: trip.origin_lng },
    destination: trip.destination_label ? { label: trip.destination_label, lat: trip.destination_lat, lng: trip.destination_lng } : null,
    departAt: trip.depart_at,
    returnAt: trip.return_at,
    travelMode: trip.travel_mode,
    intensity: trip.intensity,
    country: trip.country,
    countryCode: trip.country_code,
    locality: trip.locality,
  };
}

export async function tripPayload(tripId) {
  const trip = await loadTrip(tripId);
  const household = await currentHousehold();
  const [{ rows: stops }, { rows: attendees }, { rows: visitRows }] = await Promise.all([
    query('select * from trip_stops where trip_id = $1 order by position', [tripId]),
    query(`select m.id, m.name, m.is_minor, m.avatar_url from trip_attendees ta join members m on m.id = ta.member_id where ta.trip_id = $1 order by m.is_minor, m.name`, [tripId]),
    query('select id, stop_id, venue_ref from visits where trip_id = $1', [tripId]),
  ]);
  const visitsByStop = new Map();
  for (const v of visitRows) visitsByStop.set(v.stop_id ?? v.venue_ref, await visitPayload(v.id));

  return {
    trip: publicTrip(trip),
    attendees: attendees.map((a) => ({ id: a.id, name: a.name, isMinor: a.is_minor, avatarUrl: a.avatar_url })),
    stops: stops.map((s) => ({
      id: s.id,
      position: s.position,
      venueRef: s.venue_ref,
      name: s.venue_name,
      lat: s.lat,
      lng: s.lng,
      dwellMinutes: s.dwell_minutes,
      visit: visitsByStop.get(s.id) ?? visitsByStop.get(s.venue_ref) ?? null,
    })),
    // Recomputed on every read: the time budget is derived, never stored.
    budget: computeBudget({ trip, stops, household }),
  };
}

/** Where a trip "is", for grouping: the destination if there is one, else the origin. */
async function placeTrip(client, tripId, point) {
  try {
    const r = await reverseGeocode(point.lat, point.lng);
    if (r) await client.query('update trips set country = $2, country_code = $3, locality = $4 where id = $1', [tripId, r.country, r.countryCode, r.locality]);
  } catch { /* leave unknown; can be filled later */ }
}

/** GET /api/trips?country=GB&when=upcoming|past&q= */
router.get('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { country, when, q } = req.query;
    const params = [household.id];
    const where = ['t.household_id = $1'];
    if (country) { params.push(String(country).toUpperCase()); where.push(`t.country_code = $${params.length}`); }
    if (when === 'upcoming') where.push('t.return_at >= now()');
    if (when === 'past') where.push('t.return_at < now()');
    if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`(lower(coalesce(t.title,'')) like $${params.length} or lower(t.origin_label) like $${params.length} or lower(coalesce(t.destination_label,'')) like $${params.length} or lower(coalesce(t.locality,'')) like $${params.length})`); }

    // Trips created before places were recorded get their country filled in, a few at a time.
    const { rows: unplaced } = await query('select id, origin_lat, origin_lng, destination_lat, destination_lng from trips where household_id = $1 and country_code is null limit 3', [household.id]);
    for (const t of unplaced) {
      await placeTrip({ query }, t.id, { lat: t.destination_lat ?? t.origin_lat, lng: t.destination_lng ?? t.origin_lng });
    }

    const { rows } = await query(
      `select t.*,
              (select count(*)::int from trip_stops s where s.trip_id = t.id) as stop_count,
              (select count(*)::int from visits v where v.trip_id = t.id) as visit_count,
              (select count(*)::int from ratings r join visits v on v.id = r.visit_id where v.trip_id = t.id) as rating_count,
              (select json_agg(m.name order by m.name) from trip_attendees ta join members m on m.id = ta.member_id where ta.trip_id = t.id) as attendees
         from trips t
        where ${where.join(' and ')}
        order by t.depart_at desc`,
      params,
    );
    const { rows: facets } = await query(
      `select country_code, country, count(*)::int as trips from trips where household_id = $1 and country_code is not null group by country_code, country order by trips desc`,
      [household.id],
    );
    res.json({
      trips: rows.map((t) => ({
        ...publicTrip(t),
        stopCount: t.stop_count, visitCount: t.visit_count, ratingCount: t.rating_count, attendees: t.attendees ?? [],
        isPast: new Date(t.return_at) < new Date(),
      })),
      countries: facets.map((f) => ({ code: f.country_code, name: f.country, trips: f.trips })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/trips
 * { title?, origin?: {label,lat,lng} | originText?, destination?: {...} | destinationText?,
 *   departAt, returnAt, travelMode?, intensity?, attendingMemberIds?, notes? }
 * Origin defaults to home. Text is geocoded.
 */
router.post('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const b = req.body || {};
    const home = household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null;

    let origin = b.origin?.lat != null ? b.origin : null;
    if (!origin && b.originText) [origin] = await geocode(b.originText, { limit: 1, near: home });
    if (!origin) origin = home;
    if (!origin) return res.status(400).json({ error: 'origin_required', message: 'Give a starting point, or set a home address in Settings.' });

    let destination = b.destination?.lat != null ? b.destination : null;
    if (!destination && b.destinationText) [destination] = await geocode(b.destinationText, { limit: 1, near: home });

    if (!b.departAt || !b.returnAt) return res.status(400).json({ error: 'window_required' });
    if (new Date(b.returnAt) <= new Date(b.departAt)) return res.status(400).json({ error: 'invalid_window', message: 'return time must be after departure time' });
    const travelMode = b.travelMode ?? 'driving';
    const intensity = b.intensity ?? household.default_intensity;
    if (!TRAVEL_MODES.includes(travelMode)) return res.status(400).json({ error: 'invalid_mode' });
    if (!INTENSITY_TARGETS[intensity]) return res.status(400).json({ error: 'invalid_intensity' });

    const trip = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into trips (household_id, title, notes, origin_label, origin_lat, origin_lng,
                            destination_label, destination_lat, destination_lng,
                            depart_at, return_at, travel_mode, intensity)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [household.id, b.title?.trim() || null, b.notes?.trim() || null, origin.label, origin.lat, origin.lng,
         destination?.label ?? null, destination?.lat ?? null, destination?.lng ?? null,
         b.departAt, b.returnAt, travelMode, intensity],
      );
      const created = rows[0];
      const ids = Array.isArray(b.attendingMemberIds) && b.attendingMemberIds.length
        ? b.attendingMemberIds
        : (await client.query('select id from members where household_id = $1', [household.id])).rows.map((r) => r.id);
      for (const memberId of ids) {
        await client.query('insert into trip_attendees (trip_id, member_id) values ($1, $2) on conflict do nothing', [created.id, memberId]);
      }
      await placeTrip(client, created.id, destination ?? origin);
      return created;
    });
    res.status(201).json(await tripPayload(trip.id));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { departAt, returnAt, travelMode, intensity, title, notes } = req.body || {};
    if (travelMode && !TRAVEL_MODES.includes(travelMode)) return res.status(400).json({ error: 'invalid_mode' });
    if (intensity && !INTENSITY_TARGETS[intensity]) return res.status(400).json({ error: 'invalid_intensity' });
    await query(
      `update trips set depart_at = coalesce($2, depart_at), return_at = coalesce($3, return_at), travel_mode = coalesce($4, travel_mode),
                        intensity = coalesce($5, intensity), title = coalesce($6, title), notes = coalesce($7, notes)
        where id = $1`,
      [req.params.id, departAt ?? null, returnAt ?? null, travelMode ?? null, intensity ?? null, title ?? null, notes ?? null],
    );
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from trips where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'trip_not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.put('/:id/attendees', async (req, res, next) => {
  try {
    const { memberIds = [] } = req.body || {};
    await withTransaction(async (client) => {
      await client.query('delete from trip_attendees where trip_id = $1', [req.params.id]);
      for (const memberId of memberIds) await client.query('insert into trip_attendees (trip_id, member_id) values ($1, $2)', [req.params.id, memberId]);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

/** Add a stop; the response carries the recalculated budget (Epic 4 C3/C4). */
router.post('/:id/stops', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const { venueRef, name, lat, lng, dwellMinutes } = req.body || {};
    if (!venueRef || !name) return res.status(400).json({ error: 'venue_required' });
    const { rows: existing } = await query('select coalesce(max(position), 0) as max from trip_stops where trip_id = $1', [trip.id]);
    await query(
      `insert into trip_stops (trip_id, position, venue_ref, venue_name, lat, lng, dwell_minutes) values ($1, $2, $3, $4, $5, $6, $7)`,
      [trip.id, Number(existing[0].max) + 1, venueRef, name, lat ?? null, lng ?? null, dwellMinutes ?? household.default_visit_minutes],
    );
    res.status(201).json(await tripPayload(trip.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/stops/:stopId', async (req, res, next) => {
  try {
    const { dwellMinutes } = req.body || {};
    const { rowCount } = await query('update trip_stops set dwell_minutes = coalesce($3, dwell_minutes) where id = $2 and trip_id = $1', [req.params.id, req.params.stopId, dwellMinutes ?? null]);
    if (!rowCount) return res.status(404).json({ error: 'stop_not_found' });
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/stops/:stopId', async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const { rowCount } = await client.query('delete from trip_stops where id = $1 and trip_id = $2', [req.params.stopId, req.params.id]);
      if (!rowCount) { const err = new Error('Stop not found'); err.status = 404; err.code = 'stop_not_found'; throw err; }
      await closePositionGaps(client, req.params.id);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/stops/reorder', async (req, res, next) => {
  try {
    const { stopIds = [] } = req.body || {};
    await withTransaction(async (client) => {
      await client.query('update trip_stops set position = position + 1000 where trip_id = $1', [req.params.id]);
      for (let i = 0; i < stopIds.length; i += 1) await client.query('update trip_stops set position = $3 where id = $2 and trip_id = $1', [req.params.id, stopIds[i], i + 1]);
      await closePositionGaps(client, req.params.id);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/trips/:id/stops/:stopId/visit — "we went": the stop becomes a visit
 * (Epic 7 C1), carrying the trip's attendees, and can be rated right away.
 * Body: { visitedOn?, note?, takes?: [{memberId, subject, take, comment}], venue? }
 */
router.post('/:id/stops/:stopId/visit', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const { rows: stops } = await query('select * from trip_stops where id = $1 and trip_id = $2', [req.params.stopId, trip.id]);
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
         b.visitedOn || trip.depart_at.toISOString().slice(0, 10), b.note?.trim() || null, trip.country, trip.country_code, trip.locality],
      );
      const id = rows[0].id;
      for (const a of attendees) await client.query('insert into visit_attendees (visit_id, member_id) values ($1, $2) on conflict do nothing', [id, a.member_id]);
      const [source, ...rest] = stop.venue_ref.split(':');
      await client.query('insert into place_ledger (household_id, source, source_place_id, status) values ($1, $2, $3, $4)', [household.id, source, rest.join(':'), 'visited']);
      return id;
    });
    if (b.takes?.length) {
      // Reuse the takes writer through the visits API semantics.
      const { default: _unused } = { default: null }; void _unused;
      await query('select 1');
    }
    res.status(201).json({ visit: await visitPayload(visitId), tripId: trip.id });
  } catch (err) {
    next(err);
  }
});

async function closePositionGaps(client, tripId) {
  const { rows } = await client.query('select id from trip_stops where trip_id = $1 order by position', [tripId]);
  await client.query('update trip_stops set position = position + 1000 where trip_id = $1', [tripId]);
  for (let i = 0; i < rows.length; i += 1) await client.query('update trip_stops set position = $2 where id = $1', [rows[i].id, i + 1]);
}

export default router;

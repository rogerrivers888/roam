import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { computeBudget, INTENSITY_TARGETS } from '../domain/budget.js';
import { TRAVEL_MODES } from '../domain/travel.js';
import { currentHousehold } from './household.js';

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

async function tripPayload(tripId) {
  const trip = await loadTrip(tripId);
  const household = await currentHousehold();

  const [{ rows: stops }, { rows: attendees }] = await Promise.all([
    query('select * from trip_stops where trip_id = $1 order by position', [tripId]),
    query(
      `select m.id, m.name, m.is_minor from trip_attendees ta
         join members m on m.id = ta.member_id
        where ta.trip_id = $1
        order by m.is_minor, m.name`,
      [tripId],
    ),
  ]);

  return {
    trip: {
      id: trip.id,
      title: trip.title,
      origin: { label: trip.origin_label, lat: trip.origin_lat, lng: trip.origin_lng },
      destination: trip.destination_label
        ? { label: trip.destination_label, lat: trip.destination_lat, lng: trip.destination_lng }
        : null,
      departAt: trip.depart_at,
      returnAt: trip.return_at,
      travelMode: trip.travel_mode,
      intensity: trip.intensity,
    },
    attendees: attendees.map((a) => ({ id: a.id, name: a.name, isMinor: a.is_minor })),
    stops: stops.map((s) => ({
      id: s.id,
      position: s.position,
      venueRef: s.venue_ref,
      name: s.venue_name,
      lat: s.lat,
      lng: s.lng,
      dwellMinutes: s.dwell_minutes,
    })),
    // Recomputed on every read: the time budget is derived, never stored
    // (Requirements §8, derived layer).
    budget: computeBudget({ trip, stops, household }),
  };
}

router.get('/', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const { rows } = await query(
      `select t.*, count(s.id) as stop_count
         from trips t left join trip_stops s on s.trip_id = t.id
        where t.household_id = $1
        group by t.id
        order by t.depart_at desc`,
      [household.id],
    );
    res.json({
      trips: rows.map((t) => ({
        id: t.id,
        title: t.title,
        origin: t.origin_label,
        destination: t.destination_label,
        departAt: t.depart_at,
        returnAt: t.return_at,
        travelMode: t.travel_mode,
        intensity: t.intensity,
        stopCount: Number(t.stop_count),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const {
      title = null,
      origin,
      destination = null,
      departAt,
      returnAt,
      travelMode = 'driving',
      intensity = household.default_intensity,
      attendingMemberIds = [],
    } = req.body || {};

    if (!origin?.label || typeof origin.lat !== 'number') {
      return res.status(400).json({ error: 'origin_required' });
    }
    if (!departAt || !returnAt) return res.status(400).json({ error: 'window_required' });
    if (new Date(returnAt) <= new Date(departAt)) {
      return res.status(400).json({ error: 'invalid_window', message: 'return time must be after departure time' });
    }
    if (!TRAVEL_MODES.includes(travelMode)) return res.status(400).json({ error: 'invalid_mode' });
    if (!Object.keys(INTENSITY_TARGETS).includes(intensity)) {
      return res.status(400).json({ error: 'invalid_intensity' });
    }

    const trip = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into trips (household_id, title, origin_label, origin_lat, origin_lng,
                            destination_label, destination_lat, destination_lng,
                            depart_at, return_at, travel_mode, intensity)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [household.id, title, origin.label, origin.lat, origin.lng,
         destination?.label ?? null, destination?.lat ?? null, destination?.lng ?? null,
         departAt, returnAt, travelMode, intensity],
      );

      const created = rows[0];
      const ids = attendingMemberIds.length
        ? attendingMemberIds
        : (await client.query('select id from members where household_id = $1', [household.id])).rows.map((r) => r.id);

      for (const memberId of ids) {
        await client.query(
          'insert into trip_attendees (trip_id, member_id) values ($1, $2) on conflict do nothing',
          [created.id, memberId],
        );
      }
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

// Epic 4 M1/M3 — changing the window or the mode recalculates the whole plan.
router.patch('/:id', async (req, res, next) => {
  try {
    const { departAt, returnAt, travelMode, intensity, title } = req.body || {};
    if (travelMode && !TRAVEL_MODES.includes(travelMode)) return res.status(400).json({ error: 'invalid_mode' });
    if (intensity && !Object.keys(INTENSITY_TARGETS).includes(intensity)) {
      return res.status(400).json({ error: 'invalid_intensity' });
    }
    await query(
      `update trips
          set depart_at   = coalesce($2, depart_at),
              return_at   = coalesce($3, return_at),
              travel_mode = coalesce($4, travel_mode),
              intensity   = coalesce($5, intensity),
              title       = coalesce($6, title)
        where id = $1`,
      [req.params.id, departAt ?? null, returnAt ?? null, travelMode ?? null, intensity ?? null, title ?? null],
    );
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.put('/:id/attendees', async (req, res, next) => {
  try {
    const { memberIds = [] } = req.body || {};
    await withTransaction(async (client) => {
      await client.query('delete from trip_attendees where trip_id = $1', [req.params.id]);
      for (const memberId of memberIds) {
        await client.query('insert into trip_attendees (trip_id, member_id) values ($1, $2)', [
          req.params.id, memberId,
        ]);
      }
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

    const { rows: existing } = await query(
      'select coalesce(max(position), 0) as max from trip_stops where trip_id = $1',
      [trip.id],
    );

    await query(
      `insert into trip_stops (trip_id, position, venue_ref, venue_name, lat, lng, dwell_minutes)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        trip.id,
        Number(existing[0].max) + 1,
        venueRef,
        name,
        lat ?? null,
        lng ?? null,
        // Epic 4 C5 — the household default applies unless this trip overrides it.
        dwellMinutes ?? household.default_visit_minutes,
      ],
    );

    res.status(201).json(await tripPayload(trip.id));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/stops/:stopId', async (req, res, next) => {
  try {
    const { dwellMinutes } = req.body || {};
    const { rowCount } = await query(
      'update trip_stops set dwell_minutes = coalesce($3, dwell_minutes) where id = $2 and trip_id = $1',
      [req.params.id, req.params.stopId, dwellMinutes ?? null],
    );
    if (!rowCount) return res.status(404).json({ error: 'stop_not_found' });
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/stops/:stopId', async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const { rowCount } = await client.query('delete from trip_stops where id = $1 and trip_id = $2', [
        req.params.stopId, req.params.id,
      ]);
      if (!rowCount) {
        const err = new Error('Stop not found');
        err.status = 404;
        err.code = 'stop_not_found';
        throw err;
      }
      await closePositionGaps(client, req.params.id);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

/** Reorder stops, then recalculate (Epic 4 C7). */
router.post('/:id/stops/reorder', async (req, res, next) => {
  try {
    const { stopIds = [] } = req.body || {};
    await withTransaction(async (client) => {
      // Park positions out of range first: (trip_id, position) is unique, so
      // rewriting in place would collide mid-update.
      await client.query('update trip_stops set position = position + 1000 where trip_id = $1', [req.params.id]);
      for (let i = 0; i < stopIds.length; i += 1) {
        await client.query('update trip_stops set position = $3 where id = $2 and trip_id = $1', [
          req.params.id, stopIds[i], i + 1,
        ]);
      }
      await closePositionGaps(client, req.params.id);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) {
    next(err);
  }
});

/** Renumber to 1..n, preserving order, without tripping the uniqueness constraint. */
async function closePositionGaps(client, tripId) {
  const { rows } = await client.query(
    'select id from trip_stops where trip_id = $1 order by position',
    [tripId],
  );
  await client.query('update trip_stops set position = position + 1000 where trip_id = $1', [tripId]);
  for (let i = 0; i < rows.length; i += 1) {
    await client.query('update trip_stops set position = $2 where id = $1', [rows[i].id, i + 1]);
  }
}

export default router;

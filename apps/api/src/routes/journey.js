// The journey (owner, 3 Sep 2026): the shortlist read as a day. Every place
// still in the running (to call, booked, no booking needed) is taken in order
// from home, given a length, and the arrival times fall out; a booked time is
// a fixed point everything else is worked around. Save writes the result to
// the day's stops. The same engine reads a saved day back so the trip shows
// the same legs, and a leg's step-by-step directions are fetched on demand.
//
// Getting around is one choice on the trip (has_car): with the car every leg
// is a driving time (short hops stay on foot); without it each leg offers
// walking, public transport and a taxi, the quickest by default.

import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { estimateTravelMinutes } from '../domain/travel.js';
import { routingEnabled, routeBetween, directions as fetchDirections } from '../sources/routing.js';
import { dayAsTrip, slotFor } from '../domain/days.js';
import { wallToUtc, wallClock, DEFAULT_TZ } from '../domain/time.js';
import { currentHousehold } from './household.js';
import { tripPayload, LEG_MODES } from './trips.js';

const router = Router();
const RUNNING = new Set(['to_call', 'booked', 'no_booking']);
const TAXI_WAIT_MINUTES = 4;

async function loadTrip(tripId) {
  const { rows } = await query('select * from trips where id = $1', [tripId]);
  if (!rows[0]) { const err = new Error('Trip not found'); err.status = 404; err.code = 'trip_not_found'; throw err; }
  return rows[0];
}
async function loadDay(trip, dayId) {
  const { rows } = dayId
    ? await query('select * from trip_days where trip_id = $1 and id = $2', [trip.id, dayId])
    : await query('select * from trip_days where trip_id = $1 order by date limit 1', [trip.id]);
  if (!rows[0]) { const err = new Error('Day not found'); err.status = 404; err.code = 'day_not_found'; throw err; }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Legs: real times from Google Routes when the key is on, distance estimates
// otherwise. One route per pair per mode, remembered for a while so a reorder
// only fetches the pairs it created (a matrix would bill N² elements).
// ---------------------------------------------------------------------------

const legCache = new Map();
const LEG_TTL_MS = 6 * 3600_000;
const legKey = (a, b, mode) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}|${mode}`;

async function legMinutes(from, to, mode, departAt, meter) {
  const apiMode = mode === 'taxi' ? 'driving' : mode;
  const k = legKey(from, to, apiMode);
  let base = legCache.get(k);
  if (!base || Date.now() - base.at > LEG_TTL_MS) {
    let r = null;
    if (routingEnabled() && meter) {
      try { r = await routeBetween({ from, to, mode: apiMode, departAt }); meter.calls += 1; } catch (e) { meter.errors.push(e.message); }
    }
    base = r ? { minutes: r.minutes, estimated: false, at: Date.now() } : { minutes: estimateTravelMinutes(from, to, apiMode), estimated: true, at: Date.now() };
    legCache.set(k, base);
  }
  return { minutes: base.minutes + (mode === 'taxi' ? TAXI_WAIT_MINUTES : 0), estimated: base.estimated };
}

async function legOptions(from, to, hasCar, departAt, meter) {
  const out = {};
  if (hasCar) {
    out.driving = await legMinutes(from, to, 'driving', departAt, meter);
    // A hop of a few streets stays on foot with the car parked; no lookup needed to know that.
    out.walking = { minutes: estimateTravelMinutes(from, to, 'walking'), estimated: true };
  } else {
    for (const m of ['walking', 'transit', 'taxi']) out[m] = await legMinutes(from, to, m, departAt, meter);
  }
  return out;
}

function pickMode(options, hasCar, preferred) {
  if (preferred && options[preferred]) return preferred;
  if (hasCar) return options.walking.minutes <= 10 ? 'walking' : 'driving';
  return Object.entries(options).sort((a, b) => a[1].minutes - b[1].minutes)[0][0];
}

const FOOD = new Set(['restaurant', 'pub']);
function defaultDwell(item, household) {
  if (item.dwell_minutes) return item.dwell_minutes;
  const c = item.category;
  if (FOOD.has(c)) return household?.default_visit_minutes ?? 60;
  if (c === 'cafe') return 45;
  if (c === 'bar') return 60;
  if (c === 'event') return 150;
  if (c === 'attraction') return 90;
  return 60;
}

const mealOf = (hour) => (hour < 11 ? 'breakfast' : hour < 15.5 ? 'lunch' : hour >= 17 ? 'dinner' : null);

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

async function buildJourney({ trip, day, household, items, source }) {
  const tz = trip.timezone || DEFAULT_TZ;
  const v = dayAsTrip(trip, day);
  const hasCar = Boolean(trip.has_car);
  const home = { label: trip.base_kind === 'home' || !trip.base_label ? 'Home' : trip.base_label, lat: v.origin_lat, lng: v.origin_lng };
  const start = new Date(v.depart_at);
  const end = new Date(v.return_at);
  const fmt = (d) => wallClock(d, tz).hhmm;
  const mins = (a, b) => Math.round((b - a) / 60_000);
  const meter = { calls: 0, errors: [] };
  const legShape = (opts, mode, from, arrive) => ({
    from: { label: from.label, lat: from.lat, lng: from.lng }, mode, minutes: opts[mode].minutes, estimated: opts[mode].estimated,
    leaveBy: fmt(new Date(arrive.getTime() - opts[mode].minutes * 60_000)),
    options: Object.fromEntries(Object.entries(opts).map(([m, o]) => [m, { minutes: o.minutes, estimated: o.estimated }])),
  });

  const stops = [];
  let cursor = start;
  let from = home;
  let estimated = false;
  for (const item of items) {
    const point = item.lat != null && item.lng != null ? { label: item.venue_label, lat: item.lat, lng: item.lng } : null;
    const opts = point ? await legOptions(from, point, hasCar, cursor.toISOString(), meter) : { walking: { minutes: 0, estimated: true } };
    const mode = point ? pickMode(opts, hasCar, item.leg_mode) : 'walking';
    const legMin = opts[mode].minutes;
    if (opts[mode].estimated) estimated = true;
    const computedArrive = new Date(cursor.getTime() + legMin * 60_000);
    let arrive = computedArrive; let fixedAt = null; let spareBefore = null; let lateBy = null;
    if (item.booked_time) {
      fixedAt = wallToUtc(day.date, String(item.booked_time).slice(0, 5), tz);
      if (fixedAt >= computedArrive) { spareBefore = mins(computedArrive, fixedAt); arrive = fixedAt; } else lateBy = mins(fixedAt, computedArrive);
    }
    const dwell = defaultDwell(item, household);
    const leave = new Date(arrive.getTime() + dwell * 60_000);
    stops.push({
      id: item.id, venueRef: item.venue_ref, name: item.venue_label, category: item.category, kind: item.kind, lat: item.lat, lng: item.lng, venue: item.venue ?? null,
      status: item.status, bookedTime: item.booked_time ? String(item.booked_time).slice(0, 5) : null, partySize: item.party_size ?? null, bookingRef: item.booking_ref ?? null, note: item.note ?? null,
      mustDo: Boolean(item.must_do), position: stops.length + 1, dwellMinutes: dwell, dwellDefault: !item.dwell_minutes,
      fixed: Boolean(fixedAt), fixedAt: fixedAt ? fmt(fixedAt) : null, arriveAt: fmt(arrive), leaveAt: fmt(leave), spareBefore, lateBy,
      legIn: legShape(opts, mode, from, arrive), legModeChosen: item.leg_mode ?? null,
      _arrive: arrive, _leave: leave,
    });
    cursor = leave;
    if (point) from = point;
  }

  let legHome = null;
  let homeAt = cursor;
  if (stops.length) {
    const opts = await legOptions(from, home, hasCar, cursor.toISOString(), meter);
    const mode = pickMode(opts, hasCar, null);
    homeAt = new Date(cursor.getTime() + opts[mode].minutes * 60_000);
    legHome = legShape(opts, mode, from, homeAt);
    if (opts[mode].estimated) estimated = true;
  }

  // How long each stop could run: work back from the next fixed point (or home-by).
  let constraintAt = end;
  let travel = legHome ? legHome.minutes : 0;
  for (let i = stops.length - 1; i >= 0; i -= 1) {
    const s = stops[i];
    const mustLeave = new Date(constraintAt.getTime() - travel * 60_000);
    s.mustLeaveBy = fmt(mustLeave);
    s.windowMinutes = mins(s._arrive, mustLeave);
    if (s.fixed) { constraintAt = s._arrive; travel = s.legIn.minutes; } else travel += s.dwellMinutes + s.legIn.minutes;
  }

  // What stands between this list and a saved day.
  const blockers = [];
  const toCall = stops.filter((s) => s.status === 'to_call');
  if (toCall.length) blockers.push({ kind: 'to_call', text: `${toCall.length} still to call`, ids: toCall.map((s) => s.id) });
  const meals = new Map();
  for (const s of stops) {
    if (!['restaurant', 'pub', 'cafe', 'bar'].includes(s.category) || s.category === 'cafe') continue;
    const meal = mealOf(wallClock(s._arrive, tz).hours);
    if (!meal) continue;
    if (!meals.has(meal)) meals.set(meal, []);
    meals.get(meal).push(s);
  }
  for (const [meal, list] of meals) if (list.length > 1) blockers.push({ kind: 'clash', text: `${list.length === 2 ? 'Two' : list.length} ${meal === 'lunch' ? 'lunches' : `${meal}s`} (${list.map((s) => s.name).join(' and ')}). Pick one.`, ids: list.map((s) => s.id) });
  for (const s of stops) if (s.lateBy) blockers.push({ kind: 'late', text: `Can't make ${s.name} by ${s.fixedAt}: ${s.lateBy} min late as things stand.`, ids: [s.id] });
  const overBy = homeAt > end ? mins(end, homeAt) : 0;
  let tipping = null;
  if (overBy) {
    for (let i = 0; i < stops.length; i += 1) {
      const rest = i === stops.length - 1 ? (legHome?.minutes ?? 0) : 0;
      if (stops[i]._leave.getTime() + rest * 60_000 > end.getTime()) { tipping = { id: stops[i].id, name: stops[i].name }; break; }
    }
    blockers.push({ kind: 'over', text: `Over by ${overBy} min${tipping ? `. ${tipping.name} is the stop that tips it` : ''}.`, ids: tipping ? [tipping.id] : [] });
  }

  return {
    source, dayId: day.id, date: day.date, hasCar, timezone: tz,
    startAt: fmt(start), endAt: fmt(end), home, homeAt: fmt(homeAt),
    stops: stops.map(({ _arrive, _leave, ...s }) => s),
    legHome, fits: overBy === 0, spareMinutes: overBy ? 0 : mins(homeAt, end), overBy, tipping,
    blockers, canSave: stops.length > 0 && blockers.length === 0,
    estimated, routing: routingEnabled() ? 'google-routes' : 'estimate', lookups: meter.calls,
  };
}

async function logRouting(household, purpose, calls) {
  if (!calls) return;
  await query('insert into provider_calls (household_id, provider, purpose, units) values ($1, $2, $3, $4)', [household.id, 'google-routes', purpose, calls]).catch(() => null);
}

/** The shortlist's places for this day, in the running, in order. Unassigned places belong to whichever day is open. */
async function runningItems(trip, day) {
  const { rows } = await query(
    `select * from trip_shortlist where trip_id = $1 and (day_id = $2 or day_id is null) and status in ('to_call','booked','no_booking')
      order by position nulls last, must_do desc, added_at`, [trip.id, day.id]);
  return rows;
}

/** A saved day's stops, in the same shape the engine reads. */
async function savedItems(trip, day) {
  const { rows } = await query('select * from trip_stops where trip_id = $1 and day_id = $2 order by position', [trip.id, day.id]);
  return rows.map((s) => ({
    id: s.id, venue_ref: s.venue_ref, venue_label: s.venue_name, category: s.category ?? null, kind: null, lat: s.lat, lng: s.lng, venue: null,
    status: s.booking_status ?? 'no_booking', booked_time: s.booking_status === 'booked' ? s.start_time : null, party_size: null, booking_ref: s.booking_ref ?? null, note: null,
    must_do: false, dwell_minutes: s.dwell_minutes, leg_mode: s.leg_mode ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/trips/:id/journey?dayId=&source=shortlist|day */
router.get('/:id/journey', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const day = await loadDay(trip, req.query.dayId ? String(req.query.dayId) : null);
    const source = req.query.source === 'day' ? 'day' : 'shortlist';
    const items = source === 'day' ? await savedItems(trip, day) : await runningItems(trip, day);
    const journey = await buildJourney({ trip, day, household, items, source });
    await logRouting(household, `trip.journey.${source}`, journey.lookups);
    if (source === 'shortlist') {
      const { rows: others } = await query(`select id, venue_label, category, status, status_note, status_on from trip_shortlist where trip_id = $1 and (day_id = $2 or day_id is null) and status not in ('to_call','booked','no_booking') order by position nulls last, added_at`, [trip.id, day.id]);
      journey.others = others.map((o) => ({ id: o.id, name: o.venue_label, category: o.category, status: o.status, statusNote: o.status_note, statusOn: o.status_on }));
    }
    res.json(journey);
  } catch (err) { next(err); }
});

/** POST /api/trips/:id/journey/save { dayId } — the running places become the day's stops, in order, with their times and bookings. */
router.post('/:id/journey/save', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const day = await loadDay(trip, req.body?.dayId ?? null);
    const items = await runningItems(trip, day);
    const journey = await buildJourney({ trip, day, household, items, source: 'shortlist' });
    await logRouting(household, 'trip.journey.save', journey.lookups);
    if (!journey.stops.length) return res.status(400).json({ error: 'nothing_to_save', message: 'Nothing is in the running for this day.' });
    if (!journey.canSave && req.body?.force !== true) return res.status(409).json({ error: 'not_ready', blockers: journey.blockers });
    const tz = trip.timezone || DEFAULT_TZ;
    await withTransaction(async (client) => {
      // One save at a time per trip: two taps in the same instant must not both delete and both insert.
      await client.query('select id from trips where id = $1 for update', [trip.id]);
      await client.query('delete from trip_stops where trip_id = $1 and day_id = $2', [trip.id, day.id]);
      for (const s of journey.stops) {
        const arrive = wallToUtc(day.date, s.arriveAt, tz);
        await client.query(
          `insert into trip_stops (trip_id, day_id, slot, start_time, position, venue_ref, venue_name, lat, lng, dwell_minutes, booking_status, booking_ref, leg_mode)
           values ($1,$2,$3,$4::time,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [trip.id, day.id, slotFor(arrive, tz), s.arriveAt, s.position, s.venueRef, s.name, s.lat, s.lng, s.dwellMinutes, s.status, s.bookingRef, s.legIn.mode],
        );
        await client.query('update trip_shortlist set day_id = $3, position = $4 where id = $2 and trip_id = $1', [trip.id, s.id, day.id, s.position]);
      }
    });
    res.json({ saved: journey.stops.length, dayId: day.id, trip: await tripPayload(trip.id) });
  } catch (err) { next(err); }
});

/** POST /api/trips/:id/shortlist/reorder { itemIds } — the order of the journey. */
router.post('/:id/shortlist/reorder', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];
    await withTransaction(async (client) => {
      for (let i = 0; i < ids.length; i += 1) await client.query('update trip_shortlist set position = $3 where id = $2 and trip_id = $1', [req.params.id, ids[i], i + 1]);
    });
    res.json(await tripPayload(req.params.id));
  } catch (err) { next(err); }
});

/** GET /api/trips/:id/directions?from=lat,lng&to=lat,lng&mode=walking|transit|driving|taxi&departAt= — one leg, step by step, fetched now and not kept. */
router.get('/:id/directions', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const pt = (s) => { const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(String(s || '')); return m ? { lat: Number(m[1]), lng: Number(m[3]) } : null; };
    const from = pt(req.query.from); const to = pt(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'points_required' });
    const mode = LEG_MODES.includes(String(req.query.mode)) ? String(req.query.mode) : 'walking';
    const apiMode = mode === 'taxi' ? 'driving' : mode;
    const departAt = req.query.departAt ? String(req.query.departAt) : null;
    let d = null;
    if (routingEnabled()) {
      d = await fetchDirections({ from, to, mode: apiMode, departAt });
      await logRouting(household, 'trip.directions', 1);
    }
    if (!d) d = { minutes: estimateTravelMinutes(from, to, apiMode), meters: null, encodedPolyline: null, steps: [], estimated: true };
    if (mode === 'taxi') d.minutes += TAXI_WAIT_MINUTES;
    res.json({ mode, ...d, source: d.estimated ? 'estimate' : 'google-routes' });
  } catch (err) { next(err); }
});

export default router;

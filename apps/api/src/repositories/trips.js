/**
 * Every statement about a trip: its days, who is coming, what is shortlisted
 * and what is scheduled.
 *
 * Some of these run inside a transaction the route owns — creating a trip is
 * one act made of six writes — so they take an optional `client`. The flow
 * stays in the route where it reads as a sentence; the SQL is all here.
 */

import { query } from '../db.js';

/** The transaction's client if there is one, otherwise the pool. */
const on = (client) => (client ? (text, params) => client.query(text, params) : query);

// ---------------------------------------------------------------------------
// the trip itself
// ---------------------------------------------------------------------------

export async function tripById(id) {
  const { rows } = await query('select * from trips where id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * The list, with the counts each row shows and the names of who is coming.
 *
 * The filters are assembled rather than written out, because which ones are
 * present depends on what was asked — and assembled here, next to the column
 * names, rather than in a route.
 */
export async function tripsFor(householdId, { country, kind, when, q } = {}) {
  const params = [householdId];
  const where = ['t.household_id = $1'];
  if (country) { params.push(String(country).toUpperCase()); where.push(`t.country_code = $${params.length}`); }
  if (kind) { params.push(String(kind)); where.push(`t.kind = $${params.length}`); }
  if (when === 'upcoming') where.push('coalesce(t.end_date, t.return_at::date) >= current_date');
  if (when === 'past') where.push('coalesce(t.end_date, t.return_at::date) < current_date');
  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    where.push(`(lower(coalesce(t.title,'')) like $${params.length} or lower(coalesce(t.place_label,'')) like $${params.length}`
      + ` or lower(coalesce(t.base_label,'')) like $${params.length} or lower(coalesce(t.locality,'')) like $${params.length})`);
  }
  const { rows } = await query(
    `select t.*,
            (select count(*)::int from trip_days d where d.trip_id = t.id) as day_count,
            (select count(*)::int from trip_stops s where s.trip_id = t.id) as stop_count,
            (select count(*)::int from trip_shortlist s where s.trip_id = t.id) as shortlist_count,
            (select count(*)::int from visits v where v.trip_id = t.id) as visit_count,
            (select count(*)::int from ratings r join visits v on v.id = r.visit_id where v.trip_id = t.id) as rating_count,
            -- How many places this trip touched, and how many of them nobody
            -- has said anything about yet: a past trip's card leads with the
            -- rating it is still owed (handover, 5 Sep 2026: "rate 3").
            (select count(distinct venue_ref)::int from (
               select venue_ref from trip_stops where trip_id = t.id
               union select venue_ref from trip_shortlist where trip_id = t.id
               union select venue_ref from visits where trip_id = t.id) x) as place_count,
            (select count(*)::int from visits v
              where v.trip_id = t.id
                and not exists (select 1 from ratings r where r.visit_id = v.id and r.subject = 'visit')) as unrated_count,
            (select json_agg(json_build_object('id', m.id, 'name', m.name) order by m.name)
               from trip_attendees ta join members m on m.id = ta.member_id where ta.trip_id = t.id) as attendees
       from trips t where ${where.join(' and ')}
      order by coalesce(t.start_date, t.depart_at::date) desc`,
    params,
  );
  return rows;
}

/** Which countries the household has trips in, for the filter row. */
export async function tripCountries(householdId) {
  const { rows } = await query(
    `select country_code, country, count(*)::int as trips
       from trips where household_id = $1 and country_code is not null
      group by country_code, country order by trips desc`,
    [householdId],
  );
  return rows;
}

/** Trips that have never been placed on the map, so they can be, lazily. */
export async function unplacedTrips(householdId, limit = 3) {
  const { rows } = await query(
    `select id, base_lat, base_lng, origin_lat, origin_lng, destination_lat, destination_lng
       from trips where household_id = $1 and country_code is null limit $2`,
    [householdId, limit],
  );
  return rows;
}

export async function setTripPlace(tripId, place, client) {
  await on(client)('update trips set country = $2, country_code = $3, locality = $4 where id = $1',
    [tripId, place.country, place.countryCode, place.locality]);
}

export async function tripPlace(tripId, client) {
  const { rows } = await on(client)('select country_code, locality from trips where id = $1', [tripId]);
  return rows[0] ?? null;
}

/** A trip away: dates, a base to sleep at, a window each day. */
export async function insertTrip(householdId, t, client) {
  const { rows } = await on(client)(
    `insert into trips (household_id, kind, title, notes, place_label, start_date, end_date,
                        base_label, base_lat, base_lng, base_kind, base_check_in, base_check_out, has_car, day_start, day_end,
                        origin_label, origin_lat, origin_lng, depart_at, return_at, travel_mode, intensity, timezone)
     values ($1,'trip',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$7,$8,$9,($5::date + $14::time), ($6::date + $15::time),$16,$17,$18) returning *`,
    [householdId, t.title, t.notes, t.placeLabel, t.startDate, t.endDate,
      t.baseLabel, t.baseLat, t.baseLng, t.baseKind, t.checkIn, t.checkOut, t.hasCar,
      t.dayStart, t.dayEnd, t.travelMode, t.intensity, t.timezone],
  );
  return rows[0];
}

/** A day out: one window, home at both ends unless a destination is named. */
export async function insertOuting(householdId, o, client) {
  const { rows } = await on(client)(
    `insert into trips (household_id, kind, title, notes, origin_label, origin_lat, origin_lng, destination_label, destination_lat, destination_lng,
                        depart_at, return_at, travel_mode, intensity, start_date, end_date, base_label, base_lat, base_lng, base_kind, has_car, day_start, day_end, timezone)
     values ($1,'outing',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,($10::timestamptz at time zone $15)::date,($11::timestamptz at time zone $15)::date,$4,$5,$6,'home',$14,($10::timestamptz at time zone $15)::time,($11::timestamptz at time zone $15)::time,$15) returning *`,
    [householdId, o.title, o.notes, o.originLabel, o.originLat, o.originLng,
      o.destinationLabel, o.destinationLat, o.destinationLng, o.departAt, o.returnAt, o.travelMode, o.intensity, o.hasCar, o.timezone],
  );
  return rows[0];
}

export async function updateTrip(id, b, client) {
  const { rows } = await on(client)(
    `update trips set
       title = coalesce($2, title), notes = coalesce($3, notes), start_date = coalesce($4, start_date), end_date = coalesce($5, end_date),
       has_car = coalesce($6, has_car), travel_mode = coalesce($7, travel_mode), intensity = coalesce($8, intensity),
       day_start = coalesce($9::time, day_start), day_end = coalesce($10::time, day_end),
       base_label = coalesce($11, base_label), base_lat = coalesce($12, base_lat), base_lng = coalesce($13, base_lng), base_kind = coalesce($14, base_kind),
       base_check_in = coalesce($15, base_check_in), base_check_out = coalesce($16, base_check_out),
       depart_at = coalesce($17, depart_at), return_at = coalesce($18, return_at)
     where id = $1 returning *`,
    [id, b.title ?? null, b.notes ?? null, b.startDate ?? null, b.endDate ?? null, b.hasCar ?? null, b.travelMode ?? null, b.intensity ?? null,
      b.dayStart ?? null, b.dayEnd ?? null, b.baseLabel ?? null, b.baseLat ?? null, b.baseLng ?? null, b.baseKind ?? null,
      b.checkIn ?? null, b.checkOut ?? null, b.departAt ?? null, b.returnAt ?? null],
  );
  return rows[0] ?? null;
}

/** Which place sources this trip may use; null means the default set. */
export async function setTripSources(id, list, client) {
  await on(client)('update trips set sources = $2 where id = $1', [id, list && list.length ? JSON.stringify(list) : null]);
}

export async function deleteTrip(id) {
  const { rowCount } = await query('delete from trips where id = $1', [id]);
  return rowCount;
}

/** What this trip's searches and plans have cost, by provider. */
export async function tripSpend(tripId) {
  const { rows } = await query(
    `select pc.provider, count(*)::int as calls, coalesce(sum(pc.estimated_cost_usd), 0)::float as cost_usd
       from provider_calls pc join plan_sessions ps on ps.id = pc.session_id
      where ps.trip_id = $1 group by pc.provider order by cost_usd desc, calls desc`,
    [tripId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// who is coming
// ---------------------------------------------------------------------------

export async function householdMemberIds(householdId, client) {
  const { rows } = await on(client)('select id from members where household_id = $1', [householdId]);
  return rows.map((r) => r.id);
}

export async function addAttendee(tripId, memberId, client) {
  await on(client)('insert into trip_attendees (trip_id, member_id) values ($1, $2) on conflict do nothing', [tripId, memberId]);
}

export async function clearAttendees(tripId, client) {
  await on(client)('delete from trip_attendees where trip_id = $1', [tripId]);
}

export async function attendeeIds(tripId) {
  const { rows } = await query('select member_id from trip_attendees where trip_id = $1', [tripId]);
  return rows;
}

export async function attendeesOf(tripId) {
  const { rows } = await query(
    `select m.id, m.name, m.is_minor, m.avatar_url
       from trip_attendees ta join members m on m.id = ta.member_id
      where ta.trip_id = $1 order by m.is_minor, m.name`,
    [tripId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// days
// ---------------------------------------------------------------------------

export async function addDay(tripId, date, client) {
  await on(client)('insert into trip_days (trip_id, date) values ($1, $2) on conflict do nothing', [tripId, date]);
}

/** Days outside the range lose their stops (cascade) — deliberate: the dates changed. */
export async function trimDaysToRange(tripId, startDate, endDate, client) {
  await on(client)('delete from trip_days where trip_id = $1 and (date < $2 or date > $3)', [tripId, startDate, endDate]);
}

export async function daysOf(tripId) {
  const { rows } = await query('select * from trip_days where trip_id = $1 order by date', [tripId]);
  return rows;
}

export async function dayOfTrip(dayId, tripId) {
  const { rows } = await query('select * from trip_days where id = $1 and trip_id = $2', [dayId, tripId]);
  return rows[0] ?? null;
}

export async function setDayDefaults(tripId, { intensity, travelMode }, client) {
  await on(client)('update trip_days set intensity = $2, travel_mode = $3 where trip_id = $1', [tripId, intensity, travelMode]);
}

export async function updateDay(tripId, dayId, d) {
  const { rowCount } = await query(
    `update trip_days set intensity = coalesce($3, intensity), travel_mode = coalesce($4, travel_mode),
            start_time = coalesce($5::time, start_time), end_time = coalesce($6::time, end_time), notes = coalesce($7, notes)
      where id = $2 and trip_id = $1`,
    [tripId, dayId, d.intensity ?? null, d.travelMode ?? null, d.startTime ?? null, d.endTime ?? null, d.notes ?? null],
  );
  return rowCount;
}

/** Where a day starts or ends: a place, or null to go back to the rule. */
export async function setDayEndpoint(tripId, dayId, which, point) {
  const column = which === 'start' ? 'start_point' : 'end_point';
  await query(`update trip_days set ${column} = $3 where id = $2 and trip_id = $1`, [tripId, dayId, point]);
}

// ---------------------------------------------------------------------------
// the shortlist
// ---------------------------------------------------------------------------

export async function shortlistOf(tripId) {
  const { rows } = await query(
    'select * from trip_shortlist where trip_id = $1 order by position nulls last, must_do desc, added_at',
    [tripId],
  );
  return rows;
}

export async function shortlistRefs(tripId) {
  const { rows } = await query('select venue_ref from trip_shortlist where trip_id = $1', [tripId]);
  return rows.map((r) => r.venue_ref);
}

export async function shortlistItem(itemId, tripId) {
  const { rows } = await query('select * from trip_shortlist where id = $1 and trip_id = $2', [itemId, tripId]);
  return rows[0] ?? null;
}

/** What the household means to do, with a point on the map, for ranking beds. */
export async function shortlistAnchors(tripId) {
  const { rows } = await query(
    `select venue_ref, venue_label, lat, lng from trip_shortlist
      where trip_id = $1 and lat is not null and status <> 'dropped'`,
    [tripId],
  );
  return rows;
}

/**
 * Add one, or fold it into the one already there.
 *
 * The starting status is the booking question answered in advance: an
 * attraction or a café is somewhere you turn up, so it starts at "no booking"
 * rather than asking the household to close a question nobody opened.
 */
export async function upsertShortlistItem(tripId, item) {
  await query(
    `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, venue, note, must_do, preferred_day_id, status, position)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, case when $5 in ('attraction','cafe') or $4 = 'other' then 'no_booking' else 'to_call' end,
             (select coalesce(max(position), 0) + 1 from trip_shortlist where trip_id = $1))
     on conflict (trip_id, venue_ref) do update
        set note = coalesce(excluded.note, trip_shortlist.note),
            must_do = excluded.must_do,
            preferred_day_id = coalesce(excluded.preferred_day_id, trip_shortlist.preferred_day_id)`,
    [tripId, item.venueRef, item.venueLabel, item.kind, item.category ?? null, item.lat ?? null, item.lng ?? null,
      item.venue ? JSON.stringify(item.venue) : null, item.note ?? null, Boolean(item.mustDo), item.preferredDayId ?? null],
  );
}

/**
 * The working state of one shortlisted place (owner, 3 Sep 2026): booking
 * status, order, length, and how they will get there.
 *
 * Two rules are in the statement rather than around it. A status that stops
 * being "booked" drops the time it was booked for, because a time nobody holds
 * is worse than none. And "full" or "set aside" dates itself, so the row can
 * say when it stopped being an option.
 */
export async function updateShortlistItem(tripId, itemId, b) {
  await query(
    `update trip_shortlist set
       note = coalesce($3, note), must_do = coalesce($4, must_do), preferred_day_id = coalesce($5, preferred_day_id), kind = coalesce($6, kind),
       status = coalesce($7, status),
       booked_time = case when $7 is not null and $7 <> 'booked' then null else coalesce($8::time, booked_time) end,
       party_size = coalesce($9, party_size), booking_ref = coalesce($10, booking_ref), status_note = coalesce($11, status_note),
       status_on = case when $7 in ('full', 'set_aside') then coalesce($12::date, current_date) when $7 is not null then null else status_on end,
       dwell_minutes = coalesce($13, dwell_minutes), leg_mode = case when $14 = '' then null else coalesce($14, leg_mode) end, day_id = coalesce($15, day_id)
     where id = $2 and trip_id = $1`,
    [tripId, itemId, b.note ?? null, b.mustDo ?? null, b.preferredDayId ?? null, b.kind ?? null,
      b.status ?? null, b.bookedTime ?? null, b.partySize ?? null, b.bookingRef ?? null, b.statusNote ?? null,
      b.statusOn ?? null, b.dwellMinutes ?? null, b.legMode ?? null, b.dayId ?? null],
  );
}

export async function deleteShortlistItem(tripId, itemId) {
  await query('delete from trip_shortlist where id = $2 and trip_id = $1', [tripId, itemId]);
}

/**
 * Start a trip's shortlist from what the household already knows in this city.
 *
 * Anything they have dismissed since it was last seen is left out — a place
 * said no to does not come back because the trip is new.
 */
export async function seedShortlistFromAtlas(tripId, householdId, countryCode, locality, client) {
  await on(client)(
    `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, venue, note)
     select $1, hp.venue_ref, hp.label, coalesce(hp.kind, 'other'), hp.category, hp.lat, hp.lng, hp.venue, hp.note
       from household_places hp
      where hp.household_id = $2 and hp.country_code = $3 and coalesce(hp.locality, '') = coalesce($4, '')
        and not exists (select 1 from place_ledger l
                         where l.household_id = $2 and l.source || ':' || l.source_place_id = hp.venue_ref
                           and l.status = 'dismissed' and l.created_at > hp.last_seen)
     on conflict (trip_id, venue_ref) do nothing`,
    [tripId, householdId, countryCode, locality],
  );
}

// ---------------------------------------------------------------------------
// stops on a day
// ---------------------------------------------------------------------------

export async function stopsOf(tripId) {
  const { rows } = await query('select * from trip_stops where trip_id = $1 order by position', [tripId]);
  return rows;
}

export async function nextStopPosition(dayId) {
  const { rows } = await query('select coalesce(max(position), 0) as max from trip_stops where day_id = $1', [dayId]);
  return Number(rows[0].max) + 1;
}

export async function insertStop(tripId, dayId, s) {
  await query(
    `insert into trip_stops (trip_id, day_id, slot, start_time, position, venue_ref, venue_name, lat, lng, dwell_minutes)
     values ($1,$2,$3,$4::time,$5,$6,$7,$8,$9,$10)`,
    [tripId, dayId, s.slot, s.startTime ?? null, s.position, s.venueRef, s.name, s.lat ?? null, s.lng ?? null, s.dwellMinutes],
  );
}

export async function updateStop(tripId, stopId, s) {
  const { rowCount } = await query(
    `update trip_stops set day_id = coalesce($3, day_id), slot = coalesce($4, slot), start_time = coalesce($5::time, start_time),
            dwell_minutes = coalesce($6, dwell_minutes), position = coalesce($7, position)
      where id = $2 and trip_id = $1`,
    [tripId, stopId, s.dayId ?? null, s.slot ?? null, s.startTime ?? null, s.dwellMinutes ?? null, s.position ?? null],
  );
  return rowCount;
}

export async function deleteStop(tripId, stopId) {
  const { rowCount } = await query('delete from trip_stops where id = $1 and trip_id = $2', [stopId, tripId]);
  return rowCount;
}

export async function setStopPosition(dayId, stopId, position, client) {
  await on(client)('update trip_stops set position = $3 where id = $2 and day_id = $1', [dayId, stopId, position]);
}

/** One stop with the date of the day it sits on, for recording a visit. */
export async function stopWithDate(stopId, tripId) {
  const { rows } = await query(
    `select s.*, d.date as day_date from trip_stops s
       left join trip_days d on d.id = s.day_id
      where s.id = $1 and s.trip_id = $2`,
    [stopId, tripId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// visits made on a trip
// ---------------------------------------------------------------------------

export async function visitIdsOf(tripId) {
  const { rows } = await query('select id, stop_id from visits where trip_id = $1', [tripId]);
  return rows;
}

export async function visitForStop(stopId) {
  const { rows } = await query('select id from visits where stop_id = $1', [stopId]);
  return rows[0] ?? null;
}

export async function insertVisitForStop(householdId, trip, stop, b, client) {
  const { rows } = await on(client)(
    `insert into visits (household_id, trip_id, stop_id, venue_ref, venue_label, category, lat, lng, visited_on, note, country, country_code, locality)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [householdId, trip.id, stop.id, stop.venue_ref, stop.venue_name, b.category ?? null, stop.lat, stop.lng,
      b.visitedOn, b.note ?? null, trip.country, trip.country_code, trip.locality],
  );
  return rows[0].id;
}

export async function addVisitAttendee(visitId, memberId, client) {
  await on(client)('insert into visit_attendees (visit_id, member_id) values ($1, $2) on conflict do nothing', [visitId, memberId]);
}

export async function recordLedger(householdId, venueRef, status, client) {
  const [source, ...rest] = String(venueRef).split(':');
  await on(client)(
    'insert into place_ledger (household_id, source, source_place_id, status) values ($1, $2, $3, $4)',
    [householdId, source, rest.join(':'), status],
  );
}

// ---------------------------------------------------------------------------
// spend
// ---------------------------------------------------------------------------

export async function recordProviderCall(householdId, provider, purpose, units = null) {
  await query(
    'insert into provider_calls (household_id, provider, purpose, units) values ($1, $2, $3, $4)',
    [householdId, provider, purpose, units],
  );
}

// ---------------------------------------------------------------------------
// the journey: the day worked out end to end
// ---------------------------------------------------------------------------

export async function dayById(tripId, dayId) {
  const { rows } = await query('select * from trip_days where trip_id = $1 and id = $2', [tripId, dayId]);
  return rows[0] ?? null;
}

export async function firstDayOf(tripId) {
  const { rows } = await query('select * from trip_days where trip_id = $1 order by date limit 1', [tripId]);
  return rows[0] ?? null;
}

export async function dayIdsInOrder(tripId) {
  const { rows } = await query('select id from trip_days where trip_id = $1 order by date', [tripId]);
  return rows;
}

/**
 * The shortlist's places for a day, in the running, in order.
 *
 * A place with no day yet belongs to whichever day is open, which is why the
 * `day_id is null` arm is here rather than being filtered afterwards.
 */
export async function runningShortlist(tripId, dayId) {
  const { rows } = await query(
    `select * from trip_shortlist
      where trip_id = $1 and (day_id = $2 or day_id is null) and status in ('to_call','booked','no_booking')
      order by position nulls last, must_do desc, added_at`,
    [tripId, dayId],
  );
  return rows;
}

/** The ones set aside or full: shown beside the day, not in it. */
export async function setAsideShortlist(tripId, dayId) {
  const { rows } = await query(
    `select id, venue_label, category, status, status_note, status_on from trip_shortlist
      where trip_id = $1 and (day_id = $2 or day_id is null) and status not in ('to_call','booked','no_booking')
      order by position nulls last, added_at`,
    [tripId, dayId],
  );
  return rows;
}

export async function stopsOnDay(tripId, dayId) {
  const { rows } = await query('select * from trip_stops where trip_id = $1 and day_id = $2 order by position', [tripId, dayId]);
  return rows;
}

/**
 * Hold the trip while a day is rewritten.
 *
 * Saving a journey deletes the day's stops and writes them again. Two taps in
 * the same instant would otherwise both delete and both insert, and the day
 * would end up with everything twice.
 */
export async function lockTrip(tripId, client) {
  await on(client)('select id from trips where id = $1 for update', [tripId]);
}

export async function clearStopsOnDay(tripId, dayId, client) {
  await on(client)('delete from trip_stops where trip_id = $1 and day_id = $2', [tripId, dayId]);
}

/** A stop as the journey engine worked it out: with its time, booking and how they get there. */
export async function insertPlannedStop(tripId, dayId, s, client) {
  await on(client)(
    `insert into trip_stops (trip_id, day_id, slot, start_time, position, venue_ref, venue_name, lat, lng, dwell_minutes, booking_status, booking_ref, leg_mode)
     values ($1,$2,$3,$4::time,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [tripId, dayId, s.slot, s.startTime, s.position, s.venueRef, s.name, s.lat, s.lng, s.dwellMinutes, s.status, s.bookingRef, s.legMode],
  );
}

export async function assignShortlistToDay(tripId, itemId, dayId, position, client) {
  await on(client)('update trip_shortlist set day_id = $3, position = $4 where id = $2 and trip_id = $1', [tripId, itemId, dayId, position]);
}

export async function setShortlistPosition(tripId, itemId, position, client) {
  await on(client)('update trip_shortlist set position = $3 where id = $2 and trip_id = $1', [tripId, itemId, position]);
}

/** The most recent trips, for the offline manifest. */
export async function recentTripIds(householdId, limit = 60) {
  const { rows } = await query(
    'select id from trips where household_id = $1 order by coalesce(start_date, depart_at::date) desc limit $2',
    [householdId, limit],
  );
  return rows;
}

/** One trip, but only if it belongs to this household. */
export async function tripOfHousehold(tripId, householdId) {
  const { rows } = await query('select id, title, start_date from trips where id = $1 and household_id = $2', [tripId, householdId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// the planner's writes
// ---------------------------------------------------------------------------

/** The outing a plan makes: one day, its window already known. */
export async function insertPlannedOuting(householdId, t) {
  const { rows } = await query(
    `insert into trips (household_id, kind, title, origin_label, origin_lat, origin_lng,
                        destination_label, destination_lat, destination_lng,
                        depart_at, return_at, travel_mode, intensity,
                        start_date, end_date, base_label, base_lat, base_lng, base_kind, day_start, day_end, has_car, timezone, sources)
     values ($1,'outing',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$13::date,$14,$15,$16,$17,$19::time,$20::time,$18,$21,$22) returning *`,
    [householdId, t.title, t.originLabel, t.originLat, t.originLng,
      t.destinationLabel, t.destinationLat, t.destinationLng,
      t.departAt, t.returnAt, t.travelMode, t.intensity,
      t.date, t.baseLabel, t.baseLat, t.baseLng, t.baseKind, t.hasCar,
      t.dayStart, t.dayEnd, t.timezone, t.sources ? JSON.stringify(t.sources) : null],
  );
  return rows[0];
}

/** The stay a plan makes: a city, a date range, a base at its centre. */
export async function insertPlannedStay(householdId, t, client) {
  const { rows } = await on(client)(
    `insert into trips (household_id, kind, title, notes, place_label, start_date, end_date,
                        base_label, base_lat, base_lng, base_kind, has_car, day_start, day_end,
                        origin_label, origin_lat, origin_lng, depart_at, return_at, travel_mode, intensity, timezone)
     values ($1,'trip',$2,$3,$4,$5,$6,$7,$8,$9,'hotel',$10,$11,$12,$7,$8,$9,($5::date + $11::time),($6::date + $12::time),$13,$14,$15) returning *`,
    [householdId, t.title, t.notes, t.placeLabel, t.startDate, t.endDate,
      t.baseLabel, t.baseLat, t.baseLng, t.hasCar, t.dayStart, t.dayEnd, t.travelMode, t.intensity, t.timezone],
  );
  return rows[0];
}

export async function insertDay(tripId, d) {
  const { rows } = await query(
    'insert into trip_days (trip_id, date, intensity, travel_mode, start_time, end_time) values ($1, $2, $3, $4, $5::time, $6::time) returning *',
    [tripId, d.date, d.intensity, d.travelMode, d.startTime, d.endTime],
  );
  return rows[0];
}

/**
 * Seed a stay's shortlist from the atlas.
 *
 * Unlike the Trips-tab version this does not filter out places the household
 * has dismissed: a plan the household just asked for is a fresh intention, and
 * the planner has already decided what to offer.
 */
export async function seedStayShortlist(tripId, householdId, countryCode, locality, client) {
  await on(client)(
    `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, venue, note)
     select $1, hp.venue_ref, hp.label, coalesce(hp.kind, 'other'), hp.category, hp.lat, hp.lng, hp.venue, hp.note
       from household_places hp
      where hp.household_id = $2 and hp.country_code = $3 and coalesce(hp.locality, '') = coalesce($4, '')
     on conflict (trip_id, venue_ref) do nothing`,
    [tripId, householdId, countryCode, locality],
  );
}

/** A place the household asked for by name, put on as a must-do. */
export async function addAskedForPlace(tripId, venueRef, label, lat, lng, note) {
  await query(
    `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, note, must_do)
     values ($1,$2,$3,'activity','attraction',$4,$5,$6,true) on conflict (trip_id, venue_ref) do nothing`,
    [tripId, venueRef, label, lat, lng, note],
  );
}

export async function addPlannedShortlistItem(tripId, c) {
  await query(
    `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, must_do)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (trip_id, venue_ref) do nothing`,
    [tripId, c.venueRef, c.name, c.kind, c.category ?? null, c.lat ?? null, c.lng ?? null, c.mustDo],
  );
}

/** Places the household has marked special — they may be further than the usual limit. */
export async function specialRefs(householdId) {
  const { rows } = await query(
    `select source || ':' || source_place_id as ref from place_ledger where household_id = $1 and status = 'special'`,
    [householdId],
  );
  return rows.map((r) => r.ref);
}

/**
 * Throw away the outing a session made, but only while nothing has been done
 * with it: no stops, nothing shortlisted, nowhere visited. Planning the same
 * session somewhere else replaces an empty trip rather than leaving it behind.
 */
export async function deleteUntouchedTrip(tripId) {
  await query(
    `delete from trips t where t.id = $1
       and not exists (select 1 from trip_stops s where s.trip_id = t.id)
       and not exists (select 1 from trip_shortlist l where l.trip_id = t.id)
       and not exists (select 1 from visits v where v.trip_id = t.id)`,
    [tripId],
  );
}

/** Clear a day's stops, keeping any that have become a visit — a fact stays. */
export async function clearUnvisitedStops(tripId, dayId = null) {
  if (dayId) {
    await query('delete from trip_stops where day_id = $1 and not exists (select 1 from visits v where v.stop_id = trip_stops.id)', [dayId]);
    return;
  }
  await query('delete from trip_stops where trip_id = $1 and not exists (select 1 from visits v where v.stop_id = trip_stops.id)', [tripId]);
}

/** A booking already made, sitting on the day as an anchor. */
export async function anchorStops(dayId) {
  const { rows } = await query(`select * from trip_stops where day_id = $1 and venue_ref like 'anchor:%' order by start_time`, [dayId]);
  return rows;
}

export async function setDayWindow(dayId, startTime, endTime) {
  await query('update trip_days set start_time = $2::time, end_time = $3::time where id = $1', [dayId, startTime, endTime]);
}

/**
 * Stretch a day to hold something on the way there or back.
 *
 * `least`/`greatest` leave the day alone where there is nothing to stretch to,
 * so a stop before the day starts moves the start and nothing else.
 */
export async function stretchDay(dayId, earliest, latest) {
  await query(
    'update trip_days set start_time = least(start_time, $2::time), end_time = greatest(end_time, $3::time) where id = $1',
    [dayId, earliest, latest],
  );
}

/** Give the day back the minutes a changed route no longer needs. */
export async function shiftDayForTravel(dayId, outMinutes, backMinutes) {
  await query(
    `update trip_days set start_time = start_time + ($2::int * interval '1 minute'),
                          end_time = end_time - ($3::int * interval '1 minute') where id = $1`,
    [dayId, outMinutes, backMinutes],
  );
}

export async function setDayIntensity(dayId, intensity) {
  await query('update trip_days set intensity = $2 where id = $1', [dayId, intensity]);
}

export async function setDayTravelMode(dayId, travelMode) {
  await query('update trip_days set travel_mode = $2 where id = $1', [dayId, travelMode]);
}

export async function setDayEndTime(dayId, endTime) {
  await query('update trip_days set end_time = $2::time where id = $1', [dayId, endTime]);
}

export async function setTripDuration(tripId, minutes) {
  await query(`update trips set return_at = depart_at + ($2::int * interval '1 minute') where id = $1`, [tripId, minutes]);
}

export async function setTripIntensity(tripId, intensity) {
  await query('update trips set intensity = $2 where id = $1', [tripId, intensity]);
}

export async function setTripTravelMode(tripId, travelMode) {
  await query('update trips set travel_mode = $2 where id = $1', [tripId, travelMode]);
}

export async function dayOfTripStrict(dayId, tripId) {
  const { rows } = await query('select * from trip_days where id = $1 and trip_id = $2', [dayId, tripId]);
  return rows[0] ?? null;
}

export async function dayRow(dayId) {
  const { rows } = await query('select * from trip_days where id = $1', [dayId]);
  return rows[0] ?? null;
}

/** One trip in full, but only if it belongs to this household. */
export async function tripOfHouseholdFull(tripId, householdId) {
  const { rows } = await query('select * from trips where id = $1 and household_id = $2', [tripId, householdId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// every place a trip touched
// ---------------------------------------------------------------------------

/**
 * Every place this trip touched, once each, whichever way it got here — booked
 * onto a day, kept on the shortlist, visited, or slept in.
 *
 * The handover, 5 Sep 2026: "Places = every place the trip touched, grouped
 * Hotels / Activities / Food & drink … each row shows the day, star rating or
 * red Rate nudge." So this is a union rather than a read of one table: a
 * restaurant they walked into is a visit with no stop, the masseria is the
 * trip's base, and the gallery they never got to is still on the shortlist.
 *
 * The household's own name is what a row says, because the household wrote it
 * (Technical Constraints §13.10) — a provider's name for a place is rented and
 * never stored, so it is never what comes back from here.
 */
export async function placesOfTrip(tripId) {
  const { rows } = await query(
    `with touched as (
       select s.venue_ref, s.venue_name as label, null::text as category, s.lat, s.lng,
              d.date as on_date, s.dwell_minutes, 'stop' as via, s.booking_status
         from trip_stops s left join trip_days d on d.id = s.day_id
        where s.trip_id = $1
       union all
       select sl.venue_ref, sl.venue_label, sl.category, sl.lat, sl.lng,
              d.date, sl.dwell_minutes, 'shortlist', sl.status
         from trip_shortlist sl left join trip_days d on d.id = sl.day_id
        where sl.trip_id = $1
       union all
       select v.venue_ref, v.venue_label, v.category, v.lat, v.lng,
              v.visited_on, null::integer, 'visit', null::text
         from visits v where v.trip_id = $1
     )
     select t.venue_ref,
            (array_agg(t.label order by (t.label <> t.venue_ref) desc))[1] as label,
            (array_agg(t.category order by (t.category is not null) desc))[1] as category,
            (array_agg(t.lat order by (t.lat is not null) desc))[1] as lat,
            (array_agg(t.lng order by (t.lng is not null) desc))[1] as lng,
            min(t.on_date) as first_on,
            max(t.on_date) as last_on,
            max(t.dwell_minutes) as dwell_minutes,
            bool_or(t.via = 'visit') as visited,
            bool_or(t.via = 'stop') as scheduled,
            bool_or(t.via = 'shortlist') as shortlisted,
            (array_agg(t.booking_status order by (t.booking_status is not null) desc))[1] as booking_status,
            hp.category as atlas_category, hp.kind as atlas_kind,
            (select json_agg(json_build_object('memberId', r.member_id, 'member', m.name, 'score', r.score))
               from ratings r join visits v2 on v2.id = r.visit_id join members m on m.id = r.member_id
              where v2.trip_id = $1 and v2.venue_ref = t.venue_ref and r.subject = 'visit' and r.score is not null) as scores
       from touched t
       left join trips tr on tr.id = $1
       left join household_places hp on hp.household_id = tr.household_id and hp.venue_ref = t.venue_ref
      group by t.venue_ref, hp.category, hp.kind
      order by min(t.on_date) nulls last, label`,
    [tripId],
  );
  return rows;
}

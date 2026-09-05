/**
 * The atlas: every place the household has claimed, and where it is.
 *
 * `household_places` is the owned layer's index — a household act (shortlist,
 * save, been, special) puts a row here, and the row holds identifiers, the
 * household's own note and, for open sources only, a snapshot. A licensed
 * provider's name, hours or rating never lands in it (Technical Constraints
 * §13.10), which is why `upsertHouseholdPlace` decides what a snapshot may
 * contain rather than writing whatever it was handed.
 */

import { query } from '../db.js';

const on = (client) => (client ? (text, params) => client.query(text, params) : query);

/**
 * Great-circle miles between a row and a point, for "close to home".
 *
 * Postgres without PostGIS: the spherical law of cosines, clamped so rounding
 * cannot hand `acos()` a number outside its domain.
 */
const MILES_FROM = (latParam, lngParam) => `(3958.7613 * acos(least(1, greatest(-1,
  sin(radians(${latParam})) * sin(radians(hp.lat)) + cos(radians(${latParam})) * cos(radians(hp.lat)) * cos(radians(hp.lng) - radians(${lngParam}))
))))`;

// ---------------------------------------------------------------------------
// writing a place into the atlas
// ---------------------------------------------------------------------------

/**
 * Record, or refresh, a place.
 *
 * Two rules are in the statement rather than around it:
 *
 *  - a place first saved with no name but its identifier keeps the better name
 *    it is given later, and never loses one to a save that has none;
 *  - the kind follows the category once one is known, so a place saved as
 *    "other" stops being "other" the moment a visit says it is a restaurant.
 */
export async function upsertHouseholdPlace(client, householdId, p) {
  await on(client)(
    `insert into household_places (household_id, venue_ref, label, kind, category, lat, lng, country, country_code, locality, venue, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (household_id, venue_ref) do update set
       label = case when excluded.label = excluded.venue_ref and household_places.label <> household_places.venue_ref
                    then household_places.label else coalesce(excluded.label, household_places.label) end,
       kind = case when excluded.category is not null then excluded.kind else coalesce(excluded.kind, household_places.kind) end,
       category = coalesce(excluded.category, household_places.category),
       lat = coalesce(excluded.lat, household_places.lat), lng = coalesce(excluded.lng, household_places.lng),
       country = coalesce(excluded.country, household_places.country), country_code = coalesce(excluded.country_code, household_places.country_code),
       locality = coalesce(excluded.locality, household_places.locality), venue = coalesce(excluded.venue, household_places.venue),
       note = coalesce(excluded.note, household_places.note), last_seen = now()`,
    [householdId, p.venueRef, p.label, p.kind, p.category, p.lat, p.lng,
      p.country, p.countryCode, p.locality, p.venue ? JSON.stringify(p.venue) : null, p.note ?? null],
  );
}

/** Name a place that was only ever held by its identifier. */
export async function nameUnnamedPlace(householdId, venueRef, label) {
  await query(
    'update household_places set label = $3 where household_id = $1 and venue_ref = $2 and label = venue_ref',
    [householdId, venueRef, label],
  );
}

export async function visitCountFor(householdId, venueRef) {
  const { rows } = await query('select count(*)::int as n from visits where household_id = $1 and venue_ref = $2', [householdId, venueRef]);
  return rows[0].n;
}

/**
 * Take a place out of the atlas, with the marks that would walk it back in.
 *
 * A visit is a fact and is kept elsewhere, so somewhere the household has
 * actually been reappears rather than being quietly erased — which is why the
 * route refuses to call this when there are visits.
 */
export async function removePlace(client, householdId, venueRef) {
  const [source, ...rest] = String(venueRef).split(':');
  await on(client)('delete from household_places where household_id = $1 and venue_ref = $2', [householdId, venueRef]);
  await on(client)('delete from place_ledger where household_id = $1 and source = $2 and source_place_id = $3', [householdId, source, rest.join(':')]);
}

// ---------------------------------------------------------------------------
// reading it back
// ---------------------------------------------------------------------------

/**
 * Countries and cities, with counts of places, visits, specials and trips, and
 * the three the area screen is divided into: things to do, food & drink, and
 * somewhere to stay (handover, 5 Sep 2026 — an area's tabs are Activities |
 * Food & drink | Hotels, and the Hotels tab only appears where there is one).
 */
export async function countryCityCounts(householdId) {
  const { rows } = await query(
    `with p as (
       select hp.country_code, hp.country, hp.locality, hp.venue_ref, hp.last_seen, hp.category,
              exists (select 1 from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as been,
              exists (select 1 from place_ledger l where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref and l.status = 'special') as special
         from household_places hp where hp.household_id = $1 and hp.country_code is not null)
     select p.country_code, p.country, p.locality,
            count(*)::int as places,
            count(*) filter (where p.been)::int as been,
            count(*) filter (where p.special)::int as special,
            count(*) filter (where p.category in ('restaurant','cafe','pub','bar'))::int as food,
            count(*) filter (where p.category in ('hotel','lodging'))::int as hotels,
            count(*) filter (where p.category is null or p.category not in ('restaurant','cafe','pub','bar','hotel','lodging'))::int as activities,
            (select count(*)::int from trips t where t.household_id = $1 and t.country_code = p.country_code and coalesce(t.locality, '') = coalesce(p.locality, '')) as trips,
            max(p.last_seen) as last_seen
       from p
      group by p.country_code, p.country, p.locality
      order by p.country, p.locality`,
    [householdId],
  );
  return rows;
}

/**
 * Every trip, thinly, filed by where it went — so a country row can say "Last:
 * Puglia · Aug 2025" and an area row can say when they were last there.
 *
 * The whole list rather than an aggregate, because "last" and "next" are two
 * different rows and the country's answer is not the sum of its areas'.
 */
export async function tripsByArea(householdId) {
  const { rows } = await query(
    `select t.id, t.title, t.place_label, t.locality, t.country, t.country_code, t.kind,
            coalesce(t.start_date, t.depart_at::date) as starts_on,
            coalesce(t.end_date, t.return_at::date) as ends_on
       from trips t
      where t.household_id = $1 and t.country_code is not null
      order by starts_on desc`,
    [householdId],
  );
  return rows;
}

/**
 * A few candidate places per area, so an area, a country's area list and a trip
 * card can each carry a picture of somewhere the household actually went.
 *
 * Several rather than one: most places have no picture we may hold, and asking
 * for the single most recent would leave most areas blank when the third row
 * down has a photograph sitting in the library.
 */
export async function areaPictureRefs(householdId, per = 10) {
  const { rows } = await query(
    `with ranked as (
       select hp.country_code, coalesce(hp.locality, 'Elsewhere') as locality, hp.venue_ref,
              row_number() over (
                partition by hp.country_code, coalesce(hp.locality, 'Elsewhere')
                order by (hp.category is null or hp.category not in ('restaurant','cafe','pub','bar','hotel','lodging')) desc,
                         hp.last_seen desc nulls last, hp.venue_ref) as n
         from household_places hp
        where hp.household_id = $1 and hp.country_code is not null)
     select country_code, locality, venue_ref, n from ranked where n <= $2 order by country_code, locality, n`,
    [householdId, per],
  );
  return rows;
}

/** Which country the front door is in, read from the places around it. */
export async function homeCountryCode(householdId, lat, lng, radiusMiles) {
  const { rows } = await query(
    `select hp.country_code, count(*)::int as n from household_places hp
      where hp.household_id = $1 and hp.country_code is not null and hp.lat is not null and hp.lng is not null
        and ${MILES_FROM('$2', '$3')} <= $4
      group by hp.country_code order by n desc limit 1`,
    [householdId, lat, lng, radiusMiles],
  );
  return rows[0]?.country_code ?? null;
}

/** The same, for the standing "close to home" view, which is not an area. */
export async function nearHomePictureRefs(householdId, lat, lng, radiusMiles, limit = 10) {
  const { rows } = await query(
    `select hp.venue_ref from household_places hp
      where hp.household_id = $1 and hp.lat is not null and hp.lng is not null and ${MILES_FROM('$2', '$3')} <= $4
      order by hp.last_seen desc nulls last limit $5`,
    [householdId, lat, lng, radiusMiles, limit],
  );
  return rows.map((r) => r.venue_ref);
}

/** Cities the household made on purpose, and the cities their trips are in. */
export async function citiesWithoutPlaces(householdId) {
  const [created, tripCities] = await Promise.all([
    query('select country, country_code, locality, lat, lng from atlas_cities where household_id = $1', [householdId]),
    query(
      `select country, country_code, locality, count(*)::int as trips,
              max(coalesce(base_lat, origin_lat)) as lat, max(coalesce(base_lng, origin_lng)) as lng
         from trips where household_id = $1 and country_code is not null
        group by country, country_code, locality`,
      [householdId],
    ),
  ]);
  return { created: created.rows, tripCities: tripCities.rows };
}

/** A centre for each city derived from its places, for "add a place here". */
export async function cityCentres(householdId) {
  const { rows } = await query(
    `select country_code, coalesce(locality, 'Elsewhere') as locality, avg(lat) as lat, avg(lng) as lng
       from household_places where household_id = $1 and lat is not null
      group by country_code, locality`,
    [householdId],
  );
  return rows;
}

export async function unplacedCount(householdId) {
  const { rows } = await query('select count(*)::int as n from household_places where household_id = $1 and country_code is null', [householdId]);
  return rows[0].n;
}

/** Everything within the household's radius of the front door, wherever it files. */
export async function nearHomeCounts(householdId, lat, lng, radiusMiles) {
  const { rows } = await query(
    `select count(*)::int as places,
            count(*) filter (where exists (select 1 from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref))::int as been,
            count(*) filter (where exists (select 1 from place_ledger l where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref and l.status = 'special'))::int as special
       from household_places hp
      where hp.household_id = $1 and hp.lat is not null and hp.lng is not null and ${MILES_FROM('$2', '$3')} <= $4`,
    [householdId, lat, lng, radiusMiles],
  );
  return rows[0];
}

/**
 * The places themselves, with everything a row shows: how often they went, who
 * said what, each person's latest score, and which trips it is on.
 *
 * A label that is only the identifier is replaced at read time by the
 * household's own name for the place, from wherever they last wrote one — a
 * save with no context should not read as a row of characters for ever.
 */
export async function placesIn(householdId, f = {}, home = null) {
  const params = [householdId];
  const where = ['hp.household_id = $1'];
  if (f.nearHome) {
    params.push(home.lat, home.lng, home.radiusMiles);
    where.push(`hp.lat is not null and hp.lng is not null and ${MILES_FROM(`$${params.length - 2}`, `$${params.length - 1}`)} <= $${params.length}`);
  }
  if (f.country && !f.nearHome) { params.push(String(f.country).toUpperCase()); where.push(`hp.country_code = $${params.length}`); }
  if (f.city && !f.nearHome) { params.push(String(f.city)); where.push(`coalesce(hp.locality, 'Elsewhere') = $${params.length}`); }
  if (f.kind) { params.push(String(f.kind)); where.push(`hp.kind = $${params.length}`); }
  if (f.q) { params.push(`%${String(f.q).toLowerCase()}%`); where.push(`(lower(hp.label) like $${params.length} or lower(coalesce(hp.note,'')) like $${params.length})`); }

  const { rows } = await query(
    `select hp.*,
            case when hp.label = hp.venue_ref then coalesce(
              (select v.venue_label from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref and v.venue_label <> hp.venue_ref order by v.created_at desc limit 1),
              (select s.venue_label from trip_shortlist s join trips t on t.id = s.trip_id where t.household_id = hp.household_id and s.venue_ref = hp.venue_ref and s.venue_label <> hp.venue_ref order by s.added_at desc limit 1),
              (select st.venue_name from trip_stops st join trips t on t.id = st.trip_id where t.household_id = hp.household_id and st.venue_ref = hp.venue_ref and st.venue_name <> hp.venue_ref order by st.created_at desc limit 1),
              hp.venue ->> 'name') end as known_label,
            (select count(*)::int from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as visits,
            (select max(v.visited_on) from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as last_on,
            (select json_agg(json_build_object('member', m.name, 'take', r.take, 'comment', r.comment, 'on', v.visited_on) order by v.visited_on desc)
               from ratings r join visits v on v.id = r.visit_id join members m on m.id = r.member_id
              where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref and r.subject = 'visit') as takes,
            (select l.status from place_ledger l where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref
              and l.status in ('special','saved','dismissed')
              order by case l.status when 'special' then 0 when 'saved' then 1 else 2 end, l.created_at desc limit 1) as ledger,
            (select json_agg(distinct jsonb_build_object('id', t.id, 'title', coalesce(t.title, t.place_label, t.locality),
                                                          'on', to_char(coalesce(t.start_date, t.depart_at::date), 'Mon YYYY')))
               from trip_shortlist s join trips t on t.id = s.trip_id
              where s.venue_ref = hp.venue_ref and t.household_id = hp.household_id) as on_trips,
            (select json_agg(json_build_object('memberId', s.member_id, 'member', s.name, 'score', s.score, 'on', s.visited_on)) from (
               select distinct on (r.member_id) r.member_id, m.name, r.score, v.visited_on
                 from ratings r join visits v on v.id = r.visit_id join members m on m.id = r.member_id
                where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref and r.subject = 'visit' and r.score is not null
                order by r.member_id, v.visited_on desc, r.created_at desc) s) as scores
       from household_places hp
      where ${where.join(' and ')}
      order by hp.kind, hp.label`,
    params,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// cities made on purpose
// ---------------------------------------------------------------------------

export async function upsertCity(householdId, c) {
  await query(
    `insert into atlas_cities (household_id, country, country_code, locality, lat, lng) values ($1,$2,$3,$4,$5,$6)
     on conflict (household_id, country_code, locality) do update
        set lat = coalesce(excluded.lat, atlas_cities.lat), lng = coalesce(excluded.lng, atlas_cities.lng)`,
    [householdId, c.country, c.countryCode, c.locality, c.lat, c.lng],
  );
}

export async function deleteCity(householdId, countryCode, locality) {
  await query('delete from atlas_cities where household_id = $1 and country_code = $2 and locality = $3', [householdId, countryCode, locality]);
}

/** The cities the household has places in, for the offline manifest. */
export async function citiesWithPlaces(householdId) {
  const { rows } = await query(
    `select distinct country_code, coalesce(locality, 'Elsewhere') as locality
       from household_places where household_id = $1 and country_code is not null`,
    [householdId],
  );
  return rows;
}

/** Every place the household has claimed, for the owned records the device keeps. */
export async function claimedRefs(householdId) {
  const { rows } = await query('select distinct venue_ref from place_claims where household_id = $1', [householdId]);
  return rows.map((r) => r.venue_ref);
}

/** What the household knows, in words, for the planner to read. */
export async function atlasForPrompt(householdId, limit = 40) {
  const { rows } = await query(
    `select hp.label, hp.kind, hp.category, hp.locality, hp.note,
            (select string_agg(distinct l.status::text, ',') from place_ledger l
              where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref) as statuses
       from household_places hp where hp.household_id = $1 order by hp.last_seen desc limit $2`,
    [householdId, limit],
  );
  return rows;
}

/** Every placed thing the household owns, for matching an idea to somewhere they know. */
export async function placedPlaces(householdId) {
  const { rows } = await query(
    'select venue_ref, label, kind, category, lat, lng, venue from household_places where household_id = $1 and lat is not null and lng is not null',
    [householdId],
  );
  return rows;
}

/** Where a place is, once the open map has been asked: postcode and nearest station. */
export async function saveWhere(householdId, venueRef, w) {
  await query(
    `update household_places set postcode = coalesce($3, postcode), station = $4, station_lines = $5,
            station_kind = $6, station_distance_m = $7, where_checked = $8
      where household_id = $1 and venue_ref = $2`,
    [householdId, venueRef, w.postcode, w.station?.name ?? null,
      w.station ? JSON.stringify(w.station.lines) : null, w.station?.kind ?? null,
      w.station?.distanceM ?? null, w.checkedAt],
  );
}

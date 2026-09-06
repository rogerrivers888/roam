/**
 * Every statement about a household, its people and what they will and will not
 * eat. The route file above this holds none.
 *
 * Rule 1 of the estate's engineering standard: all SQL lives in `repositories/`.
 * A route that needs data calls a function here.
 */

import { query, withTransaction } from '../db.js';

// ---------------------------------------------------------------------------
// the household
// ---------------------------------------------------------------------------

/**
 * The founding household — the owner's own.
 *
 * Before accounts this was *the* household and `currentHousehold()` was this
 * function. It is now the fallback for the two callers with no account behind
 * them: the owner's shared passcode, and work that runs outside any request.
 */
export async function firstHousehold() {
  const { rows } = await query('select * from households order by created_at limit 1');
  return rows[0] ?? null;
}

/** One named household: an account's own, or a group's, resolved rather than assumed. */
export async function householdById(id) {
  const { rows } = await query('select * from households where id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Change only what was sent.
 *
 * Home is the exception to "coalesce keeps the old value": a household that
 * moves country has to stop being in the old one, so the country columns follow
 * the coordinates rather than merging with what was there.
 */
export async function updateHousehold(id, f) {
  const { rows } = await query(
    `update households
        set name                  = coalesce($2, name),
            default_visit_minutes = coalesce($3, default_visit_minutes),
            max_travel_minutes    = coalesce($4, max_travel_minutes),
            default_intensity     = coalesce($5, default_intensity),
            home_label            = coalesce($6, home_label),
            home_lat              = coalesce($7, home_lat),
            home_lng              = coalesce($8, home_lng),
            home_country_code     = case when $7::numeric is null then home_country_code else $12 end,
            home_country          = case when $7::numeric is null then home_country      else $13 end,
            pace                  = coalesce($9::jsonb, pace),
            timezone              = coalesce($10, timezone),
            home_radius_miles     = coalesce($11, home_radius_miles),
            -- '' is how the household takes the picture down: coalesce cannot
            -- say "set this to nothing", so an empty string means clear it.
            home_photo_url        = case when $14::text is null then home_photo_url
                                         when $14 = '' then null else $14 end
      where id = $1 returning *`,
    [id, f.name ?? null, f.defaultVisitMinutes ?? null, f.maxTravelMinutes ?? null, f.defaultIntensity ?? null,
      f.homeLabel ?? null, f.homeLat ?? null, f.homeLng ?? null, f.pace ? JSON.stringify(f.pace) : null,
      f.timezone ?? null, f.homeRadiusMiles ?? null, f.homeCountryCode ?? null, f.homeCountry ?? null,
      f.homePhotoUrl ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Delete means delete (Epic 1 C10).
 *
 * `provider_calls` first because it is the one table that outlives the
 * household by design — it is the spend ledger, and it has no cascade. Both in
 * one transaction so a household is never half gone.
 */
export function deleteHouseholdAndCalls(householdId) {
  return withTransaction(async (client) => {
    await client.query('delete from provider_calls where household_id = $1', [householdId]);
    await client.query('delete from households where id = $1', [householdId]);
  });
}

// ---------------------------------------------------------------------------
// the people in it
// ---------------------------------------------------------------------------

/** Everybody, each with their own constraints already gathered. */
export async function membersWithConstraints(householdId) {
  const { rows } = await query(
    `select m.*,
            coalesce(json_agg(json_build_object('id', c.id, 'kind', c.kind, 'value', c.value,
                                                'conceptKey', c.concept_key, 'conceptKind', c.concept_kind, 'maxMinutes', c.max_minutes, 'favourite', c.favourite))
                     filter (where c.id is not null), '[]') as constraints
       from members m
       left join member_constraints c on c.member_id = m.id
      where m.household_id = $1
      group by m.id
      order by m.is_minor, m.created_at`,
    [householdId],
  );
  return rows;
}

export async function insertMember(householdId, m) {
  const { rows } = await query(
    `insert into members (household_id, name, is_minor, relationship, birth_year, birth_date, avatar_url, typical_visit_minutes, max_travel_minutes, email, mobile)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
    [householdId, m.name, m.isMinor, m.relationship ?? null, m.birthYear ?? null, m.birthDate ?? null,
      m.avatarUrl ?? null, m.typicalVisitMinutes ?? null, m.maxTravelMinutes ?? null,
      m.email ?? null, m.mobile ?? null],
  );
  return rows[0];
}

/**
 * Change only what was sent — and work out whether they are still a minor from
 * whichever of birth date or birth year the change leaves behind, so the answer
 * cannot disagree with the dates it was derived from.
 */
export async function updateMember(id, m) {
  const { rows } = await query(
    `update members
        set name                  = coalesce($2, name),
            relationship          = coalesce($3, relationship),
            birth_year            = coalesce($4, birth_year),
            avatar_url            = case when $5::text = '' then null else coalesce($5, avatar_url) end,
            typical_visit_minutes = coalesce($6, typical_visit_minutes),
            max_travel_minutes    = coalesce($7, max_travel_minutes),
            birth_date            = coalesce($8::date, birth_date),
            -- How to reach them, so they can be invited (migration 056). '' is
            -- how the Household tab takes a contact detail back off somebody,
            -- the way it already takes a face off them.
            email                 = case when $9::text = '' then null else coalesce($9, email) end,
            mobile                = case when $10::text = '' then null else coalesce($10, mobile) end,
            is_minor              = case when coalesce($8::date, birth_date) is not null
                                         then age(coalesce($8::date, birth_date)) < interval '13 years'
                                         when coalesce($4, birth_year) is not null
                                         then (extract(year from now())::int - coalesce($4, birth_year)) < 13
                                         else is_minor end
      where id = $1 returning *`,
    [id, m.name ?? null, m.relationship ?? null, m.birthYear ?? null, m.avatarUrl ?? null,
      m.typicalVisitMinutes ?? null, m.maxTravelMinutes ?? null, m.birthDate ?? null,
      m.email ?? null, m.mobile ?? null],
  );
  return rows[0] ?? null;
}

/** One person, on their own — the invite routes check who they are before acting. */
export async function memberById(id) {
  const { rows } = await query('select * from members where id = $1', [id]);
  return rows[0] ?? null;
}

/** Epic 1 M3 — this takes their rating history with them, by cascade. */
export async function deleteMember(id) {
  const { rowCount } = await query('delete from members where id = $1', [id]);
  return rowCount;
}

// ---------------------------------------------------------------------------
// allergens, diets, likes and dislikes
// ---------------------------------------------------------------------------

export async function constraintsOfKind(memberId, kind) {
  const { rows } = await query('select * from member_constraints where member_id = $1 and kind = $2', [memberId, kind]);
  return rows;
}

export async function capConstraint(id, maxMinutes) {
  const { rows } = await query('update member_constraints set max_minutes = $2 where id = $1 returning *', [id, maxMinutes]);
  return rows[0] ?? null;
}

/**
 * Add one, or fold it into the one already there.
 *
 * A favourite already set is never unset by adding the same thing again, and a
 * limit already set survives an add that carries none: the row only ever gains.
 */
export async function upsertConstraint(memberId, c) {
  const { rows } = await query(
    `insert into member_constraints (member_id, kind, value, concept_key, concept_kind, max_minutes, favourite)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (member_id, kind, value) do update
        set concept_key  = excluded.concept_key,
            concept_kind = excluded.concept_kind,
            max_minutes  = coalesce(excluded.max_minutes, member_constraints.max_minutes),
            favourite    = excluded.favourite or member_constraints.favourite
     returning *`,
    [memberId, c.kind, c.value, c.conceptKey ?? null, c.conceptKind ?? null, c.maxMinutes ?? null, Boolean(c.favourite)],
  );
  return rows[0];
}

/**
 * "Walks — up to 40 minutes", and "the one this person will generally pick".
 *
 * Only the fields present in `fields` are touched, which is why the statement is
 * assembled rather than written out — and why it is assembled here, where the
 * column names live, rather than in a route.
 */
export async function patchConstraint(id, fields) {
  const sets = [];
  const params = [id];
  if ('maxMinutes' in fields) {
    params.push(fields.maxMinutes ? Number(fields.maxMinutes) : null);
    sets.push(`max_minutes = $${params.length}`);
  }
  if ('favourite' in fields) {
    params.push(Boolean(fields.favourite));
    sets.push(`favourite = $${params.length} and kind = 'like'`);
  }
  if (!sets.length) return { nothingToDo: true, constraint: null };
  const { rows } = await query(`update member_constraints set ${sets.join(', ')} where id = $1 returning *`, params);
  return { nothingToDo: false, constraint: rows[0] ?? null };
}

export async function deleteConstraint(id) {
  const { rowCount } = await query('delete from member_constraints where id = $1', [id]);
  return rowCount;
}

// ---------------------------------------------------------------------------
// what the ratings have taught us, and what has been spent
// ---------------------------------------------------------------------------

/** Every rating that names a concept, with the date it was given. */
export async function conceptRatings(householdId) {
  const { rows } = await query(
    `select r.member_id, m.name, r.concept_key, r.take, v.visited_on
       from ratings r
       join visits v on v.id = r.visit_id
       join members m on m.id = r.member_id
      where v.household_id = $1 and r.concept_key is not null`,
    [householdId],
  );
  return rows;
}

/** The last few hundred provider calls, for the spend drawer. */
export async function recentProviderCalls(householdId, limit = 300) {
  const { rows } = await query(
    `select id, created_at as at, provider, purpose, coalesce(estimated_cost_usd, 0)::float as cost_usd, units
       from provider_calls where household_id = $1
      order by created_at desc limit $2`,
    [householdId, limit],
  );
  return rows;
}

/**
 * Everything the household has generated, for the export.
 *
 * Licensed place content is never in here: these are identifiers, dates and
 * what the household wrote (Technical Constraints §4).
 */
export async function everythingFor(householdId) {
  const [trips, stops, visits, ratings, ledger] = await Promise.all([
    query('select * from trips where household_id = $1 order by depart_at', [householdId]),
    query('select s.* from trip_stops s join trips t on t.id = s.trip_id where t.household_id = $1 order by s.trip_id, s.position', [householdId]),
    query('select * from visits where household_id = $1 order by visited_on', [householdId]),
    query('select r.* from ratings r join visits v on v.id = r.visit_id where v.household_id = $1 order by r.created_at', [householdId]),
    query('select * from place_ledger where household_id = $1 order by created_at', [householdId]),
  ]);
  return { trips: trips.rows, stops: stops.rows, visits: visits.rows, ratings: ratings.rows, ledger: ledger.rows };
}

// ---------------------------------------------------------------------------
// setting one up
// ---------------------------------------------------------------------------

export async function anyHouseholdExists() {
  const { rows } = await query('select id from households limit 1');
  return rows.length > 0;
}

/** Only ever from `npm run seed --force`, which says so before it runs. */
export async function deleteAllHouseholds(client) {
  await client.query('delete from households');
}

export async function createHousehold(client, h) {
  const { rows } = await client.query(
    `insert into households (name, default_visit_minutes, max_travel_minutes, default_intensity)
     values ($1, $2, $3, $4) returning id`,
    [h.name, h.defaultVisitMinutes, h.maxTravelMinutes, h.defaultIntensity],
  );
  return rows[0].id;
}

export async function createMember(client, householdId, m) {
  const { rows } = await client.query(
    `insert into members (household_id, name, is_minor, relationship, birth_year, typical_visit_minutes)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [householdId, m.name, m.isMinor, m.relationship ?? null, m.birthYear ?? null, m.typicalVisitMinutes],
  );
  return rows[0].id;
}

export async function createConstraint(client, memberId, kind, value) {
  await client.query('insert into member_constraints (member_id, kind, value) values ($1, $2, $3)', [memberId, kind, value]);
}

/**
 * Visits and what everybody thought of them — the household's own history, and
 * the most irreplaceable thing Roam holds.
 *
 * A provider can be asked again for a rating. Nobody can be asked again what
 * they thought of a meal in 2024, which is why the deletes here are narrow and
 * the writes are all inside transactions the route owns.
 */

import { query } from '../db.js';

const on = (client) => (client ? (text, params) => client.query(text, params) : query);

// ---------------------------------------------------------------------------
// one visit
// ---------------------------------------------------------------------------

export async function visitById(id) {
  const { rows } = await query('select * from visits where id = $1', [id]);
  return rows[0] ?? null;
}

/** Who came, and what each of them said. */
export async function visitDetail(id) {
  const [attendees, takes] = await Promise.all([
    query('select m.id, m.name from visit_attendees va join members m on m.id = va.member_id where va.visit_id = $1 order by m.name', [id]),
    query('select r.*, m.name as member_name from ratings r join members m on m.id = r.member_id where r.visit_id = $1 order by r.created_at', [id]),
  ]);
  return { attendees: attendees.rows, takes: takes.rows };
}

/** Same client id twice must not make two visits (Epic 6 C5). */
export async function visitByClientId(clientId) {
  const { rows } = await query('select id from visits where client_id = $1', [clientId]);
  return rows[0] ?? null;
}

export async function visitIdsAt(householdId, venueRef) {
  const { rows } = await query('select id from visits where household_id = $1 and venue_ref = $2 order by visited_on desc', [householdId, venueRef]);
  return rows;
}

export async function hasVisited(householdId, venueRef) {
  const { rows } = await query('select 1 from visits where household_id = $1 and venue_ref = $2 limit 1', [householdId, venueRef]);
  return rows.length > 0;
}

export async function insertVisit(householdId, v, client) {
  const { rows } = await on(client)(
    `insert into visits (client_id, household_id, trip_id, stop_id, venue_ref, venue_label, category, lat, lng, visited_on, note, country, country_code, locality)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [v.clientId ?? null, householdId, v.tripId ?? null, v.stopId ?? null, v.venueRef, v.venueLabel, v.category ?? null,
      v.lat ?? null, v.lng ?? null, v.visitedOn, v.note ?? null, v.country ?? null, v.countryCode ?? null, v.locality ?? null],
  );
  return rows[0].id;
}

export async function addAttendee(visitId, memberId, client) {
  await on(client)('insert into visit_attendees (visit_id, member_id) values ($1, $2) on conflict do nothing', [visitId, memberId]);
}

export async function updateVisit(id, { note, visitedOn, venueLabel }) {
  await query(
    'update visits set note = coalesce($2, note), visited_on = coalesce($3, visited_on), venue_label = coalesce($4, venue_label) where id = $1',
    [id, note ?? null, visitedOn ?? null, venueLabel ?? null],
  );
}

export async function deleteVisit(id) {
  const { rowCount } = await query('delete from visits where id = $1', [id]);
  return rowCount;
}

// ---------------------------------------------------------------------------
// what each person said
// ---------------------------------------------------------------------------

export async function insertRating(visitId, r, client) {
  await on(client)(
    `insert into ratings (visit_id, member_id, subject, take, comment, concept_key, score)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [visitId, r.memberId, r.subject, r.take, r.comment ?? null, r.conceptKey ?? null, r.score ?? null],
  );
}

/**
 * Clear a visit's takes so they can be written again.
 *
 * Only ever inside the transaction that immediately rewrites them (PUT
 * /api/visits/:id/takes): on its own this would be the one statement here that
 * loses something nobody can give back.
 */
export async function clearRatings(visitId, client) {
  await on(client)('delete from ratings where visit_id = $1', [visitId]);
}

// ---------------------------------------------------------------------------
// the history
// ---------------------------------------------------------------------------

/** The list, filtered by what was asked, with who came and what they said. */
export async function visitsFor(householdId, f = {}, takes = []) {
  const params = [householdId];
  const where = ['v.household_id = $1'];
  if (f.country) { params.push(String(f.country).toUpperCase()); where.push(`v.country_code = $${params.length}`); }
  if (f.q) {
    params.push(`%${String(f.q).toLowerCase()}%`);
    where.push(`(lower(v.venue_label) like $${params.length} or lower(coalesce(v.locality,'')) like $${params.length} or lower(coalesce(v.note,'')) like $${params.length})`);
  }
  if (f.memberId) { params.push(String(f.memberId)); where.push(`exists (select 1 from visit_attendees va where va.visit_id = v.id and va.member_id = $${params.length})`); }
  if (f.take && takes.includes(String(f.take))) {
    params.push(String(f.take));
    where.push(`exists (select 1 from ratings r where r.visit_id = v.id and r.subject = 'visit' and r.take = $${params.length}::take)`);
  }
  const { rows } = await query(
    `select v.*,
            (select json_agg(json_build_object('member', m.name, 'memberId', m.id, 'take', r.take, 'comment', r.comment, 'score', r.score))
               from ratings r join members m on m.id = r.member_id where r.visit_id = v.id and r.subject = 'visit') as visit_takes,
            (select count(*)::int from ratings r where r.visit_id = v.id and r.subject <> 'visit') as item_takes,
            (select json_agg(m.name order by m.name) from visit_attendees va join members m on m.id = va.member_id where va.visit_id = v.id) as attendees
       from visits v
      where ${where.join(' and ')}
      order by v.visited_on desc, v.created_at desc
      limit 500`,
    params,
  );
  return rows;
}

export async function visitCountries(householdId) {
  const { rows } = await query(
    `select country_code, country, count(*)::int as visits from visits
      where household_id = $1 and country_code is not null
      group by country_code, country order by visits desc`,
    [householdId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// saved, dismissed, special
// ---------------------------------------------------------------------------

export async function recordLedger(householdId, source, sourcePlaceId, status, client) {
  await on(client)(
    'insert into place_ledger (household_id, source, source_place_id, status) values ($1, $2, $3, $4)',
    [householdId, source, sourcePlaceId, status],
  );
}

// ---------------------------------------------------------------------------
// odds and ends that belong to a place lookup rather than a visit
// ---------------------------------------------------------------------------

/** Somewhere already in the atlas, matched by name, to rank above a stranger. */
export async function knownPlacesMatching(householdId, q, limit = 4) {
  const { rows } = await query(
    `select hp.venue_ref, hp.label, hp.category, hp.locality, hp.postcode,
            exists (select 1 from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as been
       from household_places hp
      where hp.household_id = $1 and lower(hp.label) like $2
      order by been desc, hp.last_seen desc limit $3`,
    [householdId, `%${String(q).toLowerCase()}%`, limit],
  );
  return rows;
}

/** Remember which country home is in, so the next search does not ask again. */
export async function rememberHomeCountry(householdId, countryCode, country) {
  await query('update households set home_country_code = $2, home_country = $3 where id = $1', [householdId, countryCode, country ?? null]);
}

/**
 * The household's relationship with a set of places, in two statements rather
 * than one per place: how often they went and what they thought, and the latest
 * mark on each (saved, dismissed, special).
 */
export async function statusForRefs(householdId, refs) {
  const [visitRows, ledgerRows] = await Promise.all([
    query(
      `select v.venue_ref, count(*)::int as visits, max(v.visited_on) as last_on,
              count(*) filter (where r.take = 'loved')::int as loved,
              count(*) filter (where r.take = 'not_for_me')::int as not_for_me
         from visits v left join ratings r on r.visit_id = v.id and r.subject = 'visit'
        where v.household_id = $1 and v.venue_ref = any($2)
        group by v.venue_ref`,
      [householdId, refs],
    ),
    query(
      `select distinct on (source, source_place_id) source || ':' || source_place_id as venue_ref, status
         from place_ledger where household_id = $1 and source || ':' || source_place_id = any($2)
        order by source, source_place_id, created_at desc`,
      [householdId, refs],
    ),
  ]);
  return { visitRows: visitRows.rows, ledgerRows: ledgerRows.rows };
}

export async function recordProviderCall(householdId, provider, purpose, units = null) {
  await query('insert into provider_calls (household_id, provider, purpose, units) values ($1, $2, $3, $4)', [householdId, provider, purpose, units]);
}

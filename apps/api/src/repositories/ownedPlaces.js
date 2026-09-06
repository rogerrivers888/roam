/**
 * The owned layer: what Roam has researched for itself about a place, and may
 * keep for good.
 *
 * This is the other half of the rented/owned split (Technical Constraints
 * §13.10). A household act claims a place; the researcher then goes to
 * OpenStreetMap, the venue's own published page and the open encyclopedias, and
 * what it finds lands in `place_facts` and is composed into `place_records`.
 *
 * Two things about these statements are the licence rather than the schema:
 *
 *  - **`place_facts` carries its own terms.** Every row records the licence it
 *    came under and when it expires, so `discardExpiredFacts` can keep the
 *    promise the moment a source with a clock is enabled.
 *  - **A source that answers replaces everything it said before.** A match that
 *    turns out to be wrong has to be able to go away, which it cannot if a
 *    re-check only overwrites the fields it happens to find this time. Silence
 *    is not a correction, so this is only ever called once a source has
 *    actually answered.
 */

import { query } from '../db.js';

// ---------------------------------------------------------------------------
// facts, with their terms
// ---------------------------------------------------------------------------

export async function putFact(venueRef, f) {
  await query(
    `insert into place_facts (venue_ref, field, source, value, licence, retention, confidence, fetched_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7, now(), $8)
     on conflict (venue_ref, field, source) do update set
       value = excluded.value, licence = excluded.licence, retention = excluded.retention,
       confidence = excluded.confidence, fetched_at = now(), expires_at = excluded.expires_at`,
    [venueRef, f.field, f.source, JSON.stringify(f.value), f.licence, f.retention, f.confidence ?? null, f.expiresAt],
  );
}

export function forgetSourceFacts(venueRef, sources) {
  return query('delete from place_facts where venue_ref = $1 and source = any($2)', [venueRef, sources]);
}

export async function liveFacts(venueRef) {
  const { rows } = await query(
    'select field, source, value, confidence from place_facts where venue_ref = $1 and expires_at is null',
    [venueRef],
  );
  return rows;
}

/** Throw away every fact whose licence says its time is up. */
export async function discardExpiredFacts() {
  const { rows } = await query('delete from place_facts where expires_at is not null and expires_at <= now() returning venue_ref');
  return rows.map((r) => r.venue_ref);
}

// ---------------------------------------------------------------------------
// the composed record
// ---------------------------------------------------------------------------

export async function ensureRecord(venueRef) {
  await query('insert into place_records (venue_ref) values ($1) on conflict do nothing', [venueRef]);
}

export async function recordFor(venueRef) {
  const { rows } = await query('select * from place_records where venue_ref = $1', [venueRef]);
  return rows[0] ?? null;
}

export async function recordsFor(refs) {
  const { rows } = await query('select * from place_records where venue_ref = any($1)', [refs]);
  return rows;
}

export async function enrichStateOf(venueRef) {
  const { rows } = await query(
    'select enrich_state, enriched_at, provenance, research_version, matched from place_records where venue_ref = $1',
    [venueRef],
  );
  return rows[0] ?? null;
}

export async function knownCategory(venueRef) {
  const { rows } = await query('select category, website, address from place_records where venue_ref = $1', [venueRef]);
  return rows[0] ?? {};
}

/**
 * Write the composed record.
 *
 * The columns are assembled from the caller's precedence table rather than
 * written out, because which fields exist is that table's business and one list
 * is easier to keep right than two.
 */
export async function writeRecord(venueRef, columns, values, attribution, provenance) {
  const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await query(
    `update place_records set ${sets},
       attribution = $${columns.length + 2}, provenance = $${columns.length + 3}, updated_at = now()
     where venue_ref = $1`,
    [venueRef, ...values, JSON.stringify(attribution), JSON.stringify(provenance)],
  );
}

export async function recordAttempt(venueRef, a) {
  const { rows } = await query(
    `update place_records set
       enrich_state = $2, enriched_at = now(), enrich_attempts = enrich_attempts + 1,
       enrich_error = $3, matched = $4, research_version = $5, updated_at = now()
     where venue_ref = $1 returning enrich_attempts`,
    [venueRef, a.state, a.error ?? null, JSON.stringify(a.matched), a.researchVersion],
  );
  return rows[0]?.enrich_attempts ?? 1;
}

export async function scheduleRetry(venueRef, at) {
  await query('update place_records set next_attempt_at = $2 where venue_ref = $1', [venueRef, at]);
}

// ---------------------------------------------------------------------------
// what to describe, and what has been claimed
// ---------------------------------------------------------------------------

/**
 * The rented record read as a description of what to look for in the open
 * world: a name and a point. Nothing from it is stored.
 */
export async function seedFromHousehold(venueRef) {
  const { rows } = await query(
    `select label, category, lat, lng, venue, locality from household_places
      where venue_ref = $1 and lat is not null order by last_seen desc limit 1`,
    [venueRef],
  );
  return rows[0] ?? null;
}

export async function seedFromShortlist(venueRef) {
  const { rows } = await query(
    `select venue_label as label, category, lat, lng, venue from trip_shortlist
      where venue_ref = $1 and lat is not null order by added_at desc limit 1`,
    [venueRef],
  );
  return rows[0] ?? null;
}

/** A household act claiming a place, and the record it starts. */
export async function claim(householdId, venueRef, reason) {
  await query('insert into place_claims (household_id, venue_ref, reason) values ($1,$2,$3) on conflict do nothing', [householdId, venueRef, reason]);
  await ensureRecord(venueRef);
}

/** Has any household actually asked for this place, or is it only swept? */
export async function isClaimed(venueRef) {
  const { rows } = await query('select 1 from place_claims where venue_ref = $1 limit 1', [venueRef]);
  return rows.length > 0;
}

/**
 * Places claimed but never researched, or due to be tried again.
 *
 * Three kinds of second chance are in here on purpose: one written off by an
 * earlier build that called a place done the first time it found nothing, one
 * whose backoff has come round, and one made by an older researcher than the
 * one running now.
 */
export async function dueForResearch(limit, maxAttempts, researchVersion) {
  const { rows } = await query(
    `select venue_ref from place_records
      where enrich_state = 'pending'
         or (enrich_state in ('failed', 'partial') and next_attempt_at is not null and next_attempt_at <= now())
         or (enrich_state = 'done' and provenance = '{}'::jsonb and enrich_attempts < $2)
         or research_version < $3
      order by research_version, enrich_attempts, first_owned limit $1`,
    [limit, maxAttempts, researchVersion],
  );
  return rows.map((r) => r.venue_ref);
}

/** How much of the household's research is owned, for Settings and the offline card. */
export async function summaryFor(householdId, behindVersion = 3) {
  const { rows } = await query(
    `select count(*)::int as claimed,
            count(*) filter (where r.enrich_state = 'done')::int as researched,
            count(*) filter (where r.osm_ref is not null)::int as in_open_map,
            count(*) filter (where r.summary is not null)::int as described,
            count(*) filter (where r.enrich_state in ('pending', 'partial'))::int as waiting,
            count(*) filter (where r.enrich_state = 'failed')::int as failed,
            count(*) filter (where r.research_version < $2)::int as behind,
            max(r.updated_at) as last_change
       from (select distinct venue_ref from place_claims where household_id = $1) c
       join place_records r on r.venue_ref = c.venue_ref`,
    [householdId, behindVersion],
  );
  return rows[0] ?? null;
}

/**
 * Every place we own within a radius of a point, nearest first.
 *
 * This is what makes Find survive a bad afternoon (owner, 5 Sep 2026: "surely
 * you could just leave the placeholders that I saw there so that they're
 * always available, because the moment it is completely empty"). When
 * OpenStreetMap times out and Google has spent its daily quota, the live sweep
 * comes back with nothing but event listings and the two tiles a family
 * actually opens read zero.
 *
 * Nothing licensed is reached for here. `place_records` is the owned layer by
 * construction — researched from the open map, the venue's own page and the
 * open encyclopedias — so serving it when the rented sources are down breaks
 * no terms and needs no expiry. It is also small: these are only the places
 * this household has already claimed.
 */
export async function ownedNear(householdId, lat, lng, radiusKm, limit = 60) {
  const { rows } = await query(
    `select * from (
       select r.*,
              (select count(*)::int from visits v where v.household_id = $1 and v.venue_ref = r.venue_ref) as visits,
              6371 * acos(least(1, greatest(-1,
                sin(radians($2)) * sin(radians(r.lat)) +
                cos(radians($2)) * cos(radians(r.lat)) * cos(radians(r.lng) - radians($3))))) as km
         from place_records r
         join household_places hp on hp.venue_ref = r.venue_ref and hp.household_id = $1
        where r.lat is not null and r.lng is not null and r.name is not null
     ) near
      where km <= $4
      order by km
      limit $5`,
    [householdId, lat, lng, radiusKm, limit],
  );
  return rows;
}

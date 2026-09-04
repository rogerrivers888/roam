/**
 * The evidence a source is earning its place.
 *
 * Every venue Roam shows is recorded against the source that supplied it, and
 * every one the household then acts on is marked selected. Without it there is
 * never evidence to drop a source (Technical Constraints §2), which is the
 * whole reason the table exists.
 *
 * Identifiers only — never a name, never a rating. What was shown is a fact
 * about us; what it was called is the provider's.
 */

import { query } from '../db.js';

/** Places already shown or turned down, so "somewhere different" means it. */
export async function seenRefs(householdId) {
  const { rows } = await query(
    `select source, source_place_id from place_ledger
      where household_id = $1 and status in ('shown', 'dismissed')`,
    [householdId],
  );
  return rows.map((r) => `${r.source}:${r.source_place_id}`);
}

/**
 * Record one search's worth of impressions, and mark the same places shown.
 *
 * Written as two statements over arrays rather than one per venue: a search
 * returns a hundred and forty places, and a hundred and forty round trips is a
 * visible pause on the answer the household is waiting for.
 */
export async function recordImpressions(householdId, queryId, candidates) {
  if (!candidates.length) return;
  await query(
    `insert into source_impressions (household_id, query_id, source, source_place_id, resolved_venue_key)
     select $1, $2, source, source_place_id, venue_key
       from unnest($3::text[], $4::text[], $5::text[]) as t(source, source_place_id, venue_key)`,
    [householdId, queryId, candidates.map((c) => c.source), candidates.map((c) => c.sourcePlaceId), candidates.map((c) => c.key)],
  );
  await query(
    `insert into place_ledger (household_id, source, source_place_id, status)
     select $1, source, source_place_id, 'shown'
       from unnest($2::text[], $3::text[]) as t(source, source_place_id)`,
    [householdId, candidates.map((c) => c.source), candidates.map((c) => c.sourcePlaceId)],
  );
}

/** Mark what the household chose out of one search. */
export async function markSelected(queryId, venueKey) {
  const { rows } = await query(
    `update source_impressions set selected = true
      where query_id = $1 and resolved_venue_key = $2
      returning source, source_place_id`,
    [queryId, venueKey],
  );
  return rows;
}

/** Shown against chosen, per source: which ones are worth what they cost. */
export async function sourceValue() {
  const { rows } = await query(
    `select source,
            count(*)                         as impressions,
            count(*) filter (where selected) as selections
       from source_impressions
      group by source
      order by selections desc, impressions desc`,
  );
  return rows;
}

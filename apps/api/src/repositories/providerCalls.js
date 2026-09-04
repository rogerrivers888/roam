/**
 * The spend ledger: every outbound call Roam has made, what it was for, and
 * what it is estimated to have cost.
 *
 * Technical Constraints §2 — every provider call is attributed to a household
 * and a session, from the first day, "without it there is never evidence to
 * drop a source". So this table is written on the way out of every integration,
 * and read by the caps that stop one running away with the owner's money.
 *
 * Nothing here holds a provider's *content*: a row is a provider, a purpose, a
 * count and a cost.
 */

import { query } from '../db.js';

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** One call, with whatever units the provider counts in. */
export async function record(householdId, provider, purpose, units = null, sessionId = null) {
  await query(
    'insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)',
    [householdId, sessionId, provider, purpose, units],
  );
}

/** One Claude call, billed in tokens rather than requests. */
export async function recordTokens(c) {
  await query(
    `insert into provider_calls
       (household_id, session_id, provider, purpose, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, estimated_cost_usd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.householdId, c.sessionId, c.provider, c.purpose, c.inputTokens ?? null, c.outputTokens ?? null,
      c.cacheReadTokens ?? null, c.cacheWriteTokens ?? null, c.costUsd],
  );
}

// ---------------------------------------------------------------------------
// the caps
// ---------------------------------------------------------------------------

export async function countForSession(sessionId) {
  const { rows } = await query('select count(*)::int as n from provider_calls where session_id = $1', [sessionId]);
  return rows[0].n;
}

export async function countThisMonth(householdId) {
  const { rows } = await query(
    `select count(*)::int as n from provider_calls
      where household_id = $1 and created_at >= date_trunc('month', now())`,
    [householdId],
  );
  return rows[0].n;
}

/**
 * How many times one purpose has run in a window.
 *
 * The window is named rather than passed as a date so that every cap is judged
 * against the database's clock, the same one the allowances use — a cap that
 * disagreed with the figure shown beside it would be worse than no cap.
 */
export async function countOfPurpose(householdId, provider, purposeLike, window = 'month') {
  const since = window === 'day' ? "date_trunc('day', now())" : "date_trunc('month', now())";
  const { rows } = await query(
    `select count(*)::int as n from provider_calls
      where household_id = $1 and provider = $2 and purpose like $3 and created_at >= ${since}`,
    [householdId, provider, purposeLike],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// what it has all cost
// ---------------------------------------------------------------------------

/** Cost and call counts for one session, and for the household this month. */
export async function summary(householdId, sessionId) {
  const { rows } = await query(
    `select
       count(*) filter (where session_id = $2)::int                                   as session_calls,
       coalesce(sum(estimated_cost_usd) filter (where session_id = $2), 0)::float      as session_cost_usd,
       count(*) filter (where created_at >= date_trunc('month', now()))::int          as month_calls,
       coalesce(sum(estimated_cost_usd) filter (where created_at >= date_trunc('month', now())), 0)::float as month_cost_usd
     from provider_calls where household_id = $1`,
    [householdId, sessionId],
  );
  return rows[0];
}

/**
 * Calls in a window, split by the unit each provider counts in.
 *
 * A row written with `units` as an object is a provider that told us what it
 * billed for; the lateral join turns each key into its own line, so "Google
 * Places" and "Google Routes elements" are counted separately even though they
 * arrived on the same row.
 */
export async function meteredUnits(householdId, from, to) {
  const { rows } = await query(
    `select k.key, count(*)::int as calls, coalesce(sum(k.value::numeric), 0)::float as units
       from provider_calls pc
       cross join lateral jsonb_each_text(case when jsonb_typeof(pc.units) = 'object' then pc.units else '{}'::jsonb end) k
      where pc.household_id = $1 and pc.created_at >= $2 and pc.created_at < $3
      group by k.key`,
    [householdId, from, to],
  );
  return rows;
}

/** The same window by provider and purpose, for rows written before units existed. */
export async function callsByPurpose(householdId, from, to) {
  const { rows } = await query(
    `select provider, purpose, (units is null or jsonb_typeof(units) <> 'object') as legacy,
            count(*)::int as calls, coalesce(sum(estimated_cost_usd), 0)::float as cost_usd,
            coalesce(sum(case when jsonb_typeof(units) = 'number' then (units #>> '{}')::numeric end), 0)::float as num_units
       from provider_calls where household_id = $1 and created_at >= $2 and created_at < $3
      group by provider, purpose, (units is null or jsonb_typeof(units) <> 'object')`,
    [householdId, from, to],
  );
  return rows;
}

/**
 * The calendar windows allowances live in, read from the database clock.
 *
 * Deliberately not `new Date()`: the caps' own statements use `now()`, and a
 * month boundary that disagreed by a few hours would show a household an
 * allowance that had reset when it had not.
 */
export async function windows() {
  const { rows } = await query(
    `select date_trunc('month', now()) as month_start,
            date_trunc('month', now()) - interval '1 month' as last_month_start,
            date_trunc('month', now()) + interval '1 month' as next_month_start,
            date_trunc('day', now()) as today_start,
            date_trunc('day', now()) + interval '1 day' as tomorrow_start,
            now() as now`,
  );
  return rows[0];
}

/** The same two reads again, grouped by month, for the spend chart. */
export async function meteredUnitsByMonth(householdId, since) {
  const { rows } = await query(
    `select to_char(date_trunc('month', pc.created_at), 'YYYY-MM') as month, k.key,
            count(*)::int as calls, coalesce(sum(k.value::numeric), 0)::float as units
       from provider_calls pc
       cross join lateral jsonb_each_text(case when jsonb_typeof(pc.units) = 'object' then pc.units else '{}'::jsonb end) k
      where pc.household_id = $1 and pc.created_at >= $2
      group by 1, 2`,
    [householdId, since],
  );
  return rows;
}

export async function callsByPurposeByMonth(householdId, since) {
  const { rows } = await query(
    `select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, provider, purpose,
            (units is null or jsonb_typeof(units) <> 'object') as legacy,
            count(*)::int as calls, coalesce(sum(estimated_cost_usd), 0)::float as cost_usd,
            coalesce(sum(case when jsonb_typeof(units) = 'number' then (units #>> '{}')::numeric end), 0)::float as num_units
       from provider_calls where household_id = $1 and created_at >= $2
      group by 1, 2, 3, 4`,
    [householdId, since],
  );
  return rows;
}

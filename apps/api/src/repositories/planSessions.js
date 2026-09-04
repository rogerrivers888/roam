/**
 * Planning sessions, and throwing them away when their time is up.
 *
 * A session's `state` holds the ideas a search produced — and those carry the
 * provider's venue names, ratings and photo references. Migration 026 gave a
 * session ten hours for exactly that reason: "it is licensed content held on
 * our side, so shorter is the better direction to be wrong in."
 *
 * Nothing ever deleted them. `expires_at` was only read in a `where` clause, so
 * every row ever created was still sitting there with a provider's content in
 * it, hours or months past the licence. This is the sweep that was missing.
 */

import { query } from '../db.js';

/**
 * Delete sessions whose time is up.
 *
 * A grace hour, so a household that comes back a minute after expiry gets the
 * honest "this has expired" from the route rather than a row that vanished
 * mid-request.
 */
export async function sweepExpiredPlanSessions() {
  const { rowCount } = await query("delete from plan_sessions where expires_at < now() - interval '1 hour'");
  return rowCount;
}

/** A new session, with whatever state its route wants to hang on it. */
export async function insertPlanSession(householdId, state, tripId = null) {
  const { rows } = await query(
    'insert into plan_sessions (household_id, state, trip_id) values ($1, $2, $3) returning *',
    [householdId, JSON.stringify(state), tripId],
  );
  return rows[0];
}

/** A live session, by id. An expired one is not found rather than returned stale. */
export async function livePlanSession(id) {
  const { rows } = await query('select * from plan_sessions where id = $1 and expires_at > now()', [id]);
  return rows[0] ?? null;
}

export async function savePlanState(id, state, tripId) {
  if (tripId === undefined) {
    await query('update plan_sessions set state = $2 where id = $1', [id, JSON.stringify(state)]);
    return;
  }
  await query('update plan_sessions set state = $2, trip_id = coalesce($3, trip_id) where id = $1', [id, JSON.stringify(state), tripId]);
}

/** The session a trip's day was last planned in, so "come back to it" can. */
export async function planSessionForDay(householdId, tripId, dayId) {
  const { rows } = await query(
    `select * from plan_sessions
      where household_id = $1 and trip_id = $2 and state->>'dayId' = $3 and expires_at > now()
      order by updated_at desc limit 1`,
    [householdId, tripId, dayId],
  );
  return rows[0] ?? null;
}

/** What one session's searches cost, attributed to the session that spent it. */
export async function recordSessionCall(householdId, sessionId, provider, purpose, units = null) {
  await query(
    'insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)',
    [householdId, sessionId, provider, purpose, units],
  );
}

/**
 * A session by its short reference — the eight characters a run is quoted by.
 *
 * Matched as a prefix of the id with the dashes taken out, because that is the
 * form the number is shown in. Not expiry-filtered: "no run here begins that"
 * and "that run has expired" are different answers and the route says which.
 */
export async function planSessionByRef(householdId, ref) {
  const { rows } = await query(
    `select id, trip_id, created_at, updated_at, state from plan_sessions
      where household_id = $1 and replace(id::text, '-', '') like $2 || '%'
      order by created_at desc limit 1`,
    [householdId, ref],
  );
  return rows[0] ?? null;
}

/** Every provider call one run made, in order, for the run's own receipt. */
export async function callsOfSession(sessionId) {
  const { rows } = await query(
    `select provider, purpose, units, estimated_cost_usd, created_at from provider_calls
      where session_id = $1 order by created_at`,
    [sessionId],
  );
  return rows;
}

/** What every planning session for one trip has cost so far. */
export async function spendOnTrip(tripId) {
  const { rows } = await query(
    `select count(pc.*)::int as trip_calls, coalesce(sum(pc.estimated_cost_usd), 0)::float as trip_cost_usd
       from provider_calls pc join plan_sessions ps on ps.id = pc.session_id where ps.trip_id = $1`,
    [tripId],
  );
  return rows[0];
}

/** What the household has spent since a moment, for the run's own budget. */
export async function spentSince(householdId, since) {
  const { rows } = await query(
    'select coalesce(sum(estimated_cost_usd), 0)::float as usd from provider_calls where household_id = $1 and created_at >= $2',
    [householdId, since],
  );
  return rows[0].usd;
}

/**
 * Mark every run that was in flight as interrupted.
 *
 * Called once on start-up. A deploy lands every few minutes while several
 * sessions are working, and a run killed mid-flight would otherwise sit saying
 * "running" until it expired — so the screen is told at once and retries.
 */
export async function markRunsInterrupted() {
  const { rowCount } = await query(
    `update plan_sessions
        set state = state || '{"running": false, "outcome": {"kind": "error", "message": "the plan was interrupted by a restart"}}'::jsonb
      where state->>'running' = 'true'`,
  );
  return rowCount;
}

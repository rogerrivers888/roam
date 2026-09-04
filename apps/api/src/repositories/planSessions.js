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

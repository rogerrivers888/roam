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

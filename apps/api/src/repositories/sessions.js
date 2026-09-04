/**
 * Every statement about `api_sessions`, and the only file that holds one.
 *
 * The estate's engineering standard is that all SQL lives in `repositories/`
 * and none anywhere else. Roam does not meet that yet — there are 360 query
 * sites across the routes — but the door is new code, so it starts in the right
 * place rather than adding to the pile the extraction will have to move.
 */

import crypto from 'node:crypto';
import { query } from '../db.js';

/** Only ever the hash. A stolen backup must not be a stolen session. */
const digest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** How stale `last_seen_at` may get before a read is worth a write. */
const SEEN_EVERY = '5 minutes';

export async function insertSession(token, label, accountId = null) {
  const { rows } = await query(
    `insert into api_sessions (token_hash, label, account_id) values ($1, $2, $3)
     returning id, label, account_id, created_at, expires_at`,
    [digest(token), label || null, accountId],
  );
  return rows[0];
}

/** The live session this token opens, or null. Never says which of the two it failed. */
export async function findLiveSession(token) {
  const { rows } = await query(
    `select id, label, account_id, created_at, last_seen_at, expires_at
       from api_sessions
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [digest(token)],
  );
  return rows[0] ?? null;
}

/**
 * Mark a session as used. Fire-and-forget and deliberately lazy: "when were you
 * last here" is a line on a settings card, not something worth a write on every
 * request the family makes.
 */
export function touchSession(id) {
  return query(
    `update api_sessions set last_seen_at = now()
      where id = $1 and last_seen_at < now() - interval '${SEEN_EVERY}'`,
    [id],
  ).catch(() => null);
}

export function revokeSession(token) {
  return query('update api_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [digest(token)]);
}

/**
 * Sign every device out — the answer to a passcode that has been shared too
 * widely. Given an account, only that account's devices: one customer signing
 * out everywhere must not sign the whole estate out.
 */
export function revokeAllSessions(accountId = null) {
  return query(
    `update api_sessions set revoked_at = now()
      where revoked_at is null and ($1::uuid is null or account_id = $1)`,
    [accountId],
  );
}

/**
 * The devices signed in, newest first, for Settings. Never the tokens.
 *
 * Scoped to one account once accounts exist: a customer's Settings screen shows
 * their own devices and has no way to learn that anybody else's exist. Passing
 * nothing keeps the old behaviour — every device — which is what the shared
 * passcode (the owner, no account row) still wants.
 */
export async function liveSessions(accountId = null) {
  const { rows } = await query(
    `select id, label, account_id, created_at, last_seen_at, expires_at
       from api_sessions
      where revoked_at is null and expires_at > now()
        and ($1::uuid is null or account_id = $1)
      order by last_seen_at desc`,
    [accountId],
  );
  return rows;
}

/**
 * Throw away what has already lapsed. A revoked or expired row is a hash and a
 * date and holds nothing about anybody, but it is not needed either.
 */
export function sweepDeadSessions() {
  return query(`delete from api_sessions where (expires_at < now() - interval '30 days') or (revoked_at < now() - interval '30 days')`);
}

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

export async function insertSession(token, label) {
  const { rows } = await query(
    `insert into api_sessions (token_hash, label) values ($1, $2)
     returning id, label, created_at, expires_at`,
    [digest(token), label || null],
  );
  return rows[0];
}

/** The live session this token opens, or null. Never says which of the two it failed. */
export async function findLiveSession(token) {
  const { rows } = await query(
    `select id, label, created_at, last_seen_at, expires_at
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

/** Sign every device out — the answer to a passcode that has been shared too widely. */
export function revokeAllSessions() {
  return query('update api_sessions set revoked_at = now() where revoked_at is null');
}

/** The devices signed in, newest first, for Settings. Never the tokens. */
export async function liveSessions() {
  const { rows } = await query(
    `select id, label, created_at, last_seen_at, expires_at
       from api_sessions
      where revoked_at is null and expires_at > now()
      order by last_seen_at desc`,
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

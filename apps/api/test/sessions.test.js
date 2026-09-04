/**
 * The session store: the thing standing between a stolen backup and a stolen
 * session, and between an old token and a way back in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { testDatabase } from './helpers/db.js';

const { query, pool } = await testDatabase();
const { findLiveSession, insertSession, liveSessions, revokeAllSessions, revokeSession, sweepDeadSessions, touchSession } =
  await import('../src/repositories/sessions.js');

const aToken = () => crypto.randomBytes(32).toString('base64url');

test.after(() => pool.end());

test('a token opens the session it made and nothing else', async () => {
  const token = aToken();
  const made = await insertSession(token, 'a test device');
  const found = await findLiveSession(token);
  assert.equal(found.id, made.id);
  assert.equal(found.label, 'a test device');
  assert.equal(await findLiveSession(aToken()), null, 'another token opens nothing');
  assert.equal(await findLiveSession(''), null);
});

test('the token itself is never written down', async () => {
  const token = aToken();
  await insertSession(token, 'secret-keeper');
  const { rows } = await query('select token_hash from api_sessions where label = $1', ['secret-keeper']);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token, 'the row must not hold the token');
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  // And nothing anywhere in the table equals the token, under any column.
  const all = await query('select * from api_sessions');
  for (const row of all.rows) {
    for (const value of Object.values(row)) {
      assert.notEqual(String(value), token);
    }
  }
});

test('an expired session is not a session', async () => {
  const token = aToken();
  const made = await insertSession(token, 'the old one');
  await query("update api_sessions set expires_at = now() - interval '1 second' where id = $1", [made.id]);
  assert.equal(await findLiveSession(token), null);
});

test('signing out closes that door and leaves the others open', async () => {
  const mine = aToken();
  const theirs = aToken();
  await insertSession(mine, 'this device');
  await insertSession(theirs, 'the other device');

  await revokeSession(mine);
  assert.equal(await findLiveSession(mine), null);
  assert.ok(await findLiveSession(theirs), 'the other device is still signed in');
});

test('signing out everywhere closes all of them', async () => {
  const a = aToken();
  const b = aToken();
  await insertSession(a, 'a');
  await insertSession(b, 'b');
  await revokeAllSessions();
  assert.equal(await findLiveSession(a), null);
  assert.equal(await findLiveSession(b), null);
  assert.deepEqual(await liveSessions(), [], 'and Settings shows none');
});

test('last-seen is lazy, and only ever moves forward', async () => {
  const token = aToken();
  const made = await insertSession(token, 'lazy');

  await touchSession(made.id);
  const fresh = await query('select last_seen_at from api_sessions where id = $1', [made.id]);
  assert.equal(fresh.rows[0].last_seen_at.getTime(), made.created_at.getTime(), 'a read a moment later is not worth a write');

  await query("update api_sessions set last_seen_at = now() - interval '1 hour' where id = $1", [made.id]);
  await touchSession(made.id);
  const moved = await query('select last_seen_at from api_sessions where id = $1', [made.id]);
  assert.ok(moved.rows[0].last_seen_at.getTime() > made.created_at.getTime() - 3600_000, 'an hour later it is');
});

test('the sweep takes only what is long dead', async () => {
  await query('delete from api_sessions');
  const live = aToken();
  await insertSession(live, 'still here');

  const stale = await insertSession(aToken(), 'expired months ago');
  await query("update api_sessions set expires_at = now() - interval '60 days' where id = $1", [stale.id]);

  const recent = await insertSession(aToken(), 'expired yesterday');
  await query("update api_sessions set expires_at = now() - interval '1 day' where id = $1", [recent.id]);

  await sweepDeadSessions();
  const { rows } = await query('select label from api_sessions order by label');
  assert.deepEqual(rows.map((r) => r.label), ['expired yesterday', 'still here'], 'only the long-dead row went');
});

test('expired planning sessions are actually deleted', async () => {
  // They hold the provider's venue names and ratings, and migration 026 gave
  // them ten hours for that reason. Nothing swept them until now.
  const { sweepExpiredPlanSessions } = await import('../src/repositories/planSessions.js');
  const { rows: [household] } = await query('insert into households (name) values ($1) returning *', ['plan sweeper']);

  const { rows: [live] } = await query(
    `insert into plan_sessions (household_id, state) values ($1, '{}'::jsonb) returning *`, [household.id]);
  const { rows: [old] } = await query(
    `insert into plan_sessions (household_id, state, expires_at) values ($1, '{}'::jsonb, now() - interval '2 hours') returning *`, [household.id]);
  const { rows: [justExpired] } = await query(
    `insert into plan_sessions (household_id, state, expires_at) values ($1, '{}'::jsonb, now() - interval '1 minute') returning *`, [household.id]);

  await sweepExpiredPlanSessions();
  const { rows } = await query('select id from plan_sessions where household_id = $1', [household.id]);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(live.id), 'a live session stays');
  assert.ok(ids.includes(justExpired.id), 'a grace hour, so nothing vanishes mid-request');
  assert.ok(!ids.includes(old.id), 'one that expired two hours ago is gone');
});

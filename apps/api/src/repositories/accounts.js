/**
 * Every statement about `accounts`, `sign_in_links` and `account_sign_ins`.
 *
 * Same standard as `sessions.js`: the door is new code, so its SQL starts in
 * `repositories/` rather than adding to the 360 query sites the extraction will
 * one day have to move.
 *
 * A link is hashed with the same one-way function a session token is. The
 * plain-text link exists for exactly as long as it takes to put it in an e-mail
 * or hand it to the owner to copy; after that only its digest is anywhere.
 */

import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';

const digest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Lowercased, trimmed: one person is one account however they type it. */
export const normaliseEmail = (email) => String(email ?? '').trim().toLowerCase();

// A deliberately plain shape — the routes decide what the owner sees and what
// an account holder sees, and neither is served a database row directly.
const COLUMNS = `id, household_id, email, name, role, role_id, status, plan, trial_ends_on,
                 monthly_call_bound, note, invited_at, activated_at, last_seen_at,
                 sign_in_count, created_at, updated_at`;

export async function accountById(id) {
  const { rows } = await query(`select ${COLUMNS} from accounts where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function accountByEmail(email) {
  const { rows } = await query(`select ${COLUMNS} from accounts where lower(email) = $1`, [normaliseEmail(email)]);
  return rows[0] ?? null;
}

export async function ownerAccount() {
  const { rows } = await query(`select ${COLUMNS} from accounts where role = 'owner'`);
  return rows[0] ?? null;
}

/**
 * Every account with the numbers the admin screen asks for.
 *
 * The usage figures are counted from `provider_calls`, which is Roam's own
 * record of Roam's own spending — nothing rented, nothing about a place. Two
 * windows, because "how much are they costing me" and "how much have they ever
 * cost me" are different questions: this calendar month, and all time.
 */
export async function listAccounts() {
  const { rows } = await query(
    `select a.id, a.household_id, a.email, a.name, a.role, a.role_id, a.status, a.plan, a.trial_ends_on,
            a.monthly_call_bound, a.note, a.invited_at, a.activated_at, a.last_seen_at,
            a.sign_in_count, a.created_at, a.updated_at,
            h.name as household_name,
            (select count(*)::int from members m where m.household_id = a.household_id) as member_count,
            (select count(*)::int from trips t where t.household_id = a.household_id) as trip_count,
            coalesce(month.calls, 0)     as calls_month,
            coalesce(month.cost, 0)      as cost_month,
            coalesce(ever.calls, 0)      as calls_ever,
            coalesce(ever.cost, 0)       as cost_ever,
            live.devices                 as live_devices
       from accounts a
       join households h on h.id = a.household_id
       left join lateral (
         select count(*)::int as calls, coalesce(sum(estimated_cost_usd), 0)::float as cost
           from provider_calls p
          where p.household_id = a.household_id and p.created_at >= date_trunc('month', now())
       ) month on true
       left join lateral (
         select count(*)::int as calls, coalesce(sum(estimated_cost_usd), 0)::float as cost
           from provider_calls p where p.household_id = a.household_id
       ) ever on true
       left join lateral (
         select count(*)::int as devices from api_sessions s
          where s.account_id = a.id and s.revoked_at is null and s.expires_at > now()
       ) live on true
      order by (a.role = 'owner') desc, a.created_at`,
  );
  return rows;
}

/**
 * A new account and the household it owns, in one transaction.
 *
 * The household is created here rather than reusing the founding one: an
 * account that shared a household would see the owner's home address, his
 * children's birthdays and every rating the family has given — which is the
 * failure the door was built to prevent, arriving by a different route.
 */
export async function createAccount({ email, name, plan, trialEndsOn, monthlyCallBound, note, role = 'customer', householdName }) {
  return withTransaction(async (client) => {
    const { rows: households } = await client.query(
      'insert into households (name) values ($1) returning id',
      [householdName || name || normaliseEmail(email)],
    );
    const { rows } = await client.query(
      `insert into accounts (household_id, email, name, role, plan, trial_ends_on, monthly_call_bound, note, invited_at)
       values ($1, $2, $3, $4, coalesce($5, 'trial'), $6, $7, $8, now())
       returning ${COLUMNS}`,
      [households[0].id, normaliseEmail(email), name || null, role, plan || null, trialEndsOn || null, monthlyCallBound ?? null, note || null],
    );
    return rows[0];
  });
}

/**
 * An account on a household that already exists.
 *
 * One caller: the owner claiming the founding household, so he appears in his
 * own list with his own usage. Everybody else gets a household of their own
 * through `createAccount`.
 */
export async function createAccountOnHousehold(householdId, { email, name, role = 'owner', plan = 'owner' }) {
  const { rows } = await query(
    `insert into accounts (household_id, email, name, role, plan, invited_at)
     values ($1, $2, $3, $4, $5, now())
     returning ${COLUMNS}`,
    [householdId, normaliseEmail(email), name || null, role, plan],
  );
  return rows[0];
}

/** Only the fields the admin screen can actually change; anything else is ignored. */
export async function updateAccount(id, patch) {
  const allowed = {
    name: patch.name,
    plan: patch.plan,
    status: patch.status,
    trial_ends_on: patch.trialEndsOn,
    monthly_call_bound: patch.monthlyCallBound,
    note: patch.note,
  };
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(allowed)) {
    if (value === undefined) continue;
    values.push(value === '' ? null : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return accountById(id);
  values.push(id);
  const { rows } = await query(
    `update accounts set ${sets.join(', ')}, updated_at = now() where id = $${values.length} returning ${COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
}

/**
 * Take the account away. Their household — every place, trip and rating in it —
 * is only removed when the caller says so in as many words, because the two are
 * different acts and one of them cannot be undone.
 */
export async function deleteAccount(id, { withHousehold = false } = {}) {
  const account = await accountById(id);
  if (!account) return null;
  if (withHousehold) {
    // accounts.household_id cascades, so the account goes with it.
    await query('delete from households where id = $1', [account.household_id]);
  } else {
    await query('delete from accounts where id = $1', [id]);
  }
  return account;
}

/**
 * The monthly ceiling on provider calls in force for a household, or null when
 * nobody has set one and the estate default applies.
 *
 * Read on every call that spends money (claude.js), which is why it is one
 * indexed lookup and returns a number rather than a row.
 */
export async function callBoundFor(householdId) {
  const { rows } = await query('select monthly_call_bound from accounts where household_id = $1 limit 1', [householdId]);
  return rows[0]?.monthly_call_bound ?? null;
}

/** Sign every one of their devices out — suspending, or handing the seat to somebody else. */
export function revokeAccountSessions(accountId) {
  return query('update api_sessions set revoked_at = now() where account_id = $1 and revoked_at is null', [accountId]);
}

// ---------------------------------------------------------------------------
// signing in
// ---------------------------------------------------------------------------

/** A link, returned in full once. What is stored is the digest and nothing else. */
export async function createSignInLink(accountId, { requestedBy = 'owner', ttlHours = 24 * 7 } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await query(
    `insert into sign_in_links (account_id, token_hash, expires_at, requested_by)
     values ($1, $2, now() + ($3 || ' hours')::interval, $4)
     returning id, account_id, expires_at, created_at`,
    [accountId, digest(token), String(ttlHours), requestedBy],
  );
  return { token, link: rows[0] };
}

/**
 * Redeem a link, once.
 *
 * The update is the check: `used_at is null` in the WHERE means two requests
 * racing on the same link cannot both come back with a row, so a forwarded link
 * that somebody else opened first is simply spent. A suspended account's link
 * does not open anything either.
 */
export async function consumeSignInLink(token) {
  const { rows } = await query(
    `update sign_in_links l
        set used_at = now()
       from accounts a
      where l.token_hash = $1
        and l.account_id = a.id
        and l.used_at is null
        and l.expires_at > now()
        and a.status <> 'suspended'
      returning l.id, l.account_id`,
    [digest(token)],
  );
  return rows[0] ?? null;
}

export function markLinkSent(id, { delivery, error = null }) {
  return query(
    `update sign_in_links set delivery = $2, delivery_error = $3, sent_at = case when $2 = 'email' then now() else sent_at end
      where id = $1`,
    [id, delivery, error],
  );
}

/** The most recent link for an account, so the admin screen can say what happened to it. */
export async function lastLinkFor(accountId) {
  const { rows } = await query(
    `select id, expires_at, used_at, delivery, delivery_error, sent_at, created_at, requested_by
       from sign_in_links where account_id = $1 order by created_at desc limit 1`,
    [accountId],
  );
  return rows[0] ?? null;
}

/**
 * Somebody signed in. Written as one statement so the counter and the date
 * cannot drift apart, and the first one is also the moment 'invited' becomes
 * 'active'.
 */
export async function recordSignIn(accountId, { method = 'link', label = null } = {}) {
  await query('insert into account_sign_ins (account_id, method, label) values ($1, $2, $3)', [accountId, method, label]);
  const { rows } = await query(
    `update accounts
        set sign_in_count = sign_in_count + 1,
            last_seen_at  = now(),
            activated_at  = coalesce(activated_at, now()),
            status        = case when status = 'invited' then 'active' else status end,
            updated_at    = now()
      where id = $1
      returning ${COLUMNS}`,
    [accountId],
  );
  return rows[0] ?? null;
}

/** Lazy, like `touchSession`: "last seen" is a line on a screen, not worth a write per request. */
export function touchAccount(accountId) {
  return query(
    `update accounts set last_seen_at = now()
      where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')`,
    [accountId],
  ).catch(() => null);
}

/** Their own sign-ins, newest first — the admin screen's "how many times, and when". */
export async function signInsFor(accountId, limit = 20) {
  const { rows } = await query(
    'select id, method, label, created_at from account_sign_ins where account_id = $1 order by created_at desc limit $2',
    [accountId, limit],
  );
  return rows;
}

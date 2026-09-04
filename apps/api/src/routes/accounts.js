/**
 * The admin module: who has Roam, and what it is costing.
 *
 * The owner's words on 4 Sep 2026: "I'd like to be able to enter their email
 * into the site and for you to send them a magic link... we need to build out
 * an admin module anyway where we can see all our customers, how long they've
 * been there, what subscriptions, and all of that stuff. On that screen, I
 * should be able to add people, invite them, and trigger the email with the
 * magic link" — and, on what a friend may spend: "I would like to be able to
 * see their usage and monitor it: when they last logged in, how many times
 * they've logged in, how much their usage is".
 *
 * Every route here is behind `requireOwner` (auth.js), which answers 404 rather
 * than 403 to everybody else: a customer using Roam has no business learning
 * that an admin module exists on the API they are using. The guard is mounted
 * with the router, on `/api/accounts` and nothing above it — a guard mounted on
 * `/api` would 404 every other route in the app for anybody but the owner.
 *
 * Two rules this file keeps that are easy to lose:
 *
 *  - **A link is shown once, and only to the owner.** The plain-text link comes
 *    back in the response to the invitation he asked for, because there is no
 *    mail sender configured yet and he has to be able to send it himself. It is
 *    never stored, never logged, and never in a list response.
 *  - **No SQL here.** It all lives in `repositories/accounts.js` (rule 1 of the
 *    estate's engineering standard).
 */

import express from 'express';
import {
  accountByEmail, accountById, createAccount, createAccountOnHousehold, createSignInLink, deleteAccount,
  lastLinkFor, listAccounts, markLinkSent, normaliseEmail, ownerAccount,
  revokeAccountSessions, signInsFor, updateAccount,
} from '../repositories/accounts.js';
import { firstHousehold } from '../repositories/households.js';
import { invitationEmail, mailStatus, sendMail, webUrl } from '../sources/mail.js';
import { HOUSEHOLD_MONTHLY_CALL_BOUND } from '../claude.js';

const router = express.Router();

/**
 * What somebody can be on. No money moves through Roam — the same rule group
 * costs follow — so a plan is a label, a date and a ceiling, not a card.
 */
export const PLANS = [
  { key: 'owner', label: 'Owner', note: 'The founding household. No limit beyond the estate default.' },
  { key: 'trial', label: 'Trial', note: 'Free while they try it. Give it an end date and the screen counts down.' },
  { key: 'friend', label: 'Friend', note: 'Free, no end date, smaller share of the provider allowance.' },
  { key: 'standard', label: 'Standard', note: 'A paying household, once there is anything to pay with.' },
];
const PLAN_KEYS = new Set(PLANS.map((p) => p.key));
const STATUSES = new Set(['invited', 'active', 'suspended']);

/**
 * A guest's default share of the month.
 *
 * The provider allowances are one pot — Google's free searches are per Google
 * account, not per household — so every household added draws on the same
 * allowance the owner's own searching does. A friend therefore starts on a
 * quarter of the estate bound rather than all of it, and the owner can raise or
 * lower any of them on the admin screen. Spend caps at the provider are still
 * his to set (CLAUDE.md); this is only Roam declining to spend.
 */
export const GUEST_MONTHLY_CALL_BOUND = Math.max(50, Math.round(HOUSEHOLD_MONTHLY_CALL_BOUND / 4));

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const bad = (message, code = 'bad_request') => Object.assign(new Error(message), { status: 400, code });

/** What the owner sees for one account. Never a token, never a link. */
const view = (row) => ({
  id: row.id,
  householdId: row.household_id,
  householdName: row.household_name ?? null,
  email: row.email,
  name: row.name,
  role: row.role,
  status: row.status,
  plan: row.plan,
  trialEndsOn: row.trial_ends_on ?? null,
  note: row.note ?? null,
  // "How long they've been there" — the two dates that answer it, and the app
  // does the arithmetic so the words match wherever they are shown.
  createdAt: row.created_at,
  invitedAt: row.invited_at,
  activatedAt: row.activated_at,
  lastSeenAt: row.last_seen_at,
  signInCount: row.sign_in_count,
  liveDevices: row.live_devices ?? 0,
  members: row.member_count ?? 0,
  trips: row.trip_count ?? 0,
  usage: {
    callsMonth: row.calls_month ?? 0,
    costMonth: Number(row.cost_month ?? 0),
    callsEver: row.calls_ever ?? 0,
    costEver: Number(row.cost_ever ?? 0),
    // The ceiling actually in force for them, so the screen can show a bar
    // rather than a number with no scale.
    bound: row.monthly_call_bound ?? (row.role === 'owner' ? HOUSEHOLD_MONTHLY_CALL_BOUND : GUEST_MONTHLY_CALL_BOUND),
    boundIsOwn: row.monthly_call_bound != null,
  },
});

/**
 * One account in the shape the list uses.
 *
 * Every verb here answers with the same object as `GET /api/accounts`, so the
 * screen can drop the answer straight into the row it just changed rather than
 * having two shapes for the same thing — one of them missing the household's
 * name and figures because they come from a join.
 */
async function enriched(id) {
  const row = (await listAccounts()).find((a) => a.id === id);
  return row ? view(row) : null;
}

/**
 * Mint a link, try to send it, and say what happened either way.
 *
 * The response carries the link itself. With no sender configured that is the
 * only way the invitation reaches anybody, and the owner copies it out of the
 * screen; with a sender configured it is still shown, because "did it actually
 * go" is a question he should be able to answer without leaving the page.
 */
async function invite(req, account, { requestedBy = 'owner', returning = false } = {}) {
  const { token, link } = await createSignInLink(account.id, { requestedBy });
  const url = `${webUrl(req)}/?signin=${token}`;
  const owner = await ownerAccount();
  const mail = mailStatus();
  let delivery = mail.configured ? 'email' : 'no_sender';
  let error = mail.configured ? null : mail.message;

  if (mail.configured) {
    const body = invitationEmail({
      name: account.name,
      url,
      from: owner?.name ?? null,
      expiresAt: link.expires_at,
      returning,
    });
    const sent = await sendMail({ to: account.email, ...body });
    if (!sent.sent) { delivery = sent.reason ?? 'send_failed'; error = sent.message ?? null; }
  }

  await markLinkSent(link.id, { delivery, error });
  return {
    url,
    expiresAt: link.expires_at,
    delivery,
    // Plain words for the screen: what happened, and what the owner does next.
    message: delivery === 'email'
      ? `Sent to ${account.email}. The link works once, and expires ${new Date(link.expires_at).toDateString()}.`
      : error,
  };
}

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------

/**
 * GET /api/accounts — everybody, with their usage and their last sign-in.
 *
 * Also carries what the screen needs to explain itself: the plans on offer, the
 * default ceiling, and whether a mail sender exists — because the answer to
 * "why did that not send" belongs on the screen that tried to send it.
 */
router.get('/', async (req, res, next) => {
  try {
    const rows = await listAccounts();
    const accounts = rows.map(view);
    // The most recent link per account, so the owner can see an invitation that
    // was never opened without opening each one.
    const links = await Promise.all(accounts.map((a) => lastLinkFor(a.id)));
    accounts.forEach((a, i) => {
      const l = links[i];
      a.lastInvite = l ? { at: l.created_at, expiresAt: l.expires_at, usedAt: l.used_at, delivery: l.delivery, error: l.delivery_error } : null;
    });
    const founding = await firstHousehold();
    res.json({
      accounts,
      plans: PLANS,
      mail: mailStatus(),
      defaults: { monthlyCallBound: HOUSEHOLD_MONTHLY_CALL_BOUND, guestMonthlyCallBound: GUEST_MONTHLY_CALL_BOUND },
      // Whether the owner himself has an account row yet. Until he does, he is
      // on the shared passcode and does not appear in his own list.
      ownerClaimed: accounts.some((a) => a.role === 'owner'),
      foundingHousehold: founding ? { id: founding.id, name: founding.name } : null,
      totals: {
        costMonth: accounts.reduce((n, a) => n + a.usage.costMonth, 0),
        costEver: accounts.reduce((n, a) => n + a.usage.costEver, 0),
        callsMonth: accounts.reduce((n, a) => n + a.usage.callsMonth, 0),
      },
    });
  } catch (err) { next(err); }
});

/** GET /api/accounts/:id — one of them, with the sign-ins behind the count. */
router.get('/:id', async (req, res, next) => {
  try {
    const account = await accountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    const [signIns, link] = await Promise.all([signInsFor(account.id), lastLinkFor(account.id)]);
    res.json({
      account: (await enriched(account.id)) ?? view(account),
      signIns: signIns.map((s) => ({ id: s.id, method: s.method, label: s.label, at: s.created_at })),
      lastInvite: link ? { at: link.created_at, expiresAt: link.expires_at, usedAt: link.used_at, delivery: link.delivery, error: link.delivery_error } : null,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// adding somebody
// ---------------------------------------------------------------------------

/**
 * POST /api/accounts — a person, a household of their own, and an invitation.
 *
 * `invite: false` creates the account without sending anything, for adding
 * several people and inviting them when the sender is configured.
 */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const email = normaliseEmail(b.email);
    if (!EMAIL.test(email)) throw bad('That does not look like an e-mail address.');
    if (b.plan && !PLAN_KEYS.has(b.plan)) throw bad('That is not one of the plans.');

    const existing = await accountByEmail(email);
    if (existing) {
      return res.status(409).json({
        error: 'account_exists',
        message: `${email} already has a Roam account.`,
        account: view(existing),
      });
    }

    const name = String(b.name || '').trim() || null;
    const account = await createAccount({
      email,
      name,
      plan: b.plan || 'trial',
      trialEndsOn: b.trialEndsOn || null,
      // A guest's smaller share, unless the owner said a number.
      monthlyCallBound: b.monthlyCallBound ?? GUEST_MONTHLY_CALL_BOUND,
      note: b.note || null,
      // Their household is named after them until they name it themselves.
      householdName: name ? `${name}'s household` : email,
    });

    const invitation = b.invite === false ? null : await invite(req, account, {});
    res.status(201).json({ account: await enriched(account.id), invitation });
  } catch (err) { next(err); }
});

/**
 * POST /api/accounts/owner — the owner's own account, on the household he
 * already has.
 *
 * Not a new household: this binds an e-mail to the founding one, so he appears
 * in his own list with his own usage and can sign in by link on a device that
 * has never had the passcode. The passcode goes on working either way.
 */
router.post('/owner', async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body?.email);
    if (!EMAIL.test(email)) throw bad('That does not look like an e-mail address.');
    const already = await ownerAccount();
    if (already) return res.status(409).json({ error: 'owner_exists', message: 'There is already an owner account.', account: view(already) });
    const founding = await firstHousehold();
    if (!founding) throw bad('There is no household to own yet. Run the seed first.', 'no_household');
    const existing = await accountByEmail(email);
    if (existing) throw bad(`${email} already has an account on another household.`, 'account_exists');

    const account = await createAccountOnHousehold(founding.id, {
      email,
      name: String(req.body?.name || '').trim() || null,
      role: 'owner',
      plan: 'owner',
    });
    res.status(201).json({ account: await enriched(account.id) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// changing and removing
// ---------------------------------------------------------------------------

/** PATCH /api/accounts/:id — plan, status, ceiling, note, name. */
router.patch('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.plan && !PLAN_KEYS.has(b.plan)) throw bad('That is not one of the plans.');
    if (b.status && !STATUSES.has(b.status)) throw bad('That is not one of the statuses.');
    const before = await accountById(req.params.id);
    if (!before) return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    if (b.status === 'suspended' && before.role === 'owner') throw bad('The owner account cannot be suspended.');

    const account = await updateAccount(req.params.id, {
      name: b.name,
      plan: b.plan,
      status: b.status,
      trialEndsOn: b.trialEndsOn,
      monthlyCallBound: b.monthlyCallBound === null ? null : b.monthlyCallBound,
      note: b.note,
    });
    // Suspending takes the devices with it; the data stays exactly where it is.
    if (b.status === 'suspended') await revokeAccountSessions(account.id);
    res.json({ account: await enriched(account.id) });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/accounts/:id — take the account away.
 *
 * Their household, and everything in it, is only removed when the caller says
 * `?withHousehold=1`. Two different acts, and one of them cannot be undone.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const account = await accountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    if (account.role === 'owner') throw bad('The owner account cannot be deleted from here.');
    const withHousehold = String(req.query.withHousehold) === '1' || req.body?.withHousehold === true;
    await revokeAccountSessions(account.id);
    await deleteAccount(account.id, { withHousehold });
    res.json({
      removed: true,
      withHousehold,
      message: withHousehold
        ? `${account.email} and everything their household had saved has been removed.`
        : `${account.email} can no longer sign in. Their household's data is still here.`,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// inviting
// ---------------------------------------------------------------------------

/** POST /api/accounts/:id/invite — a fresh link, sent if there is a sender and shown either way. */
router.post('/:id/invite', async (req, res, next) => {
  try {
    const account = await accountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    if (account.status === 'suspended') throw bad('That account is suspended. Make it active before inviting them back.');
    const invitation = await invite(req, account, { returning: account.sign_in_count > 0 });
    res.json({ account: await enriched(account.id), invitation });
  } catch (err) { next(err); }
});

/** POST /api/accounts/:id/sign-out — every device that account is signed in on. */
router.post('/:id/sign-out', async (req, res, next) => {
  try {
    const account = await accountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    await revokeAccountSessions(account.id);
    res.json({ account: await enriched(account.id), signedOut: true });
  } catch (err) { next(err); }
});

export default router;
export { invite };

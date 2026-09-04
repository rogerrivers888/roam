/**
 * Signing in, and knowing whether you are.
 *
 * Deliberately small: three verbs on one path, and the only route file in the
 * API that answers without a session (auth.js `PUBLIC`).
 */

import express from 'express';
import {
  authConfigured, clearSessionCookie, closeSession, openSession, passcodeMatches, sessionCookie,
} from '../auth.js';
import { findLiveSession, liveSessions, revokeAllSessions } from '../repositories/sessions.js';
import { accountByEmail, accountById, consumeSignInLink, ownerAccount, recordSignIn } from '../repositories/accounts.js';
import { invite } from './accounts.js';
import { accessFor } from '../access.js';

const router = express.Router();

/**
 * The doors and capabilities behind a session.
 *
 * `requireSession` attaches these to every other request, but this route
 * answers *before* the door — it is how the app finds out whether it is inside
 * — so it resolves them itself from the account it just looked up.
 */
async function accessSummary(account) {
  const access = await accessFor({ account });
  return { doors: access.doors, capabilities: [...access.capabilities], role: access.role ? { key: access.role.key, label: access.role.label } : null };
}

const bearerOf = (req) => {
  const [scheme, value] = String(req.headers.authorization || '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
};

/**
 * GET /api/session — am I signed in?
 *
 * The app asks this before it draws anything, so it can show the passcode
 * screen rather than five screens' worth of failed requests. Answers 200 either
 * way: "no" is an answer, not an error.
 */
router.get('/session', async (req, res, next) => {
  try {
    if (!authConfigured()) {
      return res.json({ signedIn: false, configured: false, message: 'This Roam API has no passcode set yet.' });
    }
    const token = bearerOf(req);
    const session = token ? await findLiveSession(token) : null;
    const account = session?.account_id ? await accountById(session.account_id) : null;
    // A suspended account is signed out here as well as at the door, so the app
    // shows the sign-in screen rather than five screens' worth of 403s.
    if (account && account.status === 'suspended') {
      return res.json({ signedIn: false, configured: true, session: null, account: null, suspended: true });
    }
    res.json({
      signedIn: Boolean(session),
      configured: true,
      session: session ? { id: session.id, label: session.label, since: session.created_at, until: session.expires_at } : null,
      // Who they are, and whether the admin module is theirs to see. The shared
      // passcode carries no account and is the owner (auth.js `requireOwner`),
      // which is why `isOwner` is answered here rather than inferred from
      // `account` being absent.
      account: account ? { id: account.id, email: account.email, name: account.name, role: account.role, plan: account.plan } : null,
      isOwner: Boolean(session) && (!session.account_id || account?.role === 'owner'),
      // Which applications this session may enter and what it may do in them
      // (access.js). The app draws only the doors it is told it holds — and the
      // API refuses the rest whatever the app draws.
      access: session ? await accessSummary(account) : null,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/session — the passcode, once, for a token that lasts ninety days.
 *
 * The token comes back in the body (the app sends it as a bearer header from
 * then on) and as a cookie, which exists only so an `<img>` tag can load a
 * photograph: auth.js will not accept that cookie for anything else.
 */
router.post('/session', async (req, res, next) => {
  try {
    if (!authConfigured()) {
      return res.status(503).json({ error: 'auth_not_configured', message: 'This Roam API has no passcode set. The owner adds ROAM_PASSCODE in Doppler.' });
    }
    if (!passcodeMatches(req.body?.passcode)) {
      // One message for a missing passcode and a wrong one: which it was is
      // information, and the caller is not necessarily the family.
      return res.status(401).json({ error: 'wrong_passcode', message: "That passcode doesn't open this Roam." });
    }
    const label = String(req.body?.label || '').slice(0, 80) || null;
    // Once the owner has claimed an account (admin › Accounts), the passcode
    // opens a session on it, so his own sign-ins and usage are counted the same
    // way everybody else's are. Until then it opens a session with no account,
    // which resolves to the founding household exactly as it always has.
    const owner = await ownerAccount();
    const { token, session } = await openSession(label, owner?.id ?? null);
    if (owner) await recordSignIn(owner.id, { method: 'passcode', label });
    sessionCookie(res, token);
    res.status(201).json({
      token,
      session: { id: session.id, label: session.label, since: session.created_at, until: session.expires_at },
      account: owner ? { id: owner.id, email: owner.email, name: owner.name, role: owner.role, plan: owner.plan } : null,
      isOwner: true,
    });
  } catch (err) { next(err); }
});

/** DELETE /api/session — sign this device out. `?all=1` signs every device out. */
router.delete('/session', async (req, res, next) => {
  try {
    const token = bearerOf(req);
    if (String(req.query.all) === '1' || req.body?.all === true) {
      // Only somebody already inside may do this, so it is checked here rather
      // than trusted from the query: a live session, or nothing happens.
      const live = token ? await findLiveSession(token) : null;
      if (!live) return res.status(401).json({ error: 'signed_out', message: 'Sign in first.' });
      // Their own devices, not the estate's: one customer signing out
      // everywhere must not sign every other household out too.
      await revokeAllSessions(live.account_id ?? null);
    } else if (token) {
      await closeSession(token);
    }
    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * POST /api/session/link — a magic link, exchanged for a session.
 *
 * This is how everybody except the owner gets in. The link is single-use and
 * expiring, and `consumeSignInLink` spends it in the same statement that checks
 * it, so a link that was forwarded to somebody else is simply already spent by
 * the time they open it.
 *
 * One message for every way of failing. "That link has expired", "that link was
 * already used" and "that account was suspended" are three facts about somebody
 * else's account, and the caller is not necessarily them.
 */
router.post('/session/link', async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    const spent = token ? await consumeSignInLink(token) : null;
    if (!spent) {
      return res.status(401).json({
        error: 'link_spent',
        message: 'That link does not work any more. Ask for a new one and it will arrive by e-mail.',
      });
    }
    const label = String(req.body?.label || '').slice(0, 80) || null;
    const account = await recordSignIn(spent.account_id, { method: 'link', label });
    const { token: sessionToken, session } = await openSession(label, spent.account_id);
    sessionCookie(res, sessionToken);
    res.status(201).json({
      token: sessionToken,
      session: { id: session.id, label: session.label, since: session.created_at, until: session.expires_at },
      account: { id: account.id, email: account.email, name: account.name, role: account.role, plan: account.plan },
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/session/request-link — "e-mail me a link".
 *
 * The owner sends invitations from the admin screen, but a link is single-use
 * and a device is signed in for ninety days, so somebody who changes phone in
 * month four needs a way back in that is not "text Roger". This is it.
 *
 * It answers exactly the same whether or not the address has an account, and
 * takes the same time to do it, so it cannot be used to find out who Roam's
 * customers are. It is held to the sign-in limit (limits.js) like the passcode.
 */
router.post('/session/request-link', async (req, res, next) => {
  try {
    const account = await accountByEmail(req.body?.email);
    // Only an account that has been invited and is not suspended gets a link.
    // Everything else falls through to the same answer as an unknown address.
    if (account && account.status !== 'suspended') {
      await invite(req, account, { requestedBy: 'self', returning: true });
    }
    res.json({
      sent: true,
      message: 'If that address has a Roam account, a link is on its way. It works once and lasts a week.',
    });
  } catch (err) { next(err); }
});

export default router;

/**
 * The devices signed in, for Settings.
 *
 * Its own router because it is the one thing here that is *not* public: the
 * door above answers without a session by design, and this must not. server.js
 * mounts it on the far side of `requireSession`.
 */
export const devices = express.Router();

devices.get('/sessions', async (req, res, next) => {
  try {
    const rows = await liveSessions(req.session?.account_id ?? null);
    res.json({
      sessions: rows.map((s) => ({ id: s.id, label: s.label, since: s.created_at, lastSeen: s.last_seen_at, until: s.expires_at })),
    });
  } catch (err) { next(err); }
});

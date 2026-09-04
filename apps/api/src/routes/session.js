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

const router = express.Router();

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
    res.json({
      signedIn: Boolean(session),
      configured: true,
      session: session ? { id: session.id, label: session.label, since: session.created_at, until: session.expires_at } : null,
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
    const { token, session } = await openSession(label);
    sessionCookie(res, token);
    res.status(201).json({ token, session: { id: session.id, label: session.label, since: session.created_at, until: session.expires_at } });
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
      await revokeAllSessions();
    } else if (token) {
      await closeSession(token);
    }
    clearSessionCookie(res);
    res.status(204).end();
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

devices.get('/sessions', async (_req, res, next) => {
  try {
    const rows = await liveSessions();
    res.json({
      sessions: rows.map((s) => ({ id: s.id, label: s.label, since: s.created_at, lastSeen: s.last_seen_at, until: s.expires_at })),
    });
  } catch (err) { next(err); }
});

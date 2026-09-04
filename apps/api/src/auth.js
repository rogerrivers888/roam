/**
 * The door.
 *
 * Roam's API answered anybody. `currentHousehold()` is "the first household in
 * the table", so every request from anywhere on the internet resolved to this
 * family: their home address, their children's names and birthdays, every place
 * they have been and what each of them thought of it — and, two requests deep,
 * `delete /api/household`. It also spent Google quota on their bill for whoever
 * asked. This file closes that.
 *
 * Two credentials, not one. The owner has a passcode, which lives in Doppler
 * and is his to set (CLAUDE.md: anything that holds a secret is the owner's to
 * do); everybody else signs in with a single-use link sent to their e-mail
 * (routes/accounts.js). Neither is ever in the repo, in `.env.example` or in
 * the database — what is written down is a hash of the session each opens, in
 * `repositories/sessions.js`, and a hash of the link, in
 * `repositories/accounts.js`.
 *
 * With no passcode set the API serves nothing to anybody it does not already
 * know. An account holder with a live session is somebody it knows, so they
 * keep working: the 503 exists to stop the household being served to the
 * internet, not to stop Roam being run on accounts alone.
 *
 * Two ways in, on purpose:
 *
 *  - `Authorization: Bearer <token>` — how the app asks for everything. A site
 *    the family has never heard of cannot read this header out of their browser,
 *    so there is no way to make their browser act for them.
 *  - a cookie — only ever accepted for `GET /api/photos/google`, because a
 *    photo is loaded by an `<img>` tag and an `<img>` tag cannot carry a
 *    header. Nothing can be changed through that route, so the cookie can be
 *    sent cross-site without opening a way to change anything.
 *
 * The second rule is the important one: cookies are not accepted for writes at
 * all, which is what keeps a cross-site request from being able to do anything.
 */

import crypto from 'node:crypto';
import { findLiveSession, insertSession, revokeSession, touchSession } from './repositories/sessions.js';
import { accountById, touchAccount } from './repositories/accounts.js';
import { runAsAccount } from './context.js';

export const COOKIE = 'roam_session';

/** Whether this process is the deployed one, rather than somebody's laptop. */
export const deployed = () => Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.NODE_ENV === 'production');

/**
 * The passcode, or null when nobody has set one.
 *
 * Locally there is a known one so the sign-in flow is the same thing developers
 * exercise as the family does. Deployed there is no fallback: an API with no
 * passcode set refuses every request rather than quietly serving the household
 * to the internet, which is the failure this whole file exists to prevent.
 */
export const passcode = () => process.env.ROAM_PASSCODE || (deployed() ? null : 'roam-dev');
export const authConfigured = () => Boolean(passcode());

/** Constant-time, and safe on a length mismatch (timingSafeEqual throws on one). */
function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length) {
    // Still compare something, so a wrong length is not faster than a wrong byte.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export const passcodeMatches = (given) => authConfigured() && sameSecret(given, passcode());

/**
 * A new session. The token is returned once and never stored in full.
 *
 * `accountId` is who it is for. Null is the shared passcode, which is the owner
 * on the founding household — the arrangement that existed before accounts, and
 * which keeps working so that adding accounts does not sign the owner out of
 * his own app.
 */
export async function openSession(label, accountId = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  const session = await insertSession(token, label, accountId);
  return { token, session };
}

export const closeSession = (token) => revokeSession(token);

// ---------------------------------------------------------------------------
// reading the request
// ---------------------------------------------------------------------------

function bearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

/** No cookie-parser: one header, split once, and never trusted for a write. */
function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
  }
  return null;
}

/**
 * Which origins the browser app may be served from, when the owner has said.
 *
 * `ROAM_WEB_ORIGIN` is a comma-separated list and is not a secret, so it is a
 * plain Railway/Doppler variable. Unset, the API still answers any origin — the
 * passcode is doing the work either way — but setting it is what stops another
 * site from being able to open a stream on the family's session, so the README
 * asks for it.
 */
const ORIGINS = () => String(process.env.ROAM_WEB_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

export function originAllowed(origin) {
  if (!origin) return true; // curl, a native app, a same-origin request: no Origin header at all.
  const list = ORIGINS();
  if (!list.length) return true;
  return list.includes(String(origin).replace(/\/$/, ''));
}

/**
 * Where a cookie may stand in for the header, and why only here.
 *
 * Two requests in the app cannot carry a header at all: an `<img>` loading a
 * photograph, and the `EventSource` a shortlist search streams down. Both are
 * GETs. Neither can change anything, so a cookie sent cross-site cannot be used
 * to act as the family — which is the whole reason writes never accept one.
 *
 * The stream does spend provider money, so it is held to the origin list as
 * well: a browser will not let another site read a cross-origin EventSource
 * unless we say its origin is allowed, and we only say so for the web app.
 */
const STREAM = /^\/api\/trips\/[^/]+\/shortlist\/search\/stream$/;
function cookieAllowed(req) {
  if (req.method !== 'GET') return false;
  if (req.path === '/api/photos/google') return true;
  if (STREAM.test(req.path)) return originAllowed(req.headers.origin);
  return false;
}

export function sessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: deployed(),
    // The web app and the API are two Railway services on two domains, so the
    // cookie is cross-site by construction and has to say so to be sent at all.
    sameSite: deployed() ? 'none' : 'lax',
    maxAge: 90 * 24 * 3600 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: deployed(), sameSite: deployed() ? 'none' : 'lax', path: '/' });
}

// ---------------------------------------------------------------------------
// the middleware
// ---------------------------------------------------------------------------

/**
 * Paths that answer without a session, and why each one is safe to.
 *
 *  - `/health`, `/robots.txt` — say nothing about the household.
 *  - `/api/session` — the door itself; rate-limited hard in `limits.js`.
 *  - `/api/session/link` — redeeming a magic link. It has to answer without a
 *    session because it is how a session is obtained; the unguessable,
 *    single-use, expiring token is the credential (repositories/accounts.js),
 *    and it is held to the same sign-in limit as the passcode.
 *  - `/api/session/request-link` — asking for a new link by e-mail. Answers the
 *    same way whether or not the address has an account, so it cannot be used
 *    to find out who Roam's customers are.
 *  - `/api/join/:token` and below — somebody else's door into one trip. The
 *    unguessable link *is* the credential (routes/groups.js), and it shows a
 *    checklist and never the roster.
 */
const PUBLIC = [
  (req) => req.path === '/health',
  (req) => req.path === '/robots.txt',
  (req) => req.path === '/api/session',
  (req) => req.path === '/api/session/link',
  (req) => req.path === '/api/session/request-link',
  (req) => req.path === '/api/join' || req.path.startsWith('/api/join/'),
];

export const isPublicPath = (req) => PUBLIC.some((test) => test(req));

export async function requireSession(req, res, next) {
  try {
    if (req.method === 'OPTIONS' || isPublicPath(req)) return next();

    const token = bearer(req) || (cookieAllowed(req) ? cookieToken(req) : null);
    const session = token ? await findLiveSession(token) : null;

    // Whose session this is. A session with no account is the shared passcode:
    // the owner, on the founding household, exactly as before accounts existed.
    const account = session?.account_id ? await accountById(session.account_id) : null;

    if (!authConfigured()) {
      // Fail closed for anybody who is not already somebody. An API with
      // nobody's passcode on it must not serve the household to the internet —
      // but an account holder signed in on their own link is not the internet,
      // and refusing them would mean the owner could never take the shared
      // passcode away without locking every friend out of their own Roam.
      if (!account) {
        return res.status(503).json({
          error: 'auth_not_configured',
          message: 'This Roam API has no passcode set. The owner adds ROAM_PASSCODE in Doppler; nothing is served until then.',
        });
      }
    } else if (!session) {
      return res.status(401).json({ error: 'signed_out', message: 'Sign in to Roam to continue.' });
    }

    // A suspended account keeps its data and loses its way in. Checked on every
    // request rather than only at sign-in, so suspending somebody takes effect
    // on the device they are already holding.
    if (session.account_id && (!account || account.status === 'suspended')) {
      return res.status(403).json({
        error: 'account_suspended',
        message: 'This Roam account is not active. Ask whoever invited you.',
      });
    }

    req.session = session;
    req.account = account;
    void touchSession(session.id);
    if (account) void touchAccount(account.id);

    // Everything downstream — including `currentHousehold()`, 86 call sites
    // deep — is served inside this account's context (context.js).
    return runAsAccount(account, next);
  } catch (err) {
    return next(err);
  }
}


/**
 * The admin module's door, inside the household one.
 *
 * Two callers pass: an account marked `owner`, and the shared passcode. The
 * second is deliberate — the passcode is the owner's own way in and predates
 * accounts, so locking the admin screen to an account row would mean the owner
 * could not reach the screen that creates the first account row.
 *
 * Everyone else gets 404, not 403. A customer has no business learning that an
 * admin module exists on the API they are using.
 */
export function requireOwner(req, res, next) {
  const isOwner = !req.session?.account_id || req.account?.role === 'owner';
  if (isOwner) return next();
  return res.status(404).json({ error: 'not_found', message: 'Not found.' });
}

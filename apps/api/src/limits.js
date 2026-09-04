/**
 * How often one caller may ask.
 *
 * Three things need this, and they need different numbers:
 *
 *  - the door, hardest. A passcode with no limit on it is a passcode somebody
 *    guesses overnight;
 *  - anything that spends money. Roam's searches call Google Places and Routes
 *    and every call is billed to this household (`provider_calls`), so an
 *    unthrottled search endpoint is somebody else's hand in the owner's wallet;
 *  - everything else, loosely, so one misbehaving script cannot hold the API
 *    down for the family.
 *
 * In memory, on purpose. Roam is a single API service; a shared counter would
 * mean Redis, and Redis for this would be the sidecar the standard says not to
 * add. The trade is honest and worth naming: a restart forgets the counters and
 * a second instance would count separately. If Roam is ever scaled past one
 * instance, this file is the thing that has to change.
 */

/** window → { key → { count, resetAt } }, one map per limiter. */
const buckets = new Map();

/** Railway terminates TLS in front of us, so the caller is the first forwarded-for. */
export function callerOf(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function hit(name, key, windowMs, max) {
  let bucket = buckets.get(name);
  if (!bucket) { bucket = new Map(); buckets.set(name, bucket); }
  const now = Date.now();
  const entry = bucket.get(key);
  if (!entry || entry.resetAt <= now) {
    bucket.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1, resetAt: now + windowMs };
  }
  entry.count += 1;
  return { ok: entry.count <= max, remaining: Math.max(0, max - entry.count), resetAt: entry.resetAt };
}

/**
 * A limiter. `max` requests per `windowMs` per caller; over that, 429 and the
 * seconds until it clears, so a client can wait rather than hammer.
 */
export function limit({ name, windowMs, max, message, keyOf = callerOf }) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const { ok, remaining, resetAt } = hit(name, keyOf(req), windowMs, max);
    const seconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('x-ratelimit-remaining', String(remaining));
    if (ok) return next();
    res.setHeader('retry-after', String(seconds));
    return res.status(429).json({ error: 'too_many_requests', message: message || `Too many requests. Try again in ${seconds}s.`, retryAfter: seconds });
  };
}

const MINUTE = 60_000;

/** The door: ten tries a quarter of an hour, which is nothing to a family and a wall to a script. */
export const signInLimit = limit({
  name: 'sign-in',
  windowMs: 15 * MINUTE,
  max: 10,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
});

/** Anything that can reach a paid provider. */
export const spendLimit = limit({
  name: 'spend',
  windowMs: 5 * MINUTE,
  max: 120,
  message: 'That is a lot of searching at once. Give it a minute.',
});

/** Everything else. Generous: a screen opening can be a dozen requests. */
export const generalLimit = limit({ name: 'general', windowMs: 5 * MINUTE, max: 900 });

/** Forget windows that have passed, so the maps do not grow for ever. */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const bucket of buckets.values()) {
    for (const [key, entry] of bucket) if (entry.resetAt <= now) bucket.delete(key);
  }
}, 10 * MINUTE);
sweep.unref?.();

// Which Overpass mirror to ask, and which one to leave alone.
//
// Overpass is somebody else's machine, run for free, and on any given day one
// or two of the public mirrors are refusing or hanging. Measured 5 Sep 2026,
// three times each:
//
//   overpass-api.de          fails outright in ~3s
//   overpass.kumi.systems    40s to a timeout, or a 504
//   overpass.private.coffee  answers in 6–10s
//   overpass.osm.ch          answers in 0.12–0.27s
//
// The background researcher (sources/openMatch.js) already knew how to cope:
// start where the last answer came from, and give a mirror that refuses ten
// minutes off. The interactive search (sources/osm.js) did not — it knew only
// the first two names on that list and gave each thirty seconds — so every
// uncached search on the Stay tab paid a dead mirror and then a hanging one
// before it reached a working one. That is the minute the owner sat through
// (owner, 5 Sep 2026: "It took more than a minute").
//
// So the knowledge lives here once and both callers share it, which also means
// a mirror one of them finds to be down is a mirror the other stops asking.

const DEFAULT = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

export const ENDPOINTS = (process.env.ROAM_OVERPASS_URLS || DEFAULT.join(','))
  .split(',').map((u) => u.trim()).filter(Boolean);

export const UA = 'Roam/0.1 (+https://github.com/rogerrivers888/roam)';

// A mirror that rate-limits us stops answering altogether for a while. Asking
// it again every time costs the full timeout on every call and is rude besides,
// so a refusal buys it ten minutes off and the work moves to another.
const COOL_OFF_MS = 10 * 60_000;
const restingUntil = new Map();
const resting = (url) => (restingUntil.get(url) ?? 0) > Date.now();

// Start where we last got an answer rather than at the top of the list.
let preferred = 0;

/**
 * The mirrors to try, in the order to try them: the one that last answered
 * first, and anything resting at the back rather than skipped — if they are all
 * resting, one of them still has to be asked.
 */
export function mirrorsInOrder() {
  const order = ENDPOINTS.map((_, i) => ENDPOINTS[(preferred + i) % ENDPOINTS.length]);
  return [...order.filter((u) => !resting(u)), ...order.filter(resting)];
}

/** This one answered: prefer it next time, and let it off any rest it was on. */
export function mirrorAnswered(url) {
  restingUntil.delete(url);
  preferred = Math.max(0, ENDPOINTS.indexOf(url));
}

/**
 * This one refused or hung. 429 is "slow down" and 503/504 are "I gave up";
 * a timeout is the same signal from a mirror that simply stops replying, which
 * is what the busy ones actually do. Anything else (a DNS failure, a reset) is
 * the machine being unreachable, which is also worth not repeating.
 */
export function mirrorFailed(url, err = null, status = null) {
  if (status && ![429, 503, 504].includes(status)) return;
  restingUntil.set(url, Date.now() + COOL_OFF_MS);
}

/** What each mirror is doing, for /api/keys-style diagnosis and the tests. */
export const mirrorHealth = () => ENDPOINTS.map((url) => ({
  url,
  resting: resting(url),
  restingForMs: Math.max(0, (restingUntil.get(url) ?? 0) - Date.now()),
  preferred: ENDPOINTS[preferred] === url,
}));

/** Only for tests: forget what we have learned about the mirrors. */
export function resetMirrors() {
  restingUntil.clear();
  preferred = 0;
}

// A search, remembered (owner, 3 Sep 2026): opening an idea on the Plan screen,
// then the same place on a trip's Find tab, must not ask the sources twice, and
// a search already running for the same area is joined rather than repeated.
// Licensed content stays in memory only — nothing here is written to the
// database (Technical Constraints: rented content is never stored).

import { searchAllSources, optInFrom } from './index.js';

const TTL_MS = 12 * 3600_000;
// A search a source did not answer (Overpass timing out) is kept only briefly,
// so the next look asks again rather than showing half a picture for hours.
const DEGRADED_TTL_MS = 10 * 60_000;
const MAX = 300;
const kept = new Map();
const inFlight = new Map();
// A source we chose not to wait for is not a source that let us down. The
// look-around asks for an answer in a few seconds and takes what it has; that
// answer is the one it wanted, so it keeps for the full twelve hours rather
// than being re-asked every ten minutes — which would mean paying for the same
// Google search all afternoon.
const letUsDown = (result) => (result.degraded ?? []).some((d) => !d.slow);
const fresh = (hit) => hit && Date.now() - hit.at < (letUsDown(hit.result) ? DEGRADED_TTL_MS : TTL_MS);

/** The same area, radius, kind, words and sources are the same search; the label is not part of it. */
export function searchKey(p) {
  const c = p.center || {};
  return [
    Number(c.lat).toFixed(4), Number(c.lng).toFixed(4), p.radiusKm ?? 3,
    [...(p.categories || [])].sort().join(','), String(p.query || '').trim().toLowerCase(),
    [...optInFrom(p.sources)].sort().join(','),
    // Two trips can share a point, a radius and a source set and still want
    // different events: what is on is only the same search over the same window.
    p.includeEvents ? `events:${p.outingStart ?? ''}:${p.outingEnd ?? ''}` : '',
  ].join('|');
}

/**
 * A venue this session has already searched up, wherever it was found.
 *
 * The searches held here carry the provider's whole answer — including the
 * photo references — and they were paid for once already. So a screen that
 * wants a picture for a place a search has just returned must read it from
 * here rather than buy the same place again as a Details call: "options are
 * composed from one retrieved pool; adding an option must not add a provider
 * call" (CLAUDE.md), and a picture is an option like any other.
 *
 * Scanning every held search sounds expensive and is not: three hundred
 * searches of about sixty venues is eighteen thousand string comparisons
 * against an in-memory map, and it happens instead of a network round trip.
 *
 * `sources/index.js` cannot do this job — `recallVenue` deliberately retains
 * only the open sources, because those are the ones we are allowed to keep.
 * This is the rented pool, in memory, expiring on the same twelve-hour clock as
 * the search it came from, and nothing here is ever written down.
 */
export function venueFromKept(venueRef) {
  for (const hit of kept.values()) {
    if (!fresh(hit)) continue;
    const found = hit.result.venues?.find((v) => v.venueRef === venueRef
      || `${v.source}:${v.sourcePlaceId}` === venueRef);
    if (found) return found;
  }
  return null;
}

/** What is already known for these parameters, or null. */
export function searchKept(params) {
  const hit = kept.get(searchKey(params));
  return fresh(hit) ? hit.result : null;
}

/**
 * Search through the cache. `fetched` is true only for the caller whose request
 * actually asked the sources — that caller logs the provider call; a hit or a
 * joined search logs nothing. `refresh` asks the sources again regardless.
 */
export async function searchCached(params, { refresh = false, onProgress = null } = {}) {
  const key = searchKey(params);
  const hit = kept.get(key);
  // A watcher is told when nothing was asked at all, so a search answered from
  // what is already held says so rather than miming a fetch that never ran.
  const cachedSay = (result) => { try { onProgress?.({ type: 'cached', count: result.venues.length }); } catch { /* not the search */ } };
  if (fresh(hit) && !refresh) { cachedSay(hit.result); return { ...hit.result, cached: true, fetchedAt: new Date(hit.at).toISOString(), fetched: false }; }
  if (inFlight.has(key) && !refresh) {
    // Two people, or two screens, asking the same thing at once. This one waits
    // on the answer the other is already getting — and is told so at once,
    // because "asking" would be a lie and the wait can be the whole 25 seconds
    // of a slow source.
    try { onProgress?.({ type: 'joining' }); } catch { /* not the search */ }
    const r = await inFlight.get(key);
    cachedSay(r);
    return { ...r, cached: true, fetchedAt: new Date().toISOString(), fetched: false };
  }
  const hold = (result) => {
    kept.delete(key);
    kept.set(key, { at: Date.now(), result });
    while (kept.size > MAX) kept.delete(kept.keys().next().value);
  };
  const run = searchAllSources(params, { onProgress })
    .then((result) => {
      hold(result);
      // A source too slow to hold the screen for was still running when this
      // answered (sources/index.js). Nobody is waiting on it, but when it lands
      // the fuller answer replaces the one held here — so the second look at
      // the same place gets OpenStreetMap's hundred and twenty for nothing,
      // having paid for them once, in the background, while the first screen
      // was already up.
      result.settling?.then((full) => {
        // Only if this is still the answer being held. A `refresh` may have
        // overwritten it in the meantime, and a straggler must not undo that.
        if (kept.get(key)?.result === result) hold({ ...full, cached: true, latecomers: true });
      }).catch(() => null);
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  const result = await run;
  return { ...result, cached: false, fetchedAt: new Date().toISOString(), fetched: true };
}

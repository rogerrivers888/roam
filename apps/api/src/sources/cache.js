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
const fresh = (hit) => hit && Date.now() - hit.at < (hit.result.degraded?.length ? DEGRADED_TTL_MS : TTL_MS);

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
  const run = searchAllSources(params, { onProgress })
    .then((result) => {
      kept.delete(key);
      kept.set(key, { at: Date.now(), result });
      while (kept.size > MAX) kept.delete(kept.keys().next().value);
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  const result = await run;
  return { ...result, cached: false, fetchedAt: new Date().toISOString(), fetched: true };
}

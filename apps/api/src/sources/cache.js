// A search, remembered (owner, 3 Sep 2026): opening an idea on the Plan screen,
// then the same place on a trip's Find tab, must not ask the sources twice, and
// a search already running for the same area is joined rather than repeated.
// Licensed content stays in memory only — nothing here is written to the
// database (Technical Constraints: rented content is never stored).

import { searchAllSources, optInFrom } from './index.js';

const TTL_MS = 12 * 3600_000;
const MAX = 300;
const kept = new Map();
const inFlight = new Map();

/** The same area, radius, kind, words and sources are the same search; the label is not part of it. */
export function searchKey(p) {
  const c = p.center || {};
  return [
    Number(c.lat).toFixed(4), Number(c.lng).toFixed(4), p.radiusKm ?? 3,
    [...(p.categories || [])].sort().join(','), String(p.query || '').trim().toLowerCase(),
    [...optInFrom(p.sources)].sort().join(','), p.includeEvents ? 'events' : '',
  ].join('|');
}

/** What is already known for these parameters, or null. */
export function searchKept(params) {
  const hit = kept.get(searchKey(params));
  return hit && Date.now() - hit.at < TTL_MS ? hit.result : null;
}

/**
 * Search through the cache. `fetched` is true only for the caller whose request
 * actually asked the sources — that caller logs the provider call; a hit or a
 * joined search logs nothing. `refresh` asks the sources again regardless.
 */
export async function searchCached(params, { refresh = false } = {}) {
  const key = searchKey(params);
  const hit = kept.get(key);
  if (hit && !refresh && Date.now() - hit.at < TTL_MS) return { ...hit.result, cached: true, fetchedAt: new Date(hit.at).toISOString(), fetched: false };
  if (inFlight.has(key) && !refresh) return { ...(await inFlight.get(key)), cached: true, fetchedAt: new Date().toISOString(), fetched: false };
  const run = searchAllSources(params)
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

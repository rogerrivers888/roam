// Beds near a point, from the open map, kept for the afternoon.
//
// Hotels do not open and close while somebody is deciding where to stay, and
// Overpass takes its time, so the first look pays for the whole session and
// every adjustment of the radius after it is instant.

import { osmSource, OSM_ATTRIBUTION } from './osm.js';

export { OSM_ATTRIBUTION };

const kept = new Map();
const TTL_MS = 6 * 60 * 60_000;
const MAX = 60;

/** Rounded to ~100m so nudging the middle of the plans re-uses the same answer. */
const keyOf = (centre, radiusKm) => `${centre.lat.toFixed(3)},${centre.lng.toFixed(3)}|${radiusKm}`;

export async function bedsNear(centre, radiusKm) {
  const key = keyOf(centre, radiusKm);
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { beds: hit.beds, cached: true };
  const found = await osmSource.search({ center: centre, radiusKm, categories: ['stay'], limit: 200 });
  const seen = new Set();
  const beds = [];
  for (const v of found) {
    const ref = `${v.source}:${v.sourcePlaceId}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    beds.push({ ...v, venueRef: ref });
  }
  kept.delete(key);
  kept.set(key, { at: Date.now(), beds });
  while (kept.size > MAX) kept.delete(kept.keys().next().value);
  return { beds, cached: false };
}

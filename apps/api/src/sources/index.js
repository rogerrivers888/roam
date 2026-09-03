// The single internal source interface (Technical Constraints §2, §13.4).
//
// Sources will be switched on and off throughout V1 and V2, so everything above
// this layer works against resolved venues and never against a provider's shape.
// Only the fixture source is registered today; Google, Yelp and TripAdvisor
// adapters slot in here without changing any caller.

import { fixturesSource } from './fixtures.js';

const REGISTRY = [fixturesSource];

/** Sources are enabled by config, not by code change (Epic 2 C8). */
export function enabledSources() {
  const configured = (process.env.ROAM_SOURCES || 'fixtures')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return REGISTRY.filter((s) => configured.includes(s.key));
}

const normaliseName = (name) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(the|a|an|restaurant|cafe|bar|pub)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

function metresBetween(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Confidence that two provider records describe the same establishment.
 * No shared identifier exists across Google, Yelp and TripAdvisor, so this is
 * inferred from normalised name and coordinate proximity (Technical Constraints §5).
 */
export function matchConfidence(a, b) {
  const sameName = normaliseName(a.name) === normaliseName(b.name);
  const distance = metresBetween(a, b);
  if (!sameName) return 0;
  if (distance <= 50) return 0.95;
  if (distance <= 150) return 0.8;
  if (distance <= 400) return 0.55;
  // Same name far apart is the chain case — deliberately below the threshold.
  return 0.2;
}

export const MERGE_THRESHOLD = Number(process.env.ROAM_MERGE_THRESHOLD || 0.75);

/**
 * Fold raw provider records into resolved venues, carrying per-field provenance.
 *
 * Below the confidence threshold records are kept SEPARATE (Epic 2 C9): showing
 * two cards for one restaurant is an annoyance, merging two restaurants into one
 * card sends a family to the wrong place.
 */
export function resolveVenues(rawRecords) {
  const resolved = [];

  for (const record of rawRecords) {
    const candidate = resolved.find((r) => matchConfidence(r, record) >= MERGE_THRESHOLD);

    if (!candidate) {
      resolved.push({
        key: `${record.source}:${record.sourcePlaceId}`,
        ...record,
        contributingSources: [record.source],
        // Which source supplied each displayed field, and — once licensed
        // sources are live — when that field must be discarded.
        provenance: Object.fromEntries(
          ['name', 'category', 'rating', 'priceLevel', 'lat', 'lng'].map((f) => [
            f,
            { source: record.source, expiresAt: null },
          ]),
        ),
        conflicts: [],
        attribution: [record.source],
      });
      continue;
    }

    // Disagreements are retained rather than discarded — they are signal
    // (Epic 2 C2, Technical Constraints §5).
    for (const field of ['name', 'category', 'rating', 'priceLevel']) {
      if (record[field] != null && candidate[field] !== record[field]) {
        candidate.conflicts.push({
          field,
          held: candidate[field],
          heldSource: candidate.provenance[field]?.source,
          offered: record[field],
          offeredSource: record.source,
        });
      }
    }
    if (!candidate.contributingSources.includes(record.source)) {
      candidate.contributingSources.push(record.source);
      candidate.attribution.push(record.source);
    }
  }

  return resolved;
}

/** Fan out across every enabled source; one failing source must not block a search (Epic 2 C7). */
export async function searchAllSources(params) {
  const sources = enabledSources();
  const settled = await Promise.allSettled(sources.map((s) => s.search(params)));

  const raw = [];
  const degraded = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      raw.push(...outcome.value);
    } else {
      degraded.push({ source: sources[i].key, error: String(outcome.reason?.message || outcome.reason) });
    }
  });

  return { venues: resolveVenues(raw), degraded, sourcesQueried: sources.map((s) => s.key) };
}

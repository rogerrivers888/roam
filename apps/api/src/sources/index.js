// The single internal source interface (Technical Constraints §2, §13.4).
//
// Sources will be switched on and off throughout V1 and V2, so everything above
// this layer works against resolved venues and never against a provider's shape.
// Only the fixture source is registered today; Google, Yelp and TripAdvisor
// adapters slot in here without changing any caller.

import { fixturesSource } from './fixtures.js';
import { osmSource } from './osm.js';
import { googleSource } from './google.js';
import { tripadvisorSource } from './tripadvisor.js';
import { ticketmasterSource } from './ticketmaster.js';
import { seatgeekSource } from './seatgeek.js';
import { predicthqSource } from './predicthq.js';
import { datathistleSource } from './datathistle.js';
import { localScoutSource } from './localscout.js';
import { detectChain } from '../domain/chains.js';

// Licensed sources register here and switch on when their key exists;
// ROAM_SOURCES still narrows the set (Epic 2 C10: no code change to enable/disable).
const REGISTRY = [fixturesSource, osmSource, googleSource, tripadvisorSource, ticketmasterSource, seatgeekSource, predicthqSource, datathistleSource, localScoutSource];

/** Sources that return timed events, so "nothing on" can be told from "not looked". */
export const eventSources = () => enabledSources().filter((s) => s.events);

/**
 * Sources are enabled by config, not by code change (Epic 2 C8).
 *
 * A source marked `optIn` (Tripadvisor: billed per location returned, 1,000
 * free for the account's lifetime) is live but silent: it only searches when
 * the request names it in `sources`. `includeOptIn: true` lists them all,
 * which the status endpoint and the detail view need.
 */
export function enabledSources({ includeOptIn = [] } = {}) {
  const configured = (process.env.ROAM_SOURCES || 'fixtures,osm,google,tripadvisor,ticketmaster,seatgeek,predicthq,datathistle,scout')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wanted = (key) => includeOptIn === true || (Array.isArray(includeOptIn) && includeOptIn.includes(key));
  return REGISTRY.filter((s) => configured.includes(s.key) && (typeof s.enabled !== 'function' || s.enabled()) && (!s.optIn || wanted(s.key)));
}

/** Parse a request's `sources` opt-in list ("tripadvisor" or "tripadvisor,other"). */
export const optInFrom = (raw) => (Array.isArray(raw) ? raw : String(raw || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

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
        ...detectChain(record),
        contributingSources: [record.source],
        // Which source supplied each displayed field, and — once licensed
        // sources are live — when that field must be discarded.
        provenance: Object.fromEntries(
          ['name', 'category', 'rating', 'ratingCount', 'priceLevel', 'lat', 'lng'].map((f) => [
            f,
            { source: record.source, expiresAt: null },
          ]),
        ),
        conflicts: [],
        attribution: [record.source],
      });
      continue;
    }

    // Per-field precedence (Technical Constraints §5): a licensed source that
    // carries ratings, photos, hours or family flags wins those fields; the
    // open source keeps what it uniquely knows (dietary tags, cuisines).
    for (const field of ['rating', 'ratingCount', 'photos', 'openingHours', 'goodForChildren', 'menuForChildren', 'reservable', 'priceLevel', 'summary', 'website', 'mapsUrl', 'externalUrl', 'justification']) {
      if (record[field] != null && (candidate[field] == null || (record.source === 'google' && candidate.source !== 'google'))) {
        candidate[field] = record[field];
        candidate.provenance[field] = { source: record.source, expiresAt: record.source === 'osm' ? null : 'session' };
      }
    }
    if (!candidate.dietaryOptions?.length && record.dietaryOptions?.length) candidate.dietaryOptions = record.dietaryOptions;
    if (!candidate.chain) Object.assign(candidate, detectChain({ ...record, chain: undefined }));
    if (!candidate.address && record.address) candidate.address = record.address;
    if (record.cuisines?.length) candidate.cuisines = [...new Set([...(candidate.cuisines || []), ...record.cuisines])];
    if (record.experiences?.length) candidate.experiences = [...new Set([...(candidate.experiences || []), ...record.experiences])];
    candidate.attributionText = [...new Set([candidate.attributionText || candidate.attribution?.text || candidate.attributionLabel, record.attribution].filter(Boolean))].join(' · ');

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

// Venues seen recently, by ref, so a detail view after a search is instant and
// does not re-query the provider. Only sources whose terms permit retention
// (fixtures, OSM) are remembered; a licensed source must opt out here.
// Google/Tripadvisor/Ticketmaster display content may not be held — even in memory across sessions.
const RETAINABLE = new Set(['fixtures', 'osm']);
const recent = new Map();
const RECENT_MAX = 2000;
export function rememberVenues(venues) {
  for (const v of venues) {
    if (!RETAINABLE.has(v.source)) continue;
    const key = `${v.source}:${v.sourcePlaceId}`;
    recent.delete(key);
    recent.set(key, v);
    if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
  }
}
export const recallVenue = (ref) => recent.get(ref) ?? null;

/** Fan out across every enabled source; one failing source must not block a search (Epic 2 C7). */
export async function searchAllSources(params) {
  const sources = enabledSources({ includeOptIn: optInFrom(params.sources) });
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

  rememberVenues(raw);
  return { venues: resolveVenues(raw), degraded, sourcesQueried: sources.map((s) => s.key) };
}

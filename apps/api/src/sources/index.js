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
import { query } from '../db.js';

// Licensed sources register here and switch on when their key exists;
// ROAM_SOURCES still narrows the set (Epic 2 C10: no code change to enable/disable).
const REGISTRY = [fixturesSource, osmSource, googleSource, tripadvisorSource, ticketmasterSource, seatgeekSource, predicthqSource, datathistleSource, localScoutSource];

/** Sources that return timed events, so "nothing on" can be told from "not looked". */
export const eventSources = () => enabledSources().filter((s) => s.events);

/**
 * Sources are enabled by config, not by code change (Epic 2 C8).
 *
 * `only` — an explicit set for this search (the app's source picker, or a
 * trip's saved sources); anything else live is left out, and an opt-in source
 * runs only when named here. With no `only`, every live source runs except the
 * opt-in ones. `includeOptIn: true` lists everything live, which the status
 * endpoint and the detail view need.
 *
 * Tripadvisor is opt-in: billed per location returned, 1,000 free for the
 * account's lifetime.
 */
// Sources the owner has switched off in Settings › Providers (app_settings
// 'sources.off'). Loaded once at start and kept in memory: enabledSources()
// is synchronous and called on every search.
let offKeys = new Set();
export async function loadSourceSettings() {
  try {
    const { rows } = await query("select value from app_settings where key = 'sources.off'");
    offKeys = new Set(Array.isArray(rows[0]?.value) ? rows[0].value.map(String) : []);
  } catch (err) {
    console.warn(`source settings not loaded: ${err.message}`);
  }
  return [...offKeys];
}
export async function setSourceOff(key, off) {
  const next = new Set(offKeys);
  if (off) next.add(key); else next.delete(key);
  await query("insert into app_settings (key, value, updated_at) values ('sources.off', $1, now()) on conflict (key) do update set value = excluded.value, updated_at = now()", [JSON.stringify([...next])]);
  offKeys = next;
  return [...offKeys];
}
/** Whether a source has what it needs to run (its key or flag), regardless of the owner's switch. */
export const sourceHasKey = (key) => { const s = REGISTRY.find((x) => x.key === key); return Boolean(s && (typeof s.enabled !== 'function' || s.enabled())); };
export const sourceOff = (key) => offKeys.has(key);
export const sourceKeys = () => REGISTRY.map((s) => s.key);

export function enabledSources({ only = null, includeOptIn = false } = {}) {
  const configured = (process.env.ROAM_SOURCES || 'fixtures,osm,google,tripadvisor,ticketmaster,seatgeek,predicthq,datathistle,scout')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const live = REGISTRY.filter((s) => configured.includes(s.key) && !offKeys.has(s.key) && (typeof s.enabled !== 'function' || s.enabled()));
  if (Array.isArray(only) && only.length) return live.filter((s) => only.includes(s.key));
  if (includeOptIn) return live;
  return live.filter((s) => !s.optIn);
}

/** Keys of the sources a search runs when nothing is picked. */
export const defaultSourceKeys = () => enabledSources().map((s) => s.key);

/** Parse a request's `sources` list ("osm,google" or an array) into keys. */
export const optInFrom = (raw) => (Array.isArray(raw) ? raw : String(raw || '').split(',')).map((s) => String(s).trim()).filter((s) => s && s !== 'default');

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
  const only = optInFrom(params.sources);
  const sources = enabledSources({ only });
  // What each provider billed for during this search (see meter.js).
  const meter = params.meter && typeof params.meter === 'object' ? params.meter : {};
  const settled = await Promise.allSettled(sources.map((s) => s.search({ ...params, meter, sources: sources.map((x) => x.key) })));

  const raw = [];
  const degraded = [];
  // How many records each source returned, before the resolver folds them (the admin source view).
  const rawCounts = {};
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      raw.push(...outcome.value);
      rawCounts[sources[i].key] = outcome.value.length;
    } else {
      degraded.push({ source: sources[i].key, error: String(outcome.reason?.message || outcome.reason) });
    }
  });

  // Second pass: a source that enriches (Tripadvisor) looks up what the others
  // found and adds its own records for the resolver to merge.
  for (const s of sources) {
    if (typeof s.enrich !== 'function' || sources.length < 2) continue;
    try {
      const extra = await s.enrich(raw, { ...params, meter });
      rawCounts[s.key] = (rawCounts[s.key] || 0) + extra.length;
      raw.push(...extra);
    } catch (err) {
      degraded.push({ source: s.key, error: String(err?.message || err) });
    }
  }

  rememberVenues(raw);
  const venues = resolveVenues(raw);
  const resolvedCounts = {};
  for (const v of venues) for (const k of v.contributingSources || [v.source]) resolvedCounts[k] = (resolvedCounts[k] || 0) + 1;
  return { venues, degraded, sourcesQueried: sources.map((s) => s.key), units: meter, rawCounts, resolvedCounts };
}

// ---------------------------------------------------------------------------
// The corridor: what is on the way (Epic 4 C2, Requirements §5 "Corridor").
// ---------------------------------------------------------------------------

/** A few points spread along the line between two ends, the ends themselves left out. */
export function pointsAlong(from, to, count) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const f = i / (count + 1);
    out.push({ lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f, fraction: f });
  }
  return out;
}

/**
 * Places along a journey rather than around either end.
 *
 * With Google on, the journey's own encoded polyline goes to Places text
 * search, which ranks by the smallest detour a place adds between the two ends
 * (Technical Constraints §3.1) — two searches, one for a meal and one for
 * something to do, however long the drive is. Without a key there is no
 * polyline, so the corridor is sampled instead: a few points along the line,
 * each searched at a radius wide enough to overlap its neighbours.
 *
 * The corridor is a bias and not a restriction in either case: Google does not
 * guarantee a result sits on the route, and a sampled circle certainly does
 * not. The caller must compute and display what each stop costs in detour.
 */
export async function searchCorridor({ encodedPolyline, origin, destination, sources = null, meter = {}, samples = 3, radiusKm = null }) {
  const only = optInFrom(sources);
  const live = enabledSources({ only });
  const google = live.find((s) => s.key === 'google');
  const raw = [];
  const degraded = [];
  const queried = new Set();

  if (google && encodedPolyline) {
    const searches = [
      ['food', 'restaurant or pub for a meal on the way'],
      ['things', 'places worth stopping at on the way — attractions, gardens, castles, viewpoints'],
    ];
    const settled = await Promise.allSettled(searches.map(([, q]) => google.searchAlongRoute({ encodedPolyline, query: q, limit: 20, meter })));
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') { raw.push(...outcome.value); queried.add('google'); }
      else degraded.push({ source: `google (${searches[i][0]} along the route)`, error: String(outcome.reason?.message || outcome.reason) });
    });
  } else if (origin && destination) {
    const km = metresBetween(origin, destination) / 1000;
    const radius = radiusKm ?? Math.min(15, Math.max(5, km / (samples * 1.6)));
    const at = pointsAlong(origin, destination, samples);
    const settled = await Promise.allSettled(at.map((p) => searchAllSources({ center: p, radiusKm: radius, categories: [], query: '', sources })));
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') { degraded.push({ source: 'corridor', error: String(outcome.reason?.message || outcome.reason) }); continue; }
      // Already resolved venues; the second resolve below folds the overlaps between samples.
      raw.push(...outcome.value.venues);
      for (const k of outcome.value.sourcesQueried) queried.add(k);
      for (const [k, v] of Object.entries(outcome.value.units || {})) meter[k] = (meter[k] || 0) + v;
      degraded.push(...outcome.value.degraded);
    }
  }

  rememberVenues(raw);
  return { venues: resolveVenues(raw), degraded, sourcesQueried: [...queried], units: meter };
}

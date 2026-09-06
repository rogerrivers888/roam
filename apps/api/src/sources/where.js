// Where a place is, at a glance (owner, 3 Sep 2026): the postcode district and
// the nearest station with the lines it serves. Inside Greater London that is
// Transport for London's StopPoint search (tube, Elizabeth line, DLR,
// Overground, rail, tram — no key, ~50 requests a minute); elsewhere it is the
// nearest railway station in OpenStreetMap. The postcode comes from the same
// reverse geocode the atlas already does, at street zoom.
//
// Everything here is looked up once per place and stored on household_places:
// a station name and a postcode district are open data, not licensed content.

import * as providerCalls from '../repositories/providerCalls.js';
import * as transit from './transit.js';
import * as transitRepo from '../repositories/transit.js';
import * as atlasRepo from '../repositories/atlas.js';
import { reverseGeocode } from './geocode.js';

const TFL = 'https://api.tfl.gov.uk/StopPoint';
// Mirrors, and which of them are answering today: sources/overpass.js.
const LONDON = { s: 51.28, n: 51.70, w: -0.51, e: 0.34 };
export const inLondon = (lat, lng) => lat >= LONDON.s && lat <= LONDON.n && lng >= LONDON.w && lng <= LONDON.e;

/** "W1T 2NB" → "W1T"; "BA1 1LZ" → "BA1"; a foreign code ("00186") is kept whole. */
export const postcodeDistrict = (pc) => {
  if (!pc) return null;
  const s = String(pc).trim().toUpperCase();
  return s.split(/\s+/)[0] || null;
};

/**
 * The station as anyone would say it. Transport for London writes the line into
 * the name where two stations share one ("Hammersmith (Dist&Picc Line)"), which
 * is more than a row needs (owner, 4 Sep 2026: "just show the tube station").
 */
export const cleanStation = (n) => {
  const s = String(n || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // "Battersea Power Station Underground Station" is Battersea Power Station:
  // drop the qualified suffix if there is one, and only otherwise a bare "Station".
  const unqualified = s.replace(/\s+(Underground|Rail|DLR|Overground|Tram)\s+Station$/i, '');
  return (unqualified === s ? s.replace(/\s+Station$/i, '') : unqualified).trim();
};
const cleanName = cleanStation;

async function tflStation(lat, lng) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), stopTypes: 'NaptanMetroStation,NaptanRailStation', radius: '1500' });
  const res = await fetch(`${TFL}?${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`TfL ${res.status}`);
  const data = await res.json();
  const stops = (data.stopPoints || []).filter((s) => Array.isArray(s.lines) && s.lines.length).sort((a, b) => a.distance - b.distance);
  const s = stops[0];
  if (!s) return null;
  const modes = s.modes || [];
  const kind = modes.find((m) => m !== 'bus') || (s.stopType === 'NaptanMetroStation' ? 'tube' : 'national-rail');
  // National Rail "lines" are operators; keep them, the web shows the first few.
  return { name: cleanName(s.commonName), lines: [...new Set(s.lines.map((l) => l.name))], kind, distanceM: Math.round(s.distance) };
}


// Which OSM tags are a stop somebody could travel from, and which are a ride:
// sources/transit.js `isServiceStop`. One copy, under test, used both by the
// harvest that fills the table and by anything reading it.

/**
 * Every stop within reach of a point — trains, tube, tram and light rail.
 *
 * Read from our own table, not from Overpass. That is the whole reliability
 * story: the old version asked a volunteer server on every search, and on
 * 6 Sep 2026 three of its four mirrors were failing at once, so the station
 * criteria silently returned nothing and the Stay tab emptied. Stations are
 * ODbL open data we may keep for good, Britain is about 3,500 rows, and a
 * bounding-box query cannot time out.
 *
 * Overpass is still the source of the data, just not on the critical path. An
 * area nobody has harvested falls back to a live lookup and what comes back is
 * written down, so the table fills itself in as the app is used. When that
 * fallback fails, whatever we already hold is returned rather than an
 * exception: half an answer from the database beats none from the network.
 *
 * Returns `{ stops, source, coverage }`. `source` is 'held' when it came from
 * the table, 'live' when Overpass was asked, and 'held-stale' when Overpass
 * was asked and refused — which is the one case a screen should mention.
 */
export async function stationsNear(lat, lng, radiusM = 8000, { kinds = null } = {}) {
  const held = await transitRepo.stopsNear(lat, lng, radiusM, { kinds });
  const coverage = await transitRepo.coverageAt(lat, lng);
  if (coverage) return { stops: held, source: 'held', coverage };

  // Never looked here. Ask once, keep what comes back, and record that this
  // patch is now covered so the next search is a database read.
  try {
    const box = transit.boxAround(lat, lng, Math.max(radiusM, 12_000));
    const found = await transit.fetchStops(box, { timeoutMs: 20_000 });
    await transitRepo.upsertStops(found);
    await transitRepo.recordCoverage(
      { ...box, area: `live:${lat.toFixed(2)},${lng.toFixed(2)}`, label: 'filled in by a search' },
      found.length,
      'live',
    );
    return { stops: await transitRepo.stopsNear(lat, lng, radiusM, { kinds }), source: 'live', coverage: null };
  } catch (err) {
    // Nothing held and nothing fetched is the only genuinely empty case, and it
    // is still not an exception: the caller drops the condition and says so.
    return { stops: held, source: 'held-stale', coverage: null, error: String(err?.message || err) };
  }
}

/**
 * The nearest stop to a place, for the line under its name.
 *
 * The same held table as `stationsNear`, for the same reason, and with one bug
 * fixed on the way: this used to take the nearest `railway=station` of any
 * kind, so a place beside Legoland got "Hill Train Bottom" as its station. The
 * shared classifier (sources/transit.js) never let those into the table.
 */
async function osmStation(lat, lng) {
  const { stops } = await stationsNear(lat, lng, 5000);
  const n = stops[0];
  if (!n) return null;
  return {
    name: n.name,
    lines: n.network ? [n.network] : [],
    // The word the rest of Roam has always used for each of these.
    kind: n.kind === 'subway' ? 'metro' : n.kind === 'rail' ? 'rail' : n.kind === 'tram' ? 'tram' : 'light-rail',
    distanceM: n.distanceM,
  };
}

/**
 * Look up where a place is. Returns { postcode, station, failed } where station
 * is { name, lines, kind, distanceM } or null, and `failed` means a provider
 * refused rather than answered — the caller should ask again later. Every outbound call is attributed
 * to the household in provider_calls.
 */
export async function whereIs(lat, lng, { householdId = null } = {}) {
  let postcode = null;
  try {
    const geo = await reverseGeocode(lat, lng, { zoom: 18 });
    postcode = postcodeDistrict(geo?.address?.postcode);
    await providerCalls.record(householdId, 'osm-nominatim', 'atlas.where', JSON.stringify({ 'osm-nominatim': 1 })).catch(() => null);
  } catch { /* the postcode is a nicety */ }
  let station = null;
  // The bounding box is generous, so somewhere just outside Transport for
  // London's area (Thorpe Park, on the Surrey edge) asks TfL, gets nothing,
  // and falls back to the map data like anywhere else in the country.
  const tried = [];
  // A provider that refuses (Overpass rate-limits by IP) is different from one
  // that answers "nothing near here": the first must be asked again later, so
  // the row is not stamped as checked.
  let failed = false;
  const attempt = async (name, fn) => {
    if (station) return;
    tried.push(name);
    try { station = await fn(); } catch { failed = true; }
  };
  if (inLondon(lat, lng)) await attempt('tfl', () => tflStation(lat, lng));
  await attempt('osm-overpass', () => osmStation(lat, lng));
  for (const provider of tried) {
    await providerCalls.record(householdId, provider, 'atlas.where', JSON.stringify({ [provider]: 1 })).catch(() => null);
  }
  return { postcode, station, failed };
}

/** Fill in postcode and station for atlas rows that have not been looked up yet, a few at a time. */
export async function fillWhere(householdId, rows, { limit = 6 } = {}) {
  const todo = rows.filter((r) => r.lat != null && r.lng != null && !r.where_checked).slice(0, limit);
  for (const r of todo) {
    const w = await whereIs(r.lat, r.lng, { householdId });
    await atlasRepo.saveWhere(householdId, r.venue_ref, { ...w, checkedAt: w.failed ? null : new Date() }).catch(() => null);
  }
  return todo.length;
}

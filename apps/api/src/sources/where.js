// Where a place is, at a glance (owner, 3 Sep 2026): the postcode district and
// the nearest station with the lines it serves. Inside Greater London that is
// Transport for London's StopPoint search (tube, Elizabeth line, DLR,
// Overground, rail, tram — no key, ~50 requests a minute); elsewhere it is the
// nearest railway station in OpenStreetMap. The postcode comes from the same
// reverse geocode the atlas already does, at street zoom.
//
// Everything here is looked up once per place and stored on household_places:
// a station name and a postcode district are open data, not licensed content.

import { query } from '../db.js';
import { reverseGeocode } from './geocode.js';

const TFL = 'https://api.tfl.gov.uk/StopPoint';
const OVERPASS = (process.env.ROAM_OVERPASS_URLS || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter').split(',');
const LONDON = { s: 51.28, n: 51.70, w: -0.51, e: 0.34 };
export const inLondon = (lat, lng) => lat >= LONDON.s && lat <= LONDON.n && lng >= LONDON.w && lng <= LONDON.e;

/** "W1T 2NB" → "W1T"; "BA1 1LZ" → "BA1"; a foreign code ("00186") is kept whole. */
export const postcodeDistrict = (pc) => {
  if (!pc) return null;
  const s = String(pc).trim().toUpperCase();
  return s.split(/\s+/)[0] || null;
};

const cleanName = (n) => String(n || '').replace(/\s+(Underground|Rail|DLR|Overground|Tram)\s+Station$/i, '').replace(/\s+Station$/i, '').trim();

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

const haversineM = (a, b) => {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function osmStation(lat, lng) {
  const body = `[out:json][timeout:12];node["railway"="station"](around:5000,${lat},${lng});out body 40;`;
  let data = null, lastErr = null;
  for (const url of OVERPASS) {
    try {
      // Overpass answers 406 without a user agent (the same header the OSM source sends).
      const res = await fetch(url, {
        method: 'POST',
        body: `data=${encodeURIComponent(body)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Roam/0.1 (+https://github.com/rogerrivers888/roam)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      data = await res.json();
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error('Overpass unavailable');
  const nodes = (data.elements || []).filter((n) => n.tags?.name).map((n) => ({ ...n, d: haversineM({ lat, lng }, { lat: n.lat, lng: n.lon }) })).sort((a, b) => a.d - b.d);
  const n = nodes[0];
  if (!n) return null;
  const t = n.tags;
  const lines = String(t.line || t['line:name'] || '').split(';').map((x) => x.trim()).filter(Boolean);
  const kind = t.station === 'subway' ? 'metro' : t.station === 'light_rail' ? 'tram' : 'rail';
  return { name: cleanName(t.name), lines, kind, distanceM: Math.round(n.d) };
}

/**
 * Look up where a place is. Returns { postcode, station } where station is
 * { name, lines, kind, distanceM } or null. Every outbound call is attributed
 * to the household in provider_calls.
 */
export async function whereIs(lat, lng, { householdId = null } = {}) {
  let postcode = null;
  try {
    const geo = await reverseGeocode(lat, lng, { zoom: 18 });
    postcode = postcodeDistrict(geo?.address?.postcode);
    await query('insert into provider_calls (household_id, provider, purpose, units) values ($1, $2, $3, $4)', [householdId, 'osm-nominatim', 'atlas.where', JSON.stringify({ 'osm-nominatim': 1 })]).catch(() => null);
  } catch { /* the postcode is a nicety */ }
  let station = null;
  // The bounding box is generous, so somewhere just outside Transport for
  // London's area (Thorpe Park, on the Surrey edge) asks TfL, gets nothing,
  // and falls back to the map data like anywhere else in the country.
  const tried = [];
  const attempt = async (name, fn) => {
    if (station) return;
    tried.push(name);
    try { station = await fn(); } catch { /* no station is fine */ }
  };
  if (inLondon(lat, lng)) await attempt('tfl', () => tflStation(lat, lng));
  await attempt('osm-overpass', () => osmStation(lat, lng));
  for (const provider of tried) {
    await query('insert into provider_calls (household_id, provider, purpose, units) values ($1, $2, $3, $4)', [householdId, provider, 'atlas.where', JSON.stringify({ [provider]: 1 })]).catch(() => null);
  }
  return { postcode, station };
}

/** Fill in postcode and station for atlas rows that have not been looked up yet, a few at a time. */
export async function fillWhere(householdId, rows, { limit = 6 } = {}) {
  const todo = rows.filter((r) => r.lat != null && r.lng != null && !r.where_checked).slice(0, limit);
  for (const r of todo) {
    const w = await whereIs(r.lat, r.lng, { householdId });
    await query(
      `update household_places set postcode = $3, station = $4, station_lines = $5, station_kind = $6, where_checked = now()
        where household_id = $1 and venue_ref = $2`,
      [householdId, r.venue_ref, w.postcode, w.station?.name ?? null, w.station ? JSON.stringify(w.station.lines) : null, w.station?.kind ?? null],
    ).catch(() => null);
  }
  return todo.length;
}

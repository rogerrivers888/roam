// "Where are we going?" — cities, towns and regions, as somebody types.
//
// This is a different question from geocoding an address, and it needs a
// different index. Nominatim (sources/geocode.js) matches whole words, so
// "Lisb" finds nothing and "Bat" finds Bath only by luck; it also answers with
// streets, shops and mountains, which is not what a box asking for a city or
// region should ever offer (owner, 4 Sep 2026: "It should only look up cities
// beginning with Bath, not streets beginning with Bath").
//
// Photon is Komoot's open typeahead over the same OpenStreetMap data: prefix
// matching on the last word, free, no key, ODbL like Nominatim — so what comes
// back may be kept and shown with attribution (Technical Constraints §4). It is
// only ever asked for areas; addresses and hotels still go through Nominatim.
// If it is unreachable, the Nominatim area filter answers instead, slower and
// without the prefix matching, so the box still works.

import { kmBetween } from '../domain/travel.js';
import { geocodeAreas, localityOf, GEOCODE_ATTRIBUTION } from './geocode.js';

const BASE = process.env.ROAM_PHOTON_URL || 'https://photon.komoot.io';
const USER_AGENT = 'Roam/0.1 (private beta; +https://github.com/rogerrivers888/roam)';
export const AREA_ATTRIBUTION = `${GEOCODE_ATTRIBUTION} · search by Photon`;

/**
 * The kinds of thing you can say you are going to. Everything else Photon knows
 * about — roads, shops, stations, lakes, peaks — is thrown away here rather
 * than shown and apologised for.
 */
const ALLOW = new Set([
  ...['city', 'town', 'village', 'hamlet', 'borough', 'suburb', 'quarter', 'municipality',
    'district', 'county', 'state', 'region', 'province', 'island', 'archipelago'].map((v) => `place:${v}`),
  'boundary:administrative', 'boundary:protected_area', 'boundary:national_park',
  'leisure:nature_reserve', 'natural:mountain_range',
]);

/** What to call it in one word, under the name. */
const WORDS = {
  city: 'city', town: 'town', village: 'village', hamlet: 'hamlet', municipality: 'municipality',
  borough: 'borough', district: 'district', suburb: 'area', quarter: 'area', administrative: 'area',
  county: 'county', state: 'state', region: 'region', province: 'province',
  island: 'island', archipelago: 'islands',
  protected_area: 'national park', national_park: 'national park', nature_reserve: 'nature reserve',
  mountain_range: 'mountains',
};

const OSM_TYPE = { N: 'node', W: 'way', R: 'relation' };

// The same short memory Nominatim gets: typing "Ba", "Bat", "Bath" asks three
// questions, and backspacing asks the first two again.
const recent = new Map();
const RECENT_MS = 10 * 60_000;
const RECENT_MAX = 400;
let calls = 0;
export function providerCalls() { return calls; }

async function ask(url) {
  const seen = recent.get(url);
  if (seen && Date.now() - seen.at < RECENT_MS) return seen.body;
  calls += 1;
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const body = await res.json();
  recent.set(url, { at: Date.now(), body });
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
  return body;
}

/** "Somerset · England · United Kingdom" — which one this is, never its name again. */
function whereLine(p, name) {
  const parts = [p.district, p.city, p.county, p.state, p.country]
    .map((s) => (s ? String(s).trim() : ''))
    .filter((s, i, arr) => s && s.toLowerCase() !== name.toLowerCase() && arr.indexOf(s) === i);
  return parts.slice(-3).join(' · ');
}

function shape(f) {
  const p = f.properties || {};
  const [lng, lat] = f.geometry?.coordinates || [];
  // "Greater London" and "City of Westminster" are what the council is called,
  // not where you are going: the same normalisation the atlas files places under.
  const name = localityOf({ city: p.name, country_code: p.countrycode }, [p.name, p.state, p.country].filter(Boolean).join(', ')) || p.name;
  return {
    label: name,
    // The name is the whole answer here; the line under it only says which one.
    formatted: name,
    name,
    where: whereLine(p, name),
    displayName: [name, whereLine(p, name).replace(/ · /g, ', ')].filter(Boolean).join(', '),
    address: { line1: name, area: null, town: name, region: p.state || p.county || null, postcode: null, country: p.country || null },
    lat: Number(lat),
    lng: Number(lng),
    country: p.country || null,
    countryCode: p.countrycode ? String(p.countrycode).toUpperCase() : null,
    // An area is its own locality: the atlas and a trip both file under this name.
    locality: name,
    kind: p.osm_value || null,
    kindWord: WORDS[p.osm_value] || null,
    source: 'osm',
    sourcePlaceId: p.osm_id ? `${OSM_TYPE[p.osm_type] || p.osm_type}/${p.osm_id}` : null,
    attribution: AREA_ATTRIBUTION,
    matchedBy: 'area',
  };
}

// Photon ranks by its own popularity, which puts Bat Yam above Bath for "bat".
// Two things move a result up: it is near home (a family in Berkshire typing
// "bat" means Bath), and it is a place rather than a dot on the map. Both are
// worth a few places and no more — "new yor" must still be New York, not the
// nearest village, and "lisb" must be Lisbon, not Lisbourg.
const NEAR_KM = 800;
const NEAR_BOOST = 3;
const SIZE_COST = {
  city: 0, state: 0, region: 0, province: 0, county: 0, island: 0, archipelago: 0,
  protected_area: 0, national_park: 0, nature_reserve: 1, mountain_range: 0,
  town: 1, municipality: 1, borough: 1, administrative: 1, district: 2,
  suburb: 3, quarter: 3, village: 3, hamlet: 4,
};

/**
 * Cities, towns and regions matching what has been typed so far, best first.
 * One request per search, and no fallbacks to postcodes or streets: this runs
 * while somebody is still typing.
 */
export async function searchAreas(text, { limit = 6, near = null, countryCode = null } = {}) {
  const q = String(text || '').trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({ q, limit: '25', lang: 'en' });
  let features;
  try {
    features = (await ask(`${BASE}/api/?${params}`))?.features ?? [];
  } catch {
    // Photon is down or slow: the slower, whole-word search still answers.
    return geocodeAreas(q, { limit, near, countryCode });
  }

  const seen = new Set();
  const kept = [];
  features.forEach((f, rank) => {
    const p = f.properties || {};
    if (!ALLOW.has(`${p.osm_key}:${p.osm_value}`)) return;
    if (!p.name || !f.geometry?.coordinates) return;
    if (countryCode && String(p.countrycode || '').toUpperCase() !== String(countryCode).toUpperCase()) return;
    // A country is not a destination (owner, 3 Sep 2026).
    if (p.country && String(p.name).trim().toLowerCase() === String(p.country).trim().toLowerCase()) return;
    const place = shape(f);
    // The same place twice — OSM has Lisbon as a city and again as a boundary —
    // is one row. Two Baths in the same country are not: the county tells them
    // apart (Sagadahoc, Maine and Steuben, New York).
    const key = `${place.label.toLowerCase()}|${place.countryCode || ''}|${place.where.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const home = near?.lat != null && kmBetween({ lat: near.lat, lng: near.lng }, { lat: place.lat, lng: place.lng }) <= NEAR_KM;
    kept.push({ place, rank: rank + (SIZE_COST[p.osm_value] ?? 2) - (home ? NEAR_BOOST : 0) });
  });
  return kept.sort((a, b) => a.rank - b.rank).slice(0, limit).map((k) => k.place);
}

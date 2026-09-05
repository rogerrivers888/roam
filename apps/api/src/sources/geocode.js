// Geocoding via OpenStreetMap Nominatim.
//
// Open data (ODbL): results may be stored with attribution — Technical
// Constraints §4 lists Overture/OSM-backed sources as the one class of source
// with no retention limit. Nominatim's usage policy asks for a real User-Agent,
// at most one request per second, and no bulk use; a family's searches are far
// below that. A commercial geocoder slots in behind the same two functions.

const BASE = process.env.ROAM_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'Roam/0.1 (private beta; +https://github.com/rogerrivers888/roam)';
export const GEOCODE_ATTRIBUTION = '© OpenStreetMap contributors';

let lastCall = 0;

// A short memory of what Nominatim has just said. Searching as somebody types
// asks about "Ba", "Bat", "Bath" in a row, and backspacing asks the earlier
// ones again; answering those from here is what makes the box feel instant,
// and it keeps a shared service's one-request-a-second easy to honour.
const recent = new Map();
const RECENT_MS = 10 * 60_000;
const RECENT_MAX = 400;

// Real requests made, so a route only writes a provider_calls row when one
// actually went out and a remembered answer costs the provider nothing.
let calls = 0;
export function providerCalls() { return calls; }

async function politeFetch(url) {
  const seen = recent.get(url);
  if (seen && Date.now() - seen.at < RECENT_MS) return seen.body;
  // Nominatim asks for ≤1 request/second.
  const wait = Math.max(0, lastCall + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  calls += 1;
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const body = await res.json();
  recent.set(url, { at: Date.now(), body });
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
  return body;
}

/** A full postal address, in the order people read it, from Nominatim's parts. */
function formatAddress(a, row) {
  const line1 = [a.house_name, a.house_number, a.road].filter(Boolean).join(' ').trim() || row.name || '';
  const area = a.suburb || a.neighbourhood || a.village || a.hamlet || null;
  const town = localityOf(a, row.display_name) || a.county || null;
  const parts = [line1, area, town, a.state, a.postcode, a.country].filter((p, i, arr) => p && arr.indexOf(p) === i);
  return parts.join(', ');
}

/**
 * The city a place files under in the atlas. Nominatim names London's 33
 * boroughs as cities ("City of Westminster", "London Borough of Camden") and
 * the whole as "Greater London", so a musical in Westminster and a museum in
 * Camden landed in different cities (owner, 3 Sep 2026: "which one is which?
 * they should be self-organising"). Anything inside Greater London is London;
 * "Greater X" elsewhere is X.
 */
export function localityOf(a, displayName = '') {
  const raw = a.city || a.town || a.village || a.suburb || a.county || a.state || null;
  if (!raw) return null;
  const inLondon = String(a.country_code || '').toLowerCase() === 'gb'
    && (/greater london/i.test(displayName) || /^greater london$/i.test(raw) || /^(city of london|city of westminster|london borough of )/i.test(raw) || /^london borough of /i.test(a.city_district || ''));
  if (inLondon) return 'London';
  // "Royal Borough of Windsor and Maidenhead", "City of Edinburgh": the council's name is not what people call the place.
  return raw.replace(/^Greater\s+/i, '').replace(/^(Royal |London |Metropolitan )?Borough of /i, '').replace(/^City of /i, '');
}

function shape(row) {
  const a = row.address || {};
  const locality = localityOf(a, row.display_name);
  return {
    label: shortLabel(row, locality),
    name: row.name || null,
    displayName: row.display_name,
    formatted: formatAddress(a, row),
    address: {
      line1: [a.house_name, a.house_number, a.road].filter(Boolean).join(' ') || row.name || null,
      area: a.suburb || a.neighbourhood || a.village || null,
      town: localityOf(a, row.display_name),
      region: a.state || a.county || null,
      postcode: a.postcode || null,
      country: a.country || null,
    },
    lat: Number(row.lat),
    lng: Number(row.lon),
    country: a.country || null,
    countryCode: a.country_code ? a.country_code.toUpperCase() : null,
    locality,
    // Nominatim's own breakdown, untouched. `locality` is the one answer most
    // callers want; this is for the caller that needs to know whether that
    // answer came from a town, a village or a council's name.
    parts: a,
    kind: row.type || row.class || null,
    source: 'osm',
    sourcePlaceId: `${row.osm_type}/${row.osm_id}`,
    attribution: GEOCODE_ATTRIBUTION,
  };
}

function shortLabel(row, locality) {
  // The city itself, asked for by name: "London", not "Greater London, London".
  if (locality && row.name && localityOf({ city: row.name, country_code: row.address?.country_code }, row.display_name) === locality) return locality;
  const name = row.name || row.display_name?.split(',')[0] || '';
  if (!locality || name.toLowerCase() === locality.toLowerCase()) return name;
  return `${name}, ${locality}`;
}

async function searchRaw(q, { limit, near, countryCode, bounded = false }) {
  const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: String(limit), 'accept-language': 'en' });
  if (near?.lat != null) {
    // Bias toward an area (home, or the city a trip is in). `bounded` turns the
    // bias into a hard limit: a hotel name typed for a trip in Rome must not
    // come back as the same chain's London hotels.
    const d = bounded ? 0.35 : 0.5;
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
    if (bounded) params.set('bounded', '1');
  }
  if (countryCode) params.set('countrycodes', String(countryCode).toLowerCase());
  return politeFetch(`${BASE}/search?${params}`);
}

async function searchOnce(q, opts) {
  return (await searchRaw(q, opts)).map(shape);
}

// UK-style postcodes; other countries' codes are usually plain digits that the
// town fallback handles well enough.
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

/**
 * Free text → candidate places, best first.
 *
 * Real addresses often fail as one string ("Fairways, Titlarks Hill, Ascot,
 * SL5 0JD" matches nothing), so the lookup degrades deliberately: the whole
 * thing, then without the first component (a house name), then the postcode,
 * then the town. When a fallback wins, the label keeps what the user typed so
 * "home" still reads as their address, and `matchedBy` says how precise it is.
 */
export async function geocode(text, { limit = 5, near = null, countryCode = null, within = false, kind = null } = {}) {
  const q = String(text || '').trim();
  if (!q) return [];
  // `within`: look inside the area around `near` first (a trip's city), then
  // anywhere in `countryCode` if that finds nothing. Never outside the country.
  const passes = within && near?.lat != null ? [{ bounded: true }, { bounded: false }] : [{ bounded: false }];

  const attempts = [{ q, matchedBy: 'address' }];
  // A hotel typed by its short name ("Cavalieri") is indexed under its full one
  // ("Rome Cavalieri, A Waldorf Astoria Hotel"); adding the word finds it, and
  // it must be tried first or a square of the same name wins. The result is the
  // real place, so it is an exact match, not a guess.
  if (kind === 'lodging' && !/\b(hotel|hostel|b&b|inn|resort|apartment|villa)\b/i.test(q)) attempts.unshift({ q: `${q} hotel`, matchedBy: 'address' });
  const parts = q.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) attempts.push({ q: parts.slice(1).join(', '), matchedBy: 'street' });
  const pc = POSTCODE.exec(q);
  if (pc) attempts.push({ q: pc[1].toUpperCase(), matchedBy: 'postcode' });
  if (parts.length >= 2) {
    // The town is usually the last non-country, non-postcode component.
    const town = [...parts].reverse().find((p) => !POSTCODE.test(p) && !/^(uk|united kingdom|england|scotland|wales|usa|united states)$/i.test(p) && p !== parts[0]);
    if (town) attempts.push({ q: town, matchedBy: 'town' });
  }

  const tried = new Set();
  for (const attempt of attempts) {
    const key = attempt.q.toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    let rows = [];
    for (const pass of passes) {
      rows = await searchOnce(attempt.q, { limit, near, countryCode, bounded: pass.bounded });
      if (rows.length) break;
    }
    if (rows.length) {
      if (attempt.matchedBy === 'address') return rows.map((r) => ({ ...r, matchedBy: 'address' }));
      // Approximate: keep the user's wording as the label, say how it was matched.
      // Keep the address exactly as the household wrote it; only the pin is ours.
      return rows.map((r) => ({
        ...r,
        label: q,
        formatted: q,
        displayName: `Placed by ${attempt.matchedBy}: ${r.displayName}`,
        matchedBy: attempt.matchedBy,
        approximate: true,
      }));
    }
  }
  return [];
}

/**
 * The kinds of thing you can say you are going to: somewhere people live, or a
 * named region. Never a street, a house, a shop or a mountain — "Bath" typed in
 * a box that asks for a city or region must not answer with Bath Road.
 *
 * Nominatim's own `featureType=settlement` filter is too narrow to use here: it
 * loses the Lake District, which is a national park rather than a settlement.
 * So we ask the ordinary way and keep the rows whose `addresstype` is a place
 * people go to.
 */
const AREA_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'municipality', 'borough', 'city_district', 'district', 'suburb', 'quarter',
  'county', 'state', 'state_district', 'province', 'region', 'island', 'archipelago',
  'national_park', 'protected_area', 'nature_reserve',
]);

/** What to call it in one word, under the name. */
const AREA_WORDS = {
  city: 'city', town: 'town', village: 'village', hamlet: 'hamlet', municipality: 'municipality',
  borough: 'borough', city_district: 'district', district: 'district', suburb: 'area', quarter: 'area',
  county: 'county', state: 'state', state_district: 'region', province: 'province', region: 'region',
  island: 'island', archipelago: 'islands',
  national_park: 'national park', protected_area: 'national park', nature_reserve: 'nature reserve',
};

/** An area is its own locality: the atlas and a trip both file under this name. */
function asArea(row, name) {
  const a = row.address || {};
  const where = String(row.display_name || '').split(',').map((s) => s.trim())
    .filter((s, i) => i > 0 && s && !/\d/.test(s) && s.toLowerCase() !== name.toLowerCase());
  return {
    ...shape(row),
    label: name,
    // The name is the whole answer here; the line under it only says which one.
    formatted: name,
    where: where.slice(-3).join(' · '),
    address: { line1: name, area: null, town: name, region: a.state || a.county || null, postcode: null, country: a.country || null },
    locality: name,
    kind: row.addresstype || row.type || null,
    kindWord: AREA_WORDS[row.addresstype || row.type] || null,
    matchedBy: 'area',
  };
}

/**
 * Somewhere you would say you were going: cities, towns and regions only.
 *
 * One request, no fallbacks: this runs while somebody is still typing, so it
 * never degrades to postcodes or streets the way `geocode` does for an address.
 * Nominatim matches the last word as a prefix, so three letters find Bath.
 */
export async function geocodeAreas(text, { limit = 6, near = null, countryCode = null } = {}) {
  const q = String(text || '').trim();
  if (q.length < 2) return [];
  // Ask for more than we show: the filter throws away the peaks, the roads and
  // the shops that a short prefix drags in.
  const rows = await searchRaw(q, { limit: Math.min(40, Math.max(limit * 5, 20)), near, countryCode });
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!AREA_TYPES.has(row.addresstype || row.type)) continue;
    const a = row.address || {};
    const name = row.name || String(row.display_name || '').split(',')[0].trim();
    if (!name) continue;
    // A country is not a destination (owner, 3 Sep 2026).
    if (a.country && name.trim().toLowerCase() === String(a.country).trim().toLowerCase()) continue;
    const key = `${name.toLowerCase()}|${a.country || ''}|${a.state || a.county || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asArea(row, name));
    if (out.length >= limit) break;
  }
  return out;
}

/** Coordinates → country and locality, for grouping trips by where they happened. */
export async function reverseGeocode(lat, lng, { zoom = 10 } = {}) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', addressdetails: '1', zoom: String(zoom), 'accept-language': 'en' });
  const row = await politeFetch(`${BASE}/reverse?${params}`);
  if (!row || row.error) return null;
  return shape(row);
}

/**
 * The named area a point sits in, with its real outline: the London borough,
 * the arrondissement, the comune. Nominatim simplifies the boundary for us
 * (`polygon_threshold`), so a borough arrives as fifty points rather than fifty
 * thousand — small enough to draw on a phone while a search runs, and open data
 * we may keep for good rather than rent.
 *
 * Zoom 10 is the level that answers with an area. Ask any deeper and a
 * neighbourhood comes back as the point somebody tagged it with, which has no
 * shape to draw.
 */
export async function areaOutline(lat, lng, { zoom = 10, threshold = 0.0006 } = {}) {
  const params = new URLSearchParams({
    lat: String(lat), lon: String(lng), format: 'jsonv2', addressdetails: '1', zoom: String(zoom),
    polygon_geojson: '1', polygon_threshold: String(threshold), 'accept-language': 'en',
  });
  const row = await politeFetch(`${BASE}/reverse?${params}`);
  if (!row || row.error) return null;
  const g = row.geojson;
  const rings = g?.type === 'Polygon' ? [g.coordinates[0]]
    : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0])
    : [];
  if (!rings.length) return null;
  return { osmRef: `${row.osm_type}/${row.osm_id}`, name: areaName(row), rings, attribution: GEOCODE_ATTRIBUTION };
}

/**
 * What people call the area, not what the council calls itself: "Islington",
 * not "London Borough of Islington". The City of London is left alone — that is
 * its name, not a title.
 */
export function areaName(row) {
  const raw = row.name || String(row.display_name || '').split(',')[0] || '';
  return raw
    .replace(/^(Royal |London |Metropolitan )?Borough of /i, '')
    .replace(/^City and County of /i, '')
    .replace(/^Municipality of /i, '')
    .trim() || raw;
}

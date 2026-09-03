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
async function politeFetch(url) {
  // Nominatim asks for ≤1 request/second.
  const wait = Math.max(0, lastCall + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return res.json();
}

function shape(row) {
  const a = row.address || {};
  const locality = a.city || a.town || a.village || a.suburb || a.county || a.state || null;
  return {
    label: shortLabel(row, locality),
    displayName: row.display_name,
    lat: Number(row.lat),
    lng: Number(row.lon),
    country: a.country || null,
    countryCode: a.country_code ? a.country_code.toUpperCase() : null,
    locality,
    kind: row.type || row.class || null,
    source: 'osm',
    sourcePlaceId: `${row.osm_type}/${row.osm_id}`,
    attribution: GEOCODE_ATTRIBUTION,
  };
}

function shortLabel(row, locality) {
  const name = row.name || row.display_name?.split(',')[0] || '';
  if (!locality || name.toLowerCase() === locality.toLowerCase()) return name;
  return `${name}, ${locality}`;
}

/** Free text → candidate places, best first. */
export async function geocode(text, { limit = 5, near = null } = {}) {
  const q = String(text || '').trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: String(limit), 'accept-language': 'en' });
  if (near?.lat != null) {
    // Bias toward the household's area without excluding the rest of the world.
    const d = 0.5;
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }
  const rows = await politeFetch(`${BASE}/search?${params}`);
  return rows.map(shape);
}

/** Coordinates → country and locality, for grouping trips by where they happened. */
export async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', addressdetails: '1', zoom: '10', 'accept-language': 'en' });
  const row = await politeFetch(`${BASE}/reverse?${params}`);
  if (!row || row.error) return null;
  return shape(row);
}

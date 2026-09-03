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

async function searchOnce(q, { limit, near, countryCode, bounded = false }) {
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
  const rows = await politeFetch(`${BASE}/search?${params}`);
  return rows.map(shape);
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

/** Coordinates → country and locality, for grouping trips by where they happened. */
export async function reverseGeocode(lat, lng, { zoom = 10 } = {}) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', addressdetails: '1', zoom: String(zoom), 'accept-language': 'en' });
  const row = await politeFetch(`${BASE}/reverse?${params}`);
  if (!row || row.error) return null;
  return shape(row);
}

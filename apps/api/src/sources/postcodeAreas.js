// Turning a county into the postcode districts that make it up (owner,
// 5 Sep 2026: "please now go ahead and get all the restaurants in Surrey and
// Berkshire, and then, once we're happy with that, we can move to London").
//
// The sweep's unit is the outward code — SL4, GU1 — because that is what
// people say and what a household recognises. A county is not: it is a name
// that covers somewhere between twenty and a hundred of them, and the mapping
// is not guessable. Berkshire has no county council at all, so nothing is
// tagged "Berkshire": it is six unitary authorities, and an outcode there
// answers with Reading or Bracknell Forest and no county whatsoever.
//
// So this asks the Office for National Statistics, through postcodes.io, which
// publishes ONS's own postcode directory: free, no key, and it gives each
// outcode's districts, counties and centroid in one answer. The centroid
// matters as much as the membership — it is where the sweep points.
//
// One request per candidate outcode, cached in memory, and the candidates are
// enumerated rather than discovered because there is no endpoint that lists
// them. That is cheap: a postcode area runs out well before 99.

const API = 'https://api.postcodes.io/outcodes';
const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; area lookup)';
const cache = new Map();

/**
 * The counties and unitary authorities each place is made of.
 *
 * Berkshire is the reason this is a list of districts rather than a county
 * name: the county was abolished in 1998 and its six unitaries are what the
 * data actually carries.
 */
export const PLACES = {
  surrey: {
    label: 'Surrey',
    // Postcode areas that reach into it. GU and KT are mostly Surrey; RH, SM,
    // CR and TW straddle the London and Sussex borders, and the ONS answer
    // decides which of their outcodes belong.
    areas: ['GU', 'KT', 'RH', 'SM', 'CR', 'TW'],
    counties: ['Surrey'],
    districts: [],
  },
  berkshire: {
    label: 'Berkshire',
    areas: ['RG', 'SL'],
    counties: [],
    // The six unitary authorities that were Berkshire.
    districts: ['Reading', 'West Berkshire', 'Wokingham', 'Bracknell Forest', 'Slough', 'Windsor and Maidenhead'],
  },
  london: {
    label: 'London',
    areas: ['E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC'],
    counties: ['Greater London'],
    districts: [],
  },
};

/** What ONS says about one outward code, or null where there is no such code. */
export async function outcode(code) {
  const key = code.toUpperCase();
  if (cache.has(key)) return cache.get(key);
  let value = null;
  try {
    const res = await fetch(`${API}/${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(10_000), headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (res.ok) {
      const { result } = await res.json();
      if (result?.latitude != null) {
        value = {
          code: result.outcode,
          lat: result.latitude,
          lng: result.longitude,
          districts: result.admin_district ?? [],
          counties: result.admin_county ?? [],
          countries: result.country ?? [],
        };
      }
    }
  } catch { /* a code that does not exist, or ONS having a moment */ }
  cache.set(key, value);
  return value;
}

const belongs = (o, place) =>
  o.counties.some((c) => place.counties.includes(c)) || o.districts.some((d) => place.districts.includes(d));

/**
 * Every outward code in a place, with where to point a sweep at it.
 *
 * Enumerated area by area and stopped when a run of codes comes back empty:
 * GU runs to 52 and SM to 7, and asking either of them about 99 is a request
 * nobody needs to serve.
 */
export async function outcodesIn(name, { maxNumber = 99, giveUpAfter = 12 } = {}) {
  const place = PLACES[String(name).toLowerCase()];
  if (!place) throw Object.assign(new Error(`Roam does not know where ${name} is.`), { status: 400 });

  const found = [];
  for (const area of place.areas) {
    let missed = 0;
    for (let n = 0; n <= maxNumber && missed < giveUpAfter; n += 1) {
      const o = await outcode(`${area}${n}`);
      if (!o) { missed += 1; continue; }
      missed = 0;
      if (belongs(o, place)) found.push(o);
    }
  }
  return { place: place.label, outcodes: found.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })) };
}

import { bump } from './meter.js';
// OpenStreetMap places via the Overpass API.
//
// Real restaurants, cafés, pubs, museums, parks and playgrounds anywhere in the
// world, with no key and no retention limit (ODbL, attribution required). What
// it does NOT have: reviews, ratings, opening-hour reliability, allergen data
// or dish lists. Those come from the licensed sources when they are enabled
// (Technical Constraints §3); this source is the floor, not the ceiling.

const ENDPOINTS = (process.env.ROAM_OVERPASS_URLS || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter').split(',');
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const AMENITY_TO_CATEGORY = {
  restaurant: 'restaurant', fast_food: 'restaurant', food_court: 'restaurant',
  cafe: 'cafe', ice_cream: 'cafe',
  pub: 'pub', biergarten: 'pub',
  bar: 'bar', nightclub: 'bar',
  cinema: 'attraction', theatre: 'attraction', arts_centre: 'attraction',
};
const AMENITY_EXPERIENCE = { cinema: 'cinema', theatre: 'theatre', arts_centre: 'art-gallery' };
const NOT_FOR_CHILDREN = /comedy|nightclub|casino|strip|adult/i;
const TOURISM_EXPERIENCE = {
  museum: 'museum', gallery: 'art-gallery', attraction: null, zoo: 'zoo', aquarium: 'aquarium',
  theme_park: 'theme-park', viewpoint: 'viewpoint', artwork: 'art-gallery',
};
const LEISURE_EXPERIENCE = {
  park: 'park', garden: 'park', nature_reserve: 'walk', playground: 'playground',
  water_park: 'swimming', swimming_pool: 'swimming', ice_rink: 'ice-skating',
  bowling_alley: 'bowling', miniature_golf: 'mini-golf', escape_game: 'escape-room',
  trampoline_park: 'trampoline', climbing: 'climbing', beach_resort: 'beach', marina: 'boat-trip',
};

const CATEGORY_FILTERS = {
  food: `nwr["amenity"~"^(restaurant|cafe|pub|bar|fast_food|ice_cream|biergarten)$"]["name"]`,
  things: `nwr["tourism"~"^(museum|gallery|attraction|zoo|aquarium|theme_park|viewpoint)$"]["name"];
  nwr["leisure"~"^(park|garden|nature_reserve|playground|water_park|swimming_pool|ice_rink|bowling_alley|miniature_golf|escape_game|trampoline_park|climbing|beach_resort)$"]["name"];
  nwr["amenity"~"^(cinema|theatre|arts_centre)$"]["name"];
  nwr["historic"~"^(castle|ruins|fort|manor|archaeological_site|palace|abbey)$"]["name"]`,
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQuery({ center, radiusM, categories, query, limit }) {
  const around = `(around:${Math.round(radiusM)},${center.lat},${center.lng})`;
  const nameFilter = query ? `["name"~"${escapeRegex(query)}",i]` : '';
  const want = categories?.length ? categories : ['food', 'things'];
  const parts = [];
  for (const group of want) {
    const filters = CATEGORY_FILTERS[group];
    if (!filters) continue;
    for (const f of filters.split(';')) {
      const t = f.trim();
      if (t) parts.push(`${t}${nameFilter}${around};`);
    }
  }
  return `[out:json][timeout:25];(${parts.join('')});out center tags ${limit};`;
}

/**
 * One Overpass element as a resolved venue. Exported because the owned place
 * layer (sources/own.js) matches a rented place to its OpenStreetMap element
 * and needs exactly this mapping, without asking Overpass a second time.
 */
export function venueFromOsmElement(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || !t.name) return null;
  // Street furniture someone tagged as an attraction (a lamp, a plaque, a
  // bollard) is not a stop; nor is a sight with no name worth planning around.
  if (t.man_made || ['plaque', 'boundary_stone', 'milestone', 'wayside_cross'].includes(t.historic) || /\b(lamp|plaque|bollard|post box|manhole|drinking fountain)\b/i.test(t.name)) return null;

  let category = 'attraction';
  const experiences = [];
  if (t.amenity && AMENITY_TO_CATEGORY[t.amenity]) {
    category = AMENITY_TO_CATEGORY[t.amenity];
    if (AMENITY_EXPERIENCE[t.amenity]) experiences.push(AMENITY_EXPERIENCE[t.amenity]);
  } else if (t.tourism) {
    const e = TOURISM_EXPERIENCE[t.tourism];
    if (e) experiences.push(e);
  } else if (t.leisure) {
    const e = LEISURE_EXPERIENCE[t.leisure];
    if (e) experiences.push(e);
  }
  if (t.historic && !['memorial', 'monument', 'church', 'wayside_cross', 'boundary_stone', 'milestone'].includes(t.historic)) {
    experiences.push('history');
    if (['castle', 'fort', 'palace', 'manor'].includes(t.historic)) experiences.push('castle');
  }

  const cuisines = (t.cuisine || '').split(';').map((c) => c.trim().toLowerCase().replace(/_/g, ' ')).filter(Boolean);
  const dietaryOptions = [];
  for (const diet of ['vegetarian', 'vegan', 'halal', 'kosher', 'gluten_free', 'dairy_free']) {
    const v = t[`diet:${diet}`];
    if (v === 'yes' || v === 'only') dietaryOptions.push(diet.replace('_', '-'));
  }

  return {
    source: 'osm',
    sourcePlaceId: `${el.type}/${el.id}`,
    name: t.name,
    category,
    cuisines,
    experiences,
    // Unknown, not "none": ranking treats missing data as unknown.
    allergens: [],
    dietaryOptions: (t.cuisine || Object.keys(t).some((k) => k.startsWith('diet:'))) ? dietaryOptions : undefined,
    priceLevel: null,
    rating: null,
    goodForChildren: t.kids_area === 'yes' || t.leisure === 'playground' ? true : (t.amenity === 'nightclub' || t.amenity === 'bar' || NOT_FOR_CHILDREN.test(t.name) || t['min_age']) ? false : null,
    lat,
    lng,
    dishes: [],
    styles: t.amenity === 'fast_food' ? ['fast-food'] : [],
    // A cinema or theatre needs a booking and a showtime; it is not a wander-in stop.
    ticketed: ['cinema', 'theatre'].includes(t.amenity) || t.tourism === 'theme_park' || /\b(theatre|theater|opera house|playhouse|cinema|concert hall)\b/i.test(t.name),
    justification: null,
    matchedDish: null,
    website: t.website || t['contact:website'] || null,
    openingHours: t.opening_hours || null,
    address: [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:suburb'] || t['addr:city'], t['addr:postcode']].filter(Boolean).join(', ') || null,
    // Mappers tag groups as brand; index.js turns this into the chain label.
    brand: t.brand || null,
    // A sight you look at rather than go into (a bath house, a statue, a
    // viewpoint) gets a short allowance, not an afternoon.
    quickLook: ['viewpoint', 'artwork'].includes(t.tourism) || ['ruins', 'archaeological_site', 'bath', 'wayside_shrine', 'city_gate', 'memorial'].includes(t.historic)
      || (t.tourism === 'attraction' && !t.opening_hours && !t.website && !t.fee),
    attribution: OSM_ATTRIBUTION,
  };
}

async function overpass(body, meter = null) {
  bump(meter, 'osm');
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Roam/0.1 (+https://github.com/rogerrivers888/roam)' },
        body: `data=${encodeURIComponent(body)}`,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status} at ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export const osmSource = {
  key: 'osm',
  label: 'OpenStreetMap',
  retention: { placeId: 'indefinite', displayFields: 'indefinite (ODbL, attribution required)' },
  attribution: { text: OSM_ATTRIBUTION, requiresAuthorCredit: false },

  /**
   * @param center     {lat,lng} — required; OSM has no notion of "near me" without it
   * @param radiusKm   search radius
   * @param categories ['food','things'] groups; empty = both
   * @param query      optional name filter (case-insensitive)
   */
  async search({ center, radiusKm = 3, categories = [], query = '', limit = 900, meter = null } = {}) {
    if (!center || center.lat == null) return [];
    const groups = new Set();
    for (const c of categories || []) {
      if (['restaurant', 'cafe', 'pub', 'bar', 'food'].includes(c)) groups.add('food');
      if (['attraction', 'event', 'things'].includes(c)) groups.add('things');
    }
    // One query per group: a single union with one limit returns the cafés
    // first and truncates the museums, which read as "no things to do".
    // Dense cities time out at large radii; shrink and retry rather than return nothing.
    const want = groups.size ? [...groups] : ['food', 'things'];
    const elements = [];
    for (const group of want) {
      let data = null;
      let r = Math.min(radiusKm, 25);
      let lastErr = null;
      // Always try at least once: a 600 m search must not be skipped for being small.
      do {
        try {
          data = await overpass(buildQuery({ center, radiusM: r * 1000, categories: [group], query: query?.trim(), limit: Math.ceil(limit / want.length) }), meter);
        } catch (err) { lastErr = err; r /= 2; }
      } while (!data && r >= 0.75);
      if (!data) throw lastErr ?? new Error('Overpass unavailable');
      elements.push(...(data.elements || []));
    }
    const venues = elements.map(venueFromOsmElement).filter(Boolean);
    // Dedupe identical names at the same spot (a node and its building way),
    // then keep the nearest — Overpass's own order is arbitrary.
    const seen = new Map();
    for (const v of venues) {
      const k = `${v.name.toLowerCase()}|${v.lat.toFixed(3)}|${v.lng.toFixed(3)}`;
      if (!seen.has(k)) seen.set(k, v);
    }
    const d2 = (v) => (v.lat - center.lat) ** 2 + ((v.lng - center.lng) * Math.cos((center.lat * Math.PI) / 180)) ** 2;
    // Nearest first, capped PER GROUP: in a city centre the 250 nearest places
    // are nearly all cafés and restaurants, and the museums never made the cut
    // — which read as "Roam has no ideas for things to do".
    const sorted = [...seen.values()].sort((a, b) => d2(a) - d2(b));
    const isFoodCat = (v) => ['restaurant', 'cafe', 'pub', 'bar'].includes(v.category);
    return [...sorted.filter(isFoodCat).slice(0, 200), ...sorted.filter((v) => !isFoodCat(v)).slice(0, 200)];
  },
};

/** One element by "type/id" (e.g. "node/123"), in the same shape search returns. */
osmSource.get = async (ref) => {
  const [type, id] = String(ref).split('/');
  if (!['node', 'way', 'relation'].includes(type) || !/^\d+$/.test(id || '')) return null;
  const data = await overpass(`[out:json][timeout:15];${type}(${id});out center tags;`);
  const el = (data.elements || [])[0];
  return el ? venueFromOsmElement(el) : null;
};

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
  nwr["amenity"~"^(cinema|theatre|arts_centre)$"]["name"]`,
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

function toVenue(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || !t.name) return null;

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
    goodForChildren: t.kids_area === 'yes' || t.leisure === 'playground' ? true : null,
    lat,
    lng,
    dishes: [],
    justification: null,
    matchedDish: null,
    website: t.website || t['contact:website'] || null,
    openingHours: t.opening_hours || null,
    address: [t['addr:housenumber'], t['addr:street'], t['addr:city']].filter(Boolean).join(' ') || null,
    attribution: OSM_ATTRIBUTION,
  };
}

async function overpass(body) {
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
  async search({ center, radiusKm = 3, categories = [], query = '', limit = 150 } = {}) {
    if (!center || center.lat == null) return [];
    const groups = new Set();
    for (const c of categories || []) {
      if (['restaurant', 'cafe', 'pub', 'bar', 'food'].includes(c)) groups.add('food');
      if (['attraction', 'event', 'things'].includes(c)) groups.add('things');
    }
    const data = await overpass(buildQuery({
      center, radiusM: Math.min(radiusKm, 25) * 1000, categories: [...groups], query: query?.trim(), limit,
    }));
    const venues = (data.elements || []).map(toVenue).filter(Boolean);
    // Dedupe identical names at the same spot (a node and its building way).
    const seen = new Map();
    for (const v of venues) {
      const k = `${v.name.toLowerCase()}|${v.lat.toFixed(3)}|${v.lng.toFixed(3)}`;
      if (!seen.has(k)) seen.set(k, v);
    }
    return [...seen.values()];
  },
};

/** One element by "type/id" (e.g. "node/123"), in the same shape search returns. */
osmSource.get = async (ref) => {
  const [type, id] = String(ref).split('/');
  if (!['node', 'way', 'relation'].includes(type) || !/^\d+$/.test(id || '')) return null;
  const data = await overpass(`[out:json][timeout:15];${type}(${id});out center tags;`);
  const el = (data.elements || [])[0];
  return el ? toVenue(el) : null;
};

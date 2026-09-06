import { bump } from './meter.js';
import { mirrorsInOrder, mirrorAnswered, mirrorFailed, UA } from './overpass.js';
// OpenStreetMap places via the Overpass API.
//
// Real restaurants, cafés, pubs, museums, parks and playgrounds anywhere in the
// world, with no key and no retention limit (ODbL, attribution required). What
// it does NOT have: reviews, ratings, opening-hour reliability, allergen data
// or dish lists. Those come from the licensed sources when they are enabled
// (Technical Constraints §3); this source is the floor, not the ceiling.

// Mirrors, and which of them are answering today: sources/overpass.js.
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

// Somewhere to sleep. Asked for on its own — never in the default set — so a
// search for somewhere to eat never comes back with hotels.
const TOURISM_TO_CATEGORY = {
  hotel: 'hotel', guest_house: 'hotel', hostel: 'hotel', motel: 'hotel',
  apartment: 'hotel', chalet: 'hotel', alpine_hut: 'hotel',
};
/** What kind of bed, in the word a person would use. */
const STAY_WORDS = {
  hotel: 'hotel', guest_house: 'guest house', hostel: 'hostel', motel: 'motel',
  apartment: 'apartment', chalet: 'chalet', alpine_hut: 'hut',
};

/**
 * The seven must-haves and four nice-to-haves the stay wizard asks about
 * (Hotels 2 §18), read off the open map's tags.
 *
 * Every one of these is a positive statement by a mapper. There is no "no
 * pool" tag in practice, so the absence of a word here means *unknown*, not
 * absent — and because a must-have filters, an unknown bed is left out. That
 * is the honest way round: showing a place because nobody said it lacked a
 * kitchen would be inventing a kitchen.
 */
export function stayAmenities(t) {
  const yes = (v) => v != null && v !== 'no' && v !== 'none' && v !== 'false';
  const out = [];
  if (yes(t.swimming_pool) || yes(t['leisure:swimming_pool'])) out.push('Pool');
  if (yes(t.kitchen) || t.tourism === 'apartment' || t.tourism === 'chalet') out.push('Kitchen');
  if (yes(t.parking) || yes(t['amenity:parking'])) out.push('Parking');
  if (yes(t['rooms:family']) || yes(t.family_rooms)) out.push('Family room');
  if (yes(t.breakfast)) out.push('Breakfast');
  if (yes(t.air_conditioning)) out.push('Air con');
  if (yes(t.dog) || yes(t.dogs) || yes(t.pets)) out.push('Pet-friendly');
  if (/sea|coast|ocean|beach/i.test(t.view || '')) out.push('Sea view');
  if (yes(t.garden) || t.leisure === 'garden') out.push('Garden');
  return out;
}

const CATEGORY_FILTERS = {
  food: `nwr["amenity"~"^(restaurant|cafe|pub|bar|fast_food|ice_cream|biergarten)$"]["name"]`,
  stay: `nwr["tourism"~"^(hotel|guest_house|hostel|motel|apartment|chalet|alpine_hut)$"]["name"]`,
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
  } else if (t.tourism && TOURISM_TO_CATEGORY[t.tourism]) {
    category = TOURISM_TO_CATEGORY[t.tourism];
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
    // Somewhere to sleep: what kind of bed it is, and the rating the operator
    // is allowed to advertise. Both are facts in the open map, not a review.
    stayKind: STAY_WORDS[t.tourism] ?? null,
    // What the bed has, in the words the stay wizard asks in (Hotels 2 §18).
    // Only what a mapper has positively said: an absent tag means unknown, and
    // a must-have is a filter, so a bed nobody has tagged does not claim a pool
    // it may not have. Sparse by nature — the wizard's live count is what tells
    // somebody that ticking three of these leaves them two beds.
    amenities: t.tourism ? stayAmenities(t) : undefined,
    stars: t.stars && /^\d/.test(t.stars) ? Number(String(t.stars).match(/\d+/)[0]) : null,
    rooms: t.rooms ? Number(t.rooms) || null : null,
    // A sight you look at rather than go into (a bath house, a statue, a
    // viewpoint) gets a short allowance, not an afternoon.
    quickLook: ['viewpoint', 'artwork'].includes(t.tourism) || ['ruins', 'archaeological_site', 'bath', 'wayside_shrine', 'city_gate', 'memorial'].includes(t.historic)
      || (t.tourism === 'attraction' && !t.opening_hours && !t.website && !t.fee),
    attribution: OSM_ATTRIBUTION,
  };
}

// One mirror's patience, not the whole search's. Thirty seconds each across a
// list that begins with two mirrors that are currently down is a minute of
// somebody watching a spinner; a working mirror answers in under a second and a
// slow one in ten, so anything past twelve is not coming.
const ENDPOINT_TIMEOUT_MS = Number(process.env.ROAM_OVERPASS_TIMEOUT_MS) || 12_000;

async function overpass(body, meter = null) {
  bump(meter, 'osm');
  let lastErr;
  for (const url of mirrorsInOrder()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: `data=${encodeURIComponent(body)}`,
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
      });
      if (!res.ok) {
        mirrorFailed(url, null, res.status);
        throw new Error(`Overpass ${res.status} at ${url}`);
      }
      const data = await res.json();
      mirrorAnswered(url, { empty: Array.isArray(data?.elements) && data.elements.length === 0 });
      return data;
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') mirrorFailed(url, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

export const osmSource = {
  key: 'osm',
  label: 'OpenStreetMap',
  /**
   * Overpass is a volunteer service and its mirrors go down. The ladder tries
   * them in turn at twelve seconds each, so two dead mirrors is twenty-four
   * seconds of a browse screen waiting for nothing — tapping Activities took
   * twenty-five seconds for an answer Google had had in one (measured on
   * production, 6 Sep 2026).
   *
   * Capped here rather than by hurrying every source along: a general deadline
   * starts a two-and-a-half second clock the moment *anything* answers, and
   * that cut sources that were merely slow — the same search fell from
   * twenty-five places to ten. This is the one that is actually slow, so this
   * is the one that gets a shorter rope. A mirror that misses it rests
   * (`rest()` below), so the next search does not pay for it again.
   */
  deadlineMs: 11_000,
  /**
   * Slow by nature, not slow today.
   *
   * Overpass answered three tries in five on production (6 Sep 2026) at 5.0s,
   * 7.2s and 9.8s, the other two running out the cap above. There is no grace
   * window that both waits for that and feels like an app, so the fan-out stops
   * waiting for this one the moment the rest have answered — and picks its
   * answer up afterwards instead (sources/index.js `settling`, cache.js).
   *
   * This is not "OpenStreetMap does not matter". It is the widest source we
   * have: a hundred and twenty restaurants in central Manchester where Google
   * returns seven. It is exactly because the answer is worth having that it is
   * kept rather than raced.
   */
  slow: true,
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
      // Only when it is asked for by name: nobody looking for lunch wants hotels.
      if (['stay', 'hotel', 'lodging'].includes(c)) groups.add('stay');
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

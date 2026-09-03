// Google Places API (New) — the primary licensed source (Technical Constraints §3.1).
//
// What it adds over OpenStreetMap: ratings and review counts, up to 5 reviews,
// photos, reliable opening hours, price level, family flags (goodForChildren,
// menuForChildren), reservable, and — for a dish or activity search — the
// review text that justified the match (contextualContents.justifications).
//
// Terms that shape this file:
//   • Retention: place_id indefinitely, coordinates 30 days, everything else
//     none. Nothing here is written to the database; venues live in the
//     in-session working memory only (sources/index.js opts Google OUT of
//     the recent-venue cache).
//   • Field masks are the cost lever: Pro fields (rating, hours, photos) are
//     requested; Enterprise/Atmosphere fields only when a screen needs them.
//   • Attribution: "Google" must be shown wherever these results appear.
//   • The key never leaves the server; photos are proxied (/api/photos/google).

const KEY = () => process.env.GOOGLE_MAPS_API_KEY?.trim();
const PLACES = 'https://places.googleapis.com/v1';
export const GOOGLE_ATTRIBUTION = 'Powered by Google';

// Field masks per call — request only what the screen renders.
const SEARCH_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.types', 'places.primaryType',
  'places.rating', 'places.userRatingCount', 'places.priceLevel', 'places.regularOpeningHours.weekdayDescriptions',
  'places.websiteUri', 'places.googleMapsUri', 'places.photos.name', 'places.photos.authorAttributions',
  'places.goodForChildren', 'places.menuForChildren', 'places.servesVegetarianFood', 'places.reservable', 'places.editorialSummary',
].join(',');
const TEXT_SEARCH_FIELDS = `${SEARCH_FIELDS},contextualContents.justifications`;
const DETAIL_FIELDS = 'id,displayName,formattedAddress,location,types,primaryType,rating,userRatingCount,priceLevel,regularOpeningHours.weekdayDescriptions,websiteUri,googleMapsUri,photos.name,photos.authorAttributions,goodForChildren,menuForChildren,servesVegetarianFood,reservable,editorialSummary,reviews';

const FOOD_TYPES = ['restaurant', 'cafe', 'bar', 'pub', 'bakery', 'ice_cream_shop', 'coffee_shop'];
const THING_TYPES = [
  'tourist_attraction', 'museum', 'art_gallery', 'park', 'playground', 'zoo', 'aquarium', 'amusement_park', 'water_park',
  'historical_landmark', 'national_park', 'hiking_area', 'garden', 'bowling_alley', 'marina', 'botanical_garden', 'planetarium',
  'observation_deck', 'cultural_landmark', 'monument', 'beach', 'ice_skating_rink', 'adventure_sports_center', 'roller_coaster',
];

const TYPE_TO_CATEGORY = {
  restaurant: 'restaurant', meal_takeaway: 'restaurant', meal_delivery: 'restaurant', bakery: 'cafe', cafe: 'cafe', coffee_shop: 'cafe', ice_cream_shop: 'cafe',
  bar: 'bar', wine_bar: 'bar', night_club: 'bar', pub: 'pub',
};
const TYPE_TO_EXPERIENCE = {
  museum: 'museum', art_gallery: 'art-gallery', park: 'park', garden: 'park', botanical_garden: 'park', playground: 'playground', zoo: 'zoo', aquarium: 'aquarium',
  amusement_park: 'theme-park', roller_coaster: 'theme-park', water_park: 'swimming', swimming_pool: 'swimming', historical_landmark: 'history', monument: 'history',
  cultural_landmark: 'history', hiking_area: 'walk', national_park: 'walk', bowling_alley: 'bowling', marina: 'boat-trip', beach: 'beach', ice_skating_rink: 'ice-skating',
  observation_deck: 'viewpoint', planetarium: 'museum', movie_theater: 'cinema', performing_arts_theater: 'theatre', stadium: 'sports-game', shopping_mall: 'shopping',
  market: 'market', book_store: 'bookshop', adventure_sports_center: 'climbing', tourist_attraction: null,
};

// Types that describe the setting, not the food: kept out of the cuisine list.
const NOT_A_CUISINE = new Set(['fine dining', 'fast food', 'family', 'buffet', 'brunch', 'breakfast', 'dessert']);
function cuisineFromTypes(types = []) {
  return types
    .filter((t) => /_restaurant$/.test(t))
    .map((t) => t.replace(/_restaurant$/, '').replace(/_/g, ' '))
    .filter((c) => !NOT_A_CUISINE.has(c));
}

// Somewhere you go to look, shop or do — even when Google also lists a café inside it.
const THING_FIRST = new Set([...THING_TYPES, 'department_store', 'shopping_mall', 'market', 'book_store', 'performing_arts_theater', 'movie_theater', 'stadium', 'concert_hall', 'church', 'place_of_worship', 'library', 'visitor_center']);

function priceLevelNumber(p) {
  return { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 }[p] ?? null;
}

function toVenue(place, justification = null) {
  const types = place.types || [];
  const primary = place.primaryType || types[0] || '';
  // The primary type decides. A museum with a café is a museum; Selfridges is
  // not a café because it has one; only when the primary type says nothing do
  // the secondary types get a say.
  const primaryIsThing = THING_FIRST.has(primary) || (TYPE_TO_EXPERIENCE[primary] !== undefined && !TYPE_TO_CATEGORY[primary]);
  let category = TYPE_TO_CATEGORY[primary]
    || (primaryIsThing || types.some((t) => THING_FIRST.has(t) && !TYPE_TO_CATEGORY[primary]) ? 'attraction' : null)
    || types.map((t) => TYPE_TO_CATEGORY[t]).find(Boolean)
    || 'attraction';
  const experiences = [...new Set([TYPE_TO_EXPERIENCE[primary], ...types.map((t) => TYPE_TO_EXPERIENCE[t])].filter(Boolean))];
  if (category === 'attraction' && !experiences.length && !types.some((t) => t in TYPE_TO_EXPERIENCE)) category = 'attraction';
  const cuisines = cuisineFromTypes(types);
  const dietary = [];
  if (place.servesVegetarianFood === true) dietary.push('vegetarian');
  return {
    source: 'google',
    sourcePlaceId: place.id,
    name: place.displayName?.text ?? place.displayName ?? '',
    category,
    cuisines,
    experiences,
    allergens: [],
    dietaryOptions: place.servesVegetarianFood != null ? dietary : undefined,
    priceLevel: priceLevelNumber(place.priceLevel),
    rating: place.rating ?? null,
    ratingCount: place.userRatingCount ?? null,
    goodForChildren: place.goodForChildren ?? null,
    menuForChildren: place.menuForChildren ?? null,
    reservable: place.reservable ?? null,
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    dishes: [],
    justification,
    matchedDish: null,
    address: place.formattedAddress ?? null,
    openingHours: place.regularOpeningHours?.weekdayDescriptions?.join(' · ') ?? null,
    website: place.websiteUri ?? null,
    mapsUrl: place.googleMapsUri ?? null,
    summary: place.editorialSummary?.text ?? null,
    upmarket: types.includes('fine_dining_restaurant') || null,
    styles: types.includes('fast_food_restaurant') ? ['fast-food'] : [],
    // Photo references only; the image is fetched through our proxy with the key.
    photos: (place.photos || []).slice(0, 3).map((p) => ({ ref: p.name, attribution: (p.authorAttributions || []).map((a) => a.displayName).join(', ') })),
    ticketed: ['movie_theater', 'performing_arts_theater', 'stadium', 'concert_hall'].includes(primary),
    attribution: GOOGLE_ATTRIBUTION,
    // Per-field retention per Google's terms: ids indefinite, coordinates 30 days, the rest not stored at all.
    retention: { placeId: 'indefinite', coordinates: '30d', displayFields: 'none' },
  };
}

async function call(path, { method = 'POST', body, fieldMask }) {
  const key = KEY();
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const res = await fetch(`${PLACES}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Places ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export const googleSource = {
  key: 'google',
  label: 'Google',
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: GOOGLE_ATTRIBUTION, requiresAuthorCredit: true },
  enabled: () => Boolean(KEY()),

  /**
   * Nearby by type groups, or Text Search when there is a query (dish, activity,
   * name) so the justification comes back with each match.
   */
  async search({ center, radiusKm = 3, categories = [], query = '', limit = 60 } = {}) {
    if (!KEY() || !center || center.lat == null) return [];
    const groups = new Set();
    for (const c of categories || []) {
      if (['restaurant', 'cafe', 'pub', 'bar', 'food'].includes(c)) groups.add('food');
      if (['attraction', 'event', 'things'].includes(c)) groups.add('things');
    }
    if (!groups.size) { groups.add('food'); groups.add('things'); }
    const radius = Math.min(radiusKm, 50) * 1000;
    const out = [];

    if (query?.trim()) {
      const data = await call('/places:searchText', {
        fieldMask: TEXT_SEARCH_FIELDS,
        body: { textQuery: query.trim(), pageSize: 20, locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } } },
      });
      (data.places || []).forEach((p, i) => {
        const j = data.contextualContents?.[i]?.justifications?.[0];
        const text = j?.reviewJustification?.highlightedText?.text ?? j?.businessAvailabilityAttributesJustification ? null : null;
        out.push(toVenue(p, j?.reviewJustification?.highlightedText?.text ?? null));
      });
      return out;
    }

    // Nearby: one call per group, 20 each (the API maximum per call).
    for (const group of groups) {
      const data = await call('/places:searchNearby', {
        fieldMask: SEARCH_FIELDS,
        body: {
          includedTypes: group === 'food' ? FOOD_TYPES : THING_TYPES,
          maxResultCount: 20,
          rankPreference: 'POPULARITY',
          locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
        },
      });
      for (const p of data.places || []) out.push(toVenue(p));
      if (out.length >= limit) break;
    }
    return out;
  },

  /** Full detail including up to 5 reviews (Pro/Enterprise fields). */
  async get(id) {
    if (!KEY()) return null;
    const p = await call(`/places/${id}`, { method: 'GET', fieldMask: DETAIL_FIELDS });
    const v = toVenue(p);
    v.reviews = (p.reviews || []).slice(0, 5).map((r) => ({
      text: r.text?.text ?? r.originalText?.text ?? '', rating: r.rating ?? null, author: r.authorAttribution?.displayName ?? null,
      authorUri: r.authorAttribution?.uri ?? null, when: r.relativePublishTimeDescription ?? null,
    }));
    return v;
  },

  /** Search along an encoded polyline; results ranked by detour (Technical Constraints §3.1). */
  async searchAlongRoute({ encodedPolyline, query, limit = 20 }) {
    if (!KEY() || !encodedPolyline) return [];
    const data = await call('/places:searchText', {
      fieldMask: `${TEXT_SEARCH_FIELDS},routingSummaries`,
      body: { textQuery: query || 'places to stop', pageSize: Math.min(limit, 20), searchAlongRouteParameters: { polyline: { encodedPolyline } } },
    });
    return (data.places || []).map((p, i) => ({
      ...toVenue(p, data.contextualContents?.[i]?.justifications?.[0]?.reviewJustification?.highlightedText?.text ?? null),
      routingSummary: data.routingSummaries?.[i] ?? null,
    }));
  },
};

/** Stream a Google photo through the server so the key stays server-side. */
export async function fetchPhoto(name, maxWidthPx = 480) {
  const key = KEY();
  if (!key) return null;
  const res = await fetch(`${PLACES}/${name}/media?maxWidthPx=${maxWidthPx}&key=${key}`, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return { contentType: res.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
}

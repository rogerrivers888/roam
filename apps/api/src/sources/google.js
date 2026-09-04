import { bump } from './meter.js';
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
  'places.regularOpeningHours.openNow', 'places.currentOpeningHours.openNow', 'places.currentOpeningHours.weekdayDescriptions',
  'places.currentOpeningHours.nextCloseTime', 'places.currentOpeningHours.nextOpenTime', 'places.utcOffsetMinutes',
  'places.websiteUri', 'places.googleMapsUri', 'places.photos.name', 'places.photos.authorAttributions',
  'places.goodForChildren', 'places.menuForChildren', 'places.servesVegetarianFood', 'places.reservable', 'places.editorialSummary',
].join(',');
const TEXT_SEARCH_FIELDS = `${SEARCH_FIELDS},contextualContents.justifications`;
const DETAIL_FIELDS = 'id,displayName,formattedAddress,location,types,primaryType,rating,userRatingCount,priceLevel,regularOpeningHours.weekdayDescriptions,regularOpeningHours.openNow,currentOpeningHours.openNow,currentOpeningHours.weekdayDescriptions,currentOpeningHours.nextCloseTime,currentOpeningHours.nextOpenTime,utcOffsetMinutes,websiteUri,googleMapsUri,photos.name,photos.authorAttributions,goodForChildren,menuForChildren,servesVegetarianFood,reservable,editorialSummary,reviews,nationalPhoneNumber';

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
const NOT_A_CUISINE = new Set(['fine dining', 'fast food', 'family', 'buffet', 'brunch', 'breakfast', 'dessert', 'restaurant']);
// Kinds of food place the provider does not spell "…_restaurant": a steakhouse
// is typed `steak_house`, so the row said nothing about it (owner, 4 Sep 2026).
const FOOD_TYPE_WORDS = {
  steak_house: 'steakhouse', bakery: 'bakery', coffee_shop: 'coffee', wine_bar: 'wine bar', bar_and_grill: 'bar and grill',
  ice_cream_shop: 'ice cream', dessert_shop: 'desserts', sandwich_shop: 'sandwiches', bagel_shop: 'bagels',
  donut_shop: 'doughnuts', juice_shop: 'juice', tea_house: 'tea', deli: 'deli', pizzeria: 'pizza',
};
// "Amalfi Ristorante" is Italian before it is vegan: a whole continent, and a
// way of eating, both say less about the food than the country does.
const BROAD_CUISINE = new Set(['european', 'mediterranean', 'asian', 'international', 'fusion', 'continental', 'modern']);
const DIETARY_CUISINE = new Set(['vegan', 'vegetarian', 'halal', 'kosher', 'gluten free']);
const cuisineRank = (c) => (DIETARY_CUISINE.has(c) ? 2 : BROAD_CUISINE.has(c) ? 1 : 0);

function cuisineFromTypes(types = []) {
  const words = types.map((t) => (/_restaurant$/.test(t) ? t.replace(/_restaurant$/, '').replace(/_/g, ' ') : FOOD_TYPE_WORDS[t] ?? null));
  const kept = [...new Set(words.filter((c) => c && !NOT_A_CUISINE.has(c)))];
  return kept.map((c, i) => ({ c, i })).sort((a, b) => cuisineRank(a.c) - cuisineRank(b.c) || a.i - b.i).map((x) => x.c);
}

const LODGING = new Set(['hotel', 'lodging', 'motel', 'resort_hotel', 'extended_stay_hotel', 'bed_and_breakfast', 'guest_house', 'hostel', 'inn']);
// Somewhere you go to look, shop or do — even when Google also lists a café inside it.
const THING_FIRST = new Set([...THING_TYPES, 'department_store', 'shopping_mall', 'market', 'book_store', 'performing_arts_theater', 'movie_theater', 'stadium', 'concert_hall', 'church', 'place_of_worship', 'library', 'visitor_center']);

// "Open today, or not" (owner, 4 Sep 2026). Google decides openNow in the
// place's own timezone, which is the only way to be right about a restaurant in
// Rome from a phone in London, so it is taken as given rather than worked out
// here. currentOpeningHours is preferred over regularOpeningHours because it
// covers the next seven days' exceptions — a bank holiday closure is exactly
// the thing you need to know before setting off. Both sit in the Enterprise SKU
// this call already pays for, so none of this adds to the bill.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A time in the place's own day, from an RFC 3339 instant. */
function localClock(iso, offsetMinutes) {
  if (!iso || !Number.isFinite(offsetMinutes)) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + offsetMinutes * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function openState(place) {
  const current = place.currentOpeningHours ?? null;
  const hours = current ?? place.regularOpeningHours ?? null;
  const offset = place.utcOffsetMinutes;
  const descriptions = current?.weekdayDescriptions?.length ? current.weekdayDescriptions : place.regularOpeningHours?.weekdayDescriptions ?? [];
  // The day where the place is, not where the phone is. Without an offset we
  // fall back to the server's day rather than guessing at one.
  const there = new Date(Date.now() + (Number.isFinite(offset) ? offset : 0) * 60_000);
  const dayName = DAY_NAMES[Number.isFinite(offset) ? there.getUTCDay() : new Date().getDay()];
  const line = descriptions.find((d) => d.startsWith(`${dayName}:`)) ?? null;
  return {
    openNow: hours?.openNow ?? null,
    // "12:00 – 11:00 PM", or "Closed" — the day's own words, without the day.
    hoursToday: line ? line.slice(dayName.length + 1).trim() || null : null,
    hoursDay: line ? dayName : null,
    closesAt: localClock(current?.nextCloseTime, offset),
    opensAt: localClock(current?.nextOpenTime, offset),
  };
}

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
  // The primary type first, so a row says what the place mostly is.
  const cuisines = cuisineFromTypes([primary, ...types]);
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
    openingHours: (place.currentOpeningHours ?? place.regularOpeningHours)?.weekdayDescriptions?.join(' · ') ?? null,
    ...openState(place),
    website: place.websiteUri ?? null,
    phone: place.nationalPhoneNumber ?? null,
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

async function call(path, { method = 'POST', body, fieldMask, meter }) {
  const key = KEY();
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not set');
  bump(meter, 'google'); // one billable request, whatever it returns
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
  async search({ center, radiusKm = 3, categories = [], query = '', limit = 60, meter = null } = {}) {
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
        fieldMask: TEXT_SEARCH_FIELDS, meter,
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
        fieldMask: SEARCH_FIELDS, meter,
        body: {
          includedTypes: group === 'food' ? FOOD_TYPES : THING_TYPES,
          maxResultCount: 20,
          rankPreference: 'POPULARITY',
          locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
        },
      });
      // A hotel is where you sleep, not a place to eat or a thing to do — even
      // when Google also types it as a restaurant because it has one.
      for (const p of data.places || []) if (!LODGING.has(p.primaryType)) out.push(toVenue(p));
      if (out.length >= limit) break;
    }
    return out;
  },

  /** Full detail including up to 5 reviews (Pro/Enterprise fields). */
  async get(id, { meter = null } = {}) {
    if (!KEY()) return null;
    const p = await call(`/places/${id}`, { method: 'GET', fieldMask: DETAIL_FIELDS, meter });
    const v = toVenue(p);
    v.reviews = (p.reviews || []).slice(0, 5).map((r) => ({
      text: r.text?.text ?? r.originalText?.text ?? '', rating: r.rating ?? null, author: r.authorAttribution?.displayName ?? null,
      authorUri: r.authorAttribution?.uri ?? null, when: r.relativePublishTimeDescription ?? null,
    }));
    return v;
  },

  /**
   * Predictions as the household types (owner, 4 Sep 2026: "when I start
   * searching, it knows the location, and so it actually just starts suggesting
   * stuff as I type"). Autocomplete is the cheapest and fastest thing the
   * provider sells — no place is fetched until one is chosen — and the point is
   * a bias, not a fence, so a restaurant in the next town still appears.
   */
  async suggest(query, { near = null, radiusKm = 15, sessionToken = null, meter = null } = {}) {
    // What kind of place a prediction is, in a word or two: "you've got the
    // right Sebastian's" needs the word restaurant next to the address
    // (owner, 4 Sep 2026).
    const describe = (types = []) => {
      const cuisines = cuisineFromTypes(types);
      const primary = types[0] || '';
      const category = TYPE_TO_CATEGORY[primary] || types.map((t) => TYPE_TO_CATEGORY[t]).find(Boolean) || null;
      const experience = TYPE_TO_EXPERIENCE[primary] || types.map((t) => TYPE_TO_EXPERIENCE[t]).find(Boolean) || null;
      const word = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1).replace(/[-_]/g, ' ');
      if (cuisines.length && (!category || category === 'restaurant')) return `${word(cuisines[0])}${/house|bakery|coffee|bar$/.test(cuisines[0]) ? '' : ' restaurant'}`;
      if (experience) return word(experience);
      if (category) return word(category === 'cafe' ? 'café' : category);
      if (types.includes('street_address') || types.includes('route') || types.includes('premise')) return 'Address';
      if (types.includes('locality') || types.includes('postal_town')) return 'Town';
      return null;
    };
    if (!KEY() || !String(query || '').trim()) return [];
    const body = { input: String(query).trim(), includedPrimaryTypes: [], languageCode: 'en-GB' };
    delete body.includedPrimaryTypes;
    if (near?.lat != null) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: Math.min(50, Math.max(1, radiusKm)) * 1000 } };
    if (sessionToken) body.sessionToken = sessionToken;
    const data = await call('/places:autocomplete', { body, meter });
    return (data.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        placeId: p.placeId,
        name: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
        where: p.structuredFormat?.secondaryText?.text ?? null,
        kind: describe(p.types || []),
        types: p.types || [],
      }))
      .filter((p) => p.placeId && p.name);
  },

  /**
   * Just what kind of place it is — the cheapest Details field mask there is
   * (Essentials), for the atlas: a row wants to say "Italian" or "Steakhouse"
   * rather than repeat "Restaurant", and the kind of thing is a taxonomy label,
   * not the rented content (reviews, photos, hours) that Pro and Enterprise bill for.
   */
  async types(id, { meter = null } = {}) {
    if (!KEY()) return null;
    const p = await call(`/places/${id}`, { method: 'GET', fieldMask: 'id,types,primaryType', meter });
    const types = p.types || [];
    const primary = p.primaryType || types[0] || '';
    return {
      cuisines: cuisineFromTypes([primary, ...types]),
      experiences: [...new Set([TYPE_TO_EXPERIENCE[primary], ...types.map((t) => TYPE_TO_EXPERIENCE[t])].filter(Boolean))],
    };
  },

  /**
   * Just enough to go looking with: the name, the point, and the address of
   * their own site.
   *
   * The owned place layer researches a place from open sources, and to do that
   * it needs to know which place it is — a name and a spot on the map. When the
   * household's own records do not carry one (a place shortlisted on a trip
   * since deleted, say), the place ID is the only thing left, and the place ID
   * is the one field we are allowed to keep. This turns it back into a
   * description of what to go and find (api/src/sources/own.js `seedFor`).
   *
   * The narrowest field mask there is, so it bills at the cheapest tier: no
   * hours, no rating, no reviews, no photos. Nothing it returns is written
   * down — it is read, used to search OpenStreetMap and Wikipedia, and dropped.
   */
  async brief(id, { meter = null } = {}) {
    if (!KEY()) return null;
    const p = await call(`/places/${id}`, { method: 'GET', fieldMask: 'id,displayName,location,websiteUri', meter });
    if (!p?.location) return null;
    return {
      name: p.displayName?.text ?? null,
      lat: p.location.latitude,
      lng: p.location.longitude,
      website: p.websiteUri ?? null,
    };
  },

  /** Search along an encoded polyline; results ranked by detour (Technical Constraints §3.1). */
  async searchAlongRoute({ encodedPolyline, query, limit = 20, meter = null }) {
    if (!KEY() || !encodedPolyline) return [];
    const data = await call('/places:searchText', {
      fieldMask: `${TEXT_SEARCH_FIELDS},routingSummaries`, meter,
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
  if (!res.ok) {
    // Say why. A picture that never arrives used to be an empty green box on
    // the screen for as long as you cared to look at it (owner, 4 Sep 2026);
    // the screen can only give up quickly if it is told.
    const why = await res.text().catch(() => '');
    const err = new Error(`Google photo ${res.status}: ${why.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return { contentType: res.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
}

// Photos already fetched, held in memory for an hour (owner, 4 Sep 2026: the
// same pictures were being downloaded again every time a tab was left and come
// back to). Two reasons, and the second is the important one:
//
//   • It is slow. Every view was two hops — the browser to us, us to Google —
//     for bytes we had in our hands a minute earlier.
//   • Every view is a billed Place Photo request. Six ideas looked at three
//     times in an afternoon was eighteen requests for six pictures.
//
// In memory only, and never written down: the same rule the search cache keeps
// (sources/cache.js). A restart loses it, which is correct — licensed content
// is not ours to keep, and this is a buffer between one household's screen and
// the provider, not a store.
const PHOTO_TTL_MS = 60 * 60_000;
// About six megabytes at the sizes the app asks for (240px thumbnails, 480px
// and 800px in the drawer). Oldest out first.
const PHOTO_MAX = 200;
const photos = new Map();

/**
 * A photo, from memory if we have it. Returns `{ contentType, body, cached }`
 * — `cached` is false only when Google was actually asked, and that is the
 * caller's signal to record the provider call.
 */
export async function photoFor(name, maxWidthPx = 480) {
  const key = `${name}@${maxWidthPx}`;
  const hit = photos.get(key);
  if (hit && Date.now() - hit.at < PHOTO_TTL_MS) {
    // Most recently wanted, last to be dropped.
    photos.delete(key);
    photos.set(key, hit);
    return { ...hit.photo, cached: true };
  }
  const photo = await fetchPhoto(name, maxWidthPx);
  if (!photo) return null;
  photos.delete(key);
  photos.set(key, { at: Date.now(), photo });
  while (photos.size > PHOTO_MAX) photos.delete(photos.keys().next().value);
  return { ...photo, cached: false };
}

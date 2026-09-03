// TripAdvisor Content API (Technical Constraints §3.3): 5,000 calls/month free,
// renewing. Strongest of the licensed sources for attractions outside the US.
// Returns up to 5 reviews and 5 photos per location; attribution required.
// Display content is not stored — identifiers only.

const KEY = () => process.env.TRIPADVISOR_API_KEY?.trim();
const BASE = 'https://api.content.tripadvisor.com/api/v1';
export const TRIPADVISOR_ATTRIBUTION = 'Reviews and photos © Tripadvisor';

async function get(path, params) {
  const key = KEY();
  if (!key) throw new Error('TRIPADVISOR_API_KEY not set');
  const qs = new URLSearchParams({ key, language: 'en', ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Tripadvisor ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

const CATEGORY_MAP = { restaurants: 'restaurant', attractions: 'attraction', hotels: 'other', geos: 'other' };

function toVenue(loc, details = {}) {
  const category = CATEGORY_MAP[loc.category?.name ?? details.category?.name] ?? 'attraction';
  const subcats = (details.subcategory || loc.subcategory || []).map((s) => (s.localized_name || s.name || '').toLowerCase());
  const experiences = [];
  for (const s of subcats) {
    if (/museum/.test(s)) experiences.push('museum');
    else if (/gallery|art/.test(s)) experiences.push('art-gallery');
    else if (/park|garden|nature/.test(s)) experiences.push('park');
    else if (/zoo/.test(s)) experiences.push('zoo');
    else if (/aquarium/.test(s)) experiences.push('aquarium');
    else if (/theater|theatre|show/.test(s)) experiences.push('theatre');
    else if (/historic|landmark|monument|castle/.test(s)) experiences.push('history');
    else if (/beach/.test(s)) experiences.push('beach');
    else if (/amusement|theme/.test(s)) experiences.push('theme-park');
  }
  const cuisines = (details.cuisine || []).map((c) => (c.localized_name || c.name || '').toLowerCase());
  return {
    source: 'tripadvisor',
    sourcePlaceId: String(loc.location_id),
    name: loc.name,
    category,
    cuisines,
    experiences: [...new Set(experiences)],
    allergens: [],
    dietaryOptions: undefined,
    priceLevel: details.price_level ? details.price_level.length : null,
    rating: details.rating != null ? Number(details.rating) : null,
    ratingCount: details.num_reviews != null ? Number(details.num_reviews) : null,
    goodForChildren: null,
    lat: Number(details.latitude ?? loc.latitude),
    lng: Number(details.longitude ?? loc.longitude),
    dishes: [],
    justification: null,
    matchedDish: null,
    address: loc.address_obj?.address_string ?? details.address_obj?.address_string ?? null,
    website: details.website ?? null,
    externalUrl: details.web_url ?? null,
    openingHours: details.hours?.weekday_text?.join(' · ') ?? null,
    attribution: TRIPADVISOR_ATTRIBUTION,
    retention: { placeId: 'indefinite', displayFields: 'none' },
  };
}

export const tripadvisorSource = {
  key: 'tripadvisor',
  label: 'Tripadvisor',
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: TRIPADVISOR_ATTRIBUTION, requiresAuthorCredit: true },
  enabled: () => Boolean(KEY()),

  /** Nearby restaurants and/or attractions; details fetched for the nearest few to get ratings. */
  async search({ center, radiusKm = 3, categories = [], query = '', limit = 30 } = {}) {
    if (!KEY() || !center || center.lat == null) return [];
    const groups = [];
    const wantsFood = !categories.length || categories.some((c) => ['restaurant', 'cafe', 'pub', 'bar', 'food'].includes(c));
    const wantsThings = !categories.length || categories.some((c) => ['attraction', 'event', 'things'].includes(c));
    if (wantsFood) groups.push('restaurants');
    if (wantsThings) groups.push('attractions');
    const out = [];
    for (const category of groups) {
      const data = query?.trim()
        ? await get('/location/search', { searchQuery: query.trim(), category, latLong: `${center.lat},${center.lng}`, radius: String(Math.min(radiusKm, 25)), radiusUnit: 'km' })
        : await get('/location/nearby_search', { category, latLong: `${center.lat},${center.lng}`, radius: String(Math.min(radiusKm, 25)), radiusUnit: 'km' });
      const locs = (data.data || []).slice(0, Math.ceil(limit / groups.length));
      // Ratings live on the details call; fetch for the first handful only (each is a billable call).
      const withDetails = await Promise.all(locs.slice(0, 10).map(async (l) => { try { return toVenue(l, await get(`/location/${l.location_id}/details`, {})); } catch { return toVenue(l); } }));
      out.push(...withDetails, ...locs.slice(10).map((l) => toVenue(l)));
    }
    return out.filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng));
  },

  async get(id) {
    if (!KEY()) return null;
    const details = await get(`/location/${id}/details`, {});
    const v = toVenue({ location_id: id, name: details.name, category: details.category, address_obj: details.address_obj }, details);
    try {
      const rev = await get(`/location/${id}/reviews`, {});
      v.reviews = (rev.data || []).slice(0, 5).map((r) => ({ text: r.text, rating: r.rating, author: r.user?.username ?? null, authorUri: r.url ?? null, when: r.published_date ?? null }));
    } catch { v.reviews = []; }
    return v;
  },
};

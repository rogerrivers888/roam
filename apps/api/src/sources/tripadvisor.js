// Tripadvisor Terra Content API, Discover plan (Technical Constraints §3.3).
// Billing is per *entity*, not per call: every location ID returned by a
// search/nearby/details response counts once; a reviews or photos call counts
// once per location. The first 1,000 entities are free once per account, then
// $0.015 each, falling with volume. So the source is built to return as few
// IDs as it usefully can and never to fetch details behind a search.
//
// Nearby search already carries rating, review count, coordinates, address and
// the Tripadvisor URL, which is what the shortlist needs. Category, cuisines,
// price and hours arrive only on the details call, which the detail view makes
// for one venue at a time. Discover returns up to 3 reviews and 5 photos.
//
// Terms: only the location ID may be cached; all other content is fetched at
// display and never stored. Review text must be loaded via a call that
// crawlers cannot index, so the API answers robots.txt with Disallow: /.

const KEY = () => process.env.TRIPADVISOR_API_KEY?.trim();
const BASE = 'https://terra.tripadvisor.com/api';
export const TRIPADVISOR_ATTRIBUTION = 'Reviews and photos © Tripadvisor';

/** Discover: 20 is the page maximum, but every ID returned is billed, so browse takes fewer. */
const NEARBY_PAGE = Math.min(20, Math.max(1, Number(process.env.ROAM_TRIPADVISOR_PAGE) || 10));
const REVIEWS_PER_VENUE = 3;

async function get(path, params = {}) {
  const key = KEY();
  if (!key) throw new Error('TRIPADVISOR_API_KEY not set');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, String(v));
  }
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { accept: 'application/json', 'X-API-Key': key },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Tripadvisor ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

const pickTranslation = (list = [], lang = 'en') =>
  list.find((t) => t.primary)?.value ?? list.find((t) => t.language === lang)?.value ?? list[0]?.value ?? null;

const TOP_LEVEL = { 'Eat & Drink': 'restaurant', Attraction: 'attraction', Experience: 'attraction', Accommodation: 'other' };
const PRICE = { 'cheap eats': 1, 'mid range': 2, 'fine dining': 3 };

function experiencesFrom(labels) {
  const out = new Set();
  for (const raw of labels) {
    const s = raw.toLowerCase();
    if (/museum/.test(s)) out.add('museum');
    else if (/gallery|art/.test(s)) out.add('art-gallery');
    else if (/park|garden|nature/.test(s)) out.add('park');
    else if (/zoo/.test(s)) out.add('zoo');
    else if (/aquarium/.test(s)) out.add('aquarium');
    else if (/theater|theatre|show/.test(s)) out.add('theatre');
    else if (/historic|landmark|monument|castle/.test(s)) out.add('history');
    else if (/beach/.test(s)) out.add('beach');
    else if (/amusement|theme/.test(s)) out.add('theme-park');
  }
  return [...out];
}

function formattedHours(h) {
  if (!h) return null;
  if (Array.isArray(h.formatted)) return h.formatted.join(' · ');
  if (typeof h.formatted === 'string') return h.formatted;
  return null;
}

/**
 * Map a Terra location (catalog or full) onto Roam's venue shape.
 * `fallbackCategory` is the category the nearby call was filtered by, since
 * catalog results do not carry one.
 */
export function toVenue(loc, fallbackCategory = 'attraction') {
  const cats = loc.categories || [];
  const top = cats.map((c) => TOP_LEVEL[c.top_level_category]).find(Boolean);
  const labels = cats.flatMap((c) => [c.display_name, c.parent_category?.display_name, ...(Array.isArray(c.hierarchy) ? c.hierarchy : [])]).filter(Boolean);
  const attrs = loc.attributes || [];
  const cuisines = attrs.filter((a) => /cuisine/i.test(a.type || '')).map((a) => String(a.name || '').toLowerCase()).filter(Boolean);
  const kids = attrs.some((a) => /kid|child|family/i.test(a.name || '')) ? true : null;
  const overall = loc.traveler_ratings?.overall ?? loc.overall_rating ?? null;
  const address = (loc.addresses || []).find((a) => a.formatted)?.formatted ?? null;
  return {
    source: 'tripadvisor',
    sourcePlaceId: String(loc.id),
    name: pickTranslation(loc.names) ?? '',
    category: top ?? fallbackCategory,
    cuisines,
    experiences: experiencesFrom(labels),
    allergens: [],
    dietaryOptions: undefined,
    priceLevel: PRICE[String(loc.price_level || '').toLowerCase()] ?? null,
    rating: overall?.rating != null ? Number(overall.rating) : null,
    ratingCount: overall?.count != null ? Number(overall.count) : null,
    goodForChildren: kids,
    lat: Number(loc.coordinates?.latitude),
    lng: Number(loc.coordinates?.longitude),
    dishes: [],
    justification: null,
    matchedDish: null,
    address,
    website: loc.urls?.official ?? null,
    externalUrl: loc.urls?.tripadvisor?.main ?? (typeof loc.urls?.tripadvisor === 'string' ? loc.urls.tripadvisor : null),
    openingHours: formattedHours(loc.opening_hours),
    attribution: TRIPADVISOR_ATTRIBUTION,
    retention: { placeId: 'indefinite', displayFields: 'none' },
  };
}

const tokens = (q) => String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

export const tripadvisorSource = {
  key: 'tripadvisor',
  label: 'Tripadvisor',
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: TRIPADVISOR_ATTRIBUTION, requiresAuthorCredit: true },
  enabled: () => Boolean(KEY()),

  /**
   * One nearby call per group (restaurants, attractions). Ratings come with the
   * page, so no details are fetched here. Terra's text search is not
   * geo-bounded and bills every ID it returns, so a query is applied to the
   * nearby page by name instead; the other sources carry text search.
   */
  async search({ center, radiusKm = 3, categories = [], query = '', limit = 30 } = {}) {
    if (!KEY() || !center || center.lat == null) return [];
    const groups = [];
    const wantsFood = !categories.length || categories.some((c) => ['restaurant', 'cafe', 'pub', 'bar', 'food'].includes(c));
    const wantsThings = !categories.length || categories.some((c) => ['attraction', 'event', 'things'].includes(c));
    if (wantsFood) groups.push(['RESTAURANT', 'restaurant']);
    if (wantsThings) groups.push(['ATTRACTION', 'attraction']);
    const size = Math.min(NEARBY_PAGE, Math.max(1, Math.ceil(limit / Math.max(1, groups.length))));
    const out = [];
    for (const [category, roamCategory] of groups) {
      const data = await get('/catalog/locations/nearby', {
        lat: center.lat, lon: center.lng, radius: Math.min(radiusKm, 25), unit: 'KM', category, size,
      });
      for (const item of data.data || []) out.push(toVenue(item.location ?? item, roamCategory));
    }
    const terms = tokens(query);
    const matched = terms.length ? out.filter((v) => { const n = v.name.toLowerCase(); return terms.some((t) => n.includes(t)); }) : out;
    return matched.filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng));
  },

  /** Full detail plus up to 3 reviews (Discover). Two billable entities per view. */
  async get(id) {
    if (!KEY()) return null;
    const details = await get(`/locations/${id}`);
    const v = toVenue(details);
    try {
      const rev = await get(`/locations/${id}/reviews`, { size: REVIEWS_PER_VENUE, sort_by: 'MOST_RECENT', language: 'en' });
      v.reviews = (rev.data || []).slice(0, REVIEWS_PER_VENUE).map((r) => ({
        text: pickTranslation(r.text) ?? '',
        title: pickTranslation(r.title) ?? null,
        rating: r.rating ?? null,
        author: r.user?.username ?? null,
        authorUri: r.url ?? null,
        when: r.publish_ts ? String(r.publish_ts).slice(0, 10) : null,
      }));
    } catch { v.reviews = []; }
    return v;
  },
};

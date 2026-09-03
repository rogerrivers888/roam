// Tripadvisor Terra Content API, Discover plan (Technical Constraints §3.3).
// Billing is per *entity*, not per call: every location ID returned by a
// search/nearby/details response counts once; a reviews or photos call counts
// once per location. The first 1,000 entities are free once per account, then
// $0.015 each, falling with volume. So the source is built to return as few
// IDs as it usefully can and never to fetch details behind a search.
//
// What the catalog actually does (probed 3 Sep 2026, ~50 entities): the radius
// form of nearby search returns almost nothing (2 results within 5 km of
// Trafalgar Square); the bounding-box form works (2,262 in a 1 km box) but the
// `category`, `sort` and `min_rating` parameters are silently ignored, so a page
// is an arbitrary slice, mostly obscure listings. Text search by name is
// accurate: it returns the real venue with its rating. So this source has two
// modes. `search` (used only when Tripadvisor is the sole source picked, i.e.
// testing) takes one bounding-box page so you can see what Terra holds.
// `enrich` (the normal opt-in path) looks up by name the venues the other
// sources already found and hands back Tripadvisor's record for the resolver to
// merge — a couple of entities per venue, and every one is a venue on screen.
// Category, cuisines, price and hours arrive only on the details call, which
// the detail view makes for one venue at a time. Discover returns 3 reviews.
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
const URL_KIND = { Restaurant_Review: 'restaurant', Attraction_Review: 'attraction', Hotel_Review: 'other' };
const categoryFromUrl = (u) => (typeof u === 'string' ? URL_KIND[(/\/(Restaurant_Review|Attraction_Review|Hotel_Review)-/.exec(u) || [])[1]] : undefined);

export function toVenue(loc, fallbackCategory = 'attraction') {
  const cats = loc.categories || [];
  // Catalog pages carry no category, but the Tripadvisor URL says what kind of listing it is.
  const top = cats.map((c) => TOP_LEVEL[c.top_level_category]).find(Boolean)
    ?? categoryFromUrl(loc.urls?.tripadvisor?.main ?? loc.urls?.tripadvisor);
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

/** How many of the other sources' venues an opt-in search looks up by name. */
const ENRICH_LIMIT = Math.max(0, Number(process.env.ROAM_TRIPADVISOR_ENRICH ?? 8));
/** Name matches per lookup: Terra ranks loosely ("Trafalgar Square" → "Colonel Saab Trafalgar Square" first), so two tries. */
const ENRICH_SIZE = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (name) => String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(the|a|an|restaurant|cafe|bar|pub)\b/g, '').replace(/[^a-z0-9]/g, '');
const kmBetween = (a, b) => { const R = 6371, r = (d) => (d * Math.PI) / 180; const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

/** A box of ±radiusKm around a point; Terra's radius mode is unusable, the box works. */
function boxAround(center, radiusKm) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  return { sw_lat: center.lat - dLat, sw_lon: center.lng - dLng, ne_lat: center.lat + dLat, ne_lon: center.lng + dLng };
}

export const tripadvisorSource = {
  key: 'tripadvisor',
  label: 'Tripadvisor',
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: TRIPADVISOR_ATTRIBUTION, requiresAuthorCredit: true },
  enabled: () => Boolean(KEY()),
  /** Never searched unless the request names it — every ID returned is billed. */
  optIn: true,

  /**
   * One bounding-box page, unfiltered because Terra ignores its filters, then
   * cut to the wanted kinds by URL type and to the radius by distance. This is
   * the "just Tripadvisor" testing view; it is not a good browse on its own.
   */
  async search({ center, radiusKm = 3, categories = [], query = '', limit = 30, sources = [] } = {}) {
    if (!KEY() || !center || center.lat == null) return [];
    // With other sources in the mix the page is a waste; `enrich` does the work.
    if (Array.isArray(sources) && sources.length > 1) return [];
    const wantsFood = !categories.length || categories.some((c) => ['restaurant', 'cafe', 'pub', 'bar', 'food'].includes(c));
    const wantsThings = !categories.length || categories.some((c) => ['attraction', 'event', 'things'].includes(c));
    const kinds = new Set([...(wantsFood ? ['restaurant'] : []), ...(wantsThings ? ['attraction'] : [])]);
    const size = Math.min(NEARBY_PAGE, Math.max(1, limit));
    const data = await get('/catalog/locations/nearby', { ...boxAround(center, Math.min(radiusKm, 25)), size });
    const terms = tokens(query);
    const out = [];
    for (const item of data.data || []) {
      const v = toVenue(item.location ?? item, wantsThings ? 'attraction' : 'restaurant');
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
      if (!kinds.has(v.category)) continue;
      if (kmBetween(center, v) > radiusKm) continue;
      if (terms.length && !terms.some((t) => v.name.toLowerCase().includes(t))) continue;
      out.push(v);
    }
    return out;
  },

  /**
   * Look up other sources' venues by name and return Tripadvisor's records; the
   * resolver merges them where name and position agree, so a wrong hit costs an
   * entity but never reaches the screen. Unrated venues (OpenStreetMap-only)
   * go first, then the nearest, up to ENRICH_LIMIT lookups.
   */
  async enrich(venues, { center, locality = null } = {}) {
    if (!KEY() || !ENRICH_LIMIT) return [];
    const candidates = venues
      .filter((v) => v.source !== 'tripadvisor' && v.name && Number.isFinite(v.lat))
      .map((v) => ({ v, d: center ? kmBetween(center, v) : 0 }))
      .sort((a, b) => (a.v.rating == null) === (b.v.rating == null) ? a.d - b.d : (a.v.rating == null ? -1 : 1))
      .slice(0, ENRICH_LIMIT);
    const out = [];
    const seen = new Set();
    for (const { v } of candidates) {
      const params = { query: v.name.slice(0, 200), size: ENRICH_SIZE };
      if (locality) params.geo_name = locality;
      let data;
      try { data = await get('/catalog/locations/search', params); } catch (err) { if (/429/.test(err.message)) { await sleep(1200); continue; } throw err; }
      for (const item of data.data || []) {
        const loc = item.location ?? item;
        const hit = toVenue(loc, v.category);
        if (seen.has(hit.sourcePlaceId) || !Number.isFinite(hit.lat)) continue;
        // Only a record that will merge is worth returning; the resolver's rule is the same test.
        if (norm(hit.name) !== norm(v.name) || kmBetween(hit, v) > 0.4) continue;
        seen.add(hit.sourcePlaceId);
        out.push(hit);
        break;
      }
      await sleep(150); // Discover: 10 requests/second, and 429s arrive well before that
    }
    return out;
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

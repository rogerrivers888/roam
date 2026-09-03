// SeatGeek Platform API (free client id, immediate). US-strongest, with
// partial coverage of London, Toronto, Vancouver and Mexico City. A second
// opinion on ticketed events; events are timed venues like Ticketmaster's.
// Display content is not stored — identifiers only.

const KEY = () => process.env.SEATGEEK_CLIENT_ID?.trim();
const BASE = 'https://api.seatgeek.com/2';
export const SEATGEEK_ATTRIBUTION = 'Events by SeatGeek';

const TAXONOMY_EXPERIENCE = { concert: 'live-music', music_festival: 'festival', classical: 'live-music', theater: 'theatre', broadway_tickets_national: 'theatre', dance_performance_tour: 'theatre', comedy: 'comedy', film: 'cinema', sports: 'sports-game', family: 'festival' };

const stamp = (s) => (s ? new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`).toISOString() : null);

export const seatgeekSource = {
  key: 'seatgeek',
  label: 'SeatGeek',
  events: true,
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: SEATGEEK_ATTRIBUTION, requiresAuthorCredit: false },
  enabled: () => Boolean(KEY()),

  /** Events near a point inside an outing window. Only asked for when includeEvents is set. */
  async search({ center, radiusKm = 10, includeEvents = false, outingStart = null, outingEnd = null, query = '' } = {}) {
    if (!KEY() || !includeEvents || !center || center.lat == null) return [];
    const start = outingStart ? new Date(outingStart) : new Date();
    const end = outingEnd ? new Date(outingEnd) : new Date(start.getTime() + 36 * 3600_000);
    const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '');
    const params = new URLSearchParams({
      client_id: KEY(), lat: String(center.lat), lon: String(center.lng), range: `${Math.max(1, Math.min(Math.round(radiusKm), 100))}km`,
      'datetime_utc.gte': iso(new Date(start.getTime() - 6 * 3600_000)), 'datetime_utc.lte': iso(end),
      per_page: '50', sort: 'datetime_utc.asc', ...(query?.trim() ? { q: query.trim() } : {}),
    });
    const res = await fetch(`${BASE}/events?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`SeatGeek ${res.status}`);
    const data = await res.json();
    return (data.events || []).map((e) => {
      const lat = Number(e.venue?.location?.lat);
      const lng = Number(e.venue?.location?.lon);
      const startsAt = e.time_tbd ? null : stamp(e.datetime_utc);
      if (!startsAt || !Number.isFinite(lat)) return null;
      const taxonomies = (e.taxonomies || []).map((t) => t.name);
      const family = taxonomies.includes('family') || /family|kids|children/i.test(e.title || '');
      const experience = taxonomies.map((t) => TAXONOMY_EXPERIENCE[t]).find(Boolean) ?? TAXONOMY_EXPERIENCE[e.type] ?? 'festival';
      const price = e.stats?.lowest_price;
      return {
        source: 'seatgeek',
        sourcePlaceId: String(e.id),
        name: e.title,
        category: 'event',
        cuisines: [],
        experiences: [...new Set([experience, ...(family ? ['festival'] : [])])],
        allergens: [],
        dietaryOptions: undefined,
        priceLevel: price != null ? (price < 15 ? 1 : price < 40 ? 2 : 3) : null,
        rating: null,
        goodForChildren: family ? true : null,
        lat, lng,
        dishes: [],
        justification: e.performers?.length ? e.performers.map((p) => p.name).slice(0, 3).join(', ') : null,
        matchedDish: null,
        venueName: e.venue?.name ?? null,
        address: [e.venue?.address, e.venue?.city].filter(Boolean).join(', ') || null,
        startsAt,
        endsAt: new Date(new Date(startsAt).getTime() + 120 * 60_000).toISOString(),
        externalUrl: e.url ?? null,
        ticketed: true, fixed: false,
        attribution: SEATGEEK_ATTRIBUTION,
      };
    }).filter(Boolean);
  },
};

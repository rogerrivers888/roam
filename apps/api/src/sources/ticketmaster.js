// Ticketmaster Discovery API v2 (Technical Constraints §8): free key, immediate,
// 230,000+ events, US-strongest with the UK, Ireland and Europe covered.
// Events are timed venues: they carry startsAt/endsAt and are scheduled with
// waiting, exactly like the fixture events.

const KEY = () => process.env.TICKETMASTER_API_KEY?.trim();
const BASE = 'https://app.ticketmaster.com/discovery/v2';
export const TICKETMASTER_ATTRIBUTION = 'Events by Ticketmaster';

const SEGMENT_EXPERIENCE = { Music: 'live-music', Sports: 'sports-game', 'Arts & Theatre': 'theatre', Film: 'cinema', Miscellaneous: 'festival', Family: 'festival' };

export const ticketmasterSource = {
  key: 'ticketmaster',
  label: 'Ticketmaster',
  events: true,
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: TICKETMASTER_ATTRIBUTION, requiresAuthorCredit: false },
  enabled: () => Boolean(KEY()),

  /** Events near a point inside an outing window. Only asked for when includeEvents is set. */
  async search({ center, radiusKm = 10, includeEvents = false, outingStart = null, outingEnd = null, query = '' } = {}) {
    if (!KEY() || !includeEvents || !center || center.lat == null) return [];
    const start = outingStart ? new Date(outingStart) : new Date();
    const end = outingEnd ? new Date(outingEnd) : new Date(start.getTime() + 36 * 3600_000);
    const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const params = new URLSearchParams({
      apikey: KEY(), latlong: `${center.lat},${center.lng}`, radius: String(Math.min(Math.round(radiusKm), 100)), unit: 'km',
      startDateTime: iso(new Date(start.getTime() - 6 * 3600_000)), endDateTime: iso(end), size: '50', sort: 'date,asc',
      ...(query?.trim() ? { keyword: query.trim() } : {}),
    });
    const res = await fetch(`${BASE}/events.json?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Ticketmaster ${res.status}`);
    const data = await res.json();
    const events = data._embedded?.events || [];
    return events.map((e) => {
      const venue = e._embedded?.venues?.[0];
      const lat = Number(venue?.location?.latitude);
      const lng = Number(venue?.location?.longitude);
      const startsAt = e.dates?.start?.dateTime ?? (e.dates?.start?.localDate ? `${e.dates.start.localDate}T${e.dates.start.localTime ?? '19:00:00'}` : null);
      if (!startsAt || !Number.isFinite(lat)) return null;
      const seg = e.classifications?.[0]?.segment?.name;
      const family = e.classifications?.some((c) => c.family) || /family|kids|children/i.test(e.name);
      const price = e.priceRanges?.[0];
      return {
        source: 'ticketmaster',
        sourcePlaceId: e.id,
        name: e.name,
        category: 'event',
        cuisines: [],
        experiences: [SEGMENT_EXPERIENCE[seg] ?? 'festival', ...(family ? ['festival'] : [])],
        allergens: [],
        dietaryOptions: undefined,
        priceLevel: price ? (price.min < 15 ? 1 : price.min < 40 ? 2 : 3) : null,
        rating: null,
        goodForChildren: family ? true : null,
        lat, lng,
        dishes: [],
        justification: e.info ?? e.pleaseNote ?? null,
        matchedDish: null,
        venueName: venue?.name ?? null,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(new Date(startsAt).getTime() + 120 * 60_000).toISOString(),
        externalUrl: e.url ?? null,
        ticketed: true, fixed: false,
        attribution: TICKETMASTER_ATTRIBUTION,
      };
    }).filter(Boolean);
  },
};

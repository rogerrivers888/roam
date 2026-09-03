// PredictHQ Events API: aggregated, ranked events worldwide — concerts, sport,
// performing arts, festivals, expos and, unusually, *community* events (fairs,
// markets, parades). 14-day trial then a Free plan; a paid plan is the
// owner's decision (CLAUDE.md). Events are timed venues. Content is not stored.

const KEY = () => process.env.PREDICTHQ_API_KEY?.trim();
const BASE = 'https://api.predicthq.com/v1';
export const PREDICTHQ_ATTRIBUTION = 'Events by PredictHQ';

const CATEGORIES = ['community', 'festivals', 'performing-arts', 'concerts', 'sports', 'expos'];
const CATEGORY_EXPERIENCE = { community: 'festival', festivals: 'festival', 'performing-arts': 'theatre', concerts: 'live-music', sports: 'sports-game', expos: 'festival' };
const TICKETED = new Set(['performing-arts', 'concerts', 'sports', 'expos']);
const LABEL_EXPERIENCE = [
  [/market/, 'market'], [/comedy/, 'comedy'], [/film|cinema|movie/, 'cinema'], [/museum|exhibition/, 'museum'], [/parade|carnival|fair|fete|fête|festival/, 'festival'],
  [/theatre|theater|musical|opera|ballet|dance/, 'theatre'], [/music|concert|gig/, 'live-music'], [/heritage|history|historic/, 'history'], [/walk|hike|trail/, 'walk'],
];

export const predicthqSource = {
  key: 'predicthq',
  label: 'PredictHQ',
  events: true,
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: PREDICTHQ_ATTRIBUTION, requiresAuthorCredit: false },
  enabled: () => Boolean(KEY()),

  /** Events active inside the outing window, near a point. Only asked for when includeEvents is set. */
  async search({ center, radiusKm = 10, includeEvents = false, outingStart = null, outingEnd = null, query = '' } = {}) {
    if (!KEY() || !includeEvents || !center || center.lat == null) return [];
    const start = outingStart ? new Date(outingStart) : new Date();
    const end = outingEnd ? new Date(outingEnd) : new Date(start.getTime() + 36 * 3600_000);
    const params = new URLSearchParams({
      within: `${Math.max(1, Math.min(Math.round(radiusKm), 100))}km@${center.lat},${center.lng}`,
      'active.gte': start.toISOString(), 'active.lte': end.toISOString(),
      category: CATEGORIES.join(','), state: 'active', limit: '50', sort: 'start',
      ...(query?.trim() ? { q: query.trim() } : {}),
    });
    const res = await fetch(`${BASE}/events/?${params}`, { headers: { authorization: `Bearer ${KEY()}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`PredictHQ ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const data = await res.json();
    return (data.results || []).map((e) => {
      const [lng, lat] = e.location || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !e.start) return null;
      const labels = [...(e.labels || []), ...(e.phq_labels || []).map((l) => l.label)].map((l) => String(l).toLowerCase());
      const family = labels.some((l) => /family|kids|children/.test(l)) || /family|kids|children/i.test(e.title || '');
      const fromLabels = labels.map((l) => LABEL_EXPERIENCE.find(([re]) => re.test(l))?.[1]).filter(Boolean);
      const venue = (e.entities || []).find((x) => x.type === 'venue');
      const startsAt = new Date(e.start).toISOString();
      const endsAt = e.end && new Date(e.end) > new Date(e.start) && new Date(e.end) - new Date(e.start) < 12 * 3600_000
        ? new Date(e.end).toISOString() : new Date(new Date(startsAt).getTime() + 120 * 60_000).toISOString();
      return {
        source: 'predicthq',
        sourcePlaceId: String(e.id),
        name: e.title,
        category: 'event',
        cuisines: [],
        experiences: [...new Set([CATEGORY_EXPERIENCE[e.category] ?? 'festival', ...fromLabels])],
        allergens: [],
        dietaryOptions: undefined,
        priceLevel: null,
        rating: null,
        goodForChildren: family ? true : null,
        lat, lng,
        dishes: [],
        justification: e.description ? String(e.description).slice(0, 160) : null,
        matchedDish: null,
        venueName: venue?.name ?? null,
        address: venue?.formatted_address ?? e.geo?.address?.formatted_address ?? null,
        startsAt, endsAt,
        externalUrl: null,
        ticketed: TICKETED.has(e.category), fixed: false,
        attribution: PREDICTHQ_ATTRIBUTION,
        // PredictHQ's rank (0–100) says how big an event is; big is not better for a family day, so it is carried, not scored.
        rank: e.rank ?? null,
      };
    }).filter(Boolean);
  },
};

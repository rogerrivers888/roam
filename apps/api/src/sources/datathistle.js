import { bump } from './meter.js';
// Data Thistle (The List) — UK live events data: half a million future
// performances "from arena shows to village fairs", refreshed daily from
// 10,000+ venues. This is the structured version of the local paper's what's-on
// page: the fête, the library storytime, the farmers' market. Free tier of
// 1,000 requests a month per account (each search here is one request), paid
// plans above that, so switching it on is the owner's decision (CLAUDE.md).
// Bearer token that expires after 30 days. Content is not stored.

const KEY = () => process.env.DATATHISTLE_API_KEY?.trim();
const BASE = 'https://api.datathistle.com/v1';
export const DATATHISTLE_ATTRIBUTION = 'Listings by Data Thistle';

const TAG_EXPERIENCE = [
  [/^(music|live music|gigs?|jazz|folk|classical)$/, 'live-music'], [/theatre|drama|musicals?|dance|pantomime|opera/, 'theatre'], [/comedy/, 'comedy'], [/film|cinema/, 'cinema'],
  [/^sport/, 'sports-game'], [/walks?|hiking/, 'walk'], [/history|heritage|traditional/, 'history'], [/markets?/, 'market'], [/festivals?|fairs?|fete|carnival|days out|seasonal|easter|christmas|halloween/, 'festival'],
  [/museums?/, 'museum'], [/art|exhibitions?|galler/, 'art-gallery'], [/books|spoken word|storytime|library/, 'bookshop'], [/nature|outdoors|wildlife|parks?|gardens?/, 'park'], [/farm/, 'farm'],
];
const FAMILY = /kids|families|family|children|toddler/;

const inWindow = (ts, from, to) => { const t = new Date(ts).getTime(); return Number.isFinite(t) && t >= from && t <= to; };

export const datathistleSource = {
  key: 'datathistle',
  label: 'Data Thistle',
  events: true,
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: DATATHISTLE_ATTRIBUTION, requiresAuthorCredit: true },
  enabled: () => Boolean(KEY()),

  /** Performances near a point inside the outing window. One record per event-at-venue. Only asked for when includeEvents is set. */
  async search({ center, radiusKm = 10, includeEvents = false, outingStart = null, outingEnd = null, query = '', meter = null } = {}) {
    if (!KEY() || !includeEvents || !center || center.lat == null) return [];
    const start = outingStart ? new Date(outingStart) : new Date();
    const end = outingEnd ? new Date(outingEnd) : new Date(start.getTime() + 36 * 3600_000);
    const from = start.getTime() - 6 * 3600_000;
    const to = end.getTime();
    const params = new URLSearchParams({
      lat: String(center.lat), lon: String(center.lng), distance: String(Math.max(1, Math.min(radiusKm, 50)) / 1.609),
      min_date: new Date(from).toISOString(), max_date: end.toISOString(), limit: '20', order: 'ts',
      ...(query?.trim() ? { name: query.trim() } : {}),
    });
    bump(meter, 'datathistle');
    const res = await fetch(`${BASE}/events?${params}`, { headers: { authorization: `Bearer ${KEY()}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Data Thistle ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const body = await res.json();
    const events = Array.isArray(body) ? body : body.data ?? body.events ?? [];
    const out = [];
    for (const e of events) {
      const tags = (e.tags || []).map((t) => String(t).toLowerCase());
      const experiences = [...new Set(tags.map((t) => TAG_EXPERIENCE.find(([re]) => re.test(t))?.[1]).filter(Boolean))];
      const family = tags.some((t) => FAMILY.test(t)) || FAMILY.test((e.name || '').toLowerCase());
      const description = (e.descriptions ?? e.description ?? []).map((d) => (typeof d === 'string' ? d : d.description)).find(Boolean) ?? null;
      const image = (e.images || [])[0];
      for (const s of e.schedules || []) {
        const place = s.place || {};
        const lat = Number(place.lat);
        const lng = Number(place.lon ?? place.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const perf = (s.performances || []).find((p) => p.ts && !p.time_unknown && inWindow(p.ts, from, to));
        const startsAt = perf ? new Date(perf.ts).toISOString() : (s.start_ts && inWindow(s.start_ts, from, to) ? new Date(s.start_ts).toISOString() : null);
        if (!startsAt) continue;
        const durationMin = perf?.duration ? Number(String(perf.duration).match(/\d+/)?.[0]) : null;
        out.push({
          source: 'datathistle',
          sourcePlaceId: `${e.event_id}@${place.place_id ?? s.place_id ?? 'venue'}`,
          name: e.name,
          category: 'event',
          cuisines: [],
          experiences: experiences.length ? experiences : ['festival'],
          allergens: [],
          dietaryOptions: undefined,
          priceLevel: /free/i.test(s.ticket_summary || '') ? 0 : null,
          rating: null,
          goodForChildren: family ? true : null,
          lat, lng,
          dishes: [],
          justification: description ? description.slice(0, 160) : null,
          matchedDish: null,
          venueName: place.name ?? null,
          address: [place.address, place.town, place.postal_code].filter(Boolean).join(', ') || null,
          startsAt,
          endsAt: new Date(new Date(startsAt).getTime() + (Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 120) * 60_000).toISOString(),
          externalUrl: perf?.links?.[0]?.url ?? e.website ?? null,
          photos: image?.url ? [{ url: image.url, attribution: image.picture_credits ?? 'Data Thistle' }] : [],
          ticketed: !/free/i.test(s.ticket_summary || ''), fixed: false,
          attribution: DATATHISTLE_ATTRIBUTION,
        });
      }
    }
    return out;
  },
};

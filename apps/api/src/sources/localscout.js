// The local scout: Claude reads the open web for what's on in a place on a day.
//
// The aggregators carry the arena show and the West End run; nobody carries the
// village fête, the library Lego club or the Saturday farmers' market — that is
// in the council's what's-on page, the local paper and the venues' own sites.
// So for a place and a date, Claude searches and reads those pages and returns
// a closed list of events in our own schema, each with the page it came from.
//
// Rules this keeps (CLAUDE.md, Technical Constraints §13):
//   • It spends money (web searches + tokens), so it is off until the owner
//     sets ROAM_LOCAL_SCOUT=on; each call is written to provider_calls with the
//     household and session, inside the same spend bounds as the planner.
//   • Nothing is stored: results live in memory for a few hours per place+date
//     so a household refining a plan does not pay for the same search twice.
//   • We show a one-line summary and the source link; we never reproduce pages.
//   • Every event is a timed venue like Ticketmaster's, so it is composed,
//     pinned and dismissed exactly like any other stop — no new UI path.

import { searchWeb } from '../claude.js';
import { geocode } from './geocode.js';
import { wallClock, wallToUtc, DEFAULT_TZ } from '../domain/time.js';

export const SCOUT_ATTRIBUTION = "Found by Roam's local scout";
const KINDS = ['festival', 'market', 'live-music', 'theatre', 'comedy', 'cinema', 'sports-game', 'museum', 'art-gallery', 'history', 'walk', 'park', 'farm', 'bookshop', 'playground', 'theme-park', 'other'];
const MAX_EVENTS = 8;
const CACHE_TTL_MS = 6 * 3600_000;
// A plan must not wait on the open web: past this the plan goes ahead without
// the scout, whose search carries on and fills the cache for the next request.
const DEADLINE_MS = Number(process.env.ROAM_SCOUT_DEADLINE_MS || 90_000);
const cache = new Map();
const inflight = new Map();

const SYSTEM = `You are a local events scout for a family day-planning app. Given a place, a date and a radius, find real events happening ON THAT DATE within the radius that a family might go to: fêtes, fairs, markets, parades, open days, library and museum sessions, workshops, walks, shows, matches, gigs, exhibitions with timed events, seasonal events.

Search the way a local would: the town or borough council's "what's on" page, the local newspaper's events section, the tourist board, libraries, museums, theatres, parks and community centres near the place, plus general "things to do in <place> on <date>" searches. Open pages to confirm the date, the time and the venue. Prefer official or venue pages as the source.

Rules:
- Only include events you have confirmed are on the given date. Recurring events (e.g. "every Saturday") count if they run that day. Exclude anything you could not confirm, permanent attractions with no timed event, and events outside the radius.
- Give the venue name and its street address or town so it can be found on a map.
- Times are local to the place, 24-hour.
- "why" is one plain sentence a parent would find useful (what it is, who it suits, cost if known). Do not copy text from the page.
- Return at most ${MAX_EVENTS} events, best for a family first.

Answer with ONLY a JSON array inside a \`\`\`json fence, no prose. Each item:
{"title": string, "venue": string, "address": string, "start_local": "HH:MM", "end_local": "HH:MM" | null, "kind": one of ${JSON.stringify(KINDS)}, "family": true|false|null, "free": true|false|null, "ticketed": true|false|null, "why": string, "source_url": string}
If you find nothing you can confirm, return [].`;

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\[[\s\S]*\]/)?.[0];
  if (!fenced) return [];
  try { const v = JSON.parse(fenced); return Array.isArray(v) ? v : []; } catch { return []; }
}

const kmBetween = (a, b) => {
  const R = 6371; const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

export const localScoutSource = {
  key: 'scout',
  label: 'Local scout',
  events: true,
  retention: { placeId: 'indefinite', displayFields: 'none' },
  attribution: { text: SCOUT_ATTRIBUTION, requiresAuthorCredit: false },
  enabled: () => /^(on|true|1|yes)$/i.test(process.env.ROAM_LOCAL_SCOUT || '') && Boolean(process.env.ANTHROPIC_API_KEY?.trim()),

  /**
   * Events on the outing's date near its base. Needs the household and session
   * (for attribution) and a place label (for the searches); without them it
   * stays quiet rather than searching anonymously.
   */
  async search({ center, radiusKm = 5, includeEvents = false, outingStart = null, outingEnd = null, placeLabel = null, householdId = null, sessionId = null, timezone = null } = {}) {
    if (!this.enabled() || !includeEvents || !center || center.lat == null || !placeLabel || !householdId) return [];
    const tz = timezone || DEFAULT_TZ;
    const start = outingStart ? new Date(outingStart) : new Date();
    const end = outingEnd ? new Date(outingEnd) : new Date(start.getTime() + 8 * 3600_000);
    const day = wallClock(start, tz);
    const radius = Math.max(2, Math.min(Math.round(radiusKm), 25));
    const cacheKey = `${center.lat.toFixed(2)},${center.lng.toFixed(2)}|${day.dateStr}|${radius}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.venues;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);

    const run = (async () => {
      const prompt = `Place: ${placeLabel} (lat ${center.lat.toFixed(4)}, lng ${center.lng.toFixed(4)}).\nDate: ${day.dateStr} (${new Date(start).toLocaleDateString('en-GB', { weekday: 'long', timeZone: tz })}). The family is there roughly ${day.hhmm}–${wallClock(end, tz).hhmm} local time; events that overlap that window are best, others on the day are fine.\nRadius: ${radius} km.`;
      const { text } = await searchWeb({ system: SYSTEM, prompt, householdId, sessionId, purpose: 'scout.events' });
      const items = extractJson(text).slice(0, MAX_EVENTS);
      const venues = [];
      for (const it of items) {
        if (!it?.title || !it?.source_url || !/^\d{1,2}:\d{2}$/.test(it.start_local || '')) continue;
        // Place the venue on the map from what the scout said, biased to the base.
        let hit = null;
        for (const text of [[it.venue, it.address].filter(Boolean).join(', '), it.address, it.venue].filter(Boolean)) {
          try { [hit] = await geocode(text, { limit: 1, near: center }); } catch { hit = null; }
          if (hit) break;
        }
        if (!hit || kmBetween(center, hit) > radius * 1.5) continue;
        const startsAt = wallToUtc(day.dateStr, it.start_local.padStart(5, '0'), tz);
        const endsAt = /^\d{1,2}:\d{2}$/.test(it.end_local || '') && wallToUtc(day.dateStr, it.end_local.padStart(5, '0'), tz) > startsAt
          ? wallToUtc(day.dateStr, it.end_local.padStart(5, '0'), tz) : new Date(startsAt.getTime() + 120 * 60_000);
        const kind = KINDS.includes(it.kind) ? it.kind : 'other';
        const host = hostOf(it.source_url);
        venues.push({
          source: 'scout',
          sourcePlaceId: `${day.dateStr}:${slug(it.title)}`,
          name: it.title,
          category: 'event',
          cuisines: [],
          experiences: kind === 'other' ? ['festival'] : [kind],
          allergens: [],
          dietaryOptions: undefined,
          priceLevel: it.free === true ? 0 : null,
          rating: null,
          goodForChildren: it.family === true ? true : null,
          lat: hit.lat, lng: hit.lng,
          dishes: [],
          justification: it.why ? String(it.why).slice(0, 200) : null,
          matchedDish: null,
          venueName: it.venue ?? null,
          address: hit.formatted ?? it.address ?? null,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          externalUrl: it.source_url,
          ticketed: it.ticketed === true, fixed: false,
          attribution: host ? `${SCOUT_ATTRIBUTION} · ${host}` : SCOUT_ATTRIBUTION,
        });
      }
      cache.set(cacheKey, { venues, expires: Date.now() + CACHE_TTL_MS });
      return venues;
    })();
    inflight.set(cacheKey, run);
    run.finally(() => inflight.delete(cacheKey)).catch(() => {});
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), DEADLINE_MS));
    const result = await Promise.race([run, timeout]);
    if (result === 'timeout') throw new Error(`local scout still searching after ${Math.round(DEADLINE_MS / 1000)}s — its findings will be in the next plan for this place and day`);
    return result;
  },
};

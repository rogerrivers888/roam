// Conversational trip planning.
//
// The household says what it wants — "we're going from home to the opera house,
// three hours, at least two things to do" — and reacts to what comes back —
// "I like the museum but not the pub". Speech and typing arrive here as the
// same text; taps arrive at /act as the same state changes. Claude interprets
// language into structured intent and into selections over the CLOSED SET of
// stops currently on screen (Epic 5 C7); it never invents venues.

import { Router } from 'express';
import { z } from 'zod/v4';
import { query } from '../db.js';
import { parseStructured, spendSummary, SpendBoundError } from '../claude.js';
import { searchAllSources, eventSources } from '../sources/index.js';
import { resolvePlace, KNOWN_PLACES } from '../sources/fixtures.js';
import { geocode, reverseGeocode } from '../sources/geocode.js';
import { deriveCatchment, reachRadiusKm, estimateTravelMinutes, TRAVEL_MODES } from '../domain/travel.js';
import { applyConstraints } from '../domain/ranking.js';
import { composeOptions, PRICE_POINTS } from '../domain/options.js';
import { paceOf, travelLimitFor, maxReachMinutes } from '../domain/pace.js';
import { dayAsTrip, slotFor } from '../domain/days.js';
import { routingEnabled, travelMatrixMinutes, routeBetween } from '../sources/routing.js';
import { wallToUtc, wallClock, DEFAULT_TZ } from '../domain/time.js';
import { INTENSITY_TARGETS } from '../domain/budget.js';
import { currentHousehold, loadMembers, toAttendees, loadLearnedPreferences } from './household.js';

const router = Router();

// ---------------------------------------------------------------------------
// Schemas — what Claude is allowed to return.
// ---------------------------------------------------------------------------

const TripIntent = z.object({
  understood: z.boolean().describe('False if the message is not about planning an outing'),
  origin: z.string().nullable().describe('Where the outing starts, as the user said it; null if not said'),
  destination: z.string().nullable().describe('Where the outing ends, if different from the origin; null if not said or if they return to the origin'),
  duration_minutes: z.number().int().nullable().describe('How long they have AT the destination, in minutes, not counting the journey there; null if not said'),
  date: z.string().nullable().describe('The date of the outing as YYYY-MM-DD, resolved from words like "Saturday" or "tomorrow" using today\'s date; null if not said'),
  depart_time: z.string().nullable().describe('Departure clock time as HH:MM 24h if the user said when they leave; null otherwise (a show time is NOT a departure time)'),
  anchor: z.object({
    name: z.string().describe('The fixed commitment the outing is planned around, e.g. "Paddington the Musical"'),
    place_text: z.string().nullable().describe('Where it is, as precisely as you know — venue name and city (e.g. "Savoy Theatre, London"); null if you do not know'),
    start_time: z.string().nullable().describe('HH:MM 24h start, if said'),
    duration_minutes: z.number().int().nullable().describe('Typical length: a West End show ~150, a football match ~120, a cinema film ~120'),
    kind: z.enum(['theatre', 'cinema', 'sports-game', 'live-music', 'museum', 'booking', 'other']),
  }).nullable().describe('A show, match, booking or appointment with a fixed time that the day must fit around; null if none'),
  wants_events: z.boolean().describe('True if they asked what events or special things are on'),
  travel_mode: z.enum(['walking', 'cycling', 'driving', 'transit']).nullable(),
  min_activities: z.number().int().nullable().describe('Minimum number of things to do (attractions or events), if said'),
  min_food_stops: z.number().int().nullable().describe('Minimum number of places to eat or drink, if said'),
  intensity: z.enum(['relaxed', 'balanced', 'packed']).nullable().describe('How full they want the time; infer only from explicit cues like "relaxed", "pack it in"'),
  wants: z.array(z.string()).describe('Specific things asked for, e.g. "ramen", "somewhere with live music", "a park"'),
  avoids: z.array(z.string()).describe('Things explicitly not wanted'),
  attending: z.array(z.string()).describe('Household member names mentioned as coming; empty if nobody was named'),
  attending_everyone: z.boolean().nullable().describe('True if they said everyone, all of us or the whole family is coming, or answered yes when the app asked whether everyone is coming; false if they named only some people; null if who is coming was not mentioned'),
  special: z.boolean().describe('True if they want somewhere special — a treat, an occasion, worth going further for'),
  price_point: z.enum(['affordable', 'mid', 'upmarket']).nullable().describe('How much they want to spend on food, if said: "cheap and cheerful" is affordable, "nice but not silly" is mid, "upmarket", "high quality", "somewhere really good" is upmarket; null if not said'),
  avoid_chains: z.boolean().nullable().describe('True if they said no chains, independents only, somewhere unique or family-run; false if they said chains are fine; null if not mentioned'),
  reply: z.string().describe('One short, warm sentence acknowledging what was understood, or asking for the single most important missing detail'),
});

const Refinement = z.object({
  liked_stop_ids: z.array(z.string()).describe('IDs of stops the user wants to keep'),
  disliked_stop_ids: z.array(z.string()).describe('IDs of stops the user does not want'),
  chosen_option_id: z.string().nullable().describe('If the user picked a whole option, its ID'),
  replacements: z.array(z.object({
    stop_id: z.string(),
    with: z.string().describe('What they want instead, in their words'),
  })).describe('Requests to swap a specific stop for something else'),
  trip_changes: z.object({
    duration_minutes: z.number().int().nullable(),
    intensity: z.enum(['relaxed', 'balanced', 'packed']).nullable(),
    travel_mode: z.enum(['walking', 'cycling', 'driving', 'transit']).nullable(),
    min_activities: z.number().int().nullable(),
    min_food_stops: z.number().int().nullable(),
    price_point: z.enum(['any', 'affordable', 'mid', 'upmarket']).nullable().describe('"somewhere upmarket" → upmarket, "cheaper" → affordable, "doesn\'t matter" → any'),
    avoid_chains: z.boolean().nullable().describe('"no chains" → true, "chains are fine" → false'),
  }).describe('Changes to the trip itself; all null if none'),
  suggested_preferences: z.array(z.object({
    member: z.string().nullable().describe('Member name if the preference is about one person, else null for the household'),
    kind: z.enum(['like', 'dislike']),
    value: z.string(),
  })).describe('Durable tastes the message reveals, worth offering to save — never save them yourself'),
  ambiguous: z.string().nullable().describe('If a reference could mean more than one stop, a short question naming the candidates; else null'),
  reply: z.string().describe('One or two short sentences saying what will change'),
});

// ---------------------------------------------------------------------------
// Prompts — stable text only; everything that varies goes in messages.
// ---------------------------------------------------------------------------

const INTERPRET_SYSTEM = `You turn what a family says about an outing into a structured trip request.

You are given the household (members, defaults) and a list of place names the app knows. Extract only what was said; do not invent an origin, duration or preferences. If the origin or the duration is missing, say so in the reply by asking for that one thing, briefly and warmly. Durations like "three hours" become minutes. "From X to Y" means origin X, destination Y. Any way of saying home — "home", "from home", "our house", "from ours", "around here", "near us", or the household's own home address if the context shows one — means the origin is exactly the word "home". If the user names a place the app does not know, keep their wording in origin/destination anyway.

Money and chains: "somewhere upmarket", "really good", "a proper steakhouse" set price_point upmarket; "cheap", "quick bite" affordable. "No chains", "independent", "family-run", "somewhere unique" set avoid_chains true.

Who is coming: names go in attending. "Everyone", "all of us", "the whole family", or "yes" in answer to the app asking whether everyone is coming, means attending_everyone is true. If nobody is mentioned, leave attending empty and attending_everyone null; the app will ask. The context may include the question the app last asked: a short answer like "yes", "home" or "three hours" answers that question.

Dates: resolve "Saturday", "tomorrow", "next Friday" to a YYYY-MM-DD from today's date in the context. Durations: "spend three hours there" is time at the destination and excludes travel. A fixed commitment (a show, a match, a booking) with a time is an anchor, not a departure — fill in the anchor with the venue if you know it (well-known productions and teams have known venues), and leave place_text null if you are not sure rather than guessing.

The reply is spoken aloud as well as shown, so keep it to one plain sentence with no lists or markup.`;

const REFINE_SYSTEM = `You interpret a family's reaction to suggested day plans.

You are given the options currently on screen, each with stops that have IDs, and what the user said. Map their words ONLY onto those stop IDs. "The museum" means the stop whose name or category is a museum; "the first one" means the first stop of the option they are looking at; "this plan" means the option in view. If a phrase could mean more than one stop, put a short question in "ambiguous" and leave the ID lists empty for that reference. Never invent stops or IDs.

Likes go in liked_stop_ids, dislikes in disliked_stop_ids. "Swap X for a park" is a replacement. "Make it longer" or "more relaxed" are trip changes. If a remark reveals a lasting taste ("Ada hates museums", "we always want ramen"), offer it in suggested_preferences — the app will ask before saving anything.

The reply is spoken aloud as well as shown: one or two plain sentences, no lists, no markup.`;

// ---------------------------------------------------------------------------
// Session state helpers
// ---------------------------------------------------------------------------

async function loadSession(id) {
  const { rows } = await query('select * from plan_sessions where id = $1 and expires_at > now()', [id]);
  if (!rows[0]) {
    const err = new Error('Planning session not found or expired');
    err.status = 404;
    err.code = 'session_not_found';
    throw err;
  }
  return rows[0];
}

async function saveSession(id, state, tripId) {
  await query(
    'update plan_sessions set state = $2, trip_id = coalesce($3, trip_id), updated_at = now() where id = $1',
    [id, JSON.stringify(state), tripId ?? null],
  );
}

function householdContext(household, members) {
  return {
    today: new Date().toISOString().slice(0, 10),
    now: new Date().toTimeString().slice(0, 5),
    household: {
      name: household.name,
      home: household.home_lat != null ? household.home_label : null,
      defaultVisitMinutes: household.default_visit_minutes,
      maxTravelMinutes: household.max_travel_minutes,
      defaultIntensity: household.default_intensity,
    },
    members: members.map((m) => ({
      name: m.name,
      isMinor: m.isMinor,
      allergens: m.allergens.map((c) => c.value),
      dislikes: m.dislikes.map((c) => c.value),
      likes: m.likes.map((c) => c.value),
    })),
    knownPlaces: KNOWN_PLACES.map((p) => p.label),
  };
}

/**
 * Where a spoken place is: the household's home, a place the app knows, or —
 * for anywhere else in the world — a geocoded match biased toward home.
 */
// "home", "from home", "our house", "from ours", "the house", "my place"...
const HOME_WORDS = /^(?:from\s+|at\s+)?(?:our\s+|my\s+|the\s+)?(?:home|house|place|ours)$/i;

async function resolveSpokenPlace(text, household) {
  if (!text) return null;
  const home = household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null;
  const said = text.trim().replace(/[.!,]+$/, '');
  if (home && (HOME_WORDS.test(said) || said.toLowerCase() === String(household.home_label || '').toLowerCase())) return { ...home, how: 'home' };
  const known = resolvePlace(text);
  if (known) return { ...known, how: 'known' };
  try {
    const [hit] = await geocode(text, { limit: 1, near: home });
    return hit ? { label: hit.label, lat: hit.lat, lng: hit.lng, country: hit.country, countryCode: hit.countryCode, locality: hit.locality, how: 'geocoded' } : null;
  } catch {
    return null;
  }
}

function roundUpToQuarter(date) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15);
  return d;
}

/**
 * "Sunningdale → London · Paddington the Musical": where from, where to, what
 * for — so the list reads at a glance. Places are named by their town, not
 * their full address; home is looked up once so it reads as its village.
 */
async function outingTitle({ origin, destination, anchorPlace, anchor }) {
  const nameOf = async (p) => {
    if (!p) return null;
    if (p.locality) return p.locality;
    if (p.how === 'home') {
      try { const r = await reverseGeocode(p.lat, p.lng, { zoom: 14 }); if (r?.locality) return r.locality; } catch { /* fall back to the label */ }
    }
    return String(p.label).split(',')[0].trim();
  };
  const from = await nameOf(origin);
  const to = await nameOf(anchorPlace ?? destination);
  const route = to && to !== from ? `${from} → ${to}` : `Around ${from}`;
  return anchor?.name ? `${route} · ${anchor.name}` : route;
}

/** Turn an intent into a trip row in the database. */
async function createTripFromIntent({ household, members, intent, origin, destination, anchorPlace, sources = null }) {
  const tz = household.timezone || DEFAULT_TZ;
  const dateStr = intent.date && /^\d{4}-\d{2}-\d{2}$/.test(intent.date) ? intent.date : wallClock(new Date(), tz).dateStr;
  const at = (hhmm) => wallToUtc(dateStr, hhmm, tz);
  const duration = intent.duration_minutes;
  let depart;
  let returnAt;
  const anchor = intent.anchor;
  if (anchor?.start_time) {
    // The window is time at the destination, wrapped around the fixed commitment.
    // "Three hours there" around a 2½-hour show means three hours besides the
    // show — otherwise there would be nothing to plan. Weighted before it.
    const start = at(anchor.start_time);
    const len = anchor.duration_minutes ?? 120;
    const spare = Math.max(60, duration);
    const before = Math.round(spare * 0.6);
    depart = new Date(start.getTime() - before * 60_000);
    returnAt = new Date(start.getTime() + (len + (spare - before)) * 60_000);
  } else if (intent.depart_time) {
    depart = at(intent.depart_time);
    returnAt = new Date(depart.getTime() + duration * 60_000);
  } else {
    depart = intent.date ? at('10:00') : roundUpToQuarter(new Date());
    returnAt = new Date(depart.getTime() + duration * 60_000);
  }
  const wc = (d) => wallClock(d, tz).hhmm;
  const mode = intent.travel_mode && TRAVEL_MODES.includes(intent.travel_mode) ? intent.travel_mode : 'transit';
  const intensity = intent.intensity && INTENSITY_TARGETS[intent.intensity] ? intent.intensity : household.default_intensity;
  // Where the day happens: the anchor's venue, else the destination, else the origin.
  const base = anchorPlace ?? destination ?? origin;
  const title = await outingTitle({ origin, destination, anchorPlace, anchor });

  const { rows } = await query(
    `insert into trips (household_id, kind, title, origin_label, origin_lat, origin_lng,
                        destination_label, destination_lat, destination_lng,
                        depart_at, return_at, travel_mode, intensity,
                        start_date, end_date, base_label, base_lat, base_lng, base_kind, day_start, day_end, has_car, timezone, sources)
     values ($1,'outing',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$13::date,$14,$15,$16,$17,$19::time,$20::time,$18,$21,$22) returning *`,
    [
      household.id, title,
      origin.label, origin.lat, origin.lng,
      (destination ?? anchorPlace)?.label ?? null, (destination ?? anchorPlace)?.lat ?? null, (destination ?? anchorPlace)?.lng ?? null,
      depart.toISOString(), returnAt.toISOString(), mode, intensity,
      dateStr, base.label, base.lat, base.lng, base === origin ? 'home' : 'other', mode === 'driving',
      wc(depart), wc(returnAt), tz, sources ? JSON.stringify(sources) : null,
    ],
  );
  const trip = rows[0];
  const { rows: dayRows } = await query(
    'insert into trip_days (trip_id, date, intensity, travel_mode, start_time, end_time) values ($1, $2, $3, $4, $5::time, $6::time) returning *',
    [trip.id, dateStr, intensity, mode, wc(depart), wc(returnAt)],
  );
  trip.day = dayRows[0];

  // Where the outing "is", for grouping trips by country and place later.
  const placeAnchor = anchorPlace ?? destination ?? origin;
  try {
    const where = placeAnchor.countryCode ? placeAnchor : await reverseGeocode(placeAnchor.lat, placeAnchor.lng);
    if (where) {
      await query('update trips set country = $2, country_code = $3, locality = $4 where id = $1', [trip.id, where.country, where.countryCode, where.locality]);
      Object.assign(trip, { country: where.country, country_code: where.countryCode, locality: where.locality });
    }
  } catch { /* unknown is acceptable */ }

  const attendingNames = new Set(intent.attending.map((n) => n.toLowerCase()));
  const attending = attendingNames.size
    ? members.filter((m) => attendingNames.has(m.name.toLowerCase()))
    : members;
  for (const m of attending.length ? attending : members) {
    await query('insert into trip_attendees (trip_id, member_id) values ($1, $2) on conflict do nothing', [trip.id, m.id]);
  }
  return { trip, attending: attending.length ? attending : members };
}

/** Retrieve the candidate pool ONCE for a trip (Epic 5 C3). */
async function retrievePool({ household, trip, attendees, intent, sessionId }) {
  const durationMinutes = Math.round((new Date(trip.return_at) - new Date(trip.depart_at)) / 60_000);
  const pace = paceOf(household);
  const special = Boolean(intent.special);
  // Reach is bounded by the household's pace (per kind, wider if special) and
  // by the window itself: nobody spends more than a third of three hours travelling.
  const maxTravelMinutes = Math.min(maxReachMinutes(pace, { special }), Math.max(15, Math.round(durationMinutes / 2)));

  const wantsText = (intent.wants || []).join(' ');
  const originPoint = { lat: trip.origin_lat, lng: trip.origin_lng };
  // The pool is what's around the base within a comfortable hop, not the whole
  // reach: a day in central London is a 2–3 km affair; a driving day a bit more.
  const hopRadiusKm = Math.min(reachRadiusKm(trip.travel_mode, maxTravelMinutes), trip.travel_mode === 'driving' ? 10 : trip.travel_mode === 'cycling' ? 5 : 3);
  const { venues, degraded, sourcesQueried } = await searchAllSources({
    center: originPoint,
    radiusKm: hopRadiusKm,
    categories: [],
    query: '',
    includeEvents: true,
    outingStart: trip.depart_at,
    // A trip's saved source set applies to its plans too; Tripadvisor only when the trip names it.
    sources: Array.isArray(trip.sources) ? trip.sources : [],
    locality: trip.locality ?? null,
    outingEnd: trip.return_at,
    // For the local scout: where and when in words, and who is asking.
    placeLabel: trip.origin_label,
    timezone: trip.timezone || household.timezone || null,
    householdId: household.id,
    sessionId,
  });
  await query(
    `insert into provider_calls (household_id, session_id, provider, purpose) values ($1, $2, $3, $4)`,
    [household.id, sessionId, sourcesQueried.join('+') || 'none', 'plan.retrieve'],
  );

  // Places the household has marked special may be further than the usual limit.
  const { rows: specials } = await query(`select source || ':' || source_place_id as ref from place_ledger where household_id = $1 and status = 'special'`, [household.id]);
  const specialRefs = new Set(specials.map((r) => r.ref));
  let reached = deriveCatchment({ origin: originPoint, maxTravelMinutes: maxTravelMinutes * 1.5, mode: trip.travel_mode, venues });
  // Real durations from the base when Google Routes is on; the estimate stays as the fallback.
  if (routingEnabled() && reached.length) {
    try {
      const real = await travelMatrixMinutes({ origin: originPoint, destinations: reached.slice(0, 200), mode: trip.travel_mode, departAt: trip.depart_at });
      if (real) reached = reached.map((v, i) => (real[i] ? { ...v, travelMinutes: real[i].minutes, travelEstimated: false } : { ...v, travelEstimated: true }));
      await query('insert into provider_calls (household_id, session_id, provider, purpose) values ($1, $2, $3, $4)', [household.id, sessionId, 'google-routes', 'plan.matrix']);
    } catch { /* keep estimates */ }
  }
  const inReach = reached
    .filter((v) => v.travelMinutes <= maxTravelMinutes || v.travelEstimated === false)
    .map((v) => ({ ...v, special: specialRefs.has(`${v.source}:${v.sourcePlaceId}`) }))
    // A restaurant 40 minutes away is out; a castle 40 minutes away is fine.
    .filter((v) => v.travelMinutes <= travelLimitFor(pace, v, { special }));
  const learned = await loadLearnedPreferences(household.id);
  const { candidates, excluded } = applyConstraints({ venues: inReach, attendees, learned });

  // "Wants" are a soft boost, not a filter: the pool stays broad so options can differ.
  const wantTerms = (intent.wants || []).map((w) => w.toLowerCase());
  for (const c of candidates) {
    const hay = [c.name, c.category, ...(c.cuisines || []), ...(c.dishes || []).map((d) => d.name)].join(' ').toLowerCase();
    const hit = wantTerms.find((w) => hay.includes(w));
    if (hit) {
      c.score += 10;
      c.reasons = [...(c.reasons || []), { kind: 'want', text: `You asked for ${hit}` }];
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  return { candidates, excluded, degraded, maxTravelMinutes, sourcesQueried, wantsText };
}

function publicTrip(trip) {
  return {
    id: trip.id,
    title: trip.title,
    origin: { label: trip.origin_label, lat: trip.origin_lat, lng: trip.origin_lng },
    destination: trip.destination_label
      ? { label: trip.destination_label, lat: trip.destination_lat, lng: trip.destination_lng }
      : null,
    departAt: trip.depart_at,
    returnAt: trip.return_at,
    travelMode: trip.travel_mode,
    intensity: trip.intensity,
    country: trip.country ?? null,
    countryCode: trip.country_code ?? null,
    locality: trip.locality ?? null,
  };
}

/** The trip a session plans: the real trip, or one day of it seen as a trip. */
async function sessionTrip(session) {
  const { rows } = await query('select * from trips where id = $1', [session.trip_id]);
  const real = rows[0];
  if (session.state.dayId) {
    const { rows: d } = await query('select * from trip_days where id = $1', [session.state.dayId]);
    if (d[0]) return { trip: dayAsTrip(real, d[0]), real, day: d[0] };
  }
  return { trip: real, real, day: null };
}

/** Window / pace / mode changes land on the day when the session is a day. */
async function applyTripChanges(session, { durationMinutes, intensity, travelMode }) {
  if (session.state.dayId) {
    if (durationMinutes != null) {
      const { trip } = await sessionTrip(session);
      const start = new Date(trip.depart_at);
      const end = new Date(start.getTime() + Number(durationMinutes) * 60_000);
      await query('update trip_days set end_time = $2::time where id = $1', [session.state.dayId, wallClock(end, trip.timezone || DEFAULT_TZ).hhmm]);
    }
    if (intensity) await query('update trip_days set intensity = $2 where id = $1', [session.state.dayId, intensity]);
    if (travelMode) await query('update trip_days set travel_mode = $2 where id = $1', [session.state.dayId, travelMode]);
    return;
  }
  if (durationMinutes != null) await query(`update trips set return_at = depart_at + ($2::int * interval '1 minute') where id = $1`, [session.trip_id, Number(durationMinutes)]);
  if (intensity) await query('update trips set intensity = $2 where id = $1', [session.trip_id, intensity]);
  if (travelMode) await query('update trips set travel_mode = $2 where id = $1', [session.trip_id, travelMode]);
}

async function recompose(session, household) {
  const { state } = session;
  const { trip } = await sessionTrip(session);
  const composed = composeOptions({
    trip,
    household,
    pool: state.pool,
    minActivities: state.minActivities,
    minFood: state.minFood,
    pinned: state.pinned,
    excluded: state.excluded,
    attendees: state.attendeePrefs || [],
    includeChains: state.includeChains === true,
    pricePoint: PRICE_POINTS.includes(state.pricePoint) ? state.pricePoint : 'any',
  });
  return { trip, ...composed };
}

/** What every planning session for this trip has cost so far (provider_calls via plan_sessions). */
export async function tripSpend(tripId) {
  const { rows: [r] } = await query(
    `select count(pc.*)::int as trip_calls, coalesce(sum(pc.estimated_cost_usd), 0)::float as trip_cost_usd
       from provider_calls pc join plan_sessions ps on ps.id = pc.session_id where ps.trip_id = $1`,
    [tripId],
  );
  return { trip_calls: r.trip_calls, trip_cost_usd: r.trip_cost_usd };
}

async function respond(res, { session, household, reply, extra = {} }) {
  const { trip, options, browse, poolSize, target, hiddenChains } = await recompose(session, household);
  const spend = { ...(await spendSummary({ householdId: household.id, sessionId: session.id })), ...(await tripSpend(trip.id)) };
  res.json({
    sessionId: session.id,
    dayId: session.state.dayId ?? null,
    date: session.state.date ?? null,
    journey: session.state.journey ?? null,
    anchor: session.state.anchor ?? null,
    trip: publicTrip(trip),
    reply,
    options,
    // Everything found nearby, for browsing and adding; and whether any source
    // of timed events is on at all, so "nothing on" can be told from "not looked".
    browse,
    eventsSource: eventSources().map((s) => s.label).join(', ') || null,
    selection: {
      pinned: session.state.pinned,
      excluded: session.state.excluded,
      chosenOptionId: session.state.chosenOptionId ?? null,
    },
    constraints: { minActivities: session.state.minActivities, minFood: session.state.minFood, includeChains: session.state.includeChains === true, pricePoint: PRICE_POINTS.includes(session.state.pricePoint) ? session.state.pricePoint : 'any' },
    pool: { size: poolSize, targetFill: target, excludedByAllergen: session.state.excludedByAllergen ?? [], hiddenChains: hiddenChains ?? 0 },
    suggestedPreferences: session.state.suggestedPreferences ?? [],
    spend,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Start (or continue clarifying) a plan from a sentence.
 * Body: { utterance, sessionId? }
 */
router.post('/start', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { utterance, sessionId: existingId, sources: pickedSources } = req.body || {};
    if (!utterance?.trim()) return res.status(400).json({ error: 'utterance_required' });

    let session;
    if (existingId) {
      session = await loadSession(existingId);
    } else {
      const { rows } = await query(
        'insert into plan_sessions (household_id, state) values ($1, $2) returning *',
        [household.id, JSON.stringify({ transcript: [] })],
      );
      session = rows[0];
    }
    const state = session.state;
    const lastAsked = [...(state.transcript || [])].reverse().find((t) => t.role === 'assistant');
    state.transcript = [...(state.transcript || []), { role: 'user', text: utterance }];

    // Earlier partial intent (e.g. origin given, duration still missing) is
    // carried so the household only has to answer the gap; the question they
    // are answering is carried too, so "yes" and "home" mean something.
    const prior = [
      state.intent ? `Earlier in this conversation the user said: ${JSON.stringify(state.intent)}` : '',
      lastAsked ? `The app last asked: "${lastAsked.text}"` : '',
    ].filter(Boolean).join('\n');

    const intent = await parseStructured({
      system: INTERPRET_SYSTEM,
      messages: [{
        role: 'user',
        content: `${JSON.stringify(householdContext(household, members))}\n\n${prior}\n\nUser said: "${utterance}"`,
      }],
      schema: TripIntent,
      householdId: household.id,
      sessionId: session.id,
      purpose: 'plan.interpret',
    });

    // Merge with what was already known.
    const merged = { ...(state.intent || {}), ...Object.fromEntries(Object.entries(intent).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))) };
    // Empty arrays are dropped by the merge above; restore them so later code
    // can rely on their shape.
    merged.wants = [...new Set([...(state.intent?.wants || []), ...(intent.wants || [])])];
    merged.avoids = [...new Set([...(state.intent?.avoids || []), ...(intent.avoids || [])])];
    merged.attending = intent.attending?.length ? intent.attending : (state.intent?.attending || []);
    state.intent = merged;

    const origin = await resolveSpokenPlace(merged.origin, household);
    const destination = merged.destination ? await resolveSpokenPlace(merged.destination, household) : null;
    // A fixed commitment: find its venue (near the destination if we have one).
    let anchorPlace = null;
    if (merged.anchor?.place_text) {
      try { const [hit] = await geocode(merged.anchor.place_text, { limit: 1, near: destination ?? origin }); if (hit) anchorPlace = { label: hit.label, lat: hit.lat, lng: hit.lng, country: hit.country, countryCode: hit.countryCode, locality: hit.locality }; } catch { /* ask below */ }
    }
    const missing = [];
    if (!merged.origin) missing.push('origin');
    else if (!origin) missing.push('origin_unknown');
    if (!merged.duration_minutes) missing.push('duration');
    if (merged.destination && !destination) missing.push('destination_unknown');
    if (merged.anchor && !anchorPlace) missing.push('anchor_place');
    // Who's coming decides which allergens exclude, so it is confirmed rather
    // than assumed — asked once, after the where and how long are settled.
    const everyoneNames = members.map((m) => m.name);
    const askWhoIsComing = intent.understood && !missing.length && members.length > 1 && !merged.attending?.length && merged.attending_everyone == null && !state.askedAttending;
    if (askWhoIsComing) missing.push('attending');

    if (!intent.understood || missing.length) {
      let reply = intent.reply;
      if (missing.includes('origin') && household.home_lat != null) reply = 'Where are you starting from? You can just say "home".';
      if (missing.length === 1 && missing[0] === 'attending') {
        state.askedAttending = true;
        const list = everyoneNames.length > 2 ? `${everyoneNames.slice(0, -1).join(', ')} and ${everyoneNames.at(-1)}` : everyoneNames.join(' and ');
        reply = `Is it all of you — ${list}? Say yes, or tell me who's coming.`;
      }
      if (missing.includes('origin_unknown')) reply = `I couldn't place "${merged.origin}" — try the town or a fuller address, or set your home address in Settings and just say "home".`;
      if (missing.includes('destination_unknown')) reply = `I couldn't place "${merged.destination}" — try the full name with the town, like "the British Museum, London".`;
      if (missing.includes('anchor_place')) reply = merged.anchor?.place_text
        ? `I couldn't find "${merged.anchor.place_text}" on the map — which venue is ${merged.anchor.name} at?`
        : `Which venue is ${merged.anchor.name} at? Tell me the theatre or ground and the town, and I'll plan around it.`;
      state.transcript.push({ role: 'assistant', text: reply });
      await saveSession(session.id, state, null);
      return res.json({ sessionId: session.id, reply, intent: merged, missing, options: [] });
    }

    const { trip, attending } = await createTripFromIntent({ household, members, intent: merged, origin, destination, anchorPlace, sources: Array.isArray(pickedSources) && pickedSources.length ? pickedSources.map(String) : null });
    const attendees = toAttendees(attending);
    // Plan the day where it happens: the pool is what's around the base, and
    // the journey there is reported separately rather than eating the window.
    const dayTrip = dayAsTrip(trip, trip.day);
    const pool = await retrievePool({ household, trip: dayTrip, attendees, intent: merged, sessionId: session.id });

    if (merged.anchor && anchorPlace) {
      const tzA = trip.timezone || DEFAULT_TZ;
      const startsAt = merged.anchor.start_time
        ? wallToUtc(trip.day.date, merged.anchor.start_time.padStart(5, '0'), tzA).toISOString()
        : dayTrip.depart_at;
      const anchorMinutes = merged.anchor.duration_minutes ?? 120;
      const endsAt = new Date(new Date(startsAt).getTime() + anchorMinutes * 60_000).toISOString();
      const key = `anchor:${merged.anchor.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      // The booking is already a plan: it goes on the day now, so the trip shows
      // "1 planned" before any option is chosen. Committing an option replaces
      // the day's stops and puts it back in its place.
      await query(
        `insert into trip_stops (trip_id, day_id, slot, start_time, position, venue_ref, venue_name, lat, lng, dwell_minutes)
         values ($1,$2,$3,$4::time,1,$5,$6,$7,$8,$9)`,
        [trip.id, trip.day.id, slotFor(startsAt, tzA), wallClock(startsAt, tzA).hhmm, key, merged.anchor.name, anchorPlace.lat, anchorPlace.lng, anchorMinutes],
      );
      pool.candidates.unshift({
        key, source: 'anchor', sourcePlaceId: key.split(':')[1], name: merged.anchor.name, category: 'event',
        cuisines: [], experiences: [merged.anchor.kind === 'other' || merged.anchor.kind === 'booking' ? 'theatre' : merged.anchor.kind], allergens: [], dietaryOptions: undefined,
        priceLevel: null, rating: null, goodForChildren: null, lat: anchorPlace.lat, lng: anchorPlace.lng, dishes: [],
        justification: null, matchedDish: null, startsAt, endsAt, travelMinutes: 0, score: 1000, fixed: true,
        reasons: [{ kind: 'want', text: `Your ${merged.anchor.kind === 'theatre' ? 'show' : merged.anchor.kind === 'sports-game' ? 'match' : 'booking'} at ${merged.anchor.start_time ?? ''}`.trim() }],
        venueName: anchorPlace.label,
      });
    }

    if (merged.anchor && anchorPlace) {
      // One show is enough for one day: don't propose another of the same kind.
      const kind = merged.anchor.kind;
      for (const c of pool.candidates) {
        if (!c.fixed && (c.experiences || []).includes(kind)) { c.score -= 25; c.reasons = [...(c.reasons || []), { kind: 'note', text: `Another ${kind} on the same day as ${merged.anchor.name}` }]; }
      }
      pool.candidates.sort((a, b) => b.score - a.score);
    }
    state.dayId = trip.day.id;
    state.anchor = merged.anchor && anchorPlace ? { ...merged.anchor, place: anchorPlace } : null;
    state.journey = { from: trip.origin_label, to: trip.base_label, minutes: estimateTravelMinutes({ lat: trip.origin_lat, lng: trip.origin_lng }, { lat: trip.base_lat, lng: trip.base_lng }, trip.travel_mode), mode: trip.travel_mode, estimated: true };
    if (routingEnabled() && (trip.origin_lat !== trip.base_lat || trip.origin_lng !== trip.base_lng)) {
      try {
        const r = await routeBetween({ from: { lat: trip.origin_lat, lng: trip.origin_lng }, to: { lat: trip.base_lat, lng: trip.base_lng }, mode: trip.travel_mode, departAt: new Date(new Date(dayTrip.depart_at).getTime() - 3 * 3600_000).toISOString() });
        if (r) state.journey = { ...state.journey, minutes: r.minutes, estimated: false, meters: r.meters };
        await query('insert into provider_calls (household_id, session_id, provider, purpose) values ($1, $2, $3, $4)', [household.id, session.id, 'google-routes', 'plan.journey']);
      } catch { /* estimate stands */ }
    }
    state.pool = pool.candidates;
    state.excludedByAllergen = pool.excluded.map((e) => ({ name: e.name, reasons: e.exclusionReasons }));
    // Must-haves come from the time left once a fixed commitment is placed:
    // a 2½-hour show in a 5½-hour window leaves room for lunch and one thing,
    // not two things and no lunch.
    const windowMin = Math.round((new Date(dayTrip.return_at) - new Date(dayTrip.depart_at)) / 60_000);
    const spare = windowMin - (merged.anchor ? (merged.anchor.duration_minutes ?? 120) : 0);
    const packedness = { relaxed: 0.8, balanced: 1, packed: 1.25 }[trip.intensity] ?? 1;
    const activitiesThatFit = Math.max(0, Math.min(3, Math.floor(((spare - 75) / 110) * packedness)));
    const wantsToEat = merged.min_food_stops != null ? merged.min_food_stops : (spare >= 90 ? 1 : 0);
    state.minActivities = merged.min_activities ?? Math.min(activitiesThatFit, merged.anchor ? 1 : 2);
    state.minFood = wantsToEat;
    state.pinned = state.anchor ? [pool.candidates[0].key] : [];
    state.excluded = [];
    // No chains unless asked for; "somewhere special" means upmarket.
    state.includeChains = merged.avoid_chains === false;
    state.pricePoint = merged.price_point ?? (merged.special ? 'upmarket' : 'any');
    state.chosenOptionId = null;
    state.suggestedPreferences = [];
    state.attending = attendees.map((a) => ({ id: a.id, name: a.name }));
    state.attendeePrefs = attendees;
    state.transcript.push({ role: 'assistant', text: intent.reply });
    await saveSession(session.id, state, trip.id);

    session.state = state;
    session.trip_id = trip.id;
    await respond(res, {
      session, household, reply: intent.reply,
      extra: { intent: merged, missing: [], attending: state.attending, reach: { maxTravelMinutes: pool.maxTravelMinutes, estimated: true }, degradedSources: pool.degraded, journey: state.journey, anchor: state.anchor, date: trip.day.date },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * React in words to the options on screen. Body: { sessionId, utterance, viewingOptionId? }
 */
router.post('/refine', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { sessionId, utterance, viewingOptionId = null } = req.body || {};
    if (!sessionId || !utterance?.trim()) return res.status(400).json({ error: 'session_and_utterance_required' });

    const session = await loadSession(sessionId);
    const state = session.state;
    if (!state.pool) return res.status(409).json({ error: 'no_options_yet', message: 'Describe the outing first.' });

    const { options, trip } = await recompose(session, household);
    const closedSet = options.map((o) => ({
      option_id: o.id,
      title: o.title,
      stops: o.stops.map((s) => ({ id: s.id, name: s.name, category: s.category })),
    }));
    const validStopIds = new Set(options.flatMap((o) => o.stops.map((s) => s.id)));
    const validOptionIds = new Set(options.map((o) => o.id));

    const recent = (state.transcript || []).slice(-6).map((t) => `${t.role}: ${t.text}`).join('\n');
    const refinement = await parseStructured({
      system: REFINE_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          `Options on screen (the user is looking at option "${viewingOptionId || options[0]?.id}"):`,
          JSON.stringify(closedSet),
          `Trip: ${JSON.stringify({ durationMinutes: Math.round((new Date(trip.return_at) - new Date(trip.depart_at)) / 60_000), intensity: trip.intensity, travelMode: trip.travel_mode })}`,
          `Household members: ${(state.attending || []).map((a) => a.name).join(', ')}`,
          recent ? `Recent conversation:\n${recent}` : '',
          `User said: "${utterance}"`,
        ].join('\n\n'),
      }],
      schema: Refinement,
      householdId: household.id,
      sessionId: session.id,
      purpose: 'plan.refine',
    });

    // Validate against the closed set — anything else is discarded, never guessed.
    const liked = refinement.liked_stop_ids.filter((id) => validStopIds.has(id));
    const disliked = refinement.disliked_stop_ids.filter((id) => validStopIds.has(id));
    const replacements = refinement.replacements.filter((r) => validStopIds.has(r.stop_id));
    const chosen = refinement.chosen_option_id && validOptionIds.has(refinement.chosen_option_id) ? refinement.chosen_option_id : null;

    state.transcript = [...(state.transcript || []), { role: 'user', text: utterance }, { role: 'assistant', text: refinement.reply }];
    state.pinned = [...new Set([...state.pinned.filter((k) => !disliked.includes(k)), ...liked])];
    state.excluded = [...new Set([...state.excluded, ...disliked, ...replacements.map((r) => r.stop_id)])];
    state.pinned = state.pinned.filter((k) => !state.excluded.includes(k));
    if (chosen) state.chosenOptionId = chosen;

    // A replacement request boosts what they asked for so the recomposition
    // reaches for it, without filtering the pool down to it.
    for (const r of replacements) {
      const term = r.with.toLowerCase();
      for (const c of state.pool) {
        const hay = [c.name, c.category, ...(c.cuisines || [])].join(' ').toLowerCase();
        if (hay.includes(term)) c.score += 15;
      }
    }

    const tc = refinement.trip_changes || {};
    if (tc.min_activities != null) state.minActivities = tc.min_activities;
    if (tc.min_food_stops != null) state.minFood = tc.min_food_stops;
    if (tc.price_point) state.pricePoint = tc.price_point;
    if (tc.avoid_chains != null) state.includeChains = !tc.avoid_chains;
    if (tc.duration_minutes != null || tc.intensity || tc.travel_mode) {
      await applyTripChanges(session, { durationMinutes: tc.duration_minutes, intensity: tc.intensity, travelMode: tc.travel_mode });
    }

    state.suggestedPreferences = refinement.suggested_preferences;
    await saveSession(session.id, state, null);
    session.state = state;

    const reply = refinement.ambiguous ? refinement.ambiguous : refinement.reply;
    await respond(res, {
      session, household, reply,
      extra: { applied: { liked, disliked, replacements, chosenOptionId: chosen, tripChanges: tc }, ambiguous: refinement.ambiguous },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The same state changes by touch — no model call (Epic 5 "by voice or by selection").
 * Body: { sessionId, action: { type: 'like'|'unlike'|'dislike'|'restore'|'choose'|'set', stopId?, optionId?, minActivities?, minFood?, intensity? } }
 */
router.post('/act', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { sessionId, action } = req.body || {};
    if (!sessionId || !action?.type) return res.status(400).json({ error: 'session_and_action_required' });
    const session = await loadSession(sessionId);
    const state = session.state;
    if (!state.pool) return res.status(409).json({ error: 'no_options_yet' });

    switch (action.type) {
      case 'like':
        state.pinned = [...new Set([...state.pinned, action.stopId])];
        state.excluded = state.excluded.filter((k) => k !== action.stopId);
        break;
      case 'unlike':
        state.pinned = state.pinned.filter((k) => k !== action.stopId);
        break;
      case 'dislike':
        state.excluded = [...new Set([...state.excluded, action.stopId])];
        state.pinned = state.pinned.filter((k) => k !== action.stopId);
        break;
      case 'restore':
        state.excluded = state.excluded.filter((k) => k !== action.stopId);
        break;
      case 'choose':
        state.chosenOptionId = action.optionId ?? null;
        break;
      case 'set':
        if (action.minActivities != null) state.minActivities = Number(action.minActivities);
        if (action.minFood != null) state.minFood = Number(action.minFood);
        if (action.includeChains != null) state.includeChains = Boolean(action.includeChains);
        if (action.pricePoint && PRICE_POINTS.includes(action.pricePoint)) state.pricePoint = action.pricePoint;
        await applyTripChanges(session, {
          intensity: action.intensity && INTENSITY_TARGETS[action.intensity] ? action.intensity : null,
          durationMinutes: action.durationMinutes != null ? Number(action.durationMinutes) : null,
          travelMode: action.travelMode && TRAVEL_MODES.includes(action.travelMode) ? action.travelMode : null,
        });
        break;
      default:
        return res.status(400).json({ error: 'unknown_action' });
    }

    await saveSession(session.id, state, null);
    session.state = state;
    await respond(res, { session, household, reply: null, extra: { applied: action } });
  } catch (err) {
    next(err);
  }
});

/** Make an option the active trip (Epic 5 C8). Body: { sessionId, optionId } */
router.post('/commit', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { sessionId, optionId } = req.body || {};
    const session = await loadSession(sessionId);
    const { options, trip: sessTrip } = await recompose(session, household);
    const tzOf = sessTrip.timezone || DEFAULT_TZ;
    const option = options.find((o) => o.id === optionId);
    if (!option) return res.status(404).json({ error: 'option_not_found' });

    const dayId = session.state.dayId ?? null;
    if (dayId) {
      // Replace the day's plan, keeping any stop already turned into a visit.
      await query('delete from trip_stops where day_id = $1 and not exists (select 1 from visits v where v.stop_id = trip_stops.id)', [dayId]);
    } else {
      await query('delete from trip_stops where trip_id = $1 and not exists (select 1 from visits v where v.stop_id = trip_stops.id)', [session.trip_id]);
    }
    for (const stop of option.stops) {
      await query(
        `insert into trip_stops (trip_id, day_id, slot, start_time, position, venue_ref, venue_name, lat, lng, dwell_minutes)
         values ($1,$2,$3,$4::time,$5,$6,$7,$8,$9,$10)`,
        [session.trip_id, dayId, stop.arriveAt ? slotFor(stop.arriveAt, tzOf) : 'morning', stop.arriveAt ? wallClock(stop.arriveAt, tzOf).hhmm : null,
         stop.position, stop.venueRef, stop.name, stop.lat, stop.lng, stop.dwellMinutes],
      );
      await query(
        `insert into place_ledger (household_id, source, source_place_id, status)
         values ($1, split_part($2, ':', 1), split_part($2, ':', 2), 'saved')`,
        [household.id, stop.venueRef],
      );
    }
    session.state.chosenOptionId = optionId;
    session.state.committed = true;
    await saveSession(session.id, session.state, null);
    res.json({ tripId: session.trip_id, optionId, stops: option.stops.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/plan/day { tripId, dayId, minActivities?, minFood? }
 * Options for one day of a trip, composed from the trip's shortlist plus what
 * is near the base — no model call; react afterwards by voice (/refine) or tap (/act).
 */
router.post('/day', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { tripId, dayId, minActivities, minFood } = req.body || {};
    const { rows: trips } = await query('select * from trips where id = $1 and household_id = $2', [tripId, household.id]);
    const { rows: days } = await query('select * from trip_days where id = $1 and trip_id = $2', [dayId, tripId]);
    if (!trips[0] || !days[0]) return res.status(404).json({ error: 'trip_or_day_not_found' });
    const real = trips[0];
    const trip = dayAsTrip(real, days[0]);

    const members = await loadMembers(household.id);
    const { rows: att } = await query('select member_id from trip_attendees where trip_id = $1', [tripId]);
    const attendingIds = new Set(att.map((a) => a.member_id));
    const attendees = toAttendees(members.filter((m) => attendingIds.size === 0 || attendingIds.has(m.id)));

    const { rows } = await query('insert into plan_sessions (household_id, trip_id, state) values ($1, $2, $3) returning *', [household.id, tripId, JSON.stringify({ transcript: [], dayId })]);
    const session = rows[0];
    const state = session.state;

    // Pool: the shortlist (boosted; must-dos more so) plus places near the base.
    const pool = await retrievePool({ household, trip, attendees, intent: { wants: [], special: false }, sessionId: session.id });
    const { rows: shortlist } = await query('select * from trip_shortlist where trip_id = $1', [tripId]);
    const byRef = new Map(pool.candidates.map((c) => [`${c.source}:${c.sourcePlaceId}`, c]));
    const extra = [];
    for (const item of shortlist) {
      const ref = item.venue_ref;
      let cand = byRef.get(ref);
      if (!cand) {
        const [source, ...rest] = ref.split(':');
        const v = item.venue || {};
        const venue = { source, sourcePlaceId: rest.join(':'), name: item.venue_label, category: item.category ?? v.category ?? 'attraction', cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], dietaryOptions: v.dietaryOptions, allergens: [], rating: null, priceLevel: null, lat: item.lat, lng: item.lng, dishes: [], justification: null, matchedDish: null, key: ref };
        const [withTravel] = deriveCatchment({ origin: { lat: trip.origin_lat, lng: trip.origin_lng }, maxTravelMinutes: 10_000, mode: trip.travel_mode, venues: [venue] });
        const { candidates, excluded } = applyConstraints({ venues: [withTravel], attendees, learned: await loadLearnedPreferences(household.id) });
        if (excluded.length) { pool.excluded.push(excluded[0]); continue; }
        cand = candidates[0];
        extra.push(cand);
      }
      cand.score += item.must_do ? 30 : 15;
      cand.reasons = [...(cand.reasons || []), { kind: 'want', text: item.must_do ? 'Must do — on your shortlist' : 'On your shortlist' }];
      cand.shortlisted = true;
      cand.mustDo = item.must_do;
    }
    // A booking already on the day (the show said aloud when the trip was made)
    // is fixed: every option is built around it, and the pool treats it as the
    // day's one ticketed thing.
    const { rows: booked } = await query(`select * from trip_stops where day_id = $1 and venue_ref like 'anchor:%' order by start_time`, [dayId]);
    const tzD = trip.timezone || DEFAULT_TZ;
    const fixedStops = booked.map((s) => {
      const startsAt = wallToUtc(days[0].date, (s.start_time || trip.depart_at.slice(11, 16) || '12:00').slice(0, 5), tzD).toISOString();
      return {
        key: s.venue_ref, source: 'anchor', sourcePlaceId: s.venue_ref.split(':')[1], name: s.venue_name, category: 'event', cuisines: [], experiences: ['theatre'], allergens: [],
        lat: s.lat, lng: s.lng, dishes: [], justification: null, matchedDish: null, travelMinutes: 0, score: 1000, fixed: true,
        startsAt, endsAt: new Date(new Date(startsAt).getTime() + (s.dwell_minutes || 120) * 60_000).toISOString(),
        reasons: [{ kind: 'want', text: `Your booking${s.start_time ? ` at ${s.start_time.slice(0, 5)}` : ''}` }],
      };
    });
    const candidates = [...fixedStops, ...pool.candidates.filter((c) => !fixedStops.some((f) => f.key === c.key)), ...extra].sort((a, b) => b.score - a.score);

    const defaults = { relaxed: [1, 0], balanced: [1, 1], packed: [2, 1] }[trip.intensity] ?? [1, 1];
    Object.assign(state, {
      pool: candidates,
      excludedByAllergen: pool.excluded.map((e) => ({ name: e.name, reasons: e.exclusionReasons })),
      minActivities: minActivities ?? defaults[0],
      minFood: minFood ?? defaults[1],
      pinned: [...fixedStops.map((f) => f.key), ...shortlist.filter((i) => i.must_do).map((i) => i.venue_ref).filter((r) => candidates.some((c) => c.key === r))],
      excluded: [],
      includeChains: false,
      pricePoint: 'any',
      anchor: fixedStops[0] ? { name: fixedStops[0].name, start_time: booked[0].start_time?.slice(0, 5) ?? null, duration_minutes: booked[0].dwell_minutes, kind: 'booking', place: { label: fixedStops[0].name, lat: fixedStops[0].lat, lng: fixedStops[0].lng } } : null,
      chosenOptionId: null,
      suggestedPreferences: [],
      attending: attendees.map((a) => ({ id: a.id, name: a.name })),
      attendeePrefs: attendees,
    });
    await saveSession(session.id, state, tripId);
    session.state = state;
    await respond(res, { session, household, reply: null, extra: { dayId, date: days[0].date, attending: state.attending, reach: { maxTravelMinutes: pool.maxTravelMinutes, estimated: true }, degradedSources: pool.degraded } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/plan/day/latest?tripId=&dayId= — the day's most recent planning
 * session, so leaving the tab and coming back shows the same options.
 */
router.get('/day/latest', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { tripId, dayId } = req.query;
    if (!tripId || !dayId) return res.status(400).json({ error: 'trip_and_day_required' });
    const { rows } = await query(
      `select * from plan_sessions where household_id = $1 and trip_id = $2 and state->>'dayId' = $3 and expires_at > now() order by updated_at desc limit 1`,
      [household.id, tripId, dayId],
    );
    const session = rows[0];
    if (!session || !session.state?.pool) return res.json({ sessionId: null, options: [] });
    await respond(res, { session, household, reply: null, extra: { dayId, date: session.state.date ?? null, transcript: session.state.transcript ?? [], attending: session.state.attending ?? [], resumed: true } });
  } catch (err) { next(err); }
});

router.get('/:sessionId', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const session = await loadSession(req.params.sessionId);
    if (!session.state.pool) {
      return res.json({ sessionId: session.id, intent: session.state.intent ?? null, options: [], transcript: session.state.transcript ?? [] });
    }
    await respond(res, { session, household, reply: null, extra: { transcript: session.state.transcript ?? [], intent: session.state.intent } });
  } catch (err) {
    next(err);
  }
});

// Spend bounds surface as a status the UI can render calmly (Epic 3 C10).
router.use((err, _req, res, next) => {
  if (err instanceof SpendBoundError) {
    return res.status(429).json({
      error: err.code,
      scope: err.scope,
      bound: err.bound,
      message: `That's as many planning requests as this ${err.scope} allows — what's on screen still works.`,
    });
  }
  return next(err);
});

export default router;

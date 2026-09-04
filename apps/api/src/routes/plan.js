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
import { query, withTransaction } from '../db.js';
import { parseStructured, spendSummary, SpendBoundError, MODEL } from '../claude.js';

// How many candidates get a real road time from Google Routes on each plan.
// Billed per element against a daily quota, so it is a budget, not a maximum.
const MATRIX_MAX = Number(process.env.ROAM_MATRIX_MAX || 60);

// Rows fill while the household is still talking: a smaller, quicker model reads the words so far.
const PREVIEW_MODEL = process.env.ROAM_PREVIEW_MODEL || 'claude-sonnet-5';
import { searchAllSources, searchCorridor, eventSources, optInFrom, defaultSourceKeys, enabledSources, sourceHasKey, sourceOff } from '../sources/index.js';
import { resolvePlace, KNOWN_PLACES } from '../sources/fixtures.js';
import { geocode, reverseGeocode } from '../sources/geocode.js';
import { deriveCatchment, reachRadiusKm, estimateTravelMinutes, detourMinutes as estimateDetour, TRAVEL_MODES, kmBetween } from '../domain/travel.js';
import { applyConstraints } from '../domain/ranking.js';
import { composeOptions, dwellFor, richFields, PRICE_POINTS, eventInsideWindow } from '../domain/options.js';
import { lineByKey } from '../sources/pricing.js';
import { paceOf, travelLimitFor, maxReachMinutes } from '../domain/pace.js';
import { dayAsTrip, slotFor } from '../domain/days.js';
import { ensureDays, placeTrip, addShortlistItem } from './trips.js';
import { searchCached, searchKept } from '../sources/cache.js';
import { routingEnabled, travelMatrixMinutes, routeMatrixMinutes, routeBetween } from '../sources/routing.js';
import { wallToUtc, wallClock, DEFAULT_TZ } from '../domain/time.js';
import { INTENSITY_TARGETS } from '../domain/budget.js';
import { corridorStops, scheduleCorridor, MAX_DETOUR_MINUTES } from '../domain/corridor.js';
import { currentHousehold, loadMembers, toAttendees, loadLearnedPreferences } from './household.js';

const router = Router();

// ---------------------------------------------------------------------------
// Schemas — what Claude is allowed to return.
// ---------------------------------------------------------------------------

const TripIntent = z.object({
  understood: z.boolean().describe('False if the message is not about planning an outing'),
  origin: z.string().nullable().describe('Where the outing starts, as the user said it; null if not said'),
  destination: z.string().nullable().describe('Where the outing ends, if different from the origin; null if not said or if they return to the origin. Name it as precisely as the words allow: a famous attraction that leaves no doubt gives its town ("the Roman Baths" → "Bath, Somerset"); add the region when the same name exists in several places'),
  duration_minutes: z.number().int().nullable().describe('How long they have AT the destination, in minutes, not counting the journey there; null if not said'),
  date: z.string().nullable().describe('The date of the outing as YYYY-MM-DD, resolved from words like "Saturday" or "tomorrow" using today\'s date; null if not said'),
  // These four are never null (the schema allows at most 16 nullable fields): an
  // empty string or 0 means "not said", and normaliseIntent() turns it into null.
  nights: z.number().int().describe('Nights away from home if they said they will stay over ("stay the night", "one night", "a hotel", "back Sunday"); 0 for a day out'),
  end_date: z.string().describe('The day they come home as YYYY-MM-DD when it differs from the date ("come home the following evening"); empty string otherwise'),
  stay: z.string().describe('What they want from where they sleep, in their words ("a hotel with a thermal spa near the centre"); empty string if not staying over'),
  question: z.object({
    text: z.string().describe('One short question, spoken aloud; empty string when there is nothing to ask'),
    choices: z.array(z.string()).max(4).describe('Two to four short answers in the user\'s own words, each a complete reply they could tap or say; empty when there is no question'),
  }).describe('When what they said could reasonably mean two or more different things and the difference changes the plan, ask instead of guessing. Leave text empty when the meaning is clear, when the app can find it out itself, or when the user already answered it'),
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
  budget_low: z.number().int().describe('The least they said they want to spend for the day, in pounds; 0 if not said'),
  budget_high: z.number().int().describe('The most they said they want to spend for the day, in pounds ("about a hundred quid", "no more than £150"); 0 if not said'),
  reply: z.string().describe('One short, warm sentence acknowledging what was understood, or asking for the single most important missing detail'),
});

/** "Not said" is null throughout, whatever shape the schema had to use. */
function normaliseIntent(intent) {
  const out = { ...intent };
  if (!(Number(out.nights) >= 1)) out.nights = null;
  if (!out.end_date || !/^\d{4}-\d{2}-\d{2}$/.test(out.end_date)) out.end_date = null;
  if (!out.stay?.trim()) out.stay = null;
  if (!(Number(out.budget_low) > 0)) out.budget_low = null;
  if (!(Number(out.budget_high) > 0)) out.budget_high = null;
  out.question = out.question?.text?.trim() && (out.question.choices || []).length >= 2 ? { text: out.question.text.trim(), choices: out.question.choices.map((c) => String(c).trim()).filter(Boolean) } : null;
  return out;
}

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

Staying over: "stay the night", "a hotel", "back the next evening" mean nights ≥ 1 and end_date the day they return; describe the place to stay in stay. For a stay, duration_minutes is only what they said about a particular day, else null. Attractions imply their town: the Roman Baths are in Bath, Somerset; the Louvre is in Paris.

Ask, don't guess: when something could mean two different things and it matters — which day, whether a time is fixed, indoor or outdoor — put one short question in question with two to four answers they can tap or say, and make the reply that same question. Never ask about what they already said, and never ask what the app can look up (an address, an opening time, which town of that name — the app puts that question itself with the map's choices). If the context shows the app's last question and its choices, a short answer picks one of those choices: put that choice's exact words into the field the question was about.

The reply is spoken aloud as well as shown, so keep it to one plain sentence with no lists or markup.`;

const REFINE_SYSTEM = `You interpret a family's reaction to suggested day plans.

You are given the options currently on screen, each with stops that have IDs, and what the user said. One group may be "on-the-way": places between home and where they are going, each marked as being on the way there or on the way home. Wanting one of those ("stop at the castle on the way", "we could eat there on the way home") is a liked stop id; not wanting one ("don't stop", "skip the pub on the way") is a disliked stop id. Never choose "on-the-way" as chosen_option_id — it is not a plan for the day. Map their words ONLY onto those stop IDs. "The museum" means the stop whose name or category is a museum; "the first one" means the first stop of the option they are looking at; "this plan" means the option in view. If a phrase could mean more than one stop, put a short question in "ambiguous" and leave the ID lists empty for that reference. Never invent stops or IDs.

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

// Kinds of map feature a family goes *to*, as Nominatim names them; and the
// linear ones (a road, a stream) that a place name must never silently become.
const SETTLEMENT = new Set(['city', 'town', 'village', 'hamlet', 'administrative', 'municipality', 'borough', 'suburb', 'quarter', 'neighbourhood', 'county', 'island', 'state', 'region', 'district']);
const LINEAR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road', 'street', 'track', 'path', 'footway', 'cycleway', 'bridleway', 'stream', 'river', 'canal', 'ditch', 'drain', 'rail', 'railway', 'bus_stop', 'junction']);
const normName = (t) => String(t || '').toLowerCase().replace(/^(the|at|from|to)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const kindWord = (h) => (LINEAR.has(h.kind) ? (['stream', 'river', 'canal', 'ditch', 'drain'].includes(h.kind) ? 'river' : 'road') : h.kind === 'administrative' ? 'area' : String(h.kind || 'place').replace(/_/g, ' '));
const asPlace = (hit, how) => ({ label: hit.name || hit.label, lat: hit.lat, lng: hit.lng, country: hit.country, countryCode: hit.countryCode, locality: hit.locality, how });

/**
 * Where a spoken place is — or the choices, when the map is not sure.
 * Returns { place } when one match is beyond doubt (home, a known place, a
 * settlement or venue with exactly that name), else { choices } to put to the
 * household. A road called Bath Road near home is never taken for Bath.
 */
// The household's home country, looked up once: a bare name is searched there first.
const homeCountryCache = new Map();
async function homeCountry(household) {
  if (household.home_lat == null) return null;
  const key = `${household.id}:${household.home_lat},${household.home_lng}`;
  if (homeCountryCache.has(key)) return homeCountryCache.get(key);
  let cc = null;
  try { const r = await reverseGeocode(household.home_lat, household.home_lng, { zoom: 3 }); cc = r?.countryCode ?? null; } catch { cc = null; }
  homeCountryCache.set(key, cc);
  return cc;
}

async function resolveSpokenPlace(text, household, { all = false } = {}) {
  if (!text) return { place: null, choices: null };
  const home = household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null;
  const said = text.trim().replace(/[.!,]+$/, '');
  if (home && (HOME_WORDS.test(said) || said.toLowerCase() === String(household.home_label || '').toLowerCase())) return { place: { ...home, how: 'home' } };
  const known = resolvePlace(text);
  if (known) return { place: { ...known, how: 'known' } };
  const wanted = normName(said);
  // "Bath" is Bath; so is "Bath, Somerset" when Somerset is in the full address.
  const named = (h) => {
    const n = normName(h.name);
    if (!n) return false;
    if (n === wanted || normName(h.label) === wanted) return true;
    const rest = wanted.startsWith(`${n} `) ? wanted.slice(n.length + 1) : null;
    return Boolean(rest && normName(h.displayName).includes(rest));
  };
  const isSettlement = (h) => SETTLEMENT.has(h.kind);
  let hits = [];
  try {
    hits = await geocode(text, { limit: 5, near: home });
    // The bias toward home is right for an address and wrong for a bare name:
    // "Newport" near Ascot finds a village in Essex three ways and never Wales.
    // A name with no street number or comma is looked for everywhere as well.
    const bareName = !/[\d,]/.test(said);
    if (bareName || !hits[0] || !(named(hits[0]) && !LINEAR.has(hits[0].kind))) {
      // The home country first (Bath is the one in Somerset, not Kentucky); the world only if that finds little.
      const cc = await homeCountry(household);
      const wideHome = cc ? await geocode(text, { limit: 8, countryCode: cc }) : [];
      const wideAll = wideHome.length >= 3 ? [] : await geocode(text, { limit: 5 });
      const seen = new Set(hits.map((h) => h.sourcePlaceId));
      for (const h of [...wideHome, ...wideAll]) { if (!seen.has(h.sourcePlaceId)) { seen.add(h.sourcePlaceId); hits.push(h); } }
    }
    // An address fragment with no name of its own ("London" for an industrial estate) is not a place to go.
    hits = hits.filter((h) => h.name);
  } catch {
    return { place: null, choices: null };
  }
  const precise = hits.filter((h) => !h.approximate);
  // One entry per place: the village, its parish boundary and its station are one Newport.
  const rank = (h) => ['city', 'town', 'village', 'hamlet', 'administrative'].indexOf(h.kind) + 1 || (LINEAR.has(h.kind) ? 99 : 50);
  const byPlace = new Map();
  for (const h of (precise.length ? precise : hits)) {
    const key = `${normName(h.name)}|${normName(h.locality)}`;
    const have = byPlace.get(key);
    if (!have || rank(h) < rank(have)) byPlace.set(key, h);
  }
  // The town and its parish boundary, or the town under two different locality
  // names, are one Newport: same name within 3 km collapses to the best-ranked.
  const pool = [];
  for (const h of [...byPlace.values()].sort((a, b) => rank(a) - rank(b))) {
    if (pool.some((p) => normName(p.name) === normName(h.name) && kmBetween(p, h) < 3)) continue;
    pool.push(h);
  }
  if (!pool.length) return { place: null, choices: null };
  const exactTowns = pool.filter((h) => isSettlement(h) && named(h));
  if (exactTowns.length === 1 && !all) return { place: asPlace(exactTowns[0], 'geocoded') };
  const exactVenues = pool.filter((h) => named(h) && !LINEAR.has(h.kind) && !isSettlement(h));
  if (!exactTowns.length && exactVenues.length === 1 && !all) return { place: asPlace(exactVenues[0], 'geocoded') };
  // A full address or postcode has one honest answer; a bare name that only found roads does not.
  if (pool.length === 1 && !LINEAR.has(pool[0].kind) && !all) return { place: asPlace(pool[0], 'geocoded') };
  // For a search list: only hits that carry a word of what was typed, the home
  // country before the world, and nearer before further.
  let ranked = [...exactTowns, ...exactVenues, ...pool.filter((h) => !exactTowns.includes(h) && !exactVenues.includes(h))];
  if (all) {
    const tokens = wanted.split(' ').filter((t) => t.length >= 3);
    const cc = await homeCountry(household);
    ranked = ranked.filter((h) => !tokens.length || tokens.some((t) => normName(h.name).includes(t)));
    const score = (h) => (named(h) ? 0 : 1) * 100 + (cc && h.countryCode && h.countryCode !== cc ? 50 : 0) + (LINEAR.has(h.kind) ? 10 : ['station', 'bus_stop', 'platform', 'halt'].includes(h.kind) ? 5 : 0);
    ranked = ranked.map((h, i) => [h, i]).sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1]).map(([h]) => h);
  }
  const choices = [];
  for (const h of ranked) {
    // "Newport (city)" says nothing; "Newport, Wales (city)" does.
    const name = h.name || h.label;
    const region = h.address?.region && normName(h.address.region) !== normName(name) ? h.address.region : h.address?.country && normName(h.address.country) !== normName(name) ? h.address.country : null;
    const where = h.locality && normName(h.locality) !== normName(name) ? `, ${h.locality}` : region ? `, ${region}` : '';
    const label = `${name}${where} (${kindWord(h)})`;
    if (choices.some((c) => c.label === label)) continue;
    choices.push({ label, say: `${name}${where}`, kind: kindWord(h), place: asPlace(h, 'geocoded') });
    if (choices.length === (all ? 8 : 4)) break;
  }
  return { place: null, choices };
}

/** The choice a short answer picks, by its words; null if it is not one of them. */
function matchChoice(question, utterance) {
  if (!question?.choices?.length) return null;
  const u = normName(utterance);
  return question.choices.find((c) => normName(c.say) === u || normName(c.label) === u || normName(c.label.replace(/\s*\([^)]*\)$/, '')) === u) ?? null;
}

const firstName = (n) => String(n || '').split(' ')[0];
const minutesWords = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} hour${m / 60 === 1 ? '' : 's'}`);
const MEAL_WORDS = /\b(breakfast|brunch|lunch|dinner|supper|tea|coffee)\b/i;
const isNamedPlace = (w) => /[A-Z]/.test(String(w).replace(/^(the|a|an)\s+/i, '')) && !FOOD_WORDS.test(w) && !GENERIC_WANT.test(w);
const PLAN_IT = /^(plan it|go|let'?s go|that'?s it|do it|plan|make the plan|go ahead)[.! ]*$/i;

/** "somewhere nice for lunch", "Italian for dinner" → "Lunch: somewhere nice", "Dinner: Italian". */
function eatLines(wants) {
  const lines = [];
  const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
  for (const w of wants) {
    if (!FOOD_WORDS.test(w)) continue;
    const meals = [...String(w).matchAll(new RegExp(MEAL_WORDS.source, 'gi'))].map((m) => m[1].toLowerCase());
    const rest = String(w).replace(new RegExp(MEAL_WORDS.source, 'gi'), ' ').replace(/\b(for|some|a|an|the|to|at|have|and|then|go|out|both|too|also)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!meals.length) { lines.push(cap(w)); continue; }
    // "lunch and dinner somewhere nice" is two meals with the same wish.
    for (const meal of [...new Set(meals)]) lines.push(`${cap(meal)}: ${rest ? cap(rest) : 'somewhere nice'}`);
  }
  return lines;
}

/**
 * The rows are the screen: everything said so far in its slot. A row the
 * planner is sure of is plain; one it is not sure of carries a check (the
 * queue below asks it); one not said is empty. Never a guess.
 */
function rowsFor({ merged, places, checks, overnight, members = [] }) {
  const checkFields = new Set(checks.map((c) => c.field).filter(Boolean));
  const row = (key, label, value, detail = null) => ({ key, label, value: value || null, detail: detail || null, state: checkFields.has(key) ? 'check' : value ? 'plain' : 'empty' });
  const o = places.origin;
  const d = places.destination;
  const rows = [];
  const placeName = (pl) => (pl.locality && normName(pl.locality) !== normName(pl.label) && !pl.label.includes(',') ? `${pl.label}, ${pl.locality}` : pl.label);
  // "Travelling from home with the family" is one line on the screen; a From row appears only when it is somewhere else, a Who row only when someone is left out.
  if (!(o?.how === 'home' || (!o && HOME_WORDS.test(String(merged.origin || '').trim())))) rows.push(row('from', 'From', o ? placeName(o) : merged.origin || null));
  rows.push(row('to', 'To', d ? placeName(d) : merged.destination || null, !d && !merged.destination && o ? 'around where you start' : null));
  const date = merged.date ? dayWords(merged.date) : null;
  if (overnight) {
    const nights = Math.max(1, Number(merged.nights) || 1);
    const end = merged.end_date || (merged.date ? addDays(merged.date, nights) : null);
    rows.push(row('when', 'When', date ? `${date} → ${end ? dayWords(end) : '?'}` : `${nights} night${nights > 1 ? 's' : ''}`, date ? `${nights} night${nights > 1 ? 's' : ''}` : null));
  } else {
    const dur = merged.duration_minutes ? minutesWords(merged.duration_minutes) : null;
    rows.push(row('when', 'When', [date, dur].filter(Boolean).join(' · ') || null, merged.depart_time ? `leaving ${merged.depart_time}` : (date && !dur ? 'how long?' : null)));
  }
  const everyone = merged.attending_everyone || (members.length > 1 && merged.attending?.length === members.length) || !merged.attending?.length;
  if (!everyone) rows.push(row('who', 'Who', merged.attending.map(firstName).join(', ')));
  if (overnight || merged.stay) rows.push(row('stay', 'Stay', merged.stay || null, overnight && !merged.stay ? 'somewhere to sleep — not said' : null));
  const wants = merged.wants || [];
  const named = wants.filter(isNamedPlace);
  const other = wants.filter((w) => !FOOD_WORDS.test(w) && !isNamedPlace(w));
  const doParts = [...(merged.anchor?.name ? [merged.anchor.name] : []), ...named, ...other];
  const count = merged.min_activities;
  rows.push(row('do', 'Do', doParts.join(', ') || (count != null ? `${count} thing${count === 1 ? '' : 's'} to do` : null), doParts.length && count != null ? `+ ${count} more` : merged.anchor?.start_time ? `at ${merged.anchor.start_time}` : null));
  const eat = eatLines(wants);
  const foodCount = merged.min_food_stops;
  rows.push(row('eat', 'Eat', eat[0] || (foodCount != null ? `${foodCount} place${foodCount === 1 ? '' : 's'} to eat` : null), eat.slice(1).join(' · ') || null));
  const pp = merged.price_point ? { affordable: 'Affordable', mid: 'Mid-range', upmarket: 'Upmarket' }[merged.price_point] : merged.special ? 'Somewhere special' : null;
  const range = merged.budget_high ? `£${merged.budget_low || 0}–£${merged.budget_high} ${merged.budget_per === 'person' ? 'a head' : 'a day'}` : null;
  rows.push(row('budget', 'Budget', [pp, range].filter(Boolean).join(' · ') || null, merged.avoid_chains ? 'no chains' : merged.avoid_chains === false ? 'chains are fine' : null));
  return rows;
}

function whichCheck(intentField, rowKey, said, choices) {
  const text = `Which ${normName(said) === normName(choices[0].say) ? said : 'one'} do you mean — ${choices.slice(0, -1).map((c) => c.label).join(', ')} or ${choices.at(-1).label}?`;
  return { id: `${intentField}_which`, kind: 'place', field: rowKey, intentField, text, choices, skippable: false };
}

/** Everything the planner is not sure of, all at once, in the order it matters: place, time, who, stay. */
function buildChecks({ merged, origin, destination, asks, anchorPlace, overnight, members, household, state }) {
  const checks = [];
  const skipped = new Set(state.skipped || []);
  const add = (c) => { if (!skipped.has(c.id)) checks.push(c); };
  if (!merged.origin) add({ id: 'origin', kind: 'open', field: 'from', text: 'Where are you starting from? You can just say "home".', choices: household.home_lat != null ? [{ label: 'From home', say: 'From home' }] : [], skippable: false });
  else if (!origin) add(asks.origin ? whichCheck('origin', 'from', merged.origin, asks.origin) : { id: 'origin_unknown', kind: 'open', field: 'from', text: `I couldn't place "${merged.origin}" — say the town or a fuller address, or set your home in Settings and say "home".`, choices: [], skippable: false });
  if (merged.destination && !destination) add(asks.destination ? whichCheck('destination', 'to', merged.destination, asks.destination) : { id: 'destination_unknown', kind: 'open', field: 'to', text: `I couldn't place "${merged.destination}" — try the full name with the town, like "the British Museum, London".`, choices: [], skippable: false });
  if (merged.anchor && !anchorPlace) add({ id: 'anchor', kind: 'open', field: 'do', text: merged.anchor.place_text ? `I couldn't find "${merged.anchor.place_text}" on the map — which venue is ${merged.anchor.name} at?` : `Which venue is ${merged.anchor.name} at? The theatre or ground, and the town.`, choices: [], skippable: false });
  if (!overnight && !merged.duration_minutes) add({ id: 'duration', kind: 'duration', field: 'when', text: 'How long have you got there?', choices: [{ label: '2 hours', say: 'About 2 hours', value: 120 }, { label: '3 hours', say: 'About 3 hours', value: 180 }, { label: 'Half a day', say: 'Half a day', value: 300 }, { label: 'All day', say: 'All day', value: 600 }], skippable: true });
  const q = state.claudeQuestion;
  // The map's own "which one" question stands in for anything the interpreter asked about that place.
  const askedPlaces = Object.keys(asks).map((f) => normName(merged[f])).filter(Boolean);
  const aboutAPlace = q?.text && askedPlaces.some((pl) => normName(q.text).includes(pl));
  if (q?.text && q.choices?.length >= 2 && !aboutAPlace) add({ id: `q:${normName(q.text).slice(0, 40)}`, kind: 'open', field: null, text: q.text, choices: q.choices.map((c) => ({ label: c, say: c })), skippable: true });
  if (overnight && !state.stayDecision) {
    const start = merged.date && /^\d{4}-\d{2}-\d{2}$/.test(merged.date) ? merged.date : null;
    const end = start ? (merged.end_date && merged.end_date > start ? merged.end_date : addDays(start, Math.max(1, Number(merged.nights) || 1))) : null;
    const where = (destination ?? origin)?.locality || (destination ?? origin)?.label || merged.destination || merged.origin;
    add({ id: 'stay', kind: 'stay', field: 'when', text: `That's a night away — ${where}${start ? `, ${dayWords(start)} to ${dayWords(end)}` : ''}. Set it up as a trip with dates and somewhere to stay, or just plan the day out?`, choices: [{ label: 'Set up the trip', say: 'Set up the trip', value: 'trip' }, { label: 'Just plan the day', say: 'Just plan the day', value: 'day' }], skippable: true });
  }
  return checks;
}

/** What was already known plus what this turn said; nulls and empty lists never overwrite. */
function mergeIntent(prev, intent) {
  const merged = { ...(prev || {}), ...Object.fromEntries(Object.entries(intent).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))) };
  merged.wants = [...new Set([...(prev?.wants || []), ...(intent.wants || [])])];
  merged.avoids = [...new Set([...(prev?.avoids || []), ...(intent.avoids || [])])];
  merged.attending = intent.attending?.length ? intent.attending : (prev?.attending || []);
  delete merged.question;
  return merged;
}

const addDays = (dateStr, n) => new Date(new Date(`${dateStr}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const dayWords = (dateStr) => new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

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
export async function createTripFromIntent({ household, members, intent, origin, destination, anchorPlace, sources = null, title: givenTitle = null }) {
  const tz = household.timezone || DEFAULT_TZ;
  const dateStr = intent.date && /^\d{4}-\d{2}-\d{2}$/.test(intent.date) ? intent.date : wallClock(new Date(), tz).dateStr;
  const at = (hhmm) => wallToUtc(dateStr, hhmm, tz);
  // A day out is at most a long day: "a whole day" cannot wrap the clock round to nothing.
  const duration = Math.min(Math.max(60, intent.duration_minutes ?? 600), 720);
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
  const title = givenTitle ?? await outingTitle({ origin, destination, anchorPlace, anchor });

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

/**
 * An overnight stay becomes a dated trip (Trips tab): a city, a date range, a
 * base at its centre until a hotel is picked, and the wishes kept in the notes.
 */
async function createStayFromIntent({ household, members, intent, destination }) {
  const tz = household.timezone || DEFAULT_TZ;
  const start = intent.date && /^\d{4}-\d{2}-\d{2}$/.test(intent.date) ? intent.date : wallClock(new Date(), tz).dateStr;
  const nights = Math.max(1, Number(intent.nights) || 1);
  const end = intent.end_date && /^\d{4}-\d{2}-\d{2}$/.test(intent.end_date) && intent.end_date > start ? intent.end_date : addDays(start, nights);
  const city = destination.locality || destination.label;
  // The trip is named for the thing they came for (a booking, a named place), never for a meal.
  const what = intent.anchor?.name || (intent.wants || []).find(isNamedPlace) || null;
  const title = `${city} · ${what ?? new Date(`${start}T12:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
  const notes = [
    intent.stay ? `Stay: ${intent.stay}` : null,
    intent.wants?.length ? `Wants: ${intent.wants.join(', ')}` : null,
    intent.avoids?.length ? `Avoid: ${intent.avoids.join(', ')}` : null,
  ].filter(Boolean).join('\n') || null;
  const travelMode = intent.travel_mode && TRAVEL_MODES.includes(intent.travel_mode) ? intent.travel_mode : 'driving';
  const intensity = intent.intensity && INTENSITY_TARGETS[intent.intensity] ? intent.intensity : household.default_intensity;
  const base = { label: `${city} (centre)`, lat: destination.lat, lng: destination.lng };
  const attendingNames = new Set((intent.attending || []).map((n) => n.toLowerCase()));
  const attending = attendingNames.size ? members.filter((m) => attendingNames.has(m.name.toLowerCase())) : members;
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into trips (household_id, kind, title, notes, place_label, start_date, end_date,
                          base_label, base_lat, base_lng, base_kind, has_car, day_start, day_end,
                          origin_label, origin_lat, origin_lng, depart_at, return_at, travel_mode, intensity, timezone)
       values ($1,'trip',$2,$3,$4,$5,$6,$7,$8,$9,'hotel',$10,$11,$12,$7,$8,$9,($5::date + $11::time),($6::date + $12::time),$13,$14,$15) returning *`,
      [household.id, title, notes, destination.label, start, end, base.label, base.lat, base.lng, travelMode !== 'transit',
       household.day_start ?? '09:30', household.day_end ?? '21:00', travelMode, intensity, tz],
    );
    const created = rows[0];
    for (const m of attending.length ? attending : members) await client.query('insert into trip_attendees (trip_id, member_id) values ($1, $2) on conflict do nothing', [created.id, m.id]);
    await ensureDays(client, created);
    await placeTrip(client, created.id, destination);
    created.startDate = start; created.endDate = end;
    // Start from everything the household already knows in this city (atlas).
    const { rows: placed } = await client.query('select country_code, locality from trips where id = $1', [created.id]);
    if (placed[0]?.country_code) {
      await client.query(
        `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, venue, note)
         select $1, hp.venue_ref, hp.label, coalesce(hp.kind, 'other'), hp.category, hp.lat, hp.lng, hp.venue, hp.note
           from household_places hp
          where hp.household_id = $2 and hp.country_code = $3 and coalesce(hp.locality, '') = coalesce($4, '')
         on conflict (trip_id, venue_ref) do nothing`,
        [created.id, household.id, placed[0].country_code, placed[0].locality],
      );
    }
    return created;
  });
}

// What was asked for, sorted: meals count toward places to eat; a named place
// goes on the shortlist as a must-do; the rest ("one or two activities") is a number.
const FOOD_WORDS = /\b(lunch|dinner|breakfast|brunch|supper|restaurant|caf[eé]|coffee|pub|bar|drinks?|eat|meal|tea)\b/i;
const GENERIC_WANT = /\b(activit|things? to do|something|somewhere|anything|nice|relax|spa|walks?|shopping|explore|sightsee)/i;

async function seedShortlistFromWants({ trip, destination, wants }) {
  const seeded = [];
  for (const want of wants) {
    if (FOOD_WORDS.test(want) || GENERIC_WANT.test(want)) continue;
    const text = want.replace(/^(the|a|an)\s+/i, '').trim();
    if (!/[A-Z]/.test(text)) continue;
    try {
      const [hit] = await geocode(`${text}, ${destination.locality || destination.label}`, { limit: 1, near: destination, countryCode: destination.countryCode ?? null, within: true });
      if (!hit || hit.approximate || kmBetween(hit, destination) > 25) continue;
      const venueRef = `${hit.source}:${hit.sourcePlaceId}`;
      const label = hit.name || text;
      await query(
        `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, note, must_do)
         values ($1,$2,$3,'activity','attraction',$4,$5,$6,true) on conflict (trip_id, venue_ref) do nothing`,
        [trip.id, venueRef, label, hit.lat, hit.lng, 'Asked for when the trip was planned'],
      );
      seeded.push({ label, venueRef });
    } catch { /* not on the map: it stays in the notes */ }
  }
  return seeded;
}

/** Retrieve the candidate pool ONCE for a trip (Epic 5 C3). */
async function retrievePool({ household, trip, attendees, intent, sessionId, sourcesOverride = null }) {
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
  // Through the cache, not straight at the sources: the same point, radius,
  // window and source set is the same search, and the Find tab or a second
  // plan for the same day must not ask the providers again (sources/cache.js).
  const { venues, degraded, sourcesQueried, units, rawCounts, resolvedCounts, cached, fetched } = await searchCached({
    center: originPoint,
    radiusKm: hopRadiusKm,
    categories: [],
    query: '',
    includeEvents: true,
    outingStart: trip.depart_at,
    // A trip's saved source set applies to its plans too; Tripadvisor only when the trip names it.
    sources: sourcesOverride ?? (Array.isArray(trip.sources) ? trip.sources : []),
    locality: trip.locality ?? null,
    outingEnd: trip.return_at,
    // For the local scout: where and when in words, and who is asking.
    placeLabel: trip.origin_label,
    timezone: trip.timezone || household.timezone || null,
    householdId: household.id,
    sessionId,
  });
  // Only the caller that actually asked the providers is billed for it.
  if (fetched) {
    await query(
      `insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)`,
      [household.id, sessionId, sourcesQueried.join('+') || 'none', 'plan.retrieve', units],
    );
  }

  // Places the household has marked special may be further than the usual limit.
  const { rows: specials } = await query(`select source || ':' || source_place_id as ref from place_ledger where household_id = $1 and status = 'special'`, [household.id]);
  const specialRefs = new Set(specials.map((r) => r.ref));
  let reached = deriveCatchment({ origin: originPoint, maxTravelMinutes: maxTravelMinutes * 1.5, mode: trip.travel_mode, venues });
  // Real durations from the base when Google Routes is on; the estimate stays as the fallback.
  if (routingEnabled() && reached.length) {
    try {
      const meter = {};
      // The nearest by estimate get the real road time; the far tail keeps its
      // estimate and is nearly always dropped by the reach filter anyway.
      // Routes bills per origin×destination element and the daily quota is
      // finite: 200 of these on every plan was three quarters of a day's
      // allowance (owner, 4 Sep 2026, after the quota was breached).
      const asked = [...reached].sort((a, b) => a.travelMinutes - b.travelMinutes).slice(0, MATRIX_MAX);
      const real = await travelMatrixMinutes({ origin: originPoint, destinations: asked, mode: trip.travel_mode, departAt: trip.depart_at, meter });
      if (real) {
        const roadMinutes = new Map();
        asked.forEach((v, i) => { if (real[i]) roadMinutes.set(v, real[i].minutes); });
        reached = reached.map((v) => (roadMinutes.has(v) ? { ...v, travelMinutes: roadMinutes.get(v), travelEstimated: false } : { ...v, travelEstimated: true }));
      }
      if (Object.keys(meter).length) await query('insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)', [household.id, sessionId, 'google-routes', 'plan.matrix', meter]);
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

  return {
    candidates, excluded, degraded, maxTravelMinutes, sourcesQueried, wantsText,
    // Every stage, so the admin source view can say where each record was lost.
    stages: { venues, reached, inReach }, rawCounts, resolvedCounts, radiusKm: hopRadiusKm, window: { from: trip.depart_at, to: trip.return_at }, origin: originPoint, units,
    cached: Boolean(cached),
  };
}

// Under this, there is no journey to speak of and nothing is "on the way".
const CORRIDOR_MIN_JOURNEY_MINUTES = 30;

/**
 * What is on the way (Epic 4 C2). One retrieval per plan, beside the pool.
 *
 * The journey's own polyline goes to the place source's along-route search, so
 * the corridor is the road actually driven rather than a box drawn round it.
 * What comes back is put through the household's constraints exactly like the
 * destination pool — allergens exclude, tastes rank — and then measured: what
 * each place adds between home and where they are going, and how far into the
 * journey it sits. Only the few worth breaking a journey for are proposed
 * (domain/corridor.js); the rest are offered with the reason they were not.
 */
async function retrieveCorridor({ household, trip, dayTrip, attendees, sessionId, journey, polyline, sources = null, includeChains = false }) {
  const origin = { lat: Number(trip.origin_lat), lng: Number(trip.origin_lng) };
  const destination = { lat: Number(trip.base_lat ?? trip.destination_lat), lng: Number(trip.base_lng ?? trip.destination_lng) };
  if (![origin.lat, origin.lng, destination.lat, destination.lng].every(Number.isFinite)) return null;
  const mode = trip.travel_mode || 'driving';
  const limit = MAX_DETOUR_MINUTES[mode] ?? 15;
  const meter = {};
  // The same shape whether or not anything was found, so the screen can always
  // say what the journey is and that the road was looked at.
  const nothing = (extra = {}) => ({
    from: trip.origin_label, to: trip.base_label, mode, minutes: journey.minutes, estimated: journey.estimated !== false,
    stops: [], picked: [], limitMinutes: limit, windowStart: dayTrip.depart_at, windowEnd: dayTrip.return_at, ...extra,
  });
  const { venues, degraded, sourcesQueried, fetched } = await searchCorridor({ encodedPolyline: polyline, origin, destination, sources, meter });
  if (fetched && sourcesQueried.length) {
    await query('insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)',
      [household.id, sessionId, sourcesQueried.join('+'), 'plan.corridor', meter]).catch(() => null);
  }
  if (!venues.length) return nothing({ degraded, sourcesQueried });

  const { rows: specials } = await query("select source || ':' || source_place_id as ref from place_ledger where household_id = $1 and status = 'special'", [household.id]);
  const specialRefs = new Set(specials.map((r) => r.ref));

  // Measuring every result would bill for places nobody would stop at, so the
  // straight-line estimate prunes first and the real numbers are fetched for
  // what survives. A place the household already loves is never pruned.
  const near = venues
    .map((v) => ({ ...v, special: specialRefs.has(`${v.source}:${v.sourcePlaceId}`), estimatedDetour: estimateDetour({ origin, destination, venue: v, mode }) ?? 0 }))
    .filter((v) => v.special || v.estimatedDetour <= limit + 10)
    .sort((a, b) => (b.special ? 1 : 0) - (a.special ? 1 : 0) || (b.rating ?? 0) * Math.log10(Math.max(10, b.ratingCount ?? 10)) - (a.rating ?? 0) * Math.log10(Math.max(10, a.ratingCount ?? 10)))
    .slice(0, 30);
  if (!near.length) return nothing({ degraded, sourcesQueried });

  // Detour is the honest cost: home → here → there, less home → there.
  let measured = false;
  let toThem = null;
  let fromThem = null;
  if (routingEnabled()) {
    try {
      const m = {};
      const [a, b] = await Promise.all([
        routeMatrixMinutes({ origins: [origin], destinations: near, mode, departAt: dayTrip.depart_at, meter: m }),
        routeMatrixMinutes({ origins: near, destinations: [destination], mode, departAt: dayTrip.depart_at, meter: m }),
      ]);
      if (a && b) { toThem = a[0]; fromThem = b.map((row) => row[0]); measured = true; }
      await query('insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)', [household.id, sessionId, 'google-routes', 'plan.corridor.detour', m]).catch(() => null);
    } catch { /* the estimate stands */ }
  }
  const direct = journey.minutes;
  // The estimate runs 50% long on a motorway; the measured times do not. Mixing
  // the two would read as an hour's detour for a place beside the road, so a
  // pair that could not be measured is compared against the estimated journey.
  const directEstimated = estimateTravelMinutes(origin, destination, mode);
  const withCost = near.map((v, i) => {
    const bothMeasured = Boolean(measured && toThem?.[i] && fromThem?.[i]);
    const there = bothMeasured ? toThem[i].minutes : estimateTravelMinutes(origin, v, mode);
    const on = bothMeasured ? fromThem[i].minutes : estimateTravelMinutes(v, destination, mode);
    return {
      ...v,
      detourMinutes: Math.max(0, Math.round(there + on - (bothMeasured ? direct : directEstimated))),
      detourEstimated: !bothMeasured,
      // How far into the journey it sits — not how far it is from home, which
      // is not a cost here and must not be scored like one.
      alongFraction: there + on > 0 ? Math.min(0.95, Math.max(0.05, there / (there + on))) : 0.5,
    };
  });

  const learned = await loadLearnedPreferences(household.id);
  // The first and last few minutes are not a journey: somewhere five minutes
  // from home is local, and somewhere on the edge of the destination is already
  // in the pool for the day itself.
  const alongTheWay = withCost.filter((v) => v.alongFraction > 0.12 && v.alongFraction < 0.9);
  const { candidates } = applyConstraints({ venues: alongTheWay.length ? alongTheWay : withCost, attendees, learned });
  const legs = corridorStops({
    candidates,
    mode,
    journeyMinutes: direct,
    windowStart: dayTrip.depart_at,
    windowEnd: dayTrip.return_at,
    timezone: trip.timezone || household.timezone || DEFAULT_TZ,
    dwellFor: (c) => dwellFor(c, household, attendees).minutes,
    includeChains,
  });

  const asStop = (c) => ({
    ...richFields(c, null),
    pinned: false,
    leg: c.leg, meal: c.meal, why: c.why, standout: c.standout ?? null, notProposed: c.notProposed ?? null,
    detourMinutes: c.detourMinutes, detourEstimated: c.detourEstimated !== false, dwellMinutes: c.dwellMinutes,
    alongFraction: Number((c.alongFraction ?? 0.5).toFixed(3)),
    intoJourneyMinutes: Math.round(direct * (c.alongFraction ?? 0.5)),
  });
  const proposed = [...legs.out, ...legs.back].map(asStop);
  return {
    from: trip.origin_label, to: trip.base_label, mode, minutes: direct, estimated: journey.estimated !== false,
    stops: [...proposed, ...legs.more.map(asStop)],
    picked: proposed.map((s) => s.id),
    limitMinutes: legs.limitMinutes, degraded, sourcesQueried,
    windowStart: dayTrip.depart_at, windowEnd: dayTrip.return_at,
  };
}

/**
 * Getting there, and what is on the way: the real driving (or transit) time
 * where the routing source is on, and the corridor search that time's own
 * polyline makes possible. Never rejects — a day out still stands when the
 * road cannot be looked at.
 */
async function journeyWithStops({ household, trip, dayTrip, attendees, sessionId, sources = null, includeChains = false }) {
  const journey = {
    from: trip.origin_label, to: trip.base_label, mode: trip.travel_mode, estimated: true,
    minutes: estimateTravelMinutes({ lat: trip.origin_lat, lng: trip.origin_lng }, { lat: trip.base_lat, lng: trip.base_lng }, trip.travel_mode),
  };
  const awayFromHome = trip.origin_lat !== trip.base_lat || trip.origin_lng !== trip.base_lng;
  let polyline = null;
  if (routingEnabled() && awayFromHome) {
    try {
      const meter = {};
      const r = await routeBetween({ from: { lat: trip.origin_lat, lng: trip.origin_lng }, to: { lat: trip.base_lat, lng: trip.base_lng }, mode: trip.travel_mode, departAt: new Date(new Date(dayTrip.depart_at).getTime() - 3 * 3600_000).toISOString(), meter });
      if (r) { Object.assign(journey, { minutes: r.minutes, estimated: false, meters: r.meters }); polyline = r.encodedPolyline ?? null; }
      await query('insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)', [household.id, sessionId, 'google-routes', 'plan.journey', meter]);
    } catch { /* the estimate stands */ }
  }
  // Everything between home and the destination is invisible to a search around
  // the destination (Requirements §1). Once the journey is long enough to be a
  // journey, the road itself is searched as well.
  if (!awayFromHome || journey.minutes < CORRIDOR_MIN_JOURNEY_MINUTES) return { journey, route: null };
  try {
    return { journey, route: await retrieveCorridor({ household, trip, dayTrip, attendees, sessionId, journey, polyline, sources, includeChains }) };
  } catch (err) {
    return {
      journey,
      route: {
        error: String(err?.message || err), from: trip.origin_label, to: trip.base_label, mode: trip.travel_mode,
        minutes: journey.minutes, estimated: journey.estimated !== false, limitMinutes: MAX_DETOUR_MINUTES[trip.travel_mode] ?? 15,
        stops: [], picked: [], windowStart: dayTrip.depart_at, windowEnd: dayTrip.return_at,
      },
    };
  }
}

/**
 * The journey as it stands: the stops chosen for it, timed, and what they do
 * to when the day leaves home and gets back. Recomputed on every response so
 * adding or dropping a stop moves the clock.
 */
function routeView(state) {
  const route = state.route;
  if (!route?.windowStart || !route.windowEnd) return null;
  const picked = new Set(route.picked || []);
  const chosen = (route.stops || []).filter((s) => picked.has(s.id));
  const timed = scheduleCorridor({
    stops: chosen,
    journeyMinutes: route.minutes,
    windowStart: route.windowStart,
    windowEnd: route.windowEnd,
  });
  const byId = new Map([...timed.out, ...timed.back].map((s) => [s.id, s]));
  const there = Math.round((new Date(timed.leaveThereAt) - new Date(timed.arriveThereAt)) / 60_000);
  return {
    from: route.from, to: route.to, mode: route.mode, minutes: route.minutes, estimated: route.estimated,
    limitMinutes: route.limitMinutes,
    leaveHomeAt: timed.leaveHomeAt, backHomeAt: timed.backHomeAt,
    // What the stops cost: the day is the same length, so the time at the far
    // end is what pays for them.
    arriveThereAt: timed.arriveThereAt, leaveThereAt: timed.leaveThereAt,
    minutesThere: there,
    minutesThereWithout: Math.round((new Date(route.windowEnd) - new Date(route.windowStart)) / 60_000),
    addedOutMinutes: timed.addedOutMinutes, addedBackMinutes: timed.addedBackMinutes,
    addedMinutes: timed.addedOutMinutes + timed.addedBackMinutes,
    stops: (route.stops || []).map((s) => ({ ...s, chosen: picked.has(s.id), arriveAt: byId.get(s.id)?.arriveAt ?? null, leaveAt: byId.get(s.id)?.leaveAt ?? null })),
  };
}

/**
 * The day at the destination is shortened by whatever is being stopped for on
 * the way, so the options are composed for the time actually there. The shift
 * is relative, so a change the household makes to the day's length in between
 * still stands.
 */
async function applyRouteToDay(session) {
  const route = session.state.route;
  if (!route?.windowStart || !session.state.dayId) return;
  const view = routeView(session.state);
  const prev = route.applied ?? { out: 0, back: 0 };
  const next = { out: view.addedOutMinutes, back: view.addedBackMinutes };
  if (prev.out === next.out && prev.back === next.back) return;
  await query(
    `update trip_days set start_time = start_time + ($2::int * interval '1 minute'),
                          end_time = end_time - ($3::int * interval '1 minute') where id = $1`,
    [session.state.dayId, next.out - prev.out, next.back - prev.back],
  );
  route.applied = next;
}

/** Re-read the day the household asked for, once they have changed its length themselves. */
async function syncRouteWindow(session) {
  const route = session.state.route;
  if (!route?.windowStart || !session.state.dayId) return;
  const { trip } = await sessionTrip(session);
  const applied = route.applied ?? { out: 0, back: 0 };
  route.windowStart = new Date(new Date(trip.depart_at).getTime() - applied.out * 60_000).toISOString();
  route.windowEnd = new Date(new Date(trip.return_at).getTime() + applied.back * 60_000).toISOString();
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

/**
 * Admin: what each source returns for a day of a trip and where the plan
 * loses it. Runs the plan's own retrieval (same point, radius, window and
 * source set) with no Claude call, then walks every record through the same
 * stages — catchment, reach, allergens, the day's window — and reports the
 * last one it survived. The scout is left out unless asked for (it costs
 * money); Tripadvisor only when the trip or the query names it.
 */
router.get('/trips/:tripId/sources', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { rows: [real] } = await query('select * from trips where id = $1', [req.params.tripId]);
    if (!real) return res.status(404).json({ error: 'trip_not_found' });
    const { rows: days } = await query('select * from trip_days where trip_id = $1 order by date', [real.id]);
    const day = days.find((d) => d.id === req.query.dayId) ?? days[0];
    if (!day) return res.status(400).json({ error: 'no_days', message: 'This trip has no days yet.' });
    const trip = dayAsTrip(real, day);
    const members = await loadMembers(household.id);
    const attendees = toAttendees(members);
    const picked = optInFrom(req.query.sources);
    const includeScout = String(req.query.scout || '') === '1';
    const set = (picked.length ? picked : (Array.isArray(real.sources) && real.sources.length ? real.sources : defaultSourceKeys())).filter((k) => includeScout || k !== 'scout');

    const startedAt = new Date();
    const pool = await retrievePool({ household, trip, attendees, intent: { wants: [], special: false }, sessionId: null, sourcesOverride: set });
    // What this fetch cost: units at list price per provider, and the actual
    // Claude spend recorded while it ran (the scout), so a single-source
    // refresh says what it just spent.
    const { rows: [spent] } = await query('select coalesce(sum(estimated_cost_usd), 0)::float as usd from provider_calls where household_id = $1 and created_at >= $2', [household.id, startedAt]);
    const listPrice = Object.entries(pool.units || {}).map(([k, n]) => ({ key: k, units: n, usd: (lineByKey(k)?.allowance?.beyondUsd ?? 0) * n }));
    const spend = { units: pool.units || {}, listPriceUsd: listPrice.reduce((a, l) => a + l.usd, 0), byProvider: listPrice, actualUsd: spent.usd };
    const keyOf = (v) => v.key ?? `${v.source}:${v.sourcePlaceId}`;
    const reached = new Map(pool.stages.reached.map((v) => [keyOf(v), v]));
    const inReach = new Map(pool.stages.inReach.map((v) => [keyOf(v), v]));
    const excluded = new Map(pool.excluded.map((v) => [keyOf(v), v]));
    const candidates = new Map(pool.candidates.map((v) => [keyOf(v), v]));
    const base = pool.origin;

    const venues = pool.stages.venues.map((v) => {
      const k = keyOf(v);
      const r = reached.get(k); const ir = inReach.get(k); const ex = excluded.get(k); const c = candidates.get(k);
      let stage; let reason = null;
      if (!r) { stage = 'catchment'; reason = `Estimated ${Math.round(estimateTravelMinutes(base, v, trip.travel_mode))} min away, beyond ${Math.round(pool.maxTravelMinutes * 1.5)} min`; }
      else if (!ir) { stage = 'reach'; reason = `${Math.round(r.travelMinutes)} min away${r.travelEstimated === false ? ' (Google Routes)' : ' (estimated)'}, beyond the pace limit`; }
      else if (ex) { stage = 'allergen'; reason = (ex.exclusionReasons || []).join('; '); }
      else if (c && !eventInsideWindow(c, trip)) { stage = 'window'; reason = `Runs ${c.startsAt?.slice(11, 16)}–${c.endsAt?.slice(11, 16)} UTC, outside the day's ${trip.depart_at.slice(11, 16)}–${trip.return_at.slice(11, 16)} UTC`; }
      else if (c) { stage = 'shown'; reason = c.chain ? 'Shown only when chains are allowed' : null; }
      else { stage = 'reach'; reason = 'Dropped before ranking'; }
      const src = c ?? ir ?? r ?? v;
      const { photos, reviews, provenance, conflicts, ...rest } = src;
      return {
        key: k, venueRef: `${v.source}:${v.sourcePlaceId}`, name: v.name, category: v.category, source: v.source,
        contributingSources: v.contributingSources ?? [v.source], ratingSource: v.rating != null ? (provenance?.rating?.source ?? v.source) : null,
        rating: v.rating ?? null, ratingCount: v.ratingCount ?? null, priceLevel: v.priceLevel ?? null, goodForChildren: v.goodForChildren ?? null,
        startsAt: v.startsAt ?? null, endsAt: v.endsAt ?? null, venueName: v.venueName ?? null, experiences: v.experiences ?? [], cuisines: v.cuisines ?? [],
        distanceKm: Number(kmBetween(base, v).toFixed(2)), travelMinutes: src.travelMinutes != null ? Math.round(src.travelMinutes) : null, travelEstimated: src.travelEstimated !== false,
        stage, reason, score: c?.score ?? null, reasons: c?.reasons ?? [], chain: Boolean(v.chain), conflicts: conflicts ?? [],
        externalUrl: v.externalUrl ?? v.website ?? null, address: v.address ?? null, justification: v.justification ?? null, attribution: v.attributionText ?? v.attribution ?? null,
        photoCount: (photos ?? []).length,
        raw: rest,
      };
    });
    const count = (list) => { const o = {}; for (const v of list) for (const k of v.contributingSources) o[k] = (o[k] || 0) + 1; return o; };
    const survived = (min) => venues.filter((v) => ORDER.indexOf(v.stage) >= ORDER.indexOf(min));
    const stages = [
      { key: 'raw', label: 'Returned by the source', bySource: pool.rawCounts, total: Object.values(pool.rawCounts).reduce((a, b) => a + b, 0) },
      { key: 'resolved', label: 'After merging duplicates', bySource: pool.resolvedCounts, total: venues.length },
      { key: 'reach', label: `Within reach (${pool.maxTravelMinutes} min ${trip.travel_mode})`, bySource: count(survived('allergen')), total: survived('allergen').length },
      { key: 'allergen', label: 'Not excluded by an allergen', bySource: count(survived('window')), total: survived('window').length },
      { key: 'shown', label: "Inside the day's window (shown to browse)", bySource: count(survived('shown')), total: survived('shown').length },
    ];
    res.json({
      trip: { id: real.id, title: real.title, dayId: day.id, date: day.date, base: { label: trip.origin_label, ...base }, window: pool.window, mode: trip.travel_mode, timezone: trip.timezone },
      days: days.map((d) => ({ id: d.id, date: d.date })),
      sourcesQueried: pool.sourcesQueried, requested: set, includeScout, degraded: pool.degraded, radiusKm: pool.radiusKm, maxTravelMinutes: pool.maxTravelMinutes,
      stages, venues, spend,
    });
  } catch (err) {
    next(err);
  }
});
const ORDER = ['catchment', 'reach', 'allergen', 'window', 'shown'];

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
      // The end of the day was just rewritten from scratch, so the time taken
      // out of it for a stop on the way home has to be taken out again.
      if (session.state.route?.applied) session.state.route.applied = { out: session.state.route.applied.out, back: 0 };
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
    // The journey as a thing to plan, not only a time to subtract.
    route: routeView(session.state),
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
    rows: session.state.rows ?? null,
    checks: [],
    answered: session.state.answered ?? [],
    ready: true,
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
    const { utterance: said, sessionId: existingId, sources: pickedSources, attendingMemberIds, field, skip, set } = req.body || {};
    const utterance = String(said || '').trim();
    if (!utterance && !skip && !set) return res.status(400).json({ error: 'utterance_required' });

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
    state.transcript = state.transcript || [];
    state.resolved = state.resolved || {};
    state.answered = state.answered || [];
    state.skipped = state.skipped || [];
    if (pickedSources) state.sources = Array.isArray(pickedSources) && pickedSources.length ? pickedSources.map(String) : null;
    const lastAsked = [...state.transcript].reverse().find((t) => t.role === 'assistant');
    const before = state.checks || [];
    if (utterance) state.transcript.push({ role: 'user', text: utterance });

    // "Plan it" (said or tapped) runs the plan once nothing is left to check.
    if (utterance && PLAN_IT.test(utterance) && state.intent) {
      if (before.length) {
        const reply = `Still to check: ${before[0].text}`;
        return res.json({ sessionId: session.id, reply, rows: state.rows ?? [], checks: before, answered: state.answered, ready: false, intent: state.intent, options: [] });
      }
      return startRun({ household, members, session, state, res });
    }

    // An answer to something in the queue is applied as it was tapped — no interpretation, no guess.
    let picked = null;
    let pickedCheck = null;
    for (const c of before) { const m = matchChoice(c, utterance); if (m) { picked = m; pickedCheck = c; break; } }
    let intent;
    const base = state.intent || {};
    if (set && typeof set === 'object') {
      // A tapped control is exact: it lands in the intent as it is, no model call.
      // Wants a control produced last time are replaced, wants that were said stay.
      const prevControl = new Set(state.controlWants || []);
      const kept = (base.wants || []).filter((w) => !prevControl.has(w));
      const control = state.control || {};
      const next = { ...base, wants: kept, avoids: base.avoids || [], attending: base.attending || [], understood: true, question: null, reply: 'Updated.' };
      if (set.destination !== undefined) {
        if (set.destination?.lat != null) {
          const pl = { label: set.destination.label, lat: set.destination.lat, lng: set.destination.lng, locality: set.destination.locality ?? null, country: set.destination.country ?? null, countryCode: set.destination.countryCode ?? null, how: 'picked' };
          state.resolved.destination = { said: pl.label, place: pl };
          next.destination = pl.label;
        } else { next.destination = null; delete state.resolved.destination; }
      }
      if (set.date !== undefined) next.date = set.date || null;
      if (set.end_date !== undefined) next.end_date = set.end_date || null;
      if (set.nights !== undefined) next.nights = Number(set.nights) > 0 ? Number(set.nights) : null;
      if (set.duration_minutes !== undefined) next.duration_minutes = Number(set.duration_minutes) > 0 ? Number(set.duration_minutes) : null;
      if (set.depart_time !== undefined) next.depart_time = set.depart_time || null;
      if (set.do) control.do = { kinds: (set.do.kinds || []).map(String), named: (set.do.named || []).map(String), count: set.do.count ?? null };
      if (set.eat) control.eat = { meals: set.eat.meals || {}, avoid_chains: set.eat.avoid_chains ?? null, special: set.eat.special ?? null };
      if (set.budget) control.budget = { price_point: set.budget.price_point ?? null, low: set.budget.low ?? null, high: set.budget.high ?? null, per: set.budget.per ?? null };
      state.control = control;
      const made = [];
      if (control.do) {
        for (const k of control.do.kinds) made.push(k.toLowerCase());
        for (const n of control.do.named) made.push(n);
        next.min_activities = control.do.count ?? next.min_activities ?? null;
      }
      if (control.eat) {
        const meals = Object.entries(control.eat.meals || {});
        for (const [meal, kind] of meals) made.push(kind ? `${kind} for ${meal}` : `somewhere nice for ${meal}`);
        if (meals.length) next.min_food_stops = meals.length;
        if (control.eat.avoid_chains !== null) next.avoid_chains = control.eat.avoid_chains;
        if (control.eat.special !== null) next.special = Boolean(control.eat.special);
      }
      if (control.budget) {
        next.price_point = control.budget.price_point && control.budget.price_point !== 'any' ? control.budget.price_point : null;
        next.budget_low = control.budget.low ?? null;
        next.budget_high = control.budget.high ?? null;
        next.budget_per = control.budget.per ?? null;
      }
      next.wants = [...new Set([...kept, ...made])];
      state.controlWants = made;
      intent = next;
    } else if (skip) {
      const c = before.find((x) => x.id === skip);
      if (c?.skippable) {
        state.skipped.push(c.id);
        if (c.kind === 'attending') base.attending_everyone = true;
        if (c.kind === 'stay') state.stayDecision = 'day';
        if (c.id.startsWith('q:')) state.claudeQuestion = null;
        state.answered.push({ id: c.id, text: c.text, answer: 'skipped' });
      }
      intent = { ...base, understood: true, question: null, reply: 'Skipped.' };
    } else if (picked && pickedCheck.kind === 'place' && picked.place) {
      state.resolved[pickedCheck.intentField] = { said: picked.say, place: { ...picked.place, label: picked.label.replace(/\s*\([^)]*\)$/, '') } };
      intent = { ...base, [pickedCheck.intentField]: picked.say, understood: true, question: null, reply: `${picked.say} it is.` };
    } else if (picked && pickedCheck.kind === 'stay') {
      state.stayDecision = picked.value;
      intent = { ...base, understood: true, question: null, reply: picked.value === 'trip' ? 'A trip with dates, then.' : 'Just the day, then.' };
    } else if (picked && pickedCheck.kind === 'duration') {
      intent = { ...base, duration_minutes: picked.value, understood: true, question: null, reply: `${picked.label} there.` };
    } else if (picked && pickedCheck.kind === 'attending') {
      const except = String(picked.value).startsWith('except:') ? String(picked.value).slice(7) : null;
      intent = except
        ? { ...base, attending: members.filter((m) => m.id !== except).map((m) => m.name), attending_everyone: false, understood: true, question: null, reply: picked.label + '.' }
        : { ...base, attending: [], attending_everyone: true, understood: true, question: null, reply: 'Everyone, then.' };
    } else {
      // Earlier partial intent is carried so the household only has to answer
      // the gap; the open question is carried too, so "yes" and "home" mean
      // something; a tapped row scopes the words to that row alone.
      const open = before[0] ?? null;
      const FIELD_WORDS = { from: 'origin (where they start)', to: 'destination (where they are going)', when: 'date, nights and how long they have', who: 'who is coming', stay: 'where they sleep', do: 'things to do', eat: 'places to eat and meals', budget: 'price point' };
      const prior = [
        state.intent ? `Earlier in this conversation the user said: ${JSON.stringify(state.intent)}` : '',
        field && FIELD_WORDS[field] ? `The user tapped the "${field}" row and is changing only the ${FIELD_WORDS[field]}: apply their words to that alone and repeat every other field exactly as it was.` : '',
        open
          ? `The app is asking: "${open.text}"${open.choices?.length ? ` with the choices ${JSON.stringify(open.choices.map((c) => c.say))}` : ''}${open.field ? ` — it is about the ${open.field}` : ''}. A short answer answers it.`
          : lastAsked ? `The app last said: "${lastAsked.text}"` : '',
        state.intent ? 'A correction ("no, not X — Y", "actually make it Sunday") replaces the one field it is about; everything else stays.' : '',
      ].filter(Boolean).join('\n');

      intent = normaliseIntent(await parseStructured({
        system: INTERPRET_SYSTEM,
        messages: [{
          role: 'user',
          content: `${JSON.stringify(householdContext(household, members))}\n\n${prior}\n\nUser said: "${utterance}"`,
        }],
        schema: TripIntent,
        householdId: household.id,
        sessionId: session.id,
        purpose: 'plan.interpret',
      }));
      state.claudeQuestion = intent.question ?? null;
      // A place choice named in words is as good as tapped.
      for (const c of before.filter((x) => x.kind === 'place')) {
        const named = matchChoice(c, intent[c.intentField] || '') ?? matchChoice(c, utterance);
        if (named?.place) { state.resolved[c.intentField] = { said: named.say, place: { ...named.place, label: named.label.replace(/\s*\([^)]*\)$/, '') } }; intent[c.intentField] = named.say; }
      }
      if (before.some((x) => x.kind === 'stay') && !state.stayDecision) {
        const low = utterance.toLowerCase();
        if (/\b(trip|set it up|set up|yes|both|the stay|overnight)\b/.test(low)) state.stayDecision = 'trip';
        else if (/\b(just the day|day out|the day|only the day|no)\b/.test(low)) state.stayDecision = 'day';
      }
    }

    const merged = set ? { ...intent } : mergeIntent(state.intent, intent);
    // Unless said otherwise, the outing starts at home and everyone is coming (owner, 3 Sep 2026).
    if (!merged.origin && household.home_lat != null) merged.origin = 'home';
    if (!merged.attending?.length && merged.attending_everyone == null) merged.attending_everyone = true;
    // Ticks on the Who's coming row are the same statement as saying the names.
    if (Array.isArray(attendingMemberIds)) {
      const chosen = members.filter((m) => attendingMemberIds.includes(m.id));
      if (chosen.length) { merged.attending = chosen.map((m) => m.name); merged.attending_everyone = chosen.length === members.length; }
    }
    state.intent = merged;

    // Places: home, a known place, a sure match — or the choices to put to them.
    const asks = {};
    const placeFor = async (f) => {
      if (!merged[f]) return null;
      const kept = state.resolved[f];
      if (kept && normName(kept.said) === normName(merged[f])) return kept.place;
      const r = await resolveSpokenPlace(merged[f], household);
      if (r.choices?.length) asks[f] = r.choices;
      return r.place;
    };
    const origin = await placeFor('origin');
    const destination = await placeFor('destination');
    const overnight = (Number(merged.nights) || 0) >= 1 || Boolean(merged.end_date && merged.date && merged.end_date > merged.date);
    let anchorPlace = null;
    if (merged.anchor?.place_text) {
      try { const [hit] = await geocode(merged.anchor.place_text, { limit: 1, near: destination ?? origin }); if (hit) anchorPlace = { label: hit.label, lat: hit.lat, lng: hit.lng, country: hit.country, countryCode: hit.countryCode, locality: hit.locality }; } catch { /* ask below */ }
    }
    state.places = { origin, destination, anchorPlace };
    const checks = intent.understood === false && !state.intent?.origin ? [] : buildChecks({ merged, origin, destination, asks, anchorPlace, overnight, members, household, state });
    // Whatever was open and is not any more was answered by this turn.
    const stillOpen = new Set(checks.map((c) => c.id));
    const replacedQuestion = checks.some((c) => c.id.startsWith('q:'));
    for (const c of before) {
      if (stillOpen.has(c.id) || state.answered.some((a) => a.id === c.id)) continue;
      if (c.id.startsWith('q:') && replacedQuestion && pickedCheck?.id !== c.id) continue;
      const answer = pickedCheck?.id === c.id ? picked.label : utterance.slice(0, 60);
      state.answered.push({ id: c.id, text: c.text, answer });
    }
    state.checks = checks;
    state.rows = rowsFor({ merged, places: state.places, checks, overnight, members });
    state.ready = intent.understood !== false && checks.length === 0;
    const reply = checks.length ? (checks[0].kind === 'open' && !checks[0].choices.length ? checks[0].text : intent.reply || checks[0].text) : (intent.reply || 'Got it.');
    state.transcript.push({ role: 'assistant', text: reply });
    await saveSession(session.id, state, null);
    return res.json({ sessionId: session.id, reply, rows: state.rows, checks, answered: state.answered, ready: state.ready, intent: merged, missing: checks.map((c) => c.id), question: checks[0] ?? null, options: [] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Every run has a number the household can read out (owner, 4 Sep 2026: "maybe
// even my particular activity should have a unique number associated with it,
// so I can give you that, and you can look at the specific request to see
// what's going wrong"). It is the head of the session's own id, so nothing has
// to be stored to make it, and GET /api/plan/runs/:ref says what that run did.
// ---------------------------------------------------------------------------
export const runRef = (sessionId) => String(sessionId).replace(/-/g, '').slice(0, 8).toUpperCase();

router.get('/runs/:ref', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const ref = String(req.params.ref || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (ref.length < 6) return res.status(400).json({ error: 'ref_too_short', message: 'A run number is eight characters, e.g. 322FCB98.' });
    const { rows } = await query(
      `select id, trip_id, created_at, updated_at, state from plan_sessions
        where household_id = $1 and replace(id::text, '-', '') like $2 || '%'
        order by created_at desc limit 1`,
      [household.id, ref],
    );
    if (!rows[0]) return res.status(404).json({ error: 'run_not_found', message: `No run here begins ${ref.toUpperCase()}. Runs are kept for twelve hours.` });
    const run = rows[0];
    const st = run.state || {};
    const { rows: calls } = await query(
      `select provider, purpose, units, estimated_cost_usd, created_at from provider_calls
        where session_id = $1 order by created_at`,
      [run.id],
    );
    const started = st.runStartedAt ? new Date(st.runStartedAt) : new Date(run.created_at);
    res.json({
      ref: runRef(run.id),
      sessionId: run.id,
      kind: st.kind ?? 'plan',
      asked: st.input ?? st.intent ?? null,
      startedAt: started.toISOString(),
      lastTouchedAt: run.updated_at,
      seconds: Math.max(0, Math.round((new Date(run.updated_at).getTime() - started.getTime()) / 1000)),
      stage: st.stage ?? (st.running ? 'running' : 'done'),
      running: Boolean(st.running),
      error: st.error ?? null,
      answered: Array.isArray(st.ideas) ? st.ideas.map((i) => ({ title: i.title, pinned: Boolean(i.place) })) : null,
      tripId: run.trip_id,
      // What it went out and asked for, in order, so a slow run can be read.
      calls: calls.map((c) => ({ provider: c.provider, purpose: c.purpose, units: c.units, costUsd: c.estimated_cost_usd, at: c.created_at, afterSeconds: Math.max(0, Math.round((new Date(c.created_at).getTime() - started.getTime()) / 1000)) })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Inspire me: a loose brief, a mood or two and a travel cap become ideas that
// say why; an idea opens as a list of things to do and see there.
// ---------------------------------------------------------------------------

const Ideas = z.object({
  ideas: z.array(z.object({
    title: z.string().describe('Short and concrete: "Kew Gardens + Treetop Walkway, lunch in Richmond"'),
    place_text: z.string().describe('The one place to go, as a name the map can find, with its town or region: "Kew Gardens, Richmond", "Bath, Somerset"'),
    why: z.string().describe('One line: the mood it fits, roughly how far, and the person or fact it rests on ("Gina liked the Palm House", "Phoenix loves the water", "on your list since June")'),
    do: z.array(z.string()).describe('Two to four named things to do there'),
    eat: z.array(z.string()).describe('One or two meals, e.g. "lunch at a pub in Hathersage"; empty if food is not the point'),
    travel_minutes: z.number().int().describe('Rough driving time from home, in minutes'),
    overnight: z.boolean().describe('True only if the brief asks for a night away'),
  })).max(5),
  reply: z.string().describe('One warm sentence introducing the ideas, spoken aloud'),
});

const INSPIRE_SYSTEM = `You suggest days out — or a night away only if the brief asks — for one family, starting from their home.

You are given the household (people, likes, dislikes, allergens), their atlas (places they have saved, loved, listed or visited, with notes), today's date, a brief in their words, the moods they picked, a travel cap in minutes by car, and who is coming. Give three to five real, specific places in their own country within the cap. Match the moods. Prefer places from the atlas they loved or listed, and say so. Never suggest anything a coming member dislikes or cannot eat. Each idea's "why" names the person or the fact it rests on. Each idea has named things to do and, where food matters, meals. The reply is spoken aloud: one plain sentence, no lists.

The brief and the moods are both optional. When neither is given, that is not a reason to return nothing — it is the ordinary way in. Suggest the days out this family would most enjoy from home, leaning on their atlas, the ages of the people coming and what is within the cap. Never return an empty list.`;

// How much the day should cost, in the model's ear. "free" also opens the trip's
// Find tab on the places that are free to enter.
const BUDGETS = {
  any: null,
  free: 'Free or nearly free: parks, walks, beaches, free museums and galleries, a picnic or a cheap lunch — no admission tickets, no restaurant bill to speak of',
  cheap: 'Cheap and cheerful: modest entry prices at most, inexpensive places to eat',
  mid: 'Middling: normal admission prices and a proper sit-down meal are fine',
  treat: 'A treat: worth paying for — the best-rated attractions and somewhere special to eat',
};

/**
 * Inspire me runs in the background (owner, 3 Sep 2026: "Failed to fetch"
 * when a redeploy or a slow model call outlived the request). The request
 * answers at once with the session; the screen polls GET /inspire/:sessionId
 * until the ideas are on it. Body: { query, moods, maxTravelMinutes, budget, attendingMemberIds }.
 */
router.post('/inspire', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { query: brief = '', moods = [], maxTravelMinutes = null, budget = 'any', attendingMemberIds } = req.body || {};
    const attending = Array.isArray(attendingMemberIds) && attendingMemberIds.length ? members.filter((m) => attendingMemberIds.includes(m.id)) : members;
    const input = { brief: String(brief || '').trim() || null, moods, maxTravelMinutes: maxTravelMinutes ?? null, budget: budget in BUDGETS ? budget : 'any' };
    const state = { transcript: [], kind: 'inspire', input, running: true, runStartedAt: new Date().toISOString(), ideas: null, reply: null, error: null };
    const { rows: srows } = await query('insert into plan_sessions (household_id, state) values ($1, $2) returning *', [household.id, JSON.stringify(state)]);
    const session = srows[0];
    res.json({ sessionId: session.id, ref: runRef(session.id), running: true, stage: 'thinking' });
    runInspire({ household, attending, session, state }).catch(() => { /* recorded on the session */ });
  } catch (err) {
    next(err);
  }
});

// Inspire me is a list of days out, not a piece of reasoning, so it runs on the
// quicker model with thinking off (owner, 4 Sep 2026: "I've been waiting more
// than a minute and a half… we need to find ways to speed this up, even if it's
// just rendering some stuff and then rendering other stuff in the background").
const INSPIRE_MODEL = process.env.ROAM_INSPIRE_MODEL || 'claude-sonnet-5';
// A model call that has not answered by now is not going to: the run says so
// rather than leaving a spinner turning.
const INSPIRE_DEADLINE_MS = Number(process.env.ROAM_INSPIRE_DEADLINE_MS || 75_000);

const deadline = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
]);

async function runInspire({ household, attending, session, state, append = false }) {
  // Each stage is written to the session as it starts, so the screen can say
  // what is happening instead of spinning, and the ideas themselves are saved
  // before they are pinned to the map — titles first, pins as they land.
  const publish = async (patch) => { Object.assign(state, patch); await saveSession(session.id, state, null); };
  try {
    const { rows: atlas } = await query(
      `select hp.label, hp.kind, hp.category, hp.locality, hp.note,
              (select string_agg(distinct l.status::text, ',') from place_ledger l where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref) as statuses
         from household_places hp where hp.household_id = $1 order by hp.last_seen desc limit 40`,
      [household.id],
    );
    const { input } = state;
    // Five more means five it has not said yet (owner, 4 Sep 2026: "I shouldn't
    // need to refresh the list because you should be storing that data. I guess
    // the option should be 'Show me 5 more'").
    const already = append ? (state.ideas || []) : [];
    const seen = already.length
      ? `\n\nYou have already suggested these to them today, so do not offer them again or anything at the same place: ${already.map((i) => `${i.title} (${i.placeText})`).join('; ')}.`
      : '';
    await publish({ stage: 'thinking' });
    const ask = () => parseStructured({
      system: INSPIRE_SYSTEM,
      messages: [{ role: 'user', content: `${JSON.stringify({ ...householdContext(household, attending), atlas, brief: input.brief, moods: input.moods, maxTravelMinutes: input.maxTravelMinutes, budget: BUDGETS[input.budget], attending: attending.map((m) => m.name) })}${seen}` }],
      schema: Ideas,
      householdId: household.id,
      sessionId: session.id,
      purpose: append ? 'plan.inspire.more' : 'plan.inspire',
      model: INSPIRE_MODEL,
      thinking: 'off',
    });
    let out = await deadline(ask(), INSPIRE_DEADLINE_MS, 'Roam took too long thinking of places — try Inspire me again.');
    // Nothing said and no mood picked is the commonest way in, and it was
    // coming back with an empty list. Asked once more, plainly, before giving up.
    if (!out.ideas?.length) {
      await publish({ stage: 'thinking-again' });
      out = await deadline(
        parseStructured({
          system: INSPIRE_SYSTEM,
          messages: [{ role: 'user', content: `${JSON.stringify({ ...householdContext(household, attending), atlas, brief: input.brief, moods: input.moods, maxTravelMinutes: input.maxTravelMinutes, budget: BUDGETS[input.budget], attending: attending.map((m) => m.name) })}\n\nThey have not said what they want and picked no mood. That is not a reason to return nothing: give five good days out from home for this family, the kind they would be pleased to be reminded of.` }],
          schema: Ideas,
          householdId: household.id,
          sessionId: session.id,
          purpose: 'plan.inspire.retry',
          model: INSPIRE_MODEL,
          thinking: 'off',
        }),
        INSPIRE_DEADLINE_MS,
        'Roam took too long thinking of places — try Inspire me again.',
      );
    }

    const home = household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null;
    // On screen at once, unpinned: the titles and the reasons are the answer,
    // the map pin only decides whether "Things to do and see" can open.
    const fresh = out.ideas.map((idea, i) => ({
      id: `idea-${already.length + i}-${Date.now().toString(36)}`, title: idea.title, why: idea.why, placeText: idea.place_text, place: null,
      travelMinutes: idea.travel_minutes ?? null, overnight: idea.overnight, do: idea.do, eat: idea.eat, placing: true,
    }));
    const ideas = [...already, ...fresh];
    await publish({ ideas, reply: out.reply, stage: 'placing', placed: already.length });

    // The map answers about one name a second, so each pin is published as it
    // lands rather than the whole list waiting for the slowest.
    for (const idea of fresh) {
      try {
        const [hit] = await geocode(idea.placeText, { limit: 1, near: home });
        if (hit) {
          idea.place = { label: hit.label, lat: hit.lat, lng: hit.lng, locality: hit.locality ?? null, countryCode: hit.countryCode ?? null, ref: `${hit.source}:${hit.sourcePlaceId}` };
          if (home) idea.travelMinutes = estimateTravelMinutes(home, idea.place, 'driving');
        }
      } catch { /* the idea stands without a pin */ }
      idea.placing = false;
      if (home && idea.place) idea.distanceKm = Number(kmBetween(home, idea.place).toFixed(1));
      await publish({ ideas, placed: ideas.filter((x) => !x.placing).length });
    }
    await publish({ running: false, stage: 'ready' });

    // What there is at each idea is gathered now, in the background and in
    // order, so opening one is a read rather than a search (owner, 3 Sep 2026).
    for (const idea of fresh) {
      if (!idea.place) continue;
      try { await thingsAround({ household, session, place: idea.place }); } catch { /* the tap will try again */ }
    }
  } catch (err) {
    Object.assign(state, { running: false, stage: 'error', error: err?.message || String(err) });
    await saveSession(session.id, state, null);
  }
}

/**
 * Five more, on the same session (owner, 4 Sep 2026: "I shouldn't need to
 * refresh the list because you should be storing that data. I guess the option
 * should be 'Show me 5 more'"). The ones already given stay where they are and
 * are named to the model so it does not repeat itself. Body: { sessionId }.
 */
router.post('/inspire/more', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { sessionId, attendingMemberIds } = req.body || {};
    const session = await loadSession(sessionId);
    const state = session.state || {};
    if (state.kind !== 'inspire') return res.status(404).json({ error: 'session_not_found' });
    if (state.running) return res.json({ sessionId: session.id, ref: runRef(session.id), running: true, stage: state.stage ?? 'thinking' });
    const attending = Array.isArray(attendingMemberIds) && attendingMemberIds.length ? members.filter((m) => attendingMemberIds.includes(m.id)) : members;
    Object.assign(state, { running: true, stage: 'thinking', error: null, runStartedAt: new Date().toISOString() });
    await saveSession(session.id, state, null);
    res.json({ sessionId: session.id, ref: runRef(session.id), running: true, stage: 'thinking' });
    runInspire({ household, attending, session, state, append: true }).catch(() => { /* recorded on the session */ });
  } catch (err) {
    next(err);
  }
});

// The look around an idea: the same search a trip's Find tab runs at 5 km —
// the place sources, no event listings, no scout — so the two share one cache
// entry and the trip opens on what was already seen.
export const THINGS_RADIUS_KM = 5;
const placeSourceKeys = () => enabledSources().filter((src) => !src.events && src.key !== 'scout').map((src) => src.key);
const thingsSearch = (place) => ({ center: { lat: place.lat, lng: place.lng }, radiusKm: THINGS_RADIUS_KM, categories: [], query: '', includeEvents: false, sources: placeSourceKeys(), locality: place.locality ?? null });
export async function thingsAround({ household, session, place }) {
  const r = await searchCached(thingsSearch(place));
  if (r.fetched) await query('insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)', [household.id, session?.id ?? null, r.sourcesQueried.join('+') || 'none', 'plan.inspire.things', r.units]);
  return r;
}

/**
 * The venue a place name refers to, among what a search returned: the same
 * name, or one that contains it ("Thorpe Park" in "Thorpe Park Resort"), the
 * best reviewed of those, and nothing that is merely nearby.
 */
function bestNameMatch(venues, label, center) {
  const want = normName(label.split(',')[0]);
  if (want.length < 4) return null;
  const words = want.split(' ').filter((w) => w.length > 2);
  const hits = venues.filter((v) => {
    const n = normName(v.name);
    if (n === want || n.includes(want) || want.includes(n)) return true;
    // "Battersea Power Station" is listed by one source as "Battersea Power
    // Station Shopping Centre": every word of the name is there, in order or not.
    return words.length > 1 && words.every((w) => n.includes(w));
  });
  if (!hits.length) return null;
  const best = hits.sort((a, b) => (b.ratingCount ?? 0) - (a.ratingCount ?? 0))[0];
  return {
    venueRef: `${best.source}:${best.sourcePlaceId}`, name: best.name, category: best.category,
    rating: best.rating ?? null, ratingCount: best.ratingCount ?? null, priceLevel: best.priceLevel ?? null,
    photos: (best.photos ?? []).slice(0, 1), distanceKm: Number(kmBetween(center, best).toFixed(1)),
    summary: best.summary ?? null, attribution: best.attributionText ?? best.attribution ?? null,
  };
}

/** What there is to do, eat and see around an idea — the ordinary place search, cached, no model call. */
router.get('/inspire/things', async (req, res, next) => {
  try {
    const started = Date.now();
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat_lng_required' });
    const center = { lat, lng };
    const { venues, cached } = await thingsAround({ household, session: null, place: { lat, lng, locality: req.query.locality ?? null } });
    // No taste ranking here (it takes seconds over hundreds of venues): this list
    // says what is there; the trip's Find tab is where it is browsed and judged.
    const kindOf = (c) => (['restaurant', 'cafe', 'pub', 'bar'].includes(c.category) ? 'eat' : ['attraction', 'event', 'activity'].includes(c.category) ? 'do' : 'see');
    const weight = (c) => (c.rating ?? 0) * Math.log10((c.ratingCount ?? 0) + 2);
    const sorted = [...venues].sort((a, b) => weight(b) - weight(a));
    const items = sorted.map((c) => ({
      venueRef: `${c.source}:${c.sourcePlaceId}`, name: c.name, category: c.category, kind: kindOf(c), experiences: c.experiences ?? [],
      rating: c.rating ?? null, ratingCount: c.ratingCount ?? null, priceLevel: c.priceLevel ?? null,
      photos: (c.photos ?? []).slice(0, 1),
      distanceKm: Number(kmBetween(center, c).toFixed(1)), lat: c.lat, lng: c.lng, reasons: [],
    }));

    // The place itself, not only what is around it (owner, 4 Sep 2026: "no
    // stars, no colour, and no little image to show you what this place is").
    // The look-around has usually already returned it — Thorpe Park is the
    // biggest thing within five kilometres of Thorpe Park — so it is looked for
    // there first and only asked for by name when it is not.
    const label = String(req.query.label || '').trim();
    let headline = label ? bestNameMatch(sorted, label, center) : null;
    if (!headline && label && sourceHasKey('google') && !sourceOff('google')) {
      try {
        const r = await searchCached({ center, radiusKm: 8, categories: [], query: label, includeEvents: false, sources: ['google'] });
        if (r.fetched) await query('insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)', [household.id, null, 'google', 'plan.inspire.headline', r.units]);
        headline = bestNameMatch(r.venues || [], label, center);
      } catch { /* the idea does fine without a picture */ }
    }
    res.json({ items, headline, label: req.query.label ?? null, cached, tookMs: Date.now() - started });
  } catch (err) {
    next(err);
  }
});

// The places an idea names, found among what is around it and in the atlas,
// go on the new trip's shortlist as must-dos ("St James's Park", "Circolo
// Popolare"); a shorter name inside a longer one ("Tate" in "Tate Modern")
// means the longer.
export async function seedShortlistFromIdea({ household, session, trip, idea }) {
  const lines = [idea.title, ...(idea.do || []), ...(idea.eat || [])];
  const text = ` ${lines.map(normName).join(' . ')} `;
  const { venues } = searchKept(thingsSearch(idea.place)) ?? await thingsAround({ household, session, place: idea.place });
  const { rows: atlas } = await query('select venue_ref, label, kind, category, lat, lng, venue from household_places where household_id = $1 and lat is not null and lng is not null', [household.id]);
  const candidates = [
    ...venues.map((v) => ({ venueRef: `${v.source}:${v.sourcePlaceId}`, venueLabel: v.name, kind: null, category: v.category, lat: v.lat, lng: v.lng, venue: v, weight: v.ratingCount ?? 0 })),
    ...atlas.filter((p) => kmBetween(p, idea.place) <= THINGS_RADIUS_KM + 1).map((p) => ({ venueRef: p.venue_ref, venueLabel: p.label, kind: p.kind, category: p.category, lat: p.lat, lng: p.lng, venue: p.venue, weight: Number.MAX_SAFE_INTEGER })),
  ];
  const matched = new Map();
  for (const c of candidates) {
    const n = normName(c.venueLabel);
    if (n.length < 4 || !text.includes(` ${n} `)) continue;
    const cur = matched.get(n);
    if (!cur || c.weight > cur.weight) matched.set(n, c);
  }
  const names = [...matched.keys()];
  const seeded = [];
  const seededNorm = [];
  for (const n of names) {
    if (names.some((o) => o !== n && o.includes(n))) continue;
    const c = matched.get(n);
    const line = lines.slice(1).find((l) => normName(l).includes(n)) ?? null;
    await addShortlistItem(trip, household, { ...c, note: line ? `Roam suggested: ${line}` : 'Roam suggested it', mustDo: true, suggested: true });
    seeded.push(c.venueLabel);
    seededNorm.push(n);
  }
  // A named place the look-around did not return (a park the sources list
  // poorly) is put on the map by name: the capitalised phrases of each line,
  // two words or more, geocoded close to the place — nothing approximate.
  // The map answers one name a second, so at most three are looked up, the
  // ones the title names first.
  const phrases = new Set();
  for (const l of lines) for (const m of String(l).matchAll(/\b([A-Z][\w'’.]*(?:\s+(?:of|the|and|de|du|la|le|[A-Z][\w'’.]*))+)/g)) phrases.add(m[1].replace(/^(The|At|In)\s+/, '').trim());
  let lookedUp = 0;
  for (const phrase of phrases) {
    const n = normName(phrase);
    if (lookedUp >= 3 || n.split(' ').length < 2 || seededNorm.some((s) => s.includes(n) || n.includes(s))) continue;
    lookedUp += 1;
    try {
      const [hit] = await geocode(`${phrase}, ${idea.place.locality || idea.place.label}`, { limit: 1, near: idea.place, countryCode: idea.place.countryCode ?? null, within: true });
      if (!hit || hit.approximate || kmBetween(hit, idea.place) > THINGS_RADIUS_KM * 2) continue;
      const hitNorm = normName(hit.name || hit.label.split(',')[0]);
      if (!hitNorm.includes(n) && !n.includes(hitNorm)) continue;
      const label = hit.name || phrase;
      const line = lines.slice(1).find((l) => normName(l).includes(n)) ?? null;
      await addShortlistItem(trip, household, { venueRef: `${hit.source}:${hit.sourcePlaceId}`, venueLabel: label, kind: 'activity', category: 'attraction', lat: hit.lat, lng: hit.lng, note: line ? `Roam suggested: ${line}` : 'Roam suggested it', mustDo: true, suggested: true });
      seeded.push(label);
      seededNorm.push(hitNorm);
    } catch { /* not on the map: it stays in the idea's words */ }
  }
  return seeded;
}

// Declared after the literal /inspire/… paths on purpose: Express matches in
// order, and a ':sessionId' pattern above them swallows /inspire/things — which
// is why the look-around had been failing since it was written (owner, 4 Sep
// 2026: "Couldn't look around it just now… what on earth is that supposed to
// mean?").
/** Where Inspire me has got to: running, or the ideas, or what went wrong. A run lost to a restart reports so after three minutes. */
router.get('/inspire/:sessionId', async (req, res, next) => {
  try {
    const session = await loadSession(req.params.sessionId);
    const s = session.state || {};
    if (s.kind !== 'inspire') return res.status(404).json({ error: 'session_not_found' });
    const stale = s.running && s.runStartedAt && Date.now() - new Date(s.runStartedAt).getTime() > 3 * 60_000;
    // A run whose process went away mid-thought leaves no ideas and no error.
    // That is not "nothing came to mind"; it is a run that never finished.
    const interrupted = !s.running && !s.error && !(s.ideas || []).length;
    res.json({
      sessionId: session.id, ref: runRef(session.id),
      running: Boolean(s.running) && !stale,
      ideas: s.ideas ?? null, reply: s.reply ?? null, budget: s.input?.budget ?? 'any',
      stage: stale ? 'error' : s.stage ?? null, placed: s.placed ?? 0,
      startedAt: s.runStartedAt ?? null,
      error: stale || interrupted ? 'That run was interrupted before it finished — tap Inspire me again.' : s.error ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Things to do and see (owner, 3 Sep 2026): an idea opens as a day out in
 * Trips — home to the place and back, what Roam named already on the
 * shortlist, the Find tab showing everything around it from the same look
 * the ideas took. Body: { sessionId, ideaId, attendingMemberIds? }.
 */
router.post('/inspire/trip', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { sessionId, ideaId, attendingMemberIds } = req.body || {};
    const session = await loadSession(sessionId);
    const state = session.state || {};
    const idea = (state.ideas || []).find((i) => i.id === ideaId);
    if (!idea) return res.status(404).json({ error: 'idea_not_found', message: 'That idea is no longer on this session — ask for ideas again.' });
    if (!idea.place) return res.status(400).json({ error: 'idea_unpinned', message: "Roam couldn't pin this one on the map, so there is no day to open — Plan this still works from the idea itself." });
    if (household.home_lat == null) return res.status(400).json({ error: 'home_required', message: 'Set a home address in Settings first.' });
    // Tapped twice: the same day opens again, nothing is duplicated.
    if (idea.tripId) {
      const { rows } = await query('select id, title, start_date from trips where id = $1 and household_id = $2', [idea.tripId, household.id]);
      if (rows[0]) return res.json({ tripId: rows[0].id, title: rows[0].title, date: rows[0].start_date, seeded: idea.seeded ?? [], reply: `${rows[0].title} is already set up — opening it.`, existing: true });
    }
    const home = { label: household.home_label, lat: household.home_lat, lng: household.home_lng, how: 'home' };
    const attending = Array.isArray(attendingMemberIds) && attendingMemberIds.length ? members.filter((m) => attendingMemberIds.includes(m.id)) : members;
    const tz = household.timezone || DEFAULT_TZ;
    // Today while the morning lasts, otherwise tomorrow; the date is changed on the trip.
    const now = wallClock(new Date(), tz);
    const date = now.hhmm < '11:00' ? now.dateStr : addDays(now.dateStr, 1);
    const city = idea.place.locality || String(idea.place.label).split(',')[0].trim();
    const title = new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(idea.title) ? idea.title : `${city} · ${idea.title}`;
    const intent = { date, duration_minutes: 600, travel_mode: 'driving', intensity: null, anchor: null, depart_time: null, attending: attending.map((m) => m.name), wants: idea.do || [] };
    const { trip } = await createTripFromIntent({ household, members, intent, origin: home, destination: idea.place, anchorPlace: null, title });
    const seeded = await seedShortlistFromIdea({ household, session, trip, idea });
    idea.tripId = trip.id;
    idea.seeded = seeded;
    await saveSession(session.id, state, trip.id);
    const reply = `${title} set up for ${dayWords(date)}${seeded.length ? `, with ${seeded.join(', ')} on the shortlist` : ''}. Opening it in Trips.`;
    res.status(201).json({ tripId: trip.id, title, date, seeded, reply, existing: false });
  } catch (err) {
    next(err);
  }
});

/**
 * The place search behind the To row: the same ranking as a spoken name (a
 * town or venue with that name first, same-name hits merged, roads last and
 * labelled), each with a rough drive from home. GET /api/plan/places?q=
 */
router.get('/places', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ places: [] });
    const home = household.home_lat != null ? { lat: household.home_lat, lng: household.home_lng } : null;
    const r = await resolveSpokenPlace(q, household, { all: true });
    const list = r.place ? [{ label: r.place.label, say: r.place.label, kind: 'home', place: r.place }] : (r.choices || []);
    const places = list.map((c) => ({
      label: c.place.label, where: c.say.replace(c.place.label, '').replace(/^,\s*/, '') || '', kind: c.kind || 'place',
      isRoad: ['road', 'river'].includes(c.kind), travelMinutes: home && c.place.lat != null ? (() => { const m = estimateTravelMinutes(home, c.place, 'driving'); return m <= 12 * 60 ? m : null; })() : null,
      place: { label: c.place.label, lat: c.place.lat, lng: c.place.lng, locality: c.place.locality ?? null, country: c.place.country ?? null, countryCode: c.place.countryCode ?? null },
    }));
    res.json({ places });
  } catch (err) {
    next(err);
  }
});

// A restart (a deploy lands every few minutes while several sessions work)
// kills any run in flight. Say so at once rather than after five minutes, and
// the screen retries Plan it by itself.
query(`update plan_sessions set state = state || '{"running": false, "outcome": {"kind": "error", "message": "the plan was interrupted by a restart"}}'::jsonb where state->>'running' = 'true'`)
  .then((r) => { if (r.rowCount) console.log(`plan: ${r.rowCount} run(s) marked interrupted by the restart`); })
  .catch(() => { /* nothing to tidy */ });

/** Plan it: run the plan for what the rows say. Body: { sessionId } */
router.post('/go', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'session_required' });
    const session = await loadSession(sessionId);
    const state = session.state;
    if (!state.intent) return res.status(409).json({ error: 'nothing_to_plan', message: 'Say where and when first.' });
    if (state.checks?.length) return res.json({ sessionId: session.id, reply: `Still to check: ${state.checks[0].text}`, rows: state.rows ?? [], checks: state.checks, answered: state.answered ?? [], ready: false, intent: state.intent, options: [] });
    if (state.running) return res.json({ sessionId: session.id, running: true, reply: 'Still working on it.', rows: state.rows ?? [], checks: [], answered: state.answered ?? [], ready: true, intent: state.intent, options: [] });
    // The same day, asked for again: the places were found once and are still
    // here (owner, 4 Sep 2026). Only what changes the shape of the day is
    // applied, and no source is asked anything.
    if (state.pool?.length && session.trip_id && state.retrievalKey && state.retrievalKey === retrievalKey(state)) {
      await recomposeFromIntent(session, household);
      // Plan it makes a planned day and opens it in Trips, so asking again for
      // the same day settles it again from the places already found and opens
      // the same trip — never a second look at the sources.
      if (state.outcome?.kind === 'handoff' && state.outcome.handoff?.tripId === session.trip_id) {
        const { options } = await recompose(session, household);
        const first = options[0] ?? null;
        const filled = first ? (await commitOption({ household, session, optionId: first.id })).stops.map((x) => x.name) : [];
        const title = state.outcome.handoff.title || 'The day';
        const reply = filled.length
          ? `Same ${state.pool.length} places, nothing new looked up — ${title} is ${filled.join(', ')}. Opening it in Trips.`
          : `Same ${state.pool.length} places, nothing new looked up. Opening ${title} in Trips.`;
        state.outcome = { kind: 'handoff', reply, handoff: { ...state.outcome.handoff, section: filled.length ? 'day' : 'shortlist' } };
        state.transcript.push({ role: 'assistant', text: reply });
        await saveSession(session.id, state, null);
        return res.json({ sessionId: session.id, reply, handoff: state.outcome.handoff, rows: state.rows ?? [], checks: [], answered: state.answered ?? [], ready: true, intent: state.intent, options: [], reused: true });
      }
      await saveSession(session.id, state, null);
      return respond(res, {
        session, household,
        reply: `Same day, same ${state.pool.length} places — nothing new to look up.`,
        extra: { intent: state.intent, attending: state.attending ?? [], anchor: state.anchor ?? null, date: state.date ?? null, reused: true },
      });
    }
    return startRun({ household, members, session, state, res });
  } catch (err) {
    next(err);
  }
});

/**
 * Rows while the household is still talking: the words so far are read by a
 * quicker model and shown in their slots; nothing is saved but the session.
 * Body: { utterance, sessionId? }
 */
router.post('/preview', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { utterance, sessionId } = req.body || {};
    if (!utterance?.trim()) return res.status(400).json({ error: 'utterance_required' });
    let session = null;
    if (sessionId) { try { session = await loadSession(sessionId); } catch { session = null; } }
    if (!session) {
      const { rows } = await query('insert into plan_sessions (household_id, state) values ($1, $2) returning *', [household.id, JSON.stringify({ transcript: [] })]);
      session = rows[0];
    }
    const state = session.state;
    const prior = state.intent ? `Earlier in this conversation the user said: ${JSON.stringify(state.intent)}` : '';
    const intent = normaliseIntent(await parseStructured({
      system: INTERPRET_SYSTEM,
      messages: [{ role: 'user', content: `${JSON.stringify(householdContext(household, members))}\n\n${prior}\n\nThe user is still talking; this is what they have said so far: "${utterance}"` }],
      schema: TripIntent,
      householdId: household.id,
      sessionId: session.id,
      purpose: 'plan.preview',
      effort: 'low',
      model: PREVIEW_MODEL,
      thinking: 'off',
    }));
    const merged = mergeIntent(state.intent, intent);
    if (!merged.origin && household.home_lat != null) merged.origin = 'home';
    if (!merged.attending?.length && merged.attending_everyone == null) merged.attending_everyone = true;
    const overnight = (Number(merged.nights) || 0) >= 1 || Boolean(merged.end_date && merged.date && merged.end_date > merged.date);
    const places = {
      origin: merged.origin ? (HOME_WORDS.test(merged.origin.trim()) ? { label: 'Home', how: 'home' } : { label: merged.origin }) : null,
      destination: merged.destination ? { label: merged.destination } : null,
    };
    res.json({ sessionId: session.id, rows: rowsFor({ merged, places, checks: [], overnight, members }) });
  } catch (err) {
    next(err);
  }
});

/** Everything after the rows are settled: a night away becomes a trip, a day out gets its pool. */
async function executePlan({ household, members, session, state, res }) {
    const merged = state.intent;
    const { origin, destination, anchorPlace } = state.places || {};
    const overnight = (Number(merged.nights) || 0) >= 1 || Boolean(merged.end_date && merged.date && merged.end_date > merged.date);
    const pickedSources = state.sources ?? null;
    if (overnight && (state.stayDecision ?? 'day') === 'trip') {
      const where = destination ?? origin;
      const trip = await createStayFromIntent({ household, members, intent: merged, destination: where });
      // What was asked for goes with the trip: named places on the shortlist as
      // must-dos, meals and activities as the day's minimums, and every day
      // planned from one pool so the trip opens with places to choose from.
      const wants = merged.wants || [];
      const seeded = await seedShortlistFromWants({ trip, destination: where, wants });
      const foodWants = wants.filter((w) => FOOD_WORDS.test(w)).length;
      const minFood = Math.min(3, Math.max(merged.min_food_stops ?? 0, foodWants, 1));
      const minActivities = Math.min(3, seeded.length + (merged.min_activities ?? 1));
      const { rows: days } = await query('select * from trip_days where trip_id = $1 order by date', [trip.id]);
      let pool = null;
      let found = 0;
      const filled = [];
      for (const [i, d] of days.entries()) {
        try {
          const r = await planDayForTrip({ household, tripId: trip.id, dayId: d.id, minActivities, minFood, wants, pool });
          pool = pool ?? r.pool;
          found = r.session.state.pool.length;
          // Every full day is filled with the first plan so the trip opens with
          // stops, not a search box; the arrival day is left open (when they get
          // there was not said) with the same places ready to add.
          if (i > 0) {
            const { options } = await recompose(r.session, household);
            if (options[0]) { const opt = await commitOption({ household, session: r.session, optionId: options[0].id }); filled.push({ date: d.date, stops: opt.stops.map((x) => x.name) }); }
          }
        } catch { /* the trip stands; that day can be planned from Trips */ }
      }
      const city = where.locality || where.label;
      const reply = [
        `Set up ${trip.title}, ${dayWords(trip.startDate)} to ${dayWords(trip.endDate)}.`,
        seeded.length ? `${seeded.map((x) => x.label).join(', ')} on the shortlist as a must.` : '',
        ...filled.map((f) => `${dayWords(f.date)}: ${f.stops.join(', ')}.`),
        found ? `${dayWords(days[0].date)} is left open for when you arrive, with the same places near ${city} ready to add.` : '',
        'Opening it in Trips.',
      ].filter(Boolean).join(' ');
      state.transcript.push({ role: 'assistant', text: reply });
      await saveSession(session.id, state, trip.id);
      return { kind: 'handoff', reply, handoff: { tripId: trip.id, title: trip.title, section: 'day' } };
    }

    // Planning the same session somewhere else replaces the outing it made
    // last time rather than leaving an empty one behind — but only while
    // nothing has been done with it.
    if (session.trip_id) {
      await query(
        `delete from trips t where t.id = $1
           and not exists (select 1 from trip_stops s where s.trip_id = t.id)
           and not exists (select 1 from trip_shortlist l where l.trip_id = t.id)
           and not exists (select 1 from visits v where v.trip_id = t.id)`,
        [session.trip_id],
      ).catch(() => null);
    }
    const { trip, attending } = await createTripFromIntent({ household, members, intent: merged, origin, destination, anchorPlace, sources: pickedSources });
    const attendees = toAttendees(attending);
    // Plan the day where it happens: the pool is what's around the base, and
    // the journey there is reported separately rather than eating the window.
    const dayTrip = dayAsTrip(trip, trip.day);
    // The road and the destination are looked at together: the journey and what
    // is worth stopping for on it are their own retrieval, and waiting for one
    // after the other would make every plan slower to arrive.
    const roadside = journeyWithStops({
      household, trip, dayTrip, attendees, sessionId: session.id,
      sources: pickedSources, includeChains: merged.avoid_chains === false,
    });
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
      // One show is enough for one day: don't propose another of the same kind.
      const kind = merged.anchor.kind;
      for (const c of pool.candidates) {
        if (!c.fixed && (c.experiences || []).includes(kind)) { c.score -= 25; c.reasons = [...(c.reasons || []), { kind: 'note', text: `Another ${kind} on the same day as ${merged.anchor.name}` }]; }
      }
      pool.candidates.sort((a, b) => b.score - a.score);
    }
    state.dayId = trip.day.id;
    state.date = trip.day.date;
    state.anchor = merged.anchor && anchorPlace ? { ...merged.anchor, place: anchorPlace } : null;
    const { journey, route } = await roadside;
    state.journey = journey;
    state.route = route;
    // Whatever is proposed on the way is time not spent at the destination, so
    // the day is shortened before any option is composed for it.
    session.state = state;
    await applyRouteToDay(session);
    state.pool = pool.candidates;
    // What this pool was fetched for, so pressing Plan it again on the same day
    // composes it afresh instead of asking every source the same question.
    state.retrievalKey = retrievalKey(state);
    state.excludedByAllergen = pool.excluded.map((e) => ({ name: e.name, reasons: e.exclusionReasons }));
    // Must-haves come from the time left once a fixed commitment is placed:
    // a 2½-hour show in a 5½-hour window leaves room for lunch and one thing,
    // not two things and no lunch. A named want counts as a thing to do.
    const windowMin = Math.round((new Date(dayTrip.return_at) - new Date(dayTrip.depart_at)) / 60_000);
    const spare = windowMin - (merged.anchor ? (merged.anchor.duration_minutes ?? 120) : 0);
    const packedness = { relaxed: 0.8, balanced: 1, packed: 1.25 }[trip.intensity] ?? 1;
    const activitiesThatFit = Math.max(0, Math.min(3, Math.floor(((spare - 75) / 110) * packedness)));
    const namedWants = (merged.wants || []).filter(isNamedPlace).length;
    const foodLines = eatLines(merged.wants || []).length;
    const wantsToEat = merged.min_food_stops != null ? merged.min_food_stops : Math.max(foodLines, spare >= 90 ? 1 : 0);
    state.minActivities = merged.min_activities != null ? Math.min(3, merged.min_activities + namedWants) : Math.max(namedWants, Math.min(activitiesThatFit, merged.anchor ? 1 : 2));
    state.minFood = Math.min(3, wantsToEat);
    state.pinned = state.anchor ? [pool.candidates[0].key] : [];
    // A named want that is in the pool is pinned: the day is built around it.
    for (const w of (merged.wants || []).filter(isNamedPlace)) {
      const want = normName(w.replace(/^(the|a|an)\s+/i, ''));
      const hit = pool.candidates.find((c) => normName(c.name) === want || normName(c.name).includes(want));
      if (hit && !state.pinned.includes(hit.key)) { state.pinned.push(hit.key); hit.score += 40; hit.reasons = [...(hit.reasons || []), { kind: 'want', text: 'You asked for it' }]; }
    }
    state.excluded = [];
    // No chains unless asked for; "somewhere special" means upmarket.
    state.includeChains = merged.avoid_chains === false;
    // A budget in pounds stands in for a price point when none was said: per head, per day.
    const heads = Math.max(1, attendees.length);
    const perHead = merged.budget_high ? (merged.budget_per === 'person' ? merged.budget_high : merged.budget_high / heads) : null;
    const fromBudget = perHead == null ? null : perHead < 25 ? 'affordable' : perHead < 60 ? 'mid' : 'upmarket';
    state.pricePoint = merged.price_point ?? fromBudget ?? (merged.special ? 'upmarket' : 'any');
    state.chosenOptionId = null;
    state.suggestedPreferences = [];
    state.attending = attendees.map((a) => ({ id: a.id, name: a.name }));
    state.attendeePrefs = attendees;
    await saveSession(session.id, state, trip.id);
    session.state = state;
    session.trip_id = trip.id;

    // Plan it means a planned day (owner, 4 Sep 2026): the first plan is written
    // onto the day, its stops and the next best go on the shortlist, and the trip
    // opens in Trips on The day — no second Plan it there.
    const { options } = await recompose(session, household);
    const first = options[0] ?? null;
    let filled = [];
    if (first) {
      const opt = await commitOption({ household, session, optionId: first.id });
      filled = opt.stops.map((x) => x.name);
    }
    const kindOf = (cat) => (['restaurant', 'cafe', 'pub', 'bar'].includes(cat) ? 'food' : ['attraction', 'event'].includes(cat) ? 'activity' : 'other');
    const onList = new Set();
    const shortlist = async (c, mustDo) => {
      const ref = c.key || `${c.source}:${c.sourcePlaceId}`;
      if (onList.has(ref) || String(ref).startsWith('anchor:')) return;
      onList.add(ref);
      await query(
        `insert into trip_shortlist (trip_id, venue_ref, venue_label, kind, category, lat, lng, must_do)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (trip_id, venue_ref) do nothing`,
        [trip.id, ref, c.name, kindOf(c.category), c.category ?? null, c.lat ?? null, c.lng ?? null, mustDo],
      );
    };
    for (const st of first?.stops ?? []) { const c = pool.candidates.find((x) => x.key === st.id || `${x.source}:${x.sourcePlaceId}` === st.venueRef); if (c) await shortlist(c, state.pinned.includes(c.key)); }
    for (const c of pool.candidates) { if (onList.size >= 12) break; if (!c.fixed) await shortlist(c, false); }
    const reply = filled.length
      ? `${trip.title || trip.base_label} is set up for ${dayWords(trip.day.date)}: ${filled.join(', ')}. ${onList.size} places on the shortlist to swap in. Opening it in Trips.`
      : `${trip.title || trip.base_label} is set up for ${dayWords(trip.day.date)}, with ${onList.size} places on the shortlist — nothing fitted the window yet. Opening it in Trips.`;
    state.transcript.push({ role: 'assistant', text: reply });
    await saveSession(session.id, state, trip.id);
    return { kind: 'handoff', reply, handoff: { tripId: trip.id, title: trip.title || trip.base_label, section: filled.length ? 'day' : 'shortlist' } };
}

/**
 * What a retrieval actually depends on: where the day starts and happens, when
 * it is, and which sources may be asked. Everything else the household can
 * change — how long, how full, who is coming, how much to spend, how many
 * things to do — only changes how the same pool is composed.
 */
function retrievalKey(state) {
  const { origin, destination, anchorPlace } = state.places || {};
  const at = (p) => (p?.lat == null ? '' : `${Number(p.lat).toFixed(3)},${Number(p.lng).toFixed(3)}`);
  return [at(origin), at(anchorPlace ?? destination ?? origin), state.intent?.date ?? '', (state.sources ?? []).join(',')].join('|');
}

/**
 * How long the day is, as asked for. The day starts when it always did; only
 * its end moves. Whatever is being stopped for on the way is then taken off
 * each end again, so the window the options are composed for is the time
 * actually at the destination.
 */
async function setDayLength(session, minutes) {
  const state = session.state;
  const { trip } = await sessionTrip(session);
  const tz = trip.timezone || DEFAULT_TZ;
  const applied = state.route?.applied ?? { out: 0, back: 0 };
  const baseStart = state.route?.windowStart ?? trip.depart_at;
  const baseEnd = new Date(new Date(baseStart).getTime() + minutes * 60_000).toISOString();
  const start = new Date(new Date(baseStart).getTime() + applied.out * 60_000);
  const end = new Date(new Date(baseEnd).getTime() - applied.back * 60_000);
  await query('update trip_days set start_time = $2::time, end_time = $3::time where id = $1', [state.dayId, wallClock(start, tz).hhmm, wallClock(end, tz).hhmm]);
  if (state.route) { state.route.windowStart = baseStart; state.route.windowEnd = baseEnd; }
}

/**
 * The household changed the shape of the day and pressed Plan it again. None of
 * this needs a provider: the pool already found is composed differently.
 */
async function recomposeFromIntent(session, household) {
  const state = session.state;
  const intent = state.intent || {};
  if (intent.min_activities != null) state.minActivities = Math.min(3, Number(intent.min_activities));
  if (intent.min_food_stops != null) state.minFood = Math.min(3, Number(intent.min_food_stops));
  if (intent.price_point) state.pricePoint = intent.price_point;
  else if (intent.special) state.pricePoint = 'upmarket';
  if (intent.avoid_chains != null) state.includeChains = intent.avoid_chains === false;
  const duration = intent.duration_minutes != null ? Math.min(720, Math.max(60, Number(intent.duration_minutes))) : null;
  const mode = intent.travel_mode && TRAVEL_MODES.includes(intent.travel_mode) ? intent.travel_mode : null;
  const intensity = intent.intensity && INTENSITY_TARGETS[intent.intensity] ? intent.intensity : null;
  if (mode || intensity) await applyTripChanges(session, { durationMinutes: null, intensity, travelMode: mode });
  // The hours the household asked for are the hours of the day itself, before
  // anything on the way is taken out of it. Setting the day's end from its own
  // (already shortened) start would pay for the same stop twice.
  if (duration != null && state.dayId) await setDayLength(session, duration);
  if (intent.attending?.length || intent.attending_everyone) {
    const members = await loadMembers(household.id);
    const named = new Set((intent.attending || []).map((n) => n.toLowerCase()));
    const chosen = intent.attending_everyone || !named.size ? members : members.filter((m) => named.has(m.name.toLowerCase()));
    const attendees = toAttendees(chosen.length ? chosen : members);
    state.attending = attendees.map((a) => ({ id: a.id, name: a.name }));
    state.attendeePrefs = attendees;
  }
}

/**
 * Plan it runs in the background: the request returns at once with
 * `running: true`, the screen polls GET /api/plan/:sessionId, and the outcome
 * (a trip to open, or the day's pool) is kept on the session — so a slow
 * search, a redeploy or a closed tab never loses the plan.
 */
async function startRun({ household, members, session, state, res }) {
  state.running = true;
  state.outcome = null;
  state.runStartedAt = new Date().toISOString();
  await saveSession(session.id, state, null);
  res.json({ sessionId: session.id, running: true, reply: 'Working on it — this takes a minute or two.', rows: state.rows ?? [], checks: [], answered: state.answered ?? [], ready: true, intent: state.intent, options: [] });
  executePlan({ household, members, session, state, res: null })
    .then((outcome) => { state.running = false; state.outcome = outcome.kind === 'handoff' ? { kind: 'handoff', reply: outcome.reply, handoff: outcome.handoff } : { kind: 'pool', reply: outcome.reply, extra: outcome.extra }; })
    .catch((err) => { state.running = false; state.outcome = { kind: 'error', message: err?.message || String(err) }; })
    .then(() => saveSession(session.id, state, session.trip_id ?? null))
    .catch(() => { /* the poll will time out and say so */ });
}

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
    const route = routeView(state);
    const closedSet = options.map((o) => ({
      option_id: o.id,
      title: o.title,
      stops: o.stops.map((s) => ({ id: s.id, name: s.name, category: s.category })),
    }));
    // What is on the way is on screen too, so "stop at the castle on the way"
    // is one of the things they can say (Epic 5 C7: the set is what they see).
    if (route?.stops?.length) {
      closedSet.push({
        option_id: 'on-the-way',
        title: `On the way between ${route.from} and ${route.to}`,
        stops: route.stops.map((s) => ({ id: s.id, name: s.name, category: s.category, leg: s.leg === 'back' ? 'on the way home' : 'on the way there', in_the_plan: s.chosen })),
      });
    }
    const routeIds = new Set((route?.stops || []).map((s) => s.id));
    const validStopIds = new Set([...options.flatMap((o) => o.stops.map((s) => s.id)), ...routeIds]);
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
    // A stop on the way joins or leaves the journey; it is never pinned to the
    // day at the destination, which is a different piece of the plan.
    if (state.route && routeIds.size) {
      const added = liked.filter((id) => routeIds.has(id));
      const dropped = new Set(disliked.filter((id) => routeIds.has(id)));
      state.route.picked = [...new Set([...(state.route.picked || []), ...added])].filter((id) => !dropped.has(id));
    }
    const likedHere = liked.filter((id) => !routeIds.has(id));
    const dislikedHere = disliked.filter((id) => !routeIds.has(id));
    state.pinned = [...new Set([...state.pinned.filter((k) => !dislikedHere.includes(k)), ...likedHere])];
    state.excluded = [...new Set([...state.excluded, ...dislikedHere, ...replacements.map((r) => r.stop_id)])];
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
    // Last, so the day is shortened for what is being stopped for on the way
    // whatever else the same sentence changed.
    session.state = state;
    await syncRouteWindow(session);
    await applyRouteToDay(session);

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
      // A stop on the way in or out of the plan. The day at the destination is
      // untouched: the journey grows at its ends and the leaving time moves.
      case 'route_add':
        if (state.route) state.route.picked = [...new Set([...(state.route.picked || []), action.stopId])];
        await applyRouteToDay(session);
        break;
      case 'route_drop':
        if (state.route) state.route.picked = (state.route.picked || []).filter((k) => k !== action.stopId);
        await applyRouteToDay(session);
        break;
      case 'set':
        if (action.minActivities != null) state.minActivities = Number(action.minActivities);
        if (action.minFood != null) state.minFood = Number(action.minFood);
        if (action.includeChains != null) state.includeChains = Boolean(action.includeChains);
        if (action.pricePoint && PRICE_POINTS.includes(action.pricePoint)) state.pricePoint = action.pricePoint;
        if (Array.isArray(action.attendingMemberIds)) {
          // Who's coming changes whose tastes rank; allergen exclusions were applied when the pool was fetched.
          const members = await loadMembers(household.id);
          const chosen = members.filter((m) => action.attendingMemberIds.includes(m.id));
          const attendees = toAttendees(chosen.length ? chosen : members);
          state.attending = attendees.map((a) => ({ id: a.id, name: a.name }));
          state.attendeePrefs = attendees;
          await query('delete from trip_attendees where trip_id = $1', [session.trip_id]);
          for (const a of attendees) await query('insert into trip_attendees (trip_id, member_id) values ($1, $2) on conflict do nothing', [session.trip_id, a.id]);
        }
        await applyTripChanges(session, {
          intensity: action.intensity && INTENSITY_TARGETS[action.intensity] ? action.intensity : null,
          durationMinutes: action.durationMinutes != null ? Number(action.durationMinutes) : null,
          travelMode: action.travelMode && TRAVEL_MODES.includes(action.travelMode) ? action.travelMode : null,
        });
        // A day the household has just lengthened or shortened is the new day
        // the stops on the way are measured against.
        await syncRouteWindow(session);
        break;
      default:
        return res.status(400).json({ error: 'unknown_action' });
    }

    await saveSession(session.id, state, null);
    session.state = state;
    await respond(res, { session, household, reply: null, extra: { applied: action, attending: state.attending ?? [] } });
  } catch (err) {
    next(err);
  }
});

/** Make an option the active trip (Epic 5 C8). Body: { sessionId, optionId } */
/** Write an option onto its day (or the whole outing) as the plan. */
async function commitOption({ household, session, optionId }) {
    const { options, trip: sessTrip } = await recompose(session, household);
    const tzOf = sessTrip.timezone || DEFAULT_TZ;
    const option = options.find((o) => o.id === optionId);
    if (!option) { const err = new Error('option_not_found'); err.status = 404; err.code = 'option_not_found'; throw err; }

    const dayId = session.state.dayId ?? null;
    if (dayId) {
      // Replace the day's plan, keeping any stop already turned into a visit.
      await query('delete from trip_stops where day_id = $1 and not exists (select 1 from visits v where v.stop_id = trip_stops.id)', [dayId]);
    } else {
      await query('delete from trip_stops where trip_id = $1 and not exists (select 1 from visits v where v.stop_id = trip_stops.id)', [session.trip_id]);
    }
    // The day is what was chosen at the destination, with whatever was chosen
    // on the way in front of it and behind it, in the order they happen.
    const view = routeView(session.state);
    const onTheWay = (view?.stops || []).filter((s) => s.chosen && s.arriveAt);
    const byTime = (a, b) => new Date(a.arriveAt) - new Date(b.arriveAt);
    const plan = [
      ...onTheWay.filter((s) => s.leg === 'out').sort(byTime),
      ...option.stops,
      ...onTheWay.filter((s) => s.leg === 'back').sort(byTime),
    ];
    let position = 0;
    for (const stop of plan) {
      position += 1;
      await query(
        `insert into trip_stops (trip_id, day_id, slot, start_time, position, venue_ref, venue_name, lat, lng, dwell_minutes)
         values ($1,$2,$3,$4::time,$5,$6,$7,$8,$9,$10)`,
        [session.trip_id, dayId, stop.arriveAt ? slotFor(stop.arriveAt, tzOf) : 'morning', stop.arriveAt ? wallClock(stop.arriveAt, tzOf).hhmm : null,
         position, stop.venueRef, stop.name, stop.lat, stop.lng, stop.dwellMinutes],
      );
      await query(
        `insert into place_ledger (household_id, source, source_place_id, status)
         values ($1, split_part($2, ':', 1), split_part($2, ':', 2), 'saved')`,
        [household.id, stop.venueRef],
      );
    }
    // A stop on the way happens before the day at the destination starts (or
    // after it ends), so the day's own window stretches to hold it — otherwise
    // the trip would open reporting an over-run that is not real.
    if (dayId && onTheWay.length) {
      const firstOut = onTheWay.filter((s) => s.leg === 'out').map((s) => s.arriveAt).sort()[0] ?? null;
      const lastBack = onTheWay.filter((s) => s.leg === 'back').map((s) => s.leaveAt ?? s.arriveAt).sort().pop() ?? null;
      // least()/greatest() leave the day alone where there is nothing to stretch to.
      await query(
        `update trip_days set start_time = least(start_time, $2::time), end_time = greatest(end_time, $3::time) where id = $1`,
        [dayId, firstOut ? wallClock(firstOut, tzOf).hhmm : null, lastBack ? wallClock(lastBack, tzOf).hhmm : null],
      );
    }
    session.state.chosenOptionId = optionId;
    session.state.committed = true;
    await saveSession(session.id, session.state, null);
    // What was actually written: the option's stops plus whatever was chosen on the way.
    option.saved = plan.length;
    return option;
}

router.post('/commit', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { sessionId, optionId } = req.body || {};
    const session = await loadSession(sessionId);
    const option = await commitOption({ household, session, optionId });
    res.json({ tripId: session.trip_id, optionId, stops: option.saved ?? option.stops.length });
  } catch (err) {
    if (err.code === 'option_not_found') return res.status(404).json({ error: err.code });
    next(err);
  }
});

/**
 * POST /api/plan/day { tripId, dayId, minActivities?, minFood? }
 * Options for one day of a trip, composed from the trip's shortlist plus what
 * is near the base — no model call; react afterwards by voice (/refine) or tap (/act).
 */
/**
 * Plan one day of a trip: a fresh session with the pool (fetched once and
 * shared across a trip's days when `pool` is given), the shortlist boosted and
 * must-dos pinned. Returns the session and the pool it used.
 */
async function planDayForTrip({ household, tripId, dayId, minActivities, minFood, wants = [], pool: shared = null }) {
    const { rows: trips } = await query('select * from trips where id = $1 and household_id = $2', [tripId, household.id]);
    const { rows: days } = await query('select * from trip_days where id = $1 and trip_id = $2', [dayId, tripId]);
    if (!trips[0] || !days[0]) { const err = new Error('trip_or_day_not_found'); err.status = 404; err.code = 'trip_or_day_not_found'; throw err; }
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
    const pool = shared
      ? { ...shared, candidates: JSON.parse(JSON.stringify(shared.candidates)), excluded: [...shared.excluded] }
      : await retrievePool({ household, trip, attendees, intent: { wants, special: false }, sessionId: session.id });
    const { rows: shortlist } = await query('select * from trip_shortlist where trip_id = $1', [tripId]);
    const byRef = new Map(pool.candidates.map((c) => [`${c.source}:${c.sourcePlaceId}`, c]));
    const extra = [];
    const mustKeys = [];
    for (const item of shortlist) {
      const ref = item.venue_ref;
      let cand = byRef.get(ref);
      // The same place under another source's id (the geocoded Roman Baths and
      // the pool's own) is one place: match by name within a couple of streets.
      if (!cand && item.lat != null) {
        const wanted = normName(item.venue_label);
        cand = pool.candidates.find((c) => normName(c.name) === wanted && kmBetween(c, item) < 0.3) ?? null;
      }
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
      if (item.must_do) mustKeys.push(cand.key);
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
      date: days[0].date,
      pool: candidates,
      excludedByAllergen: pool.excluded.map((e) => ({ name: e.name, reasons: e.exclusionReasons })),
      minActivities: minActivities ?? defaults[0],
      minFood: minFood ?? defaults[1],
      pinned: [...new Set([...fixedStops.map((f) => f.key), ...mustKeys.filter((k) => candidates.some((c) => c.key === k))])],
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
    return { session, pool, day: days[0] };
}

router.post('/day', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { tripId, dayId, minActivities, minFood } = req.body || {};
    const { session, pool, day } = await planDayForTrip({ household, tripId, dayId, minActivities, minFood });
    await respond(res, { session, household, reply: null, extra: { dayId, date: day.date, attending: session.state.attending, reach: { maxTravelMinutes: pool.maxTravelMinutes, estimated: true }, degradedSources: pool.degraded } });
  } catch (err) {
    if (err.code === 'trip_or_day_not_found') return res.status(404).json({ error: err.code });
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
    const st = session.state;
    const base = { sessionId: session.id, intent: st.intent ?? null, options: [], transcript: st.transcript ?? [], rows: st.rows ?? null, checks: st.checks ?? [], answered: st.answered ?? [], ready: Boolean(st.ready), question: st.checks?.[0] ?? null };
    // A run lost to a restart never reports back: after five minutes say so instead of spinning.
    if (st.running && st.runStartedAt && Date.now() - new Date(st.runStartedAt).getTime() > 5 * 60_000) {
      st.running = false; st.outcome = { kind: 'error', message: 'the plan was interrupted' };
      await saveSession(session.id, st, null);
    }
    if (st.running) return res.json({ ...base, running: true, reply: null });
    if (st.outcome?.kind === 'handoff') return res.json({ ...base, reply: st.outcome.reply, handoff: st.outcome.handoff });
    if (st.outcome?.kind === 'error') return res.json({ ...base, reply: `That didn't work: ${st.outcome.message}. Try Plan it again.`, failed: true, interrupted: /interrupted/.test(st.outcome.message) });
    if (!st.pool) return res.json(base);
    await respond(res, { session, household, reply: st.outcome?.kind === 'pool' ? st.outcome.reply : null, extra: { transcript: st.transcript ?? [], intent: st.intent, ...(st.outcome?.kind === 'pool' ? st.outcome.extra : {}) } });
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

// The family's table: the best places for the food this family actually loves
// (owner, 4 Sep 2026 — "search for the best arrabbiata within my radius…
// how would that work if other people have favourite foods… present those
// choices, like 'Best arrabbiata' or 'Best steak'… because Phoenix loves this").
//
// Inspire me's ideas come from a model reading the atlas. This does not: it
// reads the household's own likes, turns each food into one search of the
// place sources, and ranks what comes back through the same constraints the
// planner uses. No model call, so a table lands in seconds.
//
// What is held where (Technical Constraints §5, §13.7): the tables are
// licensed place content, so they live in memory for a couple of hours and are
// never written to the session row. The session row exists only so every
// provider call is attributed to a household and a session.

import { Router } from 'express';
import { query } from '../db.js';
import { currentHousehold, loadMembers, toAttendees } from './household.js';
import { searchCached } from '../sources/cache.js';
import { defaultSourceKeys, sourceHasKey, sourceOff } from '../sources/index.js';
import { applyConstraints } from '../domain/ranking.js';
import { estimateTravelMinutes, kmBetween } from '../domain/travel.js';
import { routingEnabled, travelMatrixMinutes } from '../sources/routing.js';
import { foodTastes, likedConcepts, whyForUs, dishEvidence, driveRadiusKm, firstName } from '../domain/tastes.js';
import { checkMenu, menuCheckEnabled, menuCheckUsage } from '../sources/menu.js';
import { createTripFromIntent, seedShortlistFromIdea, thingsAround, THINGS_RADIUS_KM } from './plan.js';
import { addShortlistItem } from './trips.js';
import { reverseGeocode } from '../sources/geocode.js';
import { wallClock, DEFAULT_TZ } from '../domain/time.js';

const router = Router();

const FOOD_CATEGORIES = ['restaurant', 'cafe', 'pub', 'bar'];
const FOOD = new Set(FOOD_CATEGORIES);
// How many foods get their own table, and how many places each table shows.
const MAX_TABLES = Number(process.env.ROAM_TASTE_TABLES || 4);
const PLACES_PER_TABLE = 3;
// A cap of "anywhere" is still a day out: this is as far as one is worth driving.
const ANYWHERE_MINUTES = 180;
// How long one food may keep the screen waiting before it gives up its turn.
const TABLE_DEADLINE_MS = Number(process.env.ROAM_TASTE_DEADLINE_MS || 45_000);

// The tables themselves, in memory only, per session.
const RUNS = new Map();
const RUN_TTL_MS = 2 * 3600_000;
const RUN_MAX = 40;
function putRun(sessionId, run) {
  run.at = Date.now();
  RUNS.delete(sessionId);
  RUNS.set(sessionId, run);
  while (RUNS.size > RUN_MAX) RUNS.delete(RUNS.keys().next().value);
  return run;
}
function getRun(sessionId) {
  const run = RUNS.get(sessionId);
  if (!run) return null;
  if (Date.now() - run.at > RUN_TTL_MS) { RUNS.delete(sessionId); return null; }
  return run;
}

const addDays = (dateStr, n) => new Date(new Date(`${dateStr}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const dayWords = (dateStr) => new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const namesOf = (list) => list.map((l) => l.first || l.name).filter(Boolean).reduce((s, n, i, a) => (i === 0 ? n : i === a.length - 1 ? `${s} and ${n}` : `${s}, ${n}`), '');

/** What to ask the sources for this food. A dish is asked for as a person would ask. */
function queryFor(taste) {
  const label = taste.label.toLowerCase();
  return ['dish', 'ingredient'].includes(taste.kind) ? `best ${label}` : `best ${label} restaurant`;
}

/** How well the price of a place matches what they said the day should cost. */
function budgetFit(priceLevel, budget) {
  if (priceLevel == null || !budget || budget === 'any') return 0;
  const want = { free: 1, cheap: 1, mid: 2, treat: 4 }[budget];
  if (want == null) return 0;
  const off = Math.abs(priceLevel - want);
  return off === 0 ? 6 : off === 1 ? 2 : -6 * (off - 1);
}

// The reasons ranking.js produced, as lines a card can show, with the tone the
// style guide gives them: a warning red only for an allergen, never for a taste.
const REASON_TONE = { favourite: 'good', like: 'good', 'diet-ok': 'good', kids: 'good', 'learned-like': 'good', rating: 'fact', chain: 'fact', diet: 'warn', dislike: 'warn', note: 'warn', 'learned-dislike': 'warn', learning: 'fact' };
function fitLines(venue, attending) {
  const out = [];
  // The ranking layer writes each person's full name; on a card they are Roger,
  // Gina and Phoenix. The line also starts as a sentence does.
  const say = (text) => {
    let t = String(text);
    for (const m of attending) t = t.split(m.name).join(firstName(m.name));
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  for (const r of venue.reasons || []) {
    const tone = REASON_TONE[r.kind];
    if (!tone) continue;
    out.push({ tone, kind: r.kind, member: r.member ? firstName(r.member) : null, text: say(r.text) });
  }
  // Allergens are safety: no listing states ingredients, so the honest line is
  // that it cannot be checked from here (Requirements §5; menus are Epic 6).
  const withAllergens = attending.filter((m) => (m.allergens || []).length);
  for (const m of withAllergens) {
    const named = m.allergens.map((a) => a.value ?? a).join(', ');
    out.push({ tone: 'allergen', kind: 'allergen-unknown', member: firstName(m.name), text: `${named} — an allergen for ${firstName(m.name)} — is not something any listing states. Read the menu or ask when you book.` });
  }
  return out;
}

/** One food, and the best places for it within the cap. */
async function buildTable({ household, attending, attendees, session, taste, home, capMinutes, budget, sources, dishSearch, routing, meter }) {
  // Google's text search takes a dish by name and biases to a circle (50 km is
  // its widest). Without it there is no dish search at all, only the ordinary
  // nearby look, which must stay small or Overpass times out on a whole county.
  const radiusKm = Math.min(dishSearch ? 50 : 15, Math.max(2, driveRadiusKm(capMinutes)));
  const params = { center: home, radiusKm, categories: FOOD_CATEGORIES, query: queryFor(taste), includeEvents: false, sources };
  const r = await searchCached(params);
  if (r.fetched) {
    await query('insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)',
      [household.id, session?.id ?? null, r.sourcesQueried.join('+') || 'none', 'plan.tastes', r.units]);
  }

  const venues = (r.venues || [])
    .filter((v) => FOOD.has(v.category) && v.lat != null)
    .map((v) => ({ ...v, travelMinutes: estimateTravelMinutes(home, v, 'driving'), distanceKm: Number(kmBetween(home, v).toFixed(1)) }))
    // The estimate is rough, so the shortlist is generous; the real drive below decides.
    .filter((v) => v.travelMinutes <= capMinutes * 1.2);

  const { candidates, excluded } = applyConstraints({ venues, attendees });
  const scored = candidates.map((v) => {
    const evidence = dishEvidence(v, taste);
    const bonus = (evidence?.where === 'review' ? 18 : evidence?.where === 'summary' ? 10 : evidence ? 6 : 0) + budgetFit(v.priceLevel, budget);
    return { ...v, evidence, tableScore: Number((v.score + bonus).toFixed(2)) };
  }).sort((a, b) => b.tableScore - a.tableScore);

  // Real drive times for the finalists only — one matrix call, a handful of
  // elements, so "within an hour" is the road and not a straight line.
  const finalists = scored.slice(0, PLACES_PER_TABLE + 3);
  let travelNote = routingEnabled() ? routing.note : 'Google Routes is not switched on here, so the drive is worked out from the distance.';
  // One refusal from Routes stands for the whole run: the next table does not
  // ask again to be told the same thing (and billed for asking).
  if (routingEnabled() && !routing.off && finalists.length) {
    try {
      const rows = await travelMatrixMinutes({ origin: home, destinations: finalists, mode: 'driving', meter });
      rows?.forEach((row, i) => { if (row?.minutes != null) { finalists[i].travelMinutes = row.minutes; finalists[i].travelEstimated = false; } });
      // A spent quota comes back both ways: a 429, and a 200 whose rows carry
      // an error instead of a route. Neither is worth asking again this run.
      if (!rows?.some((row) => row?.minutes != null)) {
        travelNote = 'Google Routes answered without a road time for any of these, so they are worked out from the distance — a road is longer than a straight line. Its daily quota is the usual reason.';
        routing.off = true;
        routing.note = travelNote;
      }
    } catch (err) {
      // The estimate stands, but the reason is said out loud in the log and on
      // the table: an hour by road is not an hour as the crow flies.
      travelNote = /429|RESOURCE_EXHAUSTED/.test(String(err?.message))
        ? 'Google Routes has no quota left today, so these times are worked out from the distance and a road is longer than a straight line.'
        : `Drive times are estimated: ${String(err?.message || err).slice(0, 160)}`;
      routing.off = true;
      routing.note = travelNote;
      console.warn(`taste table drive times fell back to the estimate: ${err?.message || err}`);
    }
  }

  const places = finalists
    .filter((v) => v.travelMinutes <= capMinutes)
    .slice(0, PLACES_PER_TABLE)
    .map((v) => ({
      venueRef: `${v.source}:${v.sourcePlaceId}`,
      source: v.source,
      name: v.name,
      category: v.category,
      cuisines: v.cuisines ?? [],
      address: v.address ?? null,
      rating: v.rating ?? null,
      ratingCount: v.ratingCount ?? null,
      priceLevel: v.priceLevel ?? null,
      travelMinutes: v.travelMinutes,
      travelEstimated: v.travelEstimated !== false,
      distanceKm: v.distanceKm,
      lat: v.lat,
      lng: v.lng,
      website: v.website ?? null,
      mapsUrl: v.mapsUrl ?? null,
      photos: (v.photos ?? []).slice(0, 1),
      chain: Boolean(v.chain),
      // The one line of published evidence that this place does this food.
      evidence: v.evidence ? { where: v.evidence.where, text: v.evidence.text, matched: v.evidence.matched } : null,
      fits: fitLines(v, attending),
      attribution: v.attributionText ?? v.attribution ?? null,
      menu: null,
    }));

  return {
    key: taste.key,
    kind: taste.kind,
    label: taste.label,
    title: `Best ${taste.label.toLowerCase()}`,
    loved: taste.loved,
    notFor: taste.notFor,
    named: taste.named,
    // "Roger and Gina both love it" / "Phoenix's favourite"
    because: taste.loved.length
      ? `${namesOf(taste.loved)} love${taste.loved.length === 1 ? 's' : ''} ${taste.label.toLowerCase()}${taste.loved.some((l) => l.favourite) ? ` — ${namesOf(taste.loved.filter((l) => l.favourite))}'s favourite` : ''}`
      : `You asked for ${taste.label.toLowerCase()}`,
    searched: params.query,
    radiusKm: Number(radiusKm.toFixed(1)),
    travelNote,
    places,
    excluded: excluded.slice(0, 5).map((v) => ({ name: v.name, reasons: v.exclusionReasons })),
    found: venues.length,
  };
}

async function runTables({ household, attending, attendees, session, input }) {
  const home = { label: household.home_label, lat: household.home_lat, lng: household.home_lng };
  const capMinutes = input.maxTravelMinutes ?? ANYWHERE_MINUTES;
  const googleOn = sourceHasKey('google') && !sourceOff('google');
  const sources = googleOn ? ['google'] : defaultSourceKeys();
  const tastes = foodTastes(attendees, { brief: input.brief || '' }).slice(0, MAX_TABLES);
  const meter = {};
  const routing = { off: false, note: null };
  const run = putRun(session.id, {
    running: true, tastes, tables: [], input, error: null,
    note: googleOn ? null : 'Google Places is off here, so the sources cannot be asked for a dish by name — these are the places nearby whose kind matches.',
  });

  try {
    for (const taste of tastes) {
      try {
        // One slow source must not hold the whole screen: a table that takes
        // too long says so and the next one is looked up.
        run.tables.push(await Promise.race([
          buildTable({ household, attending, attendees, session, taste, home, capMinutes, budget: input.budget, sources, dishSearch: googleOn, routing, meter }),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`The sources took more than ${TABLE_DEADLINE_MS / 1000}s over ${taste.label.toLowerCase()}.`)), TABLE_DEADLINE_MS)),
        ]));
      } catch (err) {
        run.tables.push({ key: taste.key, label: taste.label, title: `Best ${taste.label.toLowerCase()}`, loved: taste.loved, notFor: taste.notFor, places: [], error: String(err?.message || err) });
      }
      run.at = Date.now(); // each table lands as it is found, so the screen fills rather than waits
    }
  } catch (err) {
    run.error = String(err?.message || err);
  }
  run.running = false;
  run.at = Date.now();
  // What the drive times cost, attributed like every other outbound call.
  try {
    if (Object.keys(meter).length) {
      await query('insert into provider_calls (household_id, session_id, provider, purpose, units) values ($1, $2, $3, $4, $5)',
        [household.id, session.id, 'google-routes', 'plan.tastes.routing', meter]);
    }
    await query('update plan_sessions set state = $2 where id = $1', [session.id, JSON.stringify({ kind: 'tastes', input, running: false })]);
  } catch { /* the tables are already in hand */ }
}

const publicRun = (run, sessionId) => ({
  sessionId,
  running: Boolean(run.running),
  tastes: (run.tastes || []).map((t) => ({ key: t.key, label: t.label, title: `Best ${t.label.toLowerCase()}`, loved: t.loved, notFor: t.notFor, named: t.named })),
  tables: run.tables || [],
  note: run.note ?? null,
  error: run.error ?? null,
  capMinutes: run.input?.maxTravelMinutes ?? null,
});

/**
 * Start the tables. Body: { brief, moods, maxTravelMinutes, budget, attendingMemberIds }.
 * Answers at once with the session and the foods it is about to look up; the
 * screen polls GET /api/plan/tastes/:sessionId as each table lands.
 */
router.post('/tastes', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    if (household.home_lat == null) return res.status(400).json({ error: 'home_required', message: 'Set a home address in Settings first — the tables are measured from home.' });
    const members = await loadMembers(household.id);
    const { brief = '', moods = [], maxTravelMinutes = null, budget = 'any', attendingMemberIds } = req.body || {};
    const attending = Array.isArray(attendingMemberIds) && attendingMemberIds.length ? members.filter((m) => attendingMemberIds.includes(m.id)) : members;
    const attendees = toAttendees(attending);
    const input = { brief: String(brief || '').trim() || null, moods, maxTravelMinutes: maxTravelMinutes ?? null, budget };
    const { rows } = await query('insert into plan_sessions (household_id, state) values ($1, $2) returning *', [household.id, JSON.stringify({ kind: 'tastes', input, running: true })]);
    const session = rows[0];
    const all = foodTastes(attendees, { brief: input.brief || '' });
    const tastes = all.slice(0, MAX_TABLES);
    // Tables cost a search each, so they are built when food is the point of
    // the day: the Food-focused mood, or a food named in what they said.
    const foodFirst = (moods || []).some((m) => /food/i.test(String(m))) || all.some((t) => t.named);
    if (!foodFirst || !tastes.length) {
      const note = !tastes.length && foodFirst ? 'Nobody coming has a food on their list yet — add likes in Household and this fills itself.' : null;
      putRun(session.id, { running: false, tastes: [], tables: [], input, error: null, note });
      return res.json({ ...publicRun(getRun(session.id), session.id), running: false });
    }
    res.json({ sessionId: session.id, running: true, tastes: tastes.map((t) => ({ key: t.key, label: t.label, title: `Best ${t.label.toLowerCase()}`, loved: t.loved, notFor: t.notFor, named: t.named })), tables: [], note: null, error: null });
    runTables({ household, attending, attendees, session, input }).catch(() => { /* recorded on the run */ });
  } catch (err) {
    next(err);
  }
});

function findPlace(sessionId, tasteKey, venueRef) {
  const run = getRun(sessionId);
  if (!run) return { error: 'tables_gone' };
  const table = (run.tables || []).find((t) => t.key === tasteKey);
  const place = table?.places?.find((p) => p.venueRef === venueRef);
  return place ? { run, table, place } : { error: 'place_gone' };
}

/**
 * What else is around a table's place, in the family's own terms: the ordinary
 * look-around (shared with the trip's Find tab through the cache), with the
 * reason each thing is for this family — "Phoenix loves climbing".
 */
router.get('/tastes/around', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { sessionId, tasteKey, venueRef } = req.query;
    const found = findPlace(String(sessionId || ''), String(tasteKey || ''), String(venueRef || ''));
    if (found.error) return res.status(404).json({ error: found.error, message: 'That place is no longer on this session — tap Inspire me again.' });
    const { place } = found;
    const attendingIds = String(req.query.members || '').split(',').filter(Boolean);
    const attending = attendingIds.length ? members.filter((m) => attendingIds.includes(m.id)) : members;
    const attendees = toAttendees(attending);
    const liked = likedConcepts(attendees, { kinds: ['experience'] });

    const { venues, cached } = await thingsAround({ household, session: null, place: { lat: place.lat, lng: place.lng, locality: place.locality ?? null } });
    const center = { lat: place.lat, lng: place.lng };
    const kindOf = (c) => (FOOD.has(c.category) ? 'eat' : ['attraction', 'event', 'activity'].includes(c.category) ? 'do' : 'see');
    const weight = (c) => (c.rating ?? 0) * Math.log10((c.ratingCount ?? 0) + 2);
    const sorted = [...venues].sort((a, b) => weight(b) - weight(a));
    // Only the head of the list is asked "who is this for": the tail is never shown.
    const head = new Set(sorted.slice(0, 80));
    const items = sorted.map((c) => ({
      venueRef: `${c.source}:${c.sourcePlaceId}`, name: c.name, category: c.category, kind: kindOf(c), experiences: c.experiences ?? [],
      rating: c.rating ?? null, ratingCount: c.ratingCount ?? null, priceLevel: c.priceLevel ?? null,
      distanceKm: Number(kmBetween(center, c).toFixed(1)), lat: c.lat, lng: c.lng,
      why: head.has(c) ? whyForUs(c, liked) : [],
      reasons: [],
    }));
    // The handful worth naming: something for as many of them as possible, best first.
    // Somebody different each time where the place allows it, best-rated first,
    // then the best of the rest — so a day out is not four museums for one person.
    const candidates = items.filter((i) => i.kind !== 'eat' && i.why.length).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    const forUs = [];
    const spoken = new Set();
    for (const it of candidates) {
      if (!it.why.some((w) => !spoken.has(w.memberId))) continue;
      forUs.push(it);
      for (const w of it.why) spoken.add(w.memberId);
      if (forUs.length >= 3) break;
    }
    for (const it of candidates) {
      if (forUs.length >= 3) break;
      if (!forUs.includes(it)) forUs.push(it);
    }
    res.json({ items, forUs, cached: Boolean(cached), radiusKm: THINGS_RADIUS_KM });
  } catch (err) {
    next(err);
  }
});

/**
 * Read this place's menu (owner, 4 Sep 2026). One tap, one venue, one call:
 * does it do the dish, is there something for everyone's requirement, does the
 * allergen appear.
 *
 * Reading takes a minute or two — Claude opens their site and looks — so it
 * runs in the background like Inspire me does and the answer is polled off the
 * place. A request held open that long is a 502 waiting to happen.
 * Body: { sessionId, tasteKey, venueRef, attendingMemberIds? }.
 */
router.post('/tastes/menu', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { sessionId, tasteKey, venueRef, attendingMemberIds } = req.body || {};
    const found = findPlace(String(sessionId || ''), String(tasteKey || ''), String(venueRef || ''));
    if (found.error) return res.status(404).json({ error: found.error, message: 'That place is no longer on this session — tap Inspire me again.' });
    if (!menuCheckEnabled()) return res.status(503).json({ error: 'menu_check_off', message: 'Reading a menu needs the planner\u2019s Anthropic key, which is not set here.' });
    const { run, place } = found;
    if (place.menuReading) return res.json({ reading: true, menu: null, error: null });
    const attending = Array.isArray(attendingMemberIds) && attendingMemberIds.length ? members.filter((m) => attendingMemberIds.includes(m.id)) : members;
    const taste = (run.tastes || []).find((t) => t.key === tasteKey);

    place.menuReading = true;
    place.menuError = null;
    res.status(202).json({ reading: true, menu: null, error: null });

    checkMenu({
      householdId: household.id,
      sessionId,
      venue: { venueRef: place.venueRef, name: place.name, address: place.address, website: place.website, mapsUrl: place.mapsUrl, cuisines: place.cuisines },
      dish: taste && ['dish', 'ingredient'].includes(taste.kind) ? { label: taste.label, aliases: taste.concept?.aliases ?? [] } : null,
      people: attending.flatMap((m) => (m.diets || []).map((d) => ({ person: firstName(m.name), need: d.value }))),
      allergens: attending.flatMap((m) => (m.allergens || []).map((a) => ({ person: firstName(m.name), allergen: a.value }))),
      kidsMatter: attending.some((m) => m.isMinor),
    })
      // Kept with the place in memory only, never on the session row.
      .then((menu) => { place.menu = menu; })
      .catch((err) => { place.menuError = /paused:/.test(String(err?.message)) ? err.message : `Roam could not read that menu: ${err?.message || err}`; })
      .finally(() => { place.menuReading = false; run.at = Date.now(); });
  } catch (err) {
    next(err);
  }
});

/** What the menu reader has come back with, if anything yet. */
router.get('/tastes/menu', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const found = findPlace(String(req.query.sessionId || ''), String(req.query.tasteKey || ''), String(req.query.venueRef || ''));
    if (found.error) return res.status(404).json({ error: found.error, message: 'That place is no longer on this session — tap Inspire me again.' });
    const { place } = found;
    res.json({ reading: Boolean(place.menuReading), menu: place.menu ?? null, error: place.menuError ?? null, usage: await menuCheckUsage(household.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * The table becomes a day out: home to the restaurant and back, the restaurant
 * on the shortlist as a must-do, and the things around it the family was shown.
 * Body: { sessionId, tasteKey, venueRef, attendingMemberIds?, around? }.
 */
router.post('/tastes/trip', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const { sessionId, tasteKey, venueRef, attendingMemberIds, around = [] } = req.body || {};
    const found = findPlace(String(sessionId || ''), String(tasteKey || ''), String(venueRef || ''));
    if (found.error) return res.status(404).json({ error: found.error, message: 'That place is no longer on this session — tap Inspire me again.' });
    if (household.home_lat == null) return res.status(400).json({ error: 'home_required', message: 'Set a home address in Settings first.' });
    const { table, place } = found;
    if (place.tripId) {
      const { rows } = await query('select id, title, start_date from trips where id = $1 and household_id = $2', [place.tripId, household.id]);
      if (rows[0]) return res.json({ tripId: rows[0].id, title: rows[0].title, date: rows[0].start_date, seeded: place.seeded ?? [], reply: `${rows[0].title} is already set up — opening it.`, existing: true });
    }

    const home = { label: household.home_label, lat: household.home_lat, lng: household.home_lng, how: 'home' };
    const attending = Array.isArray(attendingMemberIds) && attendingMemberIds.length ? members.filter((m) => attendingMemberIds.includes(m.id)) : members;
    const tz = household.timezone || DEFAULT_TZ;
    const now = wallClock(new Date(), tz);
    const date = now.hhmm < '11:00' ? now.dateStr : addDays(now.dateStr, 1);
    // Where the place is, in words, for the trip's title and its atlas entry.
    let locality = place.locality ?? null;
    if (!locality) {
      try { const hit = await reverseGeocode(place.lat, place.lng, { zoom: 12 }); locality = hit?.locality ?? hit?.label?.split(',')[0] ?? null; } catch { /* the name alone will do */ }
    }
    place.locality = locality;
    const destination = { label: place.name, lat: place.lat, lng: place.lng, locality, how: 'place' };
    const title = `${locality ? `${locality} · ` : ''}${table.label} at ${place.name}`;
    const wants = (Array.isArray(around) ? around : []).map((a) => String(a)).slice(0, 4);
    const intent = { date, duration_minutes: 480, travel_mode: 'driving', intensity: null, anchor: null, depart_time: null, attending: attending.map((m) => m.name), wants };
    const { trip } = await createTripFromIntent({ household, members, intent, origin: home, destination, anchorPlace: null, title });

    // The restaurant itself is the point of the day, so it goes on first.
    await addShortlistItem(trip, household, {
      venueRef: place.venueRef, venueLabel: place.name, kind: 'food', category: place.category,
      lat: place.lat, lng: place.lng, mustDo: true,
      note: `Roam suggested: best ${table.label.toLowerCase()}${table.loved?.length ? ` for ${namesOf(table.loved)}` : ''}`,
    });
    // Then whatever the family was shown around it, by name, exactly as Inspire me does.
    const idea = { title, place: { label: place.name, lat: place.lat, lng: place.lng, locality, countryCode: null }, do: wants, eat: [] };
    let seeded = [place.name];
    try { seeded = [place.name, ...(await seedShortlistFromIdea({ household, session: null, trip, idea }))]; } catch { /* the restaurant alone is enough */ }
    place.tripId = trip.id;
    place.seeded = seeded;
    const reply = `${title} set up for ${dayWords(date)}, with ${namesOf(seeded.map((s) => ({ name: s })))} on the shortlist. Opening it in Trips.`;
    res.status(201).json({ tripId: trip.id, title, date, seeded, reply, existing: false });
  } catch (err) {
    next(err);
  }
});

/** Whether menus can be read here, and how many reads this month have gone. */
router.get('/tastes/menu/usage', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    // readsInBackground tells a client to poll rather than hold the request open.
    res.json({ enabled: menuCheckEnabled(), readsInBackground: true, ...(await menuCheckUsage(household.id)) });
  } catch (err) {
    next(err);
  }
});

/** Where the tables have got to. */
router.get('/tastes/:sessionId', async (req, res, next) => {
  try {
    const run = getRun(req.params.sessionId);
    if (!run) return res.status(404).json({ error: 'tables_gone', message: 'Those tables were found before a restart and are not kept — tap Inspire me again.' });
    res.json(publicRun(run, req.params.sessionId));
  } catch (err) {
    next(err);
  }
});

export default router;

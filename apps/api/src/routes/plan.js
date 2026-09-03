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
import { searchAllSources } from '../sources/index.js';
import { resolvePlace, KNOWN_PLACES } from '../sources/fixtures.js';
import { deriveCatchment, TRAVEL_MODES } from '../domain/travel.js';
import { applyConstraints } from '../domain/ranking.js';
import { composeOptions } from '../domain/options.js';
import { INTENSITY_TARGETS } from '../domain/budget.js';
import { currentHousehold, loadMembers, toAttendees } from './household.js';

const router = Router();

// ---------------------------------------------------------------------------
// Schemas — what Claude is allowed to return.
// ---------------------------------------------------------------------------

const TripIntent = z.object({
  understood: z.boolean().describe('False if the message is not about planning an outing'),
  origin: z.string().nullable().describe('Where the outing starts, as the user said it; null if not said'),
  destination: z.string().nullable().describe('Where the outing ends, if different from the origin; null if not said or if they return to the origin'),
  duration_minutes: z.number().int().nullable().describe('How long they have, in minutes; null if not said'),
  depart_time: z.string().nullable().describe('Departure clock time as HH:MM 24h if said, else null'),
  travel_mode: z.enum(['walking', 'cycling', 'driving', 'transit']).nullable(),
  min_activities: z.number().int().nullable().describe('Minimum number of things to do (attractions or events), if said'),
  min_food_stops: z.number().int().nullable().describe('Minimum number of places to eat or drink, if said'),
  intensity: z.enum(['relaxed', 'balanced', 'packed']).nullable().describe('How full they want the time; infer only from explicit cues like "relaxed", "pack it in"'),
  wants: z.array(z.string()).describe('Specific things asked for, e.g. "ramen", "somewhere with live music", "a park"'),
  avoids: z.array(z.string()).describe('Things explicitly not wanted'),
  attending: z.array(z.string()).describe('Household member names mentioned as coming; empty means everyone'),
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

You are given the household (members, defaults) and a list of place names the app knows. Extract only what was said; do not invent an origin, duration or preferences. If the origin or the duration is missing, say so in the reply by asking for that one thing, briefly and warmly. Durations like "three hours" become minutes. "From X to Y" means origin X, destination Y. "Around here", "near us" and "home" mean the origin is Home. If the user names a place the app does not know, keep their wording in origin/destination anyway.

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

function roundUpToQuarter(date) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15);
  return d;
}

/** Turn an intent into a trip row in the database. */
async function createTripFromIntent({ household, members, intent, origin, destination }) {
  const depart = intent.depart_time
    ? (() => { const d = new Date(); const [h, m] = intent.depart_time.split(':').map(Number); d.setHours(h, m, 0, 0); return d; })()
    : roundUpToQuarter(new Date());
  const returnAt = new Date(depart.getTime() + intent.duration_minutes * 60_000);
  const mode = intent.travel_mode && TRAVEL_MODES.includes(intent.travel_mode) ? intent.travel_mode : 'transit';
  const intensity = intent.intensity && INTENSITY_TARGETS[intent.intensity] ? intent.intensity : household.default_intensity;

  const { rows } = await query(
    `insert into trips (household_id, title, origin_label, origin_lat, origin_lng,
                        destination_label, destination_lat, destination_lng,
                        depart_at, return_at, travel_mode, intensity)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [
      household.id,
      destination ? `${origin.label} → ${destination.label}` : `Out from ${origin.label}`,
      origin.label, origin.lat, origin.lng,
      destination?.label ?? null, destination?.lat ?? null, destination?.lng ?? null,
      depart.toISOString(), returnAt.toISOString(), mode, intensity,
    ],
  );
  const trip = rows[0];

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
  // Reach is bounded by the household's tolerance and by the window itself:
  // nobody wants to spend more than a third of three hours getting somewhere.
  const maxTravelMinutes = Math.min(household.max_travel_minutes, Math.max(15, Math.round(durationMinutes / 3)));

  const wantsText = (intent.wants || []).join(' ');
  const { venues, degraded, sourcesQueried } = await searchAllSources({
    categories: [],
    query: '',
    includeEvents: true,
    outingStart: trip.depart_at,
  });
  await query(
    `insert into provider_calls (household_id, session_id, provider, purpose) values ($1, $2, $3, $4)`,
    [household.id, sessionId, sourcesQueried.join('+') || 'none', 'plan.retrieve'],
  );

  const origin = { lat: trip.origin_lat, lng: trip.origin_lng };
  const inReach = deriveCatchment({ origin, maxTravelMinutes, mode: trip.travel_mode, venues });
  const { candidates, excluded } = applyConstraints({ venues: inReach, attendees });

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
  };
}

async function recompose(session, household) {
  const { state } = session;
  const { rows } = await query('select * from trips where id = $1', [session.trip_id]);
  const trip = rows[0];
  const composed = composeOptions({
    trip,
    household,
    pool: state.pool,
    minActivities: state.minActivities,
    minFood: state.minFood,
    pinned: state.pinned,
    excluded: state.excluded,
  });
  return { trip, ...composed };
}

async function respond(res, { session, household, reply, extra = {} }) {
  const { trip, options, poolSize, target } = await recompose(session, household);
  const spend = await spendSummary({ householdId: household.id, sessionId: session.id });
  res.json({
    sessionId: session.id,
    trip: publicTrip(trip),
    reply,
    options,
    selection: {
      pinned: session.state.pinned,
      excluded: session.state.excluded,
      chosenOptionId: session.state.chosenOptionId ?? null,
    },
    constraints: { minActivities: session.state.minActivities, minFood: session.state.minFood },
    pool: { size: poolSize, targetFill: target, excludedByAllergen: session.state.excludedByAllergen ?? [] },
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
    const { utterance, sessionId: existingId } = req.body || {};
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
    state.transcript = [...(state.transcript || []), { role: 'user', text: utterance }];

    // Earlier partial intent (e.g. origin given, duration still missing) is
    // carried so the household only has to answer the gap.
    const prior = state.intent ? `Earlier in this conversation the user said: ${JSON.stringify(state.intent)}` : '';

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

    const origin = resolvePlace(merged.origin);
    const destination = merged.destination ? resolvePlace(merged.destination) : null;
    const missing = [];
    if (!merged.origin) missing.push('origin');
    else if (!origin) missing.push('origin_unknown');
    if (!merged.duration_minutes) missing.push('duration');
    if (merged.destination && !destination) missing.push('destination_unknown');

    if (!intent.understood || missing.length) {
      let reply = intent.reply;
      if (missing.includes('origin_unknown')) reply = `I don't know "${merged.origin}" yet — try one of: ${KNOWN_PLACES.slice(0, 4).map((p) => p.label).join(', ')}.`;
      if (missing.includes('destination_unknown')) reply = `I don't know "${merged.destination}" yet — where's the outing ending? I know ${KNOWN_PLACES.slice(0, 4).map((p) => p.label).join(', ')}.`;
      state.transcript.push({ role: 'assistant', text: reply });
      await saveSession(session.id, state, null);
      return res.json({ sessionId: session.id, reply, intent: merged, missing, options: [] });
    }

    const { trip, attending } = await createTripFromIntent({ household, members, intent: merged, origin, destination });
    const attendees = toAttendees(attending);
    const pool = await retrievePool({ household, trip, attendees, intent: merged, sessionId: session.id });

    state.pool = pool.candidates;
    state.excludedByAllergen = pool.excluded.map((e) => ({ name: e.name, reasons: e.exclusionReasons }));
    state.minActivities = merged.min_activities ?? 0;
    state.minFood = merged.min_food_stops ?? 0;
    state.pinned = [];
    state.excluded = [];
    state.chosenOptionId = null;
    state.suggestedPreferences = [];
    state.attending = attendees.map((a) => ({ id: a.id, name: a.name }));
    state.transcript.push({ role: 'assistant', text: intent.reply });
    await saveSession(session.id, state, trip.id);

    session.state = state;
    session.trip_id = trip.id;
    await respond(res, {
      session, household, reply: intent.reply,
      extra: { intent: merged, missing: [], attending: state.attending, reach: { maxTravelMinutes: pool.maxTravelMinutes, estimated: true }, degradedSources: pool.degraded },
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
    if (tc.duration_minutes != null || tc.intensity || tc.travel_mode) {
      await query(
        `update trips set
           return_at   = case when $2::int is null then return_at else depart_at + ($2::int * interval '1 minute') end,
           intensity   = coalesce($3, intensity),
           travel_mode = coalesce($4, travel_mode)
         where id = $1`,
        [session.trip_id, tc.duration_minutes ?? null, tc.intensity ?? null, tc.travel_mode ?? null],
      );
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
        if (action.intensity && INTENSITY_TARGETS[action.intensity]) {
          await query('update trips set intensity = $2 where id = $1', [session.trip_id, action.intensity]);
        }
        if (action.durationMinutes != null) {
          await query(`update trips set return_at = depart_at + ($2::int * interval '1 minute') where id = $1`, [session.trip_id, Number(action.durationMinutes)]);
        }
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
    const { options } = await recompose(session, household);
    const option = options.find((o) => o.id === optionId);
    if (!option) return res.status(404).json({ error: 'option_not_found' });

    await query('delete from trip_stops where trip_id = $1', [session.trip_id]);
    for (const stop of option.stops) {
      await query(
        `insert into trip_stops (trip_id, position, venue_ref, venue_name, lat, lng, dwell_minutes)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [session.trip_id, stop.position, stop.venueRef, stop.name, stop.lat, stop.lng, stop.dwellMinutes],
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

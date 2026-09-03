// Trip options composed from ONE candidate pool (Epic 5).
//
// Discovery is the expensive part, so several complete plans are composed from
// a single retrieved pool by varying selection and ordering (C3). Each option
// differs from the others on a stated basis, and that basis is shown (C4).
// Intensity is a proportion of the window to fill, never a stop count (C1/C2),
// and it also governs how long each stop is allowed (Requirements §5).

import { computeBudget, INTENSITY_TARGETS } from './budget.js';
import { estimateTravelMinutes } from './travel.js';
import { paceOf, dwellAllowance } from './pace.js';

export const FOOD_CATEGORIES = new Set(['restaurant', 'cafe', 'pub', 'bar']);
export const ACTIVITY_CATEGORIES = new Set(['attraction', 'event']);

export const isFood = (c) => FOOD_CATEGORIES.has(c.category);
export const isActivity = (c) => ACTIVITY_CATEGORIES.has(c.category);
const isEvent = (c) => c.category === 'event';

// How much intensity stretches or squeezes each stop's allowance.
const INTENSITY_DWELL = { relaxed: 1.15, balanced: 1, packed: 0.85 };

// When must-haves do not fit at the household's usual pace, allowances are
// shortened in steps rather than the must-have dropped. Never below 30 minutes.
const DWELL_SCALES = [1, 0.8, 0.65, 0.5];
const MIN_DWELL = 30;

// A timed event can be joined a little late; later than this and it is missed.
const EVENT_LATE_TOLERANCE_MINUTES = 10;

/** Base time allowance by kind of stop (Epic 4 C5), from the household's pace and any member cap. */
export function dwellFor(candidate, household, attendees = []) {
  return dwellAllowance(paceOf(household), candidate, attendees);
}

function nearestNeighbour(origin, mode, stops) {
  const remaining = [...stops];
  const ordered = [];
  let cursor = origin;
  while (remaining.length) {
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const cost = estimateTravelMinutes(cursor, remaining[i], mode);
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    const [next] = remaining.splice(best, 1);
    ordered.push(next);
    cursor = next;
  }
  return ordered;
}

/**
 * Walk a sequence from departure, arriving, waiting for timed events, staying.
 * Returns null if an event would be missed.
 */
function simulate(trip, sequence) {
  const mode = trip.travel_mode;
  let clock = new Date(trip.depart_at).getTime();
  let cursor = { lat: trip.origin_lat, lng: trip.origin_lng };
  const timed = [];

  for (const stop of sequence) {
    const travel = estimateTravelMinutes(cursor, stop, mode);
    clock += travel * 60_000;
    let wait = 0;
    if (isEvent(stop)) {
      const start = new Date(stop.startsAt).getTime();
      const lateBy = (clock - start) / 60_000;
      if (lateBy > EVENT_LATE_TOLERANCE_MINUTES) return null;
      wait = Math.max(0, Math.round((start - clock) / 60_000));
      clock = Math.max(clock, start);
    }
    const arriveAt = new Date(clock);
    clock += stop.dwellMinutes * 60_000;
    timed.push({ ...stop, travelFromPrevMinutes: travel, waitMinutes: wait, arriveAt: arriveAt.toISOString(), leaveAt: new Date(clock).toISOString() });
    cursor = stop;
  }
  return timed;
}

/**
 * Order stops: nearest-neighbour for places, with each timed event inserted
 * where it causes the least waiting. Null if no feasible order exists.
 */
function schedule(trip, stops) {
  const origin = { lat: trip.origin_lat, lng: trip.origin_lng };
  let sequence = nearestNeighbour(origin, trip.travel_mode, stops.filter((s) => !isEvent(s)));
  const events = stops.filter(isEvent).sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

  for (const event of events) {
    let best = null;
    for (let i = 0; i <= sequence.length; i += 1) {
      const attempt = [...sequence.slice(0, i), event, ...sequence.slice(i)];
      const timed = simulate(trip, attempt);
      if (!timed) continue;
      const wait = timed.reduce((sum, s) => sum + s.waitMinutes, 0);
      if (!best || wait < best.wait) best = { attempt, wait };
    }
    if (!best) return null;
    sequence = best.attempt;
  }
  return simulate(trip, sequence);
}

function toRows(timed) {
  return timed.map((s, i) => ({
    id: s.key,
    position: i + 1,
    venue_name: s.name,
    lat: s.lat,
    lng: s.lng,
    // Waiting for an event is time the plan spends, so it counts in the budget.
    dwell_minutes: s.dwellMinutes + s.waitMinutes,
  }));
}

function eventInsideWindow(candidate, trip) {
  if (!isEvent(candidate)) return true;
  return new Date(candidate.startsAt) >= new Date(trip.depart_at) && new Date(candidate.endsAt) <= new Date(trip.return_at);
}

const BASES = [
  {
    id: 'best-match',
    title: "Best match for who's coming",
    describe: "Ranked on the household's tastes",
    order: (pool) => [...pool].sort((a, b) => b.score - a.score),
  },
  {
    id: 'least-travel',
    title: 'Least time travelling',
    describe: 'Closest places first',
    order: (pool) => [...pool].sort((a, b) => a.travelMinutes - b.travelMinutes || b.score - a.score),
  },
  {
    id: 'things-first',
    title: 'Things to do first',
    describe: 'Activities lead, food fits around them',
    order: (pool) => [
      ...pool.filter(isActivity).sort((a, b) => b.score - a.score),
      ...pool.filter(isFood).sort((a, b) => b.score - a.score),
    ],
  },
  {
    id: 'food-forward',
    title: 'Built around the meal',
    describe: "The best place to eat, then what's near it",
    order: (pool) => [
      ...pool.filter(isFood).sort((a, b) => b.score - a.score),
      ...pool.filter(isActivity).sort((a, b) => b.score - a.score),
    ],
  },
];

/**
 * Compose up to `maxOptions` complete plans.
 *
 * @param pool      ranked, constraint-applied candidates (from discovery)
 * @param pinned    venue keys that must appear in every option ("I like this")
 * @param excluded  venue keys that must not appear ("not that")
 */
export function composeOptions({
  trip,
  household,
  pool,
  minActivities = 0,
  minFood = 0,
  pinned = [],
  excluded = [],
  maxOptions = 3,
  attendees = [],
}) {
  const excludedSet = new Set(excluded);
  const target = INTENSITY_TARGETS[trip.intensity] ?? INTENSITY_TARGETS.balanced;
  const intensityDwell = INTENSITY_DWELL[trip.intensity] ?? 1;

  const usable = pool
    .filter((c) => !excludedSet.has(c.key) && eventInsideWindow(c, trip))
    .map((c) => { const a = dwellFor(c, household, attendees); return { ...c, baseDwell: a.minutes, dwellCappedBy: a.cappedBy }; });
  const byKey = new Map(usable.map((c) => [c.key, c]));
  const pinnedStops = pinned.map((k) => byKey.get(k)).filter(Boolean);

  const withDwell = (c, scale) => ({
    ...c,
    dwellMinutes: isEvent(c) ? c.baseDwell : Math.max(MIN_DWELL, Math.round(c.baseDwell * intensityDwell * scale)),
  });

  const evaluate = (stops) => {
    const timed = schedule(trip, stops);
    if (!timed) return { timed: null, budget: null };
    return { timed, budget: computeBudget({ trip, stops: toRows(timed), household }) };
  };
  const fitsWindow = (stops) => {
    const { budget } = evaluate(stops);
    return !!budget && budget.remainingMinutes >= 0;
  };
  const fitsTarget = (stops) => {
    const { budget } = evaluate(stops);
    return !!budget && budget.remainingMinutes >= 0 && budget.fillRatio <= target + 0.1;
  };

  const quotas = [
    { pred: isActivity, need: minActivities },
    { pred: isFood, need: minFood },
  ];
  const shortfallOf = (stops) => quotas.reduce((s, q) => s + Math.max(0, q.need - stops.filter(q.pred).length), 0);

  const options = [];
  const seen = new Set();

  for (const basis of BASES) {
    // 1. Must-haves first, shortening allowances step by step until they fit.
    let chosen = null;
    let chosenScale = 1;
    for (const scale of DWELL_SCALES) {
      const ranked = basis.order(usable).map((c) => withDwell(c, scale));
      const rankedByKey = new Map(ranked.map((c) => [c.key, c]));
      let seed = pinnedStops.map((p) => rankedByKey.get(p.key)).filter(Boolean);
      if (seed.length && !fitsWindow(seed)) seed = [];

      // Greedy in one quota order can satisfy activities but starve food, or
      // the reverse; try both orders and keep whichever leaves less unmet.
      let bestAttempt = null;
      for (const order of [quotas, [...quotas].reverse()]) {
        const attempt = [...seed];
        const has = (c) => attempt.some((s) => s.key === c.key);
        for (const { pred, need } of order) {
          let count = attempt.filter(pred).length;
          for (const c of ranked) {
            if (count >= need) break;
            if (has(c) || !pred(c)) continue;
            if (fitsWindow([...attempt, c])) { attempt.push(c); count += 1; }
          }
        }
        if (!bestAttempt || shortfallOf(attempt) < shortfallOf(bestAttempt)) bestAttempt = attempt;
      }

      if (!chosen || shortfallOf(bestAttempt) < shortfallOf(chosen)) { chosen = bestAttempt; chosenScale = scale; }
      if (shortfallOf(bestAttempt) === 0) break;
    }

    // 2. Fill toward the intensity target with whatever fits, in basis order.
    const ranked = basis.order(usable).map((c) => withDwell(c, chosenScale));
    const has = (c) => chosen.some((s) => s.key === c.key);
    for (const c of ranked) {
      const { budget } = evaluate(chosen);
      if (budget && budget.fillRatio >= target - 0.08) break;
      if (has(c)) continue;
      if (fitsTarget([...chosen, c])) chosen.push(c);
    }

    if (chosen.length === 0) continue;

    const { timed, budget } = evaluate(chosen);
    if (!timed) continue;
    const signature = timed.map((s) => s.key).sort().join('|');
    if (seen.has(signature)) continue; // M1: no near-identical padding
    seen.add(signature);

    const stops = timed.map((s, i) => ({
      id: s.key,
      position: i + 1,
      venueRef: `${s.source}:${s.sourcePlaceId}`,
      name: s.name,
      category: s.category,
      lat: s.lat,
      lng: s.lng,
      dwellMinutes: s.dwellMinutes,
      dwellCappedBy: s.dwellCappedBy ?? null,
      waitMinutes: s.waitMinutes,
      travelFromPrevMinutes: s.travelFromPrevMinutes,
      arriveAt: s.arriveAt,
      leaveAt: s.leaveAt,
      reasons: s.reasons ?? [],
      justification: s.justification ?? null,
      startsAt: s.startsAt ?? null,
      endsAt: s.endsAt ?? null,
      pinned: pinned.includes(s.key),
    }));

    options.push({
      id: basis.id,
      title: basis.title,
      basis: basis.describe,
      stops,
      budget,
      allowanceScale: chosenScale,
      counts: { activities: stops.filter(isActivity).length, food: stops.filter(isFood).length },
      shortfall: {
        activities: Math.max(0, minActivities - stops.filter(isActivity).length),
        food: Math.max(0, minFood - stops.filter(isFood).length),
      },
    });

    if (options.length >= maxOptions) break;
  }

  // What makes each option different from the others (research §6.2 "Differences").
  for (const option of options) {
    const others = options.filter((o) => o !== option);
    for (const stop of option.stops) {
      stop.uniqueToThisOption = others.every((o) => !o.stops.some((s) => s.id === stop.id));
    }
  }

  return { options, poolSize: usable.length, target };
}

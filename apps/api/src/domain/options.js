// Trip options composed from ONE candidate pool (Epic 5).
//
// Discovery is the expensive part, so several complete plans are composed from
// a single retrieved pool by varying selection and ordering (C3). Each option
// differs from the others on a stated basis, and that basis is shown (C4).
// Intensity is a proportion of the window to fill, never a stop count (C1/C2),
// and it also governs how long each stop is allowed (Requirements §5).

import { computeBudget, INTENSITY_TARGETS } from './budget.js';
import { estimateTravelMinutes, kmBetween } from './travel.js';
import { paceOf, dwellAllowance } from './pace.js';
import { wallClock, DEFAULT_TZ } from './time.js';

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
      // A fixed booking (your show) is arrived at 15 minutes early and never late.
      const early = stop.fixed ? 15 * 60_000 : 0;
      const start = new Date(stop.startsAt).getTime() - early;
      const lateBy = (clock - start) / 60_000;
      if (lateBy > (stop.fixed ? 0 : EVENT_LATE_TOLERANCE_MINUTES)) return null;
      wait = Math.max(0, Math.round((start - clock) / 60_000));
      clock = Math.max(clock, start) + early;
    }
    const arriveAt = new Date(clock);
    clock += stop.dwellMinutes * 60_000;
    timed.push({ ...stop, travelFromPrevMinutes: travel, waitMinutes: wait, arriveAt: arriveAt.toISOString(), leaveAt: new Date(clock).toISOString() });
    cursor = stop;
  }
  return timed;
}

// Meals belong at mealtimes: a restaurant at 09:40 is not a plan. Cafés and
// bars float; restaurants and pubs are pulled toward lunch, then dinner.
const MEAL_WINDOWS = [[11.75, 14], [18, 20.5]];
const isMeal = (s) => ['restaurant', 'pub'].includes(s.category);
const hourOf = (iso, tz) => wallClock(iso, tz || DEFAULT_TZ).hours;
function mealPenalty(arriveIso, windowIndex, tz) {
  const h = hourOf(arriveIso, tz);
  const [a, b] = MEAL_WINDOWS[Math.min(windowIndex, MEAL_WINDOWS.length - 1)];
  if (h >= a && h <= b) return 0;
  return h < a ? (a - h) * 60 : (h - b) * 60; // minutes outside the window
}

/**
 * Order stops: nearest-neighbour for places, meals slotted where they land
 * closest to a mealtime, then each timed event inserted where it causes the
 * least waiting. Null if no feasible order exists.
 */
function schedule(trip, stops) {
  const origin = { lat: trip.origin_lat, lng: trip.origin_lng };
  let sequence = nearestNeighbour(origin, trip.travel_mode, stops.filter((s) => !isEvent(s) && !isMeal(s)));
  const meals = stops.filter((s) => !isEvent(s) && isMeal(s));
  meals.forEach((meal, mi) => {
    let best = null;
    for (let i = 0; i <= sequence.length; i += 1) {
      const attempt = [...sequence.slice(0, i), meal, ...sequence.slice(i)];
      const timed = simulate(trip, attempt);
      if (!timed) continue;
      const placed = timed[i];
      const penalty = mealPenalty(placed.arriveAt, mi, trip.timezone) + timed.reduce((sum, s) => sum + s.travelFromPrevMinutes, 0) * 0.25;
      if (!best || penalty < best.penalty) best = { attempt, penalty };
    }
    sequence = best ? best.attempt : [...sequence, meal];
  });
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
// Price point, against a source's 0–4 price level. Unknown stays in: the data
// is missing, not the place unsuitable — the card says "price unknown".
export const PRICE_POINTS = ['any', 'affordable', 'mid', 'upmarket'];
function priceOk(c, pricePoint) {
  if (!pricePoint || pricePoint === 'any' || !isFood(c) || c.priceLevel == null) return true;
  if (pricePoint === 'affordable') return c.priceLevel <= 2;
  if (pricePoint === 'mid') return c.priceLevel >= 2 && c.priceLevel <= 3;
  return c.priceLevel >= 3; // upmarket
}

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
  includeChains = false,
  pricePoint = 'any',
}) {
  const excludedSet = new Set(excluded);
  const pinnedSet = new Set(pinned);
  const target = INTENSITY_TARGETS[trip.intensity] ?? INTENSITY_TARGETS.balanced;
  const intensityDwell = INTENSITY_DWELL[trip.intensity] ?? 1;
  const base = { lat: trip.origin_lat, lng: trip.origin_lng };

  const usable = pool
    // Anything ranked below zero (needs a booking, plainly unsuitable) is out
    // for every basis, including the ones that order by distance.
    .filter((c) => !excludedSet.has(c.key) && eventInsideWindow(c, trip) && (c.fixed || (c.score ?? 0) >= 0))
    // A theatre or cinema needs a ticket and a showtime: it is only ever the
    // booking the household named, never a wander-in suggestion.
    .filter((c) => c.fixed || !c.ticketed || pinnedSet.has(c.key))
    // Chains and price are the household's choice for the day. A place they
    // pinned, shortlisted or booked is theirs whatever the setting says.
    .filter((c) => c.fixed || c.shortlisted || pinnedSet.has(c.key) || ((includeChains || !c.chain) && priceOk(c, pricePoint)))
    .map((c) => { const a = dwellFor(c, household, attendees); return { ...c, baseDwell: a.minutes, dwellCappedBy: a.cappedBy }; });
  const byKey = new Map(usable.map((c) => [c.key, c]));
  const pinnedStops = pinned.map((k) => byKey.get(k)).filter(Boolean);

  const withDwell = (c, scale) => ({
    ...c,
    dwellMinutes: isEvent(c) || c.fixed ? c.baseDwell : Math.max(MIN_DWELL, Math.round(c.baseDwell * intensityDwell * scale)),
  });

  const evaluate = (stops) => {
    const timed = schedule(trip, stops);
    if (!timed) return { timed: null, budget: null };
    return { timed, budget: computeBudget({ trip, stops: toRows(timed), household }) };
  };
  const fitsWindow = (stops) => {
    if (!mealCapOk(stops)) return false;
    const { budget } = evaluate(stops);
    return !!budget && budget.remainingMinutes >= 0;
  };
  const fitsTarget = (stops) => {
    if (!mealCapOk(stops)) return false;
    const { budget } = evaluate(stops);
    return !!budget && budget.remainingMinutes >= 0 && budget.fillRatio <= target + 0.1;
  };

  // No second sit-down meal unless the day actually reaches dinner time.
  const dayStartH = hourOf(trip.depart_at, trip.timezone);
  const dayEndH = hourOf(trip.return_at, trip.timezone);
  const mealSlots = MEAL_WINDOWS.filter(([a, b]) => dayEndH >= a + 0.75 && dayStartH <= b).length;
  // "Somewhere to eat" means a meal when the day spans a mealtime; a café only counts otherwise.
  const foodQuotaPred = mealSlots > 0 ? isMeal : isFood;
  const quotas = [
    { pred: (c) => isActivity(c) && !c.fixed, need: minActivities },
    { pred: foodQuotaPred, need: minFood },
  ];
  const mealCapOk = (stops) => stops.filter(isMeal).length <= Math.max(1, mealSlots);
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
        const better = !bestAttempt
          || shortfallOf(attempt) < shortfallOf(bestAttempt)
          // A meal is harder to reschedule than a walk in a park: keep it on ties.
          || (shortfallOf(attempt) === shortfallOf(bestAttempt) && attempt.filter(isMeal).length > bestAttempt.filter(isMeal).length);
        if (better) bestAttempt = attempt;
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
      ...richFields(s, base),
      position: i + 1,
      dwellMinutes: s.dwellMinutes,
      dwellCappedBy: s.dwellCappedBy ?? null,
      waitMinutes: s.waitMinutes,
      travelFromPrevMinutes: s.travelFromPrevMinutes,
      arriveAt: s.arriveAt,
      leaveAt: s.leaveAt,
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

  // Everything found, for browsing: the three plans are a starting point, not
  // the whole pool. Same chain/price choice as the plans; ticketed things and
  // low-ranked places are shown here (with their reasons) even though no plan
  // picks them by itself — the household can add any of them.
  const browse = pool
    .filter((c) => !excludedSet.has(c.key) && !c.fixed && eventInsideWindow(c, trip))
    .filter((c) => c.shortlisted || pinnedSet.has(c.key) || ((includeChains || !c.chain) && priceOk(c, pricePoint)))
    .sort((a, b) => (isEvent(a) && isEvent(b) ? new Date(a.startsAt) - new Date(b.startsAt) : (b.score ?? 0) - (a.score ?? 0)))
    .map((c) => ({ ...richFields(c, base), dwellMinutes: dwellFor(c, household, attendees).minutes, pinned: pinnedSet.has(c.key), score: c.score ?? null }));
  // Capped per group, so a city centre's hundreds of cafés never crowd out the things to do.
  const browseCapped = [
    ...browse.filter((b) => b.category === 'event').slice(0, 40),
    ...browse.filter((b) => isActivity(b) && b.category !== 'event').slice(0, 60),
    ...browse.filter((b) => isFood(b)).slice(0, 60),
    ...browse.filter((b) => !isActivity(b) && !isFood(b)).slice(0, 20),
  ];

  const hiddenChains = pool.filter((c) => c.chain && !c.fixed && !c.shortlisted && !pinnedSet.has(c.key) && !excludedSet.has(c.key) && !includeChains).length;
  return { options, browse: browseCapped, poolSize: usable.length, target, hiddenChains, pricePoint, includeChains };
}

/** The facts a card needs, in one shape for plan stops and for browsing. */
function richFields(s, base) {
  return {
    id: s.key,
    venueRef: `${s.source}:${s.sourcePlaceId}`,
    name: s.name,
    category: s.category,
    lat: s.lat,
    lng: s.lng,
    reasons: s.reasons ?? [],
    justification: s.justification ?? null,
    startsAt: s.startsAt ?? null,
    endsAt: s.endsAt ?? null,
    fixed: Boolean(s.fixed),
    ticketed: Boolean(s.ticketed),
    venueName: s.venueName ?? null,
    externalUrl: s.externalUrl ?? null,
    shortlisted: Boolean(s.shortlisted),
    // What kind of place, how it is rated and by whom, what it costs, how far
    // it is — so a card can say more than a name and a reason.
    source: s.source,
    cuisines: s.cuisines ?? [],
    experiences: s.experiences ?? [],
    rating: s.rating ?? null,
    ratingCount: s.ratingCount ?? null,
    ratingSource: s.rating != null ? (s.provenance?.rating?.source ?? s.source) : null,
    priceLevel: s.priceLevel ?? null,
    chain: Boolean(s.chain),
    brand: s.brand ?? null,
    goodForChildren: s.goodForChildren ?? null,
    menuForChildren: s.menuForChildren ?? null,
    address: s.address ?? null,
    website: s.website ?? null,
    summary: s.summary ?? null,
    openingHours: s.openingHours ?? null,
    distanceKm: s.lat != null && base?.lat != null ? Number(kmBetween(base, s).toFixed(1)) : null,
    travelFromBaseMinutes: typeof s.travelMinutes === 'number' ? Math.round(s.travelMinutes) : null,
    attribution: s.attributionText ?? s.attribution ?? null,
    // One licensed photo reference (never the bytes); the web fetches it through /api/photos.
    photos: (s.photos ?? []).slice(0, 1),
  };
}

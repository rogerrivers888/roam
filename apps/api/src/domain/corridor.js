// What is worth stopping for on the way (Epic 4 C2, Requirements §5 "Corridor").
//
// A day out is a journey, not a destination: the two hours to Bath pass a lot
// of places, and none of them are visible in a search around Bath. This module
// takes the pool found along the route and decides which of them are worth the
// interruption — a small number, or none at all.
//
// Two things are deliberate here (owner, 4 Sep 2026):
//   • A stop is proposed only when it is *particularly good* for what it costs
//     — the bar rises with the detour, and somewhere the household already
//     loves clears it whatever it costs. An ordinary pub eight minutes off the
//     road is not a reason to break a journey, so it is listed under "also on
//     the way" and never planned in by itself.
//   • What each stop costs is always shown. The corridor is a bias, not a
//     restriction: neither Google's along-route ranking nor a sampled circle
//     guarantees a place sits on the road (Requirements §4).
//
// Nothing here calls a provider; detour minutes are handed in, measured by the
// routing source where it is on and estimated where it is not.

import { wallClock } from './time.js';

// How far off the road is still "on the way", by how you are travelling.
export const MAX_DETOUR_MINUTES = { driving: 15, transit: 20, cycling: 10, walking: 8 };
// The most a journey may grow either way for stops, however good they are.
const MAX_ADDED_MINUTES_PER_LEG = 120;
// A stop on the way is a break in a journey, not a visit: the household's usual
// two and a half hours at an attraction is what they do when they have gone
// somewhere, not what they do with a castle beside the motorway.
const BREAK_MINUTES = { food: 90, thing: 75 };

const FOOD = new Set(['restaurant', 'cafe', 'pub', 'bar']);
const ACTIVITY = new Set(['attraction', 'event']);

// Meals, in hours of the local clock. A place is only planned in as a meal if
// you would be passing it near the right time — nobody wants lunch at 09:40.
const MEALS = [
  { name: 'breakfast', from: 7.5, to: 10, categories: ['cafe', 'restaurant'] },
  { name: 'lunch', from: 11.5, to: 14.5, categories: ['restaurant', 'pub', 'cafe'] },
  { name: 'dinner', from: 17, to: 20.5, categories: ['restaurant', 'pub'] },
];

const mealAt = (date, tz, category) => {
  const h = wallClock(date, tz).hours;
  return MEALS.find((m) => h >= m.from && h <= m.to && m.categories.includes(category)) ?? null;
};

/**
 * Why this place, and not the other forty, is worth breaking a journey for.
 * Returns the sentence to show, or null when it is merely somewhere to stop.
 *
 * The bar rises with what the stop costs. Something on the road itself needs
 * only to be good; something at the far edge of the corridor has to be very
 * good indeed, because fifteen minutes each way is a real piece of the day.
 * Somewhere the household already loves clears any bar.
 */
export function standoutReason(c, detourMinutes = 0, limitMinutes = 15) {
  if (c.special) return 'One of yours — you marked it special';
  if ((c.reasons || []).some((r) => r.kind === 'learned-like')) return (c.reasons.find((r) => r.kind === 'learned-like') || {}).text ?? 'Loved before';
  const r = c.rating;
  const n = c.ratingCount ?? 0;
  if (r == null || n < 100) return null;
  const far = Math.min(1, Math.max(0, detourMinutes) / Math.max(1, limitMinutes));
  const needsRating = 4.2 + far * 0.5;
  const needsReviews = 150 + far * 650;
  if (r < needsRating || n < needsReviews) return null;
  return `${r} from ${n.toLocaleString('en-GB')} reviews${detourMinutes <= 3 ? ', right by the road' : ''}`;
}

/**
 * Decide the stops.
 *
 * `candidates` are already ranked and constrained (allergens have excluded,
 * tastes have ranked), and each carries:
 *   detourMinutes   what it adds between the two ends
 *   alongFraction   0–1, how far into the journey it sits
 *   detourEstimated whether that number was measured or estimated
 *
 * Returns the legs out and back, each with the stops proposed and what they
 * cost, plus everything else in the corridor as `more` for the household to
 * pick from itself.
 */
export function corridorStops({
  candidates, mode = 'driving', journeyMinutes, windowStart, windowEnd, timezone = 'Europe/London',
  dwellFor = () => 45, includeChains = false, maxPerLeg = 2, maxMore = 8, earliestHour = 6.5,
}) {
  const limit = MAX_DETOUR_MINUTES[mode] ?? 15;
  const out = [];
  const back = [];
  const more = [];
  const seen = new Set();

  // When they would actually be there. The time asked for at the destination
  // does not move, so a stop on the way out is paid for by leaving home
  // earlier — which is why a stop is timed backwards from the window and not
  // forwards from a departure that the stop itself changes.
  const when = (leg, fraction, detour, dwell) => (leg === 'out'
    ? new Date(new Date(windowStart).getTime() - (journeyMinutes * (1 - fraction) + detour / 2 + dwell) * 60_000)
    : new Date(new Date(windowEnd).getTime() + (journeyMinutes * (1 - fraction) + detour / 2) * 60_000));
  const leavingHomeFor = (fraction, detour, dwell) => new Date(new Date(windowStart).getTime() - (journeyMinutes + detour + dwell) * 60_000);

  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const detour = Math.round(c.detourMinutes ?? 0);
    const isFood = FOOD.has(c.category);
    const isThing = ACTIVITY.has(c.category);
    const dwell = Math.min(dwellFor(c), isFood ? BREAK_MINUTES.food : BREAK_MINUTES.thing);
    const standout = standoutReason(c, detour, limit);
    const tooFar = detour > limit;
    const banned = c.chain && !includeChains;

    // Which leg it could belong to, and why.
    // Food goes on whichever leg passes it at a mealtime — the way there for
    // lunch, the way home for dinner. Things to do only go on the way there:
    // they are shut by the time a day out is heading home.
    const f = c.alongFraction ?? 0.5;
    const atOut = when('out', f, detour, dwell);
    const atBack = when('back', f, detour, dwell);
    // Getting up at five for a pub lunch is not a day out: a stop that drags
    // the departure into the small hours is offered, never proposed.
    const tooEarly = wallClock(leavingHomeFor(f, detour, dwell), timezone).hours < earliestHour;
    const legs = [];
    if (isFood) {
      const outMeal = tooEarly ? null : mealAt(atOut, timezone, c.category);
      const backMeal = mealAt(atBack, timezone, c.category);
      if (outMeal) legs.push({ leg: 'out', why: `${outMeal.name[0].toUpperCase()}${outMeal.name.slice(1)} on the way`, meal: outMeal.name });
      if (backMeal) legs.push({ leg: 'back', why: `${backMeal.name[0].toUpperCase()}${backMeal.name.slice(1)} on the way home`, meal: backMeal.name });
    } else if (isThing && !tooEarly) {
      legs.push({ leg: 'out', why: 'Worth stopping for on the way', meal: null });
    }

    // Room on the leg: never two meals or two attractions on the same leg, and
    // never more added time than the journey can carry.
    const list = legs.length ? (legs[0].leg === 'out' ? out : back) : null;
    const addedSoFar = list ? list.reduce((t, s) => t + s.detourMinutes + s.dwellMinutes, 0) : 0;
    const room = Boolean(list) && list.length < maxPerLeg
      && addedSoFar + detour + dwell <= MAX_ADDED_MINUTES_PER_LEG
      && !list.some((s) => (FOOD.has(s.category) && isFood) || (ACTIVITY.has(s.category) && isThing));

    const stop = {
      ...c,
      detourMinutes: detour,
      dwellMinutes: dwell,
      leg: legs[0]?.leg ?? 'out',
      meal: legs[0]?.meal ?? null,
      why: legs[0]?.why ?? (isFood ? 'Somewhere to eat on the way' : 'On the way'),
      standout,
      passAt: (legs[0]?.leg === 'back' ? atBack : atOut).toISOString(),
    };

    if (standout && !tooFar && !banned && legs.length && room) {
      (legs[0].leg === 'out' ? out : back).push(stop);
      continue;
    }
    // Everything else in the corridor is offered, not planned: the reason it
    // was not proposed is the reason shown.
    if (more.length < maxMore && (isFood || isThing) && !banned) {
      const why = tooFar ? `${detour} min off the road`
        : !standout ? (detour > 3 ? `Not enough to be worth ${detour} min off the road` : 'Nothing marks it out')
        : tooEarly ? `You would have to leave home at ${wallClock(leavingHomeFor(f, detour, dwell), timezone).hhmm}`
        : !legs.length ? 'Not at a time you would stop'
        : 'The leg is full';
      more.push({ ...stop, notProposed: why });
    }
  }

  const legTotals = (list) => list.reduce((t, s) => t + s.detourMinutes + s.dwellMinutes, 0);
  return {
    out, back, more,
    addedOutMinutes: legTotals(out),
    addedBackMinutes: legTotals(back),
    limitMinutes: limit,
  };
}

/**
 * The clock, once the chosen stops are in: when to leave home, when each stop
 * happens, and when the day gets back. The window at the destination is left
 * exactly as the household set it — a stop on the way makes the day longer at
 * its ends, it does not eat the time they asked for.
 */
export function scheduleCorridor({ stops, journeyMinutes, windowStart, windowEnd }) {
  // On the way out the journey is walked from home; on the way back from the
  // destination, so the same fractions are read from the far end. Each stop
  // costs half its detour leaving the road and half rejoining it, which is
  // what makes the legs add up to the journey plus everything the stops added.
  const leg = (fromFraction, toFraction, leavingDetour, joiningDetour) =>
    Math.max(1, Math.round(journeyMinutes * Math.abs(toFraction - fromFraction) + leavingDetour / 2 + joiningDetour / 2));

  const walk = (list, startAt, startFraction, endFraction) => {
    let clock = new Date(startAt).getTime();
    let at = startFraction;
    let lastDetour = 0;
    const timed = list.map((s) => {
      const arrive = new Date(clock + leg(at, s.alongFraction ?? 0.5, lastDetour, s.detourMinutes) * 60_000);
      const leave = new Date(arrive.getTime() + s.dwellMinutes * 60_000);
      clock = leave.getTime();
      at = s.alongFraction ?? 0.5;
      lastDetour = s.detourMinutes;
      return { ...s, arriveAt: arrive.toISOString(), leaveAt: leave.toISOString() };
    });
    return { timed, endsAt: new Date(clock + leg(at, endFraction, lastDetour, 0) * 60_000) };
  };

  const outStops = stops.filter((s) => s.leg === 'out').sort((a, b) => (a.alongFraction ?? 0) - (b.alongFraction ?? 0));
  const backStops = stops.filter((s) => s.leg === 'back').sort((a, b) => (b.alongFraction ?? 0) - (a.alongFraction ?? 0));
  const addedOut = outStops.reduce((t, s) => t + s.detourMinutes + s.dwellMinutes, 0);
  const leaveHome = new Date(new Date(windowStart).getTime() - (journeyMinutes + addedOut) * 60_000);

  const out = walk(outStops, leaveHome, 0, 1);
  const back = walk(backStops, windowEnd, 1, 0);
  return { leaveHomeAt: leaveHome.toISOString(), backHomeAt: back.endsAt.toISOString(), out: out.timed, back: back.timed };
}

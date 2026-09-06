// Somewhere to sleep, ranked by how close it is to what the household is
// actually going to do.
//
// The point of this, and the reason it is not a list of hotels sorted by
// distance from a station: once there is a shortlist, "near the city centre" is
// the wrong question. The right one is "how much of our week is on foot from
// the front door", and Roam is the only thing that knows the answer, because
// only Roam holds the shortlist (owner, 4 Sep 2026: "one of the key upsells
// that we have is that we can choose accommodation that's close to the
// activities").
//
// Prices and availability are not here. They come from a booking provider with
// a key and a spend cap, which is the owner's to add (CLAUDE.md); until then
// this is the open map's own list of beds, and what it is good for is the
// geography, which is the part that actually needs Roam.

import { kmBetween, estimateTravelMinutes } from './travel.js';

/** Anything past this on foot is somewhere you would get a taxi to. */
export const WALK_MINUTES = 20;

/**
 * @param stays    candidate beds, each {lat,lng,...}
 * @param anchors  the places the household means to go: [{lat,lng,label}]
 * @param centre   the middle of the city, for when there are no anchors yet
 * @param mode     how they will get about — 'walking' when there is no car
 */
export function rankStays(stays, { anchors = [], centre = null, mode = 'walking', walkMinutes = WALK_MINUTES, availabilityFirst = false } = {}) {
  return stays
    .map((s) => {
      const toCentre = centre ? kmBetween(centre, s) : null;
      const legs = anchors.map((a) => ({ label: a.label, minutes: estimateTravelMinutes(s, a, mode), km: kmBetween(s, a) }));
      const sorted = [...legs].sort((a, b) => a.minutes - b.minutes);
      // The middle leg, not the average: one thing on the far side of town
      // should not condemn a hotel that is on the doorstep of everything else.
      const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)].minutes : null;
      const withinWalk = legs.filter((l) => l.minutes <= walkMinutes).length;
      return {
        ...s,
        distanceKm: toCentre == null ? null : Number(toCentre.toFixed(2)),
        // What the row says: "8 min walk from 4 of your 5 plans".
        plansNear: withinWalk,
        plansTotal: legs.length,
        typicalMinutes: median,
        farthest: sorted.length ? sorted[sorted.length - 1] : null,
        nearest: sorted.length ? sorted[0] : null,
      };
    })
    .sort((a, b) => {
      // Somewhere with no room free on those nights is not a worse option; it
      // is not an option. Sorting it above a hotel you can actually book buries
      // the answer — Bath returned forty beds, four of them bookable, and every
      // one of the four was below the fold (owner, 5 Sep 2026: "There are no
      // pictures or prices").
      //
      // This is availability, not price: what a room costs still never enters
      // the sort, and among the bookable ones the order is the same walk-first
      // order it always was.
      if (availabilityFirst && Boolean(a.offer) !== Boolean(b.offer)) return a.offer ? -1 : 1;
      if (a.plansTotal) {
        // How much of the week is on foot, then how far the typical leg is.
        if (b.plansNear !== a.plansNear) return b.plansNear - a.plansNear;
        if (a.typicalMinutes !== b.typicalMinutes) return a.typicalMinutes - b.typicalMinutes;
      }
      // Nothing shortlisted yet: the middle of town is the best guess there is.
      return (a.distanceKm ?? 99) - (b.distanceKm ?? 99);
    });
}

/** The point that is nearest to all of them at once — where to search from. */
export function middleOf(points) {
  if (!points.length) return null;
  return {
    lat: points.reduce((a, p) => a + p.lat, 0) / points.length,
    lng: points.reduce((a, p) => a + p.lng, 0) / points.length,
  };
}

// ---------------------------------------------------------------------------
// who is sleeping in the room
// ---------------------------------------------------------------------------

/** A hotel counts a child up to eighteen, whatever Roam's own `is_minor` line is. */
export const HOTEL_ADULT_AGE = 18;
// Only used for somebody the household has told us is a child without saying
// when they were born. Never silent: the answer names them so the screen can
// say "we asked for Nina at 10 — change it" (owner: ask, do not guess).
export const ASSUMED_CHILD_AGE = 10;

/** Somebody's age on a given day, from whichever of the birth date or the birth year we hold. */
export function ageOn(member, isoDate) {
  const on = new Date(`${String(isoDate ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(+on)) return null;
  if (member.birth_date) {
    const b = new Date(`${String(member.birth_date).slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(+b)) return null;
    let age = on.getUTCFullYear() - b.getUTCFullYear();
    const had = on.getUTCMonth() > b.getUTCMonth() || (on.getUTCMonth() === b.getUTCMonth() && on.getUTCDate() >= b.getUTCDate());
    return had ? age : age - 1;
  }
  // A birth year alone cannot say whether the birthday has been: the younger of
  // the two answers is the safer one, because a hotel that is told a child is
  // nine and meets a ten-year-old charges the difference at the desk, and a
  // hotel told ten never quotes the child rate at all.
  if (member.birth_year) return Math.max(0, on.getUTCFullYear() - Number(member.birth_year) - 1);
  return null;
}

/**
 * The party a room is priced for: how many adults, and how old each child is.
 *
 * Nobody coming is not zero people — it is a household that has not said who is
 * coming yet, and the honest default there is two adults, which is what the
 * screen shows and what they can change.
 */
export function partyForStay(members = [], { on = null } = {}) {
  const adults = [];
  const childAges = [];
  const assumed = [];
  for (const m of members) {
    const age = ageOn(m, on);
    if (age != null && age < HOTEL_ADULT_AGE) { childAges.push(age); continue; }
    if (age == null && m.is_minor) { childAges.push(ASSUMED_CHILD_AGE); assumed.push(m.name); continue; }
    adults.push(m.name);
  }
  if (!adults.length && !childAges.length) return { adults: 2, childAges: [], assumed: [], derived: false };
  // A room of children and no adult is not a booking anybody takes.
  return { adults: Math.max(1, adults.length), childAges: childAges.sort((a, b) => a - b), assumed, derived: true };
}

// ---------------------------------------------------------------------------
// where the middle of five plans actually is
// ---------------------------------------------------------------------------

/**
 * The point with the least total travel to every plan — the geometric median.
 *
 * `middleOf` above is the mean, and the mean is not the middle. Five plans in
 * Bath and one day trip to Bristol drag the mean a third of the way to Bristol,
 * and a hotel there is a bad hotel for five days out of six. The median barely
 * moves: it is the point that minimises the *sum* of the distances rather than
 * the sum of their squares, so one outlier pulls on it once instead of once per
 * mile (owner, 6 Sep 2026: "If there's one that's in the centre of them all,
 * that would be better").
 *
 * There is no closed form, so this is Weiszfeld's algorithm: start at the mean,
 * then repeatedly move to the average of the points weighted by one over their
 * distance. It converges in a handful of passes on the scale of a city, and
 * "handful of passes over six points" is microseconds — there is no call, no
 * provider and nothing to wait for.
 */
export function centreOfPlans(points, { passes = 60, tolerance = 1e-7 } = {}) {
  if (!points?.length) return null;
  if (points.length <= 2) return middleOf(points);

  // Longitude degrees are narrower than latitude ones everywhere but the
  // equator, so they are scaled before any distance is taken and the answer is
  // scaled back at the end. Without it the median drifts east-west in Britain
  // by about a third.
  const k = Math.cos((points.reduce((a, p) => a + p.lat, 0) / points.length) * Math.PI / 180) || 1;
  const pts = points.map((p) => ({ x: p.lng * k, y: p.lat }));

  let x = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  let y = pts.reduce((a, p) => a + p.y, 0) / pts.length;

  for (let pass = 0; pass < passes; pass += 1) {
    let wx = 0; let wy = 0; let w = 0;
    for (const p of pts) {
      // Landing exactly on a plan would divide by nothing. A metre is far below
      // the precision anyone can act on and keeps the arithmetic finite.
      const d = Math.max(Math.hypot(p.x - x, p.y - y), 1e-9);
      const weight = 1 / d;
      wx += p.x * weight; wy += p.y * weight; w += weight;
    }
    const nx = wx / w; const ny = wy / w;
    const moved = Math.hypot(nx - x, ny - y);
    x = nx; y = ny;
    if (moved < tolerance) break;
  }
  return { lat: y, lng: x / k };
}

/**
 * Can anywhere be within `minutes` of everything, and if so which?
 *
 * The honest answer is sometimes no, and a wizard that offers "within 15
 * minutes of all my plans" over five towns is offering something that does not
 * exist. So this reports what is reachable rather than filtering silently: the
 * beds that clear the bar, and — when none do — the best that any bed manages,
 * which is the number the screen should offer instead.
 */
export function withinOfAll(ranked, minutes) {
  const reach = (s) => s.farthest?.minutes ?? null;
  const all = ranked.filter((s) => s.plansTotal > 0 && reach(s) != null);
  if (!all.length) return { beds: ranked, bestMinutes: null, achievable: true };
  const beds = all.filter((s) => reach(s) <= minutes);
  const bestMinutes = Math.min(...all.map(reach));
  return { beds, bestMinutes, achievable: beds.length > 0 };
}

// ---------------------------------------------------------------------------
// what may be asked for here
// ---------------------------------------------------------------------------

/**
 * The must-haves worth putting on screen, counted from the beds themselves.
 *
 * The alternative was a rule per amenity — "sea view needs a coast within so
 * many miles" — and that way lies an endless list of rules, each wrong at its
 * edges, and none of them able to answer the question the household is actually
 * asking, which is "what will this cost me". Counting the pool answers both at
 * once: a facility no bed near Thorpe Park has is a chip that never appears, no
 * rule about Thorpe Park was written, and every chip that does appear carries
 * the number of beds still standing if you tick it.
 *
 * It costs nothing. The pool is already fetched and already in memory; this is
 * a loop over it.
 */
export function whatIsOnOffer(beds, { facilities = new Map(), hotelTypes = new Map(), minimum = 1 } = {}) {
  const countBy = (pick, names) => {
    const n = new Map();
    for (const bed of beds) for (const id of pick(bed)) n.set(id, (n.get(id) ?? 0) + 1);
    return [...n.entries()]
      .filter(([id, count]) => count >= minimum && names.has(id))
      .map(([id, count]) => ({ id, label: names.get(id), count }))
      // Commonest first: the chip most people will want is the one that costs
      // them least, and the rare ones are the ones worth thinking about.
      .sort((a, b) => b.count - a.count || String(a.label).localeCompare(b.label));
  };
  return {
    facilities: countBy((b) => b.facilityIds ?? [], facilities),
    types: countBy((b) => (b.hotelTypeId ? [b.hotelTypeId] : []), hotelTypes),
    of: beds.length,
  };
}

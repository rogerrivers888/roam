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

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
export function rankStays(stays, { anchors = [], centre = null, mode = 'walking', walkMinutes = WALK_MINUTES } = {}) {
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

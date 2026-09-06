// Travel time and catchment.
//
// PROTOTYPE IMPLEMENTATION. Requirements §5 is explicit that a catchment is the
// area *genuinely reachable* by the transport network, not a radius — and
// Technical Constraints §6.2 records that TravelTime is the only provider
// returning transit isochrones from timetabled data. Neither an account nor a
// price exists yet (§16 item 2), so this module approximates travel time from
// straight-line distance and a per-mode speed, with a detour factor.
//
// It is deliberately isolated behind estimateTravelMinutes/deriveCatchment so
// that swapping in a real isochrone provider touches this file only. Every
// response that uses it is flagged `estimated: true` so the UI can say so.

export const TRAVEL_MODES = ['walking', 'cycling', 'driving', 'transit'];

// Effective door-to-door speeds in km/h, including the usual overheads.
//
// `kmh` is the speed of a short hop through a town; `openKmh` the speed a long
// run settles at once the dual carriageway starts. A journey is somewhere
// between the two, and `rampKm` says how quickly it gets there — at rampKm the
// journey is running at half the difference.
const MODE_PROFILE = {
  walking: { kmh: 4.8, openKmh: 4.8, rampKm: 1, detourFactor: 1.15, fixedOverheadMinutes: 0 },
  cycling: { kmh: 15, openKmh: 18, rampKm: 8, detourFactor: 1.2, fixedOverheadMinutes: 2 },
  driving: { kmh: 28, openKmh: 58, rampKm: 12, detourFactor: 1.25, fixedOverheadMinutes: 5 },
  // Wait time is why a transit isochrone is lumpy rather than circular. A real
  // provider derives this from the timetable at the outing time (Epic 3 C2).
  transit: { kmh: 22, openKmh: 45, rampKm: 10, detourFactor: 1.35, fixedOverheadMinutes: 8 },
};

/**
 * How fast a journey of this length goes.
 *
 * This was two speeds and a step — a town speed below fifteen kilometres and an
 * open-road speed above it — and the step is a bug you can see from orbit
 * (owner, 6 Sep 2026: a twenty-mile run to Crystal Palace came back with one
 * restaurant and no activities). A detour splits one journey into two shorter
 * legs, so the legs land on the town side of the step while the journey itself
 * is on the open side: 14.9km scored 45 minutes and 15.1km scored 26. A place
 * standing *on the road* halfway along a 38km drive came out 24 minutes off it,
 * and the corridor threw away everything but the few metres either side of the
 * exact midpoint.
 *
 * A speed that climbs smoothly with the distance has no step to fall off, so
 * two legs and the journey they replace are measured on the same curve.
 */
const speedFor = (profile, km) =>
  profile.kmh + (profile.openKmh - profile.kmh) * (km / (km + profile.rampKm));

export function kmBetween(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function estimateTravelMinutes(from, to, mode = 'driving') {
  const profile = MODE_PROFILE[mode] || MODE_PROFILE.driving;
  const straight = kmBetween(from, to);
  const km = straight * profile.detourFactor;
  // Beyond city scale, transit means rail: faster, and paid for with a change
  // or two rather than with the wait at one stop.
  const overhead = mode === 'transit' && straight > 8 ? 18 : profile.fixedOverheadMinutes;
  return Math.round((km / speedFor(profile, straight)) * 60 + overhead);
}

/**
 * Restrict candidates to those reachable within maxTravelMinutes of the origin.
 * Returns each candidate annotated with its estimated travel time.
 */
export function deriveCatchment({ origin, maxTravelMinutes, mode, venues }) {
  return venues
    .map((venue) => ({
      ...venue,
      travelMinutes: estimateTravelMinutes(origin, venue, mode),
    }))
    .filter((venue) => venue.travelMinutes <= maxTravelMinutes);
}

/**
 * Additional travel time a stop adds between origin and destination (Epic 4 C2).
 * The corridor is a bias, not a restriction, so this cost is always displayed
 * rather than used to silently filter (Requirements §4).
 */
export function detourMinutes({ origin, destination, venue, mode }) {
  if (!destination) return null;
  const profile = MODE_PROFILE[mode] || MODE_PROFILE.driving;
  const direct = estimateTravelMinutes(origin, destination, mode);
  const viaVenue =
    estimateTravelMinutes(origin, venue, mode) + estimateTravelMinutes(venue, destination, mode);
  // Both legs pay the getting-going overhead and the journey they replace pays
  // it once. Stopping for lunch does not mean starting the car from cold twice,
  // so the second one is given back — otherwise every place on the road, even
  // the one you would drive past anyway, costs five minutes it does not.
  return Math.max(0, viaVenue - direct - profile.fixedOverheadMinutes);
}

/** How far, in km, the mode plausibly reaches in the given minutes — for bounding a source query. */
export function reachRadiusKm(mode, minutes) {
  const profile = MODE_PROFILE[mode] || MODE_PROFILE.driving;
  const usable = Math.max(0, minutes - profile.fixedOverheadMinutes);
  return Math.max(0.5, (usable / 60) * profile.kmh / profile.detourFactor);
}

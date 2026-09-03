// Time budget allocation — Requirements §5, "Time budget allocation".
//
//   1. total          = return time - departure time
//   2. intensity      = the proportion of that total the plan aims to fill
//   3. subtract travel for the planned route, including detours already added
//   4. subtract each stop's time allowance
//   5. what remains is the unallocated budget, shown to the user
//   6. if negative, the plan is over its window and the offending stop is named

import { estimateTravelMinutes } from './travel.js';

// Intensity is a target PROPORTION of available time, never a stop count: a
// count tuned for a four-hour window is absurd in a ten-hour one (§13.8).
export const INTENSITY_TARGETS = {
  relaxed: 0.55,
  balanced: 0.75,
  packed: 0.92,
};

/**
 * Where the day ends. A trip with a destination ends there ("from here to
 * there"); a trip without one returns to its origin.
 */
function endPoint(trip) {
  if (trip.destination_lat != null && trip.destination_lng != null) {
    return { lat: trip.destination_lat, lng: trip.destination_lng, label: trip.destination_label };
  }
  return { lat: trip.origin_lat, lng: trip.origin_lng, label: trip.origin_label };
}

export function computeBudget({ trip, stops, household }) {
  const totalMinutes = Math.round((new Date(trip.return_at) - new Date(trip.depart_at)) / 60_000);
  const mode = trip.travel_mode;
  const origin = { lat: trip.origin_lat, lng: trip.origin_lng };
  const end = endPoint(trip);
  const ordered = [...stops].sort((a, b) => a.position - b.position);

  const legs = [];
  let cursor = origin;
  let cursorLabel = trip.origin_label;

  for (const stop of ordered) {
    const point = { lat: stop.lat, lng: stop.lng };
    legs.push({ from: cursorLabel, to: stop.venue_name, minutes: estimateTravelMinutes(cursor, point, mode) });
    cursor = point;
    cursorLabel = stop.venue_name;
  }

  // The final leg is part of the window: a plan that gets you there but not
  // to where the day ends has not been planned.
  const closesLoop = end.lat !== origin.lat || end.lng !== origin.lng || ordered.length > 0;
  if (closesLoop) {
    legs.push({ from: cursorLabel, to: end.label, minutes: estimateTravelMinutes(cursor, end, mode) });
  }

  const travelMinutes = legs.reduce((sum, leg) => sum + leg.minutes, 0);
  const dwellMinutes = ordered.reduce((sum, stop) => sum + stop.dwell_minutes, 0);
  const allocatedMinutes = travelMinutes + dwellMinutes;
  const remainingMinutes = totalMinutes - allocatedMinutes;

  const targetFill = INTENSITY_TARGETS[trip.intensity] ?? INTENSITY_TARGETS.balanced;
  const targetMinutes = Math.round(totalMinutes * targetFill);

  // Which stop tips the plan over the window (Epic 4 C4): walk the plan in
  // order and name the first stop whose addition exceeds the available time.
  let overrunStop = null;
  if (remainingMinutes < 0) {
    let running = 0;
    for (let i = 0; i < ordered.length; i += 1) {
      running += legs[i].minutes + ordered[i].dwell_minutes;
      const toEnd = estimateTravelMinutes({ lat: ordered[i].lat, lng: ordered[i].lng }, end, mode);
      if (running + toEnd > totalMinutes) {
        overrunStop = { id: ordered[i].id, name: ordered[i].venue_name, position: ordered[i].position };
        break;
      }
    }
  }

  const maxTravelMinutes = household?.max_travel_minutes ?? null;

  return {
    totalMinutes,
    travelMinutes,
    dwellMinutes,
    allocatedMinutes,
    remainingMinutes,
    targetFill,
    targetMinutes,
    fillRatio: totalMinutes > 0 ? Number((allocatedMinutes / totalMinutes).toFixed(2)) : 0,
    legs,
    overrun: remainingMinutes < 0,
    overrunStop,
    // Epic 4 C6 — the household's tolerance for time spent travelling is a
    // separate limit from the window itself.
    exceedsMaxTravel: maxTravelMinutes != null && travelMinutes > maxTravelMinutes,
    maxTravelMinutes,
    estimated: true,
  };
}

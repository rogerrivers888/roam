// A day of a trip, seen as the single-window "trip" the budget and options
// engines already understand: base → stops → base, between the day's start
// and end times, at the day's pace and mode.

export function slotFor(isoOrDate) {
  const h = new Date(isoOrDate).getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

const toIso = (date, time) => new Date(`${date}T${(time || '09:30').slice(0, 5)}:00`).toISOString();

/** Build the trip-shaped object the budget/options engines consume for one day. */
export function dayAsTrip(trip, day) {
  const start = day.start_time || trip.day_start || '09:30';
  const end = day.end_time || trip.day_end || '21:00';
  return {
    id: trip.id,
    day_id: day.id,
    title: trip.title,
    origin_label: trip.base_label || trip.origin_label,
    origin_lat: trip.base_lat ?? trip.origin_lat,
    origin_lng: trip.base_lng ?? trip.origin_lng,
    destination_label: null,
    destination_lat: null,
    destination_lng: null,
    depart_at: toIso(day.date, start),
    return_at: toIso(day.date, end),
    travel_mode: day.travel_mode || trip.travel_mode || (trip.has_car ? 'driving' : 'transit'),
    intensity: day.intensity || trip.intensity || 'balanced',
    country: trip.country,
    country_code: trip.country_code,
    locality: trip.locality,
  };
}

/** Every date from start to end inclusive, as YYYY-MM-DD. */
export function datesBetween(startDate, endDate) {
  const out = [];
  const d = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (d <= end && out.length < 60) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

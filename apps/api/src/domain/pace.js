// Pace by kind of stop, with a "special" exception (owner feedback, 3 Sep 2026).
//
// Eating and doing have different rhythms: a restaurant is an hour and worth a
// 30-minute drive (45 if it's special); an activity is a couple of hours and
// worth an hour's travel — or three for something the household would go a
// long way for. A preference can also cap a stop ("walks, up to 40 minutes").

import { conceptByKey, venueHasConcept } from './concepts.js';

export const FOOD_CATEGORIES = new Set(['restaurant', 'cafe', 'pub', 'bar']);
export const kindOf = (venue) => (FOOD_CATEGORIES.has(venue?.category) ? 'food' : 'activity');

export const DEFAULT_PACE = {
  food: { typicalMinutes: 60, maxMinutes: 120, maxTravelMinutes: 30, maxTravelIfSpecialMinutes: 45 },
  activity: { typicalMinutes: 150, maxMinutes: 360, maxTravelMinutes: 60, maxTravelIfSpecialMinutes: 180 },
};

/** The household's pace, falling back to the older single-number defaults, then to ours. */
export function paceOf(household) {
  const stored = household?.pace || {};
  const legacyFood = {
    typicalMinutes: household?.default_visit_minutes ?? DEFAULT_PACE.food.typicalMinutes,
    maxTravelMinutes: household?.max_travel_minutes ?? DEFAULT_PACE.food.maxTravelMinutes,
  };
  return {
    food: { ...DEFAULT_PACE.food, ...legacyFood, ...(stored.food || {}) },
    activity: { ...DEFAULT_PACE.activity, ...(stored.activity || {}) },
  };
}

/** How far the household will travel for this venue, in minutes. */
export function travelLimitFor(pace, venue, { special = false } = {}) {
  const p = pace[kindOf(venue)];
  return special || venue?.special ? Math.max(p.maxTravelMinutes, p.maxTravelIfSpecialMinutes) : p.maxTravelMinutes;
}

/** The widest reach any stop could justify — for bounding a source query. */
export function maxReachMinutes(pace, { special = false } = {}) {
  return Math.max(
    ...['food', 'activity'].map((k) => (special ? Math.max(pace[k].maxTravelMinutes, pace[k].maxTravelIfSpecialMinutes) : pace[k].maxTravelMinutes)),
  );
}

// Fixed allowances for quick stops; the household's typical time applies to the rest.
const QUICK = { cafe: 45, bar: 60 };
// Sights and browsing take less than a museum: a viewpoint is half an hour, a
// market or bookshop three quarters, a bath house or statue you look at is 45.
const QUICK_EXPERIENCE = { viewpoint: 30, market: 45, bookshop: 45, shopping: 60 };
const QUICK_LOOK = 45;

/**
 * Time allowance for a stop: the kind's typical time, shortened by any
 * attending member's "up to N minutes" on a matching preference, and never
 * longer than the kind's maximum. Events keep their own length.
 */
export function dwellAllowance(pace, venue, attendees = []) {
  if (venue.category === 'event' && venue.startsAt && venue.endsAt) {
    return { minutes: Math.round((new Date(venue.endsAt) - new Date(venue.startsAt)) / 60_000), cappedBy: null };
  }
  const p = pace[kindOf(venue)];
  let minutes = QUICK[venue.category] ? Math.min(p.typicalMinutes, QUICK[venue.category]) : p.typicalMinutes;
  const quickExp = (venue.experiences || []).map((e) => QUICK_EXPERIENCE[e]).filter(Boolean);
  if (quickExp.length) minutes = Math.min(minutes, Math.max(...quickExp));
  if (venue.quickLook) minutes = Math.min(minutes, QUICK_LOOK);
  let cappedBy = null;
  for (const member of attendees) {
    for (const pref of [...(member.likes || []), ...(member.dislikes || [])]) {
      if (!pref.maxMinutes) continue;
      const concept = pref.conceptKey ? conceptByKey(pref.conceptKey) : null;
      if (concept && venueHasConcept(venue, concept) && pref.maxMinutes < minutes) {
        minutes = pref.maxMinutes;
        cappedBy = { member: member.name, value: pref.value, maxMinutes: pref.maxMinutes };
      }
    }
  }
  return { minutes: Math.min(minutes, p.maxMinutes), cappedBy };
}

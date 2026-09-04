// What kind of place it is, for the atlas (owner, 4 Sep 2026): "there is no
// categorization of what type of restaurant they are… instead we could say the
// type of restaurant, the category Italian or steakhouse".
//
// Open sources (OpenStreetMap, fixtures) already keep their own snapshot on the
// row, so this is only for the licensed ones. Their content is rented, so
// nothing here is written to the database: the kind of place is fetched when it
// is needed and held in memory, like the search cache (Technical Constraints §4).
// The lookup uses the cheapest field mask the provider sells — the taxonomy
// alone, no reviews, photos or hours.

import * as providerCalls from '../repositories/providerCalls.js';
import { googleSource } from './google.js';
import { recallVenue } from './index.js';

const TTL_MS = 7 * 24 * 3600_000;
const MAX = 2000;
const kept = new Map();

const fresh = (hit) => hit && Date.now() - hit.at < TTL_MS;
const has = (v) => Boolean(v && ((v.cuisines?.length ?? 0) || (v.experiences?.length ?? 0)));

/** What is already known about this venue's kind, or null. */
export function taxonomyKept(venueRef) {
  const hit = kept.get(venueRef);
  return fresh(hit) ? hit.value : null;
}

function remember(venueRef, value) {
  kept.delete(venueRef);
  kept.set(venueRef, { at: Date.now(), value });
  while (kept.size > MAX) kept.delete(kept.keys().next().value);
}

/**
 * True when a row would show nothing but its category ("Restaurants") and the
 * source could say more. A row whose own snapshot already carries cuisines or
 * experiences is left alone.
 */
export function needsTaxonomy(row) {
  if (has(row.venue)) return false;
  if (taxonomyKept(row.venue_ref)) return false;
  return String(row.venue_ref).startsWith('google:');
}

/** Ask the source what kind of place this is, cheaply, and remember it. */
export async function taxonomyFor(venueRef, { householdId = null } = {}) {
  const cached = taxonomyKept(venueRef);
  if (cached) return cached;
  const recalled = recallVenue(venueRef);
  if (has(recalled)) {
    const value = { cuisines: recalled.cuisines ?? [], experiences: recalled.experiences ?? [] };
    remember(venueRef, value);
    return value;
  }
  const [source, ...rest] = String(venueRef).split(':');
  if (source !== 'google') return null;
  const value = await googleSource.types(rest.join(':'));
  if (!value) return null;
  remember(venueRef, value);
  await providerCalls.record(householdId, 'google', 'atlas.types', JSON.stringify({ google: 1 })).catch(() => null);
  return value;
}

/** Fill in the kind of place for rows that only know their category, a few at a time. */
export async function fillTaxonomy(householdId, rows, { limit = 8 } = {}) {
  const todo = rows.filter(needsTaxonomy).slice(0, limit);
  for (const r of todo) {
    try { await taxonomyFor(r.venue_ref, { householdId }); } catch { /* the row keeps its category until the next look */ }
  }
  return todo.length;
}

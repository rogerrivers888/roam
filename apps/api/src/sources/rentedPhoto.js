// A picture for a place we do not own a picture of yet (owner, 5 Sep 2026:
// "can we not then also surface or enhance the data we hold… It means at least
// that we can have restaurant pictures, which is really useful in some
// instances").
//
// The owned ladder (sources/placePicture.js) is the right answer and stays the
// first one: a mark, a Commons photograph, a street-level frame of the front
// door, all ours to keep. But it finds nothing for most restaurants — Commons
// does not photograph the inside of a curry house — and until it does, a row of
// mint squares is what a household actually sees.
//
// So this is the rung below the floor: the provider's own photograph, fetched
// at display and never written down. It is the same bargain the rest of the
// rented layer makes (Technical Constraints §4 — display content, retention
// none), and it is kept honest by three things:
//
//   • Nothing here reaches the database. Held in memory, exactly like the kinds
//     of place in taxonomy.js and the search results in cache.js.
//   • Nothing here reaches a device. `apps/web/src/offline/policy.ts` strips a
//     licensed row's snapshot before IndexedDB, so a card that has a rented
//     picture on the network draws its category icon offline. That is correct:
//     what we rent, we lose when the signal goes.
//   • It is only asked for a place we have nothing of our own for. The day the
//     ladder finds a mark for this restaurant, this stops being called for it.
//   • It prefers a search already paid for. A place the household searched up in
//     the last twelve hours is still in the pool (cache.js), references and all,
//     so the usual way a tile fills costs nothing at all.
//
// The reference is not the photograph. What is held is a name Google will
// exchange for bytes; the bytes are fetched separately through
// /api/photos/google, which holds its own hour-long buffer and bills per fetch.

import * as providerCalls from '../repositories/providerCalls.js';
import { googleSource } from './google.js';
import { venueFromKept } from './cache.js';

// Twelve hours, not the seven days taxonomy.js keeps. A kind of place ("Italian")
// is true for years; a photo reference is a handle the provider reissues, and a
// stale one is a broken tile rather than a slightly old label. The search cache
// settled on the same twelve for the same reason.
const TTL_MS = 12 * 3600_000;
const MAX = 2000;
const kept = new Map();

const fresh = (hit) => hit && Date.now() - hit.at < TTL_MS;

/**
 * The photo references already held for this place, or null.
 *
 * A place looked up and found to have no photograph is remembered as an empty
 * list, which is not the same as null: without that, every read of every list
 * asks the provider again about the same picture-less restaurant, all day.
 */
export function photosKept(venueRef) {
  const hit = kept.get(venueRef);
  return fresh(hit) ? hit.value : null;
}

function remember(venueRef, value) {
  kept.delete(venueRef);
  kept.set(venueRef, { at: Date.now(), value });
  while (kept.size > MAX) kept.delete(kept.keys().next().value);
}

/**
 * True when a row would draw the empty tile and the provider could do better.
 *
 * `hasOwn` is the important argument and the caller must pass it: a place the
 * ladder has already found a mark or a photograph for must never cost a
 * provider call, because we already have the picture and it is better.
 */
export function needsPhoto(venueRef, hasOwn) {
  if (hasOwn) return false;
  if (photosKept(venueRef)) return false;
  return String(venueRef).startsWith('google:');
}

/** Ask the provider what photographs it has, cheaply, and hold the answer. */
export async function photosFor(venueRef, { householdId = null } = {}) {
  const cached = photosKept(venueRef);
  if (cached) return cached;

  // A search that ran in the last twelve hours already carried the references,
  // and asking again for what is in our hands is a billed call for nothing.
  // This is the path that usually answers: somebody looks at Places, then opens
  // the atlas, and the pool that filled the first screen fills the second.
  const searched = venueFromKept(venueRef);
  if (searched?.photos?.length) {
    remember(venueRef, searched.photos);
    return searched.photos;
  }

  const [source, ...rest] = String(venueRef).split(':');
  if (source !== 'google') return null;
  const found = await googleSource.photos(rest.join(':'));
  // Remembered either way — see photosKept. A restaurant with no photograph is
  // a fact about that restaurant, and one worth not re-buying every read.
  remember(venueRef, found ?? []);
  await providerCalls.record(householdId, 'google', 'atlas.photos', JSON.stringify({ google: 1 })).catch(() => null);
  return found;
}

/**
 * Find pictures for the rows that have none, a few at a time.
 *
 * The same shape as fillTaxonomy: it runs after the response has gone, the web
 * asks again shortly, and the rows fill in. A page of sixty places must not
 * become sixty billed calls the moment somebody opens Places, so the limit is
 * the page's worth of what is actually on screen and no more.
 */
export async function fillPhotos(householdId, rows, { limit = 8 } = {}) {
  const todo = rows.filter((r) => needsPhoto(r.venueRef, r.hasOwn)).slice(0, limit);
  for (const r of todo) {
    try { await photosFor(r.venueRef, { householdId }); } catch { /* the row keeps its icon until the next look */ }
  }
  return todo.length;
}

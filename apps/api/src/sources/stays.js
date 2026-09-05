// Beds near a point: the open map's list, and — once there is a key — what the
// rooms actually cost on the nights the household is away.
//
// Hotels do not open and close while somebody is deciding where to stay, and
// Overpass takes its time, so the first look pays for the whole session and
// every adjustment of the radius after it is instant. Prices are the opposite:
// they move, so they are held for minutes, not hours (sources/liteapi.js).
//
// The two lists are merged into one pool before anything is ranked, because
// ranking is Roam's own — how much of the week is on foot from the front door
// (domain/stays.js) — and it has to see every bed at once to be worth anything.
// Where a bed is in both lists the open record wins the row: the name, the
// address and the reference we keep are OpenStreetMap's, which are ours to
// keep, and LiteAPI's contribution is the price, which is not.

import { osmSource, OSM_ATTRIBUTION } from './osm.js';
import { normalise, metresBetween } from './openMatch.js';
import {
  hotelsNear, ratesNear, liteapiEnabled, liteapiKeyKind, nightsBetween,
  LITEAPI_ATTRIBUTION, CURRENCY,
} from './liteapi.js';
import { bedRatesOn } from './index.js';

export { OSM_ATTRIBUTION, LITEAPI_ATTRIBUTION };

const kept = new Map();
const TTL_MS = 6 * 60 * 60_000;
const MAX = 60;

/** Rounded to ~100m so nudging the middle of the plans re-uses the same answer. */
const keyOf = (centre, radiusKm) => `${centre.lat.toFixed(3)},${centre.lng.toFixed(3)}|${radiusKm}`;

/** The open map's beds, held for the afternoon. */
async function openBeds(centre, radiusKm) {
  const key = keyOf(centre, radiusKm);
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { beds: hit.beds, cached: true };
  const found = await osmSource.search({ center: centre, radiusKm, categories: ['stay'], limit: 200 });
  const seen = new Set();
  const beds = [];
  for (const v of found) {
    const ref = `${v.source}:${v.sourcePlaceId}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    beds.push({ ...v, venueRef: ref });
  }
  kept.delete(key);
  kept.set(key, { at: Date.now(), beds });
  while (kept.size > MAX) kept.delete(kept.keys().next().value);
  return { beds, cached: false };
}

// ---------------------------------------------------------------------------
// the same bed, twice
// ---------------------------------------------------------------------------

// A hotel's OSM node is the building; a booking platform's pin is the front
// desk, the car park or the postcode centroid. They are rarely the same point
// and never streets apart — the same reasoning, and the same distance, as
// openMatch.js uses for restaurants.
const MAX_M = 250;

/** Two names for one hotel: equal once the noise is stripped, or one clearly inside the other. */
function nameAgrees(a, b) {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // "Premier" inside "Premier Inn Windsor" is not a match; six characters is
  // about where a hotel's name stops being a word anybody else could use too.
  return short.length >= 6 && long.startsWith(short);
}

/**
 * One pool from two lists.
 *
 * The open bed keeps the row — its ref, its name, its address — and gains the
 * offer. A licensed bed nobody has mapped joins as itself, carrying its own
 * attribution so the screen can credit it on the row it appears on.
 */
export function mergeBeds(open, licensed) {
  const out = open.map((b) => ({ ...b }));
  const taken = new Set();
  for (const bed of licensed) {
    let match = null;
    let best = MAX_M;
    for (let i = 0; i < out.length; i += 1) {
      if (taken.has(i)) continue;
      const m = metresBetween(out[i], bed);
      if (m > best) continue;
      if (!nameAgrees(out[i].name, bed.name)) continue;
      match = i; best = m;
    }
    if (match == null) {
      out.push({ ...bed, offer: bed.offer ?? null });
      continue;
    }
    taken.add(match);
    // What the open record does not hold and the licensed one does: the price,
    // and the identifier a booking would be made against. The name stays OSM's.
    out[match] = {
      ...out[match],
      offer: bed.offer ?? null,
      bookRef: bed.venueRef,
      stars: out[match].stars ?? bed.stars,
      rating: out[match].rating ?? bed.rating,
      reviewCount: out[match].reviewCount ?? bed.reviewCount,
      // The open map almost never has a photograph of a hotel and the booking
      // platform always does, so this is the one field where the licensed
      // record fills a hole rather than duplicating what we already hold.
      photos: out[match].photos?.length ? out[match].photos : bed.photos ?? [],
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// the look itself
// ---------------------------------------------------------------------------

/**
 * Every bed we can see around a point, priced where we can price it.
 *
 * `stay` is the nights and the people: without it — a trip with no dates yet —
 * LiteAPI can still say which hotels are there, but not what they cost, and the
 * answer says so rather than showing an empty column.
 *
 * A licensed source that fails does not fail the look. The open map's beds are
 * the floor: somewhere to sleep with no price on it is still somewhere to
 * sleep, and the screen is told which source went quiet.
 */
export async function bedsNear(centre, radiusKm, { stay = null, meter = null } = {}) {
  // Which source spent the time. Without this, "the Stay tab is slow" is a
  // question nobody can answer without a deploy — and the answer on 5 Sep 2026
  // was neither of the obvious suspects: LiteAPI took two seconds and a pair of
  // dead Overpass mirrors took the other forty (sources/overpass.js).
  const timings = {};
  const clock = async (name, fn) => {
    const at = Date.now();
    try { return await fn(); } finally { timings[name] = Date.now() - at; }
  };

  // The three lookups do not depend on each other and must not wait for each
  // other. The open map, LiteAPI's list of beds and LiteAPI's prices are three
  // questions about the same patch of map — and `POST /hotels/rates` searches by
  // point and radius, not by the hotel ids the other call returns, so there was
  // never a reason to hold it back. Run in series they added up to twenty
  // seconds on a wide ring; run together the wait is the slowest one, not the
  // sum (owner, 5 Sep 2026: "It took more than a minute").
  const openLeg = clock('openMap', () => openBeds(centre, radiusKm));

  if (!bedRatesOn()) {
    const { beds, cached } = await openLeg;
    return {
      beds, cached, calls: 0, timings,
      sources: ['osm'], degraded: [], priced: false, nights: 0,
      currency: null, sandbox: false, reason: liteapiEnabled() ? 'switched_off' : 'no_key',
    };
  }

  const nights = stay ? nightsBetween(stay.checkin, stay.checkout) : 0;
  const hotelsLeg = clock('hotels', () => hotelsNear(centre, radiusKm, { meter }));
  const ratesLeg = nights > 0
    ? clock('rates', () => ratesNear(centre, radiusKm, {
      checkin: stay.checkin, checkout: stay.checkout, occupancies: stay.occupancies, meter,
    }))
    : null;

  // `allSettled`, not `all`: a licensed source that fails must not fail the
  // look. The open map's beds are the floor — somewhere to sleep with no price
  // on it is still somewhere to sleep — and the screen is told which source
  // went quiet.
  const [openGot, hotelsGot, ratesGot] = await Promise.allSettled([openLeg, hotelsLeg, ratesLeg]);

  if (openGot.status === 'rejected') throw openGot.reason;
  const { beds: open, cached: openCached } = openGot.value;

  let calls = 0;
  let cached = openCached;
  const degraded = [];
  let hotels = [];
  let offers = new Map();

  if (hotelsGot.status === 'fulfilled') {
    hotels = hotelsGot.value.hotels;
    if (!hotelsGot.value.cached) { calls += 1; cached = false; }
  } else {
    degraded.push({ source: 'liteapi', error: String(hotelsGot.reason?.message || hotelsGot.reason) });
  }

  if (ratesGot.status === 'fulfilled' && ratesGot.value) {
    offers = ratesGot.value.offers;
    if (!ratesGot.value.cached) { calls += 1; cached = false; }
  } else if (ratesGot.status === 'rejected') {
    degraded.push({ source: 'liteapi-rates', error: String(ratesGot.reason?.message || ratesGot.reason) });
  }

  const licensed = hotels.map((h) => ({ ...h, offer: offers.get(h.sourcePlaceId) ?? null }));
  return {
    beds: mergeBeds(open, licensed),
    cached,
    calls,
    timings,
    sources: hotels.length ? ['osm', 'liteapi'] : ['osm'],
    degraded,
    // Whether a price was asked for at all, which is not the same as whether
    // one came back: a sold-out weekend is a real answer and says "nothing free".
    priced: nights > 0 && Boolean(hotels.length) && !degraded.length,
    nights,
    currency: CURRENCY(),
    sandbox: liteapiKeyKind() === 'sandbox',
    reason: nights > 0 ? null : 'no_dates',
  };
}

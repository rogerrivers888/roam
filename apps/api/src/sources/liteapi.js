// Nuitee Connect (LiteAPI): real beds, at a real price, for a real night.
//
// The Stay tab has always known the one thing only Roam knows — how much of a
// household's week is on foot from a given front door — and never the one thing
// everybody else knows, which is what the room costs. This is that half.
//
// Two calls, deliberately, because LiteAPI splits them:
//
//   GET  /data/hotels   the beds on a patch of map: name, address, coordinates,
//                       star rating, guest score. Static content. Cheap, and it
//                       does not change while somebody is deciding, so it is
//                       held for the afternoon like the open map's own list.
//   POST /hotels/rates  what those beds cost for these dates and these people.
//                       Live inventory. Held for ten minutes and no longer: a
//                       price shown after it has moved is worse than no price.
//
// Rented, all of it. LiteAPI's names, photographs, guest scores and prices are
// theirs; they are fetched at display, never written to `place_records`, never
// to `household_places.venue`, and never to a device (offline/policy.ts does
// not name /api/trips/:id/stays, and must not learn to). When the household
// picks one of these to stay in, the *claim* is theirs and the record we keep
// of it comes from the open map instead (sources/openMatch.js), which is the
// same rule every other licensed source lives under.
//
// Booking is not here. LiteAPI can take a booking end to end (prebook, book,
// cancel), and that spends money and settles it — the owner's to switch on,
// with a payment route and a cap, not an agent's (CLAUDE.md). What is here is
// discovery: what is free, what it costs, and on what cancellation terms.

import { bump } from './meter.js';

const KEY = () => process.env.LITEAPI_KEY?.trim();
const BASE = (process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0').replace(/\/$/, '');

export const LITEAPI_ATTRIBUTION = 'Hotels, prices and availability © Nuitée (LiteAPI)';

/** Whether the key exists. Nothing here runs without one; nothing here throws for want of one. */
export const liteapiEnabled = () => Boolean(KEY());

/**
 * Which key it is, because it changes what the numbers mean. LiteAPI issues
 * `sand_…` for the sandbox, which answers with invented inventory at invented
 * prices, and `prod_…` for the live one. A sandbox price on screen with nothing
 * saying so is a lie, so the answer carries this out to the app.
 */
export function liteapiKeyKind() {
  const k = KEY();
  if (!k) return null;
  if (/^sand/i.test(k)) return 'sandbox';
  if (/^prod/i.test(k)) return 'production';
  return 'unknown';
}

// The household pays in its own money and travels on its own passport; both
// change the price LiteAPI quotes, and neither is guessable from the trip.
// Defaults are the owner's household, overridable without a code change.
export const CURRENCY = () => (process.env.LITEAPI_CURRENCY || 'GBP').toUpperCase();
export const NATIONALITY = () => (process.env.LITEAPI_NATIONALITY || 'GB').toUpperCase();

// LiteAPI's own advice for a live rates request is four to ten seconds; past
// that the Stay tab is better off showing beds with no prices than showing
// nothing at all, so the whole thing is bounded rather than left to hang.
const RATES_TIMEOUT_S = Math.min(10, Math.max(4, Number(process.env.LITEAPI_TIMEOUT_S) || 8));
// How many beds a look considers. The screen shows a dozen; the pool is bigger
// so that ranking by the shortlist has something to rank.
const LIMIT = Math.min(200, Math.max(10, Number(process.env.LITEAPI_LIMIT) || 100));
// Their minimum is a kilometre, and asking for less is an error rather than a
// tighter search.
const MIN_RADIUS_M = 1000;

// ---------------------------------------------------------------------------
// two caches, because the two calls age at completely different rates
// ---------------------------------------------------------------------------

const STATIC_TTL_MS = 6 * 60 * 60_000;
const RATES_TTL_MS = 10 * 60_000;
const MAX_KEPT = 40;

const staticKept = new Map();
const ratesKept = new Map();

/** Rounded to ~100m so nudging the middle of the plans re-uses the same answer. */
const patchKey = (centre, radiusM) => `${centre.lat.toFixed(3)},${centre.lng.toFixed(3)}|${radiusM}`;

function fromCache(store, key, ttl) {
  const hit = store.get(key);
  if (!hit || Date.now() - hit.at > ttl) return null;
  return hit.value;
}
function toCache(store, key, value) {
  store.delete(key);
  store.set(key, { at: Date.now(), value });
  while (store.size > MAX_KEPT) store.delete(store.keys().next().value);
  return value;
}

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

async function call(path, { method = 'GET', query = null, body = null, timeoutMs = 15_000, meter = null } = {}) {
  const key = KEY();
  if (!key) throw new Error('LITEAPI_KEY not set');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, String(v));
  }
  const url = `${BASE}${path}${qs.size ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', 'X-API-Key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Free to call — LiteAPI earns on the booking, not the search — but every
  // outbound call is still attributed (Technical Constraints §2), so the meter
  // counts requests and provider_calls carries them.
  bump(meter, 'liteapi', 1);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`LiteAPI ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// the beds themselves
// ---------------------------------------------------------------------------

const STAY_WORDS = {
  hotel: 'Hotel', apartment: 'Apartment', apartments: 'Apartment', hostel: 'Hostel',
  guest_house: 'Guest house', guesthouse: 'Guest house', bed_and_breakfast: 'B&B',
  resort: 'Resort', motel: 'Motel', villa: 'Villa', lodge: 'Lodge', chalet: 'Chalet',
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** LiteAPI's hotel record, in the shape the rest of Roam speaks (a resolved venue). */
function asVenue(h) {
  const lat = num(h.latitude ?? h.lat);
  const lng = num(h.longitude ?? h.lng ?? h.lon);
  if (lat == null || lng == null) return null;
  const id = String(h.id ?? h.hotelId ?? '').trim();
  if (!id) return null;
  const kindWord = String(h.hotelType ?? h.type ?? '').toLowerCase().replace(/\s+/g, '_');
  return {
    source: 'liteapi',
    sourcePlaceId: id,
    venueRef: `liteapi:${id}`,
    name: h.name ?? null,
    category: 'other',
    lat,
    lng,
    address: [h.address, h.city, h.zip ?? h.postalCode].filter(Boolean).join(', ') || null,
    stayKind: STAY_WORDS[kindWord] ?? (h.hotelType ? String(h.hotelType) : 'Hotel'),
    // The star rating an operator is allowed to advertise, and the guest score,
    // which LiteAPI reports out of ten. Places shows marks out of five, so it
    // is halved here rather than in four screens.
    stars: num(h.stars ?? h.starRating),
    rating: num(h.rating) == null ? null : Number((num(h.rating) / 2).toFixed(1)),
    reviewCount: num(h.reviewCount),
    rooms: null,
    chain: h.chain || null,
    // Their photograph, shown from their URL and never fetched into our library:
    // the library only holds pictures under licences that let us keep them
    // (sources/placePicture.js), and this is not one of them.
    photo: h.main_photo ?? h.thumbnail ?? null,
    attribution: LITEAPI_ATTRIBUTION,
  };
}

/**
 * The beds on a patch of map. Static content: names, addresses, coordinates.
 * No dates needed, so this is what a trip with no dates yet still gets.
 */
export async function hotelsNear(centre, radiusKm, { meter = null } = {}) {
  const radiusM = Math.max(MIN_RADIUS_M, Math.round(radiusKm * 1000));
  const key = patchKey(centre, radiusM);
  const hit = fromCache(staticKept, key, STATIC_TTL_MS);
  if (hit) return { hotels: hit, cached: true };
  const json = await call('/data/hotels', {
    query: { latitude: centre.lat, longitude: centre.lng, radius: radiusM, limit: LIMIT },
    meter,
  });
  const hotels = (json?.data ?? []).map(asVenue).filter(Boolean);
  toCache(staticKept, key, hotels);
  return { hotels, cached: false };
}

// ---------------------------------------------------------------------------
// what a night costs
// ---------------------------------------------------------------------------

const money = (v) => {
  const n = num(Array.isArray(v) ? v[0]?.amount : v?.amount ?? v);
  return n == null ? null : Number(n.toFixed(2));
};

/**
 * The cheapest thing on offer at one hotel, and the terms it comes on.
 *
 * Cheapest, not first: LiteAPI returns every room type each supplier will sell,
 * and a household deciding where to stay is choosing between hotels, not
 * between one hotel's fourteen rate codes. The dearer rooms are still there
 * when they open one.
 */
function cheapestOffer(row, nights) {
  let best = null;
  for (const rt of row?.roomTypes ?? []) {
    const total = money(rt.offerRetailRate) ?? money(rt.rates?.[0]?.retailRate?.total);
    if (total == null) continue;
    const rate = rt.rates?.[0] ?? {};
    const cancel = rate.cancellationPolicies ?? {};
    const offer = {
      total,
      currency: (Array.isArray(rt.offerRetailRate) ? rt.offerRetailRate[0]?.currency : rt.offerRetailRate?.currency)
        ?? rate.retailRate?.total?.[0]?.currency ?? CURRENCY(),
      perNight: nights > 0 ? Number((total / nights).toFixed(2)) : null,
      roomName: rate.name ?? rt.roomType?.name ?? null,
      // "Room only", "Breakfast included" — the difference between two prices
      // that look the same, and the one a family actually feels.
      board: rate.boardName ?? rate.boardType ?? null,
      // LiteAPI's own word: RFN refundable, NRFN not. Said in English, because
      // "can we still change our minds" is the question being asked.
      refundable: cancel.refundableTag ? /^RFN/i.test(String(cancel.refundableTag)) : null,
      freeUntil: cancel.cancelPolicyInfos?.find((p) => num(p.amount) === 0)?.cancelTime ?? null,
      offerId: rt.offerId ?? null,
    };
    if (!best || offer.total < best.total) best = offer;
  }
  return best;
}

/**
 * Rates for a patch of map, for these nights and these people.
 *
 * Returns a map of LiteAPI hotel id → cheapest offer. The beds themselves come
 * from `hotelsNear`: this call answers with ids and prices and no names.
 */
export async function ratesNear(centre, radiusKm, { checkin, checkout, occupancies, meter = null } = {}) {
  const radiusM = Math.max(MIN_RADIUS_M, Math.round(radiusKm * 1000));
  const nights = nightsBetween(checkin, checkout);
  const key = `${patchKey(centre, radiusM)}|${checkin}|${checkout}|${JSON.stringify(occupancies)}|${CURRENCY()}`;
  const hit = fromCache(ratesKept, key, RATES_TTL_MS);
  if (hit) return { offers: hit, cached: true, nights };
  const json = await call('/hotels/rates', {
    method: 'POST',
    body: {
      latitude: centre.lat,
      longitude: centre.lng,
      radius: radiusM,
      checkin,
      checkout,
      occupancies,
      currency: CURRENCY(),
      guestNationality: NATIONALITY(),
      limit: LIMIT,
      timeout: RATES_TIMEOUT_S,
    },
    // Their own timeout ends the search their side; ours is a second longer so
    // the answer they do send has time to arrive.
    timeoutMs: (RATES_TIMEOUT_S + 2) * 1000,
    meter,
  });
  const offers = new Map();
  for (const row of json?.data ?? []) {
    const id = String(row.hotelId ?? '').trim();
    if (!id) continue;
    const offer = cheapestOffer(row, nights);
    if (offer) offers.set(id, offer);
  }
  toCache(ratesKept, key, offers);
  return { offers, cached: false, nights };
}

/** Nights between two YYYY-MM-DD dates; 0 (and so no rates) for anything that is not a stay. */
export function nightsBetween(checkin, checkout) {
  if (!checkin || !checkout) return 0;
  const a = new Date(`${String(checkin).slice(0, 10)}T12:00:00Z`);
  const b = new Date(`${String(checkout).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(+a) || Number.isNaN(+b)) return 0;
  return Math.max(0, Math.round((+b - +a) / 86400000));
}

/**
 * Who is sleeping where, in LiteAPI's shape.
 *
 * One room by default, holding everybody, because that is the cheapest honest
 * answer and the household can say otherwise. Beyond one room the adults are
 * spread evenly and the children go with the first — Roam does not know who
 * shares with whom, and rather than invent it the screen shows what was asked
 * for so it can be corrected (owner: ask, do not guess).
 */
export function occupanciesFor({ adults = 2, childAges = [], rooms = 1 } = {}) {
  const n = Math.max(1, Math.min(9, Math.round(rooms)));
  const total = Math.max(n, Math.round(adults));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const share = Math.floor(total / n) + (i < total % n ? 1 : 0);
    out.push({ adults: Math.max(1, share), children: i === 0 ? childAges.filter((a) => a != null) : [] });
  }
  return out;
}

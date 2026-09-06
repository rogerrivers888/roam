// The same place, in open data.
//
// A place found through Google arrives as an identifier and a name we may not
// keep. Nearly all of them are also in OpenStreetMap, where the same facts are
// ODbL: keepable for good, with attribution. So the first act of owning a place
// is to find it again in the open map — by where it is and what it is called —
// and from then on to hold the open record rather than the rented one.
//
// A match is only claimed when it is safe: within 250 m, and with names that
// agree once the noise is stripped. A wrong match is worse than none, because
// it would put another restaurant's phone number on this one's card, so the
// confidence is returned and the caller stores what it was.

import { bump } from './meter.js';
import { mirrorsInOrder, mirrorAnswered, mirrorFailed, UA } from './overpass.js';

// The interactive search (sources/osm.js) makes one Overpass call when somebody
// taps; the researcher here makes one per claimed place, for ever. That is a
// different kind of load on a service run for nothing, so it spreads across
// every public mirror rather than leaning on the two the search uses, paces
// itself, and stands down from a mirror that says no.

// How far a match may be. A restaurant's Google pin and its OSM node are rarely
// the same point — one is the door, the other the building — but they are never
// streets apart.
const MAX_M = 250;
// One endpoint's patience, not the whole lookup's: with two endpoints a blocked
// first one used to cost 25 seconds before the second was even asked.
const ENDPOINT_TIMEOUT_MS = 15_000;

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
export function metresBetween(a, b) {
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Words that are in one source's name and not the other's, and mean nothing:
// "The Ivy" and "Ivy Restaurant" are the same restaurant.
const NOISE = /\b(the|a|an|le|la|les|el|il|restaurant|ristorante|trattoria|osteria|cafe|caf[eé]|coffee|bar|pub|inn|tavern|kitchen|bistro|brasserie|grill|house|co|company|ltd|limited|llp|plc|and)\b/g;

export function normalise(name, { noise = true } = {}) {
  const flat = String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')          // café -> cafe
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')                                   // Nando's → nandos
    .replace(/[^a-z0-9]+/g, ' ');
  return (noise ? flat.replace(NOISE, ' ') : flat).replace(/\s+/g, ' ').trim();
}

/**
 * 0–1: how much two names agree once the noise is gone.
 *
 * `ignore` is the words that are true of everything nearby — the name of the
 * town, above all. "Sunningdale Bistro Bar" loses both bistro and bar to the
 * noise list and comes down to "sunningdale", which is the first half of every
 * business in Sunningdale: it matched Sunningdale Pharmacy at 0.9, and before
 * that Sunningdale railway station (found 6 Sep 2026). Sharing the town's name
 * is not evidence of being the same place.
 */
export function nameScore(a, b, ignore = []) {
  // Written the same way, word for word, is the same place — whatever those
  // words are. This is checked before the noise comes out, because the noise
  // list holds the words that tell a bistro from a pharmacy.
  if (normalise(a, { noise: false }) === normalise(b, { noise: false }) && normalise(a, { noise: false })) return 1;
  const x = normalise(a), y = normalise(b);
  if (!x || !y) return 0;
  const dull = new Set(ignore.flatMap((w) => normalise(w).split(' ')).filter(Boolean));
  const ax = [...new Set(x.split(' '))], by = [...new Set(y.split(' '))];
  const worthIt = (tokens) => tokens.some((t) => !dull.has(t));
  // When the town is all the two have left in common, the words the noise list
  // took out are the only ones that can tell them apart, so they are read back
  // in: "Sunningdale Bistro Bar" and "Sunningdale Bistro" are one place, and
  // "Sunningdale Pharmacy" is another.
  const onWhatIsLeft = () => {
    const fx = normalise(a, { noise: false }).split(' ').filter((t) => t && !dull.has(t));
    const fy = normalise(b, { noise: false }).split(' ').filter((t) => t && !dull.has(t));
    if (!fx.length || !fy.length) return 0.35;
    const sx = fx.join(' '), sy = fy.join(' ');
    if (sx === sy) return 1;
    if (sx.startsWith(sy) || sy.startsWith(sx)) return 0.9;
    const both = fx.filter((t) => fy.includes(t));
    return both.length ? Math.min(0.85, (both.length / Math.min(fx.length, fy.length)) * 0.85) : 0;
  };
  if (x === y) return worthIt(ax) ? 1 : onWhatIsLeft();
  if (x.startsWith(y) || y.startsWith(x)) {
    const shorter = ax.length <= by.length ? ax : by;
    // "Kokoro" inside "Kokoro Windsor" is the restaurant; "Sunningdale" inside
    // "Sunningdale Pharmacy" is the village.
    return worthIt(shorter) ? 0.9 : onWhatIsLeft();
  }
  const shared = ax.filter((t) => by.includes(t) && !dull.has(t));
  if (!shared.length) return 0;
  const jaccard = shared.length / new Set([...ax, ...by]).size;

  // A name wholly contained in a longer one is usually the same place —
  // "Torreão Poente" inside "Museu de Lisboa - Torreão Poente" — and counts for
  // more than the ratio says. But only when the overlap is distinctive: the
  // town's name turns up inside half the businesses in it, and "Bath" inside
  // "The Gainsborough Bath Spa" once matched the hotel to Wikipedia's article
  // on the parliamentary constituency. So containment counts only when the
  // shared words include the longer name's first word, or a word long enough to
  // be a name rather than a place or a category.
  const longer = ax.length >= by.length ? ax : by;
  const distinctive = shared.includes(longer[0]) || shared.some((t) => t.length >= 6);
  const containment = distinctive ? shared.length / Math.min(ax.length, by.length) : 0;
  return Math.max(jaccard, containment * 0.85);
}

/**
 * The parts of a name worth searching a map for: long enough to be distinctive,
 * cut to a prefix so that "Lunn" still finds "Lunn's" and "Bath" still finds
 * "Bathwick". Three is plenty; more only widens the net.
 */
export function significantStems(name) {
  return normalise(name)
    .split(' ')
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
    .slice(0, 3)
    // Four characters, not five: the possessive is lost in normalising, so
    // "lunns" would never find "Lunn's" but "lunn" does.
    .map((t) => t.slice(0, 4));
}

// Overpass is somebody else's machine, run for free, and its fair use is about
// a request a second. The background researcher is the only caller here, so it
// paces itself rather than relying on being small.
const MIN_GAP_MS = 2000;
let lastCall = 0;
const pace = async () => {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
};

async function overpass(body, meter = null) {
  bump(meter, 'osm');
  let lastErr;
  // Which mirror, and which to leave alone, is shared with the interactive
  // search now (sources/overpass.js): a mirror either of them finds to be down
  // is one the other stops asking.
  for (const url of mirrorsInOrder()) {
    await pace();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: `data=${encodeURIComponent(body)}`,
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
      });
      // 429 is "slow down" and 504 is "I gave up"; both mean leave this one alone.
      if (!res.ok) {
        mirrorFailed(url, null, res.status);
        throw new Error(`Overpass ${res.status}`);
      }
      const data = await res.json();
      mirrorAnswered(url);
      return data;
    } catch (err) {
      // A timeout is the same signal as a 429 from a mirror that just stops
      // replying, which is what the busy ones actually do.
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') mirrorFailed(url, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Everything OSM knows about one element, as tags — the raw material for the record. */
export async function osmElement(ref, { meter = null } = {}) {
  const [type, id] = String(ref).split('/');
  if (!['node', 'way', 'relation'].includes(type) || !/^\d+$/.test(id || '')) return null;
  const data = await overpass(`[out:json][timeout:15];${type}(${id});out center tags;`, meter);
  const el = (data.elements || [])[0];
  if (!el) return null;
  return { ref: `${el.type}/${el.id}`, tags: el.tags || {}, lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon };
}

/**
 * Find this place in OpenStreetMap.
 *
 * Returns `{ ref, tags, lat, lng, distanceM, confidence, how }` or null. The
 * caller decides what to do with a low confidence; nothing here writes.
 */
export async function matchOsm({ venueRef, name, lat, lng, locality = null, meter = null } = {}) {
  // A place that is already an OSM place needs no matching — it is its own
  // match, as long as the element is where the place is. A reference that was
  // written by hand rather than read off the map may point at a real way with a
  // low number somewhere else entirely: `osm:way/1001` is a road in another
  // county, and taking it at its word renamed the Roman Baths after it
  // (found 6 Sep 2026).
  if (String(venueRef || '').startsWith('osm:')) {
    const el = await osmElement(String(venueRef).slice(4), { meter });
    if (!el) return null;
    if (lat != null && lng != null && el.lat != null && metresBetween({ lat, lng }, el) > MAX_M) return null;
    return { ...el, distanceM: 0, confidence: 1, how: 'It is an OpenStreetMap place already.' };
  }
  if (lat == null || lng == null || !String(name || '').trim()) return null;

  // Ask for the place by name, not for everything nearby. A 250 m circle in a
  // city centre holds more than four hundred named shops and benches, Overpass
  // returns them in no particular order and truncates at the limit, so the
  // restaurant we came for falls off the end and the match silently fails.
  // Searching on the distinctive part of the name instead returns a handful.
  const stems = significantStems(name);
  const around = `(around:${MAX_M},${lat},${lng})`;
  const KINDS = ['amenity', 'tourism', 'leisure', 'shop', 'historic', 'craft', 'club'];
  const byName = stems.length ? `[out:json][timeout:20];nwr["name"~"(${stems.join('|')})",i]${around};out center tags 200;` : null;
  // A name that is all short or common words gives nothing to search on; then
  // fall back to everything of the right kind, in a tighter circle.
  const byKind = `[out:json][timeout:20];nwr["name"][~"^(${KINDS.join('|')})$"~"."](around:${Math.round(MAX_M / 2)},${lat},${lng});out center tags 300;`;

  let elements = [];
  if (byName) elements = (await overpass(byName, meter)).elements ?? [];
  if (!elements.length) elements = (await overpass(byKind, meter)).elements ?? [];

  const here = { lat, lng };
  let best = null;
  for (const el of elements) {
    const elat = el.lat ?? el.center?.lat, elng = el.lon ?? el.center?.lon;
    const tags = el.tags || {};
    if (elat == null || !tags.name) continue;
    // A bus stop or a car park with the venue's name on it is not the venue.
    if (tags.highway || tags.public_transport || tags.amenity === 'parking' || tags.amenity === 'bench') continue;
    const distanceM = metresBetween(here, { lat: elat, lng: elng });
    if (distanceM > MAX_M) continue;
    // Names agree first; distance only separates two that both do.
    const dull = locality ? [locality] : [];
    const n = Math.max(nameScore(name, tags.name, dull), ...(['int_name', 'official_name', 'alt_name', 'brand', 'operator'].map((k) => (tags[k] ? nameScore(name, tags[k], dull) : 0))));
    if (n < 0.6) continue;
    const confidence = Math.min(1, n * (1 - Math.min(distanceM, MAX_M) / (MAX_M * 4)));
    if (!best || confidence > best.confidence) {
      best = { ref: `${el.type}/${el.id}`, tags, lat: elat, lng: elng, distanceM: Math.round(distanceM), confidence: Number(confidence.toFixed(2)), matchedName: tags.name };
    }
  }
  if (!best) return null;
  best.how = `Matched “${best.matchedName}” in OpenStreetMap, ${best.distanceM} m away.`;
  return best;
}

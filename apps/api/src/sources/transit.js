// Which stations exist, and what kind of thing each one is.
//
// The classification is the part worth care. "Near a station" is a promise, and
// four different things wearing `railway=station` in OpenStreetMap keep four
// different versions of it:
//
//   rail        a train you could commute on. Bath Spa, Oldfield Park.
//   subway      London Underground, Glasgow Subway.
//   light_rail  the DLR, Tyne and Wear Metro.
//   tram        Manchester Metrolink, Sheffield Supertram, Edinburgh, NET.
//
// And several things that are not transport at all also wear it: Legoland's
// Hill Train is `railway=station`, and a bed ranked "4 min walk to Hill Train
// Bottom · about 21 min by train" is nonsense dressed up as a fact (6 Sep 2026).
// A miniature, funicular or preserved line is a day out; a disused one is not
// even that. `isServiceStop` is the sieve, and it is deliberately strict:
// wrongly excluding a station costs a household one option, and wrongly
// including one costs them their idea of what the app knows.

import { overpassQuery } from './overpass.js';

/** Rides rather than transport: they are somewhere to go, not a way to get there. */
const RIDE = new Set(['miniature', 'funicular', 'monorail', 'cable_car', 'chair_lift']);

/**
 * Is this a stop somebody could actually travel from?
 *
 * Exported because it is the whole quality of the feature and belongs under
 * test on its own, away from any network.
 */
export function isServiceStop(t = {}) {
  const railway = t.railway;
  if (!['station', 'halt', 'tram_stop'].includes(railway)) return false;
  if (RIDE.has(t.station)) return false;
  if (t.usage === 'tourism' || t.tourism === 'attraction') return false;
  if (t.disused === 'yes' || t.abandoned === 'yes' || t['disused:railway'] || t['abandoned:railway']) return false;
  if (t.construction === 'yes' || t['construction:railway'] || t.proposed === 'yes' || t['proposed:railway']) return false;
  // Narrow gauge and preserved lines run for the ride; a service line runs to
  // get somewhere. A gauge under a metre is a garden railway, not Southern.
  if (t.gauge && Number(t.gauge) && Number(t.gauge) < 1000) return false;
  if (/\b(miniature|heritage|steam|model|preserved|funicular|cliff railway)\b/i.test(t.name || '')) return false;
  return true;
}

/** Which of the four it is. Order matters: a tram stop is tagged several ways. */
export function kindOf(t = {}) {
  if (t.railway === 'tram_stop' || t.station === 'tram' || t.tram === 'yes') return 'tram';
  if (t.station === 'subway' || t.subway === 'yes') return 'subway';
  if (t.station === 'light_rail' || t.light_rail === 'yes') return 'light_rail';
  return 'rail';
}

/**
 * The station as anybody would say it.
 *
 * OpenStreetMap writes the mode into the name where two stations share one
 * ("Shepherd's Bush (Central Line)", "Manchester Piccadilly (Metrolink)"), and
 * a row has no space for it (owner, 4 Sep 2026: "just show the tube station").
 */
export function cleanStopName(n) {
  const s = String(n || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const unqualified = s.replace(/\s+(Underground|Rail|DLR|Overground|Tram|Metrolink|Metro)\s+(Station|Stop)$/i, '');
  return (unqualified === s ? s.replace(/\s+(Station|Stop)$/i, '') : unqualified).trim();
}

/** One OSM element as a row, or null where it is not a stop we would offer. */
export function asStop(el) {
  const t = el.tags || {};
  if (!t.name || !isServiceStop(t)) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;
  return {
    ref: `${el.type}/${el.id}`,
    name: cleanStopName(t.name),
    kind: kindOf(t),
    lat: Number(lat),
    lng: Number(lng),
    network: t.network || null,
    operator: t.operator || null,
  };
}

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
export function metresBetween(a, b) {
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * One stop, once.
 *
 * A tram line has a stop node for each direction and a big station is mapped
 * several times over — as a node, as the building, once per operator. All of
 * them carry the same name within a few dozen metres, and a household offered
 * "Piccadilly Gardens, Piccadilly Gardens, Piccadilly Gardens" learns nothing
 * except that we are not paying attention.
 *
 * Same name within 250m is one stop. Distance alone would not do it — Bath Spa
 * and the bus station opposite are 80m apart and are different places — and
 * name alone would not either, because every tram network in Britain has a
 * "Central".
 */
export function dedupe(stops, withinM = 250) {
  const out = [];
  for (const s of stops) {
    const key = s.name.toLowerCase();
    const twin = out.find((o) => o.name.toLowerCase() === key && metresBetween(o, s) <= withinM);
    if (!twin) { out.push(s); continue; }
    // Keep the richer record, and prefer a station over a tram stop of the same
    // name: Manchester Piccadilly is a railway station that also has trams.
    const rank = (x) => (x.kind === 'rail' ? 3 : x.kind === 'subway' ? 2 : 1);
    if (rank(s) > rank(twin) || (!twin.network && s.network)) Object.assign(twin, s);
  }
  return out;
}

/** The Overpass query for one box: everything anybody could catch. */
export const stopsQuery = (s, w, n, e, timeout = 180) => `[out:json][timeout:${timeout}];(
  node["railway"~"^(station|halt|tram_stop)$"](${s},${w},${n},${e});
  way["railway"~"^(station|halt)$"](${s},${w},${n},${e});
);out center tags;`;

/**
 * Every stop in a box, from the open map.
 *
 * Throws when no mirror answers, which is the caller's to decide about — the
 * point of the table behind this is that a failure here is no longer a failure
 * on somebody's screen.
 */
export async function fetchStops({ south, west, north, east }, { timeoutMs = 180_000 } = {}) {
  const data = await overpassQuery(stopsQuery(south, west, north, east), { timeoutMs });
  const stops = (data.elements || []).map(asStop).filter(Boolean);
  return dedupe(stops);
}

/** Great Britain and Northern Ireland, in one box. About 3,500 stops. */
export const UK = { area: 'uk', label: 'United Kingdom', south: 49.8, west: -8.7, north: 60.9, east: 1.8 };

/**
 * A box around a point, in degrees, for the fallback lookup.
 *
 * Longitude degrees narrow towards the poles, so the east-west span is divided
 * by the cosine of the latitude — without it a box around Inverness is a third
 * too wide and one around Penzance too narrow.
 */
export function boxAround(lat, lng, radiusM) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(toRad(lat)) || 1);
  return { south: lat - dLat, west: lng - dLng, north: lat + dLat, east: lng + dLng };
}

/**
 * Fill the table for a region, deliberately.
 *
 * The United Kingdom in one Overpass query is a big ask of a free server, so a
 * region is cut into a grid and each cell fetched in turn with a pause between.
 * That is slower than one query and very much politer, and it means a mirror
 * falling over halfway through costs one cell rather than the whole run — the
 * cells already written stay written.
 *
 * Idempotent: every stop is keyed on its OSM ref, so running it again updates
 * rather than duplicates, and a half-finished run is resumed by running it
 * again.
 */
/** A cell's name, rounded so the same cell is the same row on every run. */
export const cellArea = (c) => `cell:${c.south.toFixed(2)},${c.west.toFixed(2)}`;

export async function harvestRegion(box, {
  cellDeg = 1.0, pauseMs = 1500, timeoutMs = 90_000, refresh = false,
  onProgress = null, upsert, record, covered = async () => false,
} = {}) {
  const cells = [];
  for (let s = box.south; s < box.north; s += cellDeg) {
    for (let w = box.west; w < box.east; w += cellDeg) {
      cells.push({ south: s, west: w, north: Math.min(s + cellDeg, box.north), east: Math.min(w + cellDeg, box.east) });
    }
  }
  let stored = 0;
  let done = 0;
  const failed = [];
  for (const [i, cell] of cells.entries()) {
    // Resumable: a cell already covered is skipped, so running this again after
    // a bad afternoon on the mirrors picks up only what is still missing. It is
    // the reason the run can be interrupted and re-run without penalty.
    if (!refresh && await covered(cell)) { done += 1; onProgress?.({ cell: i + 1, of: cells.length, skipped: true }); continue; }
    try {
      const stops = await fetchStops(cell, { timeoutMs });
      if (stops.length) stored += await upsert(stops, box.countryCode ?? null);
      // Recorded per cell, and only on success. A cell that answered is a patch
      // of map we know about — including when the answer was "nothing here",
      // which is true of a great deal of the sea and most of the Highlands.
      await record({ ...cell, area: cellArea(cell), label: `${box.label ?? 'harvest'} cell` }, stops.length, 'harvest');
      done += 1;
      onProgress?.({ cell: i + 1, of: cells.length, found: stops.length, stored });
    } catch (err) {
      // A cell that fails is skipped, not fatal. The alternative is throwing
      // away the thirty cells that worked because the thirty-first did not, and
      // an uncovered cell simply falls back to a live lookup when somebody
      // searches there.
      failed.push({ cell, error: String(err?.message || err) });
      onProgress?.({ cell: i + 1, of: cells.length, failed: true, error: String(err?.message || err) });
    }
    if (i < cells.length - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }
  // The region itself is claimed only when every cell answered, so a partial
  // run never tells the fallback that a hole has been filled.
  if (!failed.length) await record(box, stored, 'harvest');
  return { stored, cells: cells.length, done, failed };
}

/**
 * Carry on filling the stations table, whenever this process is up.
 *
 * Deliberately not "harvest on boot": the same reasoning as the atlas harvest
 * next door (server.js). It waits until the process has been answering for a
 * while, and because every cell is idempotent and recorded on its own, a run
 * cut in half by a deploy loses nothing — the next one picks up the cells that
 * are still missing and asks Overpass nothing about the rest.
 *
 * This is what makes the table finish itself. Britain is fifty-odd cells and on
 * a bad afternoon for the mirrors that is hours; nobody should have to remember
 * to come back and press something, and until it is done the live fallback
 * covers whatever anybody actually searches for.
 */
export async function resumeHarvest({ upsert, record, covered, remaining, budgetMs = 4 * 60_000 } = {}) {
  const left = await remaining();
  if (!left) return { done: true, cells: 0 };
  const started = Date.now();
  let filled = 0;
  const out = await harvestRegion({ ...UK, countryCode: 'GB' }, {
    cellDeg: 1.5,
    pauseMs: 1200,
    timeoutMs: 60_000,
    upsert,
    record,
    covered,
    // A slice at a time rather than the lot. A four-minute budget leaves the
    // process free for the screens it exists to serve, and the next tick
    // continues where this one stopped.
    onProgress: (p) => { if (!p.skipped) filled += 1; if (Date.now() - started > budgetMs) throw new StopHarvest(); },
  }).catch((err) => (err instanceof StopHarvest ? { stored: 0, cells: 0, done: filled, failed: [] } : Promise.reject(err)));
  return { done: false, cells: filled, stored: out.stored ?? 0 };
}

/** Not an error: the way out of a loop that has used its slice of the process. */
class StopHarvest extends Error {}

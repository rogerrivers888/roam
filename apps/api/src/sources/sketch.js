// The map a search is drawn on.
//
// While a search runs the household sees the country, then the town, then the
// ground being searched, with the areas inside it named (owner, 4 Sep 2026:
// "some clever sketch thing… so you have something real, tangible"). Everything
// here is the geometry that makes that possible, and all of it is open data:
// Natural Earth for the coastline, OpenStreetMap through Nominatim for the
// areas. It is the owned layer, so it is kept for good — a borough boundary
// does not move, and a country's coast moves more slowly still.
//
// Nothing a provider tells us is ever drawn here. The pins on the map are
// counts, not places: names, ratings and photographs are rented, and they are
// not ours to scatter over a map before the pool has even been ranked.
//
// Two rules govern the fetching, both because the household is waiting:
//
//   1. The centre's own area is fetched inline on a miss. It is one Nominatim
//      call and it answers in about a fifth of a second.
//   2. Its neighbours are filled in afterwards, in the background, one a
//      second, because Nominatim asks for no more than that. The first search
//      in a new town draws one named area; the second draws the lot.
//
// Overpass could give richer boundaries and was tried first. It answers a query
// like this in ninety seconds or not at all, which is fine for the research in
// own.js that nobody is waiting on, and useless for a screen somebody is
// watching.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';
import { areaOutline, GEOCODE_ATTRIBUTION } from './geocode.js';

const OUTLINES = JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/country-outlines.json'), 'utf8',
));

export const SKETCH_ATTRIBUTION = `${GEOCODE_ATTRIBUTION} · Natural Earth`;

/**
 * Web Mercator in degrees, which is what the client draws in. One projection
 * for the coastline and the boroughs both, so the camera can fly from one to
 * the other without reprojecting anything.
 */
export const mercator = (lon, lat) => [
  lon,
  -(180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + Math.max(-84, Math.min(84, lat)) * Math.PI / 360)),
];

/** Kilometres per Mercator unit at a latitude — the same in x and y, because Mercator is conformal. */
export const kmPerUnit = (lat) => 111.32 * Math.cos(lat * Math.PI / 180);

const round = (n, dp) => Number(n.toFixed(dp));
const ringToPath = (ring, dp = 4) =>
  'M' + ring.map(([lon, lat]) => { const [x, y] = mercator(lon, lat); return `${round(x, dp)},${round(y, dp)}`; }).join('L') + 'Z';

/** The country's outline, or nothing — a search in a place we have no shape for simply starts at the town. */
export function countryOutline(code) {
  const c = code ? OUTLINES[String(code).toUpperCase()] : null;
  return c ? { code: String(code).toUpperCase(), name: c.name, d: c.d, box: c.box } : null;
}

const keyFor = (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`;

function shapeArea(a) {
  const rings = a.rings.filter((r) => r.length >= 4);
  if (!rings.length) return null;
  const pts = rings.flat().map(([lon, lat]) => mercator(lon, lat));
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return { ref: a.osmRef, name: a.name, d: rings.map((r) => ringToPath(r)).join(''), cx: round(cx, 4), cy: round(cy, 4) };
}

// One background fill at a time: Nominatim asks for one request a second, and
// two searches in different towns must not race each other into three.
const filling = new Set();

/** The points of a stored path, back out of the string, for the check below. */
const pathPoints = (d) => String(d).split(/[ML]/).filter(Boolean).map((p) => p.replace('Z', '').split(',').map(Number));

/**
 * Whether a point already sits in an area we hold. A ring point inside
 * Islington does not need asking about: skipping it is one fewer call on a free
 * service that asks us to make few.
 */
function inKnownArea(areas, x, y) {
  for (const a of areas) {
    const pts = pathPoints(a.d);
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i += 1) {
      const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
      if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/**
 * The areas around a point. Answers from what is stored; on a miss it fetches
 * the one area the centre sits in and hands that back straight away, leaving
 * the neighbours to arrive before the next search.
 */
export async function sketchFor({ lat, lng, radiusKm = 3 }) {
  const key = keyFor(lat, lng);
  const { rows } = await query('select * from map_sketches where key = $1', [key]);
  const row = rows[0];
  if (row && (row.complete || Number(row.radius_km) >= radiusKm)) {
    if (!row.complete) fillNeighbours(key, lat, lng, radiusKm);
    return { place: row.place, areas: row.areas, complete: row.complete };
  }

  let centre = null;
  try { centre = await areaOutline(lat, lng); } catch { centre = null; }
  const area = centre ? shapeArea(centre) : null;
  const areas = area ? [area] : [];
  await query(
    `insert into map_sketches (key, lat, lng, radius_km, place, areas, complete)
     values ($1,$2,$3,$4,$5,$6,false)
     on conflict (key) do update set radius_km = greatest(map_sketches.radius_km, excluded.radius_km),
       place = coalesce(excluded.place, map_sketches.place),
       areas = case when jsonb_array_length(excluded.areas) > jsonb_array_length(map_sketches.areas) then excluded.areas else map_sketches.areas end`,
    [key, lat, lng, radiusKm, area?.name ?? null, JSON.stringify(areas)],
  );
  fillNeighbours(key, lat, lng, radiusKm);
  return { place: area?.name ?? null, areas, complete: false };
}

/**
 * The ring around the centre, one point every sixty degrees at two thirds of
 * the search radius. Six calls at a second each, in the background, and the
 * town has a shape for good.
 */
function fillNeighbours(key, lat, lng, radiusKm) {
  if (filling.has(key)) return;
  filling.add(key);
  (async () => {
    try {
      const { rows } = await query('select areas from map_sketches where key = $1', [key]);
      const seen = new Map((rows[0]?.areas ?? []).map((a) => [a.ref, a]));
      const km = kmPerUnit(lat);
      const r = Math.max(1.5, Math.min(12, radiusKm * 0.7));
      for (let i = 0; i < 6; i += 1) {
        const angle = (i / 6) * 2 * Math.PI;
        const dLng = (r / km) * Math.cos(angle);
        const dLat = (r / 110.57) * Math.sin(angle);
        const [px, py] = mercator(lng + dLng, lat + dLat);
        if (inKnownArea([...seen.values()], px, py)) continue;
        try {
          const hit = await areaOutline(lat + dLat, lng + dLng);
          const shaped = hit ? shapeArea(hit) : null;
          if (shaped && !seen.has(shaped.ref)) seen.set(shaped.ref, shaped);
        } catch { /* one missing neighbour is not worth failing the sketch for */ }
      }
      await query(
        'update map_sketches set areas = $2, complete = true, radius_km = greatest(radius_km, $3), fetched_at = now() where key = $1',
        [key, JSON.stringify([...seen.values()]), radiusKm],
      );
    } catch { /* the sketch is a nicety; it never breaks a search */ }
    finally { filling.delete(key); }
  })();
}

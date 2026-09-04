/**
 * The map a search is drawn on while it runs.
 *
 * A country's coast from Natural Earth and administrative boundaries from
 * OpenStreetMap: open data, about the ground rather than about a venue, and
 * ours to keep for good — which is why it is stored at all when almost nothing
 * else a search touches is.
 */

import { query } from '../db.js';

export async function sketchAt(key) {
  const { rows } = await query('select * from map_sketches where key = $1', [key]);
  return rows[0] ?? null;
}

/**
 * Record what a first look found, without ever losing a better one.
 *
 * Two searches near the same point race each other. `greatest` on the radius
 * and "keep whichever list is longer" mean the row only ever improves — a
 * narrow search arriving second cannot shrink what a wide one already drew.
 */
export async function upsertSketch(key, { lat, lng, radiusKm, place, areas }) {
  await query(
    `insert into map_sketches (key, lat, lng, radius_km, place, areas, complete)
     values ($1,$2,$3,$4,$5,$6,false)
     on conflict (key) do update
        set radius_km = greatest(map_sketches.radius_km, excluded.radius_km),
            place = coalesce(excluded.place, map_sketches.place),
            areas = case when jsonb_array_length(excluded.areas) > jsonb_array_length(map_sketches.areas)
                         then excluded.areas else map_sketches.areas end`,
    [key, lat, lng, radiusKm, place ?? null, JSON.stringify(areas)],
  );
}

export async function areasAt(key) {
  const { rows } = await query('select areas from map_sketches where key = $1', [key]);
  return rows[0]?.areas ?? [];
}

export async function completeSketch(key, areas, radiusKm) {
  await query(
    'update map_sketches set areas = $2, complete = true, radius_km = greatest(radius_km, $3), fetched_at = now() where key = $1',
    [key, JSON.stringify(areas), radiusKm],
  );
}

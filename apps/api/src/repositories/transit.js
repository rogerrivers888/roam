// Stations we hold, rather than stations we ask for.
//
// The whole point of this table is that reading it cannot fail: no mirror, no
// timeout, no volunteer server having a bad afternoon. A search for the beds
// near a station is a bounding-box query over about three and a half thousand
// rows, which Postgres answers in a millisecond.

import { query } from '../db.js';
import { metresBetween } from '../sources/transit.js';

/** Write what a harvest or a live lookup found. Idempotent: the OSM ref is the key. */
export async function upsertStops(stops, countryCode = null) {
  if (!stops.length) return 0;
  // One statement rather than one per row: a country harvest is 3,500 stops and
  // 3,500 round trips to the database is a minute of nothing happening.
  const values = [];
  const params = [];
  stops.forEach((s, i) => {
    const b = i * 7;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
    params.push(s.ref, s.name, s.kind, s.lat, s.lng, s.network ?? null, s.operator ?? null);
  });
  const { rowCount } = await query(
    `insert into transit_stops (ref, name, kind, lat, lng, network, operator)
     values ${values.join(',')}
     on conflict (ref) do update set
       name = excluded.name, kind = excluded.kind, lat = excluded.lat, lng = excluded.lng,
       network = coalesce(excluded.network, transit_stops.network),
       operator = coalesce(excluded.operator, transit_stops.operator),
       fetched_at = now()`,
    params,
  );
  if (countryCode) {
    await query('update transit_stops set country_code = $2 where ref = any($1) and country_code is null',
      [stops.map((s) => s.ref), countryCode]);
  }
  return rowCount;
}

/**
 * Every stop within `radiusM` of a point, nearest first.
 *
 * The box narrows it in the index and the haversine settles it here — exact
 * distance in SQL would need PostGIS, and over a few hundred candidate rows
 * the arithmetic is free.
 */
export async function stopsNear(lat, lng, radiusM, { kinds = null } = {}) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  const { rows } = await query(
    `select ref, name, kind, lat, lng, network, operator
       from transit_stops
      where lat between $1 and $2 and lng between $3 and $4
        and ($5::text[] is null or kind = any($5))`,
    [lat - dLat, lat + dLat, lng - dLng, lng + dLng, kinds],
  );
  return rows
    .map((r) => ({ ...r, lat: Number(r.lat), lng: Number(r.lng), distanceM: Math.round(metresBetween({ lat, lng }, { lat: Number(r.lat), lng: Number(r.lng) })) }))
    .filter((r) => r.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * Has anybody harvested the area this point falls in?
 *
 * The distinction the old code could not make: no row means we have never
 * looked, and that is not the same answer as "there are no stations here",
 * which is true of plenty of Britain.
 */
export async function coverageAt(lat, lng) {
  const { rows } = await query(
    `select area, label, stops, harvested_at, how from transit_coverage
      where $1 between south and north and $2 between west and east
      order by (north - south) * (east - west) asc limit 1`,
    [lat, lng],
  );
  return rows[0] ?? null;
}

export async function recordCoverage(box, stops, how = 'harvest') {
  await query(
    `insert into transit_coverage (area, label, south, west, north, east, stops, how)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (area) do update set
       label = excluded.label, south = excluded.south, west = excluded.west,
       north = excluded.north, east = excluded.east, stops = excluded.stops,
       how = excluded.how, harvested_at = now()`,
    [box.area, box.label ?? null, box.south, box.west, box.north, box.east, stops, how],
  );
}

/** Has this exact cell been harvested before? Keeps a re-run from redoing the work. */
export async function cellCovered(area) {
  const { rows } = await query('select 1 from transit_coverage where area = $1 and how = $2', [area, 'harvest']);
  return rows.length > 0;
}

/** What we hold, for the back office and for the tests. */
export async function stopCounts() {
  const { rows } = await query('select kind, count(*)::int as n from transit_stops group by kind order by n desc');
  const { rows: total } = await query('select count(*)::int as n, max(fetched_at) as at from transit_stops');
  const { rows: areas } = await query('select area, label, stops, harvested_at, how from transit_coverage order by stops desc');
  return { byKind: rows, total: total[0].n, fetchedAt: total[0].at, areas };
}

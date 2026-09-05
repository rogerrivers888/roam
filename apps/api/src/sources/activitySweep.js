// Everything there is to do in a county, from the one source that knows.
//
// Owner, 5 Sep 2026: "I'm not just looking for soft places. I'm looking for
// kids' activities and all activities: go-karting, flying lessons, all of the
// stuff that you can do in Surrey and Berkshire."
//
// Wikidata cannot answer that and never will. It has no item for Chobham
// Adventure Farm, nor for any trampoline park, soft play or karting track,
// because none of them is notable and notability is the only thing an
// encyclopedia sorts on. OpenStreetMap is better but thin in exactly this
// category — `leisure=indoor_play` is 3,414 objects worldwide. Google Places
// knows all of them, because they are businesses and Google's index is a
// business index.
//
// **So Google is a pointer here, and never a record.** Technical Constraints §4
// is unambiguous: "Place IDs only. Coordinates 30 days; display fields
// uncacheable." A place ID may be kept for ever; a name, a photograph, a rating
// and a review may not be kept at all. That is not a technicality to be worked
// around — it is the difference between a library we own and a copy of somebody
// else's product.
//
// The shape that follows from it is the one §13.10 already established for the
// owned place layer: the rented answer is "a description of what to go and
// find", and what gets written down is what we then find ourselves.
//
//   1. Ask Google what exists here. Hold the answer in memory.
//   2. Look each one up in OpenStreetMap. A match makes the place *ours* — an
//      ODbL name, position and tags we may keep for good and put on a device.
//   3. Write the OpenStreetMap record. Where there is no match, keep the place
//      ID and the fact that something is there, and mark the row so that its
//      name and picture are fetched live and never stored.
//
// Ratings get the same treatment they get in the food sweep: a band, never a
// number, and never Google's number. Four words, with a dozen ratings mapping
// to each, so the band cannot be read backwards into the figure behind it.

import { sweepArea } from './google.js';
import { normalise, metresBetween } from './openMatch.js';
import * as lib from '../repositories/library.js';
import { query } from '../db.js';

/**
 * What a family might do on a Saturday, in the words somebody would type.
 *
 * Text Search matches on the words, so these are phrased as a person would ask
 * rather than as a taxonomy. Several near-synonyms are deliberate: "soft play"
 * and "indoor play centre" surface different halves of the same trade, the same
 * way "restaurants" and "italian" do in the food sweep.
 */
export const ACTIVITY_QUERIES = [
  // with children
  'soft play', 'indoor play centre', 'trampoline park', 'adventure playground',
  'farm park', 'petting farm', 'play barn', 'children activities',
  // a thrill
  'go karting', 'paintball', 'laser tag', 'escape room', 'climbing wall',
  'high ropes course', 'zip line', 'flying lessons', 'skydiving', 'watersports',
  // doing something
  'bowling alley', 'ice skating rink', 'swimming pool', 'crazy golf',
  'horse riding', 'golf course', 'cycling trail', 'archery',
  // animals
  'zoo', 'aquarium', 'wildlife park', 'birds of prey centre',
  // a day out
  'theme park', 'water park', 'maze', 'steam railway',
  // looking at things
  'museum', 'art gallery', 'theatre', 'cinema', 'historic house', 'castle',
  // outside
  'country park', 'nature reserve', 'botanical garden', 'woodland walk',
  // grown-up
  'vineyard tour', 'brewery tour', 'distillery tour', 'spa day',
];

/** Google's Pro-tier list price past the free monthly allowance (pricing.js). */
export const USD_PER_CALL = 0.032;
export const FREE_PER_MONTH = 5000;

/**
 * Split a region into cells.
 *
 * One rectangle over a whole county is not enough: Text Search returns at most
 * sixty results for a query however big the fence, so a single box means the
 * sixty best-known karting tracks in Surrey and nothing in the corners. Cells
 * cost calls in proportion, which is the trade — and the whole reason this
 * function takes the number rather than assuming it.
 */
export function cellsFor({ lat, lng, spanKm = 40, across = 2 }) {
  const cells = [];
  const half = spanKm / 2;
  const step = spanKm / across;
  for (let i = 0; i < across; i += 1) {
    for (let j = 0; j < across; j += 1) {
      const dLat = (-half + step * (i + 0.5)) / 111.32;
      const dLng = (-half + step * (j + 0.5)) / (111.32 * Math.cos((lat * Math.PI) / 180) || 1);
      cells.push({ lat: lat + dLat, lng: lng + dLng, radiusKm: step / 2 });
    }
  }
  return cells;
}

const OVERPASS = (process.env.ROAM_OVERPASS_URLS || 'https://overpass-api.de/api/interpreter').split(',')[0];

/**
 * Every day-out object OpenStreetMap holds in a region, in one request.
 *
 * The first version of this asked `matchOsm` per place, which for a county is
 * 2,308 Overpass requests — forty minutes of somebody else's server for an
 * answer that fits in one query. This fetches the map's whole answer for the
 * area once and matches in memory, which is both faster and considerably more
 * polite.
 */
async function osmNear({ lat, lng, spanKm }) {
  const dLat = spanKm / 2 / 111.32;
  const dLng = spanKm / 2 / (111.32 * Math.cos((lat * Math.PI) / 180) || 1);
  const box = `${(lat - dLat).toFixed(4)},${(lng - dLng).toFixed(4)},${(lat + dLat).toFixed(4)},${(lng + dLng).toFixed(4)}`;
  const q = `[out:json][timeout:120];(
    nwr(${box})["name"]["leisure"];
    nwr(${box})["name"]["tourism"];
    nwr(${box})["name"]["attraction"];
    nwr(${box})["name"]["historic"];
    nwr(${box})["name"]["sport"];
  );out tags center;`;
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'RoamBot/1.0 (roam activity sweep)' },
    body: new URLSearchParams({ data: q }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data = await res.json();
  return (data.elements ?? []).map((e) => ({
    ref: `${e.type}/${e.id}`,
    tags: e.tags ?? {},
    name: e.tags?.name ?? null,
    lat: e.lat ?? e.center?.lat ?? null,
    lng: e.lon ?? e.center?.lon ?? null,
  })).filter((e) => e.lat != null && e.name);
}

/**
 * The same place, seen by two indexes.
 *
 * Names first, position second: two different soft plays in one retail park are
 * fifty metres apart, and "Jump In" and "Jump In Trampoline Park" are one
 * business. So the names have to agree and the points have to be close, and
 * neither alone is enough.
 */
function findMatch(place, osmList) {
  const key = normalise(place.name);
  if (!key) return null;
  let best = null;
  for (const o of osmList) {
    const d = metresBetween(place, o);
    if (d > 300) continue;
    const k = normalise(o.name);
    if (!k) continue;
    const agrees = k === key || k.includes(key) || key.includes(k);
    if (!agrees) continue;
    const score = (k === key ? 1 : 0.75) - d / 3000;
    if (!best || score > best.score) best = { ...o, distanceM: Math.round(d), confidence: score, score };
  }
  return best;
}

/**
 * Everything Google can find to do in one region, researched into rows we own.
 *
 * Returns the accounting as well as the result, because the question the owner
 * asked is a cost question: "report back on how much it cost, so we can
 * establish how much it will cost for the whole country."
 */
export async function sweepRegion(slug, {
  queries = ACTIVITY_QUERIES, across = 2, pages = 2, spanKm = 40,
  onLine, startedBy, dryRun = false,
} = {}) {
  const region = await lib.regionBySlug(slug);
  if (!region) throw new Error(`No region "${slug}"`);
  if (region.lat == null) throw new Error(`Region "${slug}" has no centre`);

  const { rows: [run] } = await query(
    `insert into sweep_runs (region_slug, provider, started_by, queries, cells)
     values ($1, 'google', $2, $3, $4) returning *`,
    [slug, startedBy ?? null, queries.length, across * across]);

  const cells = cellsFor({ lat: region.lat, lng: region.lng, spanKm, across });
  const found = new Map();
  const problems = [];
  let calls = 0;

  try {
    for (const [n, cell] of cells.entries()) {
      onLine?.(`${region.name}: cell ${n + 1} of ${cells.length}`);
      // `includedType: null` is the whole point of the parameter: fencing to one
      // Google type would lose go-karting, which is not a type at all.
      const out = await sweepArea({
        center: cell, radiusKm: cell.radiusKm, queries, pages,
        includedType: null, keepLodging: false,
      });
      calls += out.calls;
      problems.push(...out.problems);
      for (const p of out.places) if (!found.has(p.sourcePlaceId)) found.set(p.sourcePlaceId, p);
      await query('update sweep_runs set calls = $2, found = $3 where id = $1', [run.id, calls, found.size]);
    }
    onLine?.(`${region.name}: Google returned ${found.size} distinct places for ${calls} requests`);

    // --- turn the pointers into records we own ------------------------------
    let matched = 0; let kept = 0;
    if (!dryRun) {
      onLine?.(`${region.name}: asking OpenStreetMap what it knows about the same ground`);
      let osmList = [];
      try {
        osmList = await osmNear({ lat: region.lat, lng: region.lng, spanKm });
        onLine?.(`${region.name}: OpenStreetMap has ${osmList.length} named places here`);
      } catch (err) {
        problems.push(`overpass: ${err.message}`);
        onLine?.(`${region.name}: OpenStreetMap did not answer — everything stays a pointer`);
      }
      for (const p of found.values()) {
        const osm = findMatch(p, osmList);
        const owned = Boolean(osm && osm.confidence >= 0.6);
        if (owned) matched += 1;
        if (await upsertSwept(slug, p, osm, owned)) kept += 1;
      }
    }

    const billable = Math.max(0, calls);   // the allowance is applied estate-wide, in the report
    await query(
      `update sweep_runs set calls = $2, found = $3, matched = $4, kept = $5,
              cost_cents = $6, problems = $7, finished_at = now() where id = $1`,
      [run.id, calls, found.size, matched, kept,
       Math.round(billable * USD_PER_CALL * 100), JSON.stringify(problems.slice(0, 40))]);

    onLine?.(`${region.name}: ${matched} of ${found.size} matched in OpenStreetMap and are ours; ${kept} written`);
    return { runId: run.id, calls, found: found.size, matched, kept, problems };
  } catch (err) {
    await query('update sweep_runs set problems = $2, finished_at = now() where id = $1',
      [run.id, JSON.stringify([...problems, err.message].slice(0, 40))]);
    throw err;
  }
}

/**
 * Write one swept place.
 *
 * What lands depends entirely on whether OpenStreetMap knew about it, and that
 * is the licence boundary made concrete:
 *
 *   matched — the name, position and website are OpenStreetMap's, ODbL, ours to
 *             keep and to put on a phone. `display_source` stays null.
 *   not     — we keep that a place exists, where roughly, and what we asked to
 *             find it. The name is Google's and is *not* written: the row
 *             carries `display_source = 'google'` and the screen must fetch it.
 */
async function upsertSwept(slug, p, osm, owned) {
  const ref = `google:${p.sourcePlaceId}`;
  const name = owned ? (osm.tags?.name ?? null) : null;
  // Without a name we can show, there is nothing to publish yet — but the
  // pointer is still worth keeping, because it is what a later pass researches.
  const { rowCount } = await query(
    `insert into attractions
       (region_slug, source, external_ref, wikidata_id, name, slug, category, kinds,
        lat, lng, website, osm_ref, display_source, crowd_band, count_band, found_by,
        state, attribution)
     values ($1,'google',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'candidate',$16)
     on conflict (region_slug, external_ref) where external_ref is not null
     do update set
       name = coalesce(excluded.name, attractions.name),
       lat = coalesce(excluded.lat, attractions.lat),
       lng = coalesce(excluded.lng, attractions.lng),
       website = coalesce(excluded.website, attractions.website),
       osm_ref = coalesce(excluded.osm_ref, attractions.osm_ref),
       display_source = excluded.display_source,
       crowd_band = excluded.crowd_band,
       count_band = excluded.count_band,
       last_seen = now(), updated_at = now()`,
    [slug, ref,
     osm?.tags?.wikidata ?? null,
     name ?? `(${p.matchedQuery})`,
     name ? slugify(name) : `google-${p.sourcePlaceId.slice(0, 12).toLowerCase()}`,
     categoryFor(p, osm),
     [],
     // A Google coordinate may be kept 30 days; an OpenStreetMap one for ever.
     // So the matched row takes the map's position and the unmatched one takes
     // Google's, which the sweep refreshes well inside the month.
     owned ? osm.lat : p.lat,
     owned ? osm.lng : p.lng,
     owned ? (osm.tags?.website ?? osm.tags?.['contact:website'] ?? null) : null,
     owned ? osm.ref : null,
     owned ? null : 'google',
     p.crowdBand ?? null, p.countBand ?? null, p.matchedQuery ?? null,
     JSON.stringify(owned
       ? [{ source: 'OpenStreetMap', licence: 'ODbL', url: 'https://www.openstreetmap.org/copyright' }]
       : [{ source: 'Google', licence: 'place identifier only — display fetched live', note: 'Powered by Google' }])]);
  return rowCount > 0;
}

const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/** Roam's own word for it, from what the map says first and the query second. */
function categoryFor(p, osm) {
  const t = osm?.tags ?? {};
  if (t.tourism === 'zoo' || t.attraction === 'animal' || t.tourism === 'aquarium') return 'animals';
  if (t.tourism === 'theme_park' || t.leisure === 'water_park' || t.leisure === 'trampoline_park'
      || t.leisure === 'indoor_play' || t.leisure === 'playground') return 'family';
  if (t.tourism === 'museum' || t.tourism === 'gallery') return 'museum';
  if (t.leisure === 'nature_reserve' || t.leisure === 'park' || t.leisure === 'garden') return 'outdoors';
  if (t.historic || t.tourism === 'attraction') return 'heritage';
  if (t.leisure || t.sport) return 'active';
  const q = String(p.matchedQuery ?? '');
  if (/play|farm|maze|theme|water park|railway/.test(q)) return 'family';
  if (/zoo|aquarium|wildlife|birds/.test(q)) return 'animals';
  if (/museum|gallery|theatre|cinema|historic|castle/.test(q)) return /museum|gallery/.test(q) ? 'museum' : 'heritage';
  if (/park|reserve|garden|walk/.test(q)) return 'outdoors';
  return 'active';
}

/**
 * What the sweeps have cost, and what the rest of the country would.
 *
 * The free allowance is monthly and estate-wide, so it cannot be attributed to
 * a single county's run — it is applied here, once, over the month's total.
 */
export async function sweepCost() {
  const { rows } = await query(
    `select coalesce(sum(calls), 0)::int as calls,
            coalesce(sum(found), 0)::int as found,
            coalesce(sum(matched), 0)::int as matched,
            coalesce(sum(kept), 0)::int as kept,
            count(*)::int as runs,
            count(distinct region_slug)::int as regions
       from sweep_runs
      where started_at >= date_trunc('month', now())`);
  const t = rows[0];
  const billable = Math.max(0, t.calls - FREE_PER_MONTH);
  const perRegion = t.regions ? t.calls / t.regions : 0;
  const { rows: [{ n: allRegions }] } = await query('select count(*)::int as n from regions');
  const wholeCountryCalls = Math.round(perRegion * allRegions);
  return {
    ...t,
    freePerMonth: FREE_PER_MONTH,
    usdPerCall: USD_PER_CALL,
    billableCalls: billable,
    costUsd: Number((billable * USD_PER_CALL).toFixed(2)),
    perRegion: Number(perRegion.toFixed(1)),
    wholeCountry: {
      regions: allRegions,
      calls: wholeCountryCalls,
      costUsd: Number((Math.max(0, wholeCountryCalls - FREE_PER_MONTH) * USD_PER_CALL).toFixed(2)),
      note: 'At the same queries and cells, in one month. Spread over two months the free allowance applies twice.',
    },
  };
}

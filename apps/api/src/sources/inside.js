// What is inside a place (owner, 4 Sep 2026).
//
// "Saw the Ride… is a ride in Thorpe Park… the rides can't be mixed in with
// actual other events like Chertsey Museum or Staines Park… that should be in
// the side drawer when I open Thorpe Park, so I can see the different rides, or
// maybe schedule the things that I want to see… you could build your ride
// order… that would be our own proprietary information that you've gone
// sourced."
//
// A theme park is not one place, it is forty. This module goes and finds those
// forty, and everything it uses is a source whose licence lets us keep the
// answer for good — the same rule as sources/own.js:
//
//   OpenStreetMap  the rides themselves: name, what kind of ride, where it
//                  stands, its own page on the park's site, its Wikidata id.
//                  ODbL, ours to keep, attribution required.
//   Wikidata       how high, how fast, how long, the year it opened, who built
//                  it. CC0 — ours outright, no condition at all.
//   Wikipedia      a paragraph about the ride where there is an article.
//                  CC BY-SA, attribution required.
//
// Nothing here is Google's and nothing expires, which is what makes it fit to
// go on the device and stay there.

import { query } from '../db.js';
import { OSM_ATTRIBUTION } from './osm.js';

const ENDPOINTS = (process.env.ROAM_OVERPASS_URLS || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter').split(',');
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const WIKI = 'https://en.wikipedia.org/w/api.php';
const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; place research)';

/** How far a place's grounds reach, by what kind of place it is. */
export const GROUNDS_KM = { 'theme-park': 1.2, zoo: 1.0, 'water-park': 0.8, aquarium: 0.4, 'safari-park': 3.0 };
export const groundsRadiusKm = (experiences = []) => experiences.reduce((r, e) => Math.max(r, GROUNDS_KM[e] ?? 0), 0);

// What the map calls a ride, and what a family calls it.
const KINDS = {
  roller_coaster: ['roller-coaster', 'Roller coaster'],
  water_slide: ['water-slide', 'Water slide'],
  log_flume: ['water-ride', 'Water ride'],
  river_rafting: ['water-ride', 'Water ride'],
  water_ride: ['water-ride', 'Water ride'],
  drop_tower: ['thrill-ride', 'Drop tower'],
  amusement_ride: ['flat-ride', 'Ride'],
  bumper_car: ['flat-ride', 'Dodgems'],
  carousel: ['flat-ride', 'Carousel'],
  big_wheel: ['flat-ride', 'Big wheel'],
  dark_ride: ['dark-ride', 'Dark ride'],
  ghost_train: ['dark-ride', 'Ghost train'],
  maze: ['walkthrough', 'Maze'],
  animal: ['animals', 'Animals'],
  train: ['transport', 'Train'],
  boat: ['transport', 'Boat'],
  summer_toboggan: ['thrill-ride', 'Toboggan'],
  playground: ['play', 'Playground'],
};
const kindFor = (tags) => {
  const raw = String(tags.attraction || '').split(';')[0];
  if (KINDS[raw]) return KINDS[raw];
  if (tags.amenity === 'toilets') return ['facility', 'Toilets'];
  if (['cafe', 'fast_food', 'restaurant', 'ice_cream', 'bar', 'pub'].includes(tags.amenity)) return ['eat', 'Somewhere to eat'];
  if (tags.shop) return ['shop', 'Shop'];
  if (tags.tourism === 'attraction') return ['attraction', 'Attraction'];
  return ['attraction', 'Attraction'];
};
// The order a family reads them in: the big rides first, the loos last.
const KIND_ORDER = ['roller-coaster', 'thrill-ride', 'water-ride', 'water-slide', 'dark-ride', 'flat-ride', 'walkthrough', 'animals', 'play', 'transport', 'attraction', 'eat', 'shop', 'facility'];

async function overpass(body) {
  let last = null;
  // The open map is free and often busy: each endpoint is asked twice, with a
  // pause, before the research is called off.
  for (const url of [...ENDPOINTS, ...ENDPOINTS]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: `data=${encodeURIComponent(body)}`,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`overpass ${res.status}`);
      const text = await res.text();
      if (!text.trim().startsWith('{')) throw new Error('overpass busy');
      return JSON.parse(text);
    } catch (err) { last = err; await new Promise((r) => setTimeout(r, 4000)); }
  }
  throw last ?? new Error('overpass unavailable');
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

const metres = (v) => { const n = Number(String(v).replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

/**
 * The rides, the animals, the places to eat and the loos inside one place.
 * Overpass answers with everything mapped in the grounds; the duplicates a big
 * ride leaves behind (a way for the track, a node for the station, four
 * segments of the same flume) are folded into one by name.
 */
async function fromOsm({ lat, lng, radiusKm }) {
  const r = Math.round(radiusKm * 1000);
  return itemsFromElements((await overpass(
    `[out:json][timeout:80];(` +
    `nwr(around:${r},${lat},${lng})[attraction][name];` +
    `nwr(around:${r},${lat},${lng})[tourism=attraction][name];` +
    `nwr(around:${r},${lat},${lng})[amenity~"^(cafe|fast_food|restaurant|ice_cream|toilets)$"][name];` +
    `);out tags center;`,
  )).elements || []);
}

/** What the map's answer means: one entry per thing, its kind, and the facts on it. */
export function itemsFromElements(elements) {
  const byName = new Map();
  for (const el of elements) {
    const tags = el.tags || {};
    const name = String(tags.name || '').trim();
    if (!name || /^(abandoned|demolished)/.test(String(tags.attraction || ''))) continue;
    if (tags.abandoned || tags['disused:attraction']) continue;
    const [kind, kindLabel] = kindFor(tags);
    const key = `${name.toLowerCase()}|${kind}`;
    const held = byName.get(key);
    // The richest copy of a ride wins: the one that carries its Wikidata id and
    // its own page rather than the bare piece of track.
    const richness = Object.keys(tags).length + (tags.wikidata ? 5 : 0) + (tags.website ? 3 : 0);
    if (held && held.richness >= richness) continue;
    byName.set(key, {
      richness,
      itemRef: `osm:${el.type}/${el.id}`,
      name,
      kind,
      kindLabel,
      lat: el.lat ?? el.center?.lat ?? null,
      lng: el.lon ?? el.center?.lon ?? null,
      website: tags.website || tags['contact:website'] || null,
      wikidataId: /^Q\d+$/.test(tags.wikidata || '') ? tags.wikidata : null,
      wikipediaTitle: tags.wikipedia?.startsWith('en:') ? tags.wikipedia.slice(3) : null,
      facts: {
        ...(tags.min_height && tags.min_height !== '*' ? { minHeightM: metres(tags.min_height) } : {}),
        ...(tags['roller_coaster:type'] ? { coasterType: tags['roller_coaster:type'].replace(/_/g, ' ') } : {}),
        ...(tags.opening_date ? { opened: tags.opening_date } : {}),
        ...(tags.operator ? { operator: tags.operator } : {}),
        ...(tags.description ? { note: String(tags.description).slice(0, 300) } : {}),
        ...(tags.fee === 'yes' ? { extraCharge: true } : {}),
      },
      provenance: { name: 'osm', kind: 'osm', lat: 'osm', lng: 'osm' },
    });
  }
  return [...byName.values()];
}

// Wikidata's units, and what it takes to say them in ours. Anything not here
// is left out rather than guessed at: a number without a unit is not a fact.
const UNITS = {
  Q11573: 1, Q828224: 1000, Q174728: 0.01,          // metre, kilometre, centimetre
  Q3710: 0.3048, Q218593: 0.0254,                    // foot, inch
  Q180154: 1, Q182429: 1,                            // km/h, m/s treated as given
  Q3949: 1.60934, Q128822: 3.6,                      // mph → km/h, m/s → km/h
  Q199: 1,                                           // a bare number (capacity)
};

// The properties worth having about a ride, and what they are on Wikidata.
const CLAIMS = {
  P2048: ['heightM', 'quantity'],
  P2043: ['lengthM', 'quantity'],
  P2052: ['speedKph', 'quantity'],
  P571: ['opened', 'time'],
  P176: ['builtBy', 'entity'],
  P1436: ['capacity', 'quantity'],
};

/** How high, how fast, how long, when it opened, who built it — CC0, ours outright. */
async function fromWikidata(items) {
  const ids = items.map((i) => i.wikidataId).filter(Boolean).slice(0, 50);
  if (!ids.length) return new Map();
  const data = await getJson(`${WIKIDATA}?action=wbgetentities&ids=${ids.join('|')}&props=claims&format=json&origin=*`);
  const labels = new Set();
  const out = new Map();
  for (const [qid, entity] of Object.entries(data.entities || {})) {
    const facts = {};
    for (const [prop, [field, shape]] of Object.entries(CLAIMS)) {
      const claim = entity.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
      if (claim == null) continue;
      if (shape === 'quantity') {
        // Wikidata keeps the number and the unit apart, and a coaster's height
        // is as often in feet as in metres. Stealth is 205 feet, not 205 metres.
        const n = Number(String(claim.amount).replace('+', ''));
        const unit = String(claim.unit || '').split('/').pop();
        const scale = UNITS[unit];
        if (Number.isFinite(n) && scale !== undefined) facts[field] = Math.round(n * (scale || 1) * 10) / 10;
      }
      else if (shape === 'time') { const m = String(claim.time).match(/(\d{4})/); if (m) facts[field] = m[1]; }
      else if (shape === 'entity' && claim.id) { facts[field] = claim.id; labels.add(claim.id); }
    }
    if (Object.keys(facts).length) out.set(qid, facts);
  }
  // Who built it comes back as another Wikidata id; one more call names them.
  if (labels.size) {
    try {
      const named = await getJson(`${WIKIDATA}?action=wbgetentities&ids=${[...labels].slice(0, 50).join('|')}&props=labels&languages=en&format=json&origin=*`);
      for (const facts of out.values()) {
        const label = facts.builtBy && named.entities?.[facts.builtBy]?.labels?.en?.value;
        if (label) facts.builtBy = label; else delete facts.builtBy;
      }
    } catch { for (const facts of out.values()) delete facts.builtBy; }
  }
  return out;
}

/** A paragraph about the ride, where somebody has written one. */
async function fromWikipedia(items) {
  const titles = items.map((i) => i.wikipediaTitle).filter(Boolean).slice(0, 20);
  if (!titles.length) return new Map();
  const data = await getJson(`${WIKI}?action=query&prop=extracts|info&inprop=url&exintro=1&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(titles.join('|'))}`);
  const out = new Map();
  for (const page of Object.values(data.query?.pages || {})) {
    if (!page.title || !page.extract) continue;
    out.set(page.title, { summary: String(page.extract).split('\n')[0].slice(0, 600), url: page.fullurl || null });
  }
  return out;
}

/**
 * Research what is inside one place and keep it. Returns the rows as stored.
 * `force` re-researches a park whose contents are already held.
 */
export async function researchInside({ parentRef, name, lat, lng, radiusKm, force = false }) {
  if (!parentRef || lat == null || lng == null || !radiusKm) return [];
  if (!force) {
    const { rows } = await query('select contents_state, contents_at from place_records where venue_ref = $1', [parentRef]);
    const held = rows[0];
    if (held?.contents_state === 'done' && held.contents_at && Date.now() - new Date(held.contents_at).getTime() < 30 * 86_400_000) {
      return contentsOf(parentRef);
    }
  }
  await query(
    `insert into place_records (venue_ref, name, lat, lng, contents_state)
     values ($1,$2,$3,$4,'pending')
     on conflict (venue_ref) do update set contents_state = 'pending'`,
    [parentRef, name ?? null, lat, lng],
  );

  let items = [];
  try {
    items = await fromOsm({ lat, lng, radiusKm });
  } catch (err) {
    await query('update place_records set contents_state = $2 where venue_ref = $1', [parentRef, 'failed']);
    throw err;
  }

  const rides = items.filter((i) => !['eat', 'shop', 'facility'].includes(i.kind));
  const [wd, wp] = await Promise.all([
    fromWikidata(rides).catch(() => new Map()),
    fromWikipedia(rides).catch(() => new Map()),
  ]);

  const order = (i) => KIND_ORDER.indexOf(i.kind);
  items.sort((a, b) => (order(a) - order(b)) || a.name.localeCompare(b.name));

  for (const [position, item] of items.entries()) {
    const extra = item.wikidataId ? wd.get(item.wikidataId) ?? {} : {};
    const article = item.wikipediaTitle ? wp.get(item.wikipediaTitle) ?? null : null;
    const attribution = [OSM_ATTRIBUTION];
    if (Object.keys(extra).length) attribution.push('Wikidata, CC0');
    if (article) attribution.push('Wikipedia, CC BY-SA 4.0');
    const provenance = { ...item.provenance, ...Object.fromEntries(Object.keys(extra).map((k) => [k, 'wikidata'])), ...(article ? { summary: 'wikipedia' } : {}) };
    await query(
      `insert into place_contents (parent_ref, item_ref, name, kind, kind_label, lat, lng, facts, summary, summary_source, website, wikidata_id, wikipedia_url, attribution, provenance, position, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       on conflict (parent_ref, item_ref) do update set
         name = excluded.name, kind = excluded.kind, kind_label = excluded.kind_label,
         lat = excluded.lat, lng = excluded.lng, facts = excluded.facts,
         summary = excluded.summary, summary_source = excluded.summary_source, website = excluded.website,
         wikidata_id = excluded.wikidata_id, wikipedia_url = excluded.wikipedia_url,
         attribution = excluded.attribution, provenance = excluded.provenance,
         position = excluded.position, updated_at = now()`,
      [
        parentRef, item.itemRef, item.name, item.kind, item.kindLabel, item.lat, item.lng,
        JSON.stringify({ ...item.facts, ...extra }), article?.summary ?? null, article ? 'wikipedia' : null,
        item.website, item.wikidataId, article?.url ?? null,
        JSON.stringify(attribution), JSON.stringify(provenance), position,
      ],
    );
  }
  await query(
    `update place_records set contents_state = 'done', contents_count = $2, contents_at = now(), updated_at = now() where venue_ref = $1`,
    [parentRef, items.length],
  );
  return contentsOf(parentRef);
}

/** What we hold about the inside of a place. */
export async function contentsOf(parentRef) {
  const { rows } = await query(
    `select item_ref, name, kind, kind_label, lat, lng, facts, summary, summary_source, website, wikidata_id, wikipedia_url, attribution
       from place_contents where parent_ref = $1 order by position`,
    [parentRef],
  );
  return rows.map((r) => ({
    itemRef: r.item_ref, name: r.name, kind: r.kind, kindLabel: r.kind_label,
    lat: r.lat, lng: r.lng, facts: r.facts ?? {}, summary: r.summary, summarySource: r.summary_source,
    website: r.website, wikidataId: r.wikidata_id, wikipediaUrl: r.wikipedia_url, attribution: r.attribution ?? [],
  }));
}

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

import * as placeContents from '../repositories/placeContents.js';
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
async function fromOsm({ lat, lng, radiusKm, areaRef = null }) {
  const wanted =
    `nwr(SCOPE)[attraction][name];` +
    `nwr(SCOPE)[tourism=attraction][name];` +
    `nwr(SCOPE)[amenity~"^(cafe|fast_food|restaurant|ice_cream|toilets)$"][name];`;

  // Where the place is mapped as an area — a park's boundary, a zoo's fence —
  // ask for what is *inside it* rather than what is within so many metres of
  // its middle. A radius around Thorpe Park's centre reaches the retail park
  // over the road; the polygon does not, and it also does not stop short of
  // the far end of Alton Towers, which is a mile from its centre.
  if (areaRef) {
    const [kind, id] = String(areaRef).split('/');
    if ((kind === 'way' || kind === 'relation') && /^\d+$/.test(id ?? '')) {
      // Overpass numbers areas from the element they were made from; asking it
      // to derive one with map_to_area avoids having to know the offset.
      try {
        const inside = itemsFromElements((await overpass(
          `[out:json][timeout:80];${kind}(id:${id});map_to_area->.g;(` +
          wanted.replace(/SCOPE/g, 'area.g') +
          `);out tags center;`,
        )).elements || []);
        if (inside.length) return inside;
      } catch { /* fall through to the radius, which always works */ }
    }
  }

  const r = Math.round(radiusKm * 1000);
  return itemsFromElements((await overpass(
    `[out:json][timeout:80];(` + wanted.replace(/SCOPE/g, `around:${r},${lat},${lng}`) + `);out tags center;`,
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
export async function researchInside({ parentRef, name, lat, lng, radiusKm, areaRef = null, force = false }) {
  if (!parentRef || lat == null || lng == null || !radiusKm) return [];
  if (!force) {
    const held = await placeContents.contentsState(parentRef);
    if (held?.contents_state === 'done' && held.contents_at && Date.now() - new Date(held.contents_at).getTime() < 30 * 86_400_000) {
      return contentsOf(parentRef);
    }
  }
  await placeContents.markResearching(parentRef, name, lat, lng);

  let items = [];
  try {
    items = await fromOsm({ lat, lng, radiusKm, areaRef });
  } catch (err) {
    await placeContents.markResearchFailed(parentRef);
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
    await placeContents.upsertContent(parentRef, {
      itemRef: item.itemRef, name: item.name, kind: item.kind, kindLabel: item.kindLabel,
      lat: item.lat, lng: item.lng, facts: { ...item.facts, ...extra },
      summary: article?.summary ?? null, summarySource: article ? 'wikipedia' : null,
      website: item.website, wikidataId: item.wikidataId, wikipediaUrl: article?.url ?? null,
      attribution, provenance, position,
    });
  }
  await placeContents.markResearchDone(parentRef, items.length);
  return contentsOf(parentRef);
}

/** What we hold about the inside of a place. */
export async function contentsOf(parentRef) {
  const rows = await placeContents.contentsRows(parentRef);
  return rows.map((r) => ({
    itemRef: r.item_ref, name: r.name, kind: r.kind, kindLabel: r.kind_label,
    lat: r.lat, lng: r.lng, facts: r.facts ?? {}, summary: r.summary, summarySource: r.summary_source,
    website: r.website, wikidataId: r.wikidata_id, wikipediaUrl: r.wikipedia_url, attribution: r.attribution ?? [],
  }));
}

// ---------------------------------------------------------------------------
// the place itself
// ---------------------------------------------------------------------------

// How far a place's grounds reach when the map has it only as a point, by what
// the map calls it. A fallback: `fromOsm` prefers the polygon whenever there is
// one, and these numbers only decide how wide to cast when there is not.
const TAG_GROUNDS = [
  [/^theme_park$/, 1.2], [/^zoo$/, 1.0], [/^safari_park$/, 3.0], [/^water_park$/, 0.8],
  [/^aquarium$/, 0.4], [/^museum$/, 0.25], [/^gallery$/, 0.2], [/^attraction$/, 0.4],
  [/^castle$/, 0.4], [/^manor$/, 0.4], [/^ruins$/, 0.3], [/^monument$/, 0.2],
  [/^garden$/, 0.6], [/^park$/, 1.0], [/^nature_reserve$/, 1.5],
];

/** What the map calls this place, and therefore how far to look around it. */
export function groundsFromTags(tags = {}) {
  const words = [tags.tourism, tags.historic, tags.leisure, tags.attraction, tags.amenity]
    .filter(Boolean).map((w) => String(w).split(';')[0]);
  let km = 0;
  for (const w of words) for (const [re, r] of TAG_GROUNDS) if (re.test(w)) km = Math.max(km, r);
  return km;
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The map's own entry for one place: its tags, and whether it is an area.
 *
 * The tags are where the practicalities live — when it opens, whether there is
 * a charge, whether you can get a wheelchair round it, whether there are loos
 * and somewhere to park and whether the dog can come. None of that is in an
 * encyclopedia and all of it decides whether a family goes.
 *
 * Found by Wikidata id first, which is exact and needs no judgement, then by
 * name within 800m, which does. An attraction that Wikidata already gave us an
 * `osm_ref` for skips both and is fetched directly.
 */
export async function placeTags({ osmRef = null, wikidataId = null, name = null, lat = null, lng = null } = {}) {
  const clauses = [];
  if (osmRef && /^(node|way|relation)\/\d+$/.test(osmRef)) {
    const [kind, id] = osmRef.split('/');
    clauses.push(`${kind}(id:${id});`);
  }
  if (wikidataId && /^Q\d+$/.test(wikidataId)) clauses.push(`nwr["wikidata"="${wikidataId}"];`);
  if (!clauses.length && name && lat != null && lng != null) {
    clauses.push(`nwr(around:800,${lat},${lng})[name][~"^(tourism|historic|leisure|attraction)$"~"."];`);
  }
  if (!clauses.length) return null;

  let elements;
  try {
    elements = (await overpass(`[out:json][timeout:60];(${clauses.join('')});out tags center;`)).elements || [];
  } catch { return null; }
  if (!elements.length) return null;

  const wanted = norm(name);
  // An exact identifier beats a name; among names, the one that actually
  // matches beats the nearest café that happens to be tagged historic.
  const pick = elements.find((e) => e.tags?.wikidata && e.tags.wikidata === wikidataId)
    ?? elements.find((e) => wanted && norm(e.tags?.name) === wanted)
    ?? (osmRef ? elements[0] : null);
  if (!pick) return null;

  return {
    ref: `${pick.type}/${pick.id}`,
    isArea: pick.type !== 'node',
    lat: pick.lat ?? pick.center?.lat ?? null,
    lng: pick.lon ?? pick.center?.lon ?? null,
    tags: pick.tags ?? {},
  };
}

// What a tag means to a family, and the tags that carry it. Only the ones a
// household actually asks about before setting off — this is not a dump of
// everything OpenStreetMap knows, it is the six questions that decide a day.
const YES = (v) => v != null && !/^(no|none|false)$/i.test(String(v));

/** The map's answer to "can we actually go, and what do we need to know". */
export function visitFromTags(tags = {}) {
  const out = {};
  if (tags.opening_hours) out.openingHours = tags.opening_hours;
  if (tags['opening_hours:signed'] === 'no') out.seasonal = 'Hours are not signed at the gate';
  if (tags.fee != null) out.fee = /^(no|free)$/i.test(tags.fee) ? 'free' : 'charged';
  if (tags.charge) out.charge = tags.charge;
  if (tags.website || tags['contact:website']) out.website = tags.website ?? tags['contact:website'];
  if (tags.phone || tags['contact:phone']) out.phone = tags.phone ?? tags['contact:phone'];
  if (tags.wheelchair) out.wheelchair = tags.wheelchair;
  if (tags['wheelchair:description']) out.stepFree = tags['wheelchair:description'];
  if (tags['toilets:wheelchair']) out.wheelchairToilet = tags['toilets:wheelchair'];
  if (YES(tags.toilets)) out.toilets = true;
  if (YES(tags.dog) || YES(tags.dogs)) out.dogs = tags.dog ?? tags.dogs;
  if (tags.parking || YES(tags['service:parking'])) out.parking = tags.parking ?? 'yes';
  if (tags.operator) out.operator = tags.operator;
  if (tags['addr:street']) {
    out.address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:postcode']]
      .filter(Boolean).join(', ');
  }
  if (tags['addr:postcode']) out.postcode = tags['addr:postcode'];
  return out;
}

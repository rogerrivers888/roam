// A picture of a place itself, rather than of something inside it.
//
// Owner, 5 Sep 2026: "Can you go and get images for all of the different trips
// and countries that we have in the app (Italy, UK, and the different UK
// locations) so that we have something to represent each 1 of the countries and
// locations?"
//
// The atlas already puts a picture on a city, but it borrows one from a venue
// inside it — so a card for Bath shows a restaurant in Bath, and shows nothing
// at all until some place in Bath has been photographed. What a country or a
// city wants is a portrait of itself: the London skyline, the Roman forum, Bath
// from the hill.
//
// Same machinery and same rules as the attraction images (sources/harvest.js):
// Wikidata says which item a place is, Wikipedia's article says which
// photographs are worth having, Commons says what licence each is under, and
// nothing is stored whose licence does not permit it.
//
// Two things here that the attraction pass does not need:
//
//   * **Resolving a name to the right item.** "Runnymede" matched a Russian
//     prince the first time I tried it by guessing QIDs. A name is resolved
//     against Wikidata's search and then *verified against the coordinates the
//     app already holds* — within 40 km, or it is not that place.
//   * **Refusing a picture that is not a photograph of anywhere.** Italy's
//     designated image is a satellite photograph taken in 2003, which is a fine
//     illustration for an encyclopedia and a terrible one for a card that is
//     meant to make somebody want to go. Maps, flags, coats of arms, locator
//     diagrams and satellite images are all rejected in favour of the pictures
//     the article actually leads with.

import crypto from 'node:crypto';
import * as wm from './wikimedia.js';
import * as lib from '../repositories/library.js';

const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const WIDTHS = [20, 500, 960];

/**
 * Not a photograph of a place, whatever else it may be.
 *
 * The satellite image is the one that prompted this: it is what Wikidata
 * nominates for most countries, and it makes every country card look like a
 * weather report.
 */
const NOT_A_PORTRAIT = /satellite|orthographic|locator|location map|\bmap\b|flag of|coat of arms|\bseal\b|\bemblem\b|blank|outline|\bchart\b|logo|orthophoto|topograph|relief|globe|projection/i;

const km = (a, b) => {
  if (a?.lat == null || b?.lat == null) return Infinity;
  const R = (d) => (d * Math.PI) / 180;
  const s = Math.sin(R(b.lat - a.lat) / 2) ** 2
    + Math.cos(R(a.lat)) * Math.cos(R(b.lat)) * Math.sin(R(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
};

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': wm.UA, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

/**
 * Which Wikidata item this place is.
 *
 * By name, then checked against the point the app already holds for it. The
 * check is the whole value of this function: Wikidata's search will confidently
 * return a person, a film or a ship for a place name, and forty kilometres is
 * generous enough for a county and tight enough to catch all three.
 */
export async function resolveItem({ name, lat, lng, countryCode }) {
  const p = new URLSearchParams({
    action: 'wbsearchentities', format: 'json', language: 'en', uselang: 'en',
    type: 'item', limit: '7', search: name, origin: '*',
  });
  const hits = (await getJson(`${WIKIDATA}?${p}`)).search ?? [];
  if (!hits.length) return null;

  // Ask Wikidata where each candidate is, and keep the one that is where we
  // think the place is.
  const ids = hits.map((h) => h.id);
  const rows = await wm.sparql(`
    SELECT ?item ?lat ?lng ?countryCode WHERE {
      VALUES ?item { ${ids.map((i) => `wd:${i}`).join(' ')} }
      OPTIONAL { ?item p:P625/psv:P625 ?co . ?co wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lng . }
      OPTIONAL { ?item wdt:P17/wdt:P297 ?countryCode }
      OPTIONAL { ?item wdt:P297 ?countryCode }
    }`);
  const where = new Map(rows.map((r) => [r.item.split('/').pop(), r]));

  for (const h of hits) {
    const w = where.get(h.id);
    if (!w) continue;
    // A country has no single point, so it is matched on its ISO code instead.
    if (lat == null && countryCode) {
      if (String(w.countryCode || '').toUpperCase() === countryCode.toUpperCase()) return { id: h.id, label: h.label, how: 'iso code' };
      continue;
    }
    if (w.lat == null) continue;
    const d = km({ lat, lng }, { lat: Number(w.lat), lng: Number(w.lng) });
    if (d <= 40) return { id: h.id, label: h.label, how: `${Math.round(d)} km from where we had it` };
  }
  return null;
}

/** The files worth considering for a portrait, best guess first. */
async function candidates(itemId) {
  const rows = await wm.sparql(`
    SELECT ?img ?article WHERE {
      OPTIONAL { wd:${itemId} wdt:P18 ?img }
      OPTIONAL { ?article schema:about wd:${itemId} ; schema:isPartOf <https://en.wikipedia.org/> }
    } LIMIT 1`);
  const row = rows[0] ?? {};
  const out = [];
  if (row.img) out.push(`File:${decodeURIComponent(String(row.img).split('/').pop()).replace(/_/g, ' ')}`);
  if (row.article) {
    const title = decodeURIComponent(String(row.article).split('/wiki/').pop()).replace(/_/g, ' ');
    try { out.push(...await wm.articleImages(title, { limit: 14 })); } catch { /* the article's pictures are a bonus */ }
  }
  // The nominated image goes first but is not trusted: for most countries it is
  // a satellite photograph, and the article's own pictures are better.
  return [...new Set(out)].filter((t) => !NOT_A_PORTRAIT.test(t));
}

/**
 * Of the pictures an article uses, the ones that are of the place.
 *
 * Taking the first storable one gave Italy a photograph of partisans in Milan in
 * 1945 and South Oxfordshire a railway platform at Didcot. Both are in the
 * article and neither is a portrait of anywhere — country articles lead with
 * history, and district articles lead with whatever somebody photographed.
 *
 * So a candidate has to *name* the place. It is the same rule that stopped
 * "South Ascot Playing Field" being illustrated by a car park, and the same
 * conclusion: where nothing names it, we would rather hold no picture than the
 * wrong one. A card with no photograph is a gap; a card with somebody else's
 * war is a mistake nobody can explain.
 */
function namesThePlace(title, name) {
  const words = String(name).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !['city', 'town', 'county', 'district', 'borough', 'upon', 'north', 'south', 'east', 'west', 'royal', 'the', 'and', 'of'].includes(w));
  if (!words.length) return false;
  const t = String(title).toLowerCase();
  return words.some((w) => t.includes(w));
}

/**
 * Find, licence-check, download and store one portrait.
 *
 * `subjectType` is 'country' or 'locality'; `subjectId` is what the rest of
 * Roam calls the place — an ISO code, or `GB:Bath`.
 */
export async function portraitFor({ subjectType, subjectId, name, lat, lng, countryCode, onLine, replace = false }) {
  const held = await lib.portraitOf(subjectType, subjectId);
  if (held && !replace) return { subjectId, already: true };
  if (held && replace) await lib.unlinkImage(held.id, subjectType, subjectId);

  const item = await resolveItem({ name, lat, lng, countryCode });
  if (!item) { onLine?.(`${name}: no Wikidata item within reach of where we hold it`); return { subjectId, resolved: false }; }
  onLine?.(`${name} → ${item.id} (${item.how})`);

  const all = await candidates(item.id);
  // Only the ones that name the place, in the order the article used them.
  const files = all.filter((t) => namesThePlace(t, name));
  if (!files.length) {
    onLine?.(`${name}: ${all.length} pictures in the article, none of them named it — leaving it blank`);
    return { subjectId, item: item.id, found: all.length, stored: 0, reason: 'nothing named the place' };
  }

  const details = await wm.fileDetails(files, { widths: WIDTHS });
  for (const title of files) {
    const f = details.get(title) ?? [...details.values()].find((d) => d.askedAs === title);
    if (!f || !f.mayStore) continue;
    // Portraits are wide by nature — a skyline, a valley, a square. A tall
    // photograph makes a poor banner and there is usually a better one below it.
    if (f.width && f.height && f.height > f.width * 1.1) continue;

    const variants = [];
    for (const width of WIDTHS) {
      const thumb = f.thumbs[width];
      if (!thumb) continue;
      const got = await wm.fetchImage(thumb.url);
      if (!got) continue;
      variants.push({ width, actualWidth: thumb.width, actualHeight: thumb.height, mime: got.mime, bytes: got.body.length, body: got.body });
    }
    if (!variants.length) continue;
    const small = variants.find((v) => v.width === 20) ?? variants[0];
    const large = variants[variants.length - 1];

    const image = await lib.saveImage({
      source: 'wikimedia', sourceRef: f.title, sourcePageUrl: f.descriptionUrl,
      licence: f.licence, licenceUrl: f.licenceUrl, usageTerms: f.usageTerms,
      restrictions: f.restrictions, attributionRequired: f.attributionRequired, mayStore: true,
      creator: f.creator, creatorUrl: f.creatorUrl,
      creditLine: f.attributionRequired
        ? `${f.creator || 'Unknown author'}, ${f.licence}, via Wikimedia Commons`
        : `${f.licence}, via Wikimedia Commons`,
      title: f.objectName || f.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
      caption: f.caption,
      tags: [name, subjectType, countryCode].filter(Boolean),
      mime: large.mime, width: f.width, height: f.height, bytes: large.bytes,
      sha256: crypto.createHash('sha256').update(large.body).digest('hex'),
      lqip: small.width === 20 ? `data:${small.mime};base64,${small.body.toString('base64')}` : null,
    }, variants);

    await lib.linkImage(image.id, { subjectType, subjectId, role: 'hero', position: 0 });
    onLine?.(`${name}: ${f.title.replace(/^File:/, '')} — ${f.licence}`);
    return { subjectId, item: item.id, imageId: image.id, file: f.title, licence: f.licence };
  }
  onLine?.(`${name}: ${files.length} pictures, none of them storable and wide`);
  return { subjectId, item: item.id, found: files.length, stored: 0 };
}

/**
 * Every country and place the app actually mentions, and a portrait for each.
 *
 * The list is read out of the household's own data rather than typed here:
 * trips, the atlas, and saved places. That way a family who plans a week in
 * Seville gets Seville, and nobody has to remember to add it to a constant.
 */
export async function portraitsForApp({ onLine, only, replace = false } = {}) {
  const { query } = await import('../db.js');
  const { rows: places } = await query(`
    select country_code, locality, max(lat) as lat, max(lng) as lng, sum(n) as n from (
      select country_code, locality, lat, lng, count(*) as n from atlas_cities group by 1,2,3,4
      union all
      select country_code, locality, null, null, count(*) from trips where locality is not null group by 1,2
      union all
      select country_code, locality, null, null, count(*) from household_places where locality is not null group by 1,2
    ) all_of_them
    where country_code is not null and locality is not null
    group by country_code, locality order by sum(n) desc`);

  const { rows: countries } = await query(`
    select country_code, count(*) as n from (
      select country_code from atlas_cities where country_code is not null
      union all select country_code from trips where country_code is not null
      union all select country_code from household_places where country_code is not null
    ) c group by country_code order by count(*) desc`);

  // A locality with no coordinates cannot be verified against a point, so it is
  // looked up with its country as the only guard. That is weaker, and it is why
  // the atlas rows (which do carry a point) are unioned in first.
  const named = new Map();
  for (const p of places) named.set(`${p.country_code}:${p.locality}`, p);

  const out = { countries: [], localities: [] };
  for (const c of countries) {
    if (only && !only.includes(c.country_code)) continue;
    out.countries.push(await portraitFor({
      subjectType: 'country', subjectId: c.country_code,
      name: COUNTRY_NAMES[c.country_code] ?? c.country_code,
      countryCode: c.country_code, onLine, replace,
    }));
  }
  for (const [id, p] of named) {
    if (only && !only.includes(id)) continue;
    out.localities.push(await portraitFor({
      subjectType: 'locality', subjectId: id, name: p.locality,
      lat: p.lat != null ? Number(p.lat) : null, lng: p.lng != null ? Number(p.lng) : null,
      countryCode: p.country_code, onLine, replace,
    }));
  }
  return out;
}

/**
 * The ISO codes the app has seen, in words.
 *
 * Searching Wikidata for "GB" finds a great many things that are not the United
 * Kingdom. Only the countries that have actually appeared need to be here; an
 * unknown code falls through to its own letters and simply fails to resolve,
 * which is the honest outcome rather than a wrong portrait.
 */
const COUNTRY_NAMES = {
  GB: 'United Kingdom', IE: 'Ireland', FR: 'France', IT: 'Italy', ES: 'Spain',
  PT: 'Portugal', DE: 'Germany', NL: 'Netherlands', BE: 'Belgium', US: 'United States',
  GR: 'Greece', HR: 'Croatia', AT: 'Austria', CH: 'Switzerland', SE: 'Sweden',
  NO: 'Norway', DK: 'Denmark', PL: 'Poland', CZ: 'Czech Republic', TR: 'Turkey',
};

// What the open encyclopedias know about a place: Wikipedia and Wikidata.
//
// This is where an attraction gets a description we are allowed to keep. A
// castle, a museum, a gallery or a park usually has an article; the extract is
// CC BY-SA 4.0, so it may be stored and shown for good provided the article is
// credited and linked, which is why `attribution` travels with the text and is
// never optional. Wikidata's own statements are CC0 — the official website, the
// year it opened, the image — and carry no condition at all.
//
// Restaurants rarely have articles, and that is fine: this returns null and the
// record is built from the map and the venue's own page instead.
//
// Licence note for the owner: CC BY-SA is share-alike on the *text*. Storing an
// extract and showing it with credit is the ordinary use and is what every
// travel app does; it does not put any licence on Roam's own data. Rewriting
// the extract into our own words would remove the condition entirely, and is
// the thing to do if that text is ever wanted without the credit line.

import { FOOD_CATEGORIES as EATING } from '../constants.js';

const WIKI = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; place research)';
const TIMEOUT = 8000;

// An article about a building that happens to be near is not an article about
// this restaurant; the point has to be close and the name has to agree.
const MAX_M = 400;

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

/** Articles with coordinates within `radius` metres of a point. */
async function geosearch(lat, lng, radius = MAX_M) {
  const p = new URLSearchParams({
    action: 'query', list: 'geosearch', gscoord: `${lat}|${lng}`, gsradius: String(radius),
    gslimit: '20', format: 'json', origin: '*',
  });
  const data = await get(`${WIKI}?${p}`);
  return (data?.query?.geosearch ?? []).map((g) => ({ title: g.title, pageId: g.pageid, distanceM: Math.round(g.dist) }));
}

/** The article itself: the opening paragraph, its picture, and its Wikidata id. */
async function article(title) {
  const p = new URLSearchParams({
    action: 'query', prop: 'extracts|pageimages|pageprops|info', titles: title,
    exintro: '1', explaintext: '1', exsentences: '4', piprop: 'original', pageprops: 'wikibase_item',
    inprop: 'url', format: 'json', origin: '*', redirects: '1',
  });
  const data = await get(`${WIKI}?${p}`);
  const page = Object.values(data?.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return null;
  return {
    title: page.title,
    summary: (page.extract || '').trim() || null,
    url: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    imageUrl: page.original?.source ?? null,
    wikidataId: page.pageprops?.wikibase_item ?? null,
  };
}

/** The statements worth keeping from a Wikidata entity: all CC0. */
async function entity(qid) {
  const p = new URLSearchParams({ action: 'wbgetentities', ids: qid, props: 'claims', format: 'json', origin: '*' });
  const data = await get(`${WIKIDATA}?${p}`);
  const claims = data?.entities?.[qid]?.claims ?? {};
  const first = (prop) => claims[prop]?.[0]?.mainsnak?.datavalue?.value ?? null;
  const inception = first('P571');
  return {
    officialWebsite: typeof first('P856') === 'string' ? first('P856') : null,
    // "+1894-01-01T00:00:00Z" — the year is the part worth showing.
    openedYear: inception?.time ? Number(String(inception.time).slice(1, 5)) || null : null,
    commonsImage: typeof first('P18') === 'string' ? first('P18') : null,
  };
}

/**
 * What the encyclopedias have on this place.
 *
 * Returns `{ summary, url, title, imageUrl, wikidataId, officialWebsite,
 * openedYear, attribution, distanceM, confidence }` or null. Two requests when
 * there is an article, three when it also has a Wikidata entity; all free, all
 * keepable.
 */
export async function encyclopediaFor({ name, lat, lng, locality = null, address = null, category = null } = {}) {
  if (lat == null || lng == null || !String(name || '').trim()) return null;
  const { nameScore, placeWords } = await import('./openMatch.js');
  // The village's name is in half the articles written about the village, so it
  // is not evidence that this article is about this place: "Sunningdale Bistro
  // Bar" was given Sunningdale railway station's article (found 6 Sep 2026).
  // The same list the open map is matched against (openMatch.js).
  const dull = placeWords(locality, address);

  const near = await geosearch(lat, lng);
  if (!near.length) return null;
  let best = null;
  for (const cand of near) {
    // Wikipedia disambiguates in brackets — "Roman Baths (Bath)" is the Roman Baths.
    const bare = cand.title.replace(/\s*\([^)]*\)\s*$/, '');
    const n = Math.max(nameScore(name, cand.title, dull), nameScore(name, bare, dull));
    // Somewhere you eat is rarely in an encyclopedia, and the article next door
    // usually is: "Sunningdale Bistro Bar" is most of "Sunningdale railway
    // station" once the village is taken out of both. So a restaurant has to
    // match an article's whole title, not most of it — which The Ivy and Rules,
    // the ones that really do have articles, still do.
    if (n < (EATING.has(String(category ?? '').toLowerCase()) ? 0.95 : 0.7)) continue;
    const confidence = Number(Math.min(1, n * (1 - cand.distanceM / (MAX_M * 4))).toFixed(2));
    if (!best || confidence > best.confidence) best = { ...cand, confidence };
  }
  if (!best) return null;

  const page = await article(best.title);
  if (!page?.summary) return null;

  let facts = { officialWebsite: null, openedYear: null, commonsImage: null };
  if (page.wikidataId) { try { facts = await entity(page.wikidataId); } catch { /* the article alone is worth having */ } }

  return {
    ...page,
    ...facts,
    // Wikipedia disambiguates in the title — "Roman Baths (Bath)", "Dishoom
    // (restaurant)" — which is right for an encyclopedia and wrong for the name
    // of somewhere you are going. The full title still travels, because that is
    // what the attribution has to credit.
    displayTitle: page.title.replace(/\s*\([^)]*\)\s*$/, '').trim() || page.title,
    distanceM: best.distanceM,
    confidence: best.confidence,
    // The condition on the text, in the words that have to appear on screen.
    attribution: `Wikipedia — “${page.title}”, CC BY-SA 4.0`,
    attributionUrl: page.url,
  };
}

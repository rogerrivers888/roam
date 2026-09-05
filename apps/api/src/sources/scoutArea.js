// Sweeping an area for the restaurants worth knowing (owner, 4 Sep 2026).
//
// > "We don't want every restaurant. We want a select number of highly rated
// > restaurants in each postcode, and then we can cache them and load them
// > extremely quickly… we're not beholden to anyone, and we don't actually need
// > to call the APIs."
//
// Until now Roam only owned what a household had already chosen. This goes the
// other way: pick an area, work out which of its restaurants are good, and
// research those before anyone asks for them. Three passes, cheapest first.
//
//   A. The census — OpenStreetMap, over the area. Every restaurant, pub and
//      café, with cuisine, hours, website and address. Free, ODbL, ours to keep,
//      and complete in a way a licensed search never is. This is the spine.
//   B. The crowd — one licensed text search per query variant. The rating and
//      the review count arrive in the *search* response, so a whole town's
//      crowd signal costs a handful of requests rather than a Details call per
//      restaurant. Both figures are banded inside `sweepArea` and never leave
//      it: what this module receives is two words (Technical Constraints §3.1).
//   C. The judgement — the badges a restaurant puts on its own front page:
//      Michelin, the Good Food Guide, AA rosettes. Free, keepable, and a better
//      answer to "is this good" than a star average. Gathered in the menu pass,
//      because that already has to fetch the page.
//
// Chains are dropped at the gate, not ranked down: "anyone who wants a chain can
// go to Google Maps… I'm interested in the highly rated restaurants."
//
// Nothing here writes a `place_claims` row. That table means a household asked
// for this, and no household did — `scout_places` is the record of why Roam
// went looking, and the researcher is happy to be handed a place directly.

import * as scout from '../repositories/scout.js';
import * as owned from '../repositories/ownedPlaces.js';
import * as providerCalls from '../repositories/providerCalls.js';
import { osmSource } from './osm.js';
import { sweepArea as googleSweep } from './google.js';
import { chainScale, detectChain } from '../domain/chains.js';
import { score } from '../domain/scoring.js';
import { cuisineGroup } from '../domain/cuisines.js';
import { queueEnrichment } from './own.js';
import { accoladesFor } from './accolades.js';
import { childMenus, findMenuUrl } from './menuLink.js';
import { readMenu } from './menuRead.js';
import { recordMenuRead } from '../domain/placeMenus.js';
import { firstHousehold } from '../repositories/households.js';

/** What to ask the licensed search. Different words surface different halves of a town. */
const QUERIES = ['restaurants', 'best restaurants', 'italian restaurant', 'indian restaurant', 'asian restaurant', 'pub food', 'fine dining', 'brunch'];
/** A sweep comes round twice a year; a rating that has moved is rare and slow. */
const RESWEEP_DAYS = Number(process.env.ROAM_RESWEEP_DAYS || 180);
const FOOD = new Set(['restaurant', 'cafe', 'pub', 'bar']);
/** Backoff for a menu that would not open, in hours. */
const MENU_BACKOFF_H = [24, 168, 720, 2160];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(the|restaurant|ristorante|cafe|caf|bar|kitchen|co|ltd|limited)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, '').trim();

const kmBetween = (a, b) => {
  if (a?.lat == null || b?.lat == null) return Infinity;
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Are these the same restaurant seen by two sources?
 *
 * Name alone is wrong — a town can have two Bella Vistas — and distance alone
 * is wrong, because a parade of shops puts five restaurants inside forty
 * metres. Both, or neither.
 */
const samePlace = (a, b) => {
  const na = norm(a.name), nb = norm(b.name);
  if (!na || !nb) return false;
  const near = kmBetween(a, b) <= 0.12;
  return near && (na === nb || na.includes(nb) || nb.includes(na));
};

/**
 * One area, swept.
 *
 * Returns what it decided rather than throwing on a bad pass: an area where the
 * open map answered and the licensed search did not is still a useful sweep,
 * and saying so is more honest than a failure.
 */
export async function sweep(code, { dryRun = false, householdId = null } = {}) {
  const area = await scout.areaFor(code);
  if (!area) throw Object.assign(new Error(`No area called ${code}. Add it first.`), { status: 404 });
  if (!dryRun && !(await scout.markSweeping(code))) return { code, state: 'sweeping', why: 'A sweep of this area is already running.' };

  const center = { lat: area.lat, lng: area.lng };
  const radiusKm = area.radius_km;
  const notes = [];
  let candidates = [];

  // A. the census
  try {
    const found = await osmSource.search({ center, radiusKm, categories: ['food'], limit: 900 });
    for (const v of found) {
      if (!v.name || !FOOD.has(v.category)) continue;
      if (kmBetween(center, v) > radiusKm) continue;
      candidates.push({
        venueRef: `osm:${v.sourcePlaceId}`,
        name: v.name, category: v.category, cuisines: v.cuisines ?? [],
        lat: v.lat, lng: v.lng, address: v.address, website: v.website,
        openingHours: v.openingHours, brand: v.brand ?? null,
        crowdBand: null, countBand: null, from: ['osm'],
      });
    }
    notes.push(`the open map listed ${found.length}`);
  } catch (err) {
    notes.push(`the open map did not answer (${err.message.slice(0, 80)})`);
  }

  // B. the crowd
  let googleCalls = 0;
  try {
    const { places, calls, problems } = await googleSweep({ center, radiusKm, queries: QUERIES, pages: 2 });
    googleCalls = calls;
    // Every outbound provider call is attributed (CLAUDE.md; Technical
    // Constraints §2). A sweep is not a household's search, so it is logged
    // against the estate's own household with a purpose that says what it was.
    if (calls) await logSweepCalls(householdId, calls);
    // Said out loud rather than left as a zero.
    if (problems?.length) notes.push(`the crowd pass was refused: ${problems[0]}`);
    for (const g of places) {
      if (kmBetween(center, g) > radiusKm) continue;
      const ref = `google:${g.sourcePlaceId}`;
      // The same restaurant the map already gave us: keep one row, and prefer
      // the licensed identifier, because that is the ref a household's own
      // records and every search result are keyed on.
      const twin = candidates.find((c) => c.from.includes('osm') && samePlace(c, g));
      if (twin) {
        twin.venueRef = ref;
        twin.crowdBand = g.crowdBand;
        twin.countBand = g.countBand;
        twin.website = twin.website || g.website;
        twin.address = twin.address || g.address;
        twin.openingHours = twin.openingHours || g.openingHours;
        twin.cuisines = twin.cuisines?.length ? twin.cuisines : (g.cuisines ?? []);
        twin.from.push('google');
        continue;
      }
      candidates.push({
        venueRef: ref,
        name: g.name, category: g.category ?? 'restaurant', cuisines: g.cuisines ?? [],
        lat: g.lat, lng: g.lng, address: g.address, website: g.website,
        openingHours: g.openingHours, brand: null,
        crowdBand: g.crowdBand, countBand: g.countBand, from: ['google'],
      });
    }
    notes.push(`the crowd pass rated ${places.length} in ${calls} requests`);
  } catch (err) {
    // A quota is a fact about today, not about the area. The census still
    // stands, and the sweep is worth keeping: `owned_score` is exactly the
    // column that lets a rating-less area rank.
    notes.push(`the crowd pass could not run (${err.message.slice(0, 90)})`);
  }

  const seen = candidates.length;

  // Chains are weighted, not dropped (owner, 5 Sep 2026). How many of our own
  // areas already hold a place of this name is the honest measure of how big a
  // group is, and it needs no list — so it is asked for here and refined by
  // every later sweep through `rescore`.
  const sitesOf = await siteCounts();
  let chains = 0;
  for (const c of candidates) {
    const { brand } = detectChain({ name: c.name, brand: c.brand });
    const sites = sitesOf(c.name);
    const { chain, scale } = chainScale({ name: c.name, brand: brand ?? c.brand, sites });
    c.chain = chain;
    c.chainScale = scale;
    c.sites = sites;
    if (chain) chains += 1;
  }

  // Score with what this pass knows. Menus and accolades arrive later and are
  // free to fold in, which `rescore` does without asking anybody anything.
  for (const c of candidates) {
    const s = score({
      crowd: c.crowdBand, count: c.countBand, accolades: [],
      menuItems: 0, cuisines: c.cuisines, website: c.website,
      summary: null, openingHours: c.openingHours, chainScale: c.chainScale,
    });
    c.roamScore = s.roamScore;
    c.ownedScore = s.ownedScore;
    // What kind of food this is, coarsely — decided here so the menu queue can
    // ask for "the best two Chinese" with a window function (migration 048).
    c.cuisineGroup = cuisineGroup(c.cuisines);
  }

  // A place nobody has rated and nothing is known about is not "the top-rated
  // restaurant in this postcode", it is an unknown. Rank by the composite, and
  // keep the number the area asked for.
  candidates.sort((a, b) => (b.roamScore - a.roamScore) || (b.ownedScore - a.ownedScore) || a.name.localeCompare(b.name));
  const kept = candidates.slice(0, area.keep);

  // Whether this sweep could actually ask what people think of these places.
  const askedTheCrowd = kept.some((c) => c.crowdBand);

  if (dryRun) {
    return { code, dryRun: true, seen, chains, kept: kept.length, googleCalls, notes,
      places: kept.map((c, i) => ({ rank: i + 1, ...c })) };
  }

  // Researching a set that is about to be replaced is waste, and at a county's
  // scale it is expensive waste. An area whose crowd pass was refused and which
  // has never had one is a census in name order, not a ranking: the twenty-five
  // it kept are unlikely to be the twenty-five it keeps tomorrow. So the census
  // is written down — it cost nothing and it is worth having — and the research
  // waits for a sweep that could actually ask (found queueing Surrey, 5 Sep 2026).
  const provisional = !askedTheCrowd && !area.swept_at;

  for (const [i, c] of kept.entries()) {
    await scout.putPlace(code, { ...c, rank: i + 1 });
    if (provisional) continue;
    // Straight to the researcher: OpenStreetMap, their own page, the
    // encyclopedias. Nothing licensed is asked for and nothing waits on it.
    await owned.ensureRecord(c.venueRef);
    queueEnrichment(c.venueRef, { seed: { name: c.name, lat: c.lat, lng: c.lng, website: c.website, category: c.category } });
  }
  const dropped = await scout.pruneArea(code, kept.map((c) => c.venueRef));

  // The daily Text Search cap is a fact about today rather than about the area,
  // so an area that could not ask comes back tomorrow instead of in six months
  // (found sweeping SL6–SL9, 5 Sep 2026).
  const next = new Date(Date.now() + (askedTheCrowd ? RESWEEP_DAYS : 1) * 86_400_000);
  await scout.finishSweep(code, {
    state: kept.length ? 'done' : 'failed',
    why: askedTheCrowd ? notes.join('; ')
      : `${notes.join('; ')} — ranked on open data alone${provisional ? ', research held until the crowd can be asked' : ''}; will try again tomorrow`,
    seen, chains, kept: kept.length, nextSweepAt: next,
  });

  return { code, state: kept.length ? 'done' : 'failed', seen, chains, kept: kept.length, dropped: dropped.length, googleCalls, notes, nextSweepAt: next.toISOString() };
}

/**
 * Score the area again from what we now own — no provider call, no network.
 *
 * This is the half of the answer to "how do we know how to change our overall
 * score": we never change it, we rebuild it. Research and menus land after the
 * sweep, so the number a place carries improves as the dataset does, and the
 * crowd band it was given at sweep time is simply reused until the next one.
 */
export async function rescore(code) {
  const rows = await scout.placesIn(code, 500);
  // How big each group is, from everything Roam has swept since. This is the
  // number that improves on its own: a name that was in one area in September
  // is in nine by Christmas, and the score follows without anyone editing a list.
  const sitesOf = await siteCounts();
  const scored = [];
  for (const r of rows) {
    const sites = sitesOf(r.name);
    const { chain, scale } = chainScale({ name: r.name, sites });
    const s = score({
      crowd: r.crowd_band, count: r.count_band,
      accolades: r.accolades ?? [],
      menuItems: r.item_count ?? 0,
      cuisines: r.cuisines ?? [],
      website: r.website, summary: r.summary, openingHours: r.opening_hours,
      chainScale: scale,
    });
    scored.push({ ...r, venueRef: r.venue_ref, roamScore: s.roamScore, ownedScore: s.ownedScore,
      crowdBand: r.crowd_band, countBand: r.count_band, chain, chainScale: scale, sites,
      cuisineGroup: cuisineGroup(r.cuisines ?? []) });
  }
  scored.sort((a, b) => (b.roamScore - a.roamScore) || (b.ownedScore - a.ownedScore));
  for (const [i, p] of scored.entries()) await scout.putPlace(code, { ...p, rank: i + 1 });
  return { code, rescored: scored.length };
}

/**
 * Fill in the menus for places a sweep has claimed, a few at a time.
 *
 * This is the part the owner cares about most — "the menus of the app are very
 * important… for lots of restaurants I'm opening the tabs, and they are empty"
 * — so a failure is recorded with its reason rather than left as silence. The
 * accolade scan rides along on the same fetch of the venue's front page.
 */
export async function fillMenus({ limit = 3, householdId = null } = {}) {
  const due = await scout.menusDue(limit);
  const done = [];
  for (const row of due) {
    const ref = row.venue_ref;
    const label = row.name;
    const attempt = async () => {
      if (!row.website) {
        await scout.recordMenuMiss(ref, { venueLabel: label, why: 'No website for this place, so there is nothing to read.', nextAttemptAt: backoff(1) });
        return 'no website';
      }
      // The badges, from the page we are about to open anyway.
      try {
        const { accolades } = await accoladesFor(row.website);
        if (accolades.length) await scout.putAccolades(row.area_code, ref, accolades);
      } catch { /* an accolade is a nicety; the menu is the job */ }

      const link = row.menu_url ? { url: row.menu_url, label: 'Menu', how: 'known' }
        : await findMenuUrl({ website: row.website, name: label, locality: row.postcode, address: row.address });
      if (!link.url) {
        await scout.recordMenuMiss(ref, { venueLabel: label, why: link.why || 'No menu found on their site.', nextAttemptAt: backoff(1) });
        return link.why || 'no menu link';
      }
      // Reading costs money, so it is deliberately not done here: the link is
      // recorded and the read is the household's tap or the owner's batch.
      await scout.recordMenuFound(ref, { venueLabel: label, menuUrl: link.url, how: link.how });
      return `found: ${link.url}`;
    };
    try { done.push({ ref, name: label, result: await attempt() }); }
    catch (err) { done.push({ ref, name: label, result: `failed: ${err.message.slice(0, 80)}` }); }
  }
  return { looked: due.length, done };
}


/**
 * Turn the menus we have found into dishes, a couple at a time.
 *
 * Separate from `fillMenus` because this is the step that spends: finding the
 * address is a free fetch of the restaurant's own page, reading it is a Claude
 * call. Kept small per tick on purpose — the owner asked for "an automated
 * function that runs over a number of weeks", and a few menus every quarter of
 * an hour builds the dataset without a bill arriving in one afternoon.
 */
export async function readFoundMenus({ limit = 2, householdId = null, sessionId = null, ref = null } = {}) {
  if (!householdId) return { read: 0, done: [], why: 'no household to attribute the reads to' };
  const due = await scout.menusToRead(limit, ref);
  const done = [];
  for (const row of due) {
    try {
      let read;
      try {
        read = await readMenu({ url: row.menu_url, venueLabel: row.venue_label, householdId, sessionId });
      } catch (err) {
        // The page we found is an index, not a menu: "Select a menu to view",
        // with the four real menus one click further in. Sebastian's Windsor is
        // exactly this, and it is the same click-through the owner opened with.
        if (!/menu_had_no_items|menu_unreadable/.test(err.message)) throw err;
        read = await readChildren(row, { householdId, sessionId });
        if (!read) throw err;
      }
      const stored = await recordMenuRead({ venueRef: row.venue_ref, venueLabel: row.venue_label, read });
      done.push({ name: row.venue_label, items: stored.items ?? 0, kind: read.kind });
    } catch (err) {
      const why = String(err.message).slice(0, 160);
      // A menu that would not open waits a day before anyone tries again, and
      // says why in the meantime.
      await scout.recordMenuMiss(row.venue_ref, { venueLabel: row.venue_label, why, menuUrl: row.menu_url, nextAttemptAt: backoff(1) });
      done.push({ name: row.venue_label, items: 0, why });
    }
  }
  return { read: due.length, done };
}


/**
 * Read the menus a menu page lists, and put them together as one.
 *
 * A restaurant with a lunch menu, a dinner menu and a wine list has three
 * pages, and the page we found is the contents page for them. Each is read on
 * its own and the sections are stacked, labelled by which menu they came from,
 * so the household sees one menu with "Dinner · Starters" in it rather than
 * three menus or none.
 */
async function readChildren(row, { householdId, sessionId, max = 3, depth = 2 } = {}) {
  // The words that say which restaurant this is. A group's menu page asks
  // before it shows you anything, and the answer is in the venue's own name as
  // often as in the town: Megan's Windsor is "megans-by-the-crown", with no
  // Windsor in it anywhere (5 Sep 2026).
  const words = [...new Set(`${row.name ?? ''} ${row.postcode ?? ''} ${row.address ?? ''}`.toLowerCase().match(/[a-z]{4,}/g) ?? [])]
    .filter((w) => !['road', 'street', 'lane', 'unit', 'high', 'avenue', 'close', 'place', 'square', 'united', 'kingdom', 'restaurant', 'kitchen'].includes(w));

  let children = [];
  try { children = await childMenus(row.menu_url, { max, words }); } catch { return null; }
  if (!children.length) return null;

  const sections = [];
  const from = [];
  let kind = null;
  for (const child of children) {
    try {
      let part = null;
      try {
        part = await readMenu({ url: child.url, venueLabel: row.venue_label, householdId, sessionId });
      } catch (err) {
        // One more level, once. Megan's is a chooser, then a branch page, then
        // nine PDFs — three deep, and stopping at two found nothing.
        if (depth <= 1 || !/menu_had_no_items|menu_unreadable/.test(err.message)) throw err;
        part = await readChildren({ ...row, menu_url: child.url }, { householdId, sessionId, max, depth: depth - 1 });
      }
      if (!part?.sections?.length) continue;
      const label = child.label?.trim();
      for (const s of part.sections) {
        sections.push({ ...s, title: label && !s.title.toLowerCase().includes(label.toLowerCase()) ? `${label} · ${s.title}` : s.title });
      }
      kind = kind ?? part.kind;
      from.push(child.url);
    } catch { /* one child of four failing is not the menu failing */ }
  }
  if (!sections.length) return null;
  return {
    sections,
    kind: kind ?? 'html',
    // The page that listed them is the address worth remembering: it is the one
    // that will still be right when they change the lunch menu's URL.
    sourceUrl: row.menu_url,
    note: from.length > 1 ? `Read from ${from.length} menus on their site` : null,
    currency: null,
    how: [`the page was a list of menus; read ${from.length} of them`],
  };
}


/**
 * Write the sweep's licensed requests to `provider_calls`.
 *
 * The record is of what we asked of whom, not of what came back, so a refused
 * request counts the same as an answered one. A sweep has no household behind
 * it — nobody asked — so it is attributed to the estate's own, which is how the
 * bill for going looking stays separate from the bill for someone searching.
 */
async function logSweepCalls(householdId, calls) {
  try {
    const id = householdId ?? (await firstHousehold())?.id;
    if (!id) return;
    // `units` is the meter's shape: what each provider billed for.
    await providerCalls.record(id, 'google', 'scout.sweep', { google: calls }, null);
  } catch (err) {
    console.warn(`scout: could not record ${calls} provider call(s): ${err.message}`);
  }
}


/**
 * How many of Roam's own areas hold a place of each name, normalised the same
 * way places are matched across sources.
 */
async function siteCounts() {
  const rows = await scout.nameAreas();
  const byName = new Map();
  for (const r of rows) {
    const key = norm(r.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(r.area_code);
  }
  return (name) => byName.get(norm(name))?.size ?? 1;
}


/**
 * Somebody wants this menu, so go and get it.
 *
 * A place outside the top slice of its area has no menu read for it in advance
 * — that is the saving. A household act cancels that: shortlisting a place, or
 * putting it in a plan, says this one matters, and `menusDue`/`menusToRead`
 * both let a claimed place through whatever its rank. This finds the address
 * now and leaves the reading to the next tick of the loop, which is a few
 * minutes rather than the days a place at rank twenty-eight would otherwise
 * wait (owner, 5 Sep 2026).
 */
export async function wantMenu(venueRef, householdId = null) {
  const known = await scout.menuStateOf(venueRef);
  if (known?.state === 'read' || known?.state === 'found') return { state: known.state };
  const row = await scout.placeForMenu(venueRef);
  if (!row?.website) return { state: 'no website' };
  const link = await findMenuUrl({ website: row.website, name: row.name, locality: row.postcode, address: row.address });
  if (!link.url) {
    await scout.recordMenuMiss(venueRef, { venueLabel: row.name, why: link.why || 'No menu found on their site.', nextAttemptAt: backoff(1) });
    return { state: 'none', why: link.why };
  }
  await scout.recordMenuFound(venueRef, { venueLabel: row.name, menuUrl: link.url, how: link.how });
  // Read it on the next tick rather than here: the household is not waiting on
  // this call, and a read is a minute of somebody else's server and ours.
  return { state: 'found', url: link.url };
}


/**
 * Give the coarse kind to places swept before there was one.
 *
 * Free and offline: it is a lookup, not a fetch. Runs on the loop so the menu
 * queue starts meaning "two Chinese and two Indian" for the areas already done
 * rather than only for the ones swept from now on.
 */
export async function fillCuisineGroups({ limit = 5000 } = {}) {
  const rows = await scout.placesNeedingCuisineGroup(limit);
  for (const r of rows) await scout.setCuisineGroup(r.area_code, r.venue_ref, cuisineGroup(r.cuisines ?? []));
  return rows.length;
}

const backoff = (attempts) => new Date(Date.now() + (MENU_BACKOFF_H[Math.min(attempts, MENU_BACKOFF_H.length) - 1] ?? 720) * 3600_000);

/** The background loop: one area at a time, then menus. Nothing here is urgent. */
export function startScoutLoop({ everyMs = 15 * 60_000 } = {}) {
  const tick = async () => {
    try {
      const [area] = await scout.dueAreas(1);
      if (area) await sweep(area.code);
    } catch (err) { console.warn(`scout: sweep failed: ${err.message}`); }
    try { await fillCuisineGroups(); } catch (err) { console.warn(`scout: cuisine groups failed: ${err.message}`); }
    try { await fillMenus({ limit: 3 }); } catch (err) { console.warn(`scout: menus failed: ${err.message}`); }
    // And read a couple of what it found. Small and slow: this is the only part
    // of the sweep that costs, and nobody is waiting on it.
    try {
      const household = await firstHousehold();
      if (household) await readFoundMenus({ limit: 2, householdId: household.id });
    } catch (err) { console.warn(`scout: menu reads failed: ${err.message}`); }
  };
  const first = setTimeout(tick, 120_000);
  const timer = setInterval(tick, everyMs);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

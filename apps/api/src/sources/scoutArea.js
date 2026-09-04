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
import { osmSource } from './osm.js';
import { sweepArea as googleSweep } from './google.js';
import { detectChain } from '../domain/chains.js';
import { score } from '../domain/scoring.js';
import { queueEnrichment } from './own.js';
import { accoladesFor } from './accolades.js';
import { findMenuUrl } from './menuLink.js';

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
export async function sweep(code, { dryRun = false } = {}) {
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

  // Chains out at the gate.
  let chains = 0;
  for (const c of candidates) {
    const { chain } = detectChain({ name: c.name, brand: c.brand });
    c.chain = chain;
    if (chain) chains += 1;
  }
  const independents = candidates.filter((c) => !c.chain);

  // Score with what this pass knows. Menus and accolades arrive later and are
  // free to fold in, which `rescore` does without asking anybody anything.
  for (const c of independents) {
    const s = score({
      crowd: c.crowdBand, count: c.countBand, accolades: [],
      menuItems: 0, cuisines: c.cuisines, website: c.website,
      summary: null, openingHours: c.openingHours,
    });
    c.roamScore = s.roamScore;
    c.ownedScore = s.ownedScore;
  }

  // A place nobody has rated and nothing is known about is not "the top-rated
  // restaurant in this postcode", it is an unknown. Rank by the composite, and
  // keep the number the area asked for.
  independents.sort((a, b) => (b.roamScore - a.roamScore) || (b.ownedScore - a.ownedScore) || a.name.localeCompare(b.name));
  const kept = independents.slice(0, area.keep);

  if (dryRun) {
    return { code, dryRun: true, seen, chains, kept: kept.length, googleCalls, notes,
      places: kept.map((c, i) => ({ rank: i + 1, ...c })) };
  }

  for (const [i, c] of kept.entries()) {
    await scout.putPlace(code, { ...c, rank: i + 1 });
    // Straight to the researcher: OpenStreetMap, their own page, the
    // encyclopedias. Nothing licensed is asked for and nothing waits on it.
    await owned.ensureRecord(c.venueRef);
    queueEnrichment(c.venueRef, { seed: { name: c.name, lat: c.lat, lng: c.lng, website: c.website, category: c.category } });
  }
  const dropped = await scout.pruneArea(code, kept.map((c) => c.venueRef));

  const next = new Date(Date.now() + RESWEEP_DAYS * 86_400_000);
  await scout.finishSweep(code, {
    state: kept.length ? 'done' : 'failed',
    why: notes.join('; '),
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
  const scored = [];
  for (const r of rows) {
    const s = score({
      crowd: r.crowd_band, count: r.count_band,
      accolades: r.accolades ?? [],
      menuItems: r.item_count ?? 0,
      cuisines: r.cuisines ?? [],
      website: r.website, summary: r.summary, openingHours: r.opening_hours,
    });
    scored.push({ ...r, venueRef: r.venue_ref, roamScore: s.roamScore, ownedScore: s.ownedScore, crowdBand: r.crowd_band, countBand: r.count_band });
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

const backoff = (attempts) => new Date(Date.now() + (MENU_BACKOFF_H[Math.min(attempts, MENU_BACKOFF_H.length) - 1] ?? 720) * 3600_000);

/** The background loop: one area at a time, then menus. Nothing here is urgent. */
export function startScoutLoop({ everyMs = 15 * 60_000 } = {}) {
  const tick = async () => {
    try {
      const [area] = await scout.dueAreas(1);
      if (area) await sweep(area.code);
    } catch (err) { console.warn(`scout: sweep failed: ${err.message}`); }
    try { await fillMenus({ limit: 3 }); } catch (err) { console.warn(`scout: menus failed: ${err.message}`); }
  };
  const first = setTimeout(tick, 120_000);
  const timer = setInterval(tick, everyMs);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

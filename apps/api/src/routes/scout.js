/**
 * The area sweep, from the back office.
 *
 * Mounted behind the admin door. Running a sweep spends money — a handful of
 * licensed text searches per area — so it needs `manage_library`, the same
 * capability that runs the atlas harvest; reading what a sweep found needs only
 * `view_library`.
 *
 * The one route here that is not admin is `GET /api/places/area/:code`, mounted
 * on the household API, and it is the point of the whole exercise: an area's
 * best restaurants, answered from our own tables, with no provider call in the
 * request path at all.
 */

import express from 'express';
import { requires } from '../access.js';
import * as scout from '../repositories/scout.js';
import { fillMenus, readFoundMenus, rescore, sweep } from '../sources/scoutArea.js';
import { geocode } from '../sources/geocode.js';
import { outcodesIn } from '../sources/postcodeAreas.js';
import { currentHousehold } from './household.js';

const router = express.Router();

/** What has been swept, and how well it went. */
router.get('/', requires('view_library'), async (_req, res, next) => {
  try {
    res.json({ areas: await scout.coverage() });
  } catch (err) { next(err); }
});

/**
 * Add an area to the queue.
 *
 * A postcode district is the unit because it is what people say — "SL4", not a
 * bounding box — so the centre is geocoded from the code itself unless one is
 * given. Adding does not sweep: the loop picks it up, or the owner asks.
 */
router.post('/areas', requires('manage_library'), async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'code_required', message: 'Which area? A postcode district like SL4.' });
    let { lat, lng, label } = req.body ?? {};
    if (lat == null || lng == null) {
      // A district's centroid is not its high street: geocoding "SL4" answers
      // with a point in Old Windsor, two miles from the restaurants (found
      // 4 Sep 2026). So the town's name is asked first when there is one, and
      // the code is only the fallback. geocode answers with a list, best first.
      const [g] = await geocode(`${label || code}, United Kingdom`, { countryCode: 'gb', limit: 1 })
        .then((rows) => (rows.length ? rows : geocode(`${code}, United Kingdom`, { countryCode: 'gb', limit: 1 })));
      if (!g) return res.status(400).json({ error: 'not_found', message: `Could not find ${label || code} on the map — give lat and lng.` });
      lat = g.lat; lng = g.lng; label = label ?? g.label ?? null;
    }
    const area = await scout.upsertArea({
      code, label: label ?? null, lat: Number(lat), lng: Number(lng),
      radiusKm: Number(req.body?.radiusKm) || 2.5,
      keep: Number(req.body?.keep) || 25,
    });
    res.status(201).json({ area });
  } catch (err) { next(err); }
});

/** Sweep one area now. `?dryRun=1` decides nothing and writes nothing. */
router.post('/areas/:code/sweep', requires('manage_library'), async (req, res, next) => {
  try {
    const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
    res.json(await sweep(String(req.params.code).toUpperCase(), { dryRun }));
  } catch (err) { next(err); }
});

/** Score the area again from what we already own. Free: no network, no provider. */
router.post('/areas/:code/rescore', requires('manage_library'), async (req, res, next) => {
  try {
    res.json(await rescore(String(req.params.code).toUpperCase()));
  } catch (err) { next(err); }
});

/** Go and find the menus for what a sweep claimed. */
router.post('/menus/fill', requires('manage_library'), async (req, res, next) => {
  try {
    res.json(await fillMenus({ limit: Math.min(20, Number(req.body?.limit) || 3) }));
  } catch (err) { next(err); }
});

/** Every menu Roam could not read, with the reason — the work list, not silence. */
router.get('/menus/missing', requires('view_library'), async (_req, res, next) => {
  try {
    res.json({ misses: await scout.menuMisses(200) });
  } catch (err) { next(err); }
});


/**
 * Read the menus whose address we already know, into dishes.
 *
 * This is the step that costs — one Claude call per menu, attributed to the
 * owner's household in `provider_calls` like every other — so it is deliberately
 * a separate ask from finding the address, which is free. Reading is what turns
 * "there is a menu over there" into the thing the household actually wanted:
 * "they do an arrabbiata, it is £14.50, and there are four things the
 * vegetarian can eat".
 *
 * The result is pooled (`place_menus`, migration 028): the next household to
 * open this restaurant does not pay to read it again.
 */
router.post('/menus/read', requires('manage_library'), async (req, res, next) => {
  try {
    const limit = Math.min(40, Number(req.body?.limit) || 3);
    const household = await currentHousehold();
    // Deliberately not the caller's session.
    //
    // SESSION_CALL_BOUND caps a household's planning session at forty Claude
    // calls, which is the right rail for somebody sitting in front of the app
    // and exactly the wrong one for a batch that reads ninety menus: every read
    // after the fortieth was refused, and from the outside it looked like the
    // crawler failing on Megan's (found 5 Sep 2026). Building the dataset is
    // not a session. The household's monthly bound still applies, and that is
    // the guard that belongs here.
    const sessionId = null;
    // One place by name, for proving a fix without waiting for its turn.
    const ref = String(req.body?.ref || '').trim() || null;

    // A menu takes the better part of a minute to read and a batch of four
    // outlives the proxy in front of this API — the reads finished, the answer
    // never arrived, and from here it looked like a failure (found 5 Sep 2026).
    // So a batch is started and not waited on; `GET /api/admin/scout/` is where
    // the progress is.
    if (req.body?.wait === true || ref) return res.json(await readFoundMenus({ limit: ref ? 1 : limit, householdId: household.id, sessionId, ref }));
    const pending = await scout.menusToRead(limit);
    void readFoundMenus({ limit, householdId: household.id, sessionId })
      .catch((err) => console.warn(`scout: batch menu read failed: ${err.message}`));
    res.status(202).json({ started: pending.length, watch: '/api/admin/scout/' });
  } catch (err) { next(err); }
});

/** Put every miss that still has an address back in the queue, to prove a fix. */
router.post('/menus/retry', requires('manage_library'), async (_req, res, next) => {
  try {
    res.json({ requeued: await scout.retryMisses() });
  } catch (err) { next(err); }
});

/** What the sweep has cost so far, from provider_calls rather than an estimate. */
router.get('/cost', requires('view_library'), async (_req, res, next) => {
  try {
    const lines = await scout.spend();
    const areas = await scout.coverage();
    const places = areas.reduce((n, a) => n + a.places, 0);
    const menus = areas.reduce((n, a) => n + a.menus, 0);
    const usd = lines.reduce((n, l) => n + Number(l.cost_usd || 0), 0);
    res.json({
      lines,
      totals: { usd: Math.round(usd * 10000) / 10000, places, menus,
        perPlaceUsd: places ? Math.round((usd / places) * 10000) / 10000 : null,
        perMenuUsd: menus ? Math.round((usd / menus) * 10000) / 10000 : null },
    });
  } catch (err) { next(err); }
});


/**
 * Queue a whole county at once.
 *
 * Owner, 5 Sep 2026: "get all the restaurants in Surrey and Berkshire, and
 * then, once we're happy with that, we can move to London."
 *
 * Adding is not sweeping. This writes the areas and their centroids and leaves
 * them for the loop, because a county is a hundred sweeps and the licensed
 * search has a daily ceiling — the queue is what turns "the whole county" into
 * something that finishes on its own over a few days rather than failing in one
 * afternoon.
 */
router.post('/counties/:name', requires('manage_library'), async (req, res, next) => {
  try {
    const { place, outcodes } = await outcodesIn(req.params.name);
    const keep = Number(req.body?.keep) || 30;
    const menuShare = req.body?.menuShare == null ? null : Number(req.body.menuShare);
    const radiusKm = Number(req.body?.radiusKm) || 2.5;
    const added = [];
    for (const [i, o] of outcodes.entries()) {
      const existing = await scout.areaFor(o.code);
      // Spread the first sweeps out rather than making them all due at once:
      // the loop takes one at a time and the daily ceiling is real.
      const area = await scout.upsertArea({
        code: o.code,
        label: existing?.label ?? o.districts[0] ?? place,
        lat: o.lat, lng: o.lng, radiusKm, keep,
        nextSweepAt: existing?.next_sweep_at ?? new Date(Date.now() + i * 60_000),
      });
      if (menuShare != null) await scout.setMenuShare(o.code, menuShare);
      added.push({ code: area.code, label: area.label, swept: Boolean(existing?.swept_at) });
    }
    res.status(201).json({
      place,
      queued: added.length,
      alreadySwept: added.filter((a) => a.swept).length,
      areas: added,
    });
  } catch (err) { next(err); }
});


/**
 * How much of an area is worth a menu before anybody asks.
 *
 * Owner, 5 Sep 2026: "maybe we just take the top 20% of restaurants' menus…
 * In the case of London, we might take the top 10%." So it is a dial rather
 * than a constant, and it can differ by place: a London postcode holds far
 * more restaurants than a Surrey one, and the tenth of it that people actually
 * search is still a longer list.
 */
router.post('/menus/share', requires('manage_library'), async (req, res, next) => {
  try {
    const share = Number(req.body?.share);
    if (!(share > 0 && share <= 1)) return res.status(400).json({ error: 'share_required', message: 'A fraction between 0 and 1 — 0.2 is the top fifth.' });
    const keep = req.body?.keep == null ? null : Number(req.body.keep);
    const perCuisine = req.body?.perCuisine == null ? null : Number(req.body.perCuisine);
    const code = String(req.body?.code || '').trim().toUpperCase() || null;
    if (code) return res.json({ area: await scout.setMenuShare(code, share) });
    res.json({ areas: await scout.setMenuShareForAll(share, keep, perCuisine), share, keep, perCuisine });
  } catch (err) { next(err); }
});

export default router;

/**
 * The household-facing read: an area's best places, from our own tables.
 *
 * No provider is asked anything here. Everything in the answer was either
 * researched from sources we may keep or is our own judgement, which is what
 * makes it instant and what makes it ours.
 */
export const areaRouter = express.Router();

areaRouter.get('/area/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const area = await scout.areaFor(code);
    if (!area) return res.status(404).json({ error: 'not_swept', message: `Roam has not looked at ${code} yet.` });
    const rows = await scout.placesIn(code, Math.min(100, Number(req.query.limit) || 25));
    res.json({
      area: { code: area.code, label: area.label, sweptAt: area.swept_at, kept: area.kept },
      places: rows.map((r) => ({
        venueRef: r.venue_ref, name: r.name, rank: r.rank,
        // Our number and our words. The figures they were built from were never
        // written down (migration 035).
        score: r.roam_score, standing: r.crowd_band, howMany: r.count_band,
        accolades: r.accolades ?? [], cuisines: r.cuisines ?? [],
        // Kept and weighted rather than dropped: how big a group this belongs
        // to, and how many of Roam's own areas hold one (migration 038).
        chain: r.chain === true, chainScale: r.chain_scale ?? 'independent', sites: r.sites ?? 1,
        address: r.address, postcode: r.postcode, openingHours: r.opening_hours,
        summary: r.summary, website: r.website, menuUrl: r.menu_url,
        lat: r.lat, lng: r.lng,
        menu: r.menu_state === 'read' ? { items: r.item_count, readAt: r.menu_read_at } : null,
        researched: r.enrich_state === 'done',
      })),
      attribution: ['© OpenStreetMap contributors'],
    });
  } catch (err) { next(err); }
});

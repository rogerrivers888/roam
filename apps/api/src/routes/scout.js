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
    const sessionId = req.session?.id ?? null;
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

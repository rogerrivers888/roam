/**
 * What can be asked for near a point, before anybody asks for it.
 *
 * The stay wizard offers a household a set of must-haves. The question this
 * answers is which of them are worth offering *here* — owner, 6 Sep 2026: "this
 * trip is the Thorpe Park, which is nowhere near the ocean, so there's no point
 * in offering sea views."
 *
 * The tempting way to do that is a rule per amenity: sea view needs a coast
 * within so many miles, a pool needs… and so on. That way lies a list of rules
 * that is never finished, is wrong at its edges, and still cannot answer the
 * question the household is really asking, which is not "is this possible" but
 * "what will asking for it cost me".
 *
 * So there are no rules. The pool of beds for this patch of map is fetched once
 * — the same pool the list itself is built from, and usually already in memory
 * — and every facility is counted across it. A facility no bed near Chertsey
 * has is a chip that never appears, and nobody had to write anything down about
 * Chertsey. Every chip that does appear carries the number of beds still
 * standing if it is ticked.
 *
 * The cost of all this is nothing: no call is made that the list was not going
 * to make anyway, and the counting is a loop over a few hundred rows.
 */

import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { hotelsNear, vocabularies, liteapiEnabled } from '../sources/liteapi.js';
import { bedRatesOn } from '../sources/index.js';
import { whatIsOnOffer, wantsOnOffer, centreOfPlans } from '../domain/stays.js';
import * as transit from '../sources/transit.js';
import * as transitRepo from '../repositories/transit.js';

const router = Router();

/**
 * GET /api/stays/options?lat=&lng=&radiusKm=
 *
 * → { types: [{id,label,count}], facilities: [...], of, tookMs }
 *
 * Ordered commonest first, because the chip most households want is the one
 * that costs them least and the rare ones are the ones worth thinking about.
 */
router.get('/options', async (req, res, next) => {
  const started = Date.now();
  try {
    const lat = Number(req.query.lat); const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'point_required' });
    const radiusKm = Math.min(30, Math.max(1, Number(req.query.radiusKm) || 5));

    if (!bedRatesOn()) {
      // Without the price source there is no facility data at all — the open
      // map's own tags cover a fraction of hotels — so the honest answer is
      // that we cannot say, rather than an empty list that reads as "none".
      return res.json({
        types: [], facilities: [], of: 0, known: false,
        why: liteapiEnabled() ? 'The hotel source is switched off in Settings › Providers.' : 'No hotel source is connected yet.',
        tookMs: Date.now() - started,
      });
    }

    const [pool, vocab] = await Promise.all([
      hotelsNear({ lat, lng }, radiusKm),
      vocabularies(),
    ]);
    const offer = whatIsOnOffer(pool.hotels, vocab);
    res.json({
      // What to put on screen: the dozen things a household chooses on, less
      // the ones nothing here has and the ones everything here has.
      wants: wantsOnOffer(pool.hotels, vocab),
      ...offer,
      // The whole catalogue's worth, kept for the back office. 253 facilities
      // occur in Bath and no wizard should ever draw 253 chips.
      allFacilities: undefined,
      // A vocabulary that failed to load makes every chip vanish, which reads
      // as "nothing here has anything". Say which it was.
      vocabularyProblems: vocab.problems ?? [],
      known: true,
      cached: pool.cached,
      // How many of the beds carry any facility list at all. A source that
      // returns none would make every chip vanish, and "nothing is available
      // here" and "we were told nothing" must never look the same on screen.
      described: pool.hotels.filter((h) => h.facilityIds?.length).length,
      tookMs: Date.now() - started,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/stays/centre  { points: [{lat,lng,label}] }
 *
 * Where to look from when there are several places to be near: the point with
 * the least total travel to all of them (domain/stays.js `centreOfPlans`), not
 * their average, which one day trip drags a third of the way out of town.
 *
 * Pure arithmetic — no provider, no key, no wait. It is a route rather than a
 * calculation in the browser only because the ranking that uses it is the
 * server's, and the two must agree.
 */
router.post('/centre', (req, res, next) => {
  try {
    const points = (req.body?.points ?? [])
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), label: p.label ?? null }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!points.length) return res.status(400).json({ error: 'points_required' });
    const centre = centreOfPlans(points);
    res.json({ centre, of: points.length });
  } catch (err) { next(err); }
});

/**
 * GET /api/stays/probe?lat=&lng= — what the hotel source actually sends.
 *
 * The owner's, and only the owner's. Field *names* and reference vocabularies,
 * never a hotel's content: this answers "can we offer villas and farm stays"
 * and "which facilities does this source know about", which are questions about
 * the catalogue rather than about anybody's hotel.
 *
 * It exists because the documentation and the wire disagreed. The docs say
 * /data/hotels returns hotelTypeId; the live answer for Bath carried facility
 * ids on all hundred beds and a hotel type on none. That is the kind of thing
 * that has to be measured before a wizard offers a household a choice it cannot
 * honour.
 */
router.get('/probe', requireOwner, async (req, res, next) => {
  try {
    if (!bedRatesOn()) return res.json({ on: false });
    const lat = Number(req.query.lat) || 51.3811;
    const lng = Number(req.query.lng) || -2.3590;
    const [pool, vocab] = await Promise.all([hotelsNear({ lat, lng }, 5), vocabularies()]);
    const raw = pool.hotels[0] ?? {};
    res.json({
      // Which of the fields we hoped for actually arrive, and on how many rows.
      fields: Object.keys(raw).sort(),
      coverage: {
        of: pool.hotels.length,
        facilityIds: pool.hotels.filter((h) => h.facilityIds?.length).length,
        hotelTypeId: pool.hotels.filter((h) => h.hotelTypeId).length,
        stars: pool.hotels.filter((h) => h.stars).length,
        rating: pool.hotels.filter((h) => h.rating).length,
        photos: pool.hotels.filter((h) => h.photos?.length).length,
        chain: pool.hotels.filter((h) => h.chain).length,
      },
      vocabularies: {
        facilities: vocab.facilities.size,
        hotelTypes: vocab.hotelTypes.size,
        // The catalogue's own words, so the shortlist of what to offer a
        // household can be drawn from what exists rather than invented.
        hotelTypeNames: [...vocab.hotelTypes.entries()].map(([id, label]) => `${id}:${label}`),
      },
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/stays/transit — what we hold, and where we have looked.
 * POST /api/stays/transit/harvest — fill or refresh a region.
 *
 * The owner's, and only the owner's. The harvest is a few minutes of somebody
 * else's free server and it writes to a table every stay search reads, so it is
 * not a thing a household sets off by tapping something.
 */
router.get('/transit', requireOwner, async (_req, res, next) => {
  try { res.json(await transitRepo.stopCounts()); } catch (err) { next(err); }
});

router.post('/transit/harvest', requireOwner, async (req, res, next) => {
  try {
    const box = req.body?.south != null ? req.body : { ...transit.UK, countryCode: 'GB' };
    // Answered before it finishes: the United Kingdom is thirty-odd cells with
    // a pause between them, which is minutes, and an HTTP request that waits
    // that long is one a proxy will cut in half.
    res.status(202).json({ started: true, area: box.area ?? 'uk', label: box.label ?? null });
    const started = Date.now();
    const out = await transit.harvestRegion(box, {
      cellDeg: Number(req.body?.cellDeg) || 2,
      upsert: transitRepo.upsertStops,
      record: transitRepo.recordCoverage,
      covered: (cell) => transitRepo.cellCovered(transit.cellArea(cell)),
      refresh: req.body?.refresh === true,
    });
    console.log(`transit harvest ${box.area ?? 'uk'}: ${out.stored} stops, ${out.cells} cells, ${out.failed.length} failed, ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error(`transit harvest failed: ${err.message}`);
  }
});

export default router;

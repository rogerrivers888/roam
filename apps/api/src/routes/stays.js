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
import { hotelsNear, vocabularies, liteapiEnabled } from '../sources/liteapi.js';
import { bedRatesOn } from '../sources/index.js';
import { whatIsOnOffer, centreOfPlans } from '../domain/stays.js';

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
      ...offer,
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

export default router;

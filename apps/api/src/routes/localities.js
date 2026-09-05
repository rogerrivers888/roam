/**
 * Places you can point at — the back office's own geography.
 *
 * Owner, 5 Sep 2026: "I can select a county, or I can select a city, or I can
 * select a postcode, and I can see all my stats and all my data for that
 * particular location. That's a first-class citizen."
 *
 * So there is one page endpoint and it does not care which of the three it was
 * handed: `GET /api/admin/places/:slug` answers with the place, what it holds,
 * and what is in it, and the kind only decides which column the contents were
 * matched on (repositories/localities.js).
 *
 * Behind the admin door with the rest of the back office: `view_library` to
 * look, `manage_library` to run a pass. A session without the door gets 404 and
 * never learns this exists; one without the capability gets a 403 that names
 * what to ask for (access.js).
 */

import express from 'express';
import { requires } from '../access.js';
import * as loc from '../repositories/localities.js';
import { postalPass, namingPass, refreshCounts } from '../sources/localities.js';

export const router = express.Router();

/** Whether a pass is running, so two presses of the button do not make two runs. */
let running = null;

// ---------------------------------------------------------------------------
// navigating
// ---------------------------------------------------------------------------

/**
 * The tree, and how much of it is still unnamed.
 *
 * `remaining` is on this answer rather than behind its own call because it is
 * the one number that explains an empty branch: a county with no towns under it
 * has either never been harvested or never been through the naming pass, and
 * those are different problems with different buttons.
 */
router.get('/', requires('view_library'), async (_req, res, next) => {
  try {
    const [tree, pending] = await Promise.all([loc.tree(), loc.pendingNaming()]);
    res.json({ ...tree, remaining: pending, running: running ? { since: running } : null });
  } catch (err) { next(err); }
});

/** Type-ahead over every place, of every kind: "wind" finds Windsor and SL4. */
router.get('/search', requires('view_library'), async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    res.json({ places: q ? await loc.findByName(q, Math.min(30, Number(req.query.limit) || 12)) : [] });
  } catch (err) { next(err); }
});

/**
 * The coverage matrix.
 *
 * A county and the towns and postcode districts around it, each as a row of
 * held-against-applicable. Asked for by slug rather than computed for
 * everywhere, because the matrix is something you read about one part of the
 * country at a time and 107 counties of it is a wall.
 */
router.get('/coverage', requires('view_library'), async (req, res, next) => {
  try {
    const slugs = String(req.query.slugs ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    res.json({ rows: await loc.coverageRows(slugs.slice(0, 40)), facts: loc.FACT_KEYS });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// one place
// ---------------------------------------------------------------------------

/**
 * Everything about one place, in one answer.
 *
 * One round trip rather than three, for the same reason the reading screen
 * takes one: a page whose tiles arrive before its list is a page that is wrong
 * for a moment, and this one is read for its numbers.
 */
router.get('/:slug', requires('view_library'), async (req, res, next) => {
  try {
    const place = await loc.bySlug(req.params.slug);
    if (!place) return res.status(404).json({ error: 'not_found' });
    const [coverage, contents, breakdown, siblings] = await Promise.all([
      loc.coverageOf(place),
      loc.contentsOf(place, {
        kind: ['go', 'eat'].includes(req.query.kind) ? req.query.kind : null,
        missing: req.query.missing ?? null,
        limit: Math.min(500, Number(req.query.limit) || 200),
      }),
      loc.breakdownOf(place),
      loc.siblingsOf(place),
    ]);
    res.json({ place, coverage, contents, breakdown, siblings });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// filling it in
// ---------------------------------------------------------------------------

/**
 * Put places into places.
 *
 * Two passes with very different costs, so they are two buttons rather than one
 * job: the postal pass is a hundred coordinates a request and runs over
 * everything, the naming pass is one request a second and is asked for in
 * batches. Both are fire-and-forget for the same reason the menu reads are —
 * a batch outlives the Railway proxy, and a request that dies mid-run must not
 * take the work with it.
 */
router.post('/pass', requires('manage_library'), async (req, res, next) => {
  try {
    if (running) return res.status(409).json({ error: 'already_running', since: running });
    const which = req.body?.which === 'naming' ? 'naming' : 'postal';
    const limit = Math.min(2000, Math.max(1, Number(req.body?.limit) || (which === 'naming' ? 200 : 4000)));
    const householdId = req.household?.id ?? null;

    running = new Date().toISOString();
    const work = which === 'naming'
      ? namingPass({ limit, householdId })
      : postalPass({ limit, householdId });

    // The answer goes out now and the work carries on; the tree's `remaining`
    // is what says whether it is finished, which is a number that moves rather
    // than a spinner that does not.
    res.status(202).json({ started: which, limit });
    work.then(refreshCounts).catch(() => null).finally(() => { running = null; });
  } catch (err) { running = null; next(err); }
});

/** Recount, free and without a network call — the sweep's "rescore" for places. */
router.post('/recount', requires('manage_library'), async (_req, res, next) => {
  try {
    await refreshCounts();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

import { Router } from 'express';
import * as prototypes from '../repositories/prototypes.js';

const router = Router();

// A mock-up is 'new' until the owner rules on it. The web app holds the list of
// pages (they ship with the bundle); this only holds what he decided about each.
const STATUSES = new Set(['new', 'approved', 'rejected', 'archived']);

/** Every verdict recorded so far, keyed by file. Files with no row are 'new'. */
router.get('/', async (_req, res, next) => {
  try {
    const rows = await prototypes.allReviews();
    const reviews = {};
    for (const r of rows) reviews[r.file] = { status: r.status, note: r.note, updatedAt: r.updated_at };
    res.json({ reviews });
  } catch (err) { next(err); }
});

/**
 * Rule on one mock-up: PUT /api/prototypes/:file { status, note? }.
 * Back to 'new' clears the row, so "to review" is simply what has no verdict.
 */
router.put('/:file', async (req, res, next) => {
  try {
    const file = String(req.params.file);
    const status = String(req.body?.status ?? '');
    if (!STATUSES.has(status)) return res.status(400).json({ error: 'bad_status', message: `status must be one of ${[...STATUSES].join(', ')}` });
    const note = req.body?.note == null || req.body.note === '' ? null : String(req.body.note).slice(0, 2000);
    if (status === 'new' && !note) {
      await prototypes.clearReview(file);
      return res.json({ review: { file, status: 'new', note: null, updatedAt: null } });
    }
    const row = await prototypes.saveReview(file, status, note);
    res.json({ review: { file: row.file, status: row.status, note: row.note, updatedAt: row.updated_at } });
  } catch (err) { next(err); }
});

export default router;

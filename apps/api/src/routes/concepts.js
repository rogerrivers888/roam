import { Router } from 'express';
import { CONCEPTS, matchConcepts, ALLERGENS } from '../domain/concepts.js';

const router = Router();

/**
 * Suggested pills for likes, dislikes, diets and dish names as the household
 * types. Free text that matches nothing is still allowed; this is a helping
 * hand, not a gate.
 *   GET /api/concepts/suggest?q=spag&kinds=dish,cuisine,experience
 */
router.get('/suggest', (req, res) => {
  const q = String(req.query.q ?? '');
  const kinds = req.query.kinds ? String(req.query.kinds).split(',').map((k) => k.trim()).filter(Boolean) : null;
  const limit = Math.min(20, Number(req.query.limit) || 8);
  if (!q.trim()) {
    // Popular starting points when the field is empty.
    const starters = CONCEPTS.filter((c) => !kinds || kinds.includes(c.kind)).slice(0, limit);
    return res.json({ suggestions: starters.map((c) => ({ key: c.key, label: c.label, kind: c.kind, score: 0 })) });
  }
  res.json({ suggestions: matchConcepts(q, { kinds, limit }).map((c) => ({ key: c.key, label: c.label, kind: c.kind, score: c.score })) });
});

router.get('/', (_req, res) => {
  res.json({
    allergens: ALLERGENS,
    concepts: CONCEPTS.map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
  });
});

export default router;

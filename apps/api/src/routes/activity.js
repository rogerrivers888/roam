/**
 * What the app tells the API about being used.
 *
 * Two things, and only two: which screen somebody is on, and that they are
 * still here. Everything else the back office reports — places saved, trips
 * planned, dishes rated — is read from the tables that work already lives in
 * (repositories/activity.js), so this endpoint is not where features come to be
 * instrumented and cannot drift out of step with what actually happened.
 *
 * It is on the household's own side of the door: any signed-in session may post
 * its own activity, and it is always recorded against that session's household.
 * Nothing here takes a household id from the body — a client cannot write
 * somebody else's history.
 */

import express from 'express';
import { recordEvents } from '../repositories/activity.js';
import { currentHousehold } from './household.js';

const router = express.Router();

/**
 * POST /api/activity — a batch from one device.
 *
 * Answers 202 with a count. It is deliberately unfussy: telemetry that fails
 * must never be something the person using Roam notices, so a malformed batch
 * is dropped quietly rather than argued with.
 */
router.post('/activity', async (req, res, next) => {
  try {
    const household = await currentHousehold().catch(() => null);
    const written = await recordEvents({
      accountId: req.account?.id ?? null,
      householdId: household?.id ?? null,
      events: req.body?.events,
    });
    res.status(202).json({ recorded: written });
  } catch (err) { next(err); }
});

export default router;

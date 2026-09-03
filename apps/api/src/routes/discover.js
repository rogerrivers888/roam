import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { searchAllSources } from '../sources/index.js';
import { deriveCatchment, detourMinutes, reachRadiusKm, TRAVEL_MODES } from '../domain/travel.js';
import { applyConstraints } from '../domain/ranking.js';
import { paceOf, travelLimitFor } from '../domain/pace.js';
import { currentHousehold, loadMembers, toAttendees, loadLearnedPreferences } from './household.js';

const router = Router();

/**
 * Time-based discovery (Epic 3) with optional along-route search (Epic 4 C2).
 *
 * The search is bounded by a catchment — the area reachable in the stated time
 * by the stated mode — never by a radius. Attending members' allergens exclude;
 * their dislikes only rank.
 */
router.post('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);

    const {
      origin,
      destination = null,
      maxTravelMinutes = household.max_travel_minutes,
      mode = 'driving',
      attendingMemberIds,
      categories = [],
      query: searchQuery = '',
      includeEvents = false,
      outingStart = null,
      excludeSeen = false,
      sources = [],
    } = req.body || {};

    if (!origin || typeof origin.lat !== 'number' || typeof origin.lng !== 'number') {
      return res.status(400).json({ error: 'origin_required', message: 'origin must carry lat and lng' });
    }
    if (!TRAVEL_MODES.includes(mode)) {
      return res.status(400).json({ error: 'invalid_mode', message: `mode must be one of ${TRAVEL_MODES.join(', ')}` });
    }

    // Epic 1 C3 / M1 — with no explicit selection every member attends, and a
    // one-member household never has to answer the question at all.
    const attendingIds = Array.isArray(attendingMemberIds) && attendingMemberIds.length
      ? new Set(attendingMemberIds)
      : new Set(members.map((m) => m.id));
    const attendees = toAttendees(members.filter((m) => attendingIds.has(m.id)));

    const { venues, degraded, sourcesQueried } = await searchAllSources({
      center: origin,
      radiusKm: reachRadiusKm(mode, maxTravelMinutes),
      categories,
      query: searchQuery.trim(),
      includeEvents,
      outingStart,
      sources,
    });
    if (sourcesQueried.includes('tripadvisor')) await query('insert into provider_calls (household_id, provider, purpose) values ($1, $2, $3)', [household.id, 'tripadvisor', 'discover']);

    const pace = paceOf(household);
    let inCatchment = deriveCatchment({ origin, maxTravelMinutes, mode, venues }).filter((v) => v.travelMinutes <= Math.max(maxTravelMinutes, travelLimitFor(pace, v)));

    if (destination?.lat != null) {
      inCatchment = inCatchment.map((venue) => ({
        ...venue,
        detourMinutes: detourMinutes({ origin, destination, venue, mode }),
      }));
    }

    // The place ledger holds identifiers only, so "somewhere different" is a
    // client-side filter over fresh results (Technical Constraints §13.1).
    let ledgerFiltered = 0;
    if (excludeSeen) {
      const { rows } = await query(
        `select source, source_place_id from place_ledger
          where household_id = $1 and status in ('shown', 'dismissed')`,
        [household.id],
      );
      const seen = new Set(rows.map((r) => `${r.source}:${r.source_place_id}`));
      const before = inCatchment.length;
      inCatchment = inCatchment.filter((v) => !seen.has(`${v.source}:${v.sourcePlaceId}`));
      ledgerFiltered = before - inCatchment.length;
    }

    const learned = await loadLearnedPreferences(household.id);
    const { candidates, excluded } = applyConstraints({ venues: inCatchment, attendees, learned });

    // Attribution logging, from the first day (Epic 2 C5, Technical Constraints §2).
    const queryId = crypto.randomUUID();
    if (candidates.length > 0) {
      const values = [];
      const params = [household.id, queryId];
      candidates.forEach((c, i) => {
        values.push(`($1, $2, $${params.length + 1}, $${params.length + 2}, $${params.length + 3})`);
        params.push(c.source, c.sourcePlaceId, c.key);
      });
      await query(
        `insert into source_impressions (household_id, query_id, source, source_place_id, resolved_venue_key)
         values ${values.join(', ')}`,
        params,
      );
      await query(
        `insert into place_ledger (household_id, source, source_place_id, status)
         select $1, source, source_place_id, 'shown'
           from unnest($2::text[], $3::text[]) as t(source, source_place_id)`,
        [household.id, candidates.map((c) => c.source), candidates.map((c) => c.sourcePlaceId)],
      );
    }

    res.json({
      queryId,
      catchment: {
        origin,
        destination,
        mode,
        maxTravelMinutes,
        // Never claim a derived isochrone we have not actually derived.
        method: 'estimated-from-distance',
        estimated: true,
        note: 'Travel times are estimated. A timetabled transit isochrone requires the provider in Technical Constraints §6.2.',
      },
      attending: attendees.map((a) => ({ id: a.id, name: a.name })),
      candidates,
      excluded,
      counts: {
        returned: candidates.length,
        excludedByAllergen: excluded.length,
        filteredByLedger: ledgerFiltered,
      },
      sourcesQueried,
      degradedSources: degraded,
      attribution: sourcesQueried,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Record that the household chose a candidate (Epic 2 C6). This is the other
 * half of source attribution — without a recorded selection there is never
 * evidence that a source influenced a real decision, and no grounds to drop it.
 */
router.post('/select', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { queryId, venueKey, status = 'saved' } = req.body || {};
    if (!queryId || !venueKey) return res.status(400).json({ error: 'query_id_and_venue_key_required' });
    if (!['saved', 'dismissed', 'visited'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }

    const { rows } = await query(
      `update source_impressions set selected = true
        where query_id = $1 and resolved_venue_key = $2
        returning source, source_place_id`,
      [queryId, venueKey],
    );
    if (!rows.length) return res.status(404).json({ error: 'impression_not_found' });

    await query(
      `insert into place_ledger (household_id, source, source_place_id, status) values ($1, $2, $3, $4)`,
      [household.id, rows[0].source, rows[0].source_place_id, status],
    );
    res.json({ recorded: true, venueKey, status, sources: rows.map((r) => r.source) });
  } catch (err) {
    next(err);
  }
});

/** Which sources are earning their place. Reads the evidence Epic 2 requires. */
router.get('/source-value', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `select source,
              count(*)                                  as impressions,
              count(*) filter (where selected)          as selections
         from source_impressions
        group by source
        order by selections desc, impressions desc`,
    );
    res.json({
      sources: rows.map((r) => ({
        source: r.source,
        impressions: Number(r.impressions),
        selections: Number(r.selections),
        selectionRate: Number(r.impressions) ? Number(r.selections) / Number(r.impressions) : 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;

// What a household can take with them.
//
//   GET /api/offline/manifest  the pages worth having on the device, and how
//                              much of the household's research is owned
//   GET /api/offline/records   every owned place record, in one request
//
// The rule this keeps is the one from Technical Constraints §4: a device may
// hold what we own and what the household wrote, and nothing that is rented.
// So this endpoint never returns a provider's name, hours, reviews or photos —
// only place_records, which is built from OpenStreetMap, the venue's own page
// and the open encyclopedias, and never expires.
//
// The manifest is a list of paths rather than a bundle of bodies on purpose:
// the web app already calls these endpoints, and warming them puts the same
// answers in the same cache that a normal visit fills. One code path, so the
// offline copy cannot drift from the online one.

import { Router } from 'express';
import { query } from '../db.js';
import { currentHousehold } from './household.js';
import { ownedRecords, ownedSummary, catchUp } from '../sources/own.js';

export const offline = Router();

offline.get('/manifest', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const [{ rows: cities }, { rows: trips }, owned] = await Promise.all([
      query(
        `select distinct country_code, coalesce(locality, 'Elsewhere') as locality
           from household_places where household_id = $1 and country_code is not null`,
        [household.id],
      ),
      query('select id from trips where household_id = $1 order by coalesce(start_date, depart_at::date) desc limit 60', [household.id]),
      ownedSummary(household.id),
    ]);

    // Everything the household has ever seen on a screen that is theirs to keep.
    const paths = [
      '/api/household',
      '/api/household/learned',
      '/api/concepts/browse',
      '/api/atlas',
      '/api/atlas/places',
      '/api/visits',
      '/api/trips',
      '/api/offline/records',
      ...cities.map((c) => `/api/atlas/places?country=${encodeURIComponent(c.country_code)}&city=${encodeURIComponent(c.locality)}`),
      ...trips.map((t) => `/api/trips/${t.id}`),
      // The day itself, so a trip someone is on opens with no signal. Kept only
      // when the times in it are Roam's own estimate rather than Google Routes'
      // answer — that decision is made on the device (web/src/offline/policy.ts).
      ...trips.map((t) => `/api/trips/${t.id}/journey`),
    ];

    // Filling the copy in the background must not spend anybody's money. Every
    // path here is answered from our own database except the atlas place lists,
    // which ask Google what kind of place a few unlabelled rows are
    // (routes/atlas.js, fillTaxonomy). Those are left out of the automatic fill
    // and are saved when the household opens the Places tab, which is the same
    // lookup they would have caused anyway — or by tapping Save everything.
    const free = paths.filter((p) => !p.startsWith('/api/atlas/places') && !p.endsWith('/journey'));

    res.json({
      generatedAt: new Date().toISOString(),
      paths,
      free,
      owned: {
        claimed: owned.claimed ?? 0,
        researched: owned.researched ?? 0,
        inOpenMap: owned.in_open_map ?? 0,
        described: owned.described ?? 0,
        waiting: owned.waiting ?? 0,
        failed: owned.failed ?? 0,
        // Researched by an older version of the researcher, and due to be done again.
        behind: owned.behind ?? 0,
        lastChange: owned.last_change ?? null,
      },
    });
    // A look at the offline card is a good moment to research anything still
    // waiting: it is the one screen where the household is asking about this.
    catchUp({ limit: 10 }).catch(() => null);
  } catch (err) { next(err); }
});

/**
 * Every owned record for the places this household has claimed. This is the
 * one that makes a place openable with no signal: the name, where it is, how to
 * reach them, when they open, what is on the menu and what it is.
 */
offline.get('/records', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const { rows } = await query('select distinct venue_ref from place_claims where household_id = $1', [household.id]);
    const records = await ownedRecords(rows.map((r) => r.venue_ref));
    res.json({
      records,
      count: Object.keys(records).length,
      // Said on the offline card, because a household is entitled to know what
      // it is carrying and under whose terms.
      terms: 'Open data and each venue’s own published details. Kept indefinitely; nothing here is licensed content.',
      generatedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

export default offline;

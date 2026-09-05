/**
 * The atlas library: the back office's screen for it, and the two public reads
 * the app makes.
 *
 * Split down the middle by who is asking:
 *
 *  - Everything under `/api/admin/library` sits behind the admin door and
 *    names a capability — `view_library` to look, `manage_library` to change
 *    anything. Same rule as the rest of the back office (access.js): 404 for
 *    somebody without the door, a named 403 for somebody without the
 *    capability, because a colleague can act on "ask for manage_library" and
 *    cannot act on an empty screen.
 *  - `/api/atlas/regions…` and `/api/images/…` are the household app's, and
 *    they are deliberately dull: one indexed read of one table, no third-party
 *    call in the path, no work done per request. That is the whole point —
 *    "having users wait for a minute or more to get data is unacceptable".
 *
 * Two notes on the image endpoint.
 *
 * It is mounted **above** the session door, unlike everything else in Roam.
 * That is a decision about what these bytes are: open-licence photographs we
 * are entitled to redistribute, already public on Wikimedia Commons, and not
 * about any household. Putting them behind a cookie would cost every card a
 * credentialed request, defeat every shared cache between here and the phone,
 * and protect nothing. A household's own upload is a different matter and is
 * covered by the moderation check — `pending` and `rejected` answer 404, so a
 * picture nobody has looked at yet is not on the open web.
 *
 * And it answers with `immutable` caching for a year, because an image id
 * addresses one set of bytes for ever: changing the picture makes a new row. So
 * the second view of any card is served by the browser, the third by the
 * service worker, and neither reaches this process.
 */

import express from 'express';
import { can, requires } from '../access.js';
import * as lib from '../repositories/library.js';
import { runHarvest, refreshKinds, WIDTHS } from '../sources/harvest.js';
import { query } from '../db.js';

const bad = (message, code = 'bad_request') => Object.assign(new Error(message), { status: 400, code });
const actorOf = (req) => req.account?.email ?? 'the owner (passcode)';

// ---------------------------------------------------------------------------
// the household app's reads
// ---------------------------------------------------------------------------

/** Mounted at `/api/atlas`, inside the session door with the rest of the atlas. */
export const atlasRouter = express.Router();

/** Mounted at `/api/images`, outside it. See the note at the top of the file. */
export const imageRouter = express.Router();

/**
 * Every region and how much is in it. ~107 rows, no images, ~8KB — the index a
 * "where shall we go" screen is built from, and small enough to hold offline.
 */
atlasRouter.get('/regions', async (_req, res, next) => {
  try {
    const rows = await lib.listRegions();
    res.set('cache-control', 'public, max-age=300');
    res.json({
      regions: rows.map((r) => ({
        slug: r.slug, name: r.name, nation: r.nation, kind: r.kind,
        lat: r.lat, lng: r.lng, count: r.published_count, images: r.image_count,
      })),
      attribution: [
        { source: 'Wikidata', licence: 'CC0', url: 'https://www.wikidata.org' },
        { source: 'Wikipedia', licence: 'CC BY-SA 4.0', url: 'https://en.wikipedia.org' },
        { source: 'Wikimedia Commons', licence: 'see each image', url: 'https://commons.wikimedia.org' },
      ],
    });
  } catch (err) { next(err); }
});

/**
 * One region's published list, with the placeholder for every card inlined.
 *
 * The `lqip` is a 20px JPEG as a data URI — about 500 bytes each, so a hundred
 * of them is 50KB and the whole of London arrives in one answer that renders
 * immediately. The real photograph then streams in over it from `/api/images`.
 * That is the trick behind "almost instant": the first paint owes nothing to
 * the image network at all.
 */
atlasRouter.get('/regions/:slug', async (req, res, next) => {
  try {
    const region = await lib.regionBySlug(req.params.slug);
    if (!region) return res.status(404).json({ error: 'not_found' });
    const rows = await lib.publishedFor(region.slug);
    res.set('cache-control', 'public, max-age=300');
    res.json({
      region: { slug: region.slug, name: region.name, nation: region.nation, kind: region.kind, lat: region.lat, lng: region.lng },
      attractions: rows.map((a) => ({
        id: a.id, name: a.name, slug: a.slug, rank: a.rank, category: a.category,
        summary: a.summary, lat: a.lat, lng: a.lng, website: a.website,
        wikipediaUrl: a.wikipedia_url, osmRef: a.osm_ref, heritage: a.heritage,
        venueRef: a.venue_ref, attribution: a.attribution,
        image: a.image_id ? {
          id: a.image_id, lqip: a.lqip,
          // The credit travels with the picture, always. A card that shows the
          // photograph and not the line is the licence broken.
          credit: a.credit_line, licence: a.licence, licenceUrl: a.licence_url,
          sourceUrl: a.source_page_url, creditRequired: a.attribution_required,
        } : null,
      })),
    });
  } catch (err) { next(err); }
});

/** The bytes. `/api/images/:id/500` — one row, one buffer, cached for a year. */
imageRouter.get('/:id/:width', async (req, res, next) => {
  try {
    const image = await lib.imageById(req.params.id);
    if (!image || image.moderation !== 'approved') return res.status(404).end();
    const variant = await lib.variantFor(image.id, Number(req.params.width));
    if (!variant) return res.status(404).end();
    res.set({
      'content-type': variant.mime,
      // An id addresses one photograph for ever; a different picture is a
      // different row. So this may be cached as hard as the web allows.
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${image.id}-${variant.width}"`,
      // The licence, on the response itself, so it is attached to the bytes
      // wherever they end up and not only to the JSON that pointed at them.
      'x-licence': image.licence,
      'x-attribution': image.credit_line ?? '',
      'x-source': image.source_page_url ?? '',
    });
    res.end(variant.body);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// the back office
// ---------------------------------------------------------------------------

export const adminRouter = express.Router();

/** The first screen: what exists, what it weighs, and what is missing. */
adminRouter.get('/', requires('view_library'), async (_req, res, next) => {
  try {
    const [stats, runs, running] = await Promise.all([
      lib.libraryStats(), lib.recentRuns(8), lib.runningRun(),
    ]);
    res.json({ ...stats, runs, running, widths: WIDTHS });
  } catch (err) { next(err); }
});

// --- the gazetteer ---------------------------------------------------------

adminRouter.get('/regions', requires('view_library'), async (req, res, next) => {
  try {
    res.json({ regions: await lib.listRegions({ nation: req.query.nation, state: req.query.state }) });
  } catch (err) { next(err); }
});

adminRouter.patch('/regions/:slug', requires('manage_library'), async (req, res, next) => {
  try {
    const region = await lib.setRegionTarget(req.params.slug, req.body?.targetCount);
    if (!region) return res.status(404).json({ error: 'not_found' });
    // The target changed, so the published set has to change with it — that is
    // the whole meaning of the number.
    res.json({ region: await lib.rankRegion(region.slug) });
  } catch (err) { next(err); }
});

// --- attractions -----------------------------------------------------------

adminRouter.get('/attractions', requires('view_library'), async (req, res, next) => {
  try {
    const rows = await lib.listAttractions({
      region: req.query.region, state: req.query.state, q: req.query.q,
      category: req.query.category,
      limit: Math.min(500, Number(req.query.limit) || 200),
      offset: Number(req.query.offset) || 0,
    });
    res.json({ attractions: rows });
  } catch (err) { next(err); }
});

/**
 * Publish, hide or pin one.
 *
 * The three verbs a curated list needs, and the reason `pinned` exists at all:
 * without it every hand correction is undone by the next harvest, and a back
 * office whose decisions do not survive the night is a viewer, not a tool.
 */
adminRouter.patch('/attractions/:id', requires('manage_library'), async (req, res, next) => {
  try {
    const { state, pinned, note } = req.body ?? {};
    if (state && !['candidate', 'published', 'hidden'].includes(state)) throw bad('Unknown state');
    const row = await lib.setAttractionState(req.params.id, { state, pinned, note, by: actorOf(req) });
    if (!row) return res.status(404).json({ error: 'not_found' });
    await query(
      `insert into admin_audit (actor_id, actor_label, action, subject_type, subject_id, subject_label, after)
       values ($1,$2,$3,'attraction',$4,$5,$6)`,
      [req.account?.id ?? null, actorOf(req), 'attraction.curate', row.id, row.name,
       JSON.stringify({ state: row.state, pinned: row.pinned, note: row.note })]);
    res.json({ attraction: row });
  } catch (err) { next(err); }
});

adminRouter.post('/regions/:slug/rank', requires('manage_library'), async (req, res, next) => {
  try {
    const region = await lib.rankRegion(req.params.slug);
    if (!region) return res.status(404).json({ error: 'not_found' });
    res.json({ region });
  } catch (err) { next(err); }
});

// --- the classifier --------------------------------------------------------

adminRouter.get('/kinds', requires('view_library'), async (req, res, next) => {
  try {
    res.json({
      kinds: await lib.listKinds({
        q: req.query.q,
        admit: req.query.admit == null ? null : req.query.admit === 'true',
        limit: Math.min(500, Number(req.query.limit) || 200),
      }),
    });
  } catch (err) { next(err); }
});

adminRouter.patch('/kinds/:qid', requires('manage_library'), async (req, res, next) => {
  try {
    const row = await lib.setKind(req.params.qid, {
      admit: req.body?.admit, category: req.body?.category, by: actorOf(req),
    });
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ kind: row });
  } catch (err) { next(err); }
});

// --- the images ------------------------------------------------------------

adminRouter.get('/images', requires('view_library'), async (req, res, next) => {
  try {
    const out = await lib.searchImages({
      q: req.query.q, source: req.query.source, licence: req.query.licence,
      region: req.query.region, category: req.query.category,
      subjectType: req.query.subjectType, subjectId: req.query.subjectId,
      moderation: req.query.moderation,
      unlinked: req.query.unlinked === 'true',
      attributionRequired: req.query.credit == null ? null : req.query.credit === 'true',
      limit: Math.min(200, Number(req.query.limit) || 60),
      offset: Number(req.query.offset) || 0,
    });
    res.json(out);
  } catch (err) { next(err); }
});

adminRouter.get('/images/:id', requires('view_library'), async (req, res, next) => {
  try {
    const image = await lib.imageById(req.params.id);
    if (!image) return res.status(404).json({ error: 'not_found' });
    const { rows: links } = await query(
      `select l.*, coalesce(a.name, r.name) as label, a.region_slug
         from image_links l
         left join attractions a on l.subject_type = 'attraction' and a.id::text = l.subject_id
         left join regions r on l.subject_type = 'region' and r.slug = l.subject_id
        where l.image_id = $1`, [image.id]);
    res.json({ image, links });
  } catch (err) { next(err); }
});

/**
 * Approve, reject or re-credit an image, and award the points that go with it.
 *
 * Points rather than money, because nothing in Roam moves money and a reward
 * that implied a payment would be a promise the schema cannot keep. A rejection
 * that follows an award writes a reversing row rather than editing the first
 * one, so the ledger reads as what happened.
 */
adminRouter.patch('/images/:id', requires('manage_library'), async (req, res, next) => {
  try {
    const before = await lib.imageById(req.params.id);
    if (!before) return res.status(404).json({ error: 'not_found' });
    const { moderation, note, points } = req.body ?? {};
    if (moderation && !['approved', 'pending', 'rejected'].includes(moderation)) throw bad('Unknown moderation state');
    const image = await lib.moderateImage(before.id, { moderation, note, by: actorOf(req), points });

    if (before.contributor_account_id && moderation && moderation !== before.moderation) {
      if (moderation === 'approved') {
        await lib.awardPoints({
          accountId: before.contributor_account_id, householdId: before.contributor_household_id,
          imageId: image.id, points: points ?? 10, reason: 'accepted', by: actorOf(req),
        });
      } else if (before.moderation === 'approved') {
        await lib.awardPoints({
          accountId: before.contributor_account_id, householdId: before.contributor_household_id,
          imageId: image.id, points: -(before.reward_points || 10), reason: 'reversed',
          note: note ?? null, by: actorOf(req),
        });
      }
    }
    await query(
      `insert into admin_audit (actor_id, actor_label, action, subject_type, subject_id, subject_label, before, after)
       values ($1,$2,'image.moderate','image',$3,$4,$5,$6)`,
      [req.account?.id ?? null, actorOf(req), image.id, image.title ?? image.source_ref,
       JSON.stringify({ moderation: before.moderation }), JSON.stringify({ moderation: image.moderation })]);
    res.json({ image });
  } catch (err) { next(err); }
});

adminRouter.post('/images/:id/links', requires('manage_library'), async (req, res, next) => {
  try {
    const { subjectType, subjectId, role } = req.body ?? {};
    if (!subjectType || !subjectId) throw bad('Say what this is a picture of');
    res.json({ link: await lib.linkImage(req.params.id, { subjectType, subjectId, role: role ?? 'gallery' }) });
  } catch (err) { next(err); }
});

adminRouter.delete('/images/:id/links', requires('manage_library'), async (req, res, next) => {
  try {
    await lib.unlinkImage(req.params.id, req.query.subjectType, req.query.subjectId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

adminRouter.delete('/images/:id', requires('manage_library'), async (req, res, next) => {
  try {
    const image = await lib.imageById(req.params.id);
    if (!image) return res.status(404).json({ error: 'not_found' });
    await lib.deleteImage(image.id);
    await query(
      `insert into admin_audit (actor_id, actor_label, action, subject_type, subject_id, subject_label, before)
       values ($1,$2,'image.delete','image',$3,$4,$5)`,
      [req.account?.id ?? null, actorOf(req), image.id, image.title ?? image.source_ref,
       JSON.stringify({ source: image.source, licence: image.licence, url: image.source_page_url })]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

adminRouter.get('/contributors', requires('view_library'), async (_req, res, next) => {
  try { res.json({ contributors: await lib.contributorBoard() }); } catch (err) { next(err); }
});

// --- running the harvest ---------------------------------------------------

/**
 * Start a harvest.
 *
 * Answers as soon as the run row exists and lets the job carry on in the
 * background: the United Kingdom is about two hours of polite requests, and an
 * HTTP request is not the place to hold that. The screen then polls the run.
 *
 * One at a time, estate-wide. Two harvests would double the rate we ask
 * Wikimedia for things and interleave two sets of writes over the same rows,
 * and neither is worth the minutes it would save on a weekly job.
 */
adminRouter.post('/harvest', requires('manage_library'), async (req, res, next) => {
  try {
    const already = await lib.runningRun();
    if (already) return res.status(409).json({ error: 'busy', message: 'A harvest is already running.', run: already });

    const { scope, regions, withImages = true, refreshTypes = false } = req.body ?? {};
    let slugs = [];
    if (Array.isArray(regions) && regions.length) slugs = regions;
    else if (scope === 'all') slugs = (await lib.listRegions()).map((r) => r.slug);
    else if (scope === 'never') slugs = (await lib.listRegions({ state: 'never' })).map((r) => r.slug);
    else if (scope === 'failed') slugs = (await lib.listRegions({ state: 'failed' })).map((r) => r.slug);
    if (!slugs.length && !refreshTypes) throw bad('Nothing to harvest');

    const run = await lib.startRun(slugs.length === 1 ? `region:${slugs[0]}` : `regions:${slugs.length}`, actorOf(req));
    for (const slug of slugs) await lib.setRegionState(slug, 'queued');
    await query(
      `insert into admin_audit (actor_id, actor_label, action, subject_type, subject_id, after)
       values ($1,$2,'library.harvest','run',$3,$4)`,
      [req.account?.id ?? null, actorOf(req), run.id, JSON.stringify({ regions: slugs.length, withImages, refreshTypes })]);

    // Deliberately not awaited. The failure path is inside runHarvest, which
    // writes it to the run row — so a crash here is reported on the screen
    // rather than lost in an unhandled rejection.
    runHarvest({ slugs, withImages, refreshTypes, runId: run.id, startedBy: actorOf(req) })
      .catch((err) => lib.endRun(run.id, { state: 'failed', error: err.message?.slice(0, 500) }));

    res.status(202).json({ run });
  } catch (err) { next(err); }
});

adminRouter.get('/harvest/:id', requires('view_library'), async (req, res, next) => {
  try {
    const run = await lib.runById(req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    res.json({ run });
  } catch (err) { next(err); }
});

adminRouter.post('/harvest/:id/cancel', requires('manage_library'), async (req, res, next) => {
  try {
    const run = await lib.endRun(req.params.id, { state: 'cancelled' });
    if (!run) return res.status(404).json({ error: 'not_found' });
    res.json({ run });
  } catch (err) { next(err); }
});

/**
 * Re-ask Wikidata what counts as somewhere to go, then re-file everything we
 * already hold against the answer.
 *
 * The second half is the point. Correcting the classifier does nothing to rows
 * that were written under the old one, and for a month that meant the Outdoors
 * shelf was full of private country houses.
 */
adminRouter.post('/kinds/refresh', requires('manage_library'), async (req, res, next) => {
  try {
    const types = await refreshKinds({});
    const moved = await lib.reclassifyAttractions();
    await query(
      `insert into admin_audit (actor_id, actor_label, action, subject_type, after)
       values ($1,$2,'library.kinds.refresh','kinds',$3)`,
      [req.account?.id ?? null, actorOf(req), JSON.stringify({ types, reclassified: moved.length })]);
    res.json({ types, reclassified: moved.length, moved: moved.slice(0, 50) });
  } catch (err) { next(err); }
});

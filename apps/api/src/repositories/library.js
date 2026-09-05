// Reading and writing the atlas of attractions and the image library.
//
// Every statement that touches `regions`, `place_kinds`, `attractions`,
// `image_assets`, `image_variants`, `image_links`, `image_rewards` and
// `harvest_runs` lives here, so the pipeline (sources/harvest.js) and the back
// office (routes/library.js) cannot drift into two different ideas of what a
// published attraction is.
//
// One rule is enforced in this file rather than left to callers: **an image
// with `may_store` false is never written**. `saveImage` throws on it. The
// licence check happens where the licence is read (sources/wikimedia.js), and
// this is the second lock on the same door, because the cost of getting it
// wrong is a takedown rather than a bug.

import { query, withTransaction } from '../db.js';

// ---------------------------------------------------------------------------
// regions
// ---------------------------------------------------------------------------

export async function listRegions({ nation, state } = {}) {
  const where = []; const args = [];
  if (nation) { args.push(nation); where.push(`nation = $${args.length}`); }
  if (state) { args.push(state); where.push(`harvest_state = $${args.length}`); }
  const { rows } = await query(
    `select * from regions ${where.length ? `where ${where.join(' and ')}` : ''}
      order by nation, position`, args);
  return rows;
}

export const regionBySlug = async (slug) =>
  (await query('select * from regions where slug = $1', [slug])).rows[0] ?? null;

export async function setRegionTarget(slug, target) {
  const { rows } = await query(
    `update regions set target_count = $2, updated_at = now() where slug = $1 returning *`,
    [slug, Math.max(1, Math.min(500, Number(target) || 18))]);
  return rows[0] ?? null;
}

export async function setRegionState(slug, state, { error = null, stamp = false } = {}) {
  const { rows } = await query(
    `update regions set harvest_state = $2, harvest_error = $3,
            harvested_at = case when $4 then now() else harvested_at end, updated_at = now()
      where slug = $1 returning *`, [slug, state, error, stamp]);
  return rows[0] ?? null;
}

/** Recount what a region actually holds, rather than trusting a counter. */
export async function refreshRegionCounts(slug) {
  await query(
    `update regions r set
       candidate_count = (select count(*) from attractions a where a.region_slug = r.slug),
       published_count = (select count(*) from attractions a where a.region_slug = r.slug and a.state = 'published'),
       image_count     = (select count(distinct l.image_id) from attractions a
                            join image_links l on l.subject_type = 'attraction' and l.subject_id = a.id::text
                           where a.region_slug = r.slug),
       updated_at = now()
     where r.slug = $1`, [slug]);
}

// ---------------------------------------------------------------------------
// what counts as somewhere to go
// ---------------------------------------------------------------------------

/**
 * Write the subclass tree, leaving every hand-made decision alone.
 *
 * `where not place_kinds.overridden` is the whole point: somebody in the back
 * office deciding that a railway station is not a day out must not be undone by
 * the next refresh of a tree that never agreed with them in the first place.
 */
export async function upsertKinds(kinds) {
  if (!kinds.length) return 0;
  const values = kinds.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(',');
  const args = kinds.flatMap((k) => [k.qid, k.rootQid, k.category, k.label ?? null]);
  const { rowCount } = await query(
    `insert into place_kinds (qid, root_qid, category, label)
     values ${values}
     on conflict (qid) do update
        set root_qid = excluded.root_qid,
            category = case when place_kinds.overridden then place_kinds.category else excluded.category end,
            label    = coalesce(excluded.label, place_kinds.label),
            updated_at = now()
      where not place_kinds.overridden`, args);
  return rowCount;
}

/** The classifier, as a map, for the pipeline to consult per candidate. */
export async function kindMap() {
  const { rows } = await query('select qid, category, admit from place_kinds');
  return new Map(rows.map((r) => [r.qid, r]));
}

export async function listKinds({ q, admit, limit = 200 } = {}) {
  const where = []; const args = [];
  if (q) { args.push(`%${q}%`); where.push(`(qid ilike $${args.length} or label ilike $${args.length} or category ilike $${args.length})`); }
  if (admit != null) { args.push(admit); where.push(`admit = $${args.length}`); }
  args.push(limit);
  const { rows } = await query(
    `select * from place_kinds ${where.length ? `where ${where.join(' and ')}` : ''}
      order by seen_count desc, qid limit $${args.length}`, args);
  return rows;
}

export async function setKind(qid, { admit, category, by }) {
  const { rows } = await query(
    `update place_kinds
        set admit = coalesce($2, admit), category = coalesce($3, category),
            overridden = true, overridden_by = $4, updated_at = now()
      where qid = $1 returning *`, [qid, admit ?? null, category ?? null, by ?? null]);
  return rows[0] ?? null;
}

/** The types that still read as a bare Q-number, worst offenders first. */
export async function unlabelledKinds(limit = 400) {
  const { rows } = await query(
    `select qid from place_kinds where label is null or label = ''
      order by seen_count desc, qid limit $1`, [limit]);
  return rows.map((r) => r.qid);
}

/** How many are still nameless, for a screen that says how much is left. */
export const unlabelledKindCount = async () =>
  (await query("select count(*)::int as n from place_kinds where label is null or label = ''")).rows[0].n;

/** Give them their English names. */
export async function nameKinds(labels) {
  const entries = [...labels.entries()];
  if (!entries.length) return 0;
  const { rowCount } = await query(
    `update place_kinds set label = c.label, updated_at = now()
       from (select unnest($1::text[]) as qid, unnest($2::text[]) as label) c
      where place_kinds.qid = c.qid`,
    [entries.map(([q]) => q), entries.map(([, l]) => l)]);
  return rowCount;
}

/** What Roam calls these types, for a screen that has to name them. */
export async function kindsByQid(qids) {
  if (!qids.length) return new Map();
  const { rows } = await query('select qid, label, category, admit from place_kinds where qid = any($1)', [qids]);
  return new Map(rows.map((r) => [r.qid, r]));
}

/**
 * Recompute every attraction's category from the current classifier.
 *
 * The category is written when a region is listed, so correcting `place_kinds`
 * afterwards changes nothing that already exists — twenty-two kinds of English
 * country house went on being Outdoors until this ran. It applies the same rule
 * the harvest does (the first admitted kind, in the order Wikidata stated them)
 * and touches only rows whose answer actually changes, so it is safe to run
 * whenever the classifier moves.
 *
 * It cannot conjure places the old classifier never admitted — a lake is only
 * listed once its region is listed again. This fixes what is filed wrongly, not
 * what is missing.
 */
export async function reclassifyAttractions() {
  const { rows } = await query(
    `update attractions a
        set category = sub.category, updated_at = now()
       from (
         select a2.id,
                (select k.category
                   from unnest(a2.kinds) with ordinality as u(qid, ord)
                   join place_kinds k on k.qid = u.qid
                  where k.admit
                  order by u.ord
                  limit 1) as category
           from attractions a2
       ) sub
      where a.id = sub.id
        and sub.category is not null
        and a.category is distinct from sub.category
      returning a.id, a.name, a.category`);
  return rows;
}

/**
 * Withdraw anything whose type has since been refused.
 *
 * The companion to `reclassifyAttractions`, and needed for the same reason:
 * admission is decided when a region is listed, so refusing a type afterwards
 * leaves everything already published exactly where it was. Re-filing a country
 * house hotel as heritage makes its category honest and still leaves a working
 * hotel on a shelf of things to do.
 *
 * Hidden rather than deleted, and with the reason written on the row, because
 * this is a judgement that somebody may want to look at and reverse — and
 * because the pictures already fetched for it are still ours.
 */
export async function retireDeniedAttractions() {
  const { rows } = await query(
    `update attractions a
        set state = 'hidden',
            note = coalesce(a.note, 'Withdrawn: its type is not something to go and do'),
            updated_at = now()
      where a.state <> 'hidden'
        -- Pinned beats the rule, as it does everywhere else here. Cliveden is
        -- a country house hotel and a National Trust property, and the type
        -- alone cannot tell it from Elcot Park; a person can, once, for good.
        and not a.pinned
        and exists (select 1 from unnest(a.kinds) as k(qid)
                     join place_kinds pk on pk.qid = k.qid
                    where pk.admit = false)
      returning a.id, a.name, a.region_slug`);
  for (const slug of new Set(rows.map((r) => r.region_slug))) await refreshRegionCounts(slug);
  return rows;
}

/** How often each type has come back, so the noisy ones are easy to find. */
export async function bumpKindsSeen(qids) {
  if (!qids.length) return;
  await query(
    `update place_kinds set seen_count = seen_count + c.n
       from (select unnest($1::text[]) as qid, 1 as n) c
      where place_kinds.qid = c.qid`, [qids]);
}

// ---------------------------------------------------------------------------
// attractions
// ---------------------------------------------------------------------------

/**
 * Write what the harvest found, and never overwrite a decision.
 *
 * `state`, `pinned` and `note` are absent from the update list on purpose: a
 * person hiding a place or pinning it to the top has said something the next
 * harvest has no business contradicting.
 */
export async function upsertAttractions(regionSlug, rows) {
  if (!rows.length) return 0;
  let written = 0;
  await withTransaction(async (client) => {
    for (const a of rows) {
      await client.query(
        `insert into attractions
           (region_slug, wikidata_id, name, slug, summary, summary_source, category, kinds, lat, lng,
            wikipedia_title, wikipedia_url, commons_category, website, osm_ref, heritage,
            sitelinks, pageviews_year, score, score_parts, attribution)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         on conflict (region_slug, wikidata_id) do update set
           name = excluded.name, slug = excluded.slug,
           summary = coalesce(excluded.summary, attractions.summary),
           summary_source = coalesce(excluded.summary_source, attractions.summary_source),
           category = excluded.category, kinds = excluded.kinds,
           lat = coalesce(excluded.lat, attractions.lat), lng = coalesce(excluded.lng, attractions.lng),
           wikipedia_title = excluded.wikipedia_title, wikipedia_url = excluded.wikipedia_url,
           commons_category = coalesce(excluded.commons_category, attractions.commons_category),
           website = coalesce(excluded.website, attractions.website),
           osm_ref = coalesce(excluded.osm_ref, attractions.osm_ref),
           heritage = coalesce(excluded.heritage, attractions.heritage),
           sitelinks = excluded.sitelinks,
           pageviews_year = coalesce(excluded.pageviews_year, attractions.pageviews_year),
           score = excluded.score, score_parts = excluded.score_parts,
           attribution = excluded.attribution, last_seen = now(), updated_at = now()`,
        [regionSlug, a.wikidataId, a.name, a.slug, a.summary ?? null, a.summarySource ?? null,
         a.category ?? null, a.kinds ?? [], a.lat ?? null, a.lng ?? null,
         a.wikipediaTitle ?? null, a.wikipediaUrl ?? null, a.commonsCategory ?? null,
         a.website ?? null, a.osmRef ?? null, a.heritage ?? null,
         a.sitelinks ?? 0, a.pageviewsYear ?? null, a.score ?? 0,
         JSON.stringify(a.scoreParts ?? {}), JSON.stringify(a.attribution ?? [])]);
      written += 1;
    }
  });
  return written;
}

/**
 * Drop what the latest listing of a region no longer contains.
 *
 * Anything pinned or hidden survives, because both are somebody's decision and
 * a harvest does not overrule a person. Image links go with the row, since
 * `image_links.subject_id` is text rather than a foreign key — there is no
 * cascade to rely on, and an orphaned link is an image that shows up attached
 * to nothing.
 */
/**
 * Record what the image pass found, so it is not asked again for ever.
 *
 * 'none' is a real answer about a real place — Commons has no freely licensed
 * photograph of it — and is the difference between a harvest that converges and
 * one that re-examines the same hopeless cases on every run.
 */
export async function noteImagePass(id, state) {
  await query(
    `update attractions set image_state = $2, image_checked_at = now() where id = $1`,
    [id, state]);
}

/**
 * Regions with work outstanding: never listed, or listed and still holding
 * published attractions nobody has looked for a picture for.
 *
 * The second half is the one that matters. `harvest_state = 'done'` only ever
 * meant "listed", so a region whose target was raised from 18 to 250 counted as
 * finished while 186 of its places had no photograph and nothing was ever going
 * to go back for them.
 */
export async function regionsNeedingWork() {
  const { rows } = await query(
    `select slug, name, harvest_state,
            (select count(*) from attractions a
              where a.region_slug = r.slug and a.state = 'published' and a.image_state is null) as unillustrated
       from regions r
      where r.harvest_state = 'never'
         or exists (select 1 from attractions a
                     where a.region_slug = r.slug and a.state = 'published' and a.image_state is null)
      order by r.position`);
  return rows;
}

export async function sweepUnseen(slug, since) {
  const { rows } = await query(
    `with gone as (
       select id from attractions
        where region_slug = $1 and last_seen < $2 and not pinned and state <> 'hidden')
     , unlinked as (
       delete from image_links where subject_type = 'attraction' and subject_id in (select id::text from gone))
     delete from attractions where id in (select id from gone) returning name`,
    [slug, since]);
  return rows.map((r) => r.name);
}

/**
 * Rank a region and publish its top N.
 *
 * Pinned rows sort first whatever they scored, then everything else by score.
 * Hidden rows keep their rank so the list does not renumber itself around a
 * decision — they are simply not published.
 */
export async function rankRegion(slug) {
  const region = await regionBySlug(slug);
  if (!region) return null;
  await query(
    `with ordered as (
       select id, row_number() over (order by pinned desc, score desc, sitelinks desc, name) as r
         from attractions where region_slug = $1 and state <> 'hidden')
     update attractions a set rank = o.r,
            state = case when o.r <= $2 then 'published' else 'candidate' end,
            -- The band and the 0-10 are settled here rather than at write time
            -- because this is the moment the score is final: scoreOf measures a
            -- place against the best-read place in its own region, and until
            -- every candidate has been scored there is no best.
            roam_score = round((a.score * 10)::numeric, 1),
            band = case
              when a.score >= 0.62 then 'top'
              when a.score >= 0.52 then 'high'
              when a.score >= 0.43 then 'good'
              else 'mixed' end,
            updated_at = now()
       from ordered o where a.id = o.id and a.state <> 'hidden'`,
    [slug, region.target_count]);
  await refreshRegionCounts(slug);
  return regionBySlug(slug);
}

export async function listAttractions({ region, state, q, category, limit = 200, offset = 0 } = {}) {
  const where = []; const args = [];
  if (region) { args.push(region); where.push(`a.region_slug = $${args.length}`); }
  if (state) { args.push(state); where.push(`a.state = $${args.length}`); }
  if (category) { args.push(category); where.push(`a.category = $${args.length}`); }
  if (q) { args.push(`%${q}%`); where.push(`a.name ilike $${args.length}`); }
  args.push(limit, offset);
  const { rows } = await query(
    `select a.*, r.name as region_name, r.nation,
            (select count(*) from image_links l where l.subject_type = 'attraction' and l.subject_id = a.id::text) as image_count,
            (select i.id from image_links l join image_assets i on i.id = l.image_id
              where l.subject_type = 'attraction' and l.subject_id = a.id::text and l.role = 'hero' limit 1) as hero_id,
            (select i.lqip from image_links l join image_assets i on i.id = l.image_id
              where l.subject_type = 'attraction' and l.subject_id = a.id::text and l.role = 'hero' limit 1) as hero_lqip
       from attractions a join regions r on r.slug = a.region_slug
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by a.region_slug, a.rank nulls last, a.score desc
      limit $${args.length - 1} offset $${args.length}`, args);
  return rows;
}

export const attractionById = async (id) =>
  (await query('select * from attractions where id = $1', [id])).rows[0] ?? null;

export async function setAttractionState(id, { state, pinned, note, by }) {
  const { rows } = await query(
    `update attractions
        set state = coalesce($2, state), pinned = coalesce($3, pinned),
            note = coalesce($4, note), updated_at = now()
      where id = $1 returning *`, [id, state ?? null, pinned ?? null, note ?? null]);
  const row = rows[0] ?? null;
  if (row) await refreshRegionCounts(row.region_slug);
  return row;
}

/** What a device asks for: one region's published list, hero image and all. */
export async function publishedFor(slug) {
  const { rows } = await query(
    `select a.id, a.name, a.slug, a.summary, a.category, a.lat, a.lng, a.rank,
            a.website, a.wikipedia_url, a.osm_ref, a.heritage, a.venue_ref, a.attribution,
            i.id as image_id, i.lqip, i.credit_line, i.licence, i.licence_url, i.source_page_url,
            i.attribution_required, i.width as image_width, i.height as image_height
       from attractions a
       left join image_links l on l.subject_type = 'attraction' and l.subject_id = a.id::text and l.role = 'hero'
       left join image_assets i on i.id = l.image_id and i.moderation = 'approved'
      where a.region_slug = $1 and a.state = 'published'
      order by a.rank nulls last, a.score desc`, [slug]);
  return rows;
}

/**
 * Published attractions around a point, with the picture we own of each, best
 * first — where "best" accounts for how far away it is.
 *
 * This is what the home screen reads. It is a bounding-box scan over one small
 * table with no third-party call anywhere in it, which is the whole reason the
 * atlas exists: the shelves fill instantly and every card arrives illustrated.
 *
 * **Why distance is in the ordering.** Score alone is region-relative — each
 * county's best thing scores near one — so a wide search pools several counties
 * and London wins on volume. Asked for things to do near Ascot, ranking by
 * score put the Tower of London first at 42.9 km and twelve of the first twenty
 * were central London; Windsor Castle was fourth at 9.7 km and Legoland sixth
 * at 6.3 km. That is a list of Britain's best museums, not an answer to what a
 * family might do on Saturday.
 *
 * The damping is deliberately gentle. Somebody in Ascot really can spend a day
 * at the Tower of London, and a home screen that buried it under every local
 * garden because the garden is closer would be just as wrong in the other
 * direction. At `NEARNESS_WEIGHT` of 0.4 a place at the very edge of the search
 * keeps 60% of its score, which is enough for something exceptional an hour
 * away to hold its own against something merely good round the corner, and not
 * enough for it to lead.
 *
 * The distance here is a flat-earth approximation, which over sixty kilometres
 * is out by centimetres and is only ever used for ordering — the caller's
 * `kmBetween` is what any figure shown to a household comes from.
 *
 * `illustratedOnly` is for the home screen, which is made of pictures. A card
 * with no photograph on a wall of photographs does not read as "we have not got
 * to this one yet", it reads as broken — and an attraction is only ever without
 * one for as long as it takes the next image pass to reach it. Nothing is
 * hidden by this: the back office counts them on its own tile.
 */
const NEARNESS_WEIGHT = 0.4;

export async function publishedNear({ lat, lng, km = 25, limit = 60, illustratedOnly = false }) {
  const dLat = km / 111;
  // Longitude degrees shorten towards the poles. Guarded so a search near a
  // pole cannot divide by nothing and ask for the whole planet.
  const dLng = km / Math.max(1, 111 * Math.cos((lat * Math.PI) / 180));
  const { rows } = await query(
    `with candidates as (
       select a.id, a.name, a.slug, a.summary, a.category, a.kinds, a.lat, a.lng, a.rank, a.region_slug,
              a.website, a.wikipedia_url, a.wikidata_id, a.osm_ref, a.heritage, a.venue_ref,
              a.attribution, a.score, r.name as region_name,
              i.id as image_id, i.lqip, i.credit_line, i.licence, i.licence_url,
              i.source_page_url, i.attribution_required,
              sqrt(power((a.lat - $1) * 111.0, 2)
                 + power((a.lng - $2) * 111.0 * cos(radians($1)), 2)) as km
         from attractions a
         join regions r on r.slug = a.region_slug
         left join image_links l on l.subject_type = 'attraction' and l.subject_id = a.id::text and l.role = 'hero'
         left join image_assets i on i.id = l.image_id and i.moderation = 'approved'
        where a.state = 'published'
          and a.lat between $3 and $4 and a.lng between $5 and $6
          ${illustratedOnly ? 'and i.id is not null' : ''}
     )
     select * from candidates
      -- The box's corners reach ~40% further than its edges; this is the ring.
      where km <= $7
      order by score * (1 - ${NEARNESS_WEIGHT} * least(1.0, km / $7)) desc
      limit $8`,
    [lat, lng, lat - dLat, lat + dLat, lng - dLng, lng + dLng, km, limit]);
  return rows;
}

// ---------------------------------------------------------------------------
// the image library
// ---------------------------------------------------------------------------

/**
 * Write one image and its variants.
 *
 * Refuses anything whose licence was not read and did not permit storage. That
 * is not defensive coding for its own sake: it is the difference between a
 * library we own and a folder of other people's property.
 */
export async function saveImage(asset, variants = []) {
  if (!asset.mayStore) {
    throw Object.assign(new Error(`Refusing to store ${asset.sourceRef ?? asset.title}: licence "${asset.licence}" does not permit it`), { code: 'licence_refused' });
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into image_assets
         (source, source_ref, source_page_url, licence, licence_url, usage_terms, restrictions,
          attribution_required, may_store, creator, creator_url, credit_line, title, caption, tags,
          mime, width, height, bytes, sha256, lqip, contributor_account_id, contributor_household_id,
          moderation, reward_points)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       on conflict (source, source_ref) where source_ref is not null do update set
         licence = excluded.licence, licence_url = excluded.licence_url,
         usage_terms = excluded.usage_terms, restrictions = excluded.restrictions,
         attribution_required = excluded.attribution_required,
         creator = excluded.creator, creator_url = excluded.creator_url,
         credit_line = excluded.credit_line, title = excluded.title,
         caption = coalesce(excluded.caption, image_assets.caption),
         tags = excluded.tags, mime = excluded.mime, width = excluded.width, height = excluded.height,
         bytes = excluded.bytes, lqip = coalesce(excluded.lqip, image_assets.lqip),
         updated_at = now()
       returning *`,
      [asset.source, asset.sourceRef ?? null, asset.sourcePageUrl ?? null, asset.licence,
       asset.licenceUrl ?? null, asset.usageTerms ?? null, asset.restrictions ?? null,
       asset.attributionRequired !== false, true, asset.creator ?? null, asset.creatorUrl ?? null,
       asset.creditLine ?? null, asset.title ?? null, asset.caption ?? null, asset.tags ?? [],
       asset.mime ?? null, asset.width ?? null, asset.height ?? null, asset.bytes ?? null,
       asset.sha256 ?? null, asset.lqip ?? null, asset.contributorAccountId ?? null,
       asset.contributorHouseholdId ?? null, asset.moderation ?? 'approved', asset.rewardPoints ?? 0]);
    const image = rows[0];
    for (const v of variants) {
      await client.query(
        `insert into image_variants (image_id, width, actual_width, actual_height, mime, bytes, body)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (image_id, width) do update set
           actual_width = excluded.actual_width, actual_height = excluded.actual_height,
           mime = excluded.mime, bytes = excluded.bytes, body = excluded.body, fetched_at = now()`,
        [image.id, v.width, v.actualWidth ?? null, v.actualHeight ?? null, v.mime ?? 'image/jpeg', v.bytes, v.body]);
    }
    return image;
  });
}

export async function linkImage(imageId, { subjectType, subjectId, role = 'gallery', position = 0 }) {
  // A hero replaces the hero rather than colliding with the unique index: there
  // is one card image, and saying so twice should mean the second one wins.
  if (role === 'hero') {
    await query(
      `update image_links set role = 'gallery' where subject_type = $1 and subject_id = $2 and role = 'hero' and image_id <> $3`,
      [subjectType, subjectId, imageId]);
  }
  const { rows } = await query(
    `insert into image_links (image_id, subject_type, subject_id, role, position)
     values ($1,$2,$3,$4,$5)
     on conflict (image_id, subject_type, subject_id) do update set role = excluded.role, position = excluded.position
     returning *`, [imageId, subjectType, subjectId, role, position]);
  return rows[0];
}

export const unlinkImage = (imageId, subjectType, subjectId) =>
  query('delete from image_links where image_id = $1 and subject_type = $2 and subject_id = $3', [imageId, subjectType, subjectId]);

/**
 * The index the owner asked for.
 *
 * `q` runs against the weighted tsvector — the picture's title and tags first,
 * then its caption and the attraction it is of, then the region — so "castle
 * kent" finds Leeds Castle whether or not either word is in the file name. The
 * other arguments are the facets a library needs: where it came from, what
 * licence it is under, whether anybody has looked at it, and whether it is
 * attached to anything at all, because an unattached image is invisible
 * everywhere else and this is the only screen that can find it.
 */
export async function searchImages({
  q, source, licence, region, category, subjectType, subjectId, moderation, unlinked, attributionRequired,
  limit = 60, offset = 0,
} = {}) {
  const where = []; const args = [];
  let rank = '0';
  if (q) {
    args.push(q);
    where.push(`i.search @@ websearch_to_tsquery('english', $${args.length})`);
    rank = `ts_rank(i.search, websearch_to_tsquery('english', $${args.length}))`;
  }
  if (source) { args.push(source); where.push(`i.source = $${args.length}`); }
  if (licence) { args.push(`${licence}%`); where.push(`i.licence ilike $${args.length}`); }
  if (moderation) { args.push(moderation); where.push(`i.moderation = $${args.length}`); }
  if (attributionRequired != null) { args.push(attributionRequired); where.push(`i.attribution_required = $${args.length}`); }
  if (region) {
    args.push(region);
    where.push(`exists (select 1 from image_links l join attractions a on l.subject_type = 'attraction' and a.id::text = l.subject_id
                         where l.image_id = i.id and a.region_slug = $${args.length})`);
  }
  if (subjectType && subjectId) {
    args.push(subjectType, subjectId);
    where.push(`exists (select 1 from image_links l where l.image_id = i.id and l.subject_type = $${args.length - 1} and l.subject_id = $${args.length})`);
  }
  // What Roam decided this is a picture of — heritage, outdoors, family… The
  // category lives on the attraction rather than on the image, because the same
  // photograph can illustrate two places; this asks whether any of them is of
  // this kind.
  if (category) {
    args.push(category);
    where.push(`exists (select 1 from image_links l join attractions a on l.subject_type = 'attraction' and a.id::text = l.subject_id
                         where l.image_id = i.id and a.category = $${args.length})`);
  }
  if (unlinked) where.push('not exists (select 1 from image_links l where l.image_id = i.id)');
  args.push(limit, offset);

  const sql = `
    select i.id, i.source, i.source_ref, i.source_page_url, i.licence, i.licence_url,
           i.attribution_required, i.creator, i.creator_url, i.credit_line, i.title, i.caption,
           i.tags, i.width, i.height, i.bytes, i.lqip, i.moderation, i.moderation_note,
           i.reward_points, i.fetched_at, i.contributor_account_id,
           ${rank} as relevance,
           (select array_agg(v.width order by v.width) from image_variants v where v.image_id = i.id) as widths,
           (select coalesce(sum(v.bytes), 0) from image_variants v where v.image_id = i.id) as held_bytes,
           (select string_agg(distinct a.category, ', ')
              from image_links l join attractions a on l.subject_type = 'attraction' and a.id::text = l.subject_id
             where l.image_id = i.id) as categories,
           (select json_agg(json_build_object('type', l.subject_type, 'id', l.subject_id, 'role', l.role,
                                              'label', coalesce(a.name, r.name)))
              from image_links l
              left join attractions a on l.subject_type = 'attraction' and a.id::text = l.subject_id
              left join regions r on l.subject_type = 'region' and r.slug = l.subject_id
             where l.image_id = i.id) as links
      from image_assets i
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by ${q ? 'relevance desc,' : ''} i.fetched_at desc
     limit $${args.length - 1} offset $${args.length}`;

  const [{ rows }, total] = await Promise.all([
    query(sql, args),
    query(`select count(*)::int as n from image_assets i ${where.length ? `where ${where.join(' and ')}` : ''}`, args.slice(0, -2)),
  ]);
  return { images: rows, total: total.rows[0].n };
}

export const imageById = async (id) =>
  (await query(
    `select i.*, (select json_agg(json_build_object('width', v.width, 'actualWidth', v.actual_width,
                                                    'actualHeight', v.actual_height, 'bytes', v.bytes))
                    from image_variants v where v.image_id = i.id) as variants
       from image_assets i where i.id = $1`, [id])).rows[0] ?? null;

/**
 * The bytes to serve, at the nearest width we hold that is at least as wide as
 * the one asked for — and the widest we have if none is. A card asking for 500
 * on a library that only holds 960 gets the 960 rather than a 404.
 */
export async function variantFor(imageId, width) {
  const { rows } = await query(
    `select * from image_variants where image_id = $1
      order by (width >= $2) desc, abs(width - $2) limit 1`, [imageId, Number(width) || 500]);
  return rows[0] ?? null;
}

export async function moderateImage(id, { moderation, note, by, points }) {
  const { rows } = await query(
    `update image_assets set moderation = $2, moderation_note = coalesce($3, moderation_note),
            moderated_by = $4, moderated_at = now(),
            reward_points = coalesce($5, reward_points), updated_at = now()
      where id = $1 returning *`, [id, moderation, note ?? null, by ?? null, points ?? null]);
  return rows[0] ?? null;
}

export const deleteImage = (id) => query('delete from image_assets where id = $1', [id]);

export async function awardPoints({ accountId, householdId, imageId, points, reason, note, by }) {
  const { rows } = await query(
    `insert into image_rewards (account_id, household_id, image_id, points, reason, note, awarded_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [accountId ?? null, householdId ?? null, imageId ?? null, points, reason, note ?? null, by ?? null]);
  return rows[0];
}

export async function contributorBoard({ limit = 20 } = {}) {
  const { rows } = await query(
    `select a.id, a.email, h.name as household,
            count(distinct i.id) filter (where i.moderation = 'approved') as accepted,
            count(distinct i.id) filter (where i.moderation = 'pending') as waiting,
            coalesce(sum(w.points), 0) as points
       from accounts a
       left join households h on h.id = a.household_id
       left join image_assets i on i.contributor_account_id = a.id
       left join image_rewards w on w.account_id = a.id
      where exists (select 1 from image_assets x where x.contributor_account_id = a.id)
      group by a.id, a.email, h.name
      order by points desc, accepted desc limit $1`, [limit]);
  return rows;
}

// ---------------------------------------------------------------------------
// what the whole library looks like
// ---------------------------------------------------------------------------

export async function libraryStats() {
  const [totals, bySource, byLicence, coverage, pending] = await Promise.all([
    query(`select
             (select count(*) from image_assets) as images,
             (select count(*) from image_assets where attribution_required) as needing_credit,
             (select count(*) from image_variants) as variants,
             (select coalesce(sum(bytes), 0) from image_variants) as bytes,
             (select count(*) from attractions) as attractions,
             (select count(*) from attractions where state = 'published') as published,
             (select count(*) from regions) as regions,
             (select count(*) from regions where harvest_state = 'done') as regions_done,
             (select count(*) from attractions a where a.state = 'published'
                and not exists (select 1 from image_links l where l.subject_type = 'attraction'
                                 and l.subject_id = a.id::text and l.role = 'hero')) as published_without_image`),
    // `count(distinct i.id)` rather than `count(*)`: the join to variants gives
    // one row per width, so a plain count reports three pictures where there is
    // one held at three sizes.
    query(`select i.source, count(distinct i.id)::int as n, coalesce(sum(v.bytes), 0)::bigint as bytes
             from image_assets i left join image_variants v on v.image_id = i.id
            group by i.source order by n desc`),
    query(`select licence, attribution_required, count(*)::int as n from image_assets
            group by licence, attribution_required order by n desc`),
    query(`select r.slug, r.name, r.nation, r.kind, r.wikidata_id, r.lat, r.lng,
                  r.target_count, r.harvest_state, r.harvested_at,
                  r.candidate_count, r.published_count, r.image_count, r.harvest_error
             from regions r order by r.nation, r.position`),
    query(`select count(*)::int as n from image_assets where moderation = 'pending'`),
  ]);
  return {
    totals: totals.rows[0],
    bySource: bySource.rows,
    byLicence: byLicence.rows,
    coverage: coverage.rows,
    pendingUploads: pending.rows[0].n,
  };
}

// ---------------------------------------------------------------------------
// harvest runs
// ---------------------------------------------------------------------------

export async function startRun(scope, startedBy) {
  const { rows } = await query(
    `insert into harvest_runs (scope, started_by, stage) values ($1, $2, 'starting') returning *`,
    [scope, startedBy ?? null]);
  return rows[0];
}

export async function noteRun(id, { stage, counts, line }) {
  await query(
    `update harvest_runs
        set touched_at = now(),
            stage = coalesce($2, stage),
            counts = case when $3::jsonb is null then counts else counts || $3::jsonb end,
            log = case when $4::text is null then log
                       else (case when jsonb_array_length(log) > 200 then log - 0 else log end)
                            || jsonb_build_array(jsonb_build_object('at', now(), 'line', $4::text)) end
      where id = $1`,
    [id, stage ?? null, counts ? JSON.stringify(counts) : null, line ?? null]);
}

export async function endRun(id, { state, error } = {}) {
  const { rows } = await query(
    `update harvest_runs set state = $2, error = $3, finished_at = now(), stage = null where id = $1 returning *`,
    [id, state ?? 'done', error ?? null]);
  return rows[0] ?? null;
}

export const runById = async (id) => (await query('select * from harvest_runs where id = $1', [id])).rows[0] ?? null;

export const recentRuns = async (limit = 12) =>
  (await query('select id, scope, stage, state, counts, error, started_by, started_at, finished_at from harvest_runs order by started_at desc limit $1', [limit])).rows;

/**
 * The run that is actually running.
 *
 * "State says running" is not the same as "something is running": the API
 * process can be restarted out from under a job at any moment, and the row it
 * leaves behind would otherwise refuse every harvest afterwards. A run that has
 * said nothing for five minutes has stopped — the pipeline writes a line every
 * few seconds, so five is not a close call — and this closes it out rather than
 * reporting it.
 */
const ABANDONED_AFTER = "5 minutes";

export async function runningRun() {
  await query(
    `update harvest_runs
        set state = 'failed', error = coalesce(error, $1),
            finished_at = now(), stage = null
      where state = 'running' and touched_at < now() - interval '${ABANDONED_AFTER}'`, [RESTARTED]);
  const { rows } = await query(`select * from harvest_runs where state = 'running' order by started_at desc limit 1`);
  return rows[0] ?? null;
}

/**
 * Called once as the API comes up. Whatever a previous process was doing, it is
 * not doing it now — so its run is closed and the regions it had claimed go
 * back to being regions nothing has finished.
 *
 * Returns the runs it closed, so the caller can decide whether to pick the work
 * back up (sources/harvest.js `resumeInterrupted`).
 */
export async function recoverAbandonedRuns() {
  const { rows } = await query(
    `update harvest_runs
        set state = 'failed',
            error = coalesce(error, $1),
            finished_at = coalesce(finished_at, now()), stage = null
      where state = 'running'
      returning id, scope, counts, started_by, started_at`, [RESTARTED]);
  await query(`update regions set harvest_state = 'never', updated_at = now() where harvest_state in ('queued', 'running')`);
  return rows;
}

/** The most recent run, whatever became of it. */
export const lastRun = async () =>
  (await query('select id, scope, state, error, counts, started_at, finished_at from harvest_runs order by started_at desc limit 1')).rows[0] ?? null;

/**
 * The sentence written on a run that a restart took, and the one the resume
 * looks for. A constant rather than a literal in two files, because the resume
 * decides whether to pick hours of work back up by matching it.
 */
export const RESTARTED = 'The API restarted while this was running.';

// ---------------------------------------------------------------------------
// the detail layer (migration 041)
// ---------------------------------------------------------------------------

/**
 * The designations a place holds, and what they are worth.
 *
 * Written separately from `upsertAttractions` because they arrive separately: a
 * second, small SPARQL query over the published ids, rather than two more label
 * joins hung off the one that already walks a whole county.
 */
export async function saveAccolades(id, { accolades = [], acclaim = 0, score, scoreParts, band, roamScore }) {
  const { rows } = await query(
    `update attractions
        set accolades = $2, acclaim = $3,
            score = coalesce($4, score), score_parts = coalesce($5, score_parts),
            band = coalesce($6, band), roam_score = coalesce($7, roam_score),
            updated_at = now()
      where id = $1 returning *`,
    [id, JSON.stringify(accolades), acclaim,
     score ?? null, scoreParts ? JSON.stringify(scoreParts) : null,
     band ?? null, roamScore ?? null]);
  return rows[0] ?? null;
}

/**
 * The queue for the detail pass.
 *
 * Published rows only, and deliberately so. The detail pass is four requests a
 * place — the article, the travel guide, the map and their own ticket page —
 * and running it over the eight hundred candidates a county produces to fill a
 * list of eighteen would be three thousand requests for prose nobody will read.
 * The list is ranked before this runs; this is what happens to the winners.
 *
 * `next_attempt_at` is the backoff. A site that was down at nine is often up at
 * ten, but a place with no Wikivoyage entry and no ticket page will never have
 * one, so a row that has failed four times stops being asked.
 */
export async function attractionsNeedingDetail({ region = null, limit = 50, force = false } = {}) {
  const args = [limit];
  const where = [`a.state = 'published'`];
  if (region) { args.push(region); where.push(`a.region_slug = $${args.length}`); }
  if (!force) {
    where.push(`(d.attraction_id is null
                 or (d.state <> 'done' and d.attempts < 4
                     and (d.next_attempt_at is null or d.next_attempt_at <= now())))`);
  }
  const { rows } = await query(
    `select a.*, r.name as region_name, d.state as detail_state_now, d.attempts
       from attractions a
       join regions r on r.slug = a.region_slug
       left join attraction_details d on d.attraction_id = a.id
      where ${where.join(' and ')}
      order by a.region_slug, a.rank nulls last
      limit $1`, args);
  return rows;
}

/** Everything we hold about the inside of one place, for a drawer to read. */
export async function detailFor(attractionId) {
  const { rows } = await query(
    'select * from attraction_details where attraction_id = $1', [attractionId]);
  return rows[0] ?? null;
}

/**
 * Write what the detail pass found.
 *
 * `partial` is a real and common outcome rather than a failure: Wikipedia
 * almost always answers, a travel guide entry exists for maybe half of places
 * and a machine-readable ticket price for fewer than that. A row with sections
 * and no admission is worth keeping and worth showing, and marking it failed
 * would throw away the half that worked.
 */
export async function saveDetail(attractionId, {
  wikidataId, sections = [], highlights = [], admission = {}, visit = {},
  contentsRef = null, contentsCount = 0, attribution = [], provenance = {},
  state = 'done', error = null,
} = {}) {
  const { rows } = await query(
    `insert into attraction_details
       (attraction_id, wikidata_id, sections, highlights, admission, visit,
        contents_ref, contents_count, attribution, provenance, state, error,
        attempts, researched_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,now(),now())
     on conflict (attraction_id) do update set
       wikidata_id = excluded.wikidata_id,
       sections = excluded.sections, highlights = excluded.highlights,
       admission = excluded.admission, visit = excluded.visit,
       contents_ref = excluded.contents_ref, contents_count = excluded.contents_count,
       attribution = excluded.attribution, provenance = excluded.provenance,
       state = excluded.state, error = excluded.error,
       attempts = attraction_details.attempts + 1,
       researched_at = now(), updated_at = now()
     returning *`,
    [attractionId, wikidataId, JSON.stringify(sections), JSON.stringify(highlights),
     JSON.stringify(admission ?? {}), JSON.stringify(visit ?? {}),
     contentsRef, contentsCount, JSON.stringify(attribution), JSON.stringify(provenance),
     state, error]);
  // Denormalised so the library grid can show a coverage column without
  // dragging six kilobytes of prose per row through the pool to get it.
  await query('update attractions set detail_state = $2 where id = $1', [attractionId, state]);
  return rows[0] ?? null;
}

/**
 * Note that a pass failed, and when it is worth trying again.
 *
 * Doubling from an hour: a Wikimedia wobble clears in minutes, a site that has
 * moved never does, and four attempts is where the difference stops mattering.
 */
export async function markDetailFailed(attractionId, wikidataId, error) {
  await query(
    `insert into attraction_details (attraction_id, wikidata_id, state, error, attempts, next_attempt_at)
     values ($1, $2, 'failed', $3, 1, now() + interval '1 hour')
     on conflict (attraction_id) do update set
       state = 'failed', error = $3,
       attempts = attraction_details.attempts + 1,
       next_attempt_at = now() + (interval '1 hour' * power(2, least(attraction_details.attempts, 4))),
       updated_at = now()`,
    [attractionId, wikidataId, String(error ?? '').slice(0, 400)]);
  await query(`update attractions set detail_state = 'failed' where id = $1`, [attractionId]);
}

/** One attraction with everything attached, which is what a drawer opens on. */
export async function attractionDetail(id) {
  const { rows } = await query(
    `select a.*, r.name as region_name, r.nation,
            d.sections, d.highlights, d.admission, d.visit, d.contents_ref, d.contents_count,
            d.attribution as detail_attribution, d.provenance, d.state as detail_research_state,
            d.error as detail_error, d.researched_at, d.attempts as detail_attempts
       from attractions a
       join regions r on r.slug = a.region_slug
       left join attraction_details d on d.attraction_id = a.id
      where a.id = $1`, [id]);
  const row = rows[0];
  if (!row) return null;
  const { rows: images } = await query(
    `select i.id, i.title, i.caption, i.lqip, i.credit_line, i.licence, i.licence_url,
            i.source_page_url, i.creator, i.attribution_required, l.role, l.position
       from image_links l join image_assets i on i.id = l.image_id
      where l.subject_type = 'attraction' and l.subject_id = $1 and i.moderation = 'approved'
      order by (l.role = 'hero') desc, l.position`, [String(id)]);
  return { ...row, images };
}

/** How much of the atlas has been researched, for the coverage screen. */
export async function detailStats() {
  const { rows } = await query(
    `select count(*) filter (where a.state = 'published') as published,
            count(*) filter (where a.state = 'published' and d.state = 'done') as researched,
            count(*) filter (where a.state = 'published' and d.state = 'partial') as partial,
            count(*) filter (where a.state = 'published' and d.state = 'failed') as failed,
            count(*) filter (where a.state = 'published' and jsonb_array_length(coalesce(d.sections,'[]'::jsonb)) > 0) as with_sections,
            count(*) filter (where a.state = 'published' and coalesce(d.admission,'{}'::jsonb) <> '{}'::jsonb) as with_admission,
            count(*) filter (where a.state = 'published' and d.contents_count > 0) as with_contents,
            count(*) filter (where a.state = 'published' and jsonb_array_length(coalesce(a.accolades,'[]'::jsonb)) > 0) as with_accolades
       from attractions a left join attraction_details d on d.attraction_id = a.id`);
  return rows[0] ?? {};
}

// ---------------------------------------------------------------------------
// pictures for places
// ---------------------------------------------------------------------------
//
// An attraction is a row we made and carries its own image_state (migration
// 039). A place is a venue_ref and a place_record, so the same bookkeeping
// lives in `place_image_passes` (migration 042). Everything below is that
// table, plus the two reads a screen needs: the hero for one place, and the
// heroes for the pageful the home screen is about to draw.

/** The card image for one place, or null. Narrow row: never drags the bytes. */
export const heroForPlace = async (venueRef) =>
  (await query(
    `select i.id, i.source, i.lqip, i.credit_line, i.licence, i.licence_url,
            i.source_page_url, i.attribution_required, i.width, i.height
       from image_links l join image_assets i on i.id = l.image_id
      where l.subject_type = 'place' and l.subject_id = $1 and l.role = 'hero'
        and i.moderation = 'approved'`, [venueRef])).rows[0] ?? null;

/**
 * The card images for a pageful of places, as a Map keyed by venue_ref.
 *
 * One statement for the whole screen. The home screen draws twenty-odd cards
 * and a query each would be twenty round trips before anything is painted.
 */
export async function heroesForPlaces(refs = []) {
  const list = [...new Set(refs.filter(Boolean))];
  if (!list.length) return new Map();
  const { rows } = await query(
    `select l.subject_id as venue_ref, i.id, i.source, i.lqip, i.credit_line, i.licence,
            i.licence_url, i.source_page_url, i.attribution_required, i.width, i.height
       from image_links l join image_assets i on i.id = l.image_id
      where l.subject_type = 'place' and l.role = 'hero'
        and i.moderation = 'approved' and l.subject_id = any($1)`, [list]);
  return new Map(rows.map((r) => [r.venue_ref, r]));
}

/** What the last pass over one place concluded. */
export const placePass = async (venueRef) =>
  (await query('select * from place_image_passes where venue_ref = $1', [venueRef])).rows[0] ?? null;

/**
 * Write down what a pass concluded.
 *
 * `attempts` only counts the passes that broke. A place where every rung was
 * walked and none of them had anything is settled at one attempt, and the only
 * thing that will make us look again is the ladder learning a new rung —
 * which is what `picture_version` is for.
 */
export async function notePlacePass(venueRef, { state, rung, tried = [], error = null, version = 1, nextAttemptAt = null }) {
  const { rows } = await query(
    `insert into place_image_passes (venue_ref, state, rung, tried, attempts, error, picture_version, looked_at, next_attempt_at)
     values ($1,$2,$3,$4::jsonb, case when $2 = 'failed' then 1 else 0 end, $5, $6, now(), $7)
     on conflict (venue_ref) do update set
       state = excluded.state, rung = excluded.rung, tried = excluded.tried,
       attempts = case when excluded.state = 'failed' then place_image_passes.attempts + 1 else 0 end,
       error = excluded.error, picture_version = excluded.picture_version,
       looked_at = now(), next_attempt_at = excluded.next_attempt_at
     returning *`,
    [venueRef, state, rung, JSON.stringify(tried), error, version, nextAttemptAt]);
  return rows[0];
}

/**
 * Places whose card has no picture and whose turn it is.
 *
 * Four cases qualify, and the last is the one that makes the ladder worth
 * improving: never looked at; looked at, broke, and the backoff has passed;
 * and looked at by an older ladder than the one running now. A place settled as
 * 'none' by the current version is deliberately not returned — that is the
 * whole point of writing the negative answer down.
 *
 * Ordered so the places a household actually claimed come first: somewhere
 * shortlisted or visited is worth a picture before somewhere that merely
 * appeared in a search once.
 */
export async function placesNeedingPictures({ limit = 50, version = 1, force = false } = {}) {
  const { rows } = await query(
    `select r.venue_ref, r.name, r.category, r.website, r.lat, r.lng, r.postcode,
            r.wikidata_id, r.wikipedia_url, coalesce(p.attempts, 0) as attempts,
            (select count(*) from place_claims c where c.venue_ref = r.venue_ref) as claims
       from place_records r
       left join place_image_passes p on p.venue_ref = r.venue_ref
       left join image_links l on l.subject_type = 'place' and l.subject_id = r.venue_ref and l.role = 'hero'
      where ($2 or l.image_id is null)
        and ($2
             or p.venue_ref is null
             or p.picture_version < $3
             or (p.state = 'failed' and (p.next_attempt_at is null or p.next_attempt_at <= now()))
             -- The record learned something since we looked. A takeaway with no
             -- website has nothing for the logo rung to read, and settling it as
             -- 'none' for ever would mean the day own.js finds its website in
             -- OpenStreetMap is a day nothing happens.
             or r.updated_at > p.looked_at)
        -- A rung needs something to work from. Nothing to look at, nowhere to
        -- look: not a place this sweep can help, and returning it every run
        -- would starve the ones it can.
        and (r.website is not null or r.wikidata_id is not null or r.wikipedia_url is not null
             or (r.lat is not null and r.lng is not null))
      order by claims desc, r.first_owned asc
      limit $1`, [limit, force, version]);
  return rows;
}

/**
 * Is this exact picture already somebody else's mark?
 *
 * The second lock on the same door as the platform blocklist in sources/logo.js.
 * That list names the hosts we know serve their own icon; this catches the ones
 * nobody thought of, by asking whether these exact bytes are already the logo of
 * a place on a different site. Two restaurants on two different domains cannot
 * both own the same mark — that is a platform's icon, or a template's — so the
 * second one is refused rather than shown a picture of somebody else.
 *
 * Two branches of the same chain are the case this must not break, and it does
 * not: they share an origin, so the origin comparison lets them through.
 */
export async function logoBelongsElsewhere(sha256, origin) {
  if (!sha256 || !origin) return false;
  const { rows } = await query(
    `select i.source_page_url from image_assets i
      where i.source = 'logo' and i.sha256 = $1 and i.source_page_url is not null
      limit 25`, [sha256]);
  return rows.some((r) => {
    try { return new URL(r.source_page_url).origin !== origin; } catch { return false; }
  });
}

/** What the sweep has achieved, for the back office. */
export async function pictureStats() {
  const { rows } = await query(
    `select
       (select count(*) from place_records) as places,
       (select count(*) from image_links where subject_type = 'place' and role = 'hero') as illustrated,
       (select count(*) from place_image_passes where state = 'none') as nothing_found,
       (select count(*) from place_image_passes where state = 'failed') as to_retry,
       (select coalesce(json_object_agg(source, n), '{}'::json) from (
          select i.source, count(*)::int as n
            from image_links l join image_assets i on i.id = l.image_id
           where l.subject_type = 'place' and l.role = 'hero'
           group by i.source) s) as by_source`);
  return rows[0] ?? {};
}

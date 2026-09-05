// The harvest: how a county becomes a list of eighteen things to do, each with
// a photograph we are allowed to keep.
//
// It runs in the back office, never on a household's request. That is the whole
// architectural point of the owner's ask — "having users wait for a minute or
// more to get data is unacceptable… that means instant loading of data" — and
// it is met by moving every slow, third-party, rate-limited thing to a job that
// runs weekly and writes rows. The read path then touches one table.
//
// Four stages, each restartable on its own:
//
//   1. kinds    Ask Wikidata once what types of thing count as somewhere to go,
//               and cache the answer (~5,300 types) in `place_kinds`.
//   2. list     Per region: everything notable inside it with an English
//               Wikipedia article, filtered against those kinds.
//   3. rank     Pageviews for the plausible ones, blended with notability, and
//               the top N published.
//   4. images   For each published attraction, the pictures its article uses,
//               whose licence permits keeping them, stored at three widths.
//
// Nothing here costs money and nothing here needs an account. What it costs is
// somebody else's bandwidth, which is why `sources/wikimedia.js` paces every
// request and identifies Roam in the User-Agent.

import crypto from 'node:crypto';
import * as wm from './wikimedia.js';
import * as lib from '../repositories/library.js';

// The widths held. 20 is the placeholder that renders before the network
// answers; 500 is a card; 960 is the drawer. Wikimedia renders to its own
// buckets, so these are requests rather than promises — `actual_width` records
// what came back.
export const WIDTHS = { hero: [20, 500, 960], gallery: [20, 500] };
const GALLERY_MAX = 3;

/**
 * Types that are certainly not a day out, whatever the subclass tree says.
 *
 * They are written into `place_kinds` as `admit = false, overridden = true`,
 * which puts them on the same screen as every other classification and lets the
 * next person disagree — rather than living in a filter nobody can see. Reading
 * railway station arrives here because it descends from a root that also covers
 * genuine landmarks; a town arrives because a town is where you go, not what
 * you do when you get there.
 */
const DENY = {
  Q486972: 'human settlement', Q3957: 'town', Q532: 'village', Q515: 'city',
  Q1549591: 'big city', Q5084: 'hamlet', Q1115575: 'civil parish', Q1187811: 'unparished area',
  Q56061: 'administrative territorial entity', Q19953632: 'former administrative territorial entity',
  Q180673: 'ceremonial county', Q1136601: 'unitary authority', Q1187580: 'non-metropolitan district',
  Q55488: 'railway station', Q928830: 'metro station', Q548662: 'railway stop',
  Q3914: 'school', Q9842: 'primary school', Q159334: 'secondary school', Q3918: 'university',
  Q476028: 'association football club', Q4498974: 'ice hockey team',
  Q4830453: 'business', Q783794: 'company', Q11707: 'restaurant', Q30022: 'café',
  Q187456: 'bar', Q27686: 'hotel', Q11315: 'shopping centre',
  Q16917: 'hospital', Q34442: 'road', Q79007: 'street', Q4022: 'river',
  // A trading estate is a park in Wikidata's tree and nowhere else. These four
  // are the reason Slough Trading Estate came fifteenth in Berkshire.
  Q1662100: 'industrial park', Q338313: 'business park',
  Q12104567: 'housing estate', Q674950: 'residential area',
  Q1021645: 'office building', Q40357: 'prison',
};

const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// ---------------------------------------------------------------------------
// stage 1: what counts
// ---------------------------------------------------------------------------

export async function refreshKinds({ onLine } = {}) {
  const kinds = await wm.attractionKinds();
  const written = await lib.upsertKinds(kinds);
  onLine?.(`${kinds.length.toLocaleString()} Wikidata types descend from an attraction root; ${written.toLocaleString()} written`);
  // The refusals go in second, so they win on conflict and stay refused.
  await lib.upsertKinds(Object.entries(DENY).map(([qid, label]) => ({ qid, label, rootQid: null, category: 'excluded' })));
  for (const qid of Object.keys(DENY)) await lib.setKind(qid, { admit: false, by: 'Roam' });
  onLine?.(`${Object.keys(DENY).length} types refused outright: towns, stations, schools, businesses`);
  return kinds.length;
}

// ---------------------------------------------------------------------------
// stage 3: the ranking
// ---------------------------------------------------------------------------

/**
 * How interesting is this place, on a scale of nought to one, *within its own
 * region*.
 *
 * Region-relative, and that is the correction that made the lists right. On an
 * absolute log scale a place with 221,000 readers a year and one with 77,000
 * scored 0.89 and 0.81 — a threefold difference in how many people care,
 * flattened to three points of a hundred, which is how Canterbury Cathedral
 * came fifteenth in Kent behind eleven castles. Measured against the best-read
 * place in the same county the gap survives, and the county's own best thing
 * comes first, which is the only ordering anybody would accept.
 *
 * The square root keeps the tail alive: a place with a fifth of the readers of
 * the county's landmark still scores 0.45 rather than 0.2, so the ranking is
 * about which of these is the day out rather than a straight popularity
 * ladder.
 *
 * Six parts, and the reason each is here:
 *
 *  - **views** (0.45) — English Wikipedia readers over twelve months, against
 *    the best-read place in this region. The only part that measures whether
 *    anybody wants to go, as opposed to whether anybody wrote it down.
 *  - **open to visitors** (0.15) — an official website, and somebody named as
 *    running it. This part exists because without it the first run put
 *    Tittenhurst Park (a private house that was once John Lennon's) above
 *    Legoland Windsor, which had 2.4 million visitors last year. Wikipedia is
 *    an encyclopedia; it is interested in things for reasons that are not "you
 *    could spend Saturday there".
 *  - **visitors** (0.15) — a published visitor count, where Wikidata has one.
 *    Nobody publishes a figure for somewhere you cannot go in.
 *  - **notability** (0.15) — Wikidata sitelinks, which separate the nationally
 *    known from the locally listed.
 *  - **designated** (0.05) — Grade I, scheduled monument, World Heritage Site.
 *  - **illustrated** (0.05) — there is a photograph at all, which correlates
 *    with somebody having bothered to go, and matters on a screen of cards.
 *
 * Because the scale is per region, a score is a ranking within one county and
 * not a claim that Rutland's best is worth as much as London's. The parts are
 * kept on the row: "why is this fourth" is the first question anybody asks of a
 * ranked list, and a score with no working is not an answer.
 */
export function scoreOf({ pageviewsYear, sitelinks, hasImage, heritage, visitorsPerYear, hasOperator, website, peakViews }) {
  // An article with no pageview data at all — very new, or moved last week — is
  // estimated from notability rather than scored as "nobody looked", which
  // would bury it for a year. Marked as estimated so the back office can see
  // which rows are guesses.
  const estimated = pageviewsYear == null;
  const views = estimated ? (sitelinks || 0) * 500 : pageviewsYear;
  const peak = Math.max(peakViews || 0, views, 1);
  const readership = Math.sqrt(Math.min(1, views / peak));

  const notability = Math.min(1, Math.log10((sitelinks || 0) + 1) / 2);
  const visitors = visitorsPerYear ? Math.min(1, Math.log10(visitorsPerYear + 1) / 6.5) : 0;
  // Deliberately not "is this Wikidata type one of our roots". Canterbury
  // Cathedral's only type is `Q56242250`, a subclass three steps down, and that
  // test scored the best-known building in Kent as though it were somebody's
  // barn. What actually distinguishes a place people go to is that somebody
  // publishes a page for it and somebody is named as running it.
  const open = (website ? 0.5 : 0) + (hasOperator ? 0.5 : 0);
  const illustrated = hasImage ? 1 : 0;
  const designated = heritage ? 1 : 0;

  const score = 0.45 * readership + 0.15 * open + 0.15 * visitors + 0.15 * notability
              + 0.05 * designated + 0.05 * illustrated;
  return {
    score: Number(score.toFixed(6)),
    parts: {
      views: Number(readership.toFixed(4)), viewsEstimated: estimated,
      open: Number(open.toFixed(2)), visitors: Number(visitors.toFixed(4)),
      notability: Number(notability.toFixed(4)), illustrated, designated,
      pageviewsYear: pageviewsYear ?? null, visitorsPerYear: visitorsPerYear ?? null,
      peakViews: peak, sitelinks: sitelinks ?? 0, hasOperator: Boolean(hasOperator),
    },
  };
}

// ---------------------------------------------------------------------------
// stage 2 + 3: a region
// ---------------------------------------------------------------------------

/**
 * List, classify, rank and publish one region.
 *
 * `pageviewLimit` is the only real cost control: asking the pageviews API about
 * every one of six hundred candidates would be six hundred requests for a list
 * of eighteen. Candidates are pre-sorted by notability and only the plausible
 * top slice is asked about — deliberately several times the target, because
 * notability and interest disagree often enough that a tight cut would miss
 * exactly the popular-but-unremarkable places this is meant to surface.
 */
export async function harvestRegion(slug, { onLine, cancelled, pageviewLimit } = {}) {
  const region = await lib.regionBySlug(slug);
  if (!region) throw new Error(`No region "${slug}"`);
  if (!region.wikidata_id) throw new Error(`Region "${slug}" has no Wikidata id`);

  await lib.setRegionState(slug, 'running');
  const startedAt = new Date();
  const counts = { candidates: 0, admitted: 0, published: 0, pageviews: 0 };
  try {
    const kinds = await lib.kindMap();
    const raw = await wm.areaCandidates(region.wikidata_id);
    counts.candidates = raw.length;
    onLine?.(`${region.name}: ${raw.length} notable things with an article`);

    await lib.bumpKindsSeen(raw.flatMap((c) => c.kinds));

    // Admitted if something it is counts, and nothing it is is refused. Both
    // halves matter: Legoland Windsor is an amusement park *and* a theme park,
    // and Reading is a town that is also a county town.
    const admitted = [];
    for (const c of raw) {
      if (c.wikidataId === region.wikidata_id) continue;
      const rows = c.kinds.map((q) => kinds.get(q)).filter(Boolean);
      if (rows.some((k) => k.admit === false)) continue;
      const good = rows.filter((k) => k.admit);
      if (!good.length) continue;
      admitted.push({ ...c, category: good[0].category });
    }
    counts.admitted = admitted.length;
    onLine?.(`${admitted.length} of them are somewhere to go`);

    admitted.sort((a, b) => b.sitelinks - a.sitelinks);
    const askAbout = pageviewLimit ?? Math.max(60, region.target_count * 4);

    // Two passes, because the score is relative to the best-read place in this
    // region and that is not known until every candidate has been asked about.
    const viewsOf = new Map();
    for (const [i, c] of admitted.entries()) {
      if (cancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (i >= askAbout || !c.wikipediaTitle) continue;
      viewsOf.set(c.wikidataId, await wm.pageviewsYear(c.wikipediaTitle));
      counts.pageviews += 1;
    }
    const peakViews = Math.max(0, ...[...viewsOf.values()].filter((v) => v != null));

    const rows = [];
    for (const c of admitted) {
      const views = viewsOf.get(c.wikidataId) ?? null;
      const { score, parts } = scoreOf({
        pageviewsYear: views, sitelinks: c.sitelinks, hasImage: Boolean(c.imageFile), heritage: c.heritage,
        visitorsPerYear: c.visitorsPerYear, hasOperator: c.hasOperator, website: c.website, peakViews,
      });
      rows.push({
        wikidataId: c.wikidataId, name: c.name, slug: slugify(c.name),
        summary: null, category: c.category, kinds: c.kinds,
        lat: c.lat, lng: c.lng, wikipediaTitle: c.wikipediaTitle, wikipediaUrl: c.wikipediaUrl,
        commonsCategory: c.commonsCategory, website: c.website, osmRef: c.osmRef, heritage: c.heritage,
        sitelinks: c.sitelinks, pageviewsYear: views, score, scoreParts: parts,
        // Wikidata's own statements are CC0 and ask for nothing; the description
        // that arrives in the next step is CC BY-SA and does, which is why the
        // credit is attached to the row rather than printed by a screen.
        attribution: [{ source: 'Wikidata', licence: 'CC0', url: `https://www.wikidata.org/wiki/${c.wikidataId}` }],
        // Kept aside for the image stage rather than written: this is the file
        // Wikidata nominates as the representative picture, and it is the best
        // first guess at a hero.
        _leadImage: c.imageFile,
      });
    }

    await lib.upsertAttractions(slug, rows);
    const gone = await lib.sweepUnseen(slug, startedAt);
    if (gone.length) onLine?.(`${gone.length} no longer listed here: ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? '…' : ''}`);
    const after = await lib.rankRegion(slug);
    counts.published = after?.published_count ?? 0;
    onLine?.(`${region.name}: ${counts.published} published of ${counts.admitted}`);

    // The description, for the ones that will actually be shown. Fetched after
    // ranking so a county costs eighteen extract requests rather than four
    // hundred.
    const published = await lib.listAttractions({ region: slug, state: 'published', limit: 500 });
    const leads = new Map(rows.map((r) => [r.wikidataId, r._leadImage]));
    const withSummaries = [];
    for (const a of published) {
      if (cancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (a.summary || !a.wikipedia_title) continue;
      const summary = await wm.articleExtract(a.wikipedia_title);
      if (!summary) continue;
      withSummaries.push({
        wikidataId: a.wikidata_id, name: a.name, slug: a.slug, summary, summarySource: 'Wikipedia',
        category: a.category, kinds: a.kinds, lat: a.lat, lng: a.lng,
        wikipediaTitle: a.wikipedia_title, wikipediaUrl: a.wikipedia_url,
        commonsCategory: a.commons_category, website: a.website, osmRef: a.osm_ref, heritage: a.heritage,
        sitelinks: a.sitelinks, pageviewsYear: a.pageviews_year, score: a.score, scoreParts: a.score_parts,
        attribution: [
          ...(a.attribution ?? []),
          { source: 'Wikipedia', licence: 'CC BY-SA 4.0', url: a.wikipedia_url, note: 'Description' },
        ],
      });
    }
    if (withSummaries.length) await lib.upsertAttractions(slug, withSummaries);
    onLine?.(`${withSummaries.length} descriptions from Wikipedia`);

    await lib.setRegionState(slug, 'done', { stamp: true });
    return { counts, leads };
  } catch (err) {
    await lib.setRegionState(slug, err.cancelled ? 'never' : 'failed', { error: err.message?.slice(0, 400) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// stage 4: the pictures
// ---------------------------------------------------------------------------

const creditLine = (f) => {
  const who = f.creator || 'Unknown author';
  return f.attributionRequired ? `${who}, ${f.licence}, via Wikimedia Commons` : `${f.licence}, via Wikimedia Commons`;
};

/**
 * Find, licence-check, download and store pictures for a region's published
 * attractions.
 *
 * The candidate list is Wikidata's nominated image first, then the photographs
 * the Wikipedia article itself uses. Article images are used rather than the
 * Commons category because a category is a filing system, not a selection:
 * Category:Windsor Castle contains a photograph of a Kia Sorento, and what is
 * in the article has been through an editor.
 *
 * Anything whose licence could not be read, or was read and does not permit
 * storage, is counted as `refused` and left where it is. That count is shown in
 * the back office on purpose — a harvest that quietly skipped half of what it
 * saw would look like one that found nothing.
 */
export async function harvestImages(slug, { onLine, cancelled, leads = new Map(), gallery = GALLERY_MAX } = {}) {
  const attractions = await lib.listAttractions({ region: slug, state: 'published', limit: 500 });
  const counts = { looked: 0, stored: 0, refused: 0, bytes: 0, heroes: 0, already: 0 };

  for (const a of attractions) {
    if (cancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    if (a.hero_id) { counts.already += 1; continue; }
    counts.looked += 1;

    const lead = leads.get(a.wikidata_id) ?? null;
    let titles = [];
    if (lead) titles.push(lead.startsWith('File:') ? lead : `File:${lead}`);
    if (a.wikipedia_title) {
      try {
        titles.push(...await wm.articleImages(a.wikipedia_title, { limit: 12 }));
      } catch { /* an article that will not list its images is not a failure of the run */ }
    }
    titles = [...new Set(titles)].slice(0, 12);
    if (!titles.length) continue;

    let details;
    try {
      details = await wm.fileDetails(titles, { widths: WIDTHS.hero });
    } catch (err) {
      onLine?.(`${a.name}: could not read image licences — ${err.message}`);
      continue;
    }

    // Keep Wikidata's nominated image at the front, then the article's order,
    // and drop everything we may not hold.
    const ordered = titles.map((t) => details.get(t) ?? [...details.values()].find((d) => d.askedAs === t)).filter(Boolean);
    const usable = ordered.filter((f) => {
      if (!f.mayStore) counts.refused += 1;
      return f.mayStore;
    });
    if (!usable.length) continue;

    for (const [n, file] of usable.slice(0, 1 + gallery).entries()) {
      const role = n === 0 ? 'hero' : 'gallery';
      const widths = WIDTHS[role];
      const variants = [];
      for (const width of widths) {
        const thumb = file.thumbs[width];
        if (!thumb) continue;
        const got = await wm.fetchImage(thumb.url);
        if (!got) continue;
        variants.push({
          width, actualWidth: thumb.width, actualHeight: thumb.height,
          mime: got.mime, bytes: got.body.length, body: got.body,
        });
      }
      if (!variants.length) continue;
      const smallest = variants.find((v) => v.width === 20) ?? variants[0];
      const largest = variants[variants.length - 1];

      let image;
      try {
        image = await lib.saveImage({
          source: 'wikimedia',
          sourceRef: file.title,
          sourcePageUrl: file.descriptionUrl,
          licence: file.licence,
          licenceUrl: file.licenceUrl,
          usageTerms: file.usageTerms,
          restrictions: file.restrictions,
          attributionRequired: file.attributionRequired,
          mayStore: true,
          creator: file.creator,
          creatorUrl: file.creatorUrl,
          creditLine: creditLine(file),
          title: file.objectName || file.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
          caption: file.caption,
          // The index the library is searched by. The attraction, its category
          // and its county are on the picture itself, so a search for "castle
          // kent" finds it even though neither word is in the file name.
          tags: [a.name, a.category, a.region_name, a.nation, a.heritage].filter(Boolean),
          mime: largest.mime,
          width: file.width, height: file.height,
          bytes: largest.bytes,
          sha256: crypto.createHash('sha256').update(largest.body).digest('hex'),
          lqip: smallest.width === 20 ? `data:${smallest.mime};base64,${smallest.body.toString('base64')}` : null,
        }, variants);
      } catch (err) {
        if (err.code === 'licence_refused') { counts.refused += 1; continue; }
        throw err;
      }

      await lib.linkImage(image.id, { subjectType: 'attraction', subjectId: a.id, role, position: n });
      counts.stored += 1;
      counts.bytes += variants.reduce((n2, v) => n2 + v.bytes, 0);
      if (role === 'hero') counts.heroes += 1;
    }
  }

  await lib.refreshRegionCounts(slug);
  onLine?.(`${slug}: ${counts.heroes} card images, ${counts.stored} pictures, ${(counts.bytes / 1e6).toFixed(1)} MB${counts.refused ? `, ${counts.refused} refused on licence` : ''}`);
  return counts;
}

// ---------------------------------------------------------------------------
// the whole thing
// ---------------------------------------------------------------------------

const add = (into, from) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v; return into; };

/**
 * Run the harvest over a list of regions, writing progress as it goes.
 *
 * One region at a time, deliberately. Concurrency here would buy minutes on a
 * job that runs weekly and would spend them out of Wikimedia's goodwill.
 */
export async function runHarvest({ slugs, withImages = true, refreshTypes = false, runId, startedBy, onLine } = {}) {
  const run = runId ? await lib.runById(runId) : await lib.startRun(`regions:${slugs.length}`, startedBy);
  // Cancellation has to reach inside a region, not only between them: London
  // is a hundred attractions and several hundred requests. The run's state is
  // polled onto a flag that the stages check synchronously as they go.
  let stop = false;
  const cancelled = async () => stop || ((await lib.runById(run.id))?.state === 'cancelled');
  // The same timer is the heartbeat: `touched_at` moves every four seconds, so
  // "has said nothing for five minutes" reliably means the process behind this
  // run has gone (repositories/library.js `runningRun`). A stage that takes a
  // long time — London's pictures are twenty minutes — must not look abandoned.
  const poll = setInterval(async () => {
    if (await cancelled()) stop = true;
    await lib.noteRun(run.id, {}).catch(() => {});
  }, 4000);
  poll.unref?.();
  const check = () => stop;
  const line = async (text) => { onLine?.(text); await lib.noteRun(run.id, { line: text }); };

  const totals = { regions: 0, candidates: 0, admitted: 0, published: 0, stored: 0, refused: 0, bytes: 0, failed: 0 };
  try {
    if (refreshTypes) {
      await lib.noteRun(run.id, { stage: 'types' });
      await refreshKinds({ onLine: line });
    }
    for (const slug of slugs) {
      if (await cancelled()) { stop = true; break; }
      // A region that fails is a region that failed, not a run that failed.
      // Over 107 of them and several hours, something will go wrong somewhere —
      // Wikidata will have a bad minute, an article will be moved mid-fetch —
      // and abandoning ninety finished counties because the ninety-first threw
      // is the wrong answer. The region is marked failed by `harvestRegion`,
      // the reason is written to the log, and the run carries on. "Retry
      // failures" on the Coverage screen is what picks them up.
      try {
        await lib.noteRun(run.id, { stage: `listing ${slug}` });
        const { counts, leads } = await harvestRegion(slug, { onLine: line, cancelled: check });
        add(totals, { regions: 1, candidates: counts.candidates, admitted: counts.admitted, published: counts.published });
        if (withImages) {
          if (await cancelled()) { stop = true; break; }
          await lib.noteRun(run.id, { stage: `pictures for ${slug}` });
          const shots = await harvestImages(slug, { onLine: line, cancelled: check, leads });
          add(totals, { stored: shots.stored, refused: shots.refused, bytes: shots.bytes });
        }
      } catch (err) {
        if (err.cancelled) { stop = true; break; }
        add(totals, { failed: 1 });
        await line(`${slug} failed: ${err.message}`);
      }
      await lib.noteRun(run.id, { counts: totals });
    }
    return await lib.endRun(run.id, { state: stop ? 'cancelled' : 'done' });
  } catch (err) {
    if (err.cancelled) return lib.endRun(run.id, { state: 'cancelled' });
    await lib.noteRun(run.id, { line: `failed: ${err.message}` });
    return lib.endRun(run.id, { state: 'failed', error: err.message?.slice(0, 500) });
  } finally {
    clearInterval(poll);
  }
}

// ---------------------------------------------------------------------------
// picking it back up
// ---------------------------------------------------------------------------

/**
 * Resume a harvest the API was killed in the middle of.
 *
 * The United Kingdom is four or five hours of work living inside a web server
 * that gets restarted for a deploy, a memory limit or nothing in particular —
 * and on a shared repository, a deploy is somebody else's commit as often as
 * it is ours. Left to a person to notice and press the button again, the atlas
 * would simply never finish.
 *
 * So: if the process that just died was harvesting, and there are regions it
 * never got to, this picks them up. It is safe to do unattended because the
 * work is idempotent and cumulative — a finished county stays finished, and
 * `sweepUnseen` keeps the ones that get re-listed honest.
 *
 * Two guards. It only fires when a run was actually interrupted, so a quiet
 * boot does not start hours of work nobody asked for. And it refuses if the
 * last run started within `COOL_OFF`, so a container in a crash loop cannot
 * turn into a crash loop that also hammers Wikimedia.
 */
const COOL_OFF_MS = 4 * 60_000;

/**
 * Pick a harvest back up where a restart left it.
 *
 * Called once as the API comes up, and then every few minutes for as long as it
 * is up. The repeat is not belt-and-braces — it is the whole fix. This ran once
 * at boot to begin with, and declined that one chance because the run it was
 * meant to resume had started two minutes earlier and the cool-off below read
 * that as a restart loop. Nothing ever asked again, and ninety-five counties
 * sat there for good. Deploys land minutes apart in this tree; a resume that
 * gets one attempt will keep landing inside somebody else's deploy. So a
 * cool-off now means "not yet" rather than "never".
 *
 * `atBoot` is the difference between the two callers and it matters. At boot,
 * anything still marked running belongs to a process that is gone and is closed
 * out. On a later check it does not: a run marked running is very likely this
 * process's own, doing exactly what it should, and closing it would be the
 * periodic check killing the harvest it exists to protect. Staleness is judged
 * on `touched_at` instead (repositories/library.js `runningRun`).
 */
export async function resumeInterrupted({ atBoot = false, startedBy = 'Roam (resumed after a restart)' } = {}) {
  const justClosed = atBoot ? await lib.recoverAbandonedRuns() : [];

  if (!atBoot) {
    // Something is genuinely working. Leave it alone.
    const live = await lib.runningRun();
    if (live) return { resumed: false, reason: `already harvesting: ${live.stage ?? live.scope}` };
  }

  // Looking at the *last run* rather than only at what this boot closed is the
  // difference between resuming and not: the restart that kills a run and the
  // restart that should pick it up are usually two different restarts. The
  // first deploy closes the run; the next boots into a database where nothing
  // says "running" any more.
  const last = justClosed[0] ?? (await lib.lastRun());
  if (!last) return null;

  // Only a run a restart took. A run somebody pressed Stop on is a decision,
  // and a run that failed for its own reasons is a bug to look at rather than
  // to repeat every hour until it fills the log.
  const takenByARestart = justClosed.length > 0 || (last.state === 'failed' && last.error === lib.RESTARTED);
  if (!takenByARestart) return { resumed: false, reason: `the last run ${last.state === 'done' ? 'finished' : `ended: ${last.error ?? last.state}`}` };

  // A process that dies within four minutes of starting a run is a process that
  // will die again, and resuming into that is a loop that fills the log with
  // its own failure. Waiting is the answer, not giving up — the next check is
  // along shortly.
  if (last.started_at && Date.now() - new Date(last.started_at).getTime() < COOL_OFF_MS) {
    return { resumed: false, reason: 'a run started moments ago; waiting rather than resuming into a restart loop' };
  }

  const left = (await lib.listRegions({ state: 'never' })).map((r) => r.slug);
  if (!left.length) return { resumed: false, reason: 'nothing left to harvest' };

  const run = await lib.startRun(`resume:${left.length}`, startedBy);
  await lib.noteRun(run.id, { line: `Picking up ${left.length} regions the last run did not reach.` });
  runHarvest({ slugs: left, withImages: true, runId: run.id, startedBy })
    .catch((err) => lib.endRun(run.id, { state: 'failed', error: err.message?.slice(0, 500) }));
  return { resumed: true, regions: left.length, runId: run.id };
}

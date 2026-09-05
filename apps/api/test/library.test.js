/**
 * The atlas harvest, tested where being wrong is expensive rather than
 * inconvenient.
 *
 * Two things here can cost real money or real trouble, and neither of them
 * fails loudly on its own:
 *
 *   * **A licence read wrongly.** An image stored under terms that did not
 *     permit it does not break anything. It sits on a card looking correct
 *     until a takedown arrives, so the reader is tested against the licences
 *     Commons actually returns — including the ones that look free and are not.
 *   * **A ranking that is quietly bad.** A list of eighteen where four are
 *     private houses nobody can visit is a working feature and a useless
 *     product, and the only way that gets caught is by asserting the ordering
 *     the score is supposed to produce.
 *
 * Nothing here reaches the network or the database. The pieces that do are
 * exercised by running the harvest, which is what the back office screen is
 * for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { scoreOf } = await import('../src/sources/harvest.js');
const { ATTRACTION_ROOTS } = await import('../src/sources/wikimedia.js');

// ---------------------------------------------------------------------------
// the ranking
// ---------------------------------------------------------------------------

// Berkshire, as Wikidata actually describes it. `peakViews` is the county's
// best-read place, which is what every score here is relative to.
const PEAK = 613_221;
/** Windsor Castle: read by everyone, no published visitor figure. */
const windsor = { pageviewsYear: 613_221, sitelinks: 85, hasImage: true, heritage: 'Grade I listed building', website: 'https://…', hasOperator: false, peakViews: PEAK };
/** Legoland Windsor: fewer readers, 2.4m visitors through the gate. */
const legoland = { pageviewsYear: 46_657, sitelinks: 12, hasImage: true, heritage: null, website: 'https://…', visitorsPerYear: 2_420_000, peakViews: PEAK };
/** Tittenhurst Park: a notable private house you cannot go into. */
const tittenhurst = { pageviewsYear: 63_028, sitelinks: 5, hasImage: true, heritage: null, website: null, hasOperator: false, peakViews: PEAK };

test('somewhere you can go beats somewhere you merely read about', () => {
  // This is the whole reason the `open` and `visitors` parts exist. Before they
  // did, Tittenhurst outscored Legoland on pageviews alone.
  assert.ok(scoreOf(legoland).score > scoreOf(tittenhurst).score,
    'a theme park with 2.4m visitors must outrank a private house');
  assert.ok(scoreOf(tittenhurst).score > 0, 'and it is still ranked, not discarded');
});

test('the best-known place in a county still comes first', () => {
  assert.ok(scoreOf(windsor).score > scoreOf(legoland).score);
});

test('an article nobody has view data for is estimated, and says so', () => {
  const guessed = scoreOf({ ...legoland, pageviewsYear: null });
  assert.equal(guessed.parts.viewsEstimated, true);
  assert.ok(guessed.parts.views > 0, 'estimated from notability, not scored as nobody looked');
  const known = scoreOf(legoland);
  assert.equal(known.parts.viewsEstimated, false);
  assert.ok(known.score > guessed.score, 'and a real figure this large beats the estimate');
});

test('the score shows its working', () => {
  const { parts } = scoreOf(windsor);
  // The parts a score is made of, whatever they currently are — the point of
  // the test is that the working is kept, not that any one term is permanent.
  // `designated` gave way to `acclaim` when accolades arrived; that is a design
  // change, not a regression, and this asserts the invariant rather than the
  // line-up.
  for (const key of ['views', 'open', 'visitors', 'notability', 'illustrated']) {
    assert.ok(key in parts, `${key} is kept on the row`);
  }
  assert.ok(Object.keys(parts).length >= 8, 'the working is kept, not just the answer');
  assert.equal(parts.pageviewsYear, 613_221, 'and the raw figures with it');
});

test('the county’s best-known place comes first, however many castles it has', () => {
  // Kent, and the bug this replaced: on an absolute log scale Canterbury
  // Cathedral's 221,000 readers scored 0.89 against Dover Castle's 77,000 at
  // 0.81, and the cathedral came fifteenth behind eleven castles.
  const peakViews = 221_392;
  const canterbury = scoreOf({ pageviewsYear: 221_392, sitelinks: 65, hasImage: true, heritage: 'Grade I listed building', website: 'https://…', hasOperator: false, peakViews });
  const dover = scoreOf({ pageviewsYear: 77_466, sitelinks: 36, hasImage: true, heritage: 'Grade I listed building', website: 'https://…', hasOperator: true, peakViews });
  assert.ok(canterbury.score > dover.score,
    `Canterbury Cathedral (${canterbury.score}) must outrank Dover Castle (${dover.score})`);
});

test('a score is relative to its own region, not to the country', () => {
  // The same place, in a county where it is the best thing and in one where it
  // is not. Rutland's best is Rutland's first, and that is the right answer for
  // a screen that shows one county at a time.
  const place = { pageviewsYear: 20_000, sitelinks: 10, hasImage: true, heritage: null, website: 'https://…' };
  const inRutland = scoreOf({ ...place, peakViews: 20_000 });
  const inLondon = scoreOf({ ...place, peakViews: 5_000_000 });
  assert.ok(inRutland.score > inLondon.score);
  assert.equal(inRutland.parts.views, 1, 'the best-read place in a region scores full marks for readership');
});

test('every part is bounded, so no single signal can run away with it', () => {
  const absurd = scoreOf({ pageviewsYear: 9e12, sitelinks: 9999, hasImage: true, heritage: 'x', website: 'x', hasOperator: true, visitorsPerYear: 9e9, peakViews: 1000 });
  assert.ok(absurd.score <= 1.0001, `a score cannot exceed one (got ${absurd.score})`);
  const nothing = scoreOf({ pageviewsYear: 0, sitelinks: 0, hasImage: false, heritage: null });
  assert.ok(nothing.score >= 0);
});

// ---------------------------------------------------------------------------
// what counts as somewhere to go
// ---------------------------------------------------------------------------

test('the roots cover the things a family would call a day out', () => {
  const categories = new Set(Object.values(ATTRACTION_ROOTS));
  for (const wanted of ['museum', 'heritage', 'outdoors', 'family', 'animals', 'arts']) {
    assert.ok(categories.has(wanted), `${wanted} is a category something can be`);
  }
  // Churches were the hole that lost Canterbury Cathedral in the first run.
  assert.ok('Q16970' in ATTRACTION_ROOTS, 'church buildings are in');
  assert.ok('Q194195' in ATTRACTION_ROOTS, 'amusement parks are in');
  // And the owner was explicit that restaurants are not the point here.
  assert.ok(!('Q11707' in ATTRACTION_ROOTS), 'restaurants are not an attraction root');
});

// ---------------------------------------------------------------------------
// the licence
// ---------------------------------------------------------------------------

/**
 * The licence reader is not exported — it is an implementation detail of
 * `fileDetails` — so this drives it the way the harvest does, through a fake
 * Commons answer. What is being asserted is the decision, not the plumbing:
 * which of these may we keep the bytes of.
 */
const commonsAnswer = (files) => ({
  query: {
    pages: Object.fromEntries(files.map((f, i) => [String(i), {
      title: f.title,
      imageinfo: [{
        url: 'https://upload.wikimedia.org/x.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/' + f.title,
        width: 1000, height: 800, mime: 'image/jpeg',
        thumburl: 'https://thumb.wikimedia.org/x/500px-x.jpg', thumbwidth: 500, thumbheight: 400,
        extmetadata: {
          LicenseShortName: { value: f.licence },
          LicenseUrl: f.url ? { value: f.url } : undefined,
          UsageTerms: { value: f.terms ?? f.licence },
          AttributionRequired: f.attributionRequired ? { value: f.attributionRequired } : undefined,
          Restrictions: { value: f.restrictions ?? '' },
          Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Someone">Someone</a>' },
        },
      }],
    }])),
  },
});

test('only licences that permit keeping the bytes are admitted', async (t) => {
  const wm = await import('../src/sources/wikimedia.js');
  const cases = [
    { title: 'File:A.jpg', licence: 'CC BY-SA 4.0', keep: true },
    { title: 'File:B.jpg', licence: 'CC BY 2.0', keep: true },
    { title: 'File:C.jpg', licence: 'CC0', keep: true },
    { title: 'File:D.jpg', licence: 'Public domain', keep: true },
    { title: 'File:E.jpg', licence: 'OGL v3.0', keep: true },
    // The ones that look free and are not. Each of these is on Commons today.
    { title: 'File:F.jpg', licence: 'CC BY-NC 2.0', keep: false },
    { title: 'File:G.jpg', licence: 'CC BY-ND 4.0', keep: false },
    { title: 'File:H.jpg', licence: 'Fair use', keep: false },
    { title: 'File:I.jpg', licence: 'All rights reserved', keep: false },
    // A permissive copyright licence with a second restriction on top of it:
    // the picture is free, the building in it is trademarked. Not ours to hold.
    { title: 'File:J.jpg', licence: 'CC BY-SA 4.0', restrictions: 'trademarked', keep: false },
    // No licence stated at all is a refusal, not a default.
    { title: 'File:K.jpg', licence: '', keep: false },
  ];

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => commonsAnswer(cases),
  });
  t.after(() => { globalThis.fetch = realFetch; });

  const details = await wm.fileDetails(cases.map((c) => c.title), { widths: [500] });
  for (const c of cases) {
    assert.equal(details.get(c.title).mayStore, c.keep,
      `${c.licence || '(no licence)'}${c.restrictions ? ` + ${c.restrictions}` : ''} should ${c.keep ? 'be kept' : 'be refused'}`);
  }
});

test('CC0 and public domain ask for no credit; every BY licence does', async (t) => {
  const wm = await import('../src/sources/wikimedia.js');
  const cases = [
    { title: 'File:A.jpg', licence: 'CC0' },
    { title: 'File:B.jpg', licence: 'Public domain' },
    { title: 'File:C.jpg', licence: 'CC BY-SA 4.0' },
    { title: 'File:D.jpg', licence: 'CC BY 2.0' },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => commonsAnswer(cases),
  });
  t.after(() => { globalThis.fetch = realFetch; });

  const details = await wm.fileDetails(cases.map((c) => c.title), { widths: [500] });
  assert.equal(details.get('File:A.jpg').attributionRequired, false);
  assert.equal(details.get('File:B.jpg').attributionRequired, false);
  assert.equal(details.get('File:C.jpg').attributionRequired, true);
  assert.equal(details.get('File:D.jpg').attributionRequired, true);
  // And the page that states the terms is kept whatever the licence says, since
  // that is the answer to "where did this come from".
  assert.equal(details.get('File:A.jpg').descriptionUrl, 'https://commons.wikimedia.org/wiki/File:A.jpg');
});

test('a non-image answer is never stored as one', async (t) => {
  const wm = await import('../src/sources/wikimedia.js');
  const realFetch = globalThis.fetch;
  // Wikimedia serves an HTML error page with a 200 through some caches. Two
  // kilobytes of markup written into image_variants as a JPEG is how a library
  // fills up with things that will not render.
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: (h) => (h === 'content-type' ? 'text/html; charset=utf-8' : null) },
    arrayBuffer: async () => new ArrayBuffer(2011),
  });
  t.after(() => { globalThis.fetch = realFetch; });
  assert.equal(await wm.fetchImage('https://thumb.wikimedia.org/x.jpg'), null);
});

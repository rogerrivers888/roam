/**
 * The stations table, against a real database built from the migrations.
 *
 * The classifier is tested next door without a database; this is the half that
 * only a database can answer — that the harvest is idempotent, that a
 * bounding-box read is actually bounded, and that "we have never looked here"
 * is a different answer from "there is nothing here". That last distinction is
 * the whole reliability fix: confusing the two is what made an Overpass outage
 * read on screen as "nowhere near here is by a station".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './helpers/db.js';

const { pool, query } = await testDatabase();
const repo = await import('../src/repositories/transit.js');

test.after(() => pool.end());

const stop = (ref, name, kind, lat, lng, network = null) => ({ ref, name, kind, lat, lng, network });

// Bath Spa and Oldfield Park, roughly where they are.
const BATH = [
  stop('node/1', 'Bath Spa', 'rail', 51.3775, -2.3570, 'National Rail'),
  stop('node/2', 'Oldfield Park', 'rail', 51.3736, -2.3796, 'National Rail'),
];
// Manchester: heavy rail and the Metrolink that used to be invisible.
const MANCHESTER = [
  stop('node/10', 'Manchester Piccadilly', 'rail', 53.4773, -2.2312, 'National Rail'),
  stop('node/11', 'Piccadilly Gardens', 'tram', 53.4808, -2.2374, 'Metrolink'),
  stop('node/12', 'St Peter’s Square', 'tram', 53.4784, -2.2440, 'Metrolink'),
];

test('the table exists with the shape the code expects', async () => {
  const { rows } = await query(`select column_name from information_schema.columns
     where table_name = 'transit_stops' order by column_name`);
  const cols = rows.map((r) => r.column_name);
  for (const c of ['ref', 'name', 'kind', 'lat', 'lng', 'network', 'operator', 'country_code', 'fetched_at']) {
    assert.ok(cols.includes(c), `${c} is missing`);
  }
});

test('a kind nobody has heard of cannot be written', async () => {
  // The check constraint is the last line of defence for the promise a row
  // makes: "near a station" must not one day mean a bus stop.
  await assert.rejects(
    () => query(`insert into transit_stops (ref,name,kind,lat,lng) values ('node/99','Somewhere','bus',51,-2)`),
    /transit_stops_kind/,
  );
});

test('harvesting twice stores each stop once', async () => {
  await repo.upsertStops(BATH, 'GB');
  const first = await repo.stopCounts();
  await repo.upsertStops(BATH, 'GB');
  const second = await repo.stopCounts();
  assert.equal(first.total, 2);
  assert.equal(second.total, 2, 'a re-run updates rather than duplicates');
});

test('a re-harvest updates a renamed station in place', async () => {
  await repo.upsertStops([stop('node/1', 'Bath Spa Rebuilt', 'rail', 51.3775, -2.3570)], 'GB');
  const near = await repo.stopsNear(51.3775, -2.3570, 500);
  assert.equal(near[0].name, 'Bath Spa Rebuilt');
  // And the network it already had is not lost to a row that did not carry one.
  assert.equal(near[0].network, 'National Rail');
});

test('near means near: the box is bounded and the order is by distance', async () => {
  await repo.upsertStops(MANCHESTER, 'GB');
  // Standing outside Bath Spa: Manchester is 250km away and must not appear.
  const near = await repo.stopsNear(51.3775, -2.3570, 5000);
  assert.deepEqual(near.map((s) => s.name), ['Bath Spa Rebuilt', 'Oldfield Park']);
  assert.ok(near[0].distanceM < near[1].distanceM, 'nearest first');
  assert.ok(near[1].distanceM > 1500 && near[1].distanceM < 2500, `Oldfield Park is ~2km, got ${near[1].distanceM}m`);
});

test('a tight radius excludes what is just outside it, not just what is far', async () => {
  // The bounding box alone would let Oldfield Park through at 1.6km on the
  // diagonal; the haversine is what actually decides.
  const tight = await repo.stopsNear(51.3775, -2.3570, 1500);
  assert.deepEqual(tight.map((s) => s.name), ['Bath Spa Rebuilt']);
});

test('trams can be asked for, or left out, without a second query', async () => {
  const all = await repo.stopsNear(53.4790, -2.2380, 3000);
  assert.equal(all.length, 3, 'Piccadilly, and the two Metrolink stops');
  const heavy = await repo.stopsNear(53.4790, -2.2380, 3000, { kinds: ['rail'] });
  assert.deepEqual(heavy.map((s) => s.name), ['Manchester Piccadilly']);
  const trams = await repo.stopsNear(53.4790, -2.2380, 3000, { kinds: ['tram'] });
  assert.equal(trams.length, 2);
  assert.ok(trams.every((s) => s.network === 'Metrolink'));
});

test('“never looked here” is not the same answer as “nothing here”', async () => {
  // The distinction the old code could not make, and the reason an outage read
  // as a finding about the map.
  assert.equal(await repo.coverageAt(51.3775, -2.3570), null, 'nothing harvested yet');

  await repo.recordCoverage({ area: 'uk', label: 'United Kingdom', south: 49.8, west: -8.7, north: 60.9, east: 1.8 }, 5, 'harvest');
  const cov = await repo.coverageAt(51.3775, -2.3570);
  assert.equal(cov.area, 'uk');
  assert.equal(cov.stops, 5);
  // Somewhere genuinely outside the harvest is still unknown, and says so.
  assert.equal(await repo.coverageAt(48.8566, 2.3522), null, 'Paris is not covered by a UK harvest');
});

test('the smallest covering area wins, so a live fill-in does not mask a real harvest', async () => {
  await repo.recordCoverage({ area: 'live:51.38,-2.36', label: 'filled in by a search', south: 51.3, west: -2.4, north: 51.5, east: -2.3 }, 2, 'live');
  const cov = await repo.coverageAt(51.3775, -2.3570);
  assert.equal(cov.how, 'live', 'the tighter box is the more specific fact about this point');
});

test('recording coverage twice does not make two areas', async () => {
  await repo.recordCoverage({ area: 'uk', label: 'United Kingdom', south: 49.8, west: -8.7, north: 60.9, east: 1.8 }, 3500, 'harvest');
  const { areas } = await repo.stopCounts();
  assert.equal(areas.filter((a) => a.area === 'uk').length, 1);
  assert.equal(areas.find((a) => a.area === 'uk').stops, 3500, 'and the count is the new one');
});

test('an empty harvest writes nothing and does not throw', async () => {
  assert.equal(await repo.upsertStops([]), 0);
});

// ---------------------------------------------------------------------------
// the harvest, and surviving a bad afternoon on the mirrors
// ---------------------------------------------------------------------------

test('a harvest is resumable: a cell already done is not fetched again', async (t) => {
  const transit = await import('../src/sources/transit.js');
  const asked = [];
  const box = { area: 'test-region', label: 'Test', south: 51, west: -2, north: 53, east: 0 };

  // Two passes over the same region. The second must ask for nothing.
  const run = () => transit.harvestRegion(box, {
    cellDeg: 1, pauseMs: 0,
    upsert: async (stops) => { await repo.upsertStops(stops); return stops.length; },
    record: repo.recordCoverage,
    covered: (cell) => repo.cellCovered(transit.cellArea(cell)),
    onProgress: () => {},
    // Stand in for Overpass: record what was asked for, answer with one stop.
    ...{},
  });

  // fetchStops is module-internal, so the network is stubbed at its source.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    asked.push(String(init.body).slice(0, 40));
    return { ok: true, status: 200, json: async () => ({ elements: [
      { type: 'node', id: 1000 + asked.length, lat: 51.5, lon: -1.5, tags: { railway: 'station', name: `Stop ${asked.length}` } },
    ] }) };
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const first = await run();
  assert.equal(first.failed.length, 0);
  assert.equal(first.cells, 4, 'a 2x2 degree region at one degree a cell');
  const askedFirst = asked.length;
  assert.equal(askedFirst, 4);

  const second = await run();
  assert.equal(asked.length, askedFirst, 'the second run asks Overpass nothing at all');
  assert.equal(second.done, 4);
});

test('one mirror refusing does not lose a cell — another answers it', async (t) => {
  const transit = await import('../src/sources/transit.js');
  const { resetMirrors } = await import('../src/sources/overpass.js');
  resetMirrors();
  let call = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) throw Object.assign(new Error('Overpass 504'), { name: 'TimeoutError' });
    return { ok: true, status: 200, json: async () => ({ elements: [
      { type: 'node', id: 3000 + call, lat: 40.5, lon: 10.5, tags: { railway: 'station', name: 'Recovered' } },
    ] }) };
  };
  t.after(() => { globalThis.fetch = realFetch; resetMirrors(); });

  const out = await transit.harvestRegion(
    { area: 'recover-region', label: 'Recover', south: 40, west: 10, north: 41, east: 11 },
    { cellDeg: 1, pauseMs: 0, upsert: async (st) => { await repo.upsertStops(st); return st.length; }, record: repo.recordCoverage },
  );
  assert.equal(out.failed.length, 0, 'the second mirror answered');
  assert.equal(out.done, 1);
});

test('a cell no mirror can answer leaves the rest harvested, and stays uncovered so it can be filled in', async (t) => {
  const transit = await import('../src/sources/transit.js');
  const { resetMirrors } = await import('../src/sources/overpass.js');
  resetMirrors();
  const box = { area: 'flaky-region', label: 'Flaky', south: 40, west: 10, north: 42, east: 12 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    // Every mirror refuses for one particular cell, and only that one.
    if (String(init.body).includes('41%2C10')) throw Object.assign(new Error('Overpass 504'), { name: 'TimeoutError' });
    return { ok: true, status: 200, json: async () => ({ elements: [
      { type: 'node', id: 2000 + Math.floor(Math.random() * 1e6), lat: 40.5, lon: 10.5, tags: { railway: 'station', name: `Rome ${Math.random()}` } },
    ] }) };
  };
  t.after(() => { globalThis.fetch = realFetch; resetMirrors(); });

  const out = await transit.harvestRegion(box, {
    cellDeg: 1, pauseMs: 0,
    upsert: async (stops) => { await repo.upsertStops(stops); return stops.length; },
    record: repo.recordCoverage,
    covered: (cell) => repo.cellCovered(transit.cellArea(cell)),
  });

  assert.equal(out.failed.length, 1, 'the one cell no mirror would answer');
  assert.equal(out.done, 3, 'and three still landed');
  // The region as a whole is NOT claimed — otherwise the live fallback would
  // never fill the hole, which is the failure this table exists to prevent.
  const { areas } = await repo.stopCounts();
  assert.equal(areas.find((a) => a.area === 'flaky-region'), undefined);
  // But the cells that did answer are covered, so a re-run only does the hole.
  assert.ok(await repo.cellCovered(transit.cellArea({ south: 40, west: 10 })), 'a good cell is remembered');
  assert.equal(await repo.cellCovered(transit.cellArea({ south: 41, west: 10 })), false, 'the bad one is not');
});

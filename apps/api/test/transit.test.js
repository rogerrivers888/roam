/**
 * Stations, and whether "near a station" can be trusted.
 *
 * Owner, 6 Sep 2026: "it needs to be reliable. If it's not reliable, it's not
 * fit for purpose." So what is tested here is not the happy path — that part
 * was never the problem — but the four ways this feature has actually lied:
 *
 *  1. A ride tagged as a station. Legoland's Hill Train came back as somewhere
 *     to catch a train from, and a bed was ranked "4 min walk to Hill Train
 *     Bottom · about 21 min by train".
 *  2. A tram network invisible. Manchester returned nine stops, all heavy rail,
 *     because tram stops are tagged `tram_stop` and nothing asked for them.
 *  3. One stop counted several times, because a tram line has a node per
 *     direction and a big station is mapped once per operator.
 *  4. An outage read as a finding. Overpass down meant no stations, which meant
 *     every bed failed the walk test, which read on screen as "nowhere near
 *     here is by a station".
 *
 * No network: every test here is the classifier, the deduplication or the
 * geometry, all of which are pure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isServiceStop, kindOf, cleanStopName, asStop, dedupe, boxAround, metresBetween, stopsQuery, UK,
} from '../src/sources/transit.js';

const node = (tags, lat = 51.5, lon = -0.1, id = 1) => ({ type: 'node', id, lat, lon, tags });

// ---------------------------------------------------------------------------
// 1. a ride is not a station
// ---------------------------------------------------------------------------

test('Legoland’s Hill Train is not somewhere to catch a train from', () => {
  // The one that shipped: a bed "4 min walk to Hill Train Bottom".
  assert.equal(isServiceStop({ railway: 'station', name: 'Hill Train Bottom', gauge: '610' }), false);
  assert.equal(isServiceStop({ railway: 'station', name: 'Hill Train Bottom', station: 'funicular' }), false);
});

test('every kind of ride is refused, and for its own reason', () => {
  for (const station of ['miniature', 'funicular', 'monorail', 'cable_car', 'chair_lift']) {
    assert.equal(isServiceStop({ railway: 'station', name: 'Somewhere', station }), false, station);
  }
  assert.equal(isServiceStop({ railway: 'station', name: 'Bluebell Railway (heritage)' }), false);
  assert.equal(isServiceStop({ railway: 'station', name: 'Old Halt', disused: 'yes' }), false);
  assert.equal(isServiceStop({ railway: 'station', name: 'Future Halt', 'construction:railway': 'station' }), false);
  assert.equal(isServiceStop({ railway: 'station', name: 'Museum Line', usage: 'tourism' }), false);
  // A narrow gauge under a metre is a garden railway, not Southern.
  assert.equal(isServiceStop({ railway: 'station', name: 'Romney Hythe', gauge: '381' }), false);
  // And a real one survives all of it.
  assert.equal(isServiceStop({ railway: 'station', name: 'Bath Spa' }), true);
  assert.equal(isServiceStop({ railway: 'halt', name: 'Berney Arms' }), true);
});

test('a stop that is not a railway stop at all is refused', () => {
  assert.equal(isServiceStop({ highway: 'bus_stop', name: 'High Street' }), false);
  assert.equal(isServiceStop({ amenity: 'parking', name: 'Station Car Park' }), false);
  assert.equal(isServiceStop({}), false);
});

// ---------------------------------------------------------------------------
// 2. trams, and telling the four kinds apart
// ---------------------------------------------------------------------------

test('a tram stop is a tram stop, which is not the same promise as a station', () => {
  assert.equal(kindOf({ railway: 'tram_stop', name: 'Piccadilly Gardens' }), 'tram');
  assert.equal(isServiceStop({ railway: 'tram_stop', name: 'Piccadilly Gardens' }), true);
  // Metrolink, Supertram, NET and Edinburgh are all tagged this way, and none
  // of them existed as far as Roam was concerned before 6 Sep 2026.
  assert.equal(kindOf({ railway: 'station', station: 'tram', name: 'Cathedral' }), 'tram');
});

test('tube, DLR and heavy rail are told apart', () => {
  assert.equal(kindOf({ railway: 'station', station: 'subway', name: 'Oxford Circus' }), 'subway');
  assert.equal(kindOf({ railway: 'station', station: 'light_rail', name: 'Poplar' }), 'light_rail');
  assert.equal(kindOf({ railway: 'station', name: 'Bath Spa' }), 'rail');
  assert.equal(kindOf({ railway: 'halt', name: 'Berney Arms' }), 'rail');
});

test('the name is what a person would say', () => {
  assert.equal(cleanStopName("Shepherd's Bush (Central Line) Underground Station"), "Shepherd's Bush");
  assert.equal(cleanStopName('Manchester Piccadilly (Metrolink) Tram Stop'), 'Manchester Piccadilly');
  assert.equal(cleanStopName('Bath Spa'), 'Bath Spa');
  // "Battersea Power Station" is a place; only the qualified suffix comes off.
  assert.equal(cleanStopName('Battersea Power Station Underground Station'), 'Battersea Power Station');
});

test('a stop without a name is not offered, because a row cannot show it', () => {
  assert.equal(asStop(node({ railway: 'station' })), null);
  assert.equal(asStop({ type: 'node', id: 1, tags: { railway: 'station', name: 'Nowhere' } }), null, 'nor one without a point');
});

// ---------------------------------------------------------------------------
// 3. one stop, once
// ---------------------------------------------------------------------------

test('a tram line’s two directions are one stop, not two', () => {
  const stops = [
    { ref: 'node/1', name: 'Piccadilly Gardens', kind: 'tram', lat: 53.4808, lng: -2.2374 },
    { ref: 'node/2', name: 'Piccadilly Gardens', kind: 'tram', lat: 53.4809, lng: -2.2375 },
  ];
  assert.equal(dedupe(stops).length, 1);
});

test('the same name across town is two stops', () => {
  const stops = [
    { ref: 'node/1', name: 'Central', kind: 'tram', lat: 53.4808, lng: -2.2374 },
    { ref: 'node/2', name: 'Central', kind: 'tram', lat: 53.5200, lng: -2.2374 },
  ];
  assert.equal(dedupe(stops).length, 2, 'every tram network in Britain has a Central');
});

test('where a station and a tram stop share a name, the station wins the row', () => {
  // Manchester Piccadilly is a railway station that also has trams. Saying
  // "tram stop" would be true and misleading.
  const out = dedupe([
    { ref: 'node/1', name: 'Manchester Piccadilly', kind: 'tram', lat: 53.4772, lng: -2.2311 },
    { ref: 'node/2', name: 'Manchester Piccadilly', kind: 'rail', lat: 53.4773, lng: -2.2312, network: 'National Rail' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'rail');
  assert.equal(out[0].network, 'National Rail');
});

test('two different places 80m apart are not merged', () => {
  const out = dedupe([
    { ref: 'node/1', name: 'Bath Spa', kind: 'rail', lat: 51.3775, lng: -2.3570 },
    { ref: 'node/2', name: 'Bath Bus Station', kind: 'rail', lat: 51.3780, lng: -2.3575 },
  ]);
  assert.equal(out.length, 2, 'names decide; distance only guards against a shared name');
});

// ---------------------------------------------------------------------------
// the geometry the walk is measured with
// ---------------------------------------------------------------------------

test('a box around a point is not a third too wide in Scotland', () => {
  // Longitude degrees narrow towards the poles. Without the cosine, a box
  // around Inverness is far wider east-west than it is tall.
  const inverness = boxAround(57.4778, -4.2247, 10_000);
  const wideKm = metresBetween({ lat: 57.4778, lng: inverness.west }, { lat: 57.4778, lng: inverness.east }) / 1000;
  const tallKm = metresBetween({ lat: inverness.south, lng: -4.2247 }, { lat: inverness.north, lng: -4.2247 }) / 1000;
  assert.ok(Math.abs(wideKm - tallKm) < 1, `box should be square-ish: ${wideKm.toFixed(1)} x ${tallKm.toFixed(1)} km`);
  assert.ok(wideKm > 19 && wideKm < 21, `20km across, got ${wideKm.toFixed(1)}`);
});

test('the walk to Bath Spa is the walk to Bath Spa', () => {
  // The Abbey Hotel to Bath Spa station: about 350m on the map.
  const m = metresBetween({ lat: 51.3800, lng: -2.3590 }, { lat: 51.3775, lng: -2.3570 });
  assert.ok(m > 250 && m < 400, `expected ~300m, got ${Math.round(m)}m`);
});

// ---------------------------------------------------------------------------
// the query itself, because a typo here is an empty country
// ---------------------------------------------------------------------------

test('the harvest asks for all four kinds and nothing else', () => {
  const q = stopsQuery(51, -2, 52, -1);
  assert.match(q, /railway.*station\|halt\|tram_stop/, 'trams must be in the query, not only in the classifier');
  assert.match(q, /out center tags/, 'ways need their centre, or a station mapped as a building has no point');
  assert.match(q, /\(51,-2,52,-1\)/);
});

test('the United Kingdom box covers the corners of it', () => {
  const inside = (lat, lng) => lat >= UK.south && lat <= UK.north && lng >= UK.west && lng <= UK.east;
  assert.ok(inside(50.0657, -5.7132), 'Land’s End');
  assert.ok(inside(58.6373, -3.0689), 'John o’ Groats');
  assert.ok(inside(60.1667, -1.1500), 'Lerwick');
  assert.ok(inside(51.5074, -0.1278), 'London');
  assert.ok(inside(54.5973, -5.9301), 'Belfast');
  assert.ok(!inside(48.8566, 2.3522), 'and not Paris');
});

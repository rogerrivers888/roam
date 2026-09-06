/**
 * What the household ceiling counts.
 *
 * It exists "so one household cannot run up an unbounded bill" (Technical
 * Constraints §14), and it was counting every row in `provider_calls`. Most of
 * those rows are the open map, the encyclopedias and the address lookup, which
 * are free: one afternoon of research put a household at 3,004 of 3,000 on
 * about fifteen hundred free calls, and the first thing it cost them was
 * reading a menu (owner, 6 Sep 2026: "Count only what can cost money").
 *
 * Attribution did not change — every call is still recorded, whoever it went
 * to. This is only about which of them the money guard counts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canBill, FREE_SOURCES } from '../src/constants.js';

test('the open sources cannot send a bill, so they do not fill the ceiling', () => {
  for (const free of ['osm', 'osm-overpass', 'osm-nominatim', 'photon', 'wikipedia', 'wikidata', 'fixtures']) {
    assert.equal(canBill(free), false, free);
  }
});

test('everything that can charge still counts', () => {
  for (const paid of ['anthropic', 'google', 'google-places', 'google-routes', 'tripadvisor', 'liteapi', 'datathistle', 'ticketmaster']) {
    assert.equal(canBill(paid), true, paid);
  }
});

test('a search names every source it asked, and one that bills is enough', () => {
  assert.equal(canBill('fixtures+osm'), false);
  assert.equal(canBill('osm+wikipedia'), false);
  assert.equal(canBill('fixtures+osm+google'), true);
  assert.equal(canBill('fixtures+osm+google+ticketmaster+predicthq+datathistle'), true);
});

test('a row naming nobody counts, because an unknown source is not a free one', () => {
  assert.equal(canBill(''), true);
  assert.equal(canBill(null), true);
  assert.equal(canBill('something-new'), true);
});

test('the free list is names, not patterns, so a new source is billable until it is added', () => {
  assert.ok(FREE_SOURCES.has('wikipedia'));
  assert.ok(!FREE_SOURCES.has('wikipedia-commons'));
});

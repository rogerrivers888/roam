import test from 'node:test';
import assert from 'node:assert/strict';
import { stayAmenities } from '../src/sources/osm.js';
import { stayKindMatches } from '../src/routes/trips.js';

// What the stay wizard asks for (Hotels 2 §18), against what the open map says.

test('a mapper who says there is a pool is believed; silence is not', () => {
  assert.deepEqual(stayAmenities({ tourism: 'hotel', swimming_pool: 'outdoor' }), ['Pool']);
  assert.deepEqual(stayAmenities({ tourism: 'hotel' }), []);
  assert.deepEqual(stayAmenities({ tourism: 'hotel', swimming_pool: 'no' }), []);
});

test('a flat has a kitchen without anybody tagging one', () => {
  assert.ok(stayAmenities({ tourism: 'apartment' }).includes('Kitchen'));
  assert.ok(stayAmenities({ tourism: 'chalet' }).includes('Kitchen'));
  assert.ok(!stayAmenities({ tourism: 'hotel' }).includes('Kitchen'));
});

test('the words on the chips are the words that come back', () => {
  const got = stayAmenities({
    tourism: 'guest_house', breakfast: 'yes', parking: 'yes',
    air_conditioning: 'yes', dog: 'yes', view: 'sea', garden: 'yes',
  });
  assert.deepEqual(got, ['Parking', 'Breakfast', 'Air con', 'Pet-friendly', 'Sea view', 'Garden']);
});

test('a house or a flat is not one word in the open map', () => {
  assert.ok(stayKindMatches('apartment', ['house or flat']));
  assert.ok(stayKindMatches('chalet', ['house or flat']));
  assert.ok(!stayKindMatches('apartment', ['hotel']));
});

test('a B&B answers to guest house, which is what OSM calls it', () => {
  assert.ok(stayKindMatches('guest house', ['b&b']));
  assert.ok(stayKindMatches('Bed and Breakfast', ['b&b']));
});

test('no type asked for is not a filter at all', () => {
  assert.ok(!stayKindMatches('hotel', []));
});

test('a kind nobody mapped is a hotel, so Hotel still finds it', () => {
  assert.ok(stayKindMatches(null, ['hotel']));
});

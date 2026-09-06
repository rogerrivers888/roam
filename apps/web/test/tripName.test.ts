import test from 'node:test';
import assert from 'node:assert/strict';
import { tripName } from '../src/screens/tripName';

// Every record below was read off production on 6 Sep 2026, unchanged.

test('a holiday made from Thorpe Park is not called Runnymede', () => {
  assert.equal(tripName({
    title: 'Thorpe Park · Sep 2026',
    locality: 'Runnymede',
    destination: null,
    base: { label: 'Thorpe Park (centre)' },
    place: { label: 'Thorpe Park' },
    origin: { label: 'Thorpe Park (centre)' },
  }), 'Thorpe Park');
});

test('a holiday made from Legoland is not called Windsor and Maidenhead', () => {
  assert.equal(tripName({
    title: 'Legoland Windsor · Sep 2026',
    locality: 'Windsor and Maidenhead',
    destination: null,
    base: { label: 'Legoland Windsor (centre)' },
    place: { label: 'Legoland Windsor' },
    origin: { label: 'Legoland Windsor (centre)' },
  }), 'Legoland Windsor');
});

test('a day out keeps its destination', () => {
  assert.equal(tripName({
    title: 'Home → Thorpe Park',
    locality: 'Runnymede',
    destination: { label: 'Thorpe Park' },
    base: { label: 'Fairways, Titlarks Hill, Ascot, SL5 0JD' },
    place: null,
    origin: { label: 'Fairways, Titlarks Hill, Ascot, SL5 0JD' },
  }), 'Thorpe Park');
});

test('a town keeps its own name, and loses the county after the comma', () => {
  assert.equal(tripName({
    title: 'Henley-on-Thames · Saturday out',
    locality: 'South Oxfordshire',
    destination: null,
    base: { label: 'Henley-on-Thames, South Oxfordshire (centre)' },
    place: { label: 'Henley-on-Thames, South Oxfordshire' },
    origin: { label: 'Henley-on-Thames, South Oxfordshire (centre)' },
  }), 'Henley-on-Thames');
});

test('a borough is used only when nothing was chosen', () => {
  assert.equal(tripName({ locality: 'Runnymede' }), 'Runnymede');
  assert.equal(tripName({ locality: 'Runnymede', place: { label: 'Thorpe Park' } }), 'Thorpe Park');
});

test('a region holiday is called what they picked, not the town they sleep in', () => {
  assert.equal(tripName({ place: { label: 'Puglia' }, locality: 'Ostuni' }), 'Puglia');
});

test('nothing at all still reads as something', () => {
  assert.equal(tripName({}), 'This trip');
  assert.equal(tripName({ place: { label: '  ' }, origin: { label: 'Ascot' } }), 'Ascot');
});

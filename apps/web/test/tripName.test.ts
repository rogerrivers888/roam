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

// The name on a card, and the name of a place inside one.

test('a title auto-made from the council gets its head swapped, and keeps the month', async () => {
  const { tripTitle } = await import('../src/screens/tripName');
  assert.equal(tripTitle({
    title: 'Bath and North East Somerset · Sep 2026',
    locality: 'Bath and North East Somerset',
    place: { label: 'Bath' },
  }), 'Bath · Sep 2026');
});

test('a title somebody typed is left alone', async () => {
  const { tripTitle } = await import('../src/screens/tripName');
  assert.equal(tripTitle({ title: 'Bath · pub lunch', locality: 'Bath', place: { label: 'Bath' } }), 'Bath · pub lunch');
  assert.equal(tripTitle({ title: 'Home → Thorpe Park', locality: 'Runnymede', destination: { label: 'Thorpe Park' } }), 'Home → Thorpe Park');
  assert.equal(tripTitle({ title: 'Thorpe Park · Sep 2026', locality: 'Runnymede', place: { label: 'Thorpe Park' } }), 'Thorpe Park · Sep 2026');
});

test('a trip with no title at all is named the same way as everything else', async () => {
  const { tripTitle } = await import('../src/screens/tripName');
  assert.equal(tripTitle({ locality: 'Runnymede', place: { label: 'Thorpe Park' } }), 'Thorpe Park');
});

test('an address reads by its town; a place reads by its own name', async () => {
  const { shortPlaceName } = await import('../src/screens/tripName');
  assert.equal(shortPlaceName({ label: 'Fairways, Titlarks Hill, Ascot, SL5 0JD', locality: 'Ascot' }), 'Ascot');
  assert.equal(shortPlaceName({ label: 'Bath', locality: 'Bath and North East Somerset' }), 'Bath');
  assert.equal(shortPlaceName({ label: 'Henley-on-Thames, South Oxfordshire', locality: 'South Oxfordshire' }), 'Henley-on-Thames');
  assert.equal(shortPlaceName({ label: 'Thorpe Park' }), 'Thorpe Park');
  assert.equal(shortPlaceName(null), '');
});

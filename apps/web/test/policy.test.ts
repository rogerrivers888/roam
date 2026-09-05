/**
 * The two allowlists that decide what the device may hold and what it may hold
 * *back* — offline/policy.ts.
 *
 * Both are deny-by-default and both are silent when they are wrong. A `storable`
 * that lets a provider's name through writes rented content to a phone we
 * cannot reach to delete it from. A `queueable` that lets a planning session
 * through replays it hours after it expired. Neither shows up on a screen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpenSource, queueable, storable } from '../src/offline/policy.ts';

// --- what may be written to the device --------------------------------------

test('the household’s own answers are kept whole', () => {
  for (const path of ['/api/household', '/api/household/learned', '/api/visits', '/api/trips', '/api/sources', '/api/offline/records']) {
    assert.notEqual(storable(path, { anything: true }), null, `${path} should be saved`);
  }
});

test('an endpoint nobody has thought about is not saved', () => {
  for (const path of ['/api/plan/preview', '/api/discover', '/api/menu/read', '/api/places/where', '/api/something/new']) {
    assert.equal(storable(path, { anything: true }), null, `${path} must not be saved by default`);
  }
});

test('what a hotel room costs never lands on a phone', () => {
  // The Stay tab's answer carries LiteAPI's hotels and their live prices. Both
  // are rented, and a price is stale within minutes besides — a phone is
  // somewhere we cannot reach to correct either. The trip itself is saved (the
  // test above), so this one exists to stop `/stays` being swept along with it.
  for (const path of ['/api/trips/abc-123/stays', '/api/trips/abc-123/stays?radiusKm=2&rooms=1']) {
    assert.equal(storable(path, { results: [{ name: 'A hotel', offer: { total: 312.5 } }] }), null, `${path} must not be saved`);
  }
});

test('a licensed place row loses its venue on the way to the device', () => {
  const body = {
    places: [
      { venueRef: 'google:places/ChIJabc', name: 'Ours to show, not to keep', venue: { name: 'The Bistro', rating: 4.6, hours: 'Mon–Fri' } },
      { venueRef: 'osm:node/123', name: 'Open data', venue: { name: 'The Park', tags: {} } },
    ],
  };
  const saved: any = storable('/api/atlas/places', body);
  assert.equal(saved.places[0].venue, null, 'the provider’s record must not land');
  assert.notEqual(saved.places[1].venue, null, 'OpenStreetMap is ours to keep');
  // And the answer on screen is untouched: only what is written down is stripped.
  assert.equal(body.places[0].venue!.name, 'The Bistro');
});

test('the provider’s photograph fills a tile but never lands on the device', () => {
  // The rung below the owned ladder's floor (api/src/sources/rentedPhoto.js):
  // where we own no picture of a restaurant, the atlas sends the provider's, to
  // be fetched at display. It is the most strictly rented thing on the row — a
  // reference under a retention allowance of none — so it must not survive the
  // trip to IndexedDB, while our own picture must.
  const body = {
    places: [
      { venueRef: 'google:ChIJabc', name: 'No picture of our own', image: null,
        photos: [{ ref: 'places/ChIJabc/photos/XYZ', attribution: 'A. Photographer' }] },
      { venueRef: 'google:ChIJdef', name: 'The ladder found their mark',
        image: { id: 'img-1', source: 'logo', licence: 'their own mark' } },
    ],
  };
  const saved: any = storable('/api/atlas/places', body);
  assert.equal(saved.places[0].photos, undefined, 'a rented photo reference must not be written down');
  assert.deepEqual(saved.places[1].image, { id: 'img-1', source: 'logo', licence: 'their own mark' },
    'our own picture is ours to keep, and is the whole point of owning it');
  // Untouched on screen: only what is written down is stripped.
  assert.equal(body.places[0].photos![0].ref, 'places/ChIJabc/photos/XYZ');
});

test('a trip’s shortlist is stripped the same way', () => {
  const saved: any = storable('/api/trips/abc-123', {
    trip: { id: 'abc-123' },
    shortlist: [{ venueRef: 'google:places/X', venue: { name: 'Rented' } }, { venueRef: 'fixtures:1', venue: { name: 'Ours' } }],
  });
  assert.equal(saved.shortlist[0].venue, null);
  assert.notEqual(saved.shortlist[1].venue, null);
});

test('a place drawer keeps our side of it and none of theirs', () => {
  const saved: any = storable('/api/places/detail', {
    venueRef: 'google:places/Y',
    venue: { name: 'Theirs', rating: 4.2 },
    ours: { address: 'Researched by us', phone: '01234' },
    household: { note: 'Ada loved the slide' },
    visits: [{ id: 'v1' }],
    menu: { items: ['live look at their site'] },
  });
  assert.equal(saved.venue, null);
  assert.equal(saved.menu, null);
  assert.deepEqual(saved.ours, { address: 'Researched by us', phone: '01234' });
  assert.deepEqual(saved.household, { note: 'Ada loved the slide' });
});

test('a journey is kept only when the times in it are our own arithmetic', () => {
  assert.notEqual(storable('/api/trips/t1/journey', { estimated: true, legs: [] }), null);
  assert.equal(storable('/api/trips/t1/journey', { estimated: false, legs: [] }), null, 'Google Routes’ answer is not ours to keep');
  assert.equal(storable('/api/trips/t1/directions', { legs: [] }), null, 'and neither is one that does not say');
});

test('a participant’s own list is kept, the organiser’s roster is not', () => {
  const saved: any = storable('/api/join/tok123', { group: { name: 'Cornwall' }, expecting: ['Jules', 'Sam'], you: { name: 'Ada' } });
  assert.deepEqual(saved.expecting, [], 'other people’s names are not written to anybody’s phone');
  assert.equal(storable('/api/trips/t1/group', { participants: [] }), null, 'the organiser’s view is a live read');
});

test('which sources are ours to keep', () => {
  assert.equal(isOpenSource('osm:node/1'), true);
  assert.equal(isOpenSource('fixtures:1'), true);
  assert.equal(isOpenSource('google:places/X'), false);
  assert.equal(isOpenSource('tripadvisor:123'), false);
  assert.equal(isOpenSource(null), false);
  assert.equal(isOpenSource(undefined), false);
});

test('a body that is not an object is never saved', () => {
  for (const body of [null, undefined, 'text', 42]) {
    assert.equal(storable('/api/household', body), null);
  }
});

// --- what may wait on the device to be sent ---------------------------------

test('a read is never queued', () => {
  for (const path of ['/api/household', '/api/visits', '/api/trips']) {
    assert.equal(queueable('GET', path), false);
    assert.equal(queueable('HEAD', path), false);
  }
});

test('what the household said about a place waits, because it still means it', () => {
  assert.equal(queueable('POST', '/api/visits'), true);
  assert.equal(queueable('PUT', '/api/visits/v1/takes'), true);
  assert.equal(queueable('PATCH', '/api/household'), true);
  assert.equal(queueable('DELETE', '/api/household/members/m1'), true);
  assert.equal(queueable('POST', '/api/atlas/places'), true);
  assert.equal(queueable('POST', '/api/orders'), true);
  assert.equal(queueable('PATCH', '/api/trips/t1/stops/s1'), true);
  assert.equal(queueable('POST', '/api/join/tok/items/i1'), true, 'a participant with no signal');
});

test('anything bound to a session that expires is not queued', () => {
  // A planning session lives ten hours; replaying one later is at best a 404,
  // and at worst a plan built from ideas that have been thrown away.
  assert.equal(queueable('POST', '/api/plan'), false);
  assert.equal(queueable('POST', '/api/plan/preview'), false);
  assert.equal(queueable('POST', '/api/plan/abc/refine'), false);
  assert.equal(queueable('POST', '/api/session'), false, 'signing in needs the API by definition');
  assert.equal(queueable('POST', '/api/join/tok'), false, 'joining returns the token the device needs');
});

test('a search run late is a different search', () => {
  assert.equal(queueable('POST', '/api/trips/t1/shortlist/search'), false);
  assert.equal(queueable('GET', '/api/trips/t1/shortlist/search/stream'), false);
  assert.equal(queueable('POST', '/api/discover'), false);
  assert.equal(queueable('POST', '/api/menu/read'), false);
});

test('a path nobody has thought about is not queued', () => {
  assert.equal(queueable('POST', '/api/something/new'), false);
});

test('the query string does not change the answer', () => {
  assert.equal(queueable('PATCH', '/api/household?x=1'), true);
  assert.equal(queueable('POST', '/api/plan/preview?live=1'), false);
});

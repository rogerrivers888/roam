/**
 * Every address Roam has, read and written — src/routes.ts.
 *
 * This is the file that decides what a link means, so it is the file where a
 * mistake is silent and expensive: a shape that parses one way and writes back
 * another gives the same page two addresses, and a legacy address that stops
 * being answered breaks a link somebody was sent.
 *
 * So every route is walked both ways, and the old `?tab=` addresses — which the
 * owner keeps on his phone, and which went out in group invites — are pinned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hrefOf, legacyHref, parseRoute, paths, parentOf, tabOf, titleOf } from '../src/routes.ts';

/** Read it, write it back, and get the same address. */
const roundTrip = (href: string, expected?: string) => {
  const route = parseRoute(href);
  assert.equal(hrefOf(route), expected ?? href, `${href} did not come back as itself`);
  return route;
};

// --- every page ------------------------------------------------------------

test('the home screen', () => {
  assert.deepEqual(parseRoute('/'), { name: 'inspire', searching: false, shelf: null });
  assert.deepEqual(parseRoute('/inspire'), { name: 'inspire', searching: false, shelf: null });
  roundTrip('/inspire');
});

test('one layer into Inspire: the search, and a shelf opened out', () => {
  assert.deepEqual(roundTrip('/inspire/search'), { name: 'inspire', searching: true, shelf: null });
  assert.deepEqual(roundTrip('/inspire/culture'), { name: 'inspire', searching: false, shelf: 'culture' });
  assert.equal(paths.inspireShelf('adrenaline'), '/inspire/adrenaline');
});

test('Food is a door into Places, so it is not a shelf and has no address', () => {
  assert.equal(parseRoute('/inspire/food').name, 'unknown');
});

test('Places: the atlas, close to home, and one city', () => {
  assert.deepEqual(roundTrip('/places'), { name: 'places', scope: null });
  assert.deepEqual(roundTrip('/places/home'), { name: 'places', scope: { home: true } });
  assert.deepEqual(roundTrip('/places/GB/London'), { name: 'places', scope: { country: 'GB', city: 'London' } });
});

test('a city with a space in its name survives the round trip', () => {
  const href = paths.placesCity('GB', 'Lake District');
  assert.equal(href, '/places/GB/Lake%20District');
  assert.deepEqual(parseRoute(href), { name: 'places', scope: { country: 'GB', city: 'Lake District' } });
  assert.equal(hrefOf(parseRoute(href)), href);
});

test('a country on its own is the atlas, not a page of its own', () => {
  assert.deepEqual(parseRoute('/places/GB'), { name: 'places', scope: null });
});

test('Trips: the list, the form, a trip, a trip’s tab, and one day of it', () => {
  assert.deepEqual(roundTrip('/trips'), { name: 'trips', creating: false, tripId: null, section: null, dayId: null });
  assert.deepEqual(roundTrip('/trips/new'), { name: 'trips', creating: true, tripId: null, section: null, dayId: null });
  assert.deepEqual(roundTrip('/trips/abc'), { name: 'trips', creating: false, tripId: 'abc', section: null, dayId: null });
  assert.deepEqual(roundTrip('/trips/abc/shortlist'), { name: 'trips', creating: false, tripId: 'abc', section: 'shortlist', dayId: null });
  assert.deepEqual(roundTrip('/trips/abc/day/d1'), { name: 'trips', creating: false, tripId: 'abc', section: 'day', dayId: 'd1' });
});

test('a day identifier only means anything under the day tab', () => {
  // /trips/abc/stay/d1 would be a shape with no meaning; the day is dropped
  // rather than remembered somewhere it can never be used.
  assert.equal(parseRoute('/trips/abc/stay/d1').name, 'trips');
  assert.equal((parseRoute('/trips/abc/stay/d1') as any).dayId, null);
  assert.equal(paths.trip('abc', 'stay', 'd1'), '/trips/abc/stay');
});

test('a trip tab nobody has heard of is not a page', () => {
  assert.equal(parseRoute('/trips/abc/elsewhere').name, 'unknown');
});

test('Household, Settings, Prototypes and the back office', () => {
  assert.deepEqual(roundTrip('/household'), { name: 'household', memberId: null });
  assert.deepEqual(roundTrip('/household/m1'), { name: 'household', memberId: 'm1' });
  assert.deepEqual(roundTrip('/settings'), { name: 'settings', section: 'preferences' });
  assert.deepEqual(roundTrip('/settings/providers'), { name: 'settings', section: 'providers' });
  assert.deepEqual(roundTrip('/prototypes'), { name: 'prototypes', section: null });
  assert.deepEqual(roundTrip('/prototypes/trips'), { name: 'prototypes', section: 'trips' });
  assert.deepEqual(roundTrip('/admin/reporting'), { name: 'admin', screen: 'reporting' });
  assert.deepEqual(parseRoute('/admin'), { name: 'admin', screen: 'overview' });
});

test('an invite link is its own page and never a query on somebody else’s', () => {
  assert.deepEqual(roundTrip('/join/tok123'), { name: 'join', token: 'tok123' });
  assert.equal(paths.join('a/b'), '/join/a%2Fb');
  assert.deepEqual(parseRoute('/join/a%2Fb'), { name: 'join', token: 'a/b' });
});

test('an address with no page behind it says so rather than pretending', () => {
  for (const path of ['/nowhere', '/settings/money', '/plan/extra', '/prototypes/nothing']) {
    assert.equal(parseRoute(path).name, 'unknown', `${path} should not resolve to a page`);
  }
});

test('the query is never part of which page it is', () => {
  assert.deepEqual(parseRoute('/places/GB/London?kind=eat&sort=recent'), { name: 'places', scope: { country: 'GB', city: 'London' } });
  assert.deepEqual(parseRoute('/inspire/culture?travel=30'), { name: 'inspire', searching: false, shelf: 'culture' });
});

// --- the links that already exist ------------------------------------------

test('the addresses Roam used to have still land somewhere', () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.equal(legacyHref('/', q('tab=places')), '/places');
  assert.equal(legacyHref('/', q('tab=trips')), '/trips');
  assert.equal(legacyHref('/', q('tab=trips&trip=abc')), '/trips/abc');
  assert.equal(legacyHref('/', q('tab=trips&trip=abc&section=group')), '/trips/abc/group');
  assert.equal(legacyHref('/', q('tab=plan')), '/plan');
  assert.equal(legacyHref('/', q('join=tok')), '/join/tok');
});

test('a magic link travels across the redirect rather than being dropped', () => {
  assert.equal(legacyHref('/', new URLSearchParams('tab=places&signin=abc')), '/places?signin=abc');
});

test('an address that is already the new shape is left alone', () => {
  assert.equal(legacyHref('/trips/abc', new URLSearchParams('tab=places')), null);
  assert.equal(legacyHref('/', new URLSearchParams('')), null);
  assert.equal(legacyHref('/', new URLSearchParams('signin=abc')), null);
});

// --- what the shell needs from a route -------------------------------------

test('every route knows which tab it lights up', () => {
  assert.equal(tabOf(parseRoute('/trips/abc/day/d1')), 'trips');
  assert.equal(tabOf(parseRoute('/places/home')), 'places');
  assert.equal(tabOf(parseRoute('/admin/audit')), null);
  assert.equal(tabOf(parseRoute('/join/x')), null);
});

test('Back has somewhere to go for somebody who arrived on a shared link', () => {
  assert.equal(parentOf(parseRoute('/trips/abc/day/d1')), '/trips/abc/day');
  assert.equal(parentOf(parseRoute('/trips/abc/shortlist')), '/trips/abc');
  assert.equal(parentOf(parseRoute('/trips/abc')), '/trips');
  assert.equal(parentOf(parseRoute('/places/GB/London')), '/places');
  assert.equal(parentOf(parseRoute('/household/m1')), '/household');
  assert.equal(parentOf(parseRoute('/admin/audit')), '/admin/overview');
});

test('a window of Roam tabs is not seven identical ones', () => {
  assert.equal(titleOf(parseRoute('/places/GB/London')), 'London · Roam');
  assert.equal(titleOf(parseRoute('/inspire/culture')), 'Culture · Roam');
  assert.equal(titleOf(parseRoute('/nowhere')), 'Not a page · Roam');
});

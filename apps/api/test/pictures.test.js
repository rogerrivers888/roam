/**
 * The picture ladder's arithmetic and its refusals.
 *
 * Owner, 5 Sep 2026, on the delivery apps' one food photo per restaurant: "The
 * only other option is to use generic images (a huge bank) and just mix and
 * match them for all the different restaurants, but that's a bit misleading."
 *
 * Three things below are silent failures if they regress, which is why they are
 * pinned here rather than left to be noticed on a screen:
 *
 *   * A street-level frame that is near a restaurant but pointing away from it
 *     is a photograph of the road. If `scoreFrame` stops rejecting those, every
 *     card quietly fills with tarmac and nothing errors.
 *   * A logo taken from a venue's Instagram page is Instagram's mark, and two
 *     restaurants get the same picture — exactly what the owner objected to. It
 *     happened, to Harpers and Nón Cafe & Kitchen, before the blocklist existed.
 *   * A picture whose bytes are not an image at all — a 404 page served as
 *     `image/jpeg`, which is common — must not be stored as one.
 *
 * All pure: no database, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { bearing, headingError, metresBetween, scoreFrame } = await import('../src/sources/streetLevel.js');
const { dimensions, sniff } = await import('../src/sources/pictureBytes.js');
const { LOGO_BASIS } = await import('../src/sources/logo.js');

// A restaurant on the north side of a street running east–west.
const VENUE = { lat: 51.48400, lng: -0.60440 };
/** A camera `m` metres west of the venue on the road, pointing `heading`. */
const camera = (metresWest, heading, extra = {}) => ({
  lat: VENUE.lat - 0.00018,                       // ~20m south: the road
  lng: VENUE.lng - metresWest / 69_500,           // metres → degrees at this latitude
  heading, width: 3000, shotAt: Date.now() - 365 * 24 * 3600 * 1000, ...extra,
});

test('the maths agrees with the compass', () => {
  assert.equal(Math.round(bearing({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })), 0, 'due north');
  assert.equal(Math.round(bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })), 90, 'due east');
  // The short way round, not the long way: 350° and 10° are twenty degrees apart.
  assert.equal(headingError(350, 10), 20);
  assert.equal(headingError(10, 350), 20);
  assert.ok(Math.abs(metresBetween({ lat: 51.484, lng: -0.6044 }, { lat: 51.485, lng: -0.6044 }) - 111) < 3);
});

test('a frame pointing away from the restaurant is not a picture of it', () => {
  // Driving east, twenty-five metres short of it: the venue is ahead and a
  // little left, which is in shot.
  assert.ok(scoreFrame(camera(25, 75), VENUE) > 0, 'approaching, looking at it');
  // The same spot, driving west: the venue is behind the camera.
  assert.equal(scoreFrame(camera(25, 255), VENUE), null, 'driving away from it');
  // Alongside it, pointing up the road: the front of the building is off to one
  // side, outside the lens. This is the common case and the one that matters.
  assert.equal(scoreFrame(camera(2, 90), VENUE), null, 'level with it, looking up the road');
});

test('among frames that are looking at it, nearer and newer wins', () => {
  const near = scoreFrame(camera(22, 70), VENUE);
  const far = scoreFrame(camera(58, 78), VENUE);
  assert.ok(near > far, 'a frame from across the junction is worse than one from the kerb');

  const fresh = scoreFrame(camera(25, 75, { shotAt: Date.now() - 200 * 24 * 3600 * 1000 }), VENUE);
  const stale = scoreFrame(camera(25, 75, { shotAt: Date.now() - 7 * 365 * 24 * 3600 * 1000 }), VENUE);
  assert.ok(fresh > stale, 'a restaurant that closed in 2019 is not what to show');
});

test('a frame with no heading is unusable, however close it is', () => {
  assert.equal(scoreFrame({ ...camera(10, 75), heading: null }, VENUE), null);
  assert.equal(scoreFrame({ lat: null, lng: null, heading: 75 }, VENUE), null);
});

test('bytes are believed over content-types', () => {
  const html = Buffer.from('<!DOCTYPE html><title>404</title>', 'utf8');
  assert.equal(sniff(html), null, 'an error page served as image/jpeg is not an image');
  assert.equal(sniff(Buffer.alloc(4)), null, 'too short to be anything');

  // A minimal PNG header: signature, then IHDR with 180×180.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8), Buffer.from([0, 0, 0, 180, 0, 0, 0, 180]),
  ]);
  assert.equal(sniff(png), 'image/png');
  assert.deepEqual(dimensions(png, 'image/png'), { width: 180, height: 180 });
});

test('a logo is stored on a stated basis, not on a licence it does not have', () => {
  // The distinction the whole rung rests on. If this ever becomes a CC string,
  // the library is claiming a licence nobody granted.
  assert.match(LOGO_BASIS.licence, /trade mark/i);
  assert.doesNotMatch(LOGO_BASIS.licence, /\bCC\b|creativecommons/i);
  assert.equal(LOGO_BASIS.licenceUrl, null, 'there is no deed to link to');
  assert.equal(LOGO_BASIS.attributionRequired, false, 'naming the business is the credit');
  assert.match(LOGO_BASIS.restrictions, /referential/i);
});

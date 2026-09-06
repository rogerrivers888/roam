/**
 * What a device is told when a source will not answer.
 *
 * The owner, 5 Sep 2026: "I also see this on a lot of pages: Google Places 429
 * error code 429 message: 'Exceeded your metric.' I should never see that on
 * the phone app."
 *
 * So this is really one assertion made several ways: whatever a provider says,
 * what comes back is a sentence a family can read, and none of the provider's
 * own words — its metric names, its project number, its status codes — are in
 * it. The raw text still goes to the log and to `provider_calls`; it just does
 * not travel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { whySourceFailed, sourceName } from '../src/sources/why.js';

/** The real thing, as Google Places (New) sends it. */
const GOOGLE_429 = `Google Places 429: {
  "error": {
    "code": 429,
    "message": "Quota exceeded for quota metric 'GetPlaceRequest' and limit 'GetPlaceRequest per day' of service 'places.googleapis.com' for consumer 'project_number:951234567890'.",
    "status": "RESOURCE_EXHAUSTED"
  }
}`;

const LEAKS = /\b429\b|quota|metric|googleapis|project_number|RESOURCE_EXHAUSTED|status code|\{|\}/i;

test('a provider over its allowance says so in one sentence', () => {
  const said = whySourceFailed('google', new Error(GOOGLE_429));
  assert.match(said, /^Google has used up today's allowance/);
  assert.ok(!LEAKS.test(said), `provider plumbing leaked to the device: ${said}`);
});

test('none of the ways a source can fall over reach a phone in its own words', () => {
  const cases = [
    new Error(GOOGLE_429),
    new Error('Google Places 403: {"error":{"code":403,"message":"API key not valid"}}'),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    new Error('GOOGLE_MAPS_API_KEY not set'),
    new Error('fetch failed: ECONNREFUSED 142.250.187.238:443'),
    'Overpass 504',
  ];
  for (const err of cases) {
    const said = whySourceFailed('google', err);
    assert.ok(!LEAKS.test(said), `provider plumbing leaked to the device: ${said}`);
    assert.match(said, /^Google .+\.$/, `not a sentence: ${said}`);
  }
});

test('every source is called what the family calls it', () => {
  assert.equal(sourceName('osm-overpass'), 'The open map');
  assert.equal(sourceName('google-places'), 'Google');
  assert.equal(sourceName('liteapi'), 'The hotel prices');
  // An unknown key still reads as words rather than as a slug.
  assert.equal(sourceName('some-new-source'), 'some new source');
});

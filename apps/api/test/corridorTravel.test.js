// What it costs to stop somewhere on the way.
//
// A twenty-mile day out to Crystal Palace came back with one restaurant along
// the whole route and nothing at all to do (owner, 6 Sep 2026). The corridor
// was not the problem; the arithmetic underneath it was. `estimateTravelMinutes`
// changed gear at fifteen kilometres — a town speed below, an open-road speed
// above — and a detour is one journey measured as two shorter ones, so the two
// halves fell on the town side of the change while the journey they replaced
// stayed on the open side. A place standing *on the road* halfway along came
// out twenty-four minutes off it and the fifteen-minute budget threw it away.
//
// These are the numbers that must not come back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTravelMinutes, detourMinutes, kmBetween } from '../src/domain/travel.js';

const HOME = { lat: 51.38622, lng: -0.62342 };            // Fairways, Ascot
const CRYSTAL_PALACE = { lat: 51.422294, lng: -0.075789 };
const THORPE_PARK = { lat: 51.404722, lng: -0.513056 };

/** A point the given fraction of the way along the straight line between two ends. */
const along = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });

test('a place on the road costs almost nothing, wherever along it stands', () => {
  for (let f = 0.05; f < 1; f += 0.05) {
    const venue = along(HOME, CRYSTAL_PALACE, f);
    const detour = detourMinutes({ origin: HOME, destination: CRYSTAL_PALACE, venue, mode: 'driving' });
    assert.ok(
      detour <= 8,
      `a stop ${Math.round(f * 100)}% of the way along the road cost ${detour} min, which is not a detour`,
    );
  }
});

test('the drive is not measured differently either side of an arbitrary distance', () => {
  // The old model jumped from 45 minutes to 26 between 14.9km and 15.1km.
  const at = (km) => estimateTravelMinutes({ lat: 51, lng: 0 }, { lat: 51 + km / 111.32, lng: 0 }, 'driving');
  for (let km = 1; km < 60; km += 0.5) {
    assert.ok(at(km + 0.5) - at(km) >= 0, `going ${km + 0.5}km cannot be quicker than going ${km}km`);
    assert.ok(at(km + 0.5) - at(km) <= 3, `half a kilometre added ${at(km + 0.5) - at(km)} minutes at ${km}km`);
  }
});

test('a longer drive averages a faster speed, and a short hop a slower one', () => {
  const speed = (km) => (km / at(km)) * 60;
  const at = (km) => estimateTravelMinutes({ lat: 51, lng: 0 }, { lat: 51 + km / 111.32, lng: 0 }, 'driving');
  assert.ok(speed(2) < 20, `two kilometres through a town averaged ${speed(2).toFixed(1)} km/h`);
  assert.ok(speed(100) > 40, `a hundred kilometres averaged ${speed(100).toFixed(1)} km/h`);
  assert.ok(speed(100) < 70, `a hundred kilometres averaged ${speed(100).toFixed(1)} km/h, which is not driving`);
});

test('the corridor still keeps out what is not on the way', () => {
  // Chobham Common: only ten minutes extra by the arithmetic — back past the
  // house and round — but nobody calls it on the way to Thorpe Park. What keeps
  // it out is the width of the corridor, not the detour, so the width must stay
  // tight on a short journey however much it grows on a long one.
  const CHOBHAM = { lat: 51.3733, lng: -0.5867 };
  const width = (origin, destination, reachKm) => Math.min(8, Math.max(1, reachKm / 2, kmBetween(origin, destination) * 0.12));
  const offLine = (origin, destination, v) => {
    const kx = Math.cos((origin.lat * Math.PI) / 180);
    const ax = (destination.lng - origin.lng) * kx;
    const ay = destination.lat - origin.lat;
    const t = Math.max(0, Math.min(1, (ax * (v.lng - origin.lng) * kx + ay * (v.lat - origin.lat)) / (ax * ax + ay * ay)));
    return kmBetween({ lat: origin.lat + (destination.lat - origin.lat) * t, lng: origin.lng + (destination.lng - origin.lng) * t }, v);
  };
  const reach = 3.73; // driving, a fifteen-minute budget
  assert.ok(
    offLine(HOME, THORPE_PARK, CHOBHAM) > width(HOME, THORPE_PARK, reach),
    'Chobham Common is back inside the corridor to Thorpe Park',
  );
  // And Richmond Park, three and a half kilometres off a thirty-eight kilometre
  // drive, is inside the one to Crystal Palace — it was not, and that is why
  // the screen was empty.
  const RICHMOND_PARK = { lat: 51.4413, lng: -0.2749 };
  assert.ok(
    offLine(HOME, CRYSTAL_PALACE, RICHMOND_PARK) < width(HOME, CRYSTAL_PALACE, reach),
    'Richmond Park is still outside the corridor to Crystal Palace',
  );
});

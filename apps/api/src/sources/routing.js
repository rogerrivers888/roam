// Real travel times via the Google Routes API, with the distance-based
// estimate as the fallback when there is no key (domain/travel.js).
//
// Two calls are used: a route matrix for "how long from the base to each
// candidate" (one request, many elements) and a single route for the journey
// from home to the base, which also yields the polyline for search-along-route.
// Nothing is stored beyond the session; Google's terms forbid caching results.

const KEY = () => process.env.GOOGLE_MAPS_API_KEY?.trim();
const ROUTES = 'https://routes.googleapis.com';

const MODE = { driving: 'DRIVE', walking: 'WALK', cycling: 'BICYCLE', transit: 'TRANSIT' };

export const routingEnabled = () => Boolean(KEY());

async function post(path, body, fieldMask) {
  const res = await fetch(`${ROUTES}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': KEY(), 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google Routes ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
const secondsToMinutes = (s) => Math.round(Number(String(s || '0s').replace('s', '')) / 60);

/** Minutes from one origin to many destinations, in the given mode, at departAt. Null entries where no route. */
export async function travelMatrixMinutes({ origin, destinations, mode = 'driving', departAt = null }) {
  if (!KEY() || !destinations.length) return null;
  const out = new Array(destinations.length).fill(null);
  // The matrix allows up to 625 elements; keep batches small so one failure is cheap.
  for (let i = 0; i < destinations.length; i += 100) {
    const batch = destinations.slice(i, i + 100);
    const body = {
      origins: [{ waypoint: wp(origin) }],
      destinations: batch.map((d) => ({ waypoint: wp(d) })),
      travelMode: MODE[mode] || 'DRIVE',
      ...(mode === 'driving' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
      ...(departAt && new Date(departAt) > new Date() ? { departureTime: new Date(departAt).toISOString() } : {}),
    };
    const rows = await post('/distanceMatrix/v2:computeRouteMatrix', body, 'originIndex,destinationIndex,duration,distanceMeters,condition');
    for (const r of rows) {
      if (r.condition === 'ROUTE_EXISTS') out[i + r.destinationIndex] = { minutes: secondsToMinutes(r.duration), meters: r.distanceMeters ?? null };
    }
  }
  return out;
}

/** One journey: minutes, distance and the encoded polyline (for search-along-route). */
export async function routeBetween({ from, to, mode = 'driving', departAt = null }) {
  if (!KEY()) return null;
  const body = {
    origin: wp(from), destination: wp(to), travelMode: MODE[mode] || 'DRIVE',
    ...(mode === 'driving' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
    ...(departAt && new Date(departAt) > new Date() ? { departureTime: new Date(departAt).toISOString() } : {}),
    ...(mode === 'transit' ? { transitPreferences: { routingPreference: 'FEWER_TRANSFERS' } } : {}),
  };
  const data = await post('/directions/v2:computeRoutes', body, 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline');
  const r = data.routes?.[0];
  return r ? { minutes: secondsToMinutes(r.duration), meters: r.distanceMeters ?? null, encodedPolyline: r.polyline?.encodedPolyline ?? null, estimated: false } : null;
}

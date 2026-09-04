import { bump } from './meter.js';
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

/**
 * Minutes for every origin × destination pair, in the given mode, at departAt.
 * Returns rows[origin][destination], null where no route exists. Billed per
 * element, so the caller keeps the two sides small.
 */
export async function routeMatrixMinutes({ origins, destinations, mode = 'driving', departAt = null, meter = null }) {
  if (!KEY() || !origins.length || !destinations.length) return null;
  const out = origins.map(() => new Array(destinations.length).fill(null));
  // The matrix allows up to 625 elements; keep batches small so one failure is cheap.
  const perBatch = Math.max(1, Math.floor(100 / origins.length));
  for (let i = 0; i < destinations.length; i += perBatch) {
    const batch = destinations.slice(i, i + perBatch);
    bump(meter, 'google-routes', batch.length * origins.length); // billed per origin×destination element
    const body = {
      origins: origins.map((o) => ({ waypoint: wp(o) })),
      destinations: batch.map((d) => ({ waypoint: wp(d) })),
      travelMode: MODE[mode] || 'DRIVE',
      ...(mode === 'driving' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
      ...(departAt && new Date(departAt) > new Date() ? { departureTime: new Date(departAt).toISOString() } : {}),
    };
    const rows = await post('/distanceMatrix/v2:computeRouteMatrix', body, 'originIndex,destinationIndex,duration,distanceMeters,condition');
    for (const r of rows) {
      // A zero index is left out of the JSON, so both must be read as optional:
      // reading destinationIndex as undefined silently dropped every first column.
      if (r.condition === 'ROUTE_EXISTS') out[r.originIndex ?? 0][i + (r.destinationIndex ?? 0)] = { minutes: secondsToMinutes(r.duration), meters: r.distanceMeters ?? null };
    }
  }
  return out;
}

/** Minutes from one origin to many destinations. Null entries where no route. */
export async function travelMatrixMinutes({ origin, destinations, mode = 'driving', departAt = null, meter = null }) {
  const rows = await routeMatrixMinutes({ origins: [origin], destinations, mode, departAt, meter });
  return rows ? rows[0] : null;
}

/** One journey: minutes, distance and the encoded polyline (for search-along-route). */
export async function routeBetween({ from, to, mode = 'driving', departAt = null, meter = null }) {
  if (!KEY()) return null;
  bump(meter, 'google-routes');
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

/**
 * Step-by-step directions for one leg, for the trip's "Directions" drawer:
 * walking turns, driving, or public transport with the line, headsign, stops
 * and departure time. Fetched when the drawer opens, never stored.
 */
export async function directions({ from, to, mode = 'walking', departAt = null }) {
  if (!KEY()) return null;
  const body = {
    origin: wp(from), destination: wp(to), travelMode: MODE[mode] || 'WALK',
    ...(mode === 'driving' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
    ...(departAt && new Date(departAt) > new Date() ? { departureTime: new Date(departAt).toISOString() } : {}),
    ...(mode === 'transit' ? { transitPreferences: { routingPreference: 'FEWER_TRANSFERS' } } : {}),
  };
  const mask = [
    'routes.duration', 'routes.distanceMeters', 'routes.polyline.encodedPolyline',
    'routes.legs.steps.navigationInstruction.instructions', 'routes.legs.steps.distanceMeters', 'routes.legs.steps.staticDuration', 'routes.legs.steps.travelMode',
    'routes.legs.steps.transitDetails.stopDetails', 'routes.legs.steps.transitDetails.localizedValues', 'routes.legs.steps.transitDetails.headsign',
    'routes.legs.steps.transitDetails.transitLine', 'routes.legs.steps.transitDetails.stopCount',
  ].join(',');
  const data = await post('/directions/v2:computeRoutes', body, mask);
  const r = data.routes?.[0];
  if (!r) return null;
  const steps = (r.legs || []).flatMap((leg) => leg.steps || []).map((s) => {
    const t = s.transitDetails;
    const line = t?.transitLine;
    return {
      text: s.navigationInstruction?.instructions ?? (t ? `${line?.vehicle?.name?.text ?? 'Transit'} towards ${t.headsign ?? ''}`.trim() : ''),
      minutes: secondsToMinutes(s.staticDuration), meters: s.distanceMeters ?? null, travelMode: (s.travelMode || 'WALK').toLowerCase(),
      transit: t ? {
        line: line?.nameShort || line?.name || null, agency: line?.agencies?.[0]?.name ?? null, vehicle: line?.vehicle?.name?.text ?? null, color: line?.color ?? null, textColor: line?.textColor ?? null,
        headsign: t.headsign ?? null, stopCount: t.stopCount ?? null,
        from: t.stopDetails?.departureStop?.name ?? null, to: t.stopDetails?.arrivalStop?.name ?? null,
        departs: t.localizedValues?.departureTime?.time?.text ?? null, arrives: t.localizedValues?.arrivalTime?.time?.text ?? null,
      } : null,
    };
  });
  return { minutes: secondsToMinutes(r.duration), meters: r.distanceMeters ?? null, encodedPolyline: r.polyline?.encodedPolyline ?? null, steps, estimated: false };
}

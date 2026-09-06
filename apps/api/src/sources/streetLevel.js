// The shopfront, photographed from the street by somebody who let us keep it.
//
// This is the rung that makes the ladder work outside the chains. A restaurant
// with no Wikipedia article, no Wikidata item and a website built on a template
// still has a front door, and somebody has almost certainly driven past it with
// a camera on the dashboard and published the frame under a licence that lets
// anyone republish it.
//
//   KartaView    CC BY-SA 4.0, no key, no account, no bill. Formerly
//                OpenStreetCam; the API still answers on the old host.
//   Mapillary    CC BY-SA 4.0, and much better coverage — but it needs an
//                access token. The token is free and does not bill, but a token
//                is a secret, secrets come from Doppler, and adding one is the
//                owner's to do (CLAUDE.md). So this file uses Mapillary when
//                MAPILLARY_TOKEN is set and simply does not when it is not.
//
// The hard part is not fetching a picture near a point. It is fetching one that
// is *looking at* the place. A dashcam frame taken six metres away pointing up
// the road shows tarmac; the same drive twenty metres earlier, pointing across
// the junction, shows the front of the restaurant. Every frame carries the
// camera's compass heading, so the test is whether the bearing from the camera
// to the venue falls inside the lens — which is arithmetic, and is most of what
// is below.
//
// Nothing here is a provider call in the sense `provider_calls` means: no key,
// no bill, no per-call cost to the household. It is somebody else's bandwidth,
// so it is paced and bounded like every other open source in this directory.

import { fetchPicture } from './pictureBytes.js';

const KARTAVIEW = 'https://api.openstreetcam.org/2.0/photo/';
const MAPILLARY = 'https://graph.mapillary.com/images';
const TIMEOUT_MS = 9000;

// How far away a frame may have been taken. Beyond this the building is a
// smudge behind traffic; the useful band is roughly 8–35m and the scoring
// below prefers it.
const MAX_METRES = 60;
const IDEAL_MIN = 8;
const IDEAL_MAX = 35;
// Half the horizontal field of view of a typical dashcam or phone (KartaView's
// own camera parameters report ~62° horizontal), plus margin for GPS drift on
// the camera position. A frame whose heading is further off than this than the
// venue is not pointing at it.
const HALF_FOV_DEG = 38;
// A frame from 2013 shows a restaurant that closed in 2015. Newer is better and
// this is where "newer" stops being worth much more.
const FRESH_YEARS = 8;

export const KARTAVIEW_LICENCE = {
  licence: 'CC BY-SA 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  usageTerms: 'Street-level imagery published by KartaView contributors under CC BY-SA 4.0. May be kept and republished with the credit and a link to the source.',
  attributionRequired: true,
};
export const MAPILLARY_LICENCE = {
  licence: 'CC BY-SA 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  usageTerms: 'Street-level imagery published by Mapillary contributors under CC BY-SA 4.0. May be kept and republished with the credit and a link to the source.',
  attributionRequired: true,
};

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Metres between two points, near enough at these distances. */
export function metresBetween(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat = toRad((a.lat + b.lat) / 2);
  const x = dLng * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/** Compass bearing from one point to another, 0–360, north is 0. */
export function bearing(from, to) {
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(to.lat));
  const x = Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat))
    - Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The smaller of the two ways round the compass between two headings. */
export function headingError(heading, target) {
  const d = Math.abs(((heading - target + 540) % 360) - 180);
  return d;
}

/**
 * How good a frame is for one venue, or null if it is no good at all.
 *
 * Three things in order of weight: is the venue actually in shot, is the camera
 * a sensible distance away, and how old is it. A frame that fails the first
 * test is discarded rather than scored down — a photograph of the road outside
 * a restaurant is not a worse picture of the restaurant, it is not one.
 */
export function scoreFrame(frame, venue, now = Date.now()) {
  if (frame.lat == null || frame.lng == null || frame.heading == null) return null;
  const away = metresBetween(frame, venue);
  if (away > MAX_METRES || away < 1) return null;
  const err = headingError(frame.heading, bearing(frame, venue));
  if (err > HALF_FOV_DEG) return null;

  // Dead ahead is best, and the score falls off to nothing at the edge of the
  // lens where the building is distorted and half out of frame.
  const aim = 1 - err / HALF_FOV_DEG;
  const range = away < IDEAL_MIN ? away / IDEAL_MIN
    : away <= IDEAL_MAX ? 1
    : Math.max(0, 1 - (away - IDEAL_MAX) / (MAX_METRES - IDEAL_MAX));
  const years = frame.shotAt ? (now - frame.shotAt) / (365.25 * 24 * 3600 * 1000) : FRESH_YEARS;
  const fresh = Math.max(0, 1 - years / FRESH_YEARS);
  // A bigger original is a sharper card. Worth a little, not much.
  const size = Math.min(1, (frame.width ?? 1600) / 4000);
  return aim * 0.45 + range * 0.25 + fresh * 0.22 + size * 0.08;
}

async function getJson(url, { timeout = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

const stamp = (s) => { const t = Date.parse(String(s ?? '').replace(' ', 'T')); return Number.isFinite(t) ? t : null; };

/** KartaView's frames near a point, in the shape `scoreFrame` wants. */
async function kartaviewFrames({ lat, lng }) {
  const url = `${KARTAVIEW}?lat=${lat}&lng=${lng}&radius=${MAX_METRES}&itemsPerPage=60&page=1`;
  const json = await getJson(url);
  const rows = json?.result?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    // A 360° frame is stored equirectangular: cropping the right part of it out
    // needs a reprojection this API cannot do, and shown whole it is a smear.
    .filter((r) => (r.projection ?? 'PLANE') === 'PLANE' && String(r.isWrapped ?? '0') !== '1')
    .map((r) => ({
      source: 'kartaview',
      id: String(r.id),
      lat: Number(r.lat), lng: Number(r.lng),
      heading: r.heading == null ? null : Number(r.heading),
      width: Number(r.width) || null, height: Number(r.height) || null,
      shotAt: stamp(r.shotDate ?? r.dateAdded),
      // The large thumbnail, not the original: the original is a 4000px dashcam
      // frame of several megabytes and the card draws it at 56px.
      imageUrl: r.fileurlLTh ?? r.imageLthUrl ?? r.fileurlTh ?? null,
      sourcePageUrl: r.sequenceId != null ? `https://kartaview.org/details/${r.sequenceId}/${r.sequenceIndex ?? 0}` : 'https://kartaview.org/',
      creator: 'KartaView contributors',
      creatorUrl: 'https://kartaview.org/',
      ...KARTAVIEW_LICENCE,
      creditLine: 'KartaView contributors (CC BY-SA 4.0)',
    }))
    .filter((f) => f.imageUrl);
}

/**
 * Mapillary's frames near a point. Only when a token exists.
 *
 * `compass_angle` is the corrected heading; `computed_compass_angle` is the one
 * their structure-from-motion pass produced and is better where it exists.
 */
async function mapillaryFrames({ lat, lng }) {
  const token = process.env.MAPILLARY_TOKEN;
  if (!token) return [];
  // A degree of latitude is ~111km; the box is the search radius, squared off.
  const d = MAX_METRES / 111_320;
  const dLng = d / Math.max(0.2, Math.cos(toRad(lat)));
  const fields = 'id,computed_geometry,geometry,compass_angle,computed_compass_angle,captured_at,thumb_1024_url,width,height,creator,is_pano';
  const url = `${MAPILLARY}?access_token=${encodeURIComponent(token)}&fields=${fields}&limit=60`
    + `&bbox=${lng - dLng},${lat - d},${lng + dLng},${lat + d}`;
  const json = await getJson(url);
  if (!Array.isArray(json?.data)) return [];
  return json.data
    .filter((r) => !r.is_pano)
    .map((r) => {
      const point = r.computed_geometry?.coordinates ?? r.geometry?.coordinates;
      if (!Array.isArray(point)) return null;
      const who = r.creator?.username ?? null;
      return {
        source: 'mapillary',
        id: String(r.id),
        lng: Number(point[0]), lat: Number(point[1]),
        heading: r.computed_compass_angle ?? r.compass_angle ?? null,
        width: r.width ?? null, height: r.height ?? null,
        shotAt: typeof r.captured_at === 'number' ? r.captured_at : stamp(r.captured_at),
        imageUrl: r.thumb_1024_url ?? null,
        sourcePageUrl: `https://www.mapillary.com/app/?pKey=${r.id}&focus=photo`,
        creator: who ? `${who} / Mapillary` : 'Mapillary contributors',
        creatorUrl: who ? `https://www.mapillary.com/app/user/${encodeURIComponent(who)}` : 'https://www.mapillary.com/',
        ...MAPILLARY_LICENCE,
        creditLine: `${who ?? 'Mapillary contributors'} / Mapillary (CC BY-SA 4.0)`,
      };
    })
    .filter((f) => f && f.imageUrl && f.heading != null);
}

/**
 * The best street-level photograph of one venue that we may keep, with its
 * bytes — or null when nobody has driven past it pointing the right way.
 *
 * Both sources are asked together when both are available, and the frames are
 * ranked against each other rather than one source being preferred: a Mapillary
 * frame from last year beats a KartaView one from 2014 and the other way round.
 *
 * Never throws.
 */
export async function findShopfront({ lat, lng } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { shot: null, reason: 'we do not know where it is' };
  }
  const venue = { lat, lng };
  const [karta, mapi] = await Promise.all([
    kartaviewFrames(venue).catch(() => []),
    mapillaryFrames(venue).catch(() => []),
  ]);
  const nearby = [...karta, ...mapi];

  const ranked = nearby
    .map((f) => ({ frame: f, score: scoreFrame(f, venue) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score);

  // Why it came back empty, in the words the back office prints. "Nothing
  // found" covers three completely different situations and they want three
  // different answers: nobody has driven down this street, or plenty have and
  // none was looking this way, or we found one and could not fetch it. Only the
  // second is a reason to loosen the scoring, and without this line there is no
  // way to tell which one is happening (found 6 Sep 2026, when the rung came
  // back empty 21 times out of 21 and there was nothing to look at).
  const counted = `${karta.length} KartaView, ${mapi.length} Mapillary`;
  if (!nearby.length) {
    return {
      shot: null,
      counts: { kartaview: 0, mapillary: 0, inFrame: 0 },
      reason: mapillaryReady()
        ? `nobody has driven past it with a camera — no frames within ${MAX_METRES}m`
        : `no frames within ${MAX_METRES}m, and Mapillary is switched off so only KartaView was asked`,
    };
  }
  if (!ranked.length) {
    // How close the best of them came, and from how far away. Without these two
    // numbers "none of them pointing at it" is a dead end: it cannot say whether
    // the lens window is a few degrees too tight or whether the point we hold
    // for this place is inside a building forty metres off the road, and those
    // want opposite fixes. Measuring beats picking a wider number and hoping.
    const errors = nearby
      .filter((f) => f.heading != null && Number.isFinite(f.lat) && Number.isFinite(f.lng))
      .map((f) => ({ off: headingError(f.heading, bearing(f, venue)), away: metresBetween(f, venue) }))
      .sort((a, b) => a.off - b.off);
    const best = errors[0];
    return {
      shot: null,
      counts: { kartaview: karta.length, mapillary: mapi.length, inFrame: 0 },
      bestOffDeg: best ? Math.round(best.off) : null,
      bestAwayM: best ? Math.round(best.away) : null,
      reason: best
        ? `${counted} frames near it, none pointing at it — the closest was ${Math.round(best.off)}° off from ${Math.round(best.away)}m, and the lens window is ${HALF_FOV_DEG}°`
        : `${counted} frames near it, none of them with a heading`,
    };
  }

  // Try the best few: a frame can rank well and then 404, and the second-best
  // view of the front door is still the front door.
  for (const { frame, score } of ranked.slice(0, 3)) {
    const got = await fetchPicture(frame.imageUrl);
    if (!got) continue;
    const away = Math.round(metresBetween(frame, venue));
    return {
      shot: {
        ...frame, ...got,
        score,
        metresAway: away,
        why: `a street-level frame taken ${away}m away looking at it, ${frame.source === 'mapillary' ? 'from Mapillary' : 'from KartaView'}`,
      },
      counts: { kartaview: karta.length, mapillary: mapi.length, inFrame: ranked.length },
    };
  }
  return {
    shot: null,
    counts: { kartaview: karta.length, mapillary: mapi.length, inFrame: ranked.length },
    reason: `${ranked.length} frames were looking at it and none of them could be fetched`,
  };
}

/** Whether the Mapillary rung is available, for the back office to explain itself. */
export const mapillaryReady = () => Boolean(process.env.MAPILLARY_TOKEN);

/**
 * Why the rung is off, in a sentence the back office can print.
 *
 * "Set MAPILLARY_TOKEN" is a useless thing to say to somebody who believes they
 * already did. The owner added the token on 6 Sep 2026, both Doppler syncs
 * reported In Sync, and the rung went on answering "not ready" — because the
 * secret was named `MAPILLARY_TOKE`. That took an hour to find by eye, and the
 * one process that could see both the name we want and the names that exist was
 * the one insisting nothing had been set.
 *
 * So when the exact name is missing, look for a near miss and say it out loud.
 * A near miss is any variable mentioning Mapillary that is not the name we
 * read — a truncation, a rename, an ACCESS_TOKEN, a KEY. The value is never
 * touched or reported, only the name: that is the part that is wrong, and it is
 * not the secret.
 */
export function mapillaryTrouble() {
  if (process.env.MAPILLARY_TOKEN) return null;
  const nearMiss = Object.keys(process.env)
    .filter((k) => k !== 'MAPILLARY_TOKEN' && /mapillary/i.test(k));
  if (nearMiss.length) {
    return `A secret named ${nearMiss.join(' and ')} is set, but this reads MAPILLARY_TOKEN. `
      + 'Rename it in Doppler — the value is fine, the name is one character out.';
  }
  return 'Needs MAPILLARY_TOKEN in Doppler. The token is free and does not bill, '
    + 'but it is a secret, so it is the owner\u2019s to add.';
}

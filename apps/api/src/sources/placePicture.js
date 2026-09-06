// A picture for a place, found rather than taken.
//
// Owner, 5 Sep 2026, on the delivery apps: "they have 1 photo of the food for
// each restaurant, and it just provides something swipeable… We don't even have
// logos or anything like that, so it would just be a text listing, which is
// okay but not ideal. The only other option is to use generic images… but
// that's a bit misleading."
//
// The delivery apps did not take those photographs either — the restaurant
// uploaded one during onboarding, under a contract. We have no such contract,
// so instead of one source that we would have to steal from, this walks a
// ladder of sources that are already ours to hold, and stops at the first that
// answers:
//
//   1  household   A photograph somebody in the house took at the table. Theirs,
//                  ours to keep, and the best answer there is. Nothing to fetch:
//                  if one is linked, the ladder is already finished.
//   2  logo        The mark the business publishes for other people's software
//                  to draw. Trade mark, referential use — see sources/logo.js
//                  for why that is a different question from the photographs.
//   3  wikimedia   A Commons photograph, via the venue's Wikidata item or its
//                  Wikipedia article. Rare for restaurants, common for the
//                  pubs, hotels and listed buildings among them, and the only
//                  rung that yields a real photograph of the place.
//   4  street      A frame of the shopfront from KartaView or Mapillary, CC
//                  BY-SA. What the household will actually be looking at when
//                  they walk down the street.
//   5  —           Nothing. The card draws its own identity: the category icon
//                  on a ground derived from the place itself (VenueThumb on the
//                  web). Not a stock photograph of somebody else's dinner, and
//                  not a grey box either.
//
// Rung 5 has no code here on purpose. An illustration is not an asset, it is
// drawn from the venue_ref at render time, so it never occupies a row, never
// needs a licence and can never be mistaken for a photograph of the place.
//
// What this file will not do, ever: take a photograph out of a restaurant's own
// gallery, or store one from Google, Tripadvisor, Yelp or Foursquare. Those are
// rented and stay rented (Technical Constraints §4).

import crypto from 'node:crypto';
import * as lib from '../repositories/library.js';
import * as wm from './wikimedia.js';
import { findLogo, LOGO_BASIS } from './logo.js';
import { findShopfront } from './streetLevel.js';
import { fetchPicture } from './pictureBytes.js';

/**
 * What the ladder can do, as a number.
 *
 * The same idea as own.js's RESEARCH_VERSION. Bumping it makes the sweep go
 * back to every place that was settled as "nothing found" by an older ladder,
 * so adding a rung improves the places already looked at rather than only the
 * ones claimed afterwards.
 *
 *   1  logo, Commons, street-level
 *   2  street-level that can actually answer. Version 1 shipped with Mapillary
 *      unreachable — the token was not set, and KartaView alone has 0–11 frames
 *      per 100m in the towns this is for. So the 773 places version 1 settled as
 *      "nothing we may hold" were judged by a ladder missing its widest rung,
 *      and most of them are exactly the case it exists for: an independent with
 *      no website and no encyclopedia entry, and a perfectly photographable
 *      front door.
 */
export const PICTURE_VERSION = 2;

// How long a rung that broke waits before it is tried again. A restaurant's
// website is down for an afternoon; that is not a reason to write the place off.
const BACKOFF_MIN = [30, 240, 1440, 10080];

const WIDTH = { hero: 500 };

/** Was a Commons file named on the venue's Wikidata item? */
async function wikidataImage(qid) {
  if (!/^Q\d+$/.test(String(qid ?? ''))) return null;
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json&origin=*`;
    const res = await fetch(url, { headers: { 'user-agent': wm.UA, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const claim = (await res.json())?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    return typeof claim === 'string' ? `File:${claim}` : null;
  } catch { return null; }
}

/**
 * The Commons rung: a photograph of this actual place, under a licence that
 * lets us keep it.
 *
 * Wikidata's nominated image first because somebody chose it as *the* picture
 * of the place; the article's images after, in the order the article uses them,
 * which is close enough to "most representative first" to be worth having.
 */
async function fromWikimedia({ wikidataId, wikipediaUrl }) {
  const titles = [];
  const nominated = await wikidataImage(wikidataId);
  if (nominated) titles.push(nominated);
  if (wikipediaUrl) {
    const title = decodeURIComponent(String(wikipediaUrl).split('/wiki/')[1] ?? '').replace(/_/g, ' ');
    if (title) {
      try { titles.push(...await wm.articleImages(title, { limit: 8 })); } catch { /* an article that will not list its images is not a failure */ }
    }
  }
  const unique = [...new Set(titles)].slice(0, 8);
  if (!unique.length) return null;

  let details;
  try { details = await wm.fileDetails(unique, { widths: [20, WIDTH.hero] }); } catch { return null; }

  for (const title of unique) {
    const file = details.get(title) ?? [...details.values()].find((d) => d.askedAs === title);
    // "We could not read the licence" and "it is free" are different answers,
    // and only one of them is safe (migration 036).
    if (!file?.mayStore) continue;
    const variants = [];
    for (const width of [20, WIDTH.hero]) {
      const thumb = file.thumbs[width];
      if (!thumb) continue;
      const got = await wm.fetchImage(thumb.url);
      if (!got) continue;
      variants.push({ width, actualWidth: thumb.width, actualHeight: thumb.height, mime: got.mime, bytes: got.body.length, body: got.body });
    }
    if (!variants.length) continue;
    return {
      rung: 'wikimedia',
      variants,
      why: 'a photograph of the place on Wikimedia Commons',
      asset: {
        source: 'wikimedia',
        sourceRef: file.title,
        sourcePageUrl: file.descriptionUrl,
        licence: file.licence, licenceUrl: file.licenceUrl,
        usageTerms: file.usageTerms, restrictions: file.restrictions,
        attributionRequired: file.attributionRequired,
        creator: file.creator, creatorUrl: file.creatorUrl,
        creditLine: [file.creator, file.licence].filter(Boolean).join(' · ') || file.licence,
        title: file.objectName || file.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
        caption: file.caption,
        width: file.width, height: file.height,
      },
    };
  }
  return null;
}

/** The logo rung, in the shape the writer below wants. */
async function fromLogo({ venueRef, name, website }) {
  const logo = await findLogo({ website });
  if (!logo) return null;
  // These exact bytes already being another site's mark means they are not a
  // mark at all — they are a platform's icon or a template's placeholder, and
  // showing them here would put somebody else's picture on this restaurant.
  const origin = (() => { try { return new URL(logo.sitePage).origin; } catch { return null; } })();
  const sha = crypto.createHash('sha256').update(logo.body).digest('hex');
  if (await lib.logoBelongsElsewhere(sha, origin)) return null;
  return {
    rung: 'logo',
    variants: [{ width: logo.width ?? 180, actualWidth: logo.width, actualHeight: logo.height, mime: logo.mime, bytes: logo.bytes, body: logo.body }],
    why: logo.why,
    asset: {
      source: 'logo',
      // One mark per venue. Two restaurants in a chain publish the same file and
      // it is genuinely the same picture, but they are different cards and the
      // library should be able to say which places carry it — the sha256 index
      // is what shows the duplication without the rows fighting each other.
      sourceRef: venueRef,
      sourcePageUrl: logo.sitePage,
      ...LOGO_BASIS,
      creator: name ?? null,
      creatorUrl: logo.sitePage,
      creditLine: name ? `${name} — their own mark` : 'The business’s own mark',
      title: name ? `${name} logo` : 'Logo',
      caption: null,
      width: logo.width, height: logo.height,
    },
  };
}

/** The street-level rung. */
async function fromStreet({ name, lat, lng }) {
  const shot = await findShopfront({ lat, lng });
  if (!shot) return null;
  return {
    rung: shot.source,
    variants: [{ width: shot.width ?? 1024, actualWidth: shot.width, actualHeight: shot.height, mime: shot.mime, bytes: shot.bytes, body: shot.body }],
    why: shot.why,
    asset: {
      source: shot.source,
      sourceRef: `${shot.source}:${shot.id}`,
      sourcePageUrl: shot.sourcePageUrl,
      licence: shot.licence, licenceUrl: shot.licenceUrl,
      usageTerms: shot.usageTerms, restrictions: null,
      attributionRequired: shot.attributionRequired,
      creator: shot.creator, creatorUrl: shot.creatorUrl,
      creditLine: shot.creditLine,
      title: name ? `${name} from the street` : 'Street view',
      caption: `Taken about ${shot.metresAway}m away, looking at it.`,
      width: shot.width, height: shot.height,
    },
  };
}

/**
 * Walk the ladder for one place and keep what it finds.
 *
 * `place` is a place_record, or anything carrying `venue_ref`, `name`,
 * `website`, `lat`, `lng`, `category`, `wikidata_id` and `wikipedia_url`.
 *
 * Returns `{ state, rung, tried, imageId }`. `state` is 'found' when a picture
 * is linked, 'none' when every rung was walked and none of them had anything we
 * may hold, and 'failed' when the looking itself broke — which is a different
 * thing and is retried.
 *
 * Never throws; a sweep over ten thousand places must not stop on one bad site.
 */
export async function pictureFor(place, { force = false } = {}) {
  const venueRef = place.venue_ref ?? place.venueRef;
  if (!venueRef) throw new Error('pictureFor needs a venue_ref');
  const tried = [];

  // Rung 1. A photograph somebody in the house took outranks anything we could
  // go and find, and it is already in the library — there is nothing to fetch.
  const existing = await lib.heroForPlace(venueRef);
  if (existing && !force) {
    if (existing.source === 'household' || existing.source === 'upload') {
      return { state: 'found', rung: 'household', tried: [{ rung: 'household', found: true }], imageId: existing.id };
    }
    return { state: 'found', rung: existing.source, tried: [{ rung: existing.source, found: true }], imageId: existing.id };
  }

  const name = place.name ?? null;
  const rungs = [
    ['logo', () => fromLogo({ venueRef, name, website: place.website })],
    ['wikimedia', () => fromWikimedia({ wikidataId: place.wikidata_id, wikipediaUrl: place.wikipedia_url })],
    ['street', () => fromStreet({ name, lat: Number(place.lat), lng: Number(place.lng) })],
  ];

  let broke = null;
  for (const [label, run] of rungs) {
    let found;
    try {
      found = await run();
    } catch (err) {
      // A rung that threw is not a rung that answered "nothing". Remember the
      // difference: the first is retried, the second is settled.
      tried.push({ rung: label, error: err.message });
      broke = err.message;
      continue;
    }
    if (!found) { tried.push({ rung: label, found: false }); continue; }

    const largest = found.variants[found.variants.length - 1];
    let image;
    try {
      image = await lib.saveImage({
        ...found.asset,
        mayStore: true,
        tags: [name, place.category, place.postcode, found.asset.source].filter(Boolean),
        mime: largest.mime,
        bytes: largest.bytes,
        sha256: crypto.createHash('sha256').update(largest.body).digest('hex'),
        lqip: (() => {
          const tiny = found.variants.find((v) => v.width === 20);
          return tiny ? `data:${tiny.mime};base64,${tiny.body.toString('base64')}` : null;
        })(),
      }, found.variants);
    } catch (err) {
      if (err.code === 'licence_refused') { tried.push({ rung: label, refused: err.message }); continue; }
      tried.push({ rung: label, error: err.message });
      broke = err.message;
      continue;
    }
    await lib.linkImage(image.id, { subjectType: 'place', subjectId: venueRef, role: 'hero', position: 0 });
    tried.push({ rung: label, found: true, why: found.why });
    return { state: 'found', rung: found.rung, tried, imageId: image.id, why: found.why };
  }

  return { state: broke ? 'failed' : 'none', rung: null, tried, error: broke };
}

/** When a failed pass should be tried again. */
export const retryAt = (attempts) => {
  const mins = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)];
  return new Date(Date.now() + mins * 60_000);
};

/**
 * Walk the ladder over every place that has not been looked at.
 *
 * One at a time and paced, for the same reason the atlas harvest is: the whole
 * cost of this is other people's patience — Wikimedia, KartaView, and a
 * restaurant's own server, none of whom are being paid.
 */
export async function sweepPictures({ limit = 50, pauseMs = 400, force = false, onLine, cancelled } = {}) {
  const places = await lib.placesNeedingPictures({ limit, version: PICTURE_VERSION, force });
  const counts = { looked: 0, found: 0, none: 0, failed: 0, byRung: {} };

  for (const place of places) {
    if (cancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    counts.looked += 1;
    const result = await pictureFor(place, { force });
    counts[result.state === 'found' ? 'found' : result.state] += 1;
    if (result.rung) counts.byRung[result.rung] = (counts.byRung[result.rung] || 0) + 1;
    await lib.notePlacePass(place.venue_ref, {
      state: result.state,
      rung: result.rung,
      tried: result.tried,
      error: result.error ?? null,
      version: PICTURE_VERSION,
      nextAttemptAt: result.state === 'failed' ? retryAt(place.attempts ?? 0) : null,
    });
    onLine?.(`${place.name ?? place.venue_ref}: ${result.state === 'found' ? `${result.rung} — ${result.why}` : result.state === 'none' ? 'nothing we may hold' : `failed — ${result.error}`}`);
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }

  const rungs = Object.entries(counts.byRung).map(([k, v]) => `${v} ${k}`).join(', ');
  onLine?.(`pictures: looked at ${counts.looked}, found ${counts.found}${rungs ? ` (${rungs})` : ''}, ${counts.none} with nothing, ${counts.failed} to retry`);
  return counts;
}

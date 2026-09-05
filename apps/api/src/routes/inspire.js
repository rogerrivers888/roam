/**
 * Inspire: the home screen's one read.
 *
 * The household opens Roam and is shown things to do, near home or near
 * wherever they searched, on shelves named for what a day is about — Fun, Food,
 * Culture, Adrenaline, Relaxing, Outdoors. That is a browse, not a plan: no
 * model call, no ideas written, nothing kept.
 *
 * **One pool, many shelves.** This endpoint makes exactly one place search —
 * the same 5 km look-around a trip's Find tab makes, sharing its cache entry —
 * and hands back every venue once, each carrying the moods it belongs to, how
 * long it takes to get to, and how long the household would spend there. The
 * screen then draws six shelves, filters by budget and travel time and flips
 * between moods without asking anybody anything (Requirements: options are
 * composed from one retrieved pool; adding an option must not add a call).
 *
 * **Two points, not one.** `lat`/`lng` is where we are *looking*; `from` is
 * where the family would set off from — home, unless they tapped "where I am".
 * That is what makes "35 min" true both for a park down the road and for a
 * gallery in Bath: the distance on the card is the journey they would make.
 *
 * **The home screen is ours, and makes no provider call at all.** It is served
 * from the atlas (§13.12): the top attractions of each county, researched from
 * Wikidata and Wikipedia, each with a photograph we own outright. A bounding-box
 * read of one small table, single-digit milliseconds, nothing rented in it.
 *
 * It did not start that way. It was a live 5 km look-around, and near Ascot that
 * meant 128 places, none with a photograph, forty of them suburban play areas —
 * while Ascot Racecourse sat 0.9 km away in the atlas with a picture and was not
 * on the screen at all. Neither was Legoland, Windsor Great Park or Windsor
 * Castle.
 *
 * **No food here** (owner, 5 Sep 2026): "for food, we should not show that on
 * our homepage now, and we should just show inspirational activities… if I
 * clicked on food, it would take me to the places tab and search for food."
 * Restaurants rarely have a photograph anybody may republish, so a Food shelf
 * on a screen made of pictures is a row of grey rectangles. The chip is a
 * doorway into Places instead, and the atlas holds no restaurants by design.
 *
 * `live=1` puts the old look-around back alongside the atlas, for a "see
 * everything around here" that is a deliberate tap rather than the front door.
 * It is the only thing here that costs a provider call.
 *
 * Nothing here goes on a device. The answer carries a provider's names, photos
 * and ratings, which are rented (Technical Constraints §4), so this path is
 * absent from `offline/policy.ts` and is therefore never written to IndexedDB.
 * The atlas half *could* travel — it is CC0 and CC BY-SA and ours to keep — but
 * it arrives here mixed with the rented half, and a rule that has to separate
 * them per item is a rule that will one day separate them wrongly. It is served
 * whole from `/api/atlas/regions/:slug`, which is where the device gets it.
 */

import { Router } from 'express';
import { currentHousehold, loadMembers, toAttendees } from './household.js';
import { householdStatus } from './places.js';
import { thingsAround, THINGS_RADIUS_KM } from './plan.js';
import { estimateTravelMinutes, kmBetween, TRAVEL_MODES } from '../domain/travel.js';
import { dwellFor } from '../domain/options.js';
import { MOODS, moodsFor, moodsForAtlas } from '../domain/moods.js';
import { rules as shelfRules } from '../repositories/shelfRules.js';
import { publishedNear, heroesForPlaces } from '../repositories/library.js';
import { enabledSources } from '../sources/index.js';

/**
 * A stored picture, in the shape a card draws.
 *
 * `credit` travels with the image and nothing else may drop it: for every
 * licence except CC0 and public domain, showing the picture without the line is
 * the licence broken. `source` is on it because a logo is not a photograph and
 * must not be drawn like one — a mark is contained on its ground, a photograph
 * fills the tile.
 */
const ownedImage = (row) => (row ? {
  id: row.id,
  source: row.source,
  lqip: row.lqip,
  credit: row.credit_line,
  licence: row.licence,
  licenceUrl: row.licence_url,
  sourceUrl: row.source_page_url,
  creditRequired: row.attribution_required,
} : null);

export const inspire = Router();

/** "51.38,-0.62" → a point, or null. */
function point(text) {
  const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * A place worth ranking above another: what the sources think of it, damped by
 * how many people said so, so one five-star review does not beat a thousand
 * four-star ones. Sources with no ratings at all (OpenStreetMap) fall through
 * to distance, which is the only honest ordering left.
 */
const weight = (v) => (v.rating ?? 0) * Math.log10((v.ratingCount ?? 0) + 2);

/**
 * How far out the atlas reaches, unless asked otherwise (`?km=`).
 *
 * Much further than the live look-around's 5 km, and deliberately: a family
 * will drive half an hour to a castle and will not drive half an hour to a
 * playground. Sixty kilometres is about an hour, which is the default on the
 * screen's own travel-time chip — so the pool is wide enough that narrowing it
 * there means something, and distance costs nothing when the answer is a
 * bounding-box read of our own table rather than a provider call.
 */
const ATLAS_RADIUS_KM = 60;
const ATLAS_MAX_KM = 100;
/**
 * How many to hand over. Everything within reach rather than a page: these are
 * our own rows, they are small, and paginating our own table so a household can
 * scroll is a round trip bought for nothing.
 */
const ATLAS_LIMIT = 250;

/**
 * The credit a picture and a rating travel with. Sources hand this over as a
 * line of text or as a list of them, so both shapes end as a list — a card that
 * shows the content and not the credit is the licence broken.
 */
function attributionOf(v, lines) {
  // A merged venue carries the readable line already; an unmerged one carries
  // the keys of the sources that contributed, which the registry names.
  if (v.attributionText) return String(v.attributionText).split(' · ').filter(Boolean);
  const keys = v.contributingSources ?? (Array.isArray(v.attribution) ? v.attribution : [v.source]);
  return [...new Set(keys.map((k) => lines[k]).filter(Boolean))];
}

/**
 * GET /api/inspire/near?lat=&lng=&label=&locality=&from=lat,lng&mode=driving&live=1
 *
 * Things to do around a point, on shelves. `from` defaults to the household's
 * home; `mode` to how they usually travel.
 *
 * The answer says which pools are in it (`pools`) rather than leaving the screen
 * to infer it from a thin shelf. `live=1` adds the OpenStreetMap look-around and
 * is the only form that spends anything.
 */
inspire.get('/near', async (req, res, next) => {
  try {
    const started = Date.now();
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const home = household.home_lat != null
      ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng }
      : null;

    const centre = point(`${req.query.lat},${req.query.lng}`) ?? home;
    if (!centre) {
      return res.status(400).json({
        error: 'where_required',
        message: 'Search for a town, or set your home address in Household, and Roam will look around it.',
      });
    }
    // Where the family sets off from. "Where I am" hands over a fix; otherwise
    // it is home, and a household that has not set one measures from the middle
    // of the search — every card then reads 0 min, which is at least true.
    const given = point(req.query.from);
    const origin = given
      ? { ...given, label: null, how: 'given' }
      : home
        ? { ...home, how: 'home' }
        : { ...centre, label: null, how: 'centre' };
    const mode = TRAVEL_MODES.includes(req.query.mode) ? req.query.mode : 'driving';
    const label = String(req.query.label || '').trim() || household.home_label || null;
    const locality = req.query.locality ? String(req.query.locality) : null;

    // The atlas alone unless somebody deliberately asks for more. `owned=1` is
    // kept as the older spelling of the same default so a client that still
    // sends it is not surprised.
    const live = req.query.live === '1' || req.query.live === 'true';
    // How far a day out may be. Capped, because the query is a bounding box and
    // "everywhere" is not a search.
    const reach = Math.min(ATLAS_MAX_KM, Math.max(1, Number(req.query.km) || ATLAS_RADIUS_KM));
    const { venues, cached } = live
      ? await thingsAround({ household, session: null, place: { ...centre, locality } })
      : { venues: [], cached: true };

    // Around this place, and only around it. A source is free to answer with
    // whatever its index matched, and the fixture set ignores the point it was
    // given entirely, so the ring is enforced here rather than trusted.
    const around = venues
      .filter((v) => v.lat != null && v.lng != null && kmBetween(centre, v) <= THINGS_RADIUS_KM + 1)
      .sort((a, b) => weight(b) - weight(a) || kmBetween(centre, a) - kmBetween(centre, b));

    // What the back office has taught about which shelf a place belongs on.
    // One small read, cached in the process, and the only thing standing
    // between "Wikidata calls this a sports venue" and "this is a day out".
    const taught = await shelfRules();

    const attendees = toAttendees(members);
    // A source states its credit either as a line or as { text, … }; the card only wants the line.
    const lines = Object.fromEntries(enabledSources({ includeOptIn: true }).map((s) => [s.key, typeof s.attribution === 'string' ? s.attribution : s.attribution?.text ?? null]));
    // The pictures we own for these places, in one statement rather than one a
    // card. A restaurant's picture is never a photograph of its food — it is
    // the mark it publishes, a Commons photograph of the building, or a
    // street-level frame of the front door (sources/placePicture.js). Anything
    // the ladder has found is here; anything it has not falls through to the
    // provider's photo and then to the card drawing its own identity.
    const ourPictures = await heroesForPlaces(around.map((v) => `${v.source}:${v.sourcePlaceId}`));

    const items = around.map((v) => ({
      venueRef: `${v.source}:${v.sourcePlaceId}`,
      source: v.source,
      name: v.name,
      category: v.category,
      moods: moodsFor(v, taught),
      experiences: v.experiences ?? [],
      cuisines: v.cuisines ?? [],
      rating: v.rating ?? null,
      ratingCount: v.ratingCount ?? null,
      priceLevel: v.priceLevel ?? null,
      goodForChildren: v.goodForChildren ?? null,
      photos: (v.photos ?? []).slice(0, 1),
      // Ours if we have one. A provider's photo still travels on `photos` and is
      // fetched at display time; this key is always present so the card has one
      // shape to draw rather than two.
      image: ownedImage(ourPictures.get(`${v.source}:${v.sourcePlaceId}`)),
      attribution: attributionOf(v, lines),
      lat: v.lat,
      lng: v.lng,
      // How far it is from the middle of the search, and how long the journey
      // to it would actually take from where the family sets off — two
      // different numbers, and the card wants the second.
      distanceKm: Number(kmBetween(centre, v).toFixed(1)),
      travelMinutes: estimateTravelMinutes(origin, v, mode),
      // Straight-line and a per-mode speed until a routing provider is paid for
      // (domain/travel.js). The screen says "about", because that is what it is.
      estimated: true,
      dwellMinutes: dwellFor(v, household, attendees).minutes,
      household: null,
    }));

    // --- the second pool: what the county is actually known for -------------
    // Deduped against the first by name and nearness, not by identifier: the
    // same castle is `osm:way/123` in one pool and `wikidata:Q456` in the other
    // and no join exists between those. Two names that match within 250 m are
    // the same place — at that distance a real coincidence would have to be a
    // second Windsor Castle in the grounds of the first.
    let atlasCount = 0;
    const nameKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const already = items.map((i) => ({ key: nameKey(i.name), lat: i.lat, lng: i.lng }));
    const seen = (a) => already.some((b) => b.key === nameKey(a.name)
      && a.lat != null && kmBetween(a, b) < 0.25);

    // Twice the OSM radius, because an attraction worth driving to is worth
    // showing from further away than a playground is. It is therefore the outer
    // edge of the whole answer, which is what `radiusKm` has to report.
    const atlas = await publishedNear({
      lat: centre.lat, lng: centre.lng, km: reach, limit: ATLAS_LIMIT,
      // The home screen is a wall of photographs; a card without one reads as
      // broken rather than as pending.
      illustratedOnly: true,
    });
    for (const a of atlas) {
      if (a.lat == null || a.lng == null) continue;
      // The box is generous at its corners; this is the honest ring.
      if (kmBetween(centre, a) > reach) continue;
      if (seen(a)) continue;
      items.push({
        // Wikidata's own identifier where there is no OpenStreetMap one, which
        // is most of the time. It is CC0, it outlives every provider we might
        // use, and it is the identifier this place already has.
        venueRef: a.osm_ref ? `osm:${a.osm_ref}` : `wikidata:${a.wikidata_id}`,
        source: 'atlas',
        name: a.name,
        category: 'attraction',
        moods: moodsForAtlas({ ref: a.osm_ref ? `osm:${a.osm_ref}` : `wikidata:${a.wikidata_id}`, category: a.category, kinds: a.kinds ?? [] }, taught),
        // What the atlas calls this place — heritage, outdoors, family, museum,
        // arts, animals, active, landmark. Its own field rather than smuggled
        // into `experiences`, which is a closed vocabulary that voice is
        // interpreted against (domain/concepts.js): putting a word in there
        // that is not one of its terms would make the set quietly no longer
        // closed, which is the sort of thing that breaks somewhere else months
        // later. The screen's "kind of thing" filter reads this.
        atlasCategory: a.category,
        experiences: [], cuisines: [],
        rating: null, ratingCount: null, priceLevel: null, goodForChildren: null,
        photos: [],
        // The picture, and the licence it is shown under. `credit` is not
        // decoration: for everything but CC0 and public domain, showing the
        // photograph without it is the licence broken (L17).
        image: a.image_id ? {
          id: a.image_id, source: 'wikimedia', lqip: a.lqip, credit: a.credit_line,
          licence: a.licence, licenceUrl: a.licence_url, sourceUrl: a.source_page_url,
          creditRequired: a.attribution_required,
        } : null,
        summary: a.summary,
        heritage: a.heritage,
        website: a.website,
        wikipediaUrl: a.wikipedia_url,
        region: a.region_name,
        attribution: [
          ...(a.image_id && a.attribution_required && a.credit_line ? [a.credit_line] : []),
          ...(a.summary ? ['Wikipedia, CC BY-SA 4.0'] : []),
          'Wikidata, CC0',
        ],
        lat: a.lat, lng: a.lng,
        distanceKm: Number(kmBetween(centre, a).toFixed(1)),
        travelMinutes: estimateTravelMinutes(origin, a, mode),
        estimated: true,
        dwellMinutes: dwellFor({ category: 'attraction', experiences: [] }, household, attendees).minutes,
        household: null,
      });
      atlasCount += 1;
    }

    // The heart on each card: whether this household has already kept, been to
    // or made a special of the place. One query for the lot.
    const status = await householdStatus(household.id, items.map((i) => i.venueRef));
    for (const item of items) item.household = status[item.venueRef] ?? null;

    const counts = Object.fromEntries(MOODS.map((m) => [m.key, items.filter((i) => i.moods.includes(m.key)).length]));

    res.json({
      place: { label, ...centre, locality },
      from: origin,
      mode,
      // The furthest anything in this answer can be, not the radius of one of
      // the two searches behind it. The screen prints this in "N places within
      // X km", and the atlas half reaches twice as far as the look-around — so
      // reporting 5 while showing Windsor Castle at 9.7 would be a plain
      // untruth on the screen.
      radiusKm: atlasCount ? reach : THINGS_RADIUS_KM,
      // What is actually in this answer. Said outright, so a screen never has to
      // work out from an empty shelf whether a pool was absent or merely quiet.
      pools: { atlas: true, live },
      moods: MOODS.map((m) => ({ ...m, count: counts[m.key] })),
      items,
      cached: Boolean(cached),
      tookMs: Date.now() - started,
      attribution: [...new Set(items.flatMap((i) => i.attribution))],
    });
  } catch (err) {
    next(err);
  }
});

export default inspire;

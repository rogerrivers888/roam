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
 * Nothing here goes on a device. The answer carries a provider's names, photos
 * and ratings, which are rented (Technical Constraints §4), so this path is
 * absent from `offline/policy.ts` and is therefore never written to IndexedDB.
 */

import { Router } from 'express';
import { currentHousehold, loadMembers, toAttendees } from './household.js';
import { householdStatus } from './places.js';
import { thingsAround, THINGS_RADIUS_KM } from './plan.js';
import { estimateTravelMinutes, kmBetween, TRAVEL_MODES } from '../domain/travel.js';
import { dwellFor } from '../domain/options.js';
import { MOODS, moodsFor } from '../domain/moods.js';
import { enabledSources } from '../sources/index.js';

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
 * GET /api/inspire/near?lat=&lng=&label=&locality=&from=lat,lng&mode=driving
 *
 * Everything around a point, on shelves. `from` defaults to the household's
 * home; `mode` to how they usually travel.
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

    const { venues, cached } = await thingsAround({ household, session: null, place: { ...centre, locality } });

    // Around this place, and only around it. A source is free to answer with
    // whatever its index matched, and the fixture set ignores the point it was
    // given entirely, so the ring is enforced here rather than trusted.
    const around = venues
      .filter((v) => v.lat != null && v.lng != null && kmBetween(centre, v) <= THINGS_RADIUS_KM + 1)
      .sort((a, b) => weight(b) - weight(a) || kmBetween(centre, a) - kmBetween(centre, b));

    const attendees = toAttendees(members);
    // A source states its credit either as a line or as { text, … }; the card only wants the line.
    const lines = Object.fromEntries(enabledSources({ includeOptIn: true }).map((s) => [s.key, typeof s.attribution === 'string' ? s.attribution : s.attribution?.text ?? null]));
    const items = around.map((v) => ({
      venueRef: `${v.source}:${v.sourcePlaceId}`,
      source: v.source,
      name: v.name,
      category: v.category,
      moods: moodsFor(v),
      experiences: v.experiences ?? [],
      cuisines: v.cuisines ?? [],
      rating: v.rating ?? null,
      ratingCount: v.ratingCount ?? null,
      priceLevel: v.priceLevel ?? null,
      goodForChildren: v.goodForChildren ?? null,
      photos: (v.photos ?? []).slice(0, 1),
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

    // The heart on each card: whether this household has already kept, been to
    // or made a special of the place. One query for the lot.
    const status = await householdStatus(household.id, items.map((i) => i.venueRef));
    for (const item of items) item.household = status[item.venueRef] ?? null;

    const counts = Object.fromEntries(MOODS.map((m) => [m.key, items.filter((i) => i.moods.includes(m.key)).length]));

    res.json({
      place: { label, ...centre, locality },
      from: origin,
      mode,
      radiusKm: THINGS_RADIUS_KM,
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

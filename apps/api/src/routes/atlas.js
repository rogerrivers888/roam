// The atlas: countries → cities → the household's places, across every trip.
//
//   GET /api/atlas                      countries and cities with counts
//   GET /api/atlas/places?country=&city=  places there: been / saved / special, with what everyone thought
//   GET /api/atlas/sketch?lat=&lng=      the map a search is drawn on while it runs
//
// Every visit, save, special or shortlist entry lands here (upsertHouseholdPlace),
// so going back somewhere makes the list longer, and a trip to that city starts
// from everything already known.

import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { reverseGeocode, geocode } from '../sources/geocode.js';
import { searchAreas } from '../sources/areas.js';
import { recallVenue } from '../sources/index.js';
import { currentHousehold } from './household.js';
import { fillWhere } from '../sources/where.js';
import { fillTaxonomy, needsTaxonomy, taxonomyKept } from '../sources/taxonomy.js';
import { countryOutline, sketchFor, SKETCH_ATTRIBUTION } from '../sources/sketch.js';

export const atlas = Router();

// Great-circle miles between a row and a point, for "close to home". Postgres
// without PostGIS: the spherical law of cosines, clamped so rounding cannot
// hand acos() a number outside its domain.
const MILES_FROM = (latParam, lngParam) => `(3958.7613 * acos(least(1, greatest(-1,
  sin(radians(${latParam})) * sin(radians(hp.lat)) + cos(radians(${latParam})) * cos(radians(hp.lat)) * cos(radians(hp.lng) - radians(${lngParam}))
))))`;

// One background fill per household at a time.
const whereRunning = new Set();
const kindOfCategory = (c) => (['restaurant', 'cafe', 'pub', 'bar'].includes(c) ? 'food' : ['attraction', 'event'].includes(c) ? 'activity' : 'other');

// Reverse-geocoding is rate-limited; nearby points share a result.
const localityCache = new Map();
async function localityFor(lat, lng) {
  if (lat == null || lng == null) return null;
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (localityCache.has(key)) return localityCache.get(key);
  try {
    const r = await reverseGeocode(lat, lng);
    const v = r ? { country: r.country, countryCode: r.countryCode, locality: r.locality } : null;
    localityCache.set(key, v);
    return v;
  } catch { return null; }
}

/**
 * Record (or refresh) a place in the atlas. `client` may be a transaction
 * client or the pool-backed `query` wrapper ({ query }).
 */
export async function upsertHouseholdPlace(client, householdId, p) {
  const venue = p.venue ?? recallVenue(p.venueRef) ?? null;
  const category = p.category ?? venue?.category ?? null;
  const lat = p.lat ?? venue?.lat ?? null;
  const lng = p.lng ?? venue?.lng ?? null;
  let where = { country: p.country ?? null, countryCode: p.countryCode ?? null, locality: p.locality ?? null };
  if (!where.countryCode) where = (await localityFor(lat, lng)) ?? where;
  const snapshot = venue && ['osm', 'fixtures'].includes(String(p.venueRef).split(':')[0])
    ? { category: venue.category, cuisines: venue.cuisines, experiences: venue.experiences, dietaryOptions: venue.dietaryOptions, address: venue.address, website: venue.website, openingHours: venue.openingHours }
    : null;
  await client.query(
    `insert into household_places (household_id, venue_ref, label, kind, category, lat, lng, country, country_code, locality, venue, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (household_id, venue_ref) do update set
       label = case when excluded.label = excluded.venue_ref and household_places.label <> household_places.venue_ref then household_places.label else coalesce(excluded.label, household_places.label) end,
       -- The kind follows the category once one is known: a place first saved without one must not stay "other" after a visit says it is a restaurant.
       kind = case when excluded.category is not null then excluded.kind else coalesce(excluded.kind, household_places.kind) end, category = coalesce(excluded.category, household_places.category),
       lat = coalesce(excluded.lat, household_places.lat), lng = coalesce(excluded.lng, household_places.lng),
       country = coalesce(excluded.country, household_places.country), country_code = coalesce(excluded.country_code, household_places.country_code),
       locality = coalesce(excluded.locality, household_places.locality), venue = coalesce(excluded.venue, household_places.venue),
       note = coalesce(excluded.note, household_places.note), last_seen = now()`,
    [householdId, p.venueRef, p.label ?? venue?.name ?? p.venueRef, p.kind ?? kindOfCategory(category), category, lat, lng,
     where.country, where.countryCode, where.locality, snapshot ? JSON.stringify(snapshot) : null, p.note ?? null],
  );
}

/** GET /api/atlas — countries → cities with counts of places, visits and trips. */
atlas.get('/', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const { rows } = await query(
      `with p as (
         select hp.country_code, hp.country, hp.locality, hp.venue_ref, hp.last_seen,
                exists (select 1 from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as been,
                exists (select 1 from place_ledger l where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref and l.status = 'special') as special
           from household_places hp where hp.household_id = $1 and hp.country_code is not null)
       select p.country_code, p.country, p.locality,
              count(*)::int as places,
              count(*) filter (where p.been)::int as been,
              count(*) filter (where p.special)::int as special,
              (select count(*)::int from trips t where t.household_id = $1 and t.country_code = p.country_code and coalesce(t.locality, '') = coalesce(p.locality, '')) as trips,
              max(p.last_seen) as last_seen
         from p
        group by p.country_code, p.country, p.locality
        order by p.country, p.locality`,
      [household.id],
    );
    // Cities the household created on purpose, and cities its trips are in,
    // appear even before they have places.
    const [{ rows: created }, { rows: tripCities }] = await Promise.all([
      query('select country, country_code, locality, lat, lng from atlas_cities where household_id = $1', [household.id]),
      query(`select country, country_code, locality, count(*)::int as trips, max(coalesce(base_lat, origin_lat)) as lat, max(coalesce(base_lng, origin_lng)) as lng
               from trips where household_id = $1 and country_code is not null group by country, country_code, locality`, [household.id]),
    ]);
    const countries = new Map();
    const ensure = (code, name) => { if (!countries.has(code)) countries.set(code, { code, name, places: 0, been: 0, cities: [] }); return countries.get(code); };
    const cityOf = (c, name) => { let ci = c.cities.find((x) => x.name === name); if (!ci) { ci = { name, places: 0, been: 0, special: 0, trips: 0, lastSeen: null, lat: null, lng: null, created: false }; c.cities.push(ci); } return ci; };
    for (const r of rows) {
      const c = ensure(r.country_code, r.country);
      c.places += r.places; c.been += r.been;
      Object.assign(cityOf(c, r.locality ?? 'Elsewhere'), { places: r.places, been: r.been, special: r.special, trips: r.trips, lastSeen: r.last_seen });
    }
    for (const r of created) { const ci = cityOf(ensure(r.country_code, r.country), r.locality); ci.created = true; ci.lat ??= r.lat; ci.lng ??= r.lng; }
    for (const r of tripCities) { const ci = cityOf(ensure(r.country_code, r.country), r.locality ?? 'Elsewhere'); ci.trips = Math.max(ci.trips, r.trips); ci.lat ??= r.lat; ci.lng ??= r.lng; }
    // Give place-derived cities a centre from their places, for "add a place here".
    const { rows: centres } = await query('select country_code, coalesce(locality, \'Elsewhere\') as locality, avg(lat) as lat, avg(lng) as lng from household_places where household_id = $1 and lat is not null group by country_code, locality', [household.id]);
    for (const r of centres) { const c = countries.get(r.country_code); const ci = c?.cities.find((x) => x.name === r.locality); if (ci) { ci.lat ??= Number(r.lat); ci.lng ??= Number(r.lng); } }
    const { rows: unplaced } = await query('select count(*)::int as n from household_places where household_id = $1 and country_code is null', [household.id]);

    // Close to home: everything within the household's radius of the front
    // door, whichever city it files under. Not a city — a standing view.
    let home = null;
    if (household.home_lat != null && household.home_lng != null) {
      const radiusMiles = household.home_radius_miles ?? 10;
      const { rows: near } = await query(
        `select count(*)::int as places,
                count(*) filter (where exists (select 1 from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref))::int as been,
                count(*) filter (where exists (select 1 from place_ledger l where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref and l.status = 'special'))::int as special
           from household_places hp
          where hp.household_id = $1 and hp.lat is not null and hp.lng is not null and ${MILES_FROM('$2', '$3')} <= $4`,
        [household.id, household.home_lat, household.home_lng, radiusMiles],
      );
      home = { label: household.home_label, lat: household.home_lat, lng: household.home_lng, radiusMiles, ...near[0] };
    }
    res.json({ countries: [...countries.values()].sort((a, b) => b.places - a.places), unplaced: unplaced[0].n, home });
  } catch (err) { next(err); }
});

/** GET /api/atlas/places?country=GB&city=London&kind=food&status=been|saved|special */
atlas.get('/places', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { country, city, kind, status, q, nearHome } = req.query;
    const params = [household.id];
    const where = ['hp.household_id = $1'];
    // "Close to home" cuts across cities: everything within the radius, wherever it files.
    if (nearHome) {
      if (household.home_lat == null || household.home_lng == null) return res.json({ places: [], wherePending: 0 });
      params.push(household.home_lat, household.home_lng, household.home_radius_miles ?? 10);
      where.push(`hp.lat is not null and hp.lng is not null and ${MILES_FROM(`$${params.length - 2}`, `$${params.length - 1}`)} <= $${params.length}`);
    }
    if (country && !nearHome) { params.push(String(country).toUpperCase()); where.push(`hp.country_code = $${params.length}`); }
    if (city && !nearHome) { params.push(String(city)); where.push(`coalesce(hp.locality, 'Elsewhere') = $${params.length}`); }
    if (kind) { params.push(String(kind)); where.push(`hp.kind = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`(lower(hp.label) like $${params.length} or lower(coalesce(hp.note,'')) like $${params.length})`); }
    const { rows } = await query(
      `select hp.*,
              -- A label that is only the identifier (a save without context) is replaced at read time by the household's own name for the place.
              case when hp.label = hp.venue_ref then coalesce(
                (select v.venue_label from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref and v.venue_label <> hp.venue_ref order by v.created_at desc limit 1),
                (select s.venue_label from trip_shortlist s join trips t on t.id = s.trip_id where t.household_id = hp.household_id and s.venue_ref = hp.venue_ref and s.venue_label <> hp.venue_ref order by s.added_at desc limit 1),
                (select st.venue_name from trip_stops st join trips t on t.id = st.trip_id where t.household_id = hp.household_id and st.venue_ref = hp.venue_ref and st.venue_name <> hp.venue_ref order by st.created_at desc limit 1),
                hp.venue ->> 'name') end as known_label,
              (select count(*)::int from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as visits,
              (select max(v.visited_on) from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as last_on,
              (select json_agg(json_build_object('member', m.name, 'take', r.take, 'comment', r.comment, 'on', v.visited_on) order by v.visited_on desc)
                 from ratings r join visits v on v.id = r.visit_id join members m on m.id = r.member_id
                where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref and r.subject = 'visit') as takes,
              (select l.status from place_ledger l where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref and l.status in ('special','saved','dismissed') order by case l.status when 'special' then 0 when 'saved' then 1 else 2 end, l.created_at desc limit 1) as ledger,
              (select json_agg(distinct t.title) from trip_shortlist s join trips t on t.id = s.trip_id where s.venue_ref = hp.venue_ref and t.household_id = hp.household_id) as on_trips,
              -- Each person's latest score out of 5 here (owner, 3 Sep 2026: the row shows one number, mine; the drawer shows the history).
              (select json_agg(json_build_object('memberId', s.member_id, 'member', s.name, 'score', s.score, 'on', s.visited_on)) from (
                 select distinct on (r.member_id) r.member_id, m.name, r.score, v.visited_on
                   from ratings r join visits v on v.id = r.visit_id join members m on m.id = r.member_id
                  where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref and r.subject = 'visit' and r.score is not null
                  order by r.member_id, v.visited_on desc, r.created_at desc) s) as scores
         from household_places hp
        where ${where.join(' and ')}
        order by hp.kind, hp.label`,
      params,
    );
    let places = rows.map((r) => ({
      venueRef: r.venue_ref, name: r.known_label ?? r.label, unnamed: (r.known_label ?? r.label) === r.venue_ref, kind: r.category ? kindOfCategory(r.category) : r.kind, category: r.category, lat: r.lat, lng: r.lng,
      country: r.country, countryCode: r.country_code, locality: r.locality, venue: r.venue, note: r.note,
      visits: r.visits, lastOn: r.last_on, takes: r.takes ?? [], ledger: r.ledger, onTrips: (r.on_trips ?? []).filter(Boolean),
      status: r.visits > 0 ? 'been' : r.ledger === 'special' ? 'special' : 'saved',
      special: r.ledger === 'special',
      scores: r.scores ?? [],
      postcode: r.postcode ?? null, station: r.station ?? null, stationLines: r.station_lines ?? [], stationKind: r.station_kind ?? null,
      stationDistanceM: r.station_distance_m ?? null, whereChecked: r.where_checked ?? null,
      loved: (r.takes ?? []).filter((t) => t.take === 'loved').length,
      notForMe: (r.takes ?? []).filter((t) => t.take === 'not_for_me').length,
    }));
    // A licensed source's kind of place is rented, so it is never stored: what
    // has been fetched since the service started is held in memory and merged in here.
    places = places.map((p) => {
      const kinds = taxonomyKept(p.venueRef);
      return kinds ? { ...p, venue: { ...(p.venue ?? {}), cuisines: kinds.cuisines, experiences: kinds.experiences } } : p;
    });
    if (status) places = places.filter((p) => (status === 'special' ? p.special : p.status === status));
    // Where a place is, and what kind of place it is, are looked up lazily a few
    // rows per read, after the response has gone; the web asks again shortly
    // while any row is still waiting.
    const pending = rows.filter((r) => r.lat != null && r.lng != null && !r.where_checked).length
      + rows.filter(needsTaxonomy).length;
    res.json({ places, wherePending: pending });
    if (pending && !whereRunning.has(household.id)) {
      whereRunning.add(household.id);
      Promise.resolve()
        .then(() => fillWhere(household.id, rows))
        .then(() => fillTaxonomy(household.id, rows))
        .catch(() => null)
        .finally(() => whereRunning.delete(household.id));
    }
  } catch (err) { next(err); }
});


/** PATCH /api/atlas/places { venueRef, label } — name a place that was only ever held by its identifier. */
atlas.patch('/places', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { venueRef, label } = req.body || {};
    if (!venueRef || !String(label || '').trim()) return res.status(400).json({ error: 'label_required' });
    await query('update household_places set label = $3 where household_id = $1 and venue_ref = $2 and label = venue_ref', [household.id, venueRef, String(label).trim()]);
    res.json({ venueRef, label: String(label).trim() });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/atlas/places { venueRef } — take a place out of the atlas
 * (owner, 4 Sep 2026: "I need to be able to delete stuff… manage my list, and
 * curate it"). The saved and dismissed marks go with it, so it does not walk
 * back in; a visit is a fact and is kept, so somewhere the household has
 * actually been reappears rather than being quietly erased.
 */
atlas.delete('/places', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const venueRef = String(req.body?.venueRef || '').trim();
    if (!venueRef) return res.status(400).json({ error: 'venue_ref_required' });
    const { rows } = await query('select count(*)::int as n from visits where household_id = $1 and venue_ref = $2', [household.id, venueRef]);
    if (rows[0].n) return res.status(409).json({ error: 'has_visits', message: "You've been here, so it stays in your atlas. Delete the visit first if it was a mistake." });
    const [source, ...rest] = venueRef.split(':');
    await withTransaction(async (client) => {
      await client.query('delete from household_places where household_id = $1 and venue_ref = $2', [household.id, venueRef]);
      await client.query('delete from place_ledger where household_id = $1 and source = $2 and source_place_id = $3', [household.id, source, rest.join(':')]);
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

/** POST /api/atlas/cities { placeText | place } — create a city on purpose. */
atlas.post('/cities', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const b = req.body || {};
    let place = b.place?.lat != null ? b.place : null;
    // Typed rather than picked: it is still a city or a region that is wanted, so ask the source that only knows those.
    if (!place && b.placeText) [place] = await searchAreas(b.placeText, { limit: 1 });
    if (!place) return res.status(404).json({ error: 'city_not_found', message: `Couldn't find "${b.placeText}". Try the city and country, e.g. "Lisbon, Portugal".` });
    // A city search returns the city itself; its locality is its own name.
    const locality = place.locality || place.label.split(',')[0];
    if (!place.countryCode) return res.status(400).json({ error: 'country_unknown', message: 'That place has no country in the map data.' });
    // A country is not a destination (owner, 3 Sep 2026): "United Kingdom" typed here used to become a city called United Kingdom.
    if (place.country && locality.trim().toLowerCase() === String(place.country).trim().toLowerCase()) {
      return res.status(400).json({ error: 'country_not_city', message: `${place.country} is a country — type a city or a region in it, like "Bath" or "Lake District".` });
    }
    await query(
      `insert into atlas_cities (household_id, country, country_code, locality, lat, lng) values ($1,$2,$3,$4,$5,$6)
       on conflict (household_id, country_code, locality) do update set lat = coalesce(excluded.lat, atlas_cities.lat), lng = coalesce(excluded.lng, atlas_cities.lng)`,
      [household.id, place.country, place.countryCode, locality, place.lat, place.lng],
    );
    res.status(201).json({ city: { name: locality, country: place.country, countryCode: place.countryCode, lat: place.lat, lng: place.lng } });
  } catch (err) { next(err); }
});

atlas.delete('/cities', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { countryCode, locality } = req.body || {};
    await query('delete from atlas_cities where household_id = $1 and country_code = $2 and locality = $3', [household.id, countryCode, locality]);
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * GET /api/atlas/sketch?lat=&lng=&radiusKm=&country=GB
 *
 * The map a search is drawn on while it runs (owner, 4 Sep 2026; mock-up
 * /mockups/waiting-options.html): the country's coast, the named areas around
 * the point, and the ground the search covers. All of it open data and all of
 * it kept — see sources/sketch.js.
 *
 * It answers from what is stored, so it never holds a search up. The first
 * search in a new town gets the country and the one area the centre sits in;
 * the neighbours are filled in behind it and are there the next time.
 */
atlas.get('/sketch', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'point_required', message: 'lat and lng are required' });
    }
    const radiusKm = Math.min(50, Math.max(0.5, Number(req.query.radiusKm) || 3));
    let code = req.query.country ? String(req.query.country) : null;
    if (!code) code = (await localityFor(lat, lng))?.countryCode ?? null;
    const { place, areas, complete } = await sketchFor({ lat, lng, radiusKm });
    res.json({
      centre: { lat, lng }, radiusKm, place, areas, complete,
      country: countryOutline(code),
      attribution: SKETCH_ATTRIBUTION,
    });
  } catch (err) { next(err); }
});

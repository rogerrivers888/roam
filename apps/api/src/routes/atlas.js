// The atlas: countries → cities → the household's places, across every trip.
//
//   GET /api/atlas                      countries and cities with counts
//   GET /api/atlas/places?country=&city=  places there: been / saved / special, with what everyone thought
//
// Every visit, save, special or shortlist entry lands here (upsertHouseholdPlace),
// so going back somewhere makes the list longer, and a trip to that city starts
// from everything already known.

import { Router } from 'express';
import { query } from '../db.js';
import { reverseGeocode } from '../sources/geocode.js';
import { recallVenue } from '../sources/index.js';
import { currentHousehold } from './household.js';

export const atlas = Router();

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
       label = coalesce(excluded.label, household_places.label),
       kind = coalesce(excluded.kind, household_places.kind), category = coalesce(excluded.category, household_places.category),
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
    const countries = new Map();
    for (const r of rows) {
      if (!countries.has(r.country_code)) countries.set(r.country_code, { code: r.country_code, name: r.country, places: 0, been: 0, cities: [] });
      const c = countries.get(r.country_code);
      c.places += r.places; c.been += r.been;
      c.cities.push({ name: r.locality ?? 'Elsewhere', places: r.places, been: r.been, special: r.special, trips: r.trips, lastSeen: r.last_seen });
    }
    const { rows: unplaced } = await query('select count(*)::int as n from household_places where household_id = $1 and country_code is null', [household.id]);
    res.json({ countries: [...countries.values()].sort((a, b) => b.places - a.places), unplaced: unplaced[0].n });
  } catch (err) { next(err); }
});

/** GET /api/atlas/places?country=GB&city=London&kind=food&status=been|saved|special */
atlas.get('/places', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { country, city, kind, status, q } = req.query;
    const params = [household.id];
    const where = ['hp.household_id = $1'];
    if (country) { params.push(String(country).toUpperCase()); where.push(`hp.country_code = $${params.length}`); }
    if (city) { params.push(String(city)); where.push(`coalesce(hp.locality, 'Elsewhere') = $${params.length}`); }
    if (kind) { params.push(String(kind)); where.push(`hp.kind = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`(lower(hp.label) like $${params.length} or lower(coalesce(hp.note,'')) like $${params.length})`); }
    const { rows } = await query(
      `select hp.*,
              (select count(*)::int from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as visits,
              (select max(v.visited_on) from visits v where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref) as last_on,
              (select json_agg(json_build_object('member', m.name, 'take', r.take, 'comment', r.comment, 'on', v.visited_on) order by v.visited_on desc)
                 from ratings r join visits v on v.id = r.visit_id join members m on m.id = r.member_id
                where v.household_id = hp.household_id and v.venue_ref = hp.venue_ref and r.subject = 'visit') as takes,
              (select l.status from place_ledger l where l.household_id = hp.household_id and l.source || ':' || l.source_place_id = hp.venue_ref and l.status in ('special','saved','dismissed') order by case l.status when 'special' then 0 when 'saved' then 1 else 2 end, l.created_at desc limit 1) as ledger,
              (select json_agg(distinct t.title) from trip_shortlist s join trips t on t.id = s.trip_id where s.venue_ref = hp.venue_ref and t.household_id = hp.household_id) as on_trips
         from household_places hp
        where ${where.join(' and ')}
        order by hp.kind, hp.label`,
      params,
    );
    let places = rows.map((r) => ({
      venueRef: r.venue_ref, name: r.label, kind: r.kind, category: r.category, lat: r.lat, lng: r.lng,
      country: r.country, countryCode: r.country_code, locality: r.locality, venue: r.venue, note: r.note,
      visits: r.visits, lastOn: r.last_on, takes: r.takes ?? [], ledger: r.ledger, onTrips: (r.on_trips ?? []).filter(Boolean),
      status: r.visits > 0 ? 'been' : r.ledger === 'special' ? 'special' : 'saved',
      special: r.ledger === 'special',
      loved: (r.takes ?? []).filter((t) => t.take === 'loved').length,
      notForMe: (r.takes ?? []).filter((t) => t.take === 'not_for_me').length,
    }));
    if (status) places = places.filter((p) => (status === 'special' ? p.special : p.status === status));
    res.json({ places });
  } catch (err) { next(err); }
});

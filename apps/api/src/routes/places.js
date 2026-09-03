// Places the household can find, has been to, and has opinions about.
//
//   /api/places   — search the world (rented layer) and see what we think of it
//   /api/visits   — the owned record: we went, who came, what everyone thought
//
// A visit is the join between rented and owned data (Requirements §5, §8): a
// venue identifier plus a household-written label, date, attendees, note and
// takes. Everything on it survives even if the source's record goes away.

import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { searchAllSources, enabledSources, recallVenue } from '../sources/index.js';
import { geocode, reverseGeocode } from '../sources/geocode.js';
import { resolveConcept, conceptByKey } from '../domain/concepts.js';
import { kmBetween } from '../domain/travel.js';
import { currentHousehold, loadMembers } from './household.js';

export const places = Router();
export const visits = Router();

const TAKES = ['loved', 'fine', 'not_for_me'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function homeOf(household) {
  return household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null;
}

/** "near" may be "lat,lng", free text, or absent (home). */
async function resolveNear(nearParam, household) {
  const home = await homeOf(household);
  if (!nearParam) return home ? { ...home, how: 'home' } : null;
  const m = /^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/.exec(nearParam);
  if (m) return { label: nearParam, lat: Number(m[1]), lng: Number(m[3]), how: 'coords' };
  if (/^home$/i.test(nearParam.trim()) && home) return { ...home, how: 'home' };
  const [hit] = await geocode(nearParam, { limit: 1, near: home });
  return hit ? { ...hit, how: 'geocoded' } : null;
}

/** The household's relationship with a set of venue refs, in one query each. */
async function householdStatus(householdId, refs) {
  if (!refs.length) return {};
  const [{ rows: v }, { rows: l }] = await Promise.all([
    query(
      `select v.venue_ref, count(*)::int as visits, max(v.visited_on) as last_on,
              count(*) filter (where r.take = 'loved')::int as loved,
              count(*) filter (where r.take = 'not_for_me')::int as not_for_me
         from visits v left join ratings r on r.visit_id = v.id and r.subject = 'visit'
        where v.household_id = $1 and v.venue_ref = any($2)
        group by v.venue_ref`,
      [householdId, refs],
    ),
    query(
      `select distinct on (source, source_place_id) source || ':' || source_place_id as venue_ref, status
         from place_ledger where household_id = $1 and source || ':' || source_place_id = any($2)
        order by source, source_place_id, created_at desc`,
      [householdId, refs],
    ),
  ]);
  const out = {};
  for (const r of v) out[r.venue_ref] = { visits: r.visits, lastOn: r.last_on, loved: r.loved, notForMe: r.not_for_me };
  for (const r of l) out[r.venue_ref] = { ...(out[r.venue_ref] || {}), ledger: r.status };
  return out;
}

/** The concept a whole-visit take attaches to: what kind of place it was. */
function visitConcept(venue) {
  if (venue?.experiences?.length) return conceptByKey(`experience:${venue.experiences[0]}`) ?? null;
  if (venue?.cuisines?.length) {
    for (const c of venue.cuisines) {
      const hit = conceptByKey(`cuisine:${c}`) ?? resolveConcept(c, { kinds: ['cuisine'] });
      if (hit) return hit;
    }
  }
  if (venue?.category && ['pub', 'bar', 'cafe'].includes(venue.category)) return conceptByKey(`cuisine:${venue.category}`);
  return null;
}

async function writeTakes(client, visitId, takes, venue) {
  for (const t of takes || []) {
    if (!TAKES.includes(t.take)) continue;
    const subject = (t.subject || 'visit').trim();
    let concept = null;
    if (subject === 'visit') concept = visitConcept(venue);
    else concept = t.conceptKey ? conceptByKey(t.conceptKey) : resolveConcept(subject, { kinds: ['dish', 'experience'] });
    await client.query(
      `insert into ratings (visit_id, member_id, subject, take, comment, concept_key)
       values ($1, $2, $3, $4, $5, $6)`,
      [visitId, t.memberId, subject, t.take, t.comment?.trim() || null, concept?.key ?? null],
    );
  }
}

async function visitPayload(id) {
  const { rows } = await query('select * from visits where id = $1', [id]);
  if (!rows[0]) return null;
  const v = rows[0];
  const [{ rows: attendees }, { rows: takes }] = await Promise.all([
    query('select m.id, m.name from visit_attendees va join members m on m.id = va.member_id where va.visit_id = $1 order by m.name', [id]),
    query('select r.*, m.name as member_name from ratings r join members m on m.id = r.member_id where r.visit_id = $1 order by r.created_at', [id]),
  ]);
  return {
    id: v.id,
    venueRef: v.venue_ref,
    venueLabel: v.venue_label,
    category: v.category,
    lat: v.lat,
    lng: v.lng,
    visitedOn: v.visited_on,
    note: v.note,
    country: v.country,
    countryCode: v.country_code,
    locality: v.locality,
    tripId: v.trip_id,
    stopId: v.stop_id,
    attendees,
    takes: takes.map((t) => ({
      id: t.id, memberId: t.member_id, member: t.member_name, subject: t.subject, take: t.take, comment: t.comment,
      conceptKey: t.concept_key, concept: conceptByKey(t.concept_key)?.label ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// /api/places
// ---------------------------------------------------------------------------

/** GET /api/places/geocode?q=London — for pickers (home, trip location, "near"). */
places.get('/geocode', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const results = await geocode(String(req.query.q || ''), { limit: Number(req.query.limit) || 6, near: await homeOf(household) });
    await query('insert into provider_calls (household_id, provider, purpose) values ($1, $2, $3)', [household.id, 'osm-nominatim', 'places.geocode']);
    res.json({ results, attribution: '© OpenStreetMap contributors' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/places/search?q=&near=&categories=food,things&radiusKm=3
 * Real places near somewhere, with what the household already thinks of them.
 */
places.get('/search', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const near = await resolveNear(req.query.near ? String(req.query.near) : null, household);
    if (!near) return res.status(400).json({ error: 'near_required', message: 'Say where to look, or set a home address first.' });
    const categories = req.query.categories ? String(req.query.categories).split(',').filter(Boolean) : [];
    const radiusKm = Math.min(25, Number(req.query.radiusKm) || 3);
    const q = String(req.query.q || '').trim();

    const { venues, degraded, sourcesQueried } = await searchAllSources({
      center: { lat: near.lat, lng: near.lng }, radiusKm, categories, query: q, includeEvents: false,
    });
    await query('insert into provider_calls (household_id, provider, purpose) values ($1, $2, $3)', [household.id, sourcesQueried.join('+') || 'none', 'places.search']);

    const inRange = venues
      .map((v) => ({ ...v, distanceKm: Number(kmBetween(near, v).toFixed(2)) }))
      .filter((v) => v.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
    const status = await householdStatus(household.id, inRange.map((v) => `${v.source}:${v.sourcePlaceId}`));

    res.json({
      near: { label: near.label, lat: near.lat, lng: near.lng, how: near.how },
      radiusKm,
      results: inRange.slice(0, 120).map((v) => ({ ...v, venueRef: `${v.source}:${v.sourcePlaceId}`, household: status[`${v.source}:${v.sourcePlaceId}`] ?? null })),
      sourcesQueried,
      degradedSources: degraded,
      attribution: [...new Set(inRange.map((v) => v.attribution).filter(Boolean))],
    });
  } catch (err) {
    next(err);
  }
});

/** Venue refs are "source:id" and OSM ids contain a slash, so they travel as a query parameter. */
function splitRef(ref) {
  const [source, ...rest] = String(ref || '').split(':');
  return { source, id: rest.join(':') };
}

/** GET /api/places/detail?ref=osm:node/123 — one place, plus the household's history there. */
places.get('/detail', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { source, id } = splitRef(req.query.ref);
    if (!source || !id) return res.status(400).json({ error: 'ref_required' });
    const ref = `${source}:${id}`;
    const src = enabledSources().find((s) => s.key === source);
    let venue = recallVenue(ref);
    let sourceError = null;
    if (!venue && src?.get) {
      try { venue = await src.get(id); } catch (err) { sourceError = String(err?.message || err); }
    }
    const { rows } = await query('select id from visits where household_id = $1 and venue_ref = $2 order by visited_on desc', [household.id, ref]);
    const history = await Promise.all(rows.map((r) => visitPayload(r.id)));
    const status = await householdStatus(household.id, [ref]);
    res.json({ venueRef: ref, venue: venue ? { ...venue, venueRef: ref } : null, household: status[ref] ?? null, visits: history, sourceError });
  } catch (err) {
    next(err);
  }
});

/** POST /api/places/save { ref, status } — remember a place for later (or dismiss it). */
places.post('/save', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { source, id } = splitRef(req.body?.ref);
    if (!source || !id) return res.status(400).json({ error: 'ref_required' });
    const status = ['saved', 'dismissed'].includes(req.body?.status) ? req.body.status : 'saved';
    await query('insert into place_ledger (household_id, source, source_place_id, status) values ($1, $2, $3, $4)', [household.id, source, id, status]);
    res.json({ venueRef: `${source}:${id}`, status });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// /api/visits
// ---------------------------------------------------------------------------

/**
 * POST /api/visits
 * { venueRef, venueLabel, category, lat, lng, visitedOn, attendeeIds, note, clientId,
 *   venue?: {experiences,cuisines,category}, takes?: [{memberId, subject, take, comment}] , tripId?, stopId? }
 */
visits.post('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const b = req.body || {};
    if (!b.venueRef || !b.venueLabel) return res.status(400).json({ error: 'venue_required' });
    const visitedOn = b.visitedOn || new Date().toISOString().slice(0, 10);

    // Same client id twice must not make two visits (Epic 6 C5).
    if (b.clientId) {
      const { rows } = await query('select id from visits where client_id = $1', [b.clientId]);
      if (rows[0]) return res.json({ visit: await visitPayload(rows[0].id), deduplicated: true });
    }

    let where = { country: b.country ?? null, countryCode: b.countryCode ?? null, locality: b.locality ?? null };
    if (!where.countryCode && b.lat != null && b.lng != null) {
      try {
        const r = await reverseGeocode(b.lat, b.lng);
        if (r) where = { country: r.country, countryCode: r.countryCode, locality: r.locality };
      } catch { /* leave unknown */ }
    }

    const members = await loadMembers(household.id);
    const attendeeIds = (Array.isArray(b.attendeeIds) && b.attendeeIds.length ? b.attendeeIds : members.map((m) => m.id))
      .filter((id) => members.some((m) => m.id === id));

    const visitId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into visits (client_id, household_id, trip_id, stop_id, venue_ref, venue_label, category, lat, lng, visited_on, note, country, country_code, locality)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [b.clientId ?? null, household.id, b.tripId ?? null, b.stopId ?? null, b.venueRef, b.venueLabel, b.category ?? null, b.lat ?? null, b.lng ?? null,
         visitedOn, b.note?.trim() || null, where.country, where.countryCode, where.locality],
      );
      const id = rows[0].id;
      for (const memberId of attendeeIds) {
        await client.query('insert into visit_attendees (visit_id, member_id) values ($1, $2) on conflict do nothing', [id, memberId]);
      }
      await writeTakes(client, id, b.takes, b.venue ?? { category: b.category });
      const [source, ...rest] = b.venueRef.split(':');
      await client.query('insert into place_ledger (household_id, source, source_place_id, status) values ($1, $2, $3, $4)', [household.id, source, rest.join(':'), 'visited']);
      return id;
    });

    res.status(201).json({ visit: await visitPayload(visitId) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/visits?country=GB&q=&memberId=&take=loved — the household's history. */
visits.get('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { country, q, memberId, take } = req.query;
    const params = [household.id];
    const where = ['v.household_id = $1'];
    if (country) { params.push(String(country).toUpperCase()); where.push(`v.country_code = $${params.length}`); }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`(lower(v.venue_label) like $${params.length} or lower(coalesce(v.locality,'')) like $${params.length} or lower(coalesce(v.note,'')) like $${params.length})`); }
    if (memberId) { params.push(String(memberId)); where.push(`exists (select 1 from visit_attendees va where va.visit_id = v.id and va.member_id = $${params.length})`); }
    if (take && TAKES.includes(String(take))) { params.push(String(take)); where.push(`exists (select 1 from ratings r where r.visit_id = v.id and r.subject = 'visit' and r.take = $${params.length}::take)`); }

    const { rows } = await query(
      `select v.*,
              (select json_agg(json_build_object('member', m.name, 'memberId', m.id, 'take', r.take, 'comment', r.comment))
                 from ratings r join members m on m.id = r.member_id where r.visit_id = v.id and r.subject = 'visit') as visit_takes,
              (select count(*)::int from ratings r where r.visit_id = v.id and r.subject <> 'visit') as item_takes,
              (select json_agg(m.name order by m.name) from visit_attendees va join members m on m.id = va.member_id where va.visit_id = v.id) as attendees
         from visits v
        where ${where.join(' and ')}
        order by v.visited_on desc, v.created_at desc
        limit 500`,
      params,
    );
    const { rows: facets } = await query(
      `select country_code, country, count(*)::int as visits from visits where household_id = $1 and country_code is not null group by country_code, country order by visits desc`,
      [household.id],
    );
    res.json({
      visits: rows.map((v) => ({
        id: v.id, venueRef: v.venue_ref, venueLabel: v.venue_label, category: v.category, lat: v.lat, lng: v.lng,
        visitedOn: v.visited_on, note: v.note, country: v.country, countryCode: v.country_code, locality: v.locality,
        tripId: v.trip_id, attendees: v.attendees ?? [], visitTakes: v.visit_takes ?? [], itemTakes: v.item_takes,
      })),
      countries: facets.map((f) => ({ code: f.country_code, name: f.country, visits: f.visits })),
    });
  } catch (err) {
    next(err);
  }
});

visits.get('/:id', async (req, res, next) => {
  try {
    const v = await visitPayload(req.params.id);
    if (!v) return res.status(404).json({ error: 'visit_not_found' });
    res.json({ visit: v });
  } catch (err) {
    next(err);
  }
});

visits.patch('/:id', async (req, res, next) => {
  try {
    const { note, visitedOn, venueLabel } = req.body || {};
    await query(
      `update visits set note = coalesce($2, note), visited_on = coalesce($3, visited_on), venue_label = coalesce($4, venue_label) where id = $1`,
      [req.params.id, note ?? null, visitedOn ?? null, venueLabel ?? null],
    );
    res.json({ visit: await visitPayload(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/visits/:id/takes — replace what everyone thought. Body: { takes: [...], venue? } */
visits.put('/:id/takes', async (req, res, next) => {
  try {
    const { rows } = await query('select * from visits where id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'visit_not_found' });
    const venue = req.body?.venue ?? { category: rows[0].category };
    await withTransaction(async (client) => {
      await client.query('delete from ratings where visit_id = $1', [req.params.id]);
      await writeTakes(client, req.params.id, req.body?.takes, venue);
    });
    res.json({ visit: await visitPayload(req.params.id) });
  } catch (err) {
    next(err);
  }
});

visits.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from visits where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'visit_not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { visitPayload };

// The swept areas and what each sweep decided (migration 035).
//
// Nothing licensed is written from here. `scout_places` carries our own score,
// the bands it was built from and the open facts behind it; the rating and the
// review count that produced a band are folded in by the sweep and discarded
// before anything reaches this file.

import { query } from '../db.js';

export async function upsertArea(a) {
  const { rows } = await query(
    `insert into scout_areas (code, label, country_code, lat, lng, radius_km, keep, next_sweep_at)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8, now()))
     on conflict (code) do update set
       label = coalesce(excluded.label, scout_areas.label),
       lat = excluded.lat, lng = excluded.lng,
       radius_km = excluded.radius_km, keep = excluded.keep
     returning *`,
    [a.code, a.label ?? null, a.countryCode ?? 'GB', a.lat, a.lng, a.radiusKm ?? 2.5, a.keep ?? 25, a.nextSweepAt ?? null],
  );
  return rows[0];
}

export async function areaFor(code) {
  const { rows } = await query('select * from scout_areas where code = $1', [code]);
  return rows[0] ?? null;
}

export async function allAreas() {
  const { rows } = await query('select * from scout_areas order by code');
  return rows;
}

/** Areas whose turn it is. A sweep in flight is never handed out twice. */
export async function dueAreas(limit = 1) {
  const { rows } = await query(
    `select * from scout_areas
      where state <> 'sweeping' and next_sweep_at is not null and next_sweep_at <= now()
      order by next_sweep_at limit $1`,
    [limit],
  );
  return rows;
}

export async function markSweeping(code) {
  const { rows } = await query(
    `update scout_areas set state = 'sweeping', why = null where code = $1 and state <> 'sweeping' returning code`,
    [code],
  );
  return rows.length > 0;
}

export async function finishSweep(code, { state, why = null, seen = 0, chains = 0, kept = 0, nextSweepAt = null }) {
  await query(
    `update scout_areas set state = $2, why = $3, seen = $4, chains = $5, kept = $6,
            swept_at = now(), sweeps = sweeps + 1, next_sweep_at = $7
      where code = $1`,
    [code, state, why, seen, chains, kept, nextSweepAt],
  );
}

/**
 * Write one place into an area's selection, and remember the score.
 *
 * The history row is our own number over time, which is how "has this place
 * changed?" is answered without ever having held the thing that changed.
 */
export async function putPlace(areaCode, p) {
  await query(
    `insert into scout_places (area_code, venue_ref, name, rank, roam_score, owned_score, crowd_band, count_band,
                               accolades, cuisines, chain, website, lat, lng, last_seen, scored_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), now())
     on conflict (area_code, venue_ref) do update set
       name = coalesce(excluded.name, scout_places.name), rank = excluded.rank,
       roam_score = excluded.roam_score, owned_score = excluded.owned_score,
       crowd_band = excluded.crowd_band, count_band = excluded.count_band,
       accolades = excluded.accolades, cuisines = excluded.cuisines, chain = excluded.chain,
       website = coalesce(excluded.website, scout_places.website),
       lat = coalesce(excluded.lat, scout_places.lat), lng = coalesce(excluded.lng, scout_places.lng),
       last_seen = now(), scored_at = now()`,
    [areaCode, p.venueRef, p.name ?? null, p.rank, p.roamScore, p.ownedScore, p.crowdBand, p.countBand,
      JSON.stringify(p.accolades ?? []), JSON.stringify(p.cuisines ?? []), p.chain === true,
      p.website ?? null, p.lat ?? null, p.lng ?? null],
  );
  await query(
    `insert into scout_score_history (area_code, venue_ref, roam_score, owned_score, crowd_band, count_band, rank)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
    [areaCode, p.venueRef, p.roamScore, p.ownedScore, p.crowdBand, p.countBand, p.rank],
  );
}

/** Drop anything the latest sweep did not see again — it has closed, or fallen out of the cut. */
export async function pruneArea(areaCode, keepRefs) {
  const { rows } = await query(
    'delete from scout_places where area_code = $1 and not (venue_ref = any($2)) returning venue_ref',
    [areaCode, keepRefs],
  );
  return rows.map((r) => r.venue_ref);
}

/** An area's selection, best first. This is the query a search should be able to answer from. */
export async function placesIn(areaCode, limit = 50) {
  const { rows } = await query(
    `select p.*, r.address, r.postcode, r.opening_hours, r.summary, r.menu_url, r.enrich_state,
            m.item_count, m.state as menu_state, m.read_at as menu_read_at
       from scout_places p
       left join place_records r on r.venue_ref = p.venue_ref
       left join place_menus m on m.venue_ref = p.venue_ref
      where p.area_code = $1 and p.chain = false
      order by p.rank limit $2`,
    [areaCode, limit],
  );
  return rows;
}

/** How the sweep is doing, per area — the owner's figure for the dataset. */
export async function coverage() {
  const { rows } = await query(
    `select a.code, a.label, a.state, a.swept_at, a.next_sweep_at, a.seen, a.chains, a.kept, a.sweeps,
            count(p.venue_ref)::int                                            as places,
            count(r.venue_ref) filter (where r.enrich_state = 'done')::int      as researched,
            count(m.venue_ref) filter (where m.state = 'read')::int             as menus,
            count(m.venue_ref) filter (where m.state <> 'read')::int            as menus_failed,
            coalesce(sum(m.item_count) filter (where m.state = 'read'), 0)::int as dishes
       from scout_areas a
       left join scout_places p on p.area_code = a.code and p.chain = false
       left join place_records r on r.venue_ref = p.venue_ref
       left join place_menus m on m.venue_ref = p.venue_ref
      group by a.code, a.label, a.state, a.swept_at, a.next_sweep_at, a.seen, a.chains, a.kept, a.sweeps
      order by a.code`,
  );
  return rows;
}

/**
 * Menus still to read, or worth trying again.
 *
 * A place with no row at all has never been tried; a row in a state other than
 * 'read' whose backoff has come round is one the crawler could not open, and
 * every one of those is a line in the work list the owner asked to see rather
 * than an empty tab.
 */
export async function menusDue(limit = 5) {
  const { rows } = await query(
    `select p.venue_ref, coalesce(p.name, r.name) as name, coalesce(r.website, p.website) as website,
            r.menu_url, r.address, r.postcode, r.category, p.area_code
       from scout_places p
       join place_records r on r.venue_ref = p.venue_ref
       left join place_menus m on m.venue_ref = p.venue_ref
      where p.chain = false
        and r.enrich_state = 'done'
        and (m.venue_ref is null
             or (m.state not in ('read', 'found') and m.attempts < 4 and (m.next_attempt_at is null or m.next_attempt_at <= now())))
      order by p.rank limit $1`,
    [limit],
  );
  return rows;
}

/** Record that there is no menu, and why — so the empty tab has an answer in it. */
export async function recordMenuMiss(venueRef, { venueLabel = null, why, menuUrl = null, nextAttemptAt = null }) {
  await query(
    `insert into place_menus (venue_ref, venue_label, source_url, source_kind, state, why, menu_url,
                              section_count, item_count, attempts, next_attempt_at, reads)
     values ($1,$2,null,'none','none',$3,$4,0,0,1,$5,0)
     on conflict (venue_ref) do update set
       state = 'none', why = excluded.why, menu_url = coalesce(excluded.menu_url, place_menus.menu_url),
       attempts = place_menus.attempts + 1, next_attempt_at = excluded.next_attempt_at, read_at = now()`,
    [venueRef, venueLabel, why, menuUrl, nextAttemptAt],
  );
}

/** Every menu Roam could not read, with the reason. The work list. */
export async function menuMisses(limit = 100) {
  const { rows } = await query(
    `select m.venue_ref, m.venue_label, m.state, m.why, m.menu_url, m.attempts, m.read_at, r.website
       from place_menus m left join place_records r on r.venue_ref = m.venue_ref
      where m.state <> 'read' order by m.read_at desc limit $1`,
    [limit],
  );
  return rows;
}

/** The badges a venue claims on its own page. Open facts; kept for good. */
export async function putAccolades(areaCode, venueRef, accolades) {
  await query('update scout_places set accolades = $3 where area_code = $1 and venue_ref = $2',
    [areaCode, venueRef, JSON.stringify(accolades)]);
}

/**
 * We know where the menu is, even though we have not read it yet.
 *
 * Finding the address is free; reading it costs, so the two are separate states.
 * A row in 'found' is a menu the household can open on a tap and the batch
 * reader can pick up — it is emphatically not an empty tab.
 */
export async function recordMenuFound(venueRef, { venueLabel = null, menuUrl, how = null }) {
  await query(
    `insert into place_menus (venue_ref, venue_label, source_url, source_kind, state, why, menu_url,
                              section_count, item_count, attempts, next_attempt_at, reads)
     values ($1,$2,null,'none','found',$3,$4,0,0,0,null,0)
     on conflict (venue_ref) do update set
       menu_url = excluded.menu_url,
       state = case when place_menus.state = 'read' then 'read' else 'found' end,
       why = case when place_menus.state = 'read' then place_menus.why else excluded.why end,
       next_attempt_at = null`,
    [venueRef, venueLabel, how, menuUrl],
  );
}

/** Menus whose address is known and whose dishes have not been read yet. */
export async function menusToRead(limit = 5) {
  const { rows } = await query(
    `select m.venue_ref, m.venue_label, m.menu_url, p.area_code
       from place_menus m join scout_places p on p.venue_ref = m.venue_ref
      where m.state = 'found' and m.menu_url is not null
      order by p.rank limit $1`,
    [limit],
  );
  return rows;
}

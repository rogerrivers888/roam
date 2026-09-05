/**
 * Putting every place Roam holds into a place a person would name.
 *
 * Owner, 5 Sep 2026: "I can select a county, or I can select a city, or I can
 * select a postcode, and I can see all my stats and all my data for that
 * particular location. That's a first-class citizen… Take the place name from
 * the OSM place name."
 *
 * Two open sources answer two different questions about the same point, and
 * neither needs an account:
 *
 *   Where is it, postally?    api.postcodes.io — ONS's own postcode directory.
 *                             Bulk: 100 coordinates in one request, so 7,700
 *                             places is 77 requests and about a minute.
 *   What is it called?        OpenStreetMap, through Nominatim reverse at
 *                             **zoom 14**, reading town before village before
 *                             city. One request per place, at the one a second
 *                             their policy asks for. Why 14 and why that order
 *                             is set out on TOWN_ZOOM below — both were measured
 *                             against real rows rather than assumed, and the
 *                             first answer was wrong.
 *
 * The default stays 10 for every existing caller — trips group by city on it,
 * and London's folding depends on it — and this pass asks for 14 explicitly.
 *
 * **The order matters, and it is the cheap one first.** The postal pass is fast
 * and free of rate limits, so it runs over everything and gives each place an
 * outcode immediately; the page works from that alone. The naming pass then
 * walks the same rows at a second apiece, filling in the town, and every place
 * it finishes is one more row the tree can hold. An interrupted run — and every
 * deploy interrupts one — resumes from `located_at`.
 */

import { query } from '../db.js';
import { reverseGeocode } from './geocode.js';
import * as providerCalls from '../repositories/providerCalls.js';

const POSTCODES_API = 'https://api.postcodes.io';
const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; locality lookup)';

/**
 * The zoom at which Nominatim reliably answers with a full address.
 *
 * Measured rather than assumed, on real rows from the atlas:
 *
 *   zoom 10  no settlement at all — "Royal Borough of Windsor and Maidenhead"
 *   zoom 12  a settlement only where the point sits in one — Windsor yes,
 *            Faversham no ("Borough of Swale")
 *   zoom 13  sometimes a bare place node with no address breakdown at all
 *   zoom 14  a full breakdown every time
 *
 * So 14, and the fields are read in the order a person would say them.
 */
export const TOWN_ZOOM = 14;

/** ONS's bulk reverse takes 100 points a request; more is a 400. */
const BULK = 100;

/** 'Windsor' → 'windsor'; 'Bourne End, Buckinghamshire' → 'bourne-end-buckinghamshire'. */
export const slugify = (s) => String(s)
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------------------------------------------------------------------------
// where it is, postally
// ---------------------------------------------------------------------------

/**
 * Outward codes and councils for a batch of points, from ONS.
 *
 * Answers in the order asked, with a null where a point is outside the UK or
 * in the sea. A failed batch returns nulls rather than throwing: this is one
 * of two passes and the other one still has something useful to say.
 */
export async function outcodesFor(points) {
  const out = new Array(points.length).fill(null);
  for (let i = 0; i < points.length; i += BULK) {
    const slice = points.slice(i, i + BULK);
    try {
      const res = await fetch(`${POSTCODES_API}/postcodes`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
        // `radius` because a point on a castle's keep or in the middle of a park
        // is not on a postcode's centroid, and the default 100m misses both.
        body: JSON.stringify({ geolocations: slice.map((p) => ({ longitude: p.lng, latitude: p.lat, radius: 2000, limit: 1 })) }),
      });
      if (!res.ok) continue;
      const { result } = await res.json();
      (result ?? []).forEach((r, n) => {
        const hit = r?.result?.[0];
        if (!hit) return;
        out[i + n] = {
          outcode: hit.outcode ?? null,
          council: hit.admin_district ?? null,
          county: hit.admin_county ?? null,
          country: hit.country ?? null,
        };
      });
    } catch { /* ONS having a moment; the naming pass still runs */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// what it is called
// ---------------------------------------------------------------------------

/**
 * The town one point is in, as OpenStreetMap names it.
 *
 * `reverseGeocode` already folds Greater London's boroughs into one London and
 * strips "Royal Borough of" from a council's title, which is exactly the
 * treatment the owner asked for — so this adds the zoom and nothing else.
 */
export async function townAt(lat, lng) {
  const hit = await reverseGeocode(lat, lng, { zoom: TOWN_ZOOM });
  if (!hit) return null;
  const a = hit.parts ?? {};
  // A settlement before an administration. Nominatim puts a district in `city`
  // for most of rural England — Faversham comes back as "Borough of Swale" and
  // Colley Hill as "Reigate and Banstead" — and neither is what anybody calls
  // the place. `town` and `village` are the settlement itself.
  //
  // Falling through to `hit.locality` is what keeps London whole: inside Greater
  // London there is no town or village, only a borough, and `localityOf` is the
  // one place in Roam that turns all 33 of them into London.
  const name = a.town || a.village || hit.locality || null;
  if (!name) return null;
  return {
    name,
    osmRef: hit.sourcePlaceId ?? null,
    nation: hit.address?.region ?? null,
    lat: hit.lat ?? lat,
    lng: hit.lng ?? lng,
  };
}

// ---------------------------------------------------------------------------
// writing a locality
// ---------------------------------------------------------------------------

/**
 * Make sure a place exists, and return its slug.
 *
 * `parent` is only ever passed for a town, because a town is the only kind that
 * genuinely sits inside something we hold. A postcode district straddles
 * councils — SL4 is in five of them — so it is created parentless and reached
 * by name rather than by descending into it.
 */
export async function ensureLocality({ name, kind, parentSlug = null, lat = null, lng = null, council = null, nation = null, osmRef = null, countryCode = 'GB' }) {
  if (!name) return null;
  const slug = slugify(name);
  const { rows } = await query(
    `insert into localities (slug, name, kind, country_code, nation, parent_slug, lat, lng, council, osm_ref)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (slug) do update set
       -- Never overwrite a name or a parent with a null: the second pass knows
       -- less than the first about some columns and more about others.
       --
       -- And a slug can be reached by two kinds at once. Bristol is a ceremonial
       -- county in the regions table and the town OSM names at that point, and to a
       -- person those are one place — so the town resolves onto the county's row
       -- rather than fighting it for the slug. What must not happen is the town
       -- renaming the county or giving it a parent, so both are held to the kind
       -- that created the row.
       name        = case when localities.kind = excluded.kind
                          then coalesce(excluded.name, localities.name) else localities.name end,
       parent_slug = case when localities.kind = 'county'
                          then localities.parent_slug
                          else coalesce(excluded.parent_slug, localities.parent_slug) end,
       lat         = coalesce(localities.lat, excluded.lat),
       lng         = coalesce(localities.lng, excluded.lng),
       council     = coalesce(excluded.council, localities.council),
       nation      = coalesce(excluded.nation, localities.nation),
       osm_ref     = coalesce(excluded.osm_ref, localities.osm_ref),
       updated_at  = now()
     returning slug`,
    [slug, name, kind, countryCode, nation, parentSlug, lat, lng, council, osmRef]);
  return rows[0]?.slug ?? null;
}

// ---------------------------------------------------------------------------
// the passes
// ---------------------------------------------------------------------------

/**
 * The two tables that hold points, and how a row in each is addressed.
 *
 * `attractions` has a uuid; `scout_places` is keyed on (area_code, venue_ref)
 * and has no id at all, so a restaurant swept by two neighbouring areas is two
 * rows. Keying on `venue_ref` is deliberate rather than a workaround: it is one
 * restaurant, it is in one town, and both rows should say so.
 */
const TABLES = [
  { table: 'attractions', label: 'to go', key: 'id::text', match: 'id' },
  { table: 'scout_places', label: 'to eat', key: 'venue_ref', match: 'venue_ref' },
];

/**
 * Pass one: give every place an outward code and a council.
 *
 * Cheap enough to run over everything in one go, and it is what makes a
 * postcode district navigable before a single name has been looked up.
 */
export async function postalPass({ limit = 4000, householdId = null } = {}) {
  let looked = 0; let placed = 0; let requests = 0;

  for (const { table, key, match } of TABLES) {
    const { rows } = await query(
      `select ${key} as id, lat, lng from ${table}
        where lat is not null and lng is not null and outcode is null
        order by 1 limit $1`, [limit]);
    if (!rows.length) continue;

    const answers = await outcodesFor(rows);
    requests += Math.ceil(rows.length / BULK);
    looked += rows.length;

    for (let i = 0; i < rows.length; i++) {
      const a = answers[i];
      if (!a?.outcode) continue;
      await ensureLocality({ name: a.outcode, kind: 'postcode', lat: rows[i].lat, lng: rows[i].lng, council: a.council });
      await query(`update ${table} set outcode = $2 where ${match} = $1`, [rows[i].id, a.outcode]);
      placed++;
    }
  }

  // ONS is free and unmetered, but the ledger is the record of every outbound
  // call Roam makes and a free source that is missing from it is a source
  // nobody can prove the cost of later (Technical Constraints §2).
  if (requests && householdId) {
    await providerCalls.record(householdId, 'ons-postcodes', 'localities.postal', String(requests)).catch(() => null);
  }
  return { looked, placed, requests };
}

/**
 * Pass two: give every place the name OpenStreetMap calls it.
 *
 * One request a second, so this is deliberately batched and resumable rather
 * than run to completion: the caller asks for a few hundred, the button says
 * how many are left, and a deploy in the middle costs nothing but the batch in
 * flight. Places already stamped are skipped, whether or not they got an answer
 * — a point in the sea is not worth asking about twice.
 */
export async function namingPass({ limit = 200, householdId = null } = {}) {
  let looked = 0; let named = 0;

  for (const { table, key, match } of TABLES) {
    if (looked >= limit) break;
    const { rows } = await query(
      `select distinct on (p.${match}) p.${key} as id, p.lat, p.lng, p.outcode
         from ${table} p
        where p.lat is not null and p.lng is not null and p.located_at is null
        order by p.${match} limit $1`, [limit - looked]);

    for (const row of rows) {
      looked++;
      let slug = null;
      try {
        const town = await townAt(row.lat, row.lng);
        if (town) {
          slug = await ensureLocality({
            name: town.name, kind: 'town', lat: town.lat, lng: town.lng,
            osmRef: town.osmRef, nation: town.nation,
            // A town's county is the region the atlas already put it in, which
            // is a decision somebody has checked. Deriving it again from the
            // point would produce a second answer for the same question.
            parentSlug: table === 'attractions' ? await regionOf(row.id) : null,
          });
          named++;
        }
      } catch { /* Nominatim declining is not a reason to stall the batch */ }
      await query(
        `update ${table} set locality_slug = coalesce($2, locality_slug), located_at = now() where ${match} = $1`,
        [row.id, slug]);
    }
  }

  if (looked && householdId) {
    await providerCalls.record(householdId, 'osm-nominatim', 'localities.naming', String(looked)).catch(() => null);
  }
  // `remaining` answers for whatever was asked for: a county's own backlog when
  // one was named, the whole estate's otherwise. A button that says "400 of
  // 26,000" while you are working on Berkshire is telling you about somebody
  // else's problem.
  const { rows: left } = region
    ? await query(
      'select count(*) as n from attractions where lat is not null and located_at is null and region_slug = $1', [region])
    : await query(
      `select (select count(*) from attractions  where lat is not null and located_at is null)
            + (select count(*) from scout_places where lat is not null and located_at is null) as n`);
  return { looked, named, remaining: Number(left[0].n), region };
}

/** The county the atlas already filed an attraction under. */
async function regionOf(id) {
  const { rows } = await query('select region_slug from attractions where id = $1', [id]);
  return rows[0]?.region_slug ?? null;
}

/**
 * Recount what every locality holds.
 *
 * Refreshed rather than incremented, for the reason `regions` is: a counter
 * that is added to in six places is a counter that is wrong in one of them, and
 * the whole point of this table is being able to trust the number on the page.
 */
export async function refreshCounts() {
  // A town holds what OpenStreetMap put in it; a postcode district holds what
  // ONS put in it. Two different columns, so two different statements — the
  // same split `repositories/localities.js` makes when it reads them back.
  await query(
    `update localities l set
       to_go_count  = (select count(*) from attractions a
                        where a.locality_slug = l.slug and a.state <> 'hidden'),
       to_eat_count = (select count(distinct s.venue_ref) from scout_places s
                        where s.locality_slug = l.slug),
       image_count  = (select count(*) from image_links li
                         join attractions a on li.subject_type = 'attraction' and a.id::text = li.subject_id
                        where a.locality_slug = l.slug),
       updated_at   = now()
     where l.kind = 'town'`);

  await query(
    `update localities l set
       to_go_count  = (select count(*) from attractions a
                        where a.outcode = upper(l.slug) and a.state <> 'hidden'),
       to_eat_count = (select count(distinct s.venue_ref) from scout_places s
                        where s.outcode = upper(l.slug)),
       image_count  = (select count(*) from image_links li
                         join attractions a on li.subject_type = 'attraction' and a.id::text = li.subject_id
                        where a.outcode = upper(l.slug)),
       updated_at   = now()
     where l.kind = 'postcode'`);

  // A county counts by `region_slug`, which is the atlas's own filing and has
  // been through a harvest. Its towns are not added on top: Windsor Castle is
  // Berkshire's and Windsor's at once, and adding them would count it twice.
  await query(
    `update localities l set
       to_go_count  = (select count(*) from attractions a
                        where a.region_slug = l.slug and a.state <> 'hidden'),
       to_eat_count = (select count(distinct s.venue_ref) from scout_places s
                         join localities t on t.slug = s.locality_slug
                        where t.parent_slug = l.slug),
       image_count  = (select count(*) from image_links li
                         join attractions a on li.subject_type = 'attraction' and a.id::text = li.subject_id
                        where a.region_slug = l.slug),
       updated_at   = now()
     where l.kind = 'county'`);
}

/**
 * Reading the places you can point at.
 *
 * One row shape answers for a county, a town and a postcode district alike,
 * because the owner asked to "look at each one of those through the same lens"
 * (5 Sep 2026). So there is one `bySlug`, one `contentsOf` and one coverage
 * query, and the kind only decides which column the contents are matched on:
 *
 *   county    `region_slug` — the atlas already files an attraction under one,
 *             and that decision has been checked by a harvest.
 *   town      `locality_slug` — what OpenStreetMap calls the point.
 *   postcode  `outcode` — what ONS calls it.
 *
 * That is the whole of the "two ladders" problem, in three lines. Nothing
 * further down has to know which kind it is looking at.
 */

import { query } from '../db.js';

/** Which column on a place points at a locality of this kind. */
const MATCH = { county: 'region_slug', town: 'locality_slug', postcode: 'outcode' };

/** A postcode district is stored upper-case on a place and lower-case as a slug. */
const matchValue = (loc) => (loc.kind === 'postcode' ? loc.slug.toUpperCase() : loc.slug);

export const bySlug = async (slug) => (await query(
  `select l.*, p.name as parent_name, p.slug as parent_slug_out
     from localities l
     left join localities p on p.slug = l.parent_slug
    where l.slug = $1`, [String(slug || '').toLowerCase()])).rows[0] ?? null;

/**
 * The navigation tree: nations, their counties, and each county's towns.
 *
 * Towns come back nested under their county because that nesting is true.
 * Postcode districts do not appear here at all — they are reached by name from
 * the search box, because SL4 sits in five councils and putting it under one of
 * them would be a claim we know to be false.
 */
export async function tree() {
  const { rows } = await query(
    `select slug, name, kind, nation, parent_slug, to_go_count, to_eat_count, image_count
       from localities
      order by kind, name`);
  const counties = rows.filter((r) => r.kind === 'county');
  const towns = rows.filter((r) => r.kind === 'town');
  const byParent = new Map();
  for (const t of towns) {
    if (!t.parent_slug) continue;
    if (!byParent.has(t.parent_slug)) byParent.set(t.parent_slug, []);
    byParent.get(t.parent_slug).push(t);
  }
  return {
    nations: [...new Set(counties.map((c) => c.nation).filter(Boolean))].sort(),
    counties: counties.map((c) => ({ ...c, towns: byParent.get(c.slug) ?? [] })),
    // Towns OSM named that we could not attach to a county — a place in the sea,
    // or one whose region was never harvested. Shown rather than dropped: a
    // count that does not add up is a question, and hiding it is how it stops
    // being asked.
    orphanTowns: towns.filter((t) => !t.parent_slug),
    postcodes: rows.filter((r) => r.kind === 'postcode'),
  };
}

export const findByName = async (q, limit = 12) => (await query(
  `select slug, name, kind, nation, to_go_count, to_eat_count
     from localities
    where name ilike $1 or slug ilike $1
    order by (kind = 'county') desc, to_go_count + to_eat_count desc, name
    limit $2`, [`%${String(q).trim()}%`, limit])).rows;

// ---------------------------------------------------------------------------
// what is in one
// ---------------------------------------------------------------------------

/** The six facts the back office tracks per place, and what "held" means for each. */
const FACTS = {
  picture:     { go: 'exists (select 1 from image_links li where li.subject_type = \'attraction\' and li.subject_id = a.id::text)', eat: 'false' },
  description: { go: 'a.summary is not null', eat: 'r.summary is not null' },
  // An attraction's opening hours are not held yet — `score_parts.open` says
  // whether the public may visit at all, which is a different fact — so the
  // column is honestly zero until the reading pass fills it (migration 045).
  hours:       { go: 'false', eat: 'r.opening_hours is not null' },
  website:     { go: 'a.website is not null', eat: 'coalesce(r.website, s.website) is not null' },
  menu:        { go: 'false', eat: 'exists (select 1 from place_menus m where m.venue_ref = s.venue_ref and m.state = \'read\')' },
  shelf:       { go: 'a.category is not null', eat: 'true' },
};

/**
 * Everything in one place, both kinds together, best first.
 *
 * Two selects rather than a view, because an attraction and a restaurant carry
 * genuinely different columns and flattening them into one table would make
 * every consumer re-widen them. What they share is what a row shows: a name, a
 * type, a score, and which of the six facts we hold.
 */
export async function contentsOf(loc, { kind = null, missing = null, limit = 200 } = {}) {
  const col = MATCH[loc.kind];
  if (!col) return [];
  const v = matchValue(loc);
  const out = [];

  if (kind !== 'eat') {
    const where = [`a.${col} = $1`, "a.state <> 'hidden'"];
    if (missing && FACTS[missing]) where.push(`not (${FACTS[missing].go})`);
    const { rows } = await query(
      `select a.id::text as id, a.name, a.slug, 'go' as side, a.category as type, a.score,
              a.rank, a.state, a.website, a.outcode, a.locality_slug, a.region_slug,
              (select li.image_id from image_links li
                where li.subject_type = 'attraction' and li.subject_id = a.id::text and li.role = 'hero' limit 1) as hero_id,
              (select count(*) from image_links li
                where li.subject_type = 'attraction' and li.subject_id = a.id::text)::int as image_count,
              (a.summary is not null) as has_description,
              false as has_hours,
              (a.website is not null) as has_website,
              (a.category is not null) as has_shelf
         from attractions a
        where ${where.join(' and ')}
        order by a.score desc nulls last, a.name
        limit $2`, [v, limit]);
    out.push(...rows.map((r) => ({ ...r, has_picture: r.image_count > 0, has_menu: null })));
  }

  if (kind !== 'go') {
    const where = [`s.${col === 'region_slug' ? 'locality_slug' : col} = $1`];
    // A county has no column on `scout_places` — a restaurant is filed under a
    // town and a postcode, never a region — so a county's food comes through
    // the towns that sit in it. This is the one place the two ladders have to
    // be joined, and it is one join rather than a rule everywhere else.
    if (col === 'region_slug') {
      where.length = 0;
      where.push('s.locality_slug in (select slug from localities where parent_slug = $1)');
    }
    if (missing && FACTS[missing]) where.push(`not (${FACTS[missing].eat})`);
    // `distinct on (venue_ref)` because a restaurant near a boundary is swept by
    // two areas and is one row on `place_records` and two on `scout_places`.
    // Whichever area ranked it best is the one shown.
    const { rows } = await query(
      `select distinct on (s.venue_ref)
              s.venue_ref as id, s.name, null as slug, 'eat' as side,
              'restaurant' as type, s.roam_score as score, s.owned_score, s.rank, null as state,
              coalesce(r.website, s.website) as website, s.outcode, s.locality_slug, null as region_slug,
              null as hero_id, 0 as image_count,
              (r.summary is not null) as has_description,
              (r.opening_hours is not null) as has_hours,
              (coalesce(r.website, s.website) is not null) as has_website,
              true as has_shelf,
              exists (select 1 from place_menus m where m.venue_ref = s.venue_ref and m.state = 'read') as has_menu
         from scout_places s
         left join place_records r on r.venue_ref = s.venue_ref
        where ${where.join(' and ')}
        order by s.venue_ref, s.roam_score desc nulls last
        limit $2`, [v, limit]);
    out.push(...rows.map((r) => ({ ...r, has_picture: false })));
  }

  return out;
}

/**
 * How much of each fact one place holds, as a percentage and a count.
 *
 * The percentage is what the matrix draws and the count is what the flyout
 * says, because "85%" and "3 places have no picture" are the same fact told to
 * two different questions and only the second one can be worked.
 */
export async function coverageOf(loc) {
  const col = MATCH[loc.kind];
  if (!col) return null;
  const v = matchValue(loc);

  const goSelects = Object.entries(FACTS)
    .map(([k, f]) => `count(*) filter (where ${f.go})::int as ${k}`).join(', ');
  const { rows: go } = await query(
    `select count(*)::int as total, ${goSelects}
       from attractions a where a.${col} = $1 and a.state <> 'hidden'`, [v]);

  const eatWhere = col === 'region_slug'
    ? 's.locality_slug in (select slug from localities where parent_slug = $1)'
    : `s.${col === 'region_slug' ? 'locality_slug' : col} = $1`;
  const eatSelects = Object.entries(FACTS)
    .map(([k, f]) => `count(*) filter (where ${f.eat})::int as ${k}`).join(', ');
  // One row per restaurant even where two areas swept it, then the owned record
  // beside it — the facts a restaurant is judged on live there, not on the
  // sweep's row (§13.10).
  const { rows: eat } = await query(
    `select count(*)::int as total, ${eatSelects}
       from (select distinct on (s.venue_ref) s.venue_ref, s.website, s.roam_score
               from scout_places s
              where ${eatWhere}
              order by s.venue_ref, s.roam_score desc nulls last) s
       left join place_records r on r.venue_ref = s.venue_ref`, [v]);

  const facts = {};
  for (const k of Object.keys(FACTS)) {
    // A fact that cannot apply to a side is left out of that side's total
    // rather than counted as a failure: a restaurant has no card picture in the
    // atlas sense, and calling that 0% would make every food area look broken.
    const applies = { picture: go[0].total, description: go[0].total + eat[0].total, hours: go[0].total + eat[0].total,
      website: go[0].total + eat[0].total, menu: eat[0].total, shelf: go[0].total }[k];
    const held = (k === 'menu' ? 0 : go[0][k]) + (k === 'picture' || k === 'shelf' ? 0 : eat[0][k]);
    facts[k] = { held, of: applies, pc: applies ? Math.round((held / applies) * 100) : null };
  }
  return { toGo: go[0].total, toEat: eat[0].total, facts };
}

/** The matrix: one row per place, for a county and everything under it. */
export async function coverageRows(slugs) {
  const out = [];
  for (const slug of slugs) {
    const loc = await bySlug(slug);
    if (!loc) continue;
    out.push({ slug: loc.slug, name: loc.name, kind: loc.kind, ...(await coverageOf(loc)) });
  }
  return out;
}

export const FACT_KEYS = Object.keys(FACTS);

// ---------------------------------------------------------------------------
// the page's other two panels
// ---------------------------------------------------------------------------

/** How many places have never been through the naming pass. */
export const pendingNaming = async () => Number((await query(
  `select (select count(*) from attractions  where lat is not null and located_at is null)
        + (select count(distinct venue_ref) from scout_places where lat is not null and located_at is null) as n`
)).rows[0].n);

/**
 * What a place is made of, in Roam's own eight words.
 *
 * Every category is returned, including the ones at zero, because a zero is the
 * finding: Windsor holds forty-three places to go and not one of them is filed
 * `family`, which is only visible if `family` is on the list at all.
 */
export async function breakdownOf(loc) {
  const col = MATCH[loc.kind];
  if (!col) return [];
  const { rows } = await query(
    `select coalesce(a.category, 'uncategorised') as category, count(*)::int as n
       from attractions a
      where a.${col} = $1 and a.state <> 'hidden'
      group by 1`, [matchValue(loc)]);
  const held = new Map(rows.map((r) => [r.category, r.n]));
  const ALL = ['heritage', 'outdoors', 'museum', 'family', 'arts', 'animals', 'active', 'landmark'];
  return [
    ...ALL.map((c) => ({ category: c, n: held.get(c) ?? 0 })),
    ...(held.has('uncategorised') ? [{ category: 'uncategorised', n: held.get('uncategorised') }] : []),
  ].sort((a, b) => b.n - a.n);
}

/**
 * Where to go next from here.
 *
 * A county offers its towns, a town offers the others in its county, and a
 * postcode district offers the towns its places actually sit in — which is the
 * one honest way to walk between the two ladders, because SL4 has no parent to
 * climb to and five councils it partly covers.
 */
export async function siblingsOf(loc) {
  if (loc.kind === 'county') {
    return (await query(
      `select slug, name, kind, to_go_count, to_eat_count from localities
        where parent_slug = $1 order by to_go_count + to_eat_count desc, name`, [loc.slug])).rows;
  }
  if (loc.kind === 'town' && loc.parent_slug) {
    return (await query(
      `select slug, name, kind, to_go_count, to_eat_count from localities
        where parent_slug = $1 and slug <> $2 order by to_go_count + to_eat_count desc, name limit 30`,
      [loc.parent_slug, loc.slug])).rows;
  }
  if (loc.kind === 'postcode') {
    return (await query(
      `select l.slug, l.name, l.kind, l.to_go_count, l.to_eat_count
         from localities l
        where l.slug in (
          select distinct a.locality_slug from attractions a where a.outcode = $1 and a.locality_slug is not null
          union
          select distinct s.locality_slug from scout_places s where s.outcode = $1 and s.locality_slug is not null)
        order by l.to_go_count + l.to_eat_count desc, l.name`, [matchValue(loc)])).rows;
  }
  return [];
}

/**
 * The rows of the coverage matrix for one part of the country.
 *
 * A county, the towns inside it, and the postcode districts its own places
 * actually fall in — which is the only honest way to put both ladders on one
 * screen. SL4 appears under Berkshire not because it is in Berkshire (it is in
 * five councils and reaches into Surrey) but because places we hold in Berkshire
 * carry that outward code, which is a fact about our data rather than a claim
 * about geography.
 */
export async function familyOf(slug) {
  const county = await bySlug(slug);
  if (!county || county.kind !== 'county') return county ? [county.slug] : [];
  const { rows } = await query(
    `select slug from localities where parent_slug = $1
      order by to_go_count + to_eat_count desc, name limit 12`, [county.slug]);
  // By weight, not alphabetically. Berkshire's places carry a long tail of
  // outward codes from every county it borders, and an alphabetical cut put
  // GU10 through GU17 — Farnham and Aldershot — on the page while RG1, SL4 and
  // SL6, which hold a hundred places between them, never appeared at all.
  const { rows: codes } = await query(
    `select upper(a.outcode) as code, count(*)::int as n from attractions a
      where a.region_slug = $1 and a.outcode is not null and a.state <> 'hidden'
      group by 1 order by n desc, code limit 12`, [county.slug]);
  const postcodes = codes.map((c) => c.code.toLowerCase());
  return [county.slug, ...rows.map((r) => r.slug), ...postcodes];
}

/** Every county that holds something, for the matrix's "everywhere" view. */
export const countiesWithContent = async (limit = 30) => (await query(
  `select slug from localities
    where kind = 'county' and (to_go_count > 0 or to_eat_count > 0)
    order by to_go_count + to_eat_count desc, name limit $1`, [limit])).rows.map((r) => r.slug);

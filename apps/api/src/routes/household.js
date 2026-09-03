import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { ALLERGENS, matchConcepts, resolveConcept, conceptByKey, isNegated } from '../domain/concepts.js';

const NEGATION_PREFIX = /^(not|no|never|without|anything but|nothing)\s+/i;
import { geocode } from '../sources/geocode.js';
import { spendSummary } from '../claude.js';
import { paceOf, DEFAULT_PACE } from '../domain/pace.js';
import { isValidTimezone } from '../domain/time.js';

const router = Router();

export const RELATIONSHIPS = ['parent', 'partner', 'child', 'grandparent', 'sibling', 'friend', 'other'];
const KINDS = ['allergen', 'diet', 'dislike', 'like'];
export const LEARN_THRESHOLD = Number(process.env.ROAM_LEARN_THRESHOLD || 3);
const HALF_LIFE_DAYS = Number(process.env.ROAM_LEARN_HALF_LIFE_DAYS || 180);

// V1 is a single founding household (Requirements §3). Multi-household
// onboarding is V2, so the household is looked up rather than routed to.
export async function currentHousehold() {
  const { rows } = await query('select * from households order by created_at limit 1');
  if (!rows[0]) {
    const err = new Error('No household exists. Run `npm run seed`.');
    err.status = 404;
    err.code = 'no_household';
    throw err;
  }
  return rows[0];
}

const ageOf = (birthYear) => (birthYear ? new Date().getFullYear() - birthYear : null);
/** Exact age from a birthday, else a rough one from the year. */
function ageFrom(birthDate, birthYear) {
  if (birthDate) {
    const b = new Date(birthDate);
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age -= 1;
    return age;
  }
  return ageOf(birthYear);
}

export async function loadMembers(householdId) {
  const { rows } = await query(
    `select m.*,
            coalesce(json_agg(json_build_object('id', c.id, 'kind', c.kind, 'value', c.value,
                                                'conceptKey', c.concept_key, 'conceptKind', c.concept_kind, 'maxMinutes', c.max_minutes, 'favourite', c.favourite))
                     filter (where c.id is not null), '[]') as constraints
       from members m
       left join member_constraints c on c.member_id = m.id
      where m.household_id = $1
      group by m.id
      order by m.is_minor, m.created_at`,
    [householdId],
  );

  return rows.map((row) => {
    const age = ageFrom(row.birth_date, row.birth_year);
    return {
      id: row.id,
      name: row.name,
      isMinor: age != null ? age < 13 : row.is_minor,
      age,
      birthYear: row.birth_year,
      birthDate: row.birth_date,
      relationship: row.relationship,
      avatarUrl: row.avatar_url,
      typicalVisitMinutes: row.typical_visit_minutes,
      maxTravelMinutes: row.max_travel_minutes,
      allergens: row.constraints.filter((c) => c.kind === 'allergen'),
      diets: row.constraints.filter((c) => c.kind === 'diet'),
      dislikes: row.constraints.filter((c) => c.kind === 'dislike'),
      likes: row.constraints.filter((c) => c.kind === 'like'),
    };
  });
}

/** Members flattened for the ranking layer. */
export function toAttendees(members) {
  const pref = (c) => ({ value: c.value, conceptKey: c.conceptKey ?? null, maxMinutes: c.maxMinutes ?? null, favourite: Boolean(c.favourite) });
  return members.map((m) => ({
    id: m.id,
    name: m.name,
    isMinor: m.isMinor,
    allergens: m.allergens.map((c) => c.value),
    diets: m.diets.map(pref),
    dislikes: m.dislikes.map(pref),
    likes: m.likes.map(pref),
  }));
}

/**
 * What the household's ratings say, per member per concept, with recency
 * weighting and a confidence threshold (Requirements §5 "Preference confidence").
 */
export async function loadLearnedPreferences(householdId) {
  const { rows } = await query(
    `select r.member_id, m.name, r.concept_key, r.take, v.visited_on
       from ratings r
       join visits v on v.id = r.visit_id
       join members m on m.id = r.member_id
      where v.household_id = $1 and r.concept_key is not null`,
    [householdId],
  );
  const now = Date.now();
  const acc = new Map();
  for (const r of rows) {
    const days = (now - new Date(r.visited_on).getTime()) / 86_400_000;
    const weight = Math.pow(0.5, Math.max(0, days) / HALF_LIFE_DAYS);
    const key = `${r.member_id}|${r.concept_key}`;
    const a = acc.get(key) ?? { memberId: r.member_id, name: r.name, conceptKey: r.concept_key, count: 0, net: 0, lastOn: r.visited_on };
    a.count += 1;
    a.net += r.take === 'loved' ? weight : r.take === 'not_for_me' ? -weight : 0;
    if (r.visited_on > a.lastOn) a.lastOn = r.visited_on;
    acc.set(key, a);
  }
  return [...acc.values()]
    .filter((a) => Math.abs(a.net) > 0.05)
    .map((a) => ({
      ...a,
      kind: a.net > 0 ? 'like' : 'dislike',
      confirmed: a.count >= LEARN_THRESHOLD,
      threshold: LEARN_THRESHOLD,
      label: conceptByKey(a.conceptKey)?.label ?? a.conceptKey,
      conceptKind: conceptByKey(a.conceptKey)?.kind ?? null,
      net: Number(a.net.toFixed(2)),
    }))
    .sort((x, y) => y.count - x.count);
}

function kindsFor(constraintKind) {
  if (constraintKind === 'diet') return ['diet'];
  if (constraintKind === 'allergen') return null;
  return ['dish', 'cuisine', 'ingredient', 'style', 'experience'];
}

router.get('/', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    res.json({
      household: {
        id: household.id,
        name: household.name,
        defaultVisitMinutes: household.default_visit_minutes,
        maxTravelMinutes: household.max_travel_minutes,
        defaultIntensity: household.default_intensity,
        home: household.home_lat != null ? { label: household.home_label, lat: household.home_lat, lng: household.home_lng } : null,
        pace: paceOf(household),
        timezone: household.timezone,
      },
      members,
      learned: await loadLearnedPreferences(household.id),
      vocabulary: { allergens: ALLERGENS, relationships: RELATIONSHIPS },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { name, defaultVisitMinutes, maxTravelMinutes, defaultIntensity, home, homeText, pace, timezone } = req.body;
    if (timezone && !isValidTimezone(timezone)) return res.status(400).json({ error: 'invalid_timezone' });
    const mergedPace = pace ? { food: { ...paceOf(household).food, ...(pace.food || {}) }, activity: { ...paceOf(household).activity, ...(pace.activity || {}) } } : null;
    // Home may arrive as a picked place or as typed text to geocode (Epic 3 M3).
    let homePlace = home?.lat != null ? home : null;
    if (!homePlace && homeText?.trim()) [homePlace] = await geocode(homeText, { limit: 1 });
    if (homeText?.trim() && !homePlace) return res.status(404).json({ error: 'home_not_found', message: `Couldn't find "${homeText}". Try a fuller address or a town name.` });
    const { rows } = await query(
      `update households
          set name                  = coalesce($2, name),
              default_visit_minutes = coalesce($3, default_visit_minutes),
              max_travel_minutes    = coalesce($4, max_travel_minutes),
              default_intensity     = coalesce($5, default_intensity),
              home_label            = coalesce($6, home_label),
              home_lat              = coalesce($7, home_lat),
              home_lng              = coalesce($8, home_lng),
              pace                  = coalesce($9::jsonb, pace),
              timezone              = coalesce($10, timezone)
        where id = $1 returning *`,
      [household.id, name ?? null, defaultVisitMinutes ?? null, maxTravelMinutes ?? null, defaultIntensity ?? null,
       homePlace?.label ?? null, homePlace?.lat ?? null, homePlace?.lng ?? null, mergedPace ? JSON.stringify(mergedPace) : null, timezone ?? null],
    );
    const h = rows[0];
    res.json({ household: { id: h.id, name: h.name, defaultVisitMinutes: h.default_visit_minutes, maxTravelMinutes: h.max_travel_minutes, defaultIntensity: h.default_intensity,
      home: h.home_lat != null ? { label: h.home_label, lat: h.home_lat, lng: h.home_lng } : null, pace: paceOf(h), timezone: h.timezone } });
  } catch (err) {
    next(err);
  }
});

router.post('/members', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { name, relationship = null, birthYear = null, birthDate = null, avatarUrl = null, typicalVisitMinutes, maxTravelMinutes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name_required' });
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return res.status(400).json({ error: 'invalid_birth_date', message: 'Use YYYY-MM-DD' });
    if (relationship && !RELATIONSHIPS.includes(relationship)) return res.status(400).json({ error: 'invalid_relationship' });
    const age = ageFrom(birthDate, birthYear);
    const { rows } = await query(
      `insert into members (household_id, name, is_minor, relationship, birth_year, birth_date, avatar_url, typical_visit_minutes, max_travel_minutes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [household.id, name.trim(), age != null ? age < 13 : relationship === 'child', relationship, birthYear ?? (birthDate ? Number(birthDate.slice(0, 4)) : null), birthDate, avatarUrl, typicalVisitMinutes ?? null, maxTravelMinutes ?? null],
    );
    res.status(201).json({ member: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/members/:id', async (req, res, next) => {
  try {
    const { name, relationship, birthYear, birthDate, avatarUrl, typicalVisitMinutes, maxTravelMinutes } = req.body;
    if (relationship && !RELATIONSHIPS.includes(relationship)) return res.status(400).json({ error: 'invalid_relationship' });
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return res.status(400).json({ error: 'invalid_birth_date', message: 'Use YYYY-MM-DD' });
    if (avatarUrl && avatarUrl.length > 600_000) return res.status(413).json({ error: 'avatar_too_large', message: 'Keep photos under ~400KB' });
    const { rows } = await query(
      `update members
          set name                  = coalesce($2, name),
              relationship          = coalesce($3, relationship),
              birth_year            = coalesce($4, birth_year),
              avatar_url            = case when $5::text = '' then null else coalesce($5, avatar_url) end,
              typical_visit_minutes = coalesce($6, typical_visit_minutes),
              max_travel_minutes    = coalesce($7, max_travel_minutes),
              birth_date            = coalesce($8::date, birth_date),
              is_minor              = case when coalesce($8::date, birth_date) is not null
                                           then age(coalesce($8::date, birth_date)) < interval '13 years'
                                           when coalesce($4, birth_year) is not null
                                           then (extract(year from now())::int - coalesce($4, birth_year)) < 13
                                           else is_minor end
        where id = $1 returning *`,
      [req.params.id, name ?? null, relationship ?? null, birthYear ?? (birthDate ? Number(birthDate.slice(0, 4)) : null), avatarUrl ?? null, typicalVisitMinutes ?? null, maxTravelMinutes ?? null, birthDate ?? null],
    );
    if (!rows[0]) return res.status(404).json({ error: 'member_not_found' });
    res.json({ member: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Epic 1 M3 — deleting a member deletes their profile and rating history.
router.delete('/members/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from members where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'member_not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Add an allergen, diet, dislike or like. Free text is resolved to a taste
 * concept when confident; otherwise it is kept as written and the closest
 * concepts are returned as suggestions (Epic 2 C6/C7).
 */
router.post('/members/:id/constraints', async (req, res, next) => {
  try {
    const { kind, value, conceptKey: explicitKey, maxMinutes = null, favourite = false } = req.body;
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind', message: `kind must be one of ${KINDS.join(', ')}` });
    if (!value?.trim()) return res.status(400).json({ error: 'value_required' });

    let concept = explicitKey ? conceptByKey(explicitKey) : null;
    if (!concept && kind !== 'allergen') concept = resolveConcept(value, { kinds: kindsFor(kind) });
    const stored = concept ? concept.label : value.trim();

    // A like and a dislike of the same thing cancel out, so we never store
    // both. "Long walks" on the dislike side of a liked walk is a limit, not
    // a dislike: keep short walks, cap them.
    if (kind === 'like' || kind === 'dislike') {
      const other = kind === 'like' ? 'dislike' : 'like';
      const scale = value.trim().match(/^(long|lengthy|big|all[- ]day)\s+(.+)$/i);
      const scaleConcept = scale ? resolveConcept(scale[2], { kinds: kindsFor(kind) }) : null;
      const wantKey = (scaleConcept ?? concept)?.key ?? null;
      const wantValue = (scaleConcept ? scale[2] : stored).toLowerCase();
      const { rows: others } = await query('select * from member_constraints where member_id = $1 and kind = $2', [req.params.id, other]);
      // Older rows may hold free text with no concept; resolve them the same way ranking does.
      const keyOf = (row) => row.concept_key ?? resolveConcept(row.value, { kinds: kindsFor(other) })?.key ?? null;
      const clash = others.find((row) => row.value === wantValue || (wantKey && keyOf(row) === wantKey));
      if (clash && kind === 'dislike' && scaleConcept) {
        const minutes = clash.max_minutes ?? 30;
        const { rows: updated } = await query('update member_constraints set max_minutes = $2 where id = $1 returning *', [clash.id, minutes]);
        return res.status(200).json({
          constraint: updated[0], resolved: null, suggestions: [], limited: true,
          hint: `Short ones are fine, long ones aren't — so "${clash.value}" in Loves doing is now capped at ${minutes} min rather than adding a dislike. Tap it to change the limit.`,
        });
      }
      if (clash) {
        return res.status(409).json({
          error: 'conflicts_with_' + other, constraint: clash,
          message: `"${clash.value}" is already in ${other === 'like' ? (clash.concept_kind === 'experience' ? 'Loves doing' : 'Likes') : (clash.concept_kind === 'experience' ? 'Would rather not' : 'Dislikes')}. Remove it there first${other === 'like' ? ', or tap it to set a limit' : ''}.`,
        });
      }
    }

    const { rows } = await query(
      `insert into member_constraints (member_id, kind, value, concept_key, concept_kind, max_minutes, favourite)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (member_id, kind, value) do update set concept_key = excluded.concept_key, concept_kind = excluded.concept_kind, max_minutes = coalesce(excluded.max_minutes, member_constraints.max_minutes), favourite = excluded.favourite or member_constraints.favourite
       returning *`,
      [req.params.id, kind, stored.toLowerCase(), concept?.key ?? null, concept?.kind ?? null, maxMinutes ? Number(maxMinutes) : null, kind === 'like' && Boolean(favourite)],
    );
    const negated = isNegated(value) && kind !== 'allergen';
    res.status(201).json({
      constraint: rows[0],
      resolved: concept ? { key: concept.key, label: concept.label, kind: concept.kind } : null,
      suggestions: concept || negated ? [] : matchConcepts(value, { kinds: kindsFor(kind), limit: 5 }).map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
      hint: negated
        ? `Kept "${value.trim()}" as typed, but Roam doesn't read "not". Put "${value.trim().replace(NEGATION_PREFIX, '')}" in ${kind === 'like' ? 'Dislikes' : 'Likes'} instead — the two lists do the negating.`
        : kind === 'allergen' && !ALLERGENS.includes(value.trim().toLowerCase())
          ? `Added. Place listings rarely state "${value.trim()}", so it will flag menu items once a menu is captured rather than excluding venues today.`
          : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * "Walks — up to 40 minutes": a limit on one preference (null clears it), and
 * "favourite": the one this person will generally pick over the others.
 * Only the fields sent are changed.
 */
router.patch('/constraints/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const sets = [];
    const params = [req.params.id];
    if ('maxMinutes' in body) { params.push(body.maxMinutes ? Number(body.maxMinutes) : null); sets.push(`max_minutes = $${params.length}`); }
    if ('favourite' in body) { params.push(Boolean(body.favourite)); sets.push(`favourite = $${params.length} and kind = 'like'`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update', message: 'send maxMinutes and/or favourite' });
    const { rows } = await query(`update member_constraints set ${sets.join(', ')} where id = $1 returning *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'constraint_not_found' });
    res.json({ constraint: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/constraints/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from member_constraints where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'constraint_not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/learned', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    res.json({ learned: await loadLearnedPreferences(household.id), threshold: LEARN_THRESHOLD });
  } catch (err) {
    next(err);
  }
});

/** Cost per household per period — the instrumentation §14 asks for. */
router.get('/spend', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const summary = await spendSummary({ householdId: household.id, sessionId: '00000000-0000-0000-0000-000000000000' });
    const { rows } = await query(
      `select provider, count(*)::int as calls, coalesce(sum(estimated_cost_usd), 0)::float as cost_usd
         from provider_calls where household_id = $1 and created_at >= date_trunc('month', now())
        group by provider order by calls desc`,
      [household.id],
    );
    res.json({ month: { calls: summary.month_calls, costUsd: summary.month_cost_usd, bound: summary.householdMonthlyBound }, byProvider: rows });
  } catch (err) {
    next(err);
  }
});

/** Everything the household has generated, in readable JSON (Epic 1 C9). */
router.get('/export', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    const members = await loadMembers(household.id);
    const [{ rows: trips }, { rows: stops }, { rows: visits }, { rows: ratings }, { rows: ledger }] = await Promise.all([
      query('select * from trips where household_id = $1 order by depart_at', [household.id]),
      query('select s.* from trip_stops s join trips t on t.id = s.trip_id where t.household_id = $1 order by s.trip_id, s.position', [household.id]),
      query('select * from visits where household_id = $1 order by visited_on', [household.id]),
      query('select r.* from ratings r join visits v on v.id = r.visit_id where v.household_id = $1 order by r.created_at', [household.id]),
      query('select * from place_ledger where household_id = $1 order by created_at', [household.id]),
    ]);
    res.setHeader('content-disposition', `attachment; filename="roam-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      note: 'Place content from licensed sources is not included — only identifiers and what the household wrote.',
      household: { name: household.name, defaultVisitMinutes: household.default_visit_minutes, maxTravelMinutes: household.max_travel_minutes, defaultIntensity: household.default_intensity },
      members, trips, stops, visits, ratings, placeLedger: ledger,
    });
  } catch (err) {
    next(err);
  }
});

/** Delete means delete (Epic 1 C10). The household name must be typed to confirm. */
router.delete('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { confirmName } = req.body || {};
    if (confirmName !== household.name) return res.status(400).json({ error: 'confirm_name_mismatch', message: 'Type the household name exactly to confirm deletion.' });
    await withTransaction(async (client) => {
      await client.query('delete from provider_calls where household_id = $1', [household.id]);
      await client.query('delete from households where id = $1', [household.id]);
    });
    res.json({ deleted: true, household: household.name });
  } catch (err) {
    next(err);
  }
});

export default router;

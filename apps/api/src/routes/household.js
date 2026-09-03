import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

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

export async function loadMembers(householdId) {
  const { rows } = await query(
    `select m.*,
            coalesce(json_agg(json_build_object('id', c.id, 'kind', c.kind, 'value', c.value))
                     filter (where c.id is not null), '[]') as constraints
       from members m
       left join member_constraints c on c.member_id = m.id
      where m.household_id = $1
      group by m.id
      order by m.is_minor, m.created_at`,
    [householdId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isMinor: row.is_minor,
    typicalVisitMinutes: row.typical_visit_minutes,
    maxTravelMinutes: row.max_travel_minutes,
    allergens: row.constraints.filter((c) => c.kind === 'allergen'),
    dislikes: row.constraints.filter((c) => c.kind === 'dislike'),
    likes: row.constraints.filter((c) => c.kind === 'like'),
  }));
}

/** Members flattened for the ranking layer, which only cares about values. */
export function toAttendees(members) {
  return members.map((m) => ({
    id: m.id,
    name: m.name,
    isMinor: m.isMinor,
    allergens: m.allergens.map((c) => c.value),
    dislikes: m.dislikes.map((c) => c.value),
    likes: m.likes.map((c) => c.value),
  }));
}

router.get('/', async (_req, res, next) => {
  try {
    const household = await currentHousehold();
    res.json({
      household: {
        id: household.id,
        name: household.name,
        defaultVisitMinutes: household.default_visit_minutes,
        maxTravelMinutes: household.max_travel_minutes,
        defaultIntensity: household.default_intensity,
      },
      members: await loadMembers(household.id),
    });
  } catch (err) {
    next(err);
  }
});

// Pace defaults (Epic 1 C7). A trip may override either without changing these.
router.patch('/', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { defaultVisitMinutes, maxTravelMinutes, defaultIntensity } = req.body;
    const { rows } = await query(
      `update households
          set default_visit_minutes = coalesce($2, default_visit_minutes),
              max_travel_minutes    = coalesce($3, max_travel_minutes),
              default_intensity     = coalesce($4, default_intensity)
        where id = $1
        returning *`,
      [household.id, defaultVisitMinutes ?? null, maxTravelMinutes ?? null, defaultIntensity ?? null],
    );
    res.json({ household: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/members', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const { name, isMinor = false, typicalVisitMinutes, maxTravelMinutes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name_required' });

    const { rows } = await query(
      `insert into members (household_id, name, is_minor, typical_visit_minutes, max_travel_minutes)
       values ($1, $2, $3, $4, $5) returning *`,
      [household.id, name.trim(), Boolean(isMinor), typicalVisitMinutes ?? null, maxTravelMinutes ?? null],
    );
    res.status(201).json({ member: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/members/:id', async (req, res, next) => {
  try {
    const { name, typicalVisitMinutes, maxTravelMinutes } = req.body;
    const { rows } = await query(
      `update members
          set name                  = coalesce($2, name),
              typical_visit_minutes = coalesce($3, typical_visit_minutes),
              max_travel_minutes    = coalesce($4, max_travel_minutes)
        where id = $1
        returning *`,
      [req.params.id, name ?? null, typicalVisitMinutes ?? null, maxTravelMinutes ?? null],
    );
    if (!rows[0]) return res.status(404).json({ error: 'member_not_found' });
    res.json({ member: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Epic 1 M3 — deleting a member removes their history from future calculations.
router.delete('/members/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query('delete from members where id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'member_not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/members/:id/constraints', async (req, res, next) => {
  try {
    const { kind, value } = req.body;
    if (!['allergen', 'dislike', 'like'].includes(kind)) {
      return res.status(400).json({ error: 'invalid_kind', message: 'kind must be allergen, dislike or like' });
    }
    if (!value?.trim()) return res.status(400).json({ error: 'value_required' });

    const { rows } = await query(
      `insert into member_constraints (member_id, kind, value)
       values ($1, $2, $3)
       on conflict (member_id, kind, value) do update set value = excluded.value
       returning *`,
      [req.params.id, kind, value.trim().toLowerCase()],
    );
    res.status(201).json({ constraint: rows[0] });
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

export default router;

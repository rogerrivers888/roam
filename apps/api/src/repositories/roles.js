/**
 * Every statement about roles, the capabilities they carry, and the plans an
 * account can be on.
 *
 * Rule 1 of the estate's engineering standard: all SQL lives in `repositories/`.
 */

import { query, withTransaction } from '../db.js';

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

const ROLE_COLUMNS = 'id, key, label, description, doors, is_system, is_owner, position, created_at, updated_at';

/** Every role, each with its capabilities already gathered and a head count. */
export async function listRoles() {
  const { rows } = await query(
    `select r.${ROLE_COLUMNS.split(', ').join(', r.')},
            coalesce(array_agg(c.capability) filter (where c.capability is not null), '{}') as capabilities,
            (select count(*)::int from accounts a where a.role_id = r.id) as people
       from roles r
       left join role_capabilities c on c.role_id = r.id
      group by r.id
      order by r.position, r.created_at`,
  );
  return rows;
}

export async function roleById(id) {
  const { rows } = await query(
    `select r.${ROLE_COLUMNS.split(', ').join(', r.')},
            coalesce(array_agg(c.capability) filter (where c.capability is not null), '{}') as capabilities
       from roles r left join role_capabilities c on c.role_id = r.id
      where r.id = $1 group by r.id`,
    [id],
  );
  return rows[0] ?? null;
}

export async function roleByKey(key) {
  const { rows } = await query(
    `select r.${ROLE_COLUMNS.split(', ').join(', r.')},
            coalesce(array_agg(c.capability) filter (where c.capability is not null), '{}') as capabilities
       from roles r left join role_capabilities c on c.role_id = r.id
      where r.key = $1 group by r.id`,
    [key],
  );
  return rows[0] ?? null;
}

/** The role behind a session, resolved in one read on every request that needs it. */
export async function roleForAccount(accountId) {
  const { rows } = await query(
    `select r.id, r.key, r.label, r.doors, r.is_owner,
            coalesce(array_agg(c.capability) filter (where c.capability is not null), '{}') as capabilities
       from accounts a
       join roles r on r.id = a.role_id
       left join role_capabilities c on c.role_id = r.id
      where a.id = $1
      group by r.id`,
    [accountId],
  );
  return rows[0] ?? null;
}

export async function createRole({ key, label, description, doors, capabilities = [] }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into roles (key, label, description, doors, position)
       values ($1, $2, $3, $4, coalesce((select max(position) + 1 from roles), 0))
       returning ${ROLE_COLUMNS}`,
      [key, label, description ?? null, doors ?? ['client']],
    );
    for (const capability of capabilities) {
      await client.query('insert into role_capabilities (role_id, capability) values ($1, $2) on conflict do nothing', [rows[0].id, capability]);
    }
    return rows[0];
  });
}

/**
 * Change a role, capabilities and all.
 *
 * The capability set is replaced rather than merged: the screen sends the ticked
 * boxes, and a merge would make unticking one impossible.
 */
export async function updateRole(id, { label, description, doors, capabilities }) {
  return withTransaction(async (client) => {
    await client.query(
      `update roles set label = coalesce($2, label), description = coalesce($3, description),
                        doors = coalesce($4, doors), updated_at = now()
        where id = $1`,
      [id, label ?? null, description ?? null, doors ?? null],
    );
    if (Array.isArray(capabilities)) {
      await client.query('delete from role_capabilities where role_id = $1', [id]);
      for (const capability of capabilities) {
        await client.query('insert into role_capabilities (role_id, capability) values ($1, $2) on conflict do nothing', [id, capability]);
      }
    }
  });
}

export async function deleteRole(id) {
  const { rowCount } = await query('delete from roles where id = $1 and is_system = false', [id]);
  return rowCount;
}

export async function setAccountRole(accountId, roleId) {
  const { rows } = await query('update accounts set role_id = $2, updated_at = now() where id = $1 returning id, role_id', [accountId, roleId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------

export async function listPlans({ includeInactive = true } = {}) {
  const { rows } = await query(
    `select p.*, (select count(*)::int from accounts a where a.plan = p.key and a.status <> 'suspended') as people
       from plans p
      where $1 or p.active
      order by p.position, p.key`,
    [includeInactive],
  );
  return rows;
}

export async function updatePlan(key, { label, note, pricePence, callBound, active }) {
  const { rows } = await query(
    `update plans
        set label       = coalesce($2, label),
            note        = coalesce($3, note),
            price_pence = case when $4::text = 'unset' then null else coalesce($4::integer, price_pence) end,
            call_bound  = case when $5::text = 'unset' then null else coalesce($5::integer, call_bound) end,
            active      = coalesce($6, active),
            updated_at  = now()
      where key = $1
      returning *`,
    [key, label ?? null, note ?? null,
      pricePence === null ? 'unset' : pricePence == null ? null : String(pricePence),
      callBound === null ? 'unset' : callBound == null ? null : String(callBound),
      active ?? null],
  );
  return rows[0] ?? null;
}

/** What an account is worth a month, from the plan it is on. */
export async function priceOfPlan(key) {
  const { rows } = await query('select price_pence from plans where key = $1', [key]);
  return rows[0]?.price_pence ?? null;
}

/** Written whenever a plan or status changes, so a past month can still be priced. */
export function recordPlanChange(accountId, { plan, status, pricePence, note = null }) {
  return query(
    'insert into account_plan_history (account_id, plan, status, price_pence, note) values ($1, $2, $3, $4, $5)',
    [accountId, plan, status, pricePence ?? null, note],
  );
}

// ---------------------------------------------------------------------------
// the audit trail
// ---------------------------------------------------------------------------

export function writeAudit({ actorId, actorLabel, action, subjectType, subjectId, subjectLabel, before, after }) {
  return query(
    `insert into admin_audit (actor_id, actor_label, action, subject_type, subject_id, subject_label, before, after)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actorId ?? null, actorLabel ?? null, action, subjectType ?? null, subjectId ?? null, subjectLabel ?? null,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  ).catch(() => null); // an audit row must never be the reason an action fails
}

export async function listAudit({ limit = 200, subjectId = null } = {}) {
  const { rows } = await query(
    `select id, actor_id, actor_label, action, subject_type, subject_id, subject_label, before, after, at
       from admin_audit
      where ($2::text is null or subject_id = $2)
      order by at desc limit $1`,
    [limit, subjectId],
  );
  return rows;
}

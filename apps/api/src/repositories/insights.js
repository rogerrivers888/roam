/**
 * The business side of the back office: what Roam earns, what it costs to run,
 * and what that leaves.
 *
 * Two honesty rules, both taken from the Parcelvision reporting suite the owner
 * asked this to mirror:
 *
 *  - **A gap is labelled, never drawn as a zero.** PV's revenue screen says in
 *    as many words that subscription revenue is absent because Stripe is not
 *    connected, rather than showing £0 and letting somebody read it as "nobody
 *    is paying". Roam has no payment provider at all, so every figure here is
 *    *contracted* revenue — what the plans people are on are priced at — and the
 *    screens say so. Cash collected is not knowable from this database.
 *  - **Cost is real.** `provider_calls` is Roam's own ledger of its own
 *    spending, written on every outbound call, so cost per household is measured
 *    rather than apportioned.
 */

import { query } from '../db.js';

// ---------------------------------------------------------------------------
// what is earned
// ---------------------------------------------------------------------------

/**
 * Monthly recurring revenue, by plan, as it stands today.
 *
 * Suspended accounts are excluded: they cannot use Roam, so counting them as
 * revenue would flatter every figure derived from this one. `unpriced` is the
 * count of active households on a plan with no price — trials and friends —
 * because "how many people use this for free" is a business number too.
 */
export async function mrrByPlan() {
  const { rows } = await query(
    `select p.key, p.label, p.price_pence,
            count(a.id) filter (where a.status <> 'suspended')::int                              as households,
            coalesce(sum(p.price_pence) filter (where a.status <> 'suspended'), 0)::int          as mrr_pence,
            count(a.id) filter (where a.status <> 'suspended' and p.price_pence is null)::int    as unpriced
       from plans p
       left join accounts a on a.plan = p.key
      group by p.key, p.label, p.price_pence, p.position
      order by p.position`,
  );
  return rows;
}

/**
 * Contracted revenue month by month, from the plan history.
 *
 * A month is priced by what each account was on during it, so changing a price
 * today does not rewrite what last quarter earned. Accounts that predate the
 * history table are carried by their current plan, which is the only thing that
 * can be known about them and is marked `estimated` on the screen.
 */
export async function revenueByMonth({ months = 12 } = {}) {
  const { rows } = await query(
    `with span as (
       select generate_series(date_trunc('month', now()) - (($1 - 1) || ' months')::interval,
                              date_trunc('month', now()), '1 month') as month
     ),
     -- What each account was on at the end of each month: the latest history
     -- row up to that point, falling back to the account as it stands.
     state as (
       select s.month, a.id as account_id,
              coalesce(
                (select h.plan from account_plan_history h
                  where h.account_id = a.id and h.from_at < s.month + interval '1 month'
                  order by h.from_at desc limit 1),
                a.plan) as plan,
              coalesce(
                (select h.status from account_plan_history h
                  where h.account_id = a.id and h.from_at < s.month + interval '1 month'
                  order by h.from_at desc limit 1),
                a.status) as status,
              (a.created_at < s.month + interval '1 month') as existed
         -- Left-joined, not cross-joined: with nobody on the books the months
         -- still come back as zeros, and a chart of nothing is a chart rather
         -- than an empty screen that looks broken.
         from span s left join accounts a on true
     )
     select to_char(st.month, 'YYYY-MM') as month,
            count(*) filter (where st.existed and st.status <> 'suspended')::int as households,
            coalesce(sum(p.price_pence) filter (where st.existed and st.status <> 'suspended'), 0)::int as revenue_pence,
            count(*) filter (where st.existed and st.status <> 'suspended' and p.price_pence is not null)::int as paying
       from state st
       left join plans p on p.key = st.plan
      group by st.month
      order by st.month`,
    [months],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// what it costs
// ---------------------------------------------------------------------------

/** Provider spend by month, across the estate — the cost line under the revenue one. */
export async function costByMonth({ months = 12 } = {}) {
  const { rows } = await query(
    `select to_char(date_trunc('month', created_at), 'YYYY-MM') as month,
            count(*)::int as calls,
            coalesce(sum(estimated_cost_usd), 0)::float as cost_usd
       from provider_calls
      where created_at >= date_trunc('month', now()) - (($1 - 1) || ' months')::interval
      group by 1 order by 1`,
    [months],
  );
  return rows;
}

/** Which providers the money goes to. */
export async function costByProvider({ days = 30 } = {}) {
  const { rows } = await query(
    `select provider,
            count(*)::int as calls,
            coalesce(sum(estimated_cost_usd), 0)::float as cost_usd,
            count(distinct household_id)::int as households
       from provider_calls
      where created_at >= now() - ($1 || ' days')::interval
      group by provider
      order by cost_usd desc, calls desc`,
    [String(days)],
  );
  return rows;
}

/** What each household costs to serve, which is the number that decides a price. */
export async function costByHousehold({ days = 30 } = {}) {
  const { rows } = await query(
    `select household_id,
            count(*)::int as calls,
            coalesce(sum(estimated_cost_usd), 0)::float as cost_usd
       from provider_calls
      where household_id is not null and created_at >= now() - ($1 || ' days')::interval
      group by household_id`,
    [String(days)],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// the estate at a glance
// ---------------------------------------------------------------------------

/**
 * The headline figures.
 *
 * Everything here is a count of something real. Where a figure would need a
 * payment provider to be true it is not invented: `revenue_pence` is contracted,
 * not collected, and the tile that shows it says which.
 */
export async function estateTotals() {
  const { rows } = await query(
    `select
       (select count(*)::int from households)                                                 as households,
       (select count(*)::int from accounts)                                                   as accounts,
       (select count(*)::int from accounts where status = 'active')                           as active_accounts,
       (select count(*)::int from accounts where status = 'invited')                          as invited,
       (select count(*)::int from accounts where status = 'suspended')                        as suspended,
       (select count(*)::int from accounts where created_at >= date_trunc('month', now()))    as joined_this_month,
       (select count(*)::int from members)                                                    as people,
       (select count(*)::int from household_places)                                           as places,
       (select count(*)::int from trips)                                                      as trips,
       (select count(*)::int from visits)                                                     as visits,
       (select count(*)::int from ratings)                                                    as ratings,
       (select count(*)::int from api_sessions where revoked_at is null and expires_at > now()) as live_devices,
       (select coalesce(sum(estimated_cost_usd), 0)::float from provider_calls
         where created_at >= date_trunc('month', now()))                                      as cost_month_usd,
       (select coalesce(sum(estimated_cost_usd), 0)::float from provider_calls)               as cost_ever_usd,
       (select count(*)::int from provider_calls where created_at >= date_trunc('month', now())) as calls_month`,
  );
  return rows[0];
}

/**
 * How far into the month the estate is against its own ceilings — the number
 * that matters when every household draws on one set of free allowances.
 */
export async function ceilingPressure() {
  const { rows } = await query(
    `select a.id as account_id, a.email, a.monthly_call_bound,
            (select count(*)::int from provider_calls c
              where c.household_id = a.household_id and c.created_at >= date_trunc('month', now())) as calls
       from accounts a`,
  );
  return rows;
}

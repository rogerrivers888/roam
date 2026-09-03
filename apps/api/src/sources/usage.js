// Usage per provider from provider_calls: calls, billable units and estimated
// cost for a window, plus how much of each free allowance or Roam cap has gone.
// Feeds Settings › Usage and the source picker (Technical Constraints §14
// "cost per household per period, and cost per source").

import { query } from '../db.js';
import { LINES, legacyLines } from './pricing.js';

const EPOCH = new Date(0);
const FAR = new Date('2100-01-01T00:00:00Z');

const empty = () => ({ calls: 0, units: 0, costUsd: 0, estimated: false });

/** Per-line totals between two instants: {calls, units, costUsd, estimated} keyed by line, plus the overall total. */
export async function usageBetween(householdId, from = EPOCH, to = FAR) {
  const lines = Object.fromEntries(LINES.map((l) => [l.key, empty()]));
  const total = { calls: 0, costUsd: 0 };

  // Rows written with units: the provider counted what it billed for.
  const { rows: metered } = await query(
    `select k.key, count(*)::int as calls, coalesce(sum(k.value::numeric), 0)::float as units
       from provider_calls pc cross join lateral jsonb_each_text(case when jsonb_typeof(pc.units) = 'object' then pc.units else '{}'::jsonb end) k
      where pc.household_id = $1 and pc.created_at >= $2 and pc.created_at < $3
      group by k.key`,
    [householdId, from, to],
  );
  for (const r of metered) {
    if (!lines[r.key]) lines[r.key] = empty();
    lines[r.key].calls += r.calls;
    lines[r.key].units += r.units;
  }

  // Every row for the total, and the unmetered ones (Claude calls, rows from
  // before the units column) placed by provider and purpose with estimated units.
  // A row whose units is a bare number (a routes call that recorded its
  // element count without naming the line) is placed like a legacy row but
  // keeps its real count.
  const { rows } = await query(
    `select provider, purpose, (units is null or jsonb_typeof(units) <> 'object') as legacy, count(*)::int as calls, coalesce(sum(estimated_cost_usd), 0)::float as cost_usd,
            coalesce(sum(case when jsonb_typeof(units) = 'number' then (units #>> '{}')::numeric end), 0)::float as num_units
       from provider_calls where household_id = $1 and created_at >= $2 and created_at < $3
      group by provider, purpose, (units is null or jsonb_typeof(units) <> 'object')`,
    [householdId, from, to],
  );
  for (const r of rows) {
    total.calls += r.calls;
    total.costUsd += r.cost_usd;
    if (!r.legacy) continue;
    for (const { key, units } of legacyLines(r.provider, r.purpose)) {
      if (!lines[key]) lines[key] = empty();
      lines[key].calls += r.calls;
      lines[key].units += r.num_units > 0 ? r.num_units : units * r.calls;
      lines[key].costUsd += key === 'claude' || key === 'scout' ? r.cost_usd : 0;
      // Claude rows are exact (tokens are recorded); search rows are a guess.
      if (key !== 'claude' && key !== 'scout') lines[key].estimated = true;
    }
  }
  return { lines, total };
}

/** The calendar windows allowances live in, from the database clock so they match the caps' own queries. */
export async function windows() {
  const { rows: [w] } = await query(
    `select date_trunc('month', now()) as month_start, date_trunc('month', now()) - interval '1 month' as last_month_start,
            date_trunc('month', now()) + interval '1 month' as next_month_start, date_trunc('day', now()) as today_start,
            date_trunc('day', now()) + interval '1 day' as tomorrow_start, now() as now`,
  );
  return w;
}

/**
 * How much of each free allowance or cap has gone, whatever period the screen
 * is showing: monthly ones from the month so far, daily from today, lifetime
 * from everything. Returns {key: {used, limit, kind, resetsAt, estimated}}.
 */
export async function allowanceUsage(householdId) {
  const w = await windows();
  const [month, today, all] = await Promise.all([
    usageBetween(householdId, w.month_start, w.next_month_start),
    usageBetween(householdId, w.today_start, w.tomorrow_start),
    usageBetween(householdId),
  ]);
  const out = {};
  for (const line of LINES) {
    const a = line.allowance ?? line.cap;
    if (!a) continue;
    const stats = a.kind === 'monthly' ? month : a.kind === 'daily' ? today : all;
    const s = stats.lines[line.key] ?? empty();
    // Caps count calls (that is what the bound checks) — the household cap every
    // provider call, the scout cap its own runs; allowances count what the provider bills for.
    const used = line.cap?.countsAllCalls ? stats.total.calls : line.cap && !line.allowance ? s.calls : s.units;
    out[line.key] = {
      kind: a.kind, limit: a.limit, used: Math.round(used), estimated: s.estimated,
      resetsAt: a.kind === 'monthly' ? w.next_month_start : a.kind === 'daily' ? w.tomorrow_start : null,
    };
  }
  return { allowances: out, windows: w };
}

/**
 * Per-line totals by calendar month for the last `months` months, oldest
 * first, for the spend charts: {months: ['2025-10', …], lines: {key: [{month,
 * calls, units, costUsd, estimated}]}, total: [{month, calls, costUsd}]}.
 */
export async function usageByMonth(householdId, months = 12) {
  const w = await windows();
  const start = new Date(w.month_start);
  start.setUTCMonth(start.getUTCMonth() - (months - 1));
  const labels = [];
  for (let i = 0; i < months; i += 1) { const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + i); labels.push(d.toISOString().slice(0, 7)); }
  const blank = () => Object.fromEntries(labels.map((m) => [m, empty()]));
  const lines = Object.fromEntries(LINES.map((l) => [l.key, blank()]));
  const total = Object.fromEntries(labels.map((m) => [m, { calls: 0, costUsd: 0 }]));
  const bucket = (m) => (lines[m] ? lines[m] : (lines[m] = blank()));

  const { rows: metered } = await query(
    `select to_char(date_trunc('month', pc.created_at), 'YYYY-MM') as month, k.key, count(*)::int as calls, coalesce(sum(k.value::numeric), 0)::float as units
       from provider_calls pc cross join lateral jsonb_each_text(case when jsonb_typeof(pc.units) = 'object' then pc.units else '{}'::jsonb end) k
      where pc.household_id = $1 and pc.created_at >= $2
      group by 1, 2`,
    [householdId, start],
  );
  for (const r of metered) { if (!labels.includes(r.month)) continue; const b = bucket(r.key)[r.month]; b.calls += r.calls; b.units += r.units; }

  const { rows } = await query(
    `select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, provider, purpose, (units is null or jsonb_typeof(units) <> 'object') as legacy, count(*)::int as calls, coalesce(sum(estimated_cost_usd), 0)::float as cost_usd,
            coalesce(sum(case when jsonb_typeof(units) = 'number' then (units #>> '{}')::numeric end), 0)::float as num_units
       from provider_calls where household_id = $1 and created_at >= $2
      group by 1, 2, 3, 4`,
    [householdId, start],
  );
  for (const r of rows) {
    if (!labels.includes(r.month)) continue;
    total[r.month].calls += r.calls;
    total[r.month].costUsd += r.cost_usd;
    if (!r.legacy) continue;
    for (const { key, units } of legacyLines(r.provider, r.purpose)) {
      const b = bucket(key)[r.month];
      b.calls += r.calls; b.units += r.num_units > 0 ? r.num_units : units * r.calls;
      b.costUsd += key === 'claude' || key === 'scout' ? r.cost_usd : 0;
      if (key !== 'claude' && key !== 'scout') b.estimated = true;
    }
  }
  return {
    months: labels,
    lines: Object.fromEntries(Object.entries(lines).map(([k, byMonth]) => [k, labels.map((m) => ({ month: m, calls: byMonth[m].calls, units: Math.round(byMonth[m].units), costUsd: byMonth[m].costUsd, estimated: byMonth[m].estimated }))])),
    total: labels.map((m) => ({ month: m, ...total[m] })),
  };
}

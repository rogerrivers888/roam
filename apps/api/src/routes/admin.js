/**
 * The back office API.
 *
 * Mounted behind `requireDoor('admin')` (access.js), which answers 404 to
 * anybody without the door — so a household using Roam cannot discover that any
 * of this exists. Inside, each route names the capability it needs, and a
 * refusal there is a 403 that says which capability, because the caller is a
 * colleague who can go and ask for it.
 *
 * Where a screen mixes what somebody may see with what they may not — the
 * overview carries both people and money — the answer carries the part they
 * hold and marks the rest `withheld` rather than dropping it silently. A missing
 * tile reads as "there is nothing here"; a withheld one reads as "you may not
 * see this", and those are different facts.
 */

import express from 'express';
import { CAPABILITIES, DOORS, can, requires } from '../access.js';
import * as activity from '../repositories/activity.js';
import * as insights from '../repositories/insights.js';
import * as rolesRepo from '../repositories/roles.js';
import { accountById, listAccounts, signInsFor } from '../repositories/accounts.js';
import { householdById, membersWithConstraints } from '../repositories/households.js';
import { liveSessions } from '../repositories/sessions.js';

const router = express.Router();

const bad = (message, code = 'bad_request') => Object.assign(new Error(message), { status: 400, code });
const days = (req, fallback = 30) => Math.min(365, Math.max(1, Number(req.query.days) || fallback));

/** Who is doing this, for the audit trail. The passcode has no account row. */
const actor = (req) => ({
  actorId: req.account?.id ?? null,
  actorLabel: req.account?.email ?? 'the owner (passcode)',
});

// ---------------------------------------------------------------------------
// the overview
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/overview — the first screen: how many households, how busy
 * they are, what they earn and what they cost.
 */
router.get('/overview', async (req, res, next) => {
  try {
    const window = days(req, 30);
    const [totals, active, daily, screens, feed, installs] = await Promise.all([
      insights.estateTotals(),
      activity.activeCounts(),
      activity.estateDaily({ days: window }),
      activity.estateScreens({ days: window }),
      activity.estateFeed({ limit: 12 }),
      activity.installCounts({ days: window }),
    ]);

    const money = can(req, 'view_financials')
      ? await (async () => {
        const [byPlan, revenue, cost] = await Promise.all([
          insights.mrrByPlan(), insights.revenueByMonth({ months: 12 }), insights.costByMonth({ months: 12 }),
        ]);
        return {
          mrrPence: byPlan.reduce((n, p) => n + (p.mrr_pence || 0), 0),
          byPlan,
          revenue,
          cost,
          costMonthUsd: totals.cost_month_usd,
          // Said plainly wherever it is shown: nothing here has been collected,
          // because Roam has no payment provider. It is what the plans people
          // are on are priced at.
          basis: 'contracted',
        };
      })()
      : null;

    res.json({
      window: { days: window },
      totals,
      active: {
        ...active,
        // The one ratio worth a tile: how much of the month's audience is here
        // on any given day.
        stickiness: active.mau ? Math.round((active.dau / active.mau) * 100) : 0,
      },
      daily,
      screens,
      feed,
      // Roam has no store listing; it is an installable web app, so this is the
      // honest version of an install figure rather than a borrowed one.
      installs,
      money,
      withheld: money ? [] : ['view_financials'],
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// people
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/people — every account, with what it is on, what it has done
 * and what it has cost, in one read.
 *
 * The table is sorted and filtered on the client: this is an estate of
 * households, not a million rows, and a round trip per column sort would be
 * slower than the sort.
 */
router.get('/people', requires('view_accounts'), async (req, res, next) => {
  try {
    const window = days(req, 30);
    const [accounts, engagement, roles, plans, cost] = await Promise.all([
      listAccounts(),
      activity.engagementByAccount({ days: window }),
      rolesRepo.listRoles(),
      rolesRepo.listPlans(),
      insights.costByHousehold({ days: window }),
    ]);
    const byAccount = new Map(engagement.map((e) => [e.account_id, e]));
    const byHousehold = new Map(cost.map((c) => [c.household_id, c]));
    const roleById = new Map(roles.map((r) => [r.id, r]));

    res.json({
      window: { days: window },
      people: accounts.map((a) => {
        const e = byAccount.get(a.id);
        const c = byHousehold.get(a.household_id);
        return {
          id: a.id,
          householdId: a.household_id,
          householdName: a.household_name,
          email: a.email,
          name: a.name,
          status: a.status,
          plan: a.plan,
          role: a.role_id ? { id: a.role_id, key: roleById.get(a.role_id)?.key, label: roleById.get(a.role_id)?.label } : null,
          createdAt: a.created_at,
          lastSeenAt: a.last_seen_at,
          signInCount: a.sign_in_count,
          liveDevices: a.live_devices ?? 0,
          members: a.member_count ?? 0,
          trips: a.trip_count ?? 0,
          activity: {
            seconds: e?.seconds ?? 0,
            views: e?.views ?? 0,
            daysActive: e?.days_active ?? 0,
            lastActive: e?.last_active ?? null,
          },
          // Cost is money: withheld rather than zeroed for somebody without it.
          usage: can(req, 'view_financials')
            ? { calls: c?.calls ?? 0, costUsd: c?.cost_usd ?? 0, bound: a.monthly_call_bound }
            : null,
        };
      }),
      roles: roles.map((r) => ({ id: r.id, key: r.key, label: r.label, doors: r.doors, isOwner: r.is_owner })),
      plans: plans.map((p) => ({ key: p.key, label: p.label, pricePence: p.price_pence })),
      withheld: can(req, 'view_financials') ? [] : ['view_financials'],
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/people/:id — one household, everything about it.
 *
 * This is what the drawer opens on: who they are, what they are on, the people
 * in the household, what they have been doing, where their time goes, their
 * devices, and everything an administrator has ever done to them.
 */
router.get('/people/:id', requires('view_accounts'), async (req, res, next) => {
  try {
    const account = await accountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    const window = days(req, 30);
    const seeActivity = can(req, 'view_activity');

    const [household, members, sessions, signIns, audit, role] = await Promise.all([
      householdById(account.household_id),
      membersWithConstraints(account.household_id),
      liveSessions(account.id),
      signInsFor(account.id, 20),
      rolesRepo.listAudit({ subjectId: account.id, limit: 50 }),
      account.role_id ? rolesRepo.roleById(account.role_id) : null,
    ]);

    const behaviour = seeActivity
      ? await (async () => {
        const [summary, feed, screens, daily] = await Promise.all([
          activity.summaryFor(account.household_id, { days: window }),
          activity.feedFor(account.household_id, { limit: 60 }),
          activity.screensFor(account.household_id, { days: window }),
          activity.dailyFor(account.household_id, { days: window }),
        ]);
        return { summary, feed, screens, daily };
      })()
      : null;

    res.json({
      account: {
        id: account.id, email: account.email, name: account.name, status: account.status,
        plan: account.plan, trialEndsOn: account.trial_ends_on, note: account.note,
        createdAt: account.created_at, activatedAt: account.activated_at, lastSeenAt: account.last_seen_at,
        signInCount: account.sign_in_count, monthlyCallBound: account.monthly_call_bound,
        role: role ? { id: role.id, key: role.key, label: role.label, doors: role.doors } : null,
      },
      household: household ? {
        id: household.id, name: household.name, homeLabel: household.home_label,
        timezone: household.timezone, createdAt: household.created_at,
      } : null,
      // Names and dietary constraints, because a support question is usually
      // "why is Roam refusing to suggest anywhere" and the answer is an allergen.
      members: members.map((m) => ({
        id: m.id, name: m.name, relationship: m.relationship, isMinor: m.is_minor,
        allergens: (m.constraints ?? []).filter((c) => c.kind === 'allergen').length,
        dislikes: (m.constraints ?? []).filter((c) => c.kind === 'dislike').length,
      })),
      devices: sessions.map((s) => ({ id: s.id, label: s.label, since: s.created_at, lastSeen: s.last_seen_at, until: s.expires_at })),
      signIns: signIns.map((s) => ({ id: s.id, method: s.method, label: s.label, at: s.created_at })),
      audit,
      behaviour,
      withheld: seeActivity ? [] : ['view_activity'],
    });
  } catch (err) { next(err); }
});

/** PATCH /api/admin/people/:id/role — what somebody may do in the back office. */
router.patch('/people/:id/role', requires('manage_roles'), async (req, res, next) => {
  try {
    const account = await accountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not_found', message: 'No such account.' });
    const roleId = req.body?.roleId ?? null;
    const role = roleId ? await rolesRepo.roleById(roleId) : null;
    if (roleId && !role) throw bad('That is not a role.');

    // The owner's own role is not grantable or removable from here: an estate
    // with no owner is one nobody can administer, and this is the screen that
    // would have done it.
    if (role?.is_owner || (account.role === 'owner')) {
      throw bad('The owner role is not granted or removed from this screen.');
    }
    const before = account.role_id ? await rolesRepo.roleById(account.role_id) : null;
    await rolesRepo.setAccountRole(account.id, roleId);
    await rolesRepo.writeAudit({
      ...actor(req), action: 'role.grant', subjectType: 'account', subjectId: account.id, subjectLabel: account.email,
      before: before ? { role: before.key } : null, after: role ? { role: role.key } : null,
    });
    res.json({ account: { id: account.id, role: role ? { id: role.id, key: role.key, label: role.label } : null } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

/** GET /api/admin/activity — what has been happening, across every household. */
router.get('/activity', requires('view_activity'), async (req, res, next) => {
  try {
    const window = days(req, 30);
    const [feed, screens, daily, active] = await Promise.all([
      activity.estateFeed({ limit: Math.min(300, Number(req.query.limit) || 120) }),
      activity.estateScreens({ days: window }),
      activity.estateDaily({ days: window }),
      activity.activeCounts(),
    ]);
    res.json({ window: { days: window }, feed, screens, daily, active });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

/** GET /api/admin/reporting/engagement — are people coming back, and to what. */
router.get('/reporting/engagement', requires('view_reporting'), async (req, res, next) => {
  try {
    const window = days(req, 30);
    const [daily, active, screens, retention, engagement, accounts] = await Promise.all([
      activity.estateDaily({ days: window }),
      activity.activeCounts(),
      activity.estateScreens({ days: window }),
      activity.retentionCohorts({ weeks: 8 }),
      activity.engagementByAccount({ days: window }),
      listAccounts(),
    ]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    res.json({
      window: { days: window },
      daily,
      active: { ...active, stickiness: active.mau ? Math.round((active.dau / active.mau) * 100) : 0 },
      screens,
      retention,
      // Ranked, because "who is actually using this" is the question a
      // three-household estate asks and a chart of averages cannot answer.
      leaders: engagement
        .map((e) => ({
          accountId: e.account_id,
          email: byId.get(e.account_id)?.email ?? null,
          name: byId.get(e.account_id)?.name ?? null,
          seconds: e.seconds, views: e.views, daysActive: e.days_active, lastActive: e.last_active,
        }))
        .sort((a, b) => b.seconds - a.seconds || b.views - a.views),
    });
  } catch (err) { next(err); }
});

/** GET /api/admin/reporting/revenue — what the plans people are on are worth. */
router.get('/reporting/revenue', requires('view_financials'), async (req, res, next) => {
  try {
    const [byPlan, revenue, cost, plans, totals] = await Promise.all([
      insights.mrrByPlan(),
      insights.revenueByMonth({ months: 12 }),
      insights.costByMonth({ months: 12 }),
      rolesRepo.listPlans(),
      insights.estateTotals(),
    ]);
    const mrrPence = byPlan.reduce((n, p) => n + (p.mrr_pence || 0), 0);
    const paying = byPlan.reduce((n, p) => n + (p.price_pence ? p.households : 0), 0);
    res.json({
      // Named on the screen as well as here: none of this has been collected.
      // Roam holds no card and no payment provider, so "revenue" is what the
      // plans people are on are priced at, and cash is not knowable from here.
      basis: 'contracted',
      missing: ['collected', 'failed_payments', 'refunds'],
      mrrPence,
      arrPence: mrrPence * 12,
      paying,
      free: byPlan.reduce((n, p) => n + p.unpriced, 0),
      arpuPence: paying ? Math.round(mrrPence / paying) : 0,
      byPlan,
      revenue,
      cost,
      plans,
      totals,
    });
  } catch (err) { next(err); }
});

/** GET /api/admin/reporting/usage — where the provider money goes. */
router.get('/reporting/usage', requires('view_reporting'), async (req, res, next) => {
  try {
    const window = days(req, 30);
    const money = can(req, 'view_financials');
    const [byProvider, byHousehold, pressure, accounts] = await Promise.all([
      insights.costByProvider({ days: window }),
      insights.costByHousehold({ days: window }),
      insights.ceilingPressure(),
      listAccounts(),
    ]);
    const byHouseholdId = new Map(byHousehold.map((c) => [c.household_id, c]));
    res.json({
      window: { days: window },
      byProvider: byProvider.map((p) => (money ? p : { ...p, cost_usd: null })),
      households: accounts.map((a) => ({
        accountId: a.id,
        email: a.email,
        name: a.name,
        calls: byHouseholdId.get(a.household_id)?.calls ?? 0,
        costUsd: money ? (byHouseholdId.get(a.household_id)?.cost_usd ?? 0) : null,
        bound: a.monthly_call_bound,
        // How much of their own monthly ceiling has gone — the pressure figure,
        // which matters because every household draws on one set of allowances.
        used: pressure.find((p) => p.account_id === a.id)?.calls ?? 0,
      })),
      withheld: money ? [] : ['view_financials'],
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// roles, capabilities and plans
// ---------------------------------------------------------------------------

/** The vocabulary the roles screen is built from. Any admin door may read it. */
router.get('/capabilities', (_req, res) => res.json({ capabilities: CAPABILITIES, doors: DOORS }));

router.get('/roles', requires('view_accounts'), async (_req, res, next) => {
  try { res.json({ roles: await rolesRepo.listRoles(), capabilities: CAPABILITIES, doors: DOORS }); } catch (err) { next(err); }
});

router.post('/roles', requires('manage_roles'), async (req, res, next) => {
  try {
    const key = String(req.body?.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const label = String(req.body?.label || '').trim();
    if (!key || !label) throw bad('A role needs a name.');
    if (await rolesRepo.roleByKey(key)) throw bad('There is already a role with that name.');
    const role = await rolesRepo.createRole({
      key, label, description: req.body?.description ?? null,
      doors: Array.isArray(req.body?.doors) ? req.body.doors.filter((d) => DOORS.includes(d)) : ['client'],
      capabilities: (req.body?.capabilities ?? []).filter((c) => CAPABILITIES.some((x) => x.key === c)),
    });
    await rolesRepo.writeAudit({ ...actor(req), action: 'role.create', subjectType: 'role', subjectId: role.id, subjectLabel: label, after: req.body });
    res.status(201).json({ role: await rolesRepo.roleById(role.id) });
  } catch (err) { next(err); }
});

router.patch('/roles/:id', requires('manage_roles'), async (req, res, next) => {
  try {
    const before = await rolesRepo.roleById(req.params.id);
    if (!before) return res.status(404).json({ error: 'not_found', message: 'No such role.' });
    // The owner's role always holds everything; letting it be edited would be a
    // way to lock the estate's owner out of his own back office.
    if (before.is_owner) throw bad('The owner role holds every capability there is, and cannot be narrowed.');
    await rolesRepo.updateRole(req.params.id, {
      label: req.body?.label,
      description: req.body?.description,
      doors: Array.isArray(req.body?.doors) ? req.body.doors.filter((d) => DOORS.includes(d)) : undefined,
      capabilities: Array.isArray(req.body?.capabilities)
        ? req.body.capabilities.filter((c) => CAPABILITIES.some((x) => x.key === c))
        : undefined,
    });
    const after = await rolesRepo.roleById(req.params.id);
    await rolesRepo.writeAudit({
      ...actor(req), action: 'role.update', subjectType: 'role', subjectId: after.id, subjectLabel: after.label,
      before: { capabilities: before.capabilities, doors: before.doors },
      after: { capabilities: after.capabilities, doors: after.doors },
    });
    res.json({ role: after });
  } catch (err) { next(err); }
});

router.delete('/roles/:id', requires('manage_roles'), async (req, res, next) => {
  try {
    const role = await rolesRepo.roleById(req.params.id);
    if (!role) return res.status(404).json({ error: 'not_found', message: 'No such role.' });
    if (role.is_system) throw bad('That role is one Roam ships with. It can be changed, but not deleted.');
    const removed = await rolesRepo.deleteRole(req.params.id);
    await rolesRepo.writeAudit({ ...actor(req), action: 'role.delete', subjectType: 'role', subjectId: role.id, subjectLabel: role.label, before: role });
    res.json({ removed: removed > 0 });
  } catch (err) { next(err); }
});

router.get('/plans', requires('view_accounts'), async (_req, res, next) => {
  try { res.json({ plans: await rolesRepo.listPlans() }); } catch (err) { next(err); }
});

/** PATCH /api/admin/plans/:key — what a plan is called, what it costs, what it allows. */
router.patch('/plans/:key', requires('manage_plans'), async (req, res, next) => {
  try {
    const before = (await rolesRepo.listPlans()).find((p) => p.key === req.params.key);
    if (!before) return res.status(404).json({ error: 'not_found', message: 'No such plan.' });
    const plan = await rolesRepo.updatePlan(req.params.key, {
      label: req.body?.label,
      note: req.body?.note,
      // null is "not a paid plan", which is a different statement from 0.
      pricePence: req.body?.pricePence,
      callBound: req.body?.callBound,
      active: req.body?.active,
    });
    await rolesRepo.writeAudit({
      ...actor(req), action: 'plan.update', subjectType: 'plan', subjectId: plan.key, subjectLabel: plan.label,
      before: { pricePence: before.price_pence, callBound: before.call_bound },
      after: { pricePence: plan.price_pence, callBound: plan.call_bound },
    });
    res.json({ plan });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// governance
// ---------------------------------------------------------------------------

/** GET /api/admin/audit — who did what to whom. */
router.get('/audit', requires('view_audit'), async (req, res, next) => {
  try {
    res.json({ audit: await rolesRepo.listAudit({ limit: Math.min(500, Number(req.query.limit) || 200) }) });
  } catch (err) { next(err); }
});

export default router;

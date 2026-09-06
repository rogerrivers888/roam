// Group trips: a group hangs off a trip that already exists (Roam — Group Trips
// Requirements v1.0, and the mock-ups at /mockups/group-trips*.html).
//
// One organiser, a checklist of the things the trip already contains, and the
// people who have to do them. Three rules from the owner (4 Sep 2026) shape
// what is here:
//
//   * Roam chases, not the organiser. The schedule is computed from the date
//     everything is wanted by (domain/reminders.js); the organiser sees when
//     the next run goes and how many have gone, and sending by hand is there
//     but is not the way it works.
//   * An item is required or optional. Only required items are outstanding and
//     only they are chased; an optional one asks "are you coming to this?" so a
//     table can be booked for the right number.
//   * No money moves. A fee carries an amount and the organiser's own words and
//     is ticked off by hand. Nothing here touches a card.
//
// Two audiences, two doors. Everything under /api/trips/:id/group and
// /api/groups/:id is the organiser's, and is household-scoped like the rest of
// the API. Everything under /api/join/:token belongs to whoever holds the link:
// possession of the link is not proof of identity (Epic 3), so what it opens is
// the checklist and nothing about anybody else — no roster, no other person's
// state, no contact details.

import { Router } from 'express';
import crypto from 'node:crypto';
import { withTransaction } from '../db.js';
import * as groupsRepo from '../repositories/groups.js';
import * as tripsRepo from '../repositories/trips.js';
import * as accountsRepo from '../repositories/accounts.js';
import * as householdsRepo from '../repositories/households.js';
import { openSession } from '../auth.js';
import { currentHousehold, householdOf } from './household.js';
import { CADENCES, DEFAULT_CADENCE, QUIET_HOURS, dueRuns, nextRun, reminderBody, schedule } from '../domain/reminders.js';
import { channelReady, sendReminder } from '../sources/notify.js';
import { DEFAULT_TZ } from '../domain/time.js';

const router = Router();

const ITEM_KINDS = ['stay', 'activity', 'fee'];
const PARTICIPANT_STATUSES = ['booked', 'declared', 'in', 'out'];
const ALL_STATUSES = [...PARTICIPANT_STATUSES, 'paid'];
const token = (n = 9) => crypto.randomBytes(n).toString('base64url');
const ymd = (d) => (d ? String(d).slice(0, 10) : null);
const num = (v) => (v == null || v === '' ? null : Math.max(0, Math.round(Number(v))));
/** "Priya Shah" → "Priya S." */
const shortName = (name) => {
  const parts = String(name).trim().split(/\s+/);
  return parts.length < 2 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
};
const inWords = (d) => (d ? new Date(`${ymd(d)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');

async function loadGroup(groupId) {
  const group = await groupsRepo.groupById(groupId);
  if (!group) { const e = new Error('That group does not exist.'); e.status = 404; e.code = 'group_not_found'; throw e; }
  return group;
}

async function loadTrip(tripId) {
  const trip = await tripsRepo.tripById(tripId);
  if (!trip) { const e = new Error('Trip not found'); e.status = 404; e.code = 'trip_not_found'; throw e; }
  return trip;
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

const publicItem = (i) => ({
  id: i.id, kind: i.kind, required: i.required, label: i.label, detail: i.detail, venueRef: i.venue_ref,
  stopId: i.stop_id, amountPence: i.amount_pence, refundRule: i.refund_rule, refundUntil: ymd(i.refund_until), position: i.position,
  // What kind of thing it is: wanted from everybody, or an extra people opt into.
  applies: i.required ? 'everyone' : 'extra',
  pricing: i.pricing, totalPence: i.total_pence, perHead: i.per_head,
  expectedCount: i.expected_count, minimumCount: i.minimum_count, capacity: i.capacity,
  closesOn: ymd(i.closes_on), lateJoiners: i.late_joiners, state: i.state,
  settledPence: i.settled_pence, settledHeads: i.settled_heads, settledAt: i.settled_at, dueOn: ymd(i.due_on),
  cancelledNote: i.cancelled_note,
  // v2: when it happens, where it is booked, and the organiser's line for the guest.
  startsOn: ymd(i.starts_on), startsAt: i.starts_at?.slice(0, 5) ?? null, endsAt: i.ends_at?.slice(0, 5) ?? null,
  bookWhere: i.book_where, externalUrl: i.external_url, guestNote: i.guest_note,
});

/**
 * Is this item still wanted from this person?
 *
 * A cost that varies is nobody's debt until the day it closes — the price can
 * still move, so there is nothing true to ask for. Once it has closed, the
 * people on it owe the settled share. An extra nobody opted into is never
 * outstanding, and a cancelled item is never outstanding again.
 */
function stillWanted(item, state) {
  if (item.state === 'cancelled') return false;
  if (item.pricing === 'variable' && item.state !== 'closed') return false;
  if (item.required) return !isDone(state);
  return state?.status === 'in' && (item.pricing === 'fixed' || item.state === 'closed');
}

/** How many shares an item is divided by right now. */
function countHeads(item, joined, stateFor) {
  return joined.reduce((n, p) => {
    const st = stateFor.get(`${item.id}:${p.id}`);
    const counts = item.per_head ? p.heads : 1;
    if (item.required) return n + counts;                       // everybody on the trip
    return n + (st?.status === 'in' || st?.status === 'paid' ? counts : 0); // only the yeses
  }, 0);
}

/** A share is rounded up to the penny, so the amount to recover is always covered. */
const share = (totalPence, shares) => (shares > 0 && totalPence > 0 ? Math.ceil(totalPence / shares) : null);

/**
 * The money on one item, worked out rather than stored (Group charges, 4 Sep
 * 2026). An item for everyone divides by the trip's own numbers; an extra
 * divides by the people who said yes to it. The ceiling is the total over the
 * minimum — the most anybody can ever be asked for — and it is a promise, so it
 * is worked out the same way everywhere it is shown.
 */
export function costOf(item, group, headsNow) {
  const expected = item.expected_count ?? (item.required ? group.expected_count : null);
  const minimum = item.minimum_count ?? (item.required ? group.minimum_count : null);
  const closesOn = ymd(item.closes_on) ?? ymd(group.wanted_by);
  if (item.pricing !== 'variable') {
    return { expected, minimum, closesOn, perSharePence: item.amount_pence ?? null, ceilingPence: item.amount_pence ?? null, likelyPence: item.amount_pence ?? null, shares: headsNow };
  }
  const shares = item.state === 'closed' ? (item.settled_heads ?? headsNow) : headsNow;
  return {
    expected, minimum, closesOn, shares,
    perSharePence: item.state === 'closed' ? item.settled_pence : share(item.total_pence, shares),
    ceilingPence: share(item.total_pence, minimum),
    likelyPence: share(item.total_pence, expected),
  };
}

const publicState = (s) => (s ? {
  status: s.status, bookingRef: s.booking_ref, whereBooked: s.where_booked, startsOn: ymd(s.starts_on), endsOn: ymd(s.ends_on),
  amountPence: s.amount_pence, note: s.note, markedBy: s.marked_by, on: s.on_date,
} : null);

/** Done means "nothing more wanted from this person for this item". */
const isDone = (state) => Boolean(state) && ['booked', 'declared', 'paid'].includes(state.status);
/** An optional item is answered either way; an unanswered optional is not outstanding. */
const isAnswered = (state) => Boolean(state) && ALL_STATUSES.includes(state.status);

/**
 * What the organiser sees. The screen leads with what is outstanding and keeps
 * the roster underneath (the option chosen from the mock-ups), so this returns
 * both from one read rather than making the phone ask twice.
 */
export async function groupPayload(groupId) {
  const group = await loadGroup(groupId);
  const trip = await loadTrip(group.trip_id);
  // The group's own household, not the caller's. This is read through the
  // invite link too, which is public and has no account in the air, so "the
  // household this request is being served as" is the wrong question here —
  // whose group it is, is the right one.
  const household = (await householdOf(group.household_id)) ?? await currentHousehold();
  const tz = household.timezone || DEFAULT_TZ;
  const [items, people, states, reminders] = await Promise.all([
    groupsRepo.itemsOf(groupId),
    groupsRepo.participantsOf(groupId),
    groupsRepo.statesOf(groupId),
    groupsRepo.remindersOf(groupId),
  ]);

  const stateFor = new Map(states.map((s) => [`${s.item_id}:${s.participant_id}`, s]));
  const active = people.filter((p) => !p.withdrawn_at);
  const joined = active.filter((p) => p.joined_at);
  const remindersByPerson = new Map();
  for (const r of reminders) {
    if (!r.participant_id) continue;
    const list = remindersByPerson.get(r.participant_id) ?? [];
    list.push(r);
    remindersByPerson.set(r.participant_id, list);
  }

  const participants = people.map((p) => {
    const own = {};
    for (const i of items) {
      const s = stateFor.get(`${i.id}:${p.id}`);
      if (s) own[i.id] = publicState(s);
    }
    const outstanding = items
      .filter((i) => p.joined_at && !p.withdrawn_at && stillWanted(i, stateFor.get(`${i.id}:${p.id}`)))
      .map((i) => ({ id: i.id, label: i.label, kind: i.kind }));
    const sent = (remindersByPerson.get(p.id) ?? []).filter((r) => r.status === 'sent' || r.status === 'no_channel');
    return {
      id: p.id, name: p.name, contact: p.contact, contactKind: p.contact_kind, heads: p.heads, brings: p.brings,
      memberId: p.member_id, note: p.note, invitedAt: p.invited_at, joinedAt: p.joined_at, withdrawnAt: p.withdrawn_at,
      withdrawnNote: p.withdrawn_note, states: own, outstanding,
      reminders: sent.map((r) => ({ on: r.created_at, kind: r.kind, status: r.status, body: r.body })),
      lastRemindedAt: sent[0]?.created_at ?? null,
    };
  });

  const byId = new Map(participants.map((p) => [p.id, p]));
  const itemRows = items.map((i) => {
    const forItem = joined.map((p) => stateFor.get(`${i.id}:${p.id}`));
    const done = forItem.filter(isDone).length;
    const declared = forItem.filter((s) => s?.status === 'declared').length;
    const coming = forItem.filter((s) => s?.status === 'in').length;
    const notComing = forItem.filter((s) => s?.status === 'out').length;
    const missing = joined.filter((p) => (i.required ? !isDone(stateFor.get(`${i.id}:${p.id}`)) : !isAnswered(stateFor.get(`${i.id}:${p.id}`))));
    // Who the money is divided by: everybody on the trip, or the people who
    // said yes to the extra. A share is a head unless the organiser said party.
    const counts = (p) => (i.per_head ? p.heads : 1);
    const heads = countHeads(i, joined, stateFor);
    const cost = costOf(i, group, heads);
    const paidHeads = joined.reduce((n, p) => n + (stateFor.get(`${i.id}:${p.id}`)?.status === 'paid' ? counts(p) : 0), 0);
    const owingHeads = Math.max(0, heads - paidHeads);
    const money = i.pricing ? {
      ...cost,
      // Nobody owes anything on a varying cost until the day it closes.
      billed: i.pricing === 'fixed' || i.state === 'closed',
      paidPence: cost.perSharePence != null ? paidHeads * cost.perSharePence : null,
      duePence: cost.perSharePence != null ? owingHeads * cost.perSharePence : null,
      collectedPence: i.total_pence && heads ? Math.min(i.total_pence, paidHeads * (cost.perSharePence ?? 0)) : null,
    } : null;
    return {
      ...publicItem(i),
      done, declared, confirmed: done - declared, coming, notComing, heads,
      outstanding: missing.length,
      outstandingNames: missing.slice(0, 8).map((p) => p.name),
      money,
      // Kept for the screens written before costs had a life.
      paidPence: money?.paidPence ?? null,
      duePence: money?.duePence ?? null,
    };
  });

  // The wrong-weekend catch: the trip knows the dates, so a room booked for one
  // night of two is caught in September rather than in the car park.
  const warnings = [];
  for (const i of items.filter((x) => x.kind === 'stay')) {
    for (const p of joined) {
      const s = stateFor.get(`${i.id}:${p.id}`);
      if (!s || !s.starts_on || !s.ends_on || !trip.start_date || !trip.end_date) continue;
      const from = ymd(s.starts_on); const to = ymd(s.ends_on);
      if (from !== ymd(trip.start_date) || to !== ymd(trip.end_date)) {
        warnings.push({ kind: 'dates', participantId: p.id, name: p.name, itemId: i.id, item: i.label,
          said: `${inWords(from)} to ${inWords(to)}`, wanted: `${inWords(trip.start_date)} to ${inWords(trip.end_date)}` });
      }
    }
  }

  const runsDone = new Set(reminders.filter((r) => r.run_on).map((r) => ymd(r.run_on)));
  const next = nextRun(group, tz);
  // Who the next run would actually write to: the household's own people are
  // never chased by their own app, and neither is anybody with nothing to do.
  const nextRecipients = next ? active.filter((p) => !p.member_id && (!p.joined_at || byId.get(p.id)?.outstanding.length)).length : 0;
  const sentRows = reminders.filter((r) => r.participant_id && (r.status === 'sent' || r.status === 'no_channel'));

  return {
    group: {
      id: group.id, tripId: group.trip_id, name: group.name, expectedCount: group.expected_count,
      minimumCount: group.minimum_count, maximumCount: group.maximum_count, wantedBy: ymd(group.wanted_by), inviteToken: group.invite_token, closed: Boolean(group.closed_at),
      remindersOn: group.reminders_on, cadence: group.reminder_cadence, setupDone: group.setup_done,
      paymentMode: group.payment_mode,
      invite: {
        coverKind: group.cover_kind ?? 'banner', coverUrl: group.cover_url, coverSource: group.cover_source,
        title: group.invite_title, summary: group.invite_summary,
        howItWorks: Array.isArray(group.how_it_works) ? group.how_it_works : [],
      },
      firstReminderOn: ymd(group.first_reminder_on),
      cancelledAt: group.cancelled_at, cancelledNote: group.cancelled_note,
    },
    trip: {
      id: trip.id, title: trip.title, place: trip.place_label, startDate: ymd(trip.start_date), endDate: ymd(trip.end_date),
      base: trip.base_label ? { label: trip.base_label, kind: trip.base_kind } : null,
    },
    items: itemRows,
    participants,
    summary: {
      expected: group.expected_count ?? null,
      joined: joined.length,
      notJoined: active.length - joined.length,
      withdrawn: people.length - active.length,
      heads: joined.reduce((n, p) => n + p.heads, 0),
      complete: joined.filter((p) => !byId.get(p.id).outstanding.length).length,
      missing: joined.filter((p) => byId.get(p.id).outstanding.length).length,
    },
    reminders: {
      on: group.reminders_on,
      cadence: group.reminder_cadence,
      cadences: Object.entries(CADENCES).map(([key, c]) => ({ key, label: c.label, runs: c.count })),
      channelReady: channelReady(),
      schedule: schedule(group, tz).map((r) => ({ date: r.date, daysBefore: r.daysBefore, at: r.instant, done: runsDone.has(r.date) })),
      next: next ? { date: next.date, daysBefore: next.daysBefore, at: next.instant, recipients: nextRecipients } : null,
      written: sentRows.length,
      // The actual words a participant with something outstanding would get, so
      // the organiser reads the message rather than a description of it.
      preview: (() => {
        const who = participants.find((x) => x.joinedAt && !x.memberId && x.outstanding.length) ?? participants.find((x) => x.outstanding.length);
        const organiserName = participants.find((x) => x.memberId)?.name ?? household.name ?? 'The organiser';
        return reminderBody({
          organiser: organiserName,
          groupName: group.name,
          participant: who ?? { name: 'Sam' },
          outstanding: who?.outstanding ?? items.filter((i) => i.required).slice(0, 2).map((i) => ({ label: i.label })),
          wantedBy: ymd(group.wanted_by),
          joined: true,
          short: null,
        });
      })(),
      undelivered: sentRows.filter((r) => r.status === 'no_channel').length,
      recent: reminders.slice(0, 12).map((r) => ({
        id: r.id, on: r.created_at, runOn: ymd(r.run_on), kind: r.kind, status: r.status, reason: r.reason,
        who: r.participant_id ? (byId.get(r.participant_id)?.name ?? null) : null, body: r.body,
      })),
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The organiser's door
// ---------------------------------------------------------------------------

/**
 * GET /api/groups — the household's own groups.
 *
 * Two screens ask the same question and must not answer it differently: the
 * Who's coming row on a new trip ("one of these again?") and the Who filter on
 * Trips ("show me that group"). So the counts are worked out here, once.
 */
router.get('/groups', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const rows = await groupsRepo.groupsOfHousehold(household.id);
    res.json({
      groups: rows.map((g) => ({
        id: g.id, tripId: g.trip_id, name: g.name ?? g.trip_title, inviteToken: g.invite_token,
        organiser: g.organiser ?? null, setupDone: g.setup_done,
        closed: Boolean(g.closed_at), cancelled: Boolean(g.cancelled_at),
        expectedCount: g.expected_count, minimumCount: g.minimum_count, maximumCount: g.maximum_count,
        wantedBy: ymd(g.wanted_by),
        invited: Number(g.invited), joined: Number(g.joined), heads: Number(g.heads), outstanding: Number(g.outstanding),
        trip: { id: g.trip_id, title: g.trip_title, place: g.place_label, startDate: ymd(g.start_date), endDate: ymd(g.end_date) },
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/trips/:id/group — null when the trip is still a household trip. */
router.get('/trips/:id/group', async (req, res, next) => {
  try {
    const groupId = await groupsRepo.groupIdForTrip(req.params.id);
    if (!groupId) return res.json({ group: null });
    res.json(await groupPayload(groupId));
  } catch (err) { next(err); }
});

/**
 * POST /api/trips/:id/group — make a trip a group trip.
 * The checklist is proposed from the trip itself: where they are staying, and
 * the shortlist. Things to do are wanted from everybody; a meal is asked about
 * rather than required (owner, 4 Sep 2026), and the organiser edits either.
 */
router.post('/trips/:id/group', async (req, res, next) => {
  try {
    const household = await currentHousehold();
    const trip = await loadTrip(req.params.id);
    const b = req.body || {};
    const existingId = await groupsRepo.groupIdForTrip(trip.id);
    if (existingId) return res.status(409).json({ error: 'group_exists', message: 'This trip already has a group.', ...(await groupPayload(existingId)) });

    // Everything is wanted three weeks before the trip, unless that is already
    // past — a date to chase against is what gives "outstanding" its urgency.
    const start = ymd(trip.start_date) ?? ymd(trip.depart_at);
    const threeWeeksBefore = start ? new Date(new Date(`${start}T12:00:00Z`).getTime() - 21 * 86400000).toISOString().slice(0, 10) : null;
    const today = new Date().toISOString().slice(0, 10);
    const wantedBy = ymd(b.wantedBy) ?? (threeWeeksBefore && threeWeeksBefore > today ? threeWeeksBefore : start);

    const group = await withTransaction(async (client) => {
      const created = await groupsRepo.insertGroup(trip.id, household.id, {
        name: b.name?.trim() || trip.title || trip.place_label || 'The group',
        expectedCount: num(b.expectedCount), minimumCount: num(b.minimumCount), maximumCount: num(b.maximumCount),
        wantedBy, inviteToken: token(),
        remindersOn: b.remindersOn !== false,
        cadence: CADENCES[b.cadence] ? b.cadence : DEFAULT_CADENCE,
        // Chasing starts today unless the organiser moves it.
        firstReminderOn: new Date().toISOString().slice(0, 10),
      }, client);
      if (b.items !== false) {
        let position = 0;
        if (trip.base_label && trip.base_kind !== 'home') {
          await groupsRepo.insertItem(created.id, {
            kind: 'stay', required: true, label: `A room at ${trip.base_label}`,
            detail: start && ymd(trip.end_date) ? `${inWords(start)} – ${inWords(ymd(trip.end_date))} · everyone books their own` : 'Everyone books their own',
            position: position++,
          }, client);
        }
        const shortlist = await groupsRepo.shortlistForChecklist(trip.id, client);
        for (const s of shortlist.slice(0, 8)) {
          // A meal is asked about, not required: the organiser books the table, and what they need is a number.
          await groupsRepo.insertItem(created.id, {
            kind: 'activity', required: s.kind !== 'food', label: s.venue_label,
            detail: s.kind === 'food' ? 'Are you coming to this?' : null,
            venueRef: s.venue_ref, position: position++,
          }, client);
        }
      }
      // "Use again": the same people, asked again — by name and contact only,
      // never their answers to last time's trip.
      if (b.copyFromGroupId) {
        const before = await groupsRepo.participantsPlain(b.copyFromGroupId);
        for (const p of before) {
          if (p.member_id || p.withdrawn_at) continue;
          await groupsRepo.insertParticipant(created.id, {
            name: p.name, contact: p.contact, contactKind: p.contact_kind,
            heads: p.heads || 1, brings: p.brings, invitedAt: new Date(), token: token(),
          }, client);
        }
      }
      // The household's own people are in the group already; they never need a link.
      // Oldest member first: whoever set the household up is the organiser.
      const attendees = await groupsRepo.tripAttendeesOldestFirst(trip.id, client);
      // Whoever is looking at the app is the organiser (the web passes their
      // member id); otherwise the household's first grown-up.
      const adults = attendees.filter((a) => !a.is_minor).sort((x, y) => (x.id === b.organiserMemberId ? -1 : y.id === b.organiserMemberId ? 1 : 0));
      const minors = attendees.filter((a) => a.is_minor);
      if (adults[0]) {
        await groupsRepo.insertParticipant(created.id, {
          name: adults[0].name,
          heads: attendees.length || 1,
          brings: [...adults.slice(1), ...minors].map((a) => a.name).join(', ') || null,
          memberId: adults[0].id, joinedAt: new Date(), token: token(),
        }, client);
      }
      return created;
    });
    res.status(201).json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

/** PATCH /api/groups/:id — the name, the number expected, the date, and how Roam chases. */
router.patch('/groups/:id', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const b = req.body || {};
    const sets = []; const params = [group.id];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.name !== undefined) put('name', String(b.name).trim() || null);
    if (b.expectedCount !== undefined) put('expected_count', b.expectedCount == null ? null : Math.max(0, Number(b.expectedCount)));
    // The trip's own minimum means one thing: below it, the trip is cancelled.
    if (b.minimumCount !== undefined) put('minimum_count', num(b.minimumCount));
    if (b.maximumCount !== undefined) put('maximum_count', num(b.maximumCount));
    if (b.wantedBy !== undefined) put('wanted_by', ymd(b.wantedBy));
    if (b.remindersOn !== undefined) put('reminders_on', Boolean(b.remindersOn));
    if (b.cadence !== undefined) { if (!CADENCES[b.cadence]) return res.status(400).json({ error: 'bad_cadence' }); put('reminder_cadence', b.cadence); }
    if (b.firstReminderOn !== undefined) put('first_reminder_on', ymd(b.firstReminderOn));
    if (b.closed !== undefined) put('closed_at', b.closed ? new Date() : null);
    if (b.setupDone !== undefined) put('setup_done', Boolean(b.setupDone));
    if (b.paymentMode !== undefined) put('payment_mode', b.paymentMode === 'roam' ? 'roam' : 'direct');
    if (b.coverKind !== undefined) put('cover_kind', b.coverKind === 'full' ? 'full' : 'banner');
    if (b.coverUrl !== undefined) put('cover_url', b.coverUrl || null);
    if (b.coverSource !== undefined) put('cover_source', b.coverSource || null);
    if (b.inviteTitle !== undefined) put('invite_title', String(b.inviteTitle).slice(0, 40) || null);
    if (b.inviteSummary !== undefined) put('invite_summary', String(b.inviteSummary).slice(0, 160) || null);
    if (b.howItWorks !== undefined) {
      const points = (Array.isArray(b.howItWorks) ? b.howItWorks : []).map((x) => String(x).slice(0, 90)).filter(Boolean).slice(0, 4);
      put('how_it_works', JSON.stringify(points));
    }
    if (b.newLink) put('invite_token', token());
    if (!sets.length) return res.json(await groupPayload(group.id));
    await groupsRepo.updateGroup(group.id, sets, params);
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

/** DELETE /api/groups/:id — only while it is still empty (Epic 1, M2). */
router.delete('/groups/:id', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const joined = await groupsRepo.outsidersJoined(group.id);
    if (joined > 0) return res.status(409).json({ error: 'group_in_use', message: `${joined} people have already joined. Remove them first, or close the group instead.` });
    await groupsRepo.deleteGroup(group.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// --- the checklist ---------------------------------------------------------

router.post('/groups/:id/items', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const b = req.body || {};
    const kind = ITEM_KINDS.includes(b.kind) ? b.kind : 'activity';
    if (!b.label?.trim()) return res.status(400).json({ error: 'label_required', message: 'Say what you are asking people to do.' });
    if (kind === 'fee' && b.pricing !== 'variable' && !(Number(b.amountPence) > 0)) return res.status(400).json({ error: 'amount_required', message: 'An amount of nothing is not a thing to ask for.' });
    if (b.pricing === 'variable' && !(Number(b.totalPence) > 0)) return res.status(400).json({ error: 'total_required', message: 'Say what you have to get back in total.' });
    const position = await groupsRepo.nextItemPosition(group.id);
    const pricing = b.pricing === 'variable' ? 'variable' : (b.amountPence != null || kind === 'fee' ? 'fixed' : null);
    await groupsRepo.insertItem(group.id, {
      kind, required: b.required !== false, label: b.label.trim(), detail: b.detail?.trim() || null,
      venueRef: b.venueRef ?? null, stopId: b.stopId ?? null,
      amountPence: b.amountPence == null ? null : Math.round(Number(b.amountPence)),
      refundRule: b.refundRule ?? null, refundUntil: ymd(b.refundUntil), position,
      pricing, totalPence: b.totalPence == null ? null : Math.round(Number(b.totalPence)), perHead: b.perHead !== false,
      expectedCount: num(b.expectedCount), minimumCount: num(b.minimumCount), capacity: num(b.capacity),
      closesOn: ymd(b.closesOn),
      lateJoiners: ['capacity', 'no', 'ask'].includes(b.lateJoiners) ? b.lateJoiners : 'capacity',
      // v2: when it is, where it is booked, and the line the guest reads.
      startsOn: ymd(b.startsOn), startsAt: b.startsAt || null, endsAt: b.endsAt || null,
      bookWhere: ['roam', 'yourself', 'there'].includes(b.bookWhere) ? b.bookWhere : null,
      externalUrl: b.externalUrl?.trim() || null, guestNote: b.guestNote?.trim() || null,
    });
    res.status(201).json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

router.patch('/groups/:id/items/:itemId', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const b = req.body || {};
    const sets = []; const params = [req.params.itemId, group.id];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.label !== undefined) put('label', String(b.label).trim());
    if (b.detail !== undefined) put('detail', String(b.detail).trim() || null);
    if (b.required !== undefined) put('required', Boolean(b.required));
    if (b.amountPence !== undefined) put('amount_pence', b.amountPence == null ? null : Math.round(Number(b.amountPence)));
    if (b.refundRule !== undefined) put('refund_rule', b.refundRule || null);
    if (b.refundUntil !== undefined) put('refund_until', ymd(b.refundUntil));
    if (b.position !== undefined) put('position', Number(b.position));
    if (b.pricing !== undefined) put('pricing', b.pricing || null);
    if (b.totalPence !== undefined) put('total_pence', b.totalPence == null ? null : Math.round(Number(b.totalPence)));
    if (b.perHead !== undefined) put('per_head', Boolean(b.perHead));
    if (b.expectedCount !== undefined) put('expected_count', num(b.expectedCount));
    if (b.minimumCount !== undefined) put('minimum_count', num(b.minimumCount));
    if (b.capacity !== undefined) put('capacity', num(b.capacity));
    if (b.closesOn !== undefined) put('closes_on', ymd(b.closesOn));
    if (b.lateJoiners !== undefined && ['capacity', 'no', 'ask'].includes(b.lateJoiners)) put('late_joiners', b.lateJoiners);
    if (b.startsOn !== undefined) put('starts_on', ymd(b.startsOn));
    if (b.startsAt !== undefined) put('starts_at', b.startsAt || null);
    if (b.endsAt !== undefined) put('ends_at', b.endsAt || null);
    if (b.bookWhere !== undefined) put('book_where', ['roam', 'yourself', 'there'].includes(b.bookWhere) ? b.bookWhere : null);
    if (b.externalUrl !== undefined) put('external_url', b.externalUrl?.trim() || null);
    if (b.guestNote !== undefined) put('guest_note', b.guestNote?.trim() || null);
    if (b.state !== undefined && ['open', 'closed', 'cancelled'].includes(b.state)) put('state', b.state);
    if (!sets.length) return res.json(await groupPayload(group.id));
    const before = await groupsRepo.itemOfGroup(req.params.itemId, group.id);
    await groupsRepo.updateItem(req.params.itemId, group.id, sets, params);
    const after = await groupsRepo.itemOfGroup(req.params.itemId, group.id);
    await reofferIfDearer(group, before, after);
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

/**
 * “It will not cost you more than £30” is the reason anybody said yes, so if the
 * ceiling goes up — a dearer quote, a lower minimum — everyone who said yes to
 * it is asked again. Their yes is cleared and they are told the new figure;
 * saying nothing now means they are not on it.
 */
async function reofferIfDearer(group, before, after) {
  if (!before || !after || after.pricing !== 'variable') return;
  const was = costOf(before, group, 0).ceilingPence;
  const now = costOf(after, group, 0).ceilingPence;
  if (!now || (was && now <= was)) return;
  const onIt = await groupsRepo.participantsOnItem(after.id);
  if (!onIt.length) return;
  await groupsRepo.clearAllYesses(after.id);
  for (const p of onIt) {
    await tellOne(group, p, `${after.label} could now cost up to £${(now / 100).toFixed(2)} each, not £${((was ?? 0) / 100).toFixed(2)}. Say again whether you want it.`, 'reoffer', after.id);
  }
}

/** Removing something people have already done is blocked, and says how many (Epic 2, AC4). */
router.delete('/groups/:id/items/:itemId', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const acted = await groupsRepo.actedOnCount(req.params.itemId, group.id);
    if (acted > 0) return res.status(409).json({ error: 'item_in_use', message: `${acted} ${acted === 1 ? 'person has' : 'people have'} already done this one. Change what it says instead of removing it.` });
    await groupsRepo.deleteItem(req.params.itemId, group.id);
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

// --- the people ------------------------------------------------------------

/** Add someone by name before they join, so their join lands on that row (Epic 3, AC4). */
router.post('/groups/:id/participants', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const b = req.body || {};
    if (!b.name?.trim()) return res.status(400).json({ error: 'name_required', message: 'A name is the whole point of adding somebody.' });
    await groupsRepo.insertParticipant(group.id, {
      name: b.name.trim(),
      contact: b.contact?.trim() || null,
      contactKind: b.contactKind ?? (String(b.contact ?? '').includes('@') ? 'email' : b.contact ? 'mobile' : null),
      heads: Math.max(1, Number(b.heads) || 1),
      brings: b.brings?.trim() || null, note: b.note?.trim() || null,
      invitedAt: new Date(), token: token(),
    });
    res.status(201).json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

router.patch('/groups/:id/participants/:pid', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const b = req.body || {};
    const sets = []; const params = [req.params.pid, group.id];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.name !== undefined) put('name', String(b.name).trim());
    if (b.contact !== undefined) put('contact', String(b.contact).trim() || null);
    if (b.contactKind !== undefined) put('contact_kind', b.contactKind || null);
    if (b.heads !== undefined) put('heads', Math.max(1, Number(b.heads) || 1));
    if (b.brings !== undefined) put('brings', String(b.brings).trim() || null);
    if (b.note !== undefined) put('note', String(b.note).trim() || null);
    if (b.withdrawn !== undefined) { put('withdrawn_at', b.withdrawn ? new Date() : null); put('withdrawn_note', b.withdrawn ? (b.withdrawnNote?.trim() || null) : null); }
    if (!sets.length) return res.json(await groupPayload(group.id));
    await groupsRepo.updateParticipant(req.params.pid, group.id, sets, params);
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

router.delete('/groups/:id/participants/:pid', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    await groupsRepo.deleteParticipant(req.params.pid, group.id);
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

/**
 * The organiser marking something for somebody: the fee ticked off as the money
 * reaches them, or a booking they were told about in the pub. `markedBy` keeps
 * it apart from what the participant said themselves.
 */
router.post('/groups/:id/participants/:pid/items/:itemId', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const b = req.body || {};
    const item = await groupsRepo.itemOfGroup(req.params.itemId, group.id);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    if (b.status === 'clear' || b.status === null) {
      await groupsRepo.clearState(req.params.itemId, req.params.pid);
      return res.json(await groupPayload(group.id));
    }
    if (!ALL_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad_status', message: `status must be one of ${ALL_STATUSES.join(', ')}` });
    await groupsRepo.setState(req.params.itemId, req.params.pid, {
      status: b.status, bookingRef: b.bookingRef?.trim() || null, whereBooked: b.whereBooked?.trim() || null,
      startsOn: ymd(b.startsOn), endsOn: ymd(b.endsOn),
      amountPence: b.amountPence ?? item.amount_pence ?? null, note: b.note?.trim() || null,
      markedBy: 'organiser',
    });
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

/**
 * The closing day, by hand: close it and send the bill, give it another week,
 * or call it off. Roam does this by itself on the day (runDueClosings) — this
 * is the organiser being asked first, which is what the first time should be.
 */
router.post('/groups/:id/items/:itemId/close', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const item = await groupsRepo.itemOfGroup(req.params.itemId, group.id);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    const action = req.body?.action;

    if (action === 'extend') {
      const until = ymd(req.body?.closesOn);
      if (!until) return res.status(400).json({ error: 'date_required', message: 'Say the new date.' });
      await groupsRepo.setItemState(item.id, { closesOn: until, state: 'open' });
      return res.json(await groupPayload(group.id));
    }
    if (action === 'cancel') {
      await groupsRepo.setItemState(item.id, { state: 'cancelled', cancelledNote: req.body?.note?.trim() || 'Called off by the organiser.' });
      return res.json(await groupPayload(group.id));
    }
    if (action === 'reopen') {
      await groupsRepo.setItemState(item.id, { state: 'open', clearSettlement: true });
      return res.json(await groupPayload(group.id));
    }
    // Close it: whoever is on it now is who it is divided by, and that is the price.
    const [people, states] = await Promise.all([
      groupsRepo.joinedParticipants(group.id),
      groupsRepo.statesOf(group.id),
    ]);
    const stateFor = new Map(states.map((st) => [`${st.item_id}:${st.participant_id}`, st]));
    const onIt = people.filter((p) => (item.required ? true : ['in', 'paid'].includes(stateFor.get(`${item.id}:${p.id}`)?.status)));
    const shares = onIt.reduce((n, p) => n + (item.per_head ? p.heads : 1), 0);
    const cost = costOf(item, group, shares);
    if (cost.minimum && shares < cost.minimum && !req.body?.anyway) {
      return res.status(409).json({ error: 'below_minimum', message: `${shares} of the ${cost.minimum} it needs. Call it off, give it longer, or run it anyway.`, shares, minimum: cost.minimum, perSharePence: cost.perSharePence });
    }
    // The ceiling is a promise, and it is not the organiser's to quietly break:
    // a higher share is a new offer, which means changing the numbers so that
    // everybody on it is asked again (PATCH clears their yes and tells them).
    if (cost.ceilingPence && cost.perSharePence > cost.ceilingPence) {
      return res.status(409).json({
        error: 'over_ceiling', shares, perSharePence: cost.perSharePence, ceilingPence: cost.ceilingPence,
        message: `That is £${(cost.perSharePence / 100).toFixed(2)} each and you told them no more than £${(cost.ceilingPence / 100).toFixed(2)}. Change what it needs to get back or the minimum, and everyone on it will be asked again.`,
      });
    }
    const closesOn = ymd(item.closes_on) ?? ymd(group.wanted_by) ?? new Date().toISOString().slice(0, 10);
    const due = new Date(`${closesOn}T12:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 4);
    await groupsRepo.setItemState(item.id, { state: 'closed', settledHeads: shares, settledPence: cost.perSharePence, settledAt: true, dueOn: ymd(due.toISOString()) });
    for (const p of onIt) {
      const owed = (cost.perSharePence ?? 0) * (item.per_head ? p.heads : 1);
      await tellOne(group, p, `${item.label} is settled: £${(owed / 100).toFixed(2)} — ${shares} of us, by ${inWords(ymd(due.toISOString()))}.`, 'bill', item.id);
    }
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

// --- chasing ---------------------------------------------------------------

/**
 * Write the reminders for one run and try to send them.
 * `runOn` is the dated run this belongs to (null when the organiser asked for
 * it by hand). Returns what was written, so both the loop and the button can
 * report the same thing.
 */
async function writeReminders(group, { runOn = null, only = null, itemId = null } = {}) {
  const payload = await groupPayload(group.id);
  // Reminders are written by the loop as well as by the organiser tapping, and
  // the loop belongs to nobody: the organiser's name comes from the group's own
  // household rather than from whoever's request is in flight.
  const household = (await householdOf(group.household_id)) ?? await currentHousehold();
  const organiser = payload.participants.find((p) => p.memberId)?.name ?? household.name ?? 'The organiser';
  const written = [];
  const now = Date.now();
  // The one thing a group can fix together: a cost that has not reached the
  // number it needs. The shortest-handed open cost goes in every reminder.
  const short = payload.items
    .filter((i) => i.state === 'open' && i.money?.minimum && i.money.shares < i.money.minimum)
    .map((i) => ({ label: i.label, more: i.money.minimum - i.money.shares }))
    .sort((a, b) => a.more - b.more)[0] ?? null;

  for (const p of payload.participants) {
    if (p.withdrawnAt) continue;
    // The household's own people are not chased by their own app.
    if (p.memberId && !(only && only.includes(p.id))) continue;
    if (only && !only.includes(p.id)) continue;
    const outstanding = itemId ? p.outstanding.filter((o) => o.id === itemId) : p.outstanding;
    const joined = Boolean(p.joinedAt);
    if (joined && !outstanding.length) continue;                       // nothing to say (Epic 6, AC6)
    if (!joined && group.closed_at) continue;
    // Nobody is written to twice inside the quiet window, however the runs fall.
    if (p.lastRemindedAt && now - new Date(p.lastRemindedAt).getTime() < QUIET_HOURS * 3600_000) continue;

    const body = reminderBody({ organiser, groupName: payload.group.name, participant: p, outstanding, wantedBy: payload.group.wantedBy, joined, short });
    const outcome = await sendReminder({ to: p.contact, contactKind: p.contactKind, body, group: payload.group.name, participant: p.name });
    const written_ = await groupsRepo.writeReminder(group.id, {
      participantId: p.id, itemId, runOn, kind: joined ? 'outstanding' : 'join',
      status: outcome.status === 'failed' ? 'no_channel' : outcome.status,
      reason: outcome.detail, channel: outcome.channel, body,
      sentAt: outcome.status === 'sent' ? new Date() : null,
    });
    if (written_) written.push({ participant: p.name, status: written_.status });
  }

  // A run always leaves a mark, even when it had nothing to write, so it is
  // never done twice and the organiser can see it happened.
  if (runOn) {
    await groupsRepo.markRun(
      group.id, runOn,
      written.length ? null : 'Nobody had anything outstanding.',
      `${written.length} reminder${written.length === 1 ? '' : 's'} written on ${runOn}.`,
    );
  }
  return written;
}

/** POST /api/groups/:id/reminders — send now, by hand. The option, not the way it works. */
router.post('/groups/:id/reminders', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const b = req.body || {};
    const written = await writeReminders(group, { only: Array.isArray(b.participantIds) && b.participantIds.length ? b.participantIds : null, itemId: b.itemId ?? null });
    const payload = await groupPayload(group.id);
    res.json({ ...payload, wrote: written });
  } catch (err) { next(err); }
});

/**
 * The loop that makes reminders "out of the box" true: every group with a date
 * and chasing switched on is checked, and any run whose morning has passed is
 * done once. Started from server.js; safe to call at any time.
 */
export async function runDueReminders(now = new Date()) {
  const groups = await groupsRepo.groupsToChase();
  let runs = 0;
  for (const group of groups) {
    // Each group is chased in its own household's timezone. With one household
    // that was the same thing as "the household"; with accounts it is not, and
    // a friend's Saturday must not be chased on the owner's clock.
    const household = await householdOf(group.household_id).catch(() => null);
    const tz = household?.timezone || DEFAULT_TZ;
    const done = await groupsRepo.reminderRunsDone(group.id);
    const doneDates = new Set(done.map((r) => ymd(r.run_on)));
    for (const run of dueRuns(group, tz, now, doneDates)) {
      await writeReminders(group, { runOn: run.date });
      runs += 1;
    }
  }
  return runs;
}

/**
 * The closing day, which is the whole design of a varying cost.
 *
 * On the day a cost closes, the headcount stops moving and so does the price:
 * whoever is on it owes the settled share, due four days later, and that is
 * also the day it stops being refundable, because that is the day the
 * organiser's own money leaves. Under its minimum it is cancelled instead and
 * nobody is charged anything, because nobody was ever charged anything.
 *
 * The trip's own minimum works the same way one level up: below it on the
 * group's date, the whole trip is called off and everybody is told.
 */
export async function runDueClosings(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const groups = await groupsRepo.liveGroups();
  let closed = 0;
  for (const group of groups) {
    const [people, items, states] = await Promise.all([
      groupsRepo.activeParticipants(group.id),
      groupsRepo.itemsOf(group.id),
      groupsRepo.statesOf(group.id),
    ]);
    const joined = people.filter((p) => p.joined_at);
    const stateFor = new Map(states.map((st) => [`${st.item_id}:${st.participant_id}`, st]));

    // The trip's own minimum, judged on the group's date.
    const heads = joined.reduce((n, p) => n + p.heads, 0);
    if (group.minimum_count && ymd(group.wanted_by) && ymd(group.wanted_by) <= today && heads < group.minimum_count) {
      const note = `${heads} of the ${group.minimum_count} needed by ${inWords(group.wanted_by)}.`;
      await groupsRepo.cancelGroup(group.id, note);
      await tellEveryone(group, joined, `${group.name ?? 'The trip'} is off — ${note} Nothing has been taken from you.`, 'cancelled');
      closed += 1;
      continue;
    }

    for (const item of items) {
      if (item.state !== 'open' || item.pricing !== 'variable') continue;
      const closesOn = ymd(item.closes_on) ?? ymd(group.wanted_by);
      if (!closesOn || closesOn > today) continue;
      const onIt = joined.filter((p) => (item.required ? true : ['in', 'paid'].includes(stateFor.get(`${item.id}:${p.id}`)?.status)));
      const shares = onIt.reduce((n, p) => n + (item.per_head ? p.heads : 1), 0);
      const cost = costOf(item, group, shares);

      if (cost.minimum && shares < cost.minimum) {
        const note = `${shares} of the ${cost.minimum} it needed.`;
        await groupsRepo.setItemState(item.id, { state: 'cancelled', cancelledNote: note });
        await tellEveryone(group, onIt, `${item.label} is off — ${note} Nothing to pay.`, 'cancelled', item.id);
      } else {
        const due = new Date(`${closesOn}T12:00:00Z`);
        due.setUTCDate(due.getUTCDate() + 4);
        await groupsRepo.setItemState(item.id, { state: 'closed', settledHeads: shares, settledPence: cost.perSharePence, settledAt: true, dueOn: ymd(due.toISOString()) });
        for (const p of onIt) {
          const owed = (cost.perSharePence ?? 0) * (item.per_head ? p.heads : 1);
          await tellOne(group, p, `${item.label} is settled: £${(owed / 100).toFixed(2)} — ${shares} of us, by ${inWords(ymd(due.toISOString()))}.`, 'bill', item.id);
        }
      }
      closed += 1;
    }
  }
  return closed;
}

/** One line to everybody who is affected, kept whether or not it can be sent. */
async function tellEveryone(group, people, body, kind, itemId = null) {
  for (const p of people) await tellOne(group, p, body, kind, itemId);
}

async function tellOne(group, participant, body, kind, itemId = null) {
  const outcome = await sendReminder({ to: participant.contact, contactKind: participant.contact_kind, body, group: group.name, participant: participant.name });
  await groupsRepo.writeReminder(group.id, {
    participantId: participant.id, itemId, kind,
    status: outcome.status === 'failed' ? 'no_channel' : outcome.status,
    reason: outcome.detail, channel: outcome.channel, body,
    sentAt: outcome.status === 'sent' ? new Date() : null,
  });
}

export function startReminderLoop({ everyMinutes = 15 } = {}) {
  const tick = () => runDueClosings()
    .then(() => runDueReminders())
    .catch((err) => console.error('[groups] group run failed:', err.message));
  setTimeout(tick, 20_000).unref?.();
  const timer = setInterval(tick, everyMinutes * 60_000);
  timer.unref?.();
  return timer;
}

// ---------------------------------------------------------------------------
// The link's door: whoever is holding it
// ---------------------------------------------------------------------------

async function groupByToken(inviteToken) {
  const group = await groupsRepo.groupByInviteToken(inviteToken);
  if (!group) { const e = new Error('That link is not in use any more. Ask whoever invited you for a new one.'); e.status = 404; e.code = 'link_unknown'; throw e; }
  return group;
}

/**
 * What a link opens. The trip, the checklist, and how many are coming — and
 * nothing about any other person, whoever is holding it. `?p=` is a
 * participant's own token, kept by their device, which adds their own state and
 * nothing else.
 */
async function joinPayload(group, participantToken) {
  const trip = await loadTrip(group.trip_id);
  const [items, people] = await Promise.all([
    groupsRepo.itemsOf(group.id),
    groupsRepo.participantsPlain(group.id),
  ]);
  const active = people.filter((p) => !p.withdrawn_at);
  const me = participantToken ? active.find((p) => p.token === participantToken) : null;
  const organiser = people.find((p) => p.member_id);
  // Every state, but only ever counted — a participant is told how many are on
  // a coach, never who they are.
  const allStates = await groupsRepo.statesOf(group.id);
  const byItem = new Map(allStates.map((st) => [`${st.item_id}:${st.participant_id}`, st]));
  const mine = new Map(allStates.filter((st) => me && st.participant_id === me.id).map((st) => [st.item_id, st]));

  return {
    group: {
      name: group.name, wantedBy: ymd(group.wanted_by), closed: Boolean(group.closed_at),
      cancelled: Boolean(group.cancelled_at), cancelledNote: group.cancelled_note,
      organiser: organiser?.name ?? null, expectedCount: group.expected_count, minimumCount: group.minimum_count, maximumCount: group.maximum_count,
      // Which control every priced row shows on Book your itinerary depends on
      // it, so the guest is told how they pay before they are asked to.
      paymentMode: group.payment_mode ?? 'direct',
      // Whether a six-digit code can actually be sent anywhere. Roam has no
      // message channel until NOTIFY_WEBHOOK_URL is set, and the account screen
      // says which of the two things is about to happen rather than promising a
      // text nobody can send.
      canSendCode: channelReady(),
      joined: active.filter((p) => p.joined_at).length, heads: active.filter((p) => p.joined_at).reduce((n, p) => n + p.heads, 0),
    },
    trip: {
      title: trip.title, place: trip.place_label, startDate: ymd(trip.start_date), endDate: ymd(trip.end_date),
      base: trip.base_label && trip.base_kind !== 'home' ? { label: trip.base_label } : null,
    },
    items: items.map((i) => {
      const st = mine.get(i.id);
      const heads = countHeads(i, active.filter((p) => p.joined_at), byItem);
      const cost = i.pricing ? costOf(i, group, heads) : null;
      const shares = me ? (i.per_head ? me.heads : 1) : 1;
      return {
        ...publicItem(i),
        mine: publicState(st),
        // What it would cost them: the share now, the most it could ever be,
        // and what it will probably come out at. Nothing is owed until it closes.
        money: cost ? {
          heads, shares,
          perSharePence: cost.perSharePence, ceilingPence: cost.ceilingPence, likelyPence: cost.likelyPence,
          yoursPence: cost.perSharePence == null ? null : cost.perSharePence * shares,
          ceilingYoursPence: cost.ceilingPence == null ? null : cost.ceilingPence * shares,
          likelyYoursPence: cost.likelyPence == null ? null : cost.likelyPence * shares,
          minimum: cost.minimum, expected: cost.expected, closesOn: cost.closesOn,
          billed: i.pricing === 'fixed' || i.state === 'closed',
          dueOn: ymd(i.due_on),
        } : null,
      };
    }),
    // The invite page, as the organiser wrote it, with everything else drawn
    // from the group so it cannot drift (Epic 3).
    invite: {
      coverKind: group.cover_kind ?? 'banner', coverUrl: group.cover_url,
      title: group.invite_title || group.name || trip.title,
      summary: group.invite_summary,
      howItWorks: Array.isArray(group.how_it_works) ? group.how_it_works : [],
      placesLeft: group.maximum_count ? Math.max(0, group.maximum_count - active.filter((p) => p.joined_at).reduce((n, p) => n + p.heads, 0)) : null,
    },
    // Only so a join can be offered as "are you Priya S.?" rather than a form.
    // Anyone can be holding this link, so the surname is not theirs to read:
    // enough to recognise yourself, not enough to learn who else was asked.
    expecting: me ? [] : active.filter((p) => !p.joined_at).map((p) => ({ id: p.id, name: shortName(p.name) })),
    you: me ? {
      id: me.id, name: me.name, heads: me.heads, brings: me.brings, joinedAt: me.joined_at,
      outstanding: items.filter((i) => i.required && !isDone(mine.get(i.id))).length,
    } : null,
  };
}

/** GET /api/join/:token — the checklist behind the link. */
router.get('/join/:token', async (req, res, next) => {
  try {
    const group = await groupByToken(req.params.token);
    res.json(await joinPayload(group, req.query.p ? String(req.query.p) : null));
  } catch (err) { next(err); }
});

/**
 * POST /api/join/:token — I'm coming.
 * Joining is a name, one contact and how many are with them. If the organiser
 * had already added that name, the join lands on that row rather than making a
 * second one, and opening the link again resumes rather than duplicating.
 */
router.post('/join/:token', async (req, res, next) => {
  try {
    const group = await groupByToken(req.params.token);
    if (group.closed_at) return res.status(409).json({ error: 'group_closed', message: 'This group is not taking any more people.' });
    if (group.maximum_count) {
      const heads = await groupsRepo.headsJoined(group.id);
      if (heads >= group.maximum_count) {
        return res.status(409).json({ error: 'group_full', message: `This trip is full — ${heads} of ${group.maximum_count}. Ask whoever invited you.` });
      }
    }
    const b = req.body || {};
    const name = b.name?.trim();
    if (!name) return res.status(400).json({ error: 'name_required', message: 'Give a name they will recognise.' });
    const contact = b.contact?.trim() || null;
    const contactKind = b.contactKind ?? (contact?.includes('@') ? 'email' : contact ? 'mobile' : null);
    const heads = Math.max(1, Number(b.heads) || 1);

    const people = await groupsRepo.participantsPlain(group.id);
    const match = people.find((p) => p.id === b.matchId && !p.joined_at && !p.withdrawn_at)
      ?? people.find((p) => !p.joined_at && !p.withdrawn_at && p.name.trim().toLowerCase() === name.toLowerCase());
    let me;
    if (match) {
      me = await groupsRepo.joinOntoParticipant(match.id, { name, contact, contactKind, heads, brings: b.brings?.trim() || null, token: token() });
    } else {
      me = await groupsRepo.insertParticipant(group.id, {
        name, contact, contactKind, heads, brings: b.brings?.trim() || null, joinedAt: new Date(), token: token(),
      });
    }
    res.status(201).json({ participantToken: me.token, ...(await joinPayload(group, me.token)) });
  } catch (err) { next(err); }
});

/**
 * POST /api/join/:token/account — the guest becomes a Roam user.
 *
 * One screen asked their name and one way to reach them; this is what that
 * costs them. An account of their own (accounts, 033) with a household of their
 * own and thirty days of the whole app, no card and nothing to cancel — and a
 * session on this device, because they are standing in front of it holding a
 * link somebody sent them, which is the only proof this journey can have.
 *
 * Somebody who already has a Roam account is recognised by their contact and
 * signed into the one they have; their household is not touched.
 */
router.post('/join/:token/account', async (req, res, next) => {
  try {
    const group = await groupByToken(req.params.token);
    if (group.cancelled_at) return res.status(409).json({ error: 'group_cancelled', message: 'This trip has been called off.' });
    if (group.closed_at) return res.status(409).json({ error: 'group_closed', message: 'This group is not taking any more people.' });
    const b = req.body || {};
    const name = b.name?.trim();
    if (!name) return res.status(400).json({ error: 'name_required', message: 'Give the name the organiser knows you by.' });
    const contact = b.contact?.trim() || null;
    if (!contact) return res.status(400).json({ error: 'contact_required', message: 'One way to reach you: a mobile or an email.' });
    const isEmail = contact.includes('@');

    // Full is full, counted in heads rather than rows.
    const people = await groupsRepo.participantsPlain(group.id);
    const active = people.filter((p) => !p.withdrawn_at);
    const heads = active.filter((p) => p.joined_at).reduce((n, p) => n + p.heads, 0);
    if (group.maximum_count && heads >= group.maximum_count) {
      return res.status(409).json({ error: 'group_full', message: `This trip is full — ${heads} of ${group.maximum_count}.` });
    }

    const existing = await accountsRepo.accountByContact({ email: isEmail ? contact : null, mobile: isEmail ? null : contact });
    const account = existing && existing.status !== 'suspended'
      ? existing
      : await accountsRepo.createGuestAccount({ name, email: isEmail ? contact : null, mobile: isEmail ? null : contact });

    // Their row on this group: the one the organiser added by name if it
    // matches, otherwise a new one. Never two rows for one person.
    const match = active.find((p) => p.id === b.matchId && !p.joined_at)
      ?? active.find((p) => p.account_id === account.id)
      ?? active.find((p) => !p.joined_at && p.name.trim().toLowerCase() === name.toLowerCase());
    const me = match
      ? await groupsRepo.joinOntoParticipant(match.id, { name, contact, contactKind: isEmail ? 'email' : 'mobile', heads: match.heads || 1, token: token() })
      : await groupsRepo.insertParticipant(group.id, { name, contact, contactKind: isEmail ? 'email' : 'mobile', heads: 1, joinedAt: new Date(), token: token() });
    await groupsRepo.linkParticipantAccount(me.id, account.id);

    const { token: sessionToken } = await openSession(`${name} · invited to ${group.name ?? 'a trip'}`, account.id);
    await accountsRepo.recordSignIn(account.id, { method: 'invite', label: group.name ?? null });

    res.status(201).json({
      participantToken: me.token,
      sessionToken,
      account: {
        id: account.id, name: account.name ?? name, email: account.email, mobile: account.mobile,
        householdId: account.household_id, plan: account.plan, trialEndsOn: ymd(account.trial_ends_on),
        returning: Boolean(existing),
      },
      ...(await joinPayload(group, me.token)),
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/join/:token/household — who is coming with them.
 *
 * The people they live with become members of their own household in Roam (so
 * the next trip knows them), and how many of those are coming becomes the
 * participant's headcount, which is what every per-person price divides by.
 */
router.post('/join/:token/household', async (req, res, next) => {
  try {
    const group = await groupByToken(req.params.token);
    const me = await groupsRepo.participantByToken(group.id, req.body?.participantToken ?? '');
    if (!me) return res.status(403).json({ error: 'not_you', message: 'Say who you are first.' });
    const rows = Array.isArray(req.body?.members) ? req.body.members : [];
    const account = me.account_id ? await accountsRepo.accountById(me.account_id) : null;

    // The household is theirs, so it is written to their own household and
    // never to the organiser's.
    if (account?.household_id) {
      const already = await householdsRepo.membersWithConstraints(account.household_id);
      for (const m of rows) {
        const name = String(m.name ?? '').trim();
        if (!name || already.some((x) => x.name.trim().toLowerCase() === name.toLowerCase())) continue;
        await householdsRepo.insertMember(account.household_id, {
          name,
          isMinor: Boolean(m.child),
          relationship: m.relationship ?? null,
          birthYear: m.age ? new Date().getFullYear() - Number(m.age) : null,
        });
      }
    }

    const coming = rows.filter((m) => m.coming !== false);
    const others = coming.filter((m) => !m.you).map((m) => (m.age ? `${m.name} (${m.age})` : m.name));
    await groupsRepo.updateParticipant(me.id, group.id,
      ['heads = $3', 'brings = $4'],
      [me.id, group.id, Math.max(1, coming.length || 1), others.join(', ') || null]);
    res.json(await joinPayload(group, me.token));
  } catch (err) { next(err); }
});

/**
 * POST /api/join/:token/book — Book your itinerary, confirmed.
 *
 * The guest sends what they picked; the money is worked out here and never
 * taken from the request, because a price is the group's fact and not the
 * browser's. Three sums come back for the same reason they are on the screen:
 * what is taken now, what is owed when a shared cost settles, and what is owed
 * to the organiser directly.
 */
router.post('/join/:token/book', async (req, res, next) => {
  try {
    const group = await groupByToken(req.params.token);
    const me = await groupsRepo.participantByToken(group.id, req.body?.participantToken ?? '');
    if (!me) return res.status(403).json({ error: 'not_you', message: 'Say who you are first.' });
    const picks = req.body?.picks && typeof req.body.picks === 'object' ? req.body.picks : {};
    const items = await groupsRepo.itemsOf(group.id);
    const states = await groupsRepo.statesOf(group.id);
    const byItem = new Map(states.map((st) => [`${st.item_id}:${st.participant_id}`, st]));
    const joined = (await groupsRepo.participantsPlain(group.id)).filter((p) => p.joined_at && !p.withdrawn_at);

    const lines = [];
    let paid = 0; let later = 0; let direct = 0;

    for (const i of items) {
      const pick = picks[i.id];
      if (pick === undefined) continue;
      const shares = i.per_head ? me.heads : 1;
      const status = pick === 'in' || pick === 'booked' || pick === 'declared' ? pick : pick === 'out' ? 'out' : null;
      if (status === null) {
        await groupsRepo.clearState(i.id, me.id);
        continue;
      }
      await groupsRepo.setState(i.id, me.id, { status: status === 'booked' ? 'booked' : status, markedBy: 'participant' });
      if (status === 'out' || !i.pricing) continue;

      const heads = countHeads(i, joined, byItem);
      const cost = costOf(i, group, heads);
      const each = i.state === 'closed' ? i.settled_pence : cost.perSharePence;
      const amount = (each ?? 0) * shares;
      // Money that changes hands at the venue is not ours to collect and not
      // the organiser's to be owed: it is on the list so a table is booked for
      // the right number, and nothing else.
      if (i.book_where === 'there') continue;
      if (i.pricing === 'variable' && i.state !== 'closed') {
        later += (cost.ceilingPence ?? 0) * shares;
        lines.push({ itemId: i.id, label: i.label, when: 'settles', pence: (cost.likelyPence ?? 0) * shares, ceilingPence: (cost.ceilingPence ?? 0) * shares, on: cost.closesOn });
      } else if (group.payment_mode === 'roam') {
        paid += amount;
        lines.push({ itemId: i.id, label: i.label, when: 'now', pence: amount });
      } else {
        direct += amount;
        lines.push({ itemId: i.id, label: i.label, when: 'direct', pence: amount });
      }
    }

    // Roam holds no money yet, so a booking is a record of what was agreed and
    // says so; when a provider exists this is where `paid` becomes true.
    const booking = await groupsRepo.insertBooking({
      groupId: group.id, participantId: me.id, heads: me.heads,
      paidPence: paid, laterPence: later, directPence: direct, status: 'recorded', lines,
    });
    res.json({ booking: { id: booking.id, paidPence: paid, laterPence: later, directPence: direct, lines }, ...(await joinPayload(group, me.token)) });
  } catch (err) { next(err); }
});

/**
 * POST /api/join/:token/items/:itemId — a participant saying where they are up
 * to: booked through Roam, booked elsewhere (their word for it, and shown as
 * such), or in and out of something optional.
 */
router.post('/join/:token/items/:itemId', async (req, res, next) => {
  try {
    const group = await groupByToken(req.params.token);
    const b = req.body || {};
    const me = await groupsRepo.participantByToken(group.id, b.participantToken ?? req.query.p ?? '');
    if (!me) return res.status(403).json({ error: 'not_you', message: 'Say who you are first.' });
    const item = await groupsRepo.itemOfGroup(req.params.itemId, group.id);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    if (b.status === 'clear') {
      await groupsRepo.clearState(item.id, me.id);
    } else {
      if (!PARTICIPANT_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad_status', message: `status must be one of ${PARTICIPANT_STATUSES.join(', ')}` });
      if (b.status === 'paid') return res.status(400).json({ error: 'not_yours_to_say', message: 'The organiser ticks the money off as it reaches them.' });
      // Saying yes to an extra: it may be full, or shut.
      if (b.status === 'in' && item.state !== 'cancelled') {
        const on = await groupsRepo.headsOnItemExcluding(item.id, me.id);
        const taken = on.reduce((n, r) => n + (item.per_head ? r.heads : 1), 0);
        const mine = item.per_head ? me.heads : 1;
        if (item.capacity && taken + mine > item.capacity) {
          return res.status(409).json({ error: 'full', message: `${item.label} is full — ${taken} of ${item.capacity} taken.` });
        }
        if (item.state === 'closed' && item.late_joiners === 'no') {
          return res.status(409).json({ error: 'closed', message: `${item.label} closed on ${inWords(item.closes_on)} and is not taking anybody else.` });
        }
        if (item.state === 'closed' && item.late_joiners === 'ask') {
          return res.status(409).json({ error: 'ask_organiser', message: `${item.label} has already been booked. Ask the organiser whether there is room.` });
        }
      }
      await groupsRepo.setState(item.id, me.id, {
        status: b.status, bookingRef: b.bookingRef?.trim() || null, whereBooked: b.whereBooked?.trim() || null,
        startsOn: ymd(b.startsOn), endsOn: ymd(b.endsOn), note: b.note?.trim() || null,
        markedBy: 'participant',
      });
    }
    res.json(await joinPayload(group, me.token));
  } catch (err) { next(err); }
});

export default router;

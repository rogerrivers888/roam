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
import { query, withTransaction } from '../db.js';
import { currentHousehold } from './household.js';
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
  const { rows } = await query('select * from trip_groups where id = $1', [groupId]);
  if (!rows[0]) { const e = new Error('That group does not exist.'); e.status = 404; e.code = 'group_not_found'; throw e; }
  return rows[0];
}

async function loadTrip(tripId) {
  const { rows } = await query('select * from trips where id = $1', [tripId]);
  if (!rows[0]) { const e = new Error('Trip not found'); e.status = 404; e.code = 'trip_not_found'; throw e; }
  return rows[0];
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
  const household = await currentHousehold();
  const tz = household.timezone || DEFAULT_TZ;
  const [{ rows: items }, { rows: people }, { rows: states }, { rows: reminders }] = await Promise.all([
    query('select * from group_items where group_id = $1 order by position, created_at', [groupId]),
    query('select * from group_participants where group_id = $1 order by withdrawn_at nulls first, joined_at nulls last, name', [groupId]),
    query('select s.* from group_item_states s join group_items i on i.id = s.item_id where i.group_id = $1', [groupId]),
    query('select * from group_reminders where group_id = $1 order by created_at desc limit 200', [groupId]),
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
      cadences: Object.entries(CADENCES).map(([key, c]) => ({ key, label: c.label, runs: c.days.length })),
      channelReady: channelReady(),
      schedule: schedule(group, tz).map((r) => ({ date: r.date, daysBefore: r.daysBefore, at: r.instant, done: runsDone.has(r.date) })),
      next: next ? { date: next.date, daysBefore: next.daysBefore, at: next.instant, recipients: nextRecipients } : null,
      written: sentRows.length,
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

/** GET /api/trips/:id/group — null when the trip is still a household trip. */
router.get('/trips/:id/group', async (req, res, next) => {
  try {
    const { rows } = await query('select id from trip_groups where trip_id = $1', [req.params.id]);
    if (!rows[0]) return res.json({ group: null });
    res.json(await groupPayload(rows[0].id));
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
    const existing = await query('select id from trip_groups where trip_id = $1', [trip.id]);
    if (existing.rows[0]) return res.status(409).json({ error: 'group_exists', message: 'This trip already has a group.', ...(await groupPayload(existing.rows[0].id)) });

    // Everything is wanted three weeks before the trip, unless that is already
    // past — a date to chase against is what gives "outstanding" its urgency.
    const start = ymd(trip.start_date) ?? ymd(trip.depart_at);
    const threeWeeksBefore = start ? new Date(new Date(`${start}T12:00:00Z`).getTime() - 21 * 86400000).toISOString().slice(0, 10) : null;
    const today = new Date().toISOString().slice(0, 10);
    const wantedBy = ymd(b.wantedBy) ?? (threeWeeksBefore && threeWeeksBefore > today ? threeWeeksBefore : start);

    const group = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `insert into trip_groups (trip_id, household_id, name, expected_count, minimum_count, wanted_by, invite_token, reminders_on, reminder_cadence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [trip.id, household.id, b.name?.trim() || trip.title || trip.place_label || 'The group', num(b.expectedCount), num(b.minimumCount), wantedBy, token(),
         b.remindersOn !== false, CADENCES[b.cadence] ? b.cadence : DEFAULT_CADENCE],
      );
      const created = rows[0];
      if (b.items !== false) {
        let position = 0;
        if (trip.base_label && trip.base_kind !== 'home') {
          await client.query(
            `insert into group_items (group_id, kind, required, label, detail, position)
             values ($1,'stay',true,$2,$3,$4)`,
            [created.id, `A room at ${trip.base_label}`, start && ymd(trip.end_date) ? `${inWords(start)} – ${inWords(ymd(trip.end_date))} · everyone books their own` : 'Everyone books their own', position++],
          );
        }
        const { rows: shortlist } = await client.query('select * from trip_shortlist where trip_id = $1 order by position nulls last, added_at', [trip.id]);
        for (const s of shortlist.slice(0, 8)) {
          await client.query(
            `insert into group_items (group_id, kind, required, label, detail, venue_ref, position)
             values ($1,'activity',$2,$3,$4,$5,$6)`,
            // A meal is asked about, not required: the organiser books the table, and what they need is a number.
            [created.id, s.kind !== 'food', s.venue_label, s.kind === 'food' ? 'Are you coming to this?' : null, s.venue_ref, position++],
          );
        }
      }
      // The household's own people are in the group already; they never need a link.
      const { rows: attendees } = await client.query(
        // Oldest member first: whoever set the household up is the organiser.
        `select m.id, m.name, m.is_minor from trip_attendees ta join members m on m.id = ta.member_id where ta.trip_id = $1 order by m.is_minor, m.created_at`,
        [trip.id],
      );
      // Whoever is looking at the app is the organiser (the web passes their
      // member id); otherwise the household's first grown-up.
      const adults = attendees.filter((a) => !a.is_minor).sort((x, y) => (x.id === b.organiserMemberId ? -1 : y.id === b.organiserMemberId ? 1 : 0));
      const minors = attendees.filter((a) => a.is_minor);
      if (adults[0]) {
        await client.query(
          `insert into group_participants (group_id, name, heads, brings, member_id, joined_at, token)
           values ($1,$2,$3,$4,$5,now(),$6)`,
          [created.id, adults[0].name, attendees.length || 1, [...adults.slice(1), ...minors].map((a) => a.name).join(', ') || null, adults[0].id, token()],
        );
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
    if (b.closed !== undefined) put('closed_at', b.closed ? new Date() : null);
    if (b.setupDone !== undefined) put('setup_done', Boolean(b.setupDone));
    if (b.newLink) put('invite_token', token());
    if (!sets.length) return res.json(await groupPayload(group.id));
    await query(`update trip_groups set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

/** DELETE /api/groups/:id — only while it is still empty (Epic 1, M2). */
router.delete('/groups/:id', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const { rows } = await query('select count(*)::int as n from group_participants where group_id = $1 and joined_at is not null and member_id is null', [group.id]);
    if (rows[0].n > 0) return res.status(409).json({ error: 'group_in_use', message: `${rows[0].n} people have already joined. Remove them first, or close the group instead.` });
    await query('delete from trip_groups where id = $1', [group.id]);
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
    const { rows: last } = await query('select coalesce(max(position), -1) + 1 as n from group_items where group_id = $1', [group.id]);
    const pricing = b.pricing === 'variable' ? 'variable' : (b.amountPence != null || kind === 'fee' ? 'fixed' : null);
    await query(
      `insert into group_items (group_id, kind, required, label, detail, venue_ref, stop_id, amount_pence, refund_rule, refund_until, position,
                                pricing, total_pence, per_head, expected_count, minimum_count, capacity, closes_on, late_joiners)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [group.id, kind, b.required !== false, b.label.trim(), b.detail?.trim() || null, b.venueRef ?? null, b.stopId ?? null,
       b.amountPence == null ? null : Math.round(Number(b.amountPence)),
       b.refundRule ?? null, ymd(b.refundUntil), last[0].n,
       pricing, b.totalPence == null ? null : Math.round(Number(b.totalPence)), b.perHead !== false,
       num(b.expectedCount), num(b.minimumCount), num(b.capacity), ymd(b.closesOn),
       ['capacity', 'no', 'ask'].includes(b.lateJoiners) ? b.lateJoiners : 'capacity'],
    );
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
    if (b.state !== undefined && ['open', 'closed', 'cancelled'].includes(b.state)) put('state', b.state);
    if (!sets.length) return res.json(await groupPayload(group.id));
    const { rows: before } = await query('select * from group_items where id = $1 and group_id = $2', [req.params.itemId, group.id]);
    await query(`update group_items set ${sets.join(', ')} where id = $1 and group_id = $2`, params);
    const { rows: after } = await query('select * from group_items where id = $1 and group_id = $2', [req.params.itemId, group.id]);
    await reofferIfDearer(group, before[0], after[0]);
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
  const { rows: onIt } = await query(
    `select p.* from group_item_states s join group_participants p on p.id = s.participant_id
      where s.item_id = $1 and s.status = 'in' and p.withdrawn_at is null`,
    [after.id],
  );
  if (!onIt.length) return;
  await query(`delete from group_item_states where item_id = $1 and status = 'in'`, [after.id]);
  for (const p of onIt) {
    await tellOne(group, p, `${after.label} could now cost up to £${(now / 100).toFixed(2)} each, not £${((was ?? 0) / 100).toFixed(2)}. Say again whether you want it.`, 'reoffer', after.id);
  }
}

/** Removing something people have already done is blocked, and says how many (Epic 2, AC4). */
router.delete('/groups/:id/items/:itemId', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    const { rows } = await query(
      `select count(*)::int as n from group_item_states s join group_items i on i.id = s.item_id
        where i.id = $1 and i.group_id = $2 and s.status in ('booked','declared','paid','in')`,
      [req.params.itemId, group.id],
    );
    if (rows[0].n > 0) return res.status(409).json({ error: 'item_in_use', message: `${rows[0].n} ${rows[0].n === 1 ? 'person has' : 'people have'} already done this one. Change what it says instead of removing it.` });
    await query('delete from group_items where id = $1 and group_id = $2', [req.params.itemId, group.id]);
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
    await query(
      `insert into group_participants (group_id, name, contact, contact_kind, heads, brings, note, invited_at, token)
       values ($1,$2,$3,$4,$5,$6,$7,now(),$8)`,
      [group.id, b.name.trim(), b.contact?.trim() || null, b.contactKind ?? (String(b.contact ?? '').includes('@') ? 'email' : b.contact ? 'mobile' : null),
       Math.max(1, Number(b.heads) || 1), b.brings?.trim() || null, b.note?.trim() || null, token()],
    );
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
    await query(`update group_participants set ${sets.join(', ')} where id = $1 and group_id = $2`, params);
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

router.delete('/groups/:id/participants/:pid', async (req, res, next) => {
  try {
    const group = await loadGroup(req.params.id);
    await query('delete from group_participants where id = $1 and group_id = $2', [req.params.pid, group.id]);
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
    const { rows: item } = await query('select * from group_items where id = $1 and group_id = $2', [req.params.itemId, group.id]);
    if (!item[0]) return res.status(404).json({ error: 'item_not_found' });
    if (b.status === 'clear' || b.status === null) {
      await query('delete from group_item_states where item_id = $1 and participant_id = $2', [req.params.itemId, req.params.pid]);
      return res.json(await groupPayload(group.id));
    }
    if (!ALL_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad_status', message: `status must be one of ${ALL_STATUSES.join(', ')}` });
    await query(
      `insert into group_item_states (item_id, participant_id, status, booking_ref, where_booked, starts_on, ends_on, amount_pence, note, marked_by, on_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'organiser',now())
       on conflict (item_id, participant_id) do update set status = excluded.status, booking_ref = excluded.booking_ref,
         where_booked = excluded.where_booked, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
         amount_pence = excluded.amount_pence, note = excluded.note, marked_by = 'organiser', on_date = now()`,
      [req.params.itemId, req.params.pid, b.status, b.bookingRef?.trim() || null, b.whereBooked?.trim() || null,
       ymd(b.startsOn), ymd(b.endsOn), b.amountPence ?? item[0].amount_pence ?? null, b.note?.trim() || null],
    );
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
    const { rows } = await query('select * from group_items where id = $1 and group_id = $2', [req.params.itemId, group.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    const action = req.body?.action;

    if (action === 'extend') {
      const until = ymd(req.body?.closesOn);
      if (!until) return res.status(400).json({ error: 'date_required', message: 'Say the new date.' });
      await query('update group_items set closes_on = $2, state = $3 where id = $1', [item.id, until, 'open']);
      return res.json(await groupPayload(group.id));
    }
    if (action === 'cancel') {
      await query('update group_items set state = $2, cancelled_note = $3 where id = $1', [item.id, 'cancelled', req.body?.note?.trim() || 'Called off by the organiser.']);
      return res.json(await groupPayload(group.id));
    }
    if (action === 'reopen') {
      await query('update group_items set state = $2, settled_pence = null, settled_heads = null, settled_at = null, due_on = null, cancelled_note = null where id = $1', [item.id, 'open']);
      return res.json(await groupPayload(group.id));
    }
    // Close it: whoever is on it now is who it is divided by, and that is the price.
    const [{ rows: people }, { rows: states }] = await Promise.all([
      query('select * from group_participants where group_id = $1 and withdrawn_at is null and joined_at is not null', [group.id]),
      query('select s.* from group_item_states s join group_items i on i.id = s.item_id where i.group_id = $1', [group.id]),
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
    await query('update group_items set state = $2, settled_heads = $3, settled_pence = $4, settled_at = now(), due_on = $5 where id = $1',
      [item.id, 'closed', shares, cost.perSharePence, ymd(due.toISOString())]);
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
  const household = await currentHousehold();
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
    const { rows } = await query(
      `insert into group_reminders (group_id, participant_id, item_id, run_on, kind, status, reason, channel, body, sent_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (group_id, participant_id, run_on) where run_on is not null do nothing
       returning *`,
      [group.id, p.id, itemId, runOn, joined ? 'outstanding' : 'join', outcome.status === 'failed' ? 'no_channel' : outcome.status,
       outcome.detail, outcome.channel, body, outcome.status === 'sent' ? new Date() : null],
    );
    if (rows[0]) written.push({ participant: p.name, status: rows[0].status });
  }

  // A run always leaves a mark, even when it had nothing to write, so it is
  // never done twice and the organiser can see it happened.
  if (runOn) {
    await query(
      `insert into group_reminders (group_id, participant_id, run_on, kind, status, reason, body)
       values ($1, null, $2, 'run', 'skipped', $3, $4)`,
      [group.id, runOn, written.length ? null : 'Nobody had anything outstanding.',
       `${written.length} reminder${written.length === 1 ? '' : 's'} written on ${runOn}.`],
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
  const household = await currentHousehold().catch(() => null);
  const tz = household?.timezone || DEFAULT_TZ;
  const { rows: groups } = await query('select * from trip_groups where reminders_on = true and wanted_by is not null');
  let runs = 0;
  for (const group of groups) {
    const { rows: done } = await query('select distinct run_on from group_reminders where group_id = $1 and run_on is not null', [group.id]);
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
  const { rows: groups } = await query('select * from trip_groups where cancelled_at is null');
  let closed = 0;
  for (const group of groups) {
    const [{ rows: people }, { rows: items }, { rows: states }] = await Promise.all([
      query('select * from group_participants where group_id = $1 and withdrawn_at is null', [group.id]),
      query('select * from group_items where group_id = $1', [group.id]),
      query('select s.* from group_item_states s join group_items i on i.id = s.item_id where i.group_id = $1', [group.id]),
    ]);
    const joined = people.filter((p) => p.joined_at);
    const stateFor = new Map(states.map((st) => [`${st.item_id}:${st.participant_id}`, st]));

    // The trip's own minimum, judged on the group's date.
    const heads = joined.reduce((n, p) => n + p.heads, 0);
    if (group.minimum_count && ymd(group.wanted_by) && ymd(group.wanted_by) <= today && heads < group.minimum_count) {
      const note = `${heads} of the ${group.minimum_count} needed by ${inWords(group.wanted_by)}.`;
      await query('update trip_groups set cancelled_at = now(), cancelled_note = $2 where id = $1', [group.id, note]);
      await query('update group_items set state = $2, cancelled_note = $3 where group_id = $1 and state = $4', [group.id, 'cancelled', 'The trip was called off.', 'open']);
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
        await query('update group_items set state = $2, cancelled_note = $3 where id = $1', [item.id, 'cancelled', note]);
        await tellEveryone(group, onIt, `${item.label} is off — ${note} Nothing to pay.`, 'cancelled', item.id);
      } else {
        const due = new Date(`${closesOn}T12:00:00Z`);
        due.setUTCDate(due.getUTCDate() + 4);
        await query(
          'update group_items set state = $2, settled_heads = $3, settled_pence = $4, settled_at = now(), due_on = $5 where id = $1',
          [item.id, 'closed', shares, cost.perSharePence, ymd(due.toISOString())],
        );
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
  await query(
    `insert into group_reminders (group_id, participant_id, item_id, kind, status, reason, channel, body, sent_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [group.id, participant.id, itemId, kind, outcome.status === 'failed' ? 'no_channel' : outcome.status, outcome.detail, outcome.channel, body, outcome.status === 'sent' ? new Date() : null],
  );
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
  const { rows } = await query('select * from trip_groups where invite_token = $1', [inviteToken]);
  if (!rows[0]) { const e = new Error('That link is not in use any more. Ask whoever invited you for a new one.'); e.status = 404; e.code = 'link_unknown'; throw e; }
  return rows[0];
}

/**
 * What a link opens. The trip, the checklist, and how many are coming — and
 * nothing about any other person, whoever is holding it. `?p=` is a
 * participant's own token, kept by their device, which adds their own state and
 * nothing else.
 */
async function joinPayload(group, participantToken) {
  const trip = await loadTrip(group.trip_id);
  const [{ rows: items }, { rows: people }] = await Promise.all([
    query('select * from group_items where group_id = $1 order by position, created_at', [group.id]),
    query('select * from group_participants where group_id = $1', [group.id]),
  ]);
  const active = people.filter((p) => !p.withdrawn_at);
  const me = participantToken ? active.find((p) => p.token === participantToken) : null;
  const organiser = people.find((p) => p.member_id);
  // Every state, but only ever counted — a participant is told how many are on
  // a coach, never who they are.
  const { rows: allStates } = await query('select s.* from group_item_states s join group_items i on i.id = s.item_id where i.group_id = $1', [group.id]);
  const byItem = new Map(allStates.map((st) => [`${st.item_id}:${st.participant_id}`, st]));
  const mine = new Map(allStates.filter((st) => me && st.participant_id === me.id).map((st) => [st.item_id, st]));

  return {
    group: {
      name: group.name, wantedBy: ymd(group.wanted_by), closed: Boolean(group.closed_at),
      cancelled: Boolean(group.cancelled_at), cancelledNote: group.cancelled_note,
      organiser: organiser?.name ?? null, expectedCount: group.expected_count, minimumCount: group.minimum_count, maximumCount: group.maximum_count,
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
      const { rows: full } = await query('select coalesce(sum(heads), 0)::int as heads from group_participants where group_id = $1 and joined_at is not null and withdrawn_at is null', [group.id]);
      if (full[0].heads >= group.maximum_count) {
        return res.status(409).json({ error: 'group_full', message: `This trip is full — ${full[0].heads} of ${group.maximum_count}. Ask whoever invited you.` });
      }
    }
    const b = req.body || {};
    const name = b.name?.trim();
    if (!name) return res.status(400).json({ error: 'name_required', message: 'Give a name they will recognise.' });
    const contact = b.contact?.trim() || null;
    const contactKind = b.contactKind ?? (contact?.includes('@') ? 'email' : contact ? 'mobile' : null);
    const heads = Math.max(1, Number(b.heads) || 1);

    const { rows: people } = await query('select * from group_participants where group_id = $1', [group.id]);
    const match = people.find((p) => p.id === b.matchId && !p.joined_at && !p.withdrawn_at)
      ?? people.find((p) => !p.joined_at && !p.withdrawn_at && p.name.trim().toLowerCase() === name.toLowerCase());
    let me;
    if (match) {
      const { rows } = await query(
        `update group_participants set name = $2, contact = coalesce($3, contact), contact_kind = coalesce($4, contact_kind),
           heads = $5, brings = coalesce($6, brings), joined_at = coalesce(joined_at, now()), token = coalesce(token, $7)
         where id = $1 returning *`,
        [match.id, name, contact, contactKind, heads, b.brings?.trim() || null, token()],
      );
      me = rows[0];
    } else {
      const { rows } = await query(
        `insert into group_participants (group_id, name, contact, contact_kind, heads, brings, joined_at, token)
         values ($1,$2,$3,$4,$5,$6,now(),$7) returning *`,
        [group.id, name, contact, contactKind, heads, b.brings?.trim() || null, token()],
      );
      me = rows[0];
    }
    res.status(201).json({ participantToken: me.token, ...(await joinPayload(group, me.token)) });
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
    const { rows: me } = await query('select * from group_participants where group_id = $1 and token = $2', [group.id, b.participantToken ?? req.query.p ?? '']);
    if (!me[0]) return res.status(403).json({ error: 'not_you', message: 'Say who you are first.' });
    const { rows: item } = await query('select * from group_items where id = $1 and group_id = $2', [req.params.itemId, group.id]);
    if (!item[0]) return res.status(404).json({ error: 'item_not_found' });
    if (b.status === 'clear') {
      await query('delete from group_item_states where item_id = $1 and participant_id = $2', [item[0].id, me[0].id]);
    } else {
      if (!PARTICIPANT_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad_status', message: `status must be one of ${PARTICIPANT_STATUSES.join(', ')}` });
      if (b.status === 'paid') return res.status(400).json({ error: 'not_yours_to_say', message: 'The organiser ticks the money off as it reaches them.' });
      // Saying yes to an extra: it may be full, or shut.
      if (b.status === 'in' && item[0].state !== 'cancelled') {
        const { rows: on } = await query(
          `select p.heads from group_item_states s join group_participants p on p.id = s.participant_id
            where s.item_id = $1 and s.status in ('in','paid') and p.withdrawn_at is null and p.id <> $2`,
          [item[0].id, me[0].id],
        );
        const taken = on.reduce((n, r) => n + (item[0].per_head ? r.heads : 1), 0);
        const mine = item[0].per_head ? me[0].heads : 1;
        if (item[0].capacity && taken + mine > item[0].capacity) {
          return res.status(409).json({ error: 'full', message: `${item[0].label} is full — ${taken} of ${item[0].capacity} taken.` });
        }
        if (item[0].state === 'closed' && item[0].late_joiners === 'no') {
          return res.status(409).json({ error: 'closed', message: `${item[0].label} closed on ${inWords(item[0].closes_on)} and is not taking anybody else.` });
        }
        if (item[0].state === 'closed' && item[0].late_joiners === 'ask') {
          return res.status(409).json({ error: 'ask_organiser', message: `${item[0].label} has already been booked. Ask the organiser whether there is room.` });
        }
      }
      await query(
        `insert into group_item_states (item_id, participant_id, status, booking_ref, where_booked, starts_on, ends_on, note, marked_by, on_date)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'participant',now())
         on conflict (item_id, participant_id) do update set status = excluded.status, booking_ref = excluded.booking_ref,
           where_booked = excluded.where_booked, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
           note = excluded.note, marked_by = 'participant', on_date = now()`,
        [item[0].id, me[0].id, b.status, b.bookingRef?.trim() || null, b.whereBooked?.trim() || null, ymd(b.startsOn), ymd(b.endsOn), b.note?.trim() || null],
      );
    }
    res.json(await joinPayload(group, me[0].token));
  } catch (err) { next(err); }
});

export default router;

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
});

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
      .filter((i) => i.required && p.joined_at && !p.withdrawn_at && !isDone(stateFor.get(`${i.id}:${p.id}`)))
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
    const heads = joined.reduce((n, p) => {
      const s = stateFor.get(`${i.id}:${p.id}`);
      return n + (i.required ? (isDone(s) ? p.heads : 0) : (s?.status === 'in' ? p.heads : 0));
    }, 0);
    return {
      ...publicItem(i),
      done, declared, confirmed: done - declared, coming, notComing, heads,
      outstanding: missing.length,
      outstandingNames: missing.slice(0, 8).map((p) => p.name),
      paidPence: i.kind === 'fee' ? forItem.filter((s) => s?.status === 'paid').length * (i.amount_pence ?? 0) : null,
      duePence: i.kind === 'fee' ? missing.length * (i.amount_pence ?? 0) : null,
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
  const nextRecipients = next ? active.filter((p) => !p.joined_at || byId.get(p.id)?.outstanding.length).length : 0;
  const sentRows = reminders.filter((r) => r.participant_id && (r.status === 'sent' || r.status === 'no_channel'));

  return {
    group: {
      id: group.id, tripId: group.trip_id, name: group.name, expectedCount: group.expected_count,
      wantedBy: ymd(group.wanted_by), inviteToken: group.invite_token, closed: Boolean(group.closed_at),
      remindersOn: group.reminders_on, cadence: group.reminder_cadence,
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
        `insert into trip_groups (trip_id, household_id, name, expected_count, wanted_by, invite_token, reminders_on, reminder_cadence)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [trip.id, household.id, b.name?.trim() || trip.title || trip.place_label || 'The group', b.expectedCount ?? null, wantedBy, token(),
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
    if (b.wantedBy !== undefined) put('wanted_by', ymd(b.wantedBy));
    if (b.remindersOn !== undefined) put('reminders_on', Boolean(b.remindersOn));
    if (b.cadence !== undefined) { if (!CADENCES[b.cadence]) return res.status(400).json({ error: 'bad_cadence' }); put('reminder_cadence', b.cadence); }
    if (b.closed !== undefined) put('closed_at', b.closed ? new Date() : null);
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
    if (kind === 'fee' && !(Number(b.amountPence) > 0)) return res.status(400).json({ error: 'amount_required', message: 'An amount of nothing is not a thing to ask for.' });
    const { rows: last } = await query('select coalesce(max(position), -1) + 1 as n from group_items where group_id = $1', [group.id]);
    await query(
      `insert into group_items (group_id, kind, required, label, detail, venue_ref, stop_id, amount_pence, refund_rule, refund_until, position)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [group.id, kind, b.required !== false, b.label.trim(), b.detail?.trim() || null, b.venueRef ?? null, b.stopId ?? null,
       kind === 'fee' ? Math.round(Number(b.amountPence)) : (b.amountPence == null ? null : Math.round(Number(b.amountPence))),
       b.refundRule ?? null, ymd(b.refundUntil), last[0].n],
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
    if (!sets.length) return res.json(await groupPayload(group.id));
    await query(`update group_items set ${sets.join(', ')} where id = $1 and group_id = $2`, params);
    res.json(await groupPayload(group.id));
  } catch (err) { next(err); }
});

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

    const body = reminderBody({ organiser, groupName: payload.group.name, participant: p, outstanding, wantedBy: payload.group.wantedBy, joined });
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

export function startReminderLoop({ everyMinutes = 15 } = {}) {
  const tick = () => runDueReminders().catch((err) => console.error('[groups] reminder run failed:', err.message));
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
  let states = [];
  if (me) ({ rows: states } = await query('select * from group_item_states where participant_id = $1', [me.id]));
  const mine = new Map(states.map((s) => [s.item_id, s]));

  return {
    group: {
      name: group.name, wantedBy: ymd(group.wanted_by), closed: Boolean(group.closed_at),
      organiser: organiser?.name ?? null, expectedCount: group.expected_count,
      joined: active.filter((p) => p.joined_at).length, heads: active.filter((p) => p.joined_at).reduce((n, p) => n + p.heads, 0),
    },
    trip: {
      title: trip.title, place: trip.place_label, startDate: ymd(trip.start_date), endDate: ymd(trip.end_date),
      base: trip.base_label && trip.base_kind !== 'home' ? { label: trip.base_label } : null,
    },
    items: items.map((i) => ({ ...publicItem(i), mine: publicState(mine.get(i.id)) })),
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

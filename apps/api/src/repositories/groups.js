/**
 * Group trips: the organiser's checklist, the people on it, what each of them
 * has done, and every line Roam has written to them.
 *
 * Two audiences read these tables and they must never see the same thing. The
 * organiser sees the roster. A participant behind an invite link sees their own
 * row and counts of everybody else's — never who. That rule is enforced in the
 * route that shapes the answer, but the reads here are written to make it easy
 * to keep: nothing returns a name that is not asked for by id.
 */

import { query } from '../db.js';

const on = (client) => (client ? (text, params) => client.query(text, params) : query);

/** `sets` built from what was sent, so a PATCH touches only what it names. */
function assemble(table, sets, params, where) {
  return `update ${table} set ${sets.join(', ')} where ${where}`;
}

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

export async function groupById(groupId) {
  const { rows } = await query('select * from trip_groups where id = $1', [groupId]);
  return rows[0] ?? null;
}

export async function groupIdForTrip(tripId, client) {
  const { rows } = await on(client)('select id from trip_groups where trip_id = $1', [tripId]);
  return rows[0]?.id ?? null;
}

export async function groupByInviteToken(inviteToken) {
  const { rows } = await query('select * from trip_groups where invite_token = $1', [inviteToken]);
  return rows[0] ?? null;
}

export async function insertGroup(tripId, householdId, g, client) {
  const { rows } = await on(client)(
    `insert into trip_groups (trip_id, household_id, name, expected_count, minimum_count, maximum_count, wanted_by, invite_token, reminders_on, reminder_cadence, first_reminder_on)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [tripId, householdId, g.name, g.expectedCount, g.minimumCount, g.maximumCount, g.wantedBy, g.inviteToken,
      g.remindersOn, g.cadence, g.firstReminderOn],
  );
  return rows[0];
}

export async function updateGroup(groupId, sets, params) {
  await query(assemble('trip_groups', [...sets, 'updated_at = now()'], params, 'id = $1'), params);
}

export async function deleteGroup(groupId) {
  await query('delete from trip_groups where id = $1', [groupId]);
}

/** Whether anybody from outside the household has already joined. */
export async function outsidersJoined(groupId) {
  const { rows } = await query(
    'select count(*)::int as n from group_participants where group_id = $1 and joined_at is not null and member_id is null',
    [groupId],
  );
  return rows[0].n;
}

/** Every group Roam should be chasing for. */
export async function groupsToChase() {
  const { rows } = await query('select * from trip_groups where reminders_on = true and wanted_by is not null');
  return rows;
}

/** Every group still alive, for the daily closing run. */
export async function liveGroups() {
  const { rows } = await query('select * from trip_groups where cancelled_at is null');
  return rows;
}

export async function cancelGroup(groupId, note) {
  await query('update trip_groups set cancelled_at = now(), cancelled_note = $2 where id = $1', [groupId, note]);
  await query(
    'update group_items set state = $2, cancelled_note = $3 where group_id = $1 and state = $4',
    [groupId, 'cancelled', 'The trip was called off.', 'open'],
  );
}

// ---------------------------------------------------------------------------
// the checklist
// ---------------------------------------------------------------------------

export async function itemsOf(groupId) {
  const { rows } = await query('select * from group_items where group_id = $1 order by position, created_at', [groupId]);
  return rows;
}

export async function itemOfGroup(itemId, groupId) {
  const { rows } = await query('select * from group_items where id = $1 and group_id = $2', [itemId, groupId]);
  return rows[0] ?? null;
}

export async function nextItemPosition(groupId) {
  const { rows } = await query('select coalesce(max(position), -1) + 1 as n from group_items where group_id = $1', [groupId]);
  return Number(rows[0].n);
}

/**
 * A column not named here keeps its default.
 *
 * That is why the statement is assembled rather than written out with nineteen
 * placeholders: the first checklist Roam proposes gives a stay and an activity
 * a label and a position and nothing else, and `late_joiners` is `not null`
 * with a default. Passing an explicit null for every field the caller did not
 * set overrides the default and the insert fails — which is exactly what
 * happened the first time this was written out in full.
 */
const ITEM_COLUMNS = {
  kind: 'kind', required: 'required', label: 'label', detail: 'detail',
  venueRef: 'venue_ref', stopId: 'stop_id', amountPence: 'amount_pence',
  refundRule: 'refund_rule', refundUntil: 'refund_until', position: 'position',
  pricing: 'pricing', totalPence: 'total_pence', perHead: 'per_head',
  expectedCount: 'expected_count', minimumCount: 'minimum_count', capacity: 'capacity',
  closesOn: 'closes_on', lateJoiners: 'late_joiners',
  // v2: an event of the organiser's own has a day, a time, somewhere it is
  // booked and a line for the guest.
  startsOn: 'starts_on', startsAt: 'starts_at', endsAt: 'ends_at',
  bookWhere: 'book_where', externalUrl: 'external_url', guestNote: 'guest_note',
};

export async function insertItem(groupId, i, client) {
  const columns = ['group_id'];
  const params = [groupId];
  for (const [key, column] of Object.entries(ITEM_COLUMNS)) {
    if (i[key] === undefined) continue;
    columns.push(column);
    params.push(i[key]);
  }
  const places = params.map((_, n) => `$${n + 1}`).join(',');
  await on(client)(`insert into group_items (${columns.join(', ')}) values (${places})`, params);
}

export async function updateItem(itemId, groupId, sets, params) {
  await query(assemble('group_items', sets, params, 'id = $1 and group_id = $2'), params);
}

export async function setItemState(itemId, fields) {
  const map = {
    state: 'state', closesOn: 'closes_on', cancelledNote: 'cancelled_note',
    settledHeads: 'settled_heads', settledPence: 'settled_pence', dueOn: 'due_on',
  };
  const sets = []; const params = [itemId];
  for (const [key, column] of Object.entries(map)) {
    if (!(key in fields)) continue;
    params.push(fields[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (fields.settledAt) sets.push('settled_at = now()');
  if (fields.clearSettlement) sets.push('settled_pence = null, settled_heads = null, settled_at = null, due_on = null, cancelled_note = null');
  if (!sets.length) return;
  await query(`update group_items set ${sets.join(', ')} where id = $1`, params);
}

/** How many have already acted on something, so removing it can be refused. */
export async function actedOnCount(itemId, groupId) {
  const { rows } = await query(
    `select count(*)::int as n from group_item_states s join group_items i on i.id = s.item_id
      where i.id = $1 and i.group_id = $2 and s.status in ('booked','declared','paid','in')`,
    [itemId, groupId],
  );
  return rows[0].n;
}

export async function deleteItem(itemId, groupId) {
  await query('delete from group_items where id = $1 and group_id = $2', [itemId, groupId]);
}

/** The trip's shortlist, to make the first checklist out of. */
export async function shortlistForChecklist(tripId, client) {
  const { rows } = await on(client)('select * from trip_shortlist where trip_id = $1 order by position nulls last, added_at', [tripId]);
  return rows;
}

/** The household's own people, oldest first — whoever set it up is the organiser. */
export async function tripAttendeesOldestFirst(tripId, client) {
  const { rows } = await on(client)(
    `select m.id, m.name, m.is_minor from trip_attendees ta join members m on m.id = ta.member_id
      where ta.trip_id = $1 order by m.is_minor, m.created_at`,
    [tripId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// the people
// ---------------------------------------------------------------------------

export async function participantsOf(groupId) {
  const { rows } = await query(
    'select * from group_participants where group_id = $1 order by withdrawn_at nulls first, joined_at nulls last, name',
    [groupId],
  );
  return rows;
}

export async function participantsPlain(groupId) {
  const { rows } = await query('select * from group_participants where group_id = $1', [groupId]);
  return rows;
}

export async function activeParticipants(groupId) {
  const { rows } = await query('select * from group_participants where group_id = $1 and withdrawn_at is null', [groupId]);
  return rows;
}

export async function joinedParticipants(groupId) {
  const { rows } = await query(
    'select * from group_participants where group_id = $1 and withdrawn_at is null and joined_at is not null',
    [groupId],
  );
  return rows;
}

/** What a guest confirmed: what was taken, what is owed later, and to whom. */
export async function insertBooking(b) {
  const { rows } = await query(
    `insert into group_bookings (group_id, participant_id, heads, paid_pence, later_pence, direct_pence, status, lines)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [b.groupId, b.participantId, b.heads, b.paidPence, b.laterPence, b.directPence, b.status, JSON.stringify(b.lines ?? [])],
  );
  return rows[0];
}

export async function bookingsOf(participantId) {
  const { rows } = await query('select * from group_bookings where participant_id = $1 order by created_at desc', [participantId]);
  return rows;
}

/** The account this person signed in with, once they have one. */
export async function linkParticipantAccount(participantId, accountId) {
  await query('update group_participants set account_id = $2 where id = $1', [participantId, accountId]);
}

export async function participantByAccount(groupId, accountId) {
  const { rows } = await query('select * from group_participants where group_id = $1 and account_id = $2 and withdrawn_at is null', [groupId, accountId]);
  return rows[0] ?? null;
}

export async function participantByToken(groupId, token) {
  const { rows } = await query('select * from group_participants where group_id = $1 and token = $2', [groupId, token]);
  return rows[0] ?? null;
}

/** How many heads are already in, for a group with a ceiling on numbers. */
export async function headsJoined(groupId) {
  const { rows } = await query(
    'select coalesce(sum(heads), 0)::int as heads from group_participants where group_id = $1 and joined_at is not null and withdrawn_at is null',
    [groupId],
  );
  return rows[0].heads;
}

export async function insertParticipant(groupId, p, client) {
  const { rows } = await on(client)(
    `insert into group_participants (group_id, name, contact, contact_kind, heads, brings, note, member_id, invited_at, joined_at, token)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [groupId, p.name, p.contact ?? null, p.contactKind ?? null, p.heads, p.brings ?? null, p.note ?? null,
      p.memberId ?? null, p.invitedAt ?? null, p.joinedAt ?? null, p.token],
  );
  return rows[0];
}

/**
 * Somebody joining onto a row the organiser had already made for them.
 *
 * `coalesce(joined_at, now())` rather than `now()`: opening the link a second
 * time resumes where they were, it does not make them join again.
 */
export async function joinOntoParticipant(id, p) {
  const { rows } = await query(
    `update group_participants set name = $2, contact = coalesce($3, contact), contact_kind = coalesce($4, contact_kind),
       heads = $5, brings = coalesce($6, brings), joined_at = coalesce(joined_at, now()), token = coalesce(token, $7)
     where id = $1 returning *`,
    [id, p.name, p.contact ?? null, p.contactKind ?? null, p.heads, p.brings ?? null, p.token],
  );
  return rows[0];
}

export async function updateParticipant(pid, groupId, sets, params) {
  await query(assemble('group_participants', sets, params, 'id = $1 and group_id = $2'), params);
}

export async function deleteParticipant(pid, groupId) {
  await query('delete from group_participants where id = $1 and group_id = $2', [pid, groupId]);
}

// ---------------------------------------------------------------------------
// who has done what
// ---------------------------------------------------------------------------

export async function statesOf(groupId) {
  const { rows } = await query(
    'select s.* from group_item_states s join group_items i on i.id = s.item_id where i.group_id = $1',
    [groupId],
  );
  return rows;
}

export async function clearState(itemId, participantId) {
  await query('delete from group_item_states where item_id = $1 and participant_id = $2', [itemId, participantId]);
}

/**
 * Say where somebody is up to on one thing.
 *
 * `markedBy` is the whole reason this is one function rather than two: the
 * organiser ticking the money off as it reaches them and the participant saying
 * they have booked are different claims, and the row remembers which.
 */
export async function setState(itemId, participantId, s) {
  await query(
    `insert into group_item_states (item_id, participant_id, status, booking_ref, where_booked, starts_on, ends_on, amount_pence, note, marked_by, on_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     on conflict (item_id, participant_id) do update
        set status = excluded.status, booking_ref = excluded.booking_ref, where_booked = excluded.where_booked,
            starts_on = excluded.starts_on, ends_on = excluded.ends_on, amount_pence = excluded.amount_pence,
            note = excluded.note, marked_by = excluded.marked_by, on_date = now()`,
    [itemId, participantId, s.status, s.bookingRef ?? null, s.whereBooked ?? null, s.startsOn ?? null,
      s.endsOn ?? null, s.amountPence ?? null, s.note ?? null, s.markedBy],
  );
}

/** Everybody who said yes to something, for asking them again when it gets dearer. */
export async function participantsOnItem(itemId) {
  const { rows } = await query(
    `select p.* from group_item_states s join group_participants p on p.id = s.participant_id
      where s.item_id = $1 and s.status = 'in' and p.withdrawn_at is null`,
    [itemId],
  );
  return rows;
}

export async function clearAllYesses(itemId) {
  await query(`delete from group_item_states where item_id = $1 and status = 'in'`, [itemId]);
}

/** How many heads are already on something with a capacity, excluding one person. */
export async function headsOnItemExcluding(itemId, participantId) {
  const { rows } = await query(
    `select p.heads from group_item_states s join group_participants p on p.id = s.participant_id
      where s.item_id = $1 and s.status in ('in','paid') and p.withdrawn_at is null and p.id <> $2`,
    [itemId, participantId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// what Roam has written to people
// ---------------------------------------------------------------------------

export async function remindersOf(groupId, limit = 200) {
  const { rows } = await query('select * from group_reminders where group_id = $1 order by created_at desc limit $2', [groupId, limit]);
  return rows;
}

export async function reminderRunsDone(groupId) {
  const { rows } = await query('select distinct run_on from group_reminders where group_id = $1 and run_on is not null', [groupId]);
  return rows;
}

/**
 * One reminder, written whether or not it could be sent.
 *
 * `do nothing` on the run: a dated run must never write to the same person
 * twice, however the loop is restarted.
 */
export async function writeReminder(groupId, r) {
  const { rows } = await query(
    `insert into group_reminders (group_id, participant_id, item_id, run_on, kind, status, reason, channel, body, sent_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (group_id, participant_id, run_on) where run_on is not null do nothing
     returning *`,
    [groupId, r.participantId, r.itemId ?? null, r.runOn ?? null, r.kind, r.status, r.reason ?? null,
      r.channel ?? null, r.body, r.sentAt ?? null],
  );
  return rows[0] ?? null;
}

/** A run always leaves a mark, even when it had nothing to write. */
export async function markRun(groupId, runOn, reason, body) {
  await query(
    `insert into group_reminders (group_id, participant_id, run_on, kind, status, reason, body)
     values ($1, null, $2, 'run', 'skipped', $3, $4)`,
    [groupId, runOn, reason, body],
  );
}

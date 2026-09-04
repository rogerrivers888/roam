-- Group trips (owner, 4 Sep 2026: "enabling and supporting group trips and
-- planning of those trips is now going to be another key component of the app"),
-- from Roam — Group Trips Requirements v1.0 and the two mock-ups under
-- /mockups/group-trips*.html.
--
-- A group hangs off a trip that already exists: one organiser, a checklist of
-- the things the trip already contains, and the people who have to do them.
-- Three decisions the owner made on the mock-ups are in this shape:
--
--   * Reminders run themselves. The organiser does not chase; Roam does, on a
--     schedule computed from `wanted_by` and `reminder_cadence`, and the
--     organiser sees when the next one goes and how many have gone. Sending by
--     hand stays available but is not how it is meant to work.
--   * A checklist item is required or optional. The hotel and two activities
--     are wanted from everybody; the Saturday dinner is only asked about, so
--     that a table can be booked for the right number. Only required items
--     count as outstanding, and only they are chased.
--   * No money moves yet. A fee item carries its amount and the organiser's
--     own words, and is ticked off by the organiser as the money reaches them.
--     Nothing here holds a card, a Stripe id, or a payout.
--
-- Licence: a participant is the household's own record of a person who was
-- invited — a name and one contact, kept for this trip, and not a member of the
-- household. An item's `label` is the organiser's own words for what they are
-- asking for; the place it points at is held as `venue_ref` and `stop_id`, so
-- when a licensed source is live the display resolves through the owned record
-- exactly as the shortlist does. No provider content lands in these tables.

create table if not exists trip_groups (
  id               uuid primary key default gen_random_uuid(),
  trip_id          uuid not null unique references trips(id) on delete cascade,   -- exactly one group per trip (Epic 1, AC2)
  household_id     uuid not null references households(id) on delete cascade,
  name             text,
  expected_count   integer,                                    -- a target, not a limit (Epic 1, AC3)
  wanted_by        date,                                       -- the one date everything is chased against
  invite_token     text not null unique,
  reminders_on     boolean not null default true,
  reminder_cadence text not null default 'standard',           -- 'gentle' | 'standard' | 'firm'
  closed_at        timestamptz,                                -- no longer taking people (Epic 3, AC5)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists trip_groups_household_idx on trip_groups (household_id, created_at desc);

-- What is expected of a participant: a stay, an activity, or an amount payable
-- to the organiser. `required` is the difference between "you must" and "are
-- you coming to this?" (owner, 4 Sep 2026).
create table if not exists group_items (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references trip_groups(id) on delete cascade,
  kind          text not null,                                 -- 'stay' | 'activity' | 'fee'
  required      boolean not null default true,
  label         text not null,                                 -- the organiser's own words
  detail        text,
  venue_ref     text,                                          -- resolved through the owned record at display
  stop_id       uuid references trip_stops(id) on delete set null,
  amount_pence  integer,                                       -- fee items, and what an activity costs if the organiser says
  refund_rule   text,                                          -- 'always' | 'until' | 'never'
  refund_until  date,
  position      integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists group_items_group_idx on group_items (group_id, position);

create table if not exists group_participants (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null references trip_groups(id) on delete cascade,
  name           text not null,
  contact        text,                                         -- one way to reach them, their choice of which
  contact_kind   text,                                         -- 'mobile' | 'email'
  heads          integer not null default 1,                   -- a party, not a person: two on the coach, one paying
  brings         text,                                         -- "Leo, 15" — who the extra heads are
  member_id      uuid references members(id) on delete set null, -- when they are already in the household
  token          text unique,                                  -- how their own device resumes as them
  note           text,                                         -- the organiser's private note; never shown to them
  invited_at     timestamptz,                                  -- added by name, before they joined
  joined_at      timestamptz,
  withdrawn_at   timestamptz,
  withdrawn_note text,
  created_at     timestamptz not null default now()
);
create index if not exists group_participants_group_idx on group_participants (group_id, created_at);

-- One row per person per item, written the moment anything is true about it.
-- 'booked' is confirmed through Roam; 'declared' is their word for it and is
-- shown as such (Epic 5, AC2); 'paid' is the organiser ticking the fee off;
-- 'in'/'out' are the answers to an optional item.
create table if not exists group_item_states (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references group_items(id) on delete cascade,
  participant_id uuid not null references group_participants(id) on delete cascade,
  status         text not null,                                -- 'booked' | 'declared' | 'paid' | 'in' | 'out'
  booking_ref    text,
  where_booked   text,                                         -- "Booking.com", when it was not booked through Roam
  starts_on      date,                                         -- the nights they actually booked, to catch the wrong weekend
  ends_on        date,
  amount_pence   integer,
  note           text,
  marked_by      text not null default 'participant',          -- 'participant' | 'organiser' | 'roam'
  on_date        timestamptz not null default now(),
  unique (item_id, participant_id)
);
create index if not exists group_item_states_participant_idx on group_item_states (participant_id);

-- Every reminder Roam has written, whether or not it could be delivered. The
-- schedule itself is computed from the group (domain/reminders.js) rather than
-- stored, so it stays right as people join and drop out; `run_on` is the dated
-- run a row belongs to, which is what makes a run happen once and once only.
create table if not exists group_reminders (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null references trip_groups(id) on delete cascade,
  participant_id uuid references group_participants(id) on delete cascade,
  item_id        uuid references group_items(id) on delete set null,
  run_on         date,                                         -- null for a send by hand
  kind           text not null default 'outstanding',          -- 'join' | 'outstanding'
  status         text not null,                                -- 'sent' | 'no_channel' | 'skipped'
  reason         text,                                         -- why it was skipped: too soon, nothing outstanding
  channel        text,                                         -- 'mobile' | 'email' | null
  body           text not null,                                -- exactly what was written, so it can be shown before and after
  created_at     timestamptz not null default now(),
  sent_at        timestamptz
);
create index if not exists group_reminders_group_idx on group_reminders (group_id, created_at desc);
create index if not exists group_reminders_participant_idx on group_reminders (participant_id, created_at desc);
create unique index if not exists group_reminders_run_idx on group_reminders (group_id, participant_id, run_on) where run_on is not null;

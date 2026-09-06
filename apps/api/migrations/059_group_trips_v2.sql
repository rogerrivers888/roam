-- Group trips v2 (owner, 6 Sep 2026 — "Roam Group Trips requirements v2.0",
-- the handover in Supporting docs/Groups). Four things the design asks for that
-- the tables cannot hold yet.
--
--   * **How the organiser is paid.** V1 was always direct: the guest pays them
--     however they normally do and the organiser ticks it off. Now it is a
--     choice for the group — direct, or Roam collects and pays out — because
--     that changes what every control on the guest's itinerary says. Per-cost
--     choice is V2 of this document (Appendix B); the column sits on the group
--     so moving it down later is an item-level default, not a rewrite.
--
--   * **The invite page.** The link opened a bare checklist. It now opens a
--     page the organiser shapes: a cover, a title, a summary and up to four
--     "how it works" points. Everything else on that page is drawn from the
--     group so it cannot drift out of date.
--
--   * **An event of the organiser's own.** A band, a boat, a coach: things that
--     are not on the trip's shortlist, with a day, a time, a price and a line
--     for the guest. Where it is booked matters as much as what it costs —
--     through Roam, with a third party, or paid at the door — because that is
--     the control the guest is given.
--
--   * **A guest is a Roam account.** Joining creates one (accounts, 033) with
--     the 30-day trial that table already carries, and the participant row
--     points at it, so the same person opening a second invite is recognised.

alter table trip_groups
  -- 'direct' — they pay the organiser; 'roam' — Roam collects and pays out.
  add column if not exists payment_mode   text not null default 'direct',
  -- The invite page, in the organiser's words.
  add column if not exists cover_kind     text,               -- 'banner' | 'full'
  add column if not exists cover_url      text,
  add column if not exists cover_source   text,               -- 'upload' | 'trip' | 'gallery'
  add column if not exists invite_title   text,
  add column if not exists invite_summary text,
  add column if not exists how_it_works   jsonb;              -- up to four short lines

alter table group_items
  add column if not exists starts_on   date,
  add column if not exists starts_at   time,
  add column if not exists ends_at     time,
  -- Where the guest does the thing: through Roam, themselves with somebody
  -- else, or at the door on the day. Null is "nothing to book".
  add column if not exists book_where  text,                  -- 'roam' | 'yourself' | 'there'
  add column if not exists external_url text,
  -- One line the organiser writes for the guest: where to meet, what to bring.
  add column if not exists guest_note  text;

alter table group_participants
  add column if not exists account_id uuid references accounts(id) on delete set null;
create index if not exists group_participants_account_idx on group_participants (account_id);

-- What a guest picked and what was charged, so "Confirm and pay" is a record
-- and not just a set of ticks. One row per confirmation, with the lines it
-- covered, because a guest may come back and change their optional picks.
create table if not exists group_bookings (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null references trip_groups(id) on delete cascade,
  participant_id uuid not null references group_participants(id) on delete cascade,
  heads          integer not null default 1,
  -- What was taken now, what is owed on a settle date, and what is owed to the
  -- organiser directly. Held in pence, as everything else here is.
  paid_pence     integer not null default 0,
  later_pence    integer not null default 0,
  direct_pence   integer not null default 0,
  -- 'recorded' — Roam holds no money and has written down what was agreed;
  -- 'paid' — a payment provider took it. Nothing is 'paid' until one exists.
  status         text not null default 'recorded',
  lines          jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists group_bookings_participant_idx on group_bookings (participant_id, created_at desc);

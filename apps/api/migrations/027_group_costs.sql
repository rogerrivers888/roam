-- A cost has a life, not a number (owner, 4 Sep 2026, on /mockups/group-charges.html).
--
-- Three things change here.
--
--   * The trip gets a minimum of its own. It means one thing and needs no
--     options: below it on the closing day, the trip is cancelled and everybody
--     is told. Left empty — which is the usual case — the weekend goes ahead
--     with whoever comes.
--   * A cost can be priced two ways. `fixed` is the same amount each and never
--     moves. `variable` is a total the organiser has to recover, divided by
--     whoever it applies to: the ceiling (total ÷ minimum) and the likely price
--     (total ÷ expected) are worked out and never entered.
--   * A cost that varies has a life: open while people are joining and nobody
--     pays, closed on a date when the headcount fixes the price and the bill
--     goes out, and cancelled if it never reached its minimum. An item's
--     minimum cancels that item and nothing else; the trip's cancels the trip.
--
-- An "extra" is an item people opt into (`required` false): a coach, a band, a
-- boat, a private room. Its numbers are its own, because only the people who
-- said yes are divided by. An item for everyone uses the trip's numbers.

alter table trip_groups
  add column if not exists minimum_count   integer,     -- null = the trip happens whoever comes
  add column if not exists cancelled_at    timestamptz,
  add column if not exists cancelled_note  text;

alter table group_items
  add column if not exists pricing        text,         -- 'fixed' | 'variable' (null when the item costs nothing)
  add column if not exists total_pence    integer,      -- 'variable': the whole amount to recover
  add column if not exists per_head       boolean not null default true,  -- false = one share per party
  add column if not exists expected_count integer,      -- an extra's own numbers; null = use the trip's
  add column if not exists minimum_count  integer,
  add column if not exists capacity       integer,      -- how many can ever be on it
  add column if not exists closes_on      date,         -- null = the group's own date
  add column if not exists late_joiners   text not null default 'capacity', -- 'capacity' | 'no' | 'ask'
  add column if not exists state          text not null default 'open',    -- 'open' | 'closed' | 'cancelled'
  add column if not exists settled_pence  integer,      -- the share, fixed on the closing day
  add column if not exists settled_heads  integer,
  add column if not exists settled_at     timestamptz,
  add column if not exists due_on         date,
  add column if not exists cancelled_note text;

-- Anything already carrying an amount was a flat fee, which is what 'fixed' means.
update group_items set pricing = 'fixed' where pricing is null and amount_pence is not null;

create index if not exists group_items_state_idx on group_items (state, closes_on);

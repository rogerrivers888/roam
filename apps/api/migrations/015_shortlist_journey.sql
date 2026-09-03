-- The shortlist is the working surface (owner, 3 Sep 2026): each place carries
-- a booking status, an order, a length and the way you travel to it; the day
-- is built from it and saved as stops that keep the booking with them.

alter table trip_shortlist
  add column status        text not null default 'to_call',   -- to_call | booked | no_booking | full | set_aside
  add column booked_time   time,                              -- a booked time is a fixed point in the day
  add column party_size    text,                              -- "2 + 1", as said
  add column booking_ref   text,
  add column status_note   text,                              -- why it is full / set aside, in the household's words
  add column status_on     date,                              -- the date a "full" applied to
  add column position      integer,                           -- order in the journey
  add column dwell_minutes integer,                           -- null = household default for the kind of place
  add column leg_mode      text,                              -- walking | transit | driving | taxi: how you get TO this place; null = quickest
  add column day_id        uuid references trip_days(id) on delete set null;

-- Places that never take bookings start as such; everything else waits for a call.
update trip_shortlist set status = 'no_booking' where category in ('attraction', 'cafe') or kind = 'other';

-- Existing lists keep the order they were added in.
update trip_shortlist s set position = r.rn
  from (select id, row_number() over (partition by trip_id order by must_do desc, added_at) as rn from trip_shortlist) r
 where r.id = s.id;

create index trip_shortlist_order_idx on trip_shortlist (trip_id, position);

alter table trip_stops
  add column booking_status text,
  add column booking_ref    text,
  add column leg_mode       text;

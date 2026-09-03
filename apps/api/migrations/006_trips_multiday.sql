-- Trips become multi-day (docs/trip-planner-design.md §2, §4). A same-day
-- outing is a one-day trip whose base is home.

alter table trips
  add column kind            text not null default 'outing',   -- 'outing' | 'trip'
  add column start_date      date,
  add column end_date        date,
  add column place_label     text,                             -- "Lisbon", as typed/picked
  add column base_label      text,
  add column base_lat        double precision,
  add column base_lng        double precision,
  add column base_kind       text,                             -- 'home' | 'hotel' | 'rental' | 'other'
  add column base_check_in   text,
  add column base_check_out  text,
  add column has_car         boolean not null default true,
  add column day_start       time not null default '09:30',
  add column day_end         time not null default '21:00';

create table trip_days (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references trips(id) on delete cascade,
  date          date not null,
  intensity     text,                                          -- null = trip default
  travel_mode   text,                                          -- null = trip default
  start_time    time,
  end_time      time,
  notes         text,
  unique (trip_id, date)
);

-- Places researched for THIS trip, before or while days are planned.
create table trip_shortlist (
  id               uuid primary key default gen_random_uuid(),
  trip_id          uuid not null references trips(id) on delete cascade,
  venue_ref        text not null,
  venue_label      text not null,
  kind             text not null,                              -- 'food' | 'activity' | 'other'
  category         text,
  lat              double precision,
  lng              double precision,
  venue            jsonb,                                      -- open-data snapshot (cuisines, experiences, diet…); null for licensed sources
  note             text,
  must_do          boolean not null default false,
  preferred_day_id uuid references trip_days(id) on delete set null,
  added_at         timestamptz not null default now(),
  unique (trip_id, venue_ref)
);

alter table trip_stops
  add column day_id      uuid references trip_days(id) on delete cascade,
  add column slot        text,                                 -- 'morning' | 'afternoon' | 'evening'
  add column start_time  time;
alter table trip_stops drop constraint if exists trip_stops_trip_id_position_key;
create index trip_stops_day_idx on trip_stops (day_id, position);

-- Backfill: every existing trip is a one-day outing based at its origin.
update trips set
  start_date = depart_at::date, end_date = return_at::date,
  base_label = origin_label, base_lat = origin_lat, base_lng = origin_lng, base_kind = 'home',
  day_start = depart_at::time, day_end = return_at::time
where start_date is null;

insert into trip_days (trip_id, date, intensity, travel_mode, start_time, end_time)
select id, depart_at::date, intensity, travel_mode, depart_at::time, return_at::time from trips
on conflict do nothing;

update trip_stops s set day_id = d.id, slot = 'morning'
  from trip_days d where d.trip_id = s.trip_id and s.day_id is null;

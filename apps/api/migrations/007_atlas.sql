-- The household's atlas: every place it has been to, saved, shortlisted or
-- marked special, grouped by country and city, growing across all trips.
-- Household-generated content only (label, status, notes); the source's
-- identifier is the link back to the rented layer.

create table household_places (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  venue_ref     text not null,
  label         text not null,
  kind          text,                      -- 'food' | 'activity' | 'other'
  category      text,
  lat           double precision,
  lng           double precision,
  country       text,
  country_code  text,
  locality      text,
  venue         jsonb,                     -- open-data snapshot only
  note          text,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  unique (household_id, venue_ref)
);
create index household_places_geo_idx on household_places (household_id, country_code, locality);

-- Backfill from visits and trip shortlists.
insert into household_places (household_id, venue_ref, label, kind, category, lat, lng, country, country_code, locality, first_seen, last_seen)
select v.household_id, v.venue_ref, max(v.venue_label),
       case when max(v.category) in ('restaurant','cafe','pub','bar') then 'food' when max(v.category) in ('attraction','event') then 'activity' else 'other' end,
       max(v.category), max(v.lat), max(v.lng), max(v.country), max(v.country_code), max(v.locality), min(v.created_at), max(v.created_at)
  from visits v group by v.household_id, v.venue_ref
on conflict (household_id, venue_ref) do nothing;

insert into household_places (household_id, venue_ref, label, kind, category, lat, lng, country, country_code, locality, venue, note, first_seen, last_seen)
select t.household_id, s.venue_ref, s.venue_label, s.kind, s.category, s.lat, s.lng, t.country, t.country_code, t.locality, s.venue, s.note, s.added_at, s.added_at
  from trip_shortlist s join trips t on t.id = s.trip_id
on conflict (household_id, venue_ref) do nothing;

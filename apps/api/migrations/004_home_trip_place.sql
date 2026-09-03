-- Where home is, and where a trip happened (Requirements Epic 3 M2/M3, Epic 4).

alter table households
  add column home_label text,
  add column home_lat   double precision,
  add column home_lng   double precision;

-- Trips are grouped by the country and locality of their origin/destination so
-- a holiday's places can be found again years later.
alter table trips
  add column country       text,
  add column country_code  text,
  add column locality      text,
  add column notes         text;
create index trips_country_idx on trips (household_id, country_code, depart_at desc);

-- Visits know where they were, for the same grouping.
alter table visits
  add column country       text,
  add column country_code  text,
  add column locality      text;
create index visits_country_idx on visits (household_id, country_code, visited_on desc);

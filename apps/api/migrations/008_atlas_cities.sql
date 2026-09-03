-- Cities the household creates on purpose ("we're going to Lisbon") so a city
-- can exist in the atlas before it has any places, and trips can be planned into it.
create table atlas_cities (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  country       text not null,
  country_code  text not null,
  locality      text not null,
  lat           double precision,
  lng           double precision,
  created_at    timestamptz not null default now(),
  unique (household_id, country_code, locality)
);

-- Roam initial schema.
--
-- Scope note (Requirements §8, Technical Constraints §1): this schema holds the
-- OWNED layer only — household profiles, the place ledger, trips, and the
-- attribution log. Licensed place content (names, ratings, hours, photos) is
-- RENTED and is fetched at display time, never persisted here. The one
-- deliberate exception is trip_stops.venue_name; see the comment on that column.

create table households (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  -- Pace defaults (Epic 1 C7). Overridable per trip without changing the default.
  default_visit_minutes   integer not null default 75,
  max_travel_minutes      integer not null default 45,
  default_intensity       text not null default 'balanced',
  created_at              timestamptz not null default now()
);

create table members (
  id                      uuid primary key default gen_random_uuid(),
  household_id            uuid not null references households(id) on delete cascade,
  name                    text not null,
  -- Drives the Epic 1 C8 rule: a minor's profile is editable only by a consenting adult.
  is_minor                boolean not null default false,
  typical_visit_minutes   integer,
  max_travel_minutes      integer,
  created_at              timestamptz not null default now()
);
create index members_household_idx on members (household_id);

-- Allergens exclude, dislikes only rank (Requirements §5, "Constraint application").
-- Held as one table with a kind discriminator so the distinction is explicit at
-- every read rather than inferred from which column was populated.
create type constraint_kind as enum ('allergen', 'dislike', 'like');

create table member_constraints (
  id                      uuid primary key default gen_random_uuid(),
  member_id               uuid not null references members(id) on delete cascade,
  kind                    constraint_kind not null,
  value                   text not null,
  created_at              timestamptz not null default now(),
  unique (member_id, kind, value)
);
create index member_constraints_member_idx on member_constraints (member_id);

create table trips (
  id                      uuid primary key default gen_random_uuid(),
  household_id            uuid not null references households(id) on delete cascade,
  title                   text,
  origin_label            text not null,
  origin_lat              double precision not null,
  origin_lng              double precision not null,
  destination_label       text,
  destination_lat         double precision,
  destination_lng         double precision,
  depart_at               timestamptz not null,
  return_at               timestamptz not null,
  travel_mode             text not null default 'driving',
  intensity               text not null default 'balanced',
  created_at              timestamptz not null default now()
);
create index trips_household_idx on trips (household_id);

-- Attendance is per trip: constraints belonging to members not attending are
-- ignored for that outing (Epic 1 C3).
create table trip_attendees (
  trip_id                 uuid not null references trips(id) on delete cascade,
  member_id               uuid not null references members(id) on delete cascade,
  primary key (trip_id, member_id)
);

create table trip_stops (
  id                      uuid primary key default gen_random_uuid(),
  trip_id                 uuid not null references trips(id) on delete cascade,
  position                integer not null,
  -- Source-qualified identifier, e.g. 'fixtures:v-004'. Retaining an identifier
  -- indefinitely is permitted by every source in scope (Requirements §4).
  venue_ref               text not null,
  -- PROTOTYPE ONLY. Licensed sources permit storing an identifier but not the
  -- venue's name. This column is safe while the only source is the local fixture
  -- set; when a licensed source is enabled it must become fetch-at-display-time.
  venue_name              text not null,
  lat                     double precision,
  lng                     double precision,
  dwell_minutes           integer not null,
  created_at              timestamptz not null default now(),
  unique (trip_id, position)
);
create index trip_stops_trip_idx on trip_stops (trip_id, position);

-- The place ledger (Technical Constraints §13.1): identifiers plus the
-- household's own annotations, so "show me somewhere different" works with zero
-- retention of licensed content.
create type ledger_status as enum ('shown', 'saved', 'dismissed', 'visited');

create table place_ledger (
  id                      uuid primary key default gen_random_uuid(),
  household_id            uuid not null references households(id) on delete cascade,
  source                  text not null,
  source_place_id         text not null,
  status                  ledger_status not null,
  created_at              timestamptz not null default now()
);
create index place_ledger_lookup_idx on place_ledger (household_id, source, source_place_id);

-- Attribution logging, built before the second source goes live (Epic 2 C5/C6,
-- Technical Constraints §2). Without it there is never evidence to drop a source.
create table source_impressions (
  id                      uuid primary key default gen_random_uuid(),
  household_id            uuid references households(id) on delete cascade,
  query_id                uuid not null,
  source                  text not null,
  source_place_id         text not null,
  resolved_venue_key      text not null,
  selected                boolean not null default false,
  created_at              timestamptz not null default now()
);
create index source_impressions_query_idx on source_impressions (query_id);
create index source_impressions_source_idx on source_impressions (source, selected);

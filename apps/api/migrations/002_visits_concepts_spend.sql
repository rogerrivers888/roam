-- Requirements v5.0 additions: visits, taste concepts, ratings, and the spend
-- containment ledger (Requirements §5 "Spend containment", Technical
-- Constraints §14).

-- Every outbound provider call is attributed to a household and a session, so
-- it can be bounded per session and per household per billing period.
create table provider_calls (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid references households(id) on delete set null,
  session_id        uuid,
  provider          text not null,            -- 'anthropic', 'fixtures', 'google', ...
  purpose           text not null,            -- 'plan.interpret', 'discover.search', ...
  input_tokens      integer,
  output_tokens     integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  estimated_cost_usd numeric(10,6),
  created_at        timestamptz not null default now()
);
create index provider_calls_session_idx on provider_calls (session_id, created_at);
create index provider_calls_household_period_idx on provider_calls (household_id, created_at);

-- Conversational planning sessions. Holds the in-session candidate pool and the
-- options composed from it (Epic 5 C3: one pool, retrieved once). The pool is
-- DERIVED data (Requirements §8) and expires with the session — it is working
-- memory for one planning conversation, not a cache across sessions, which the
-- retention terms prohibit for licensed sources.
create table plan_sessions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  trip_id       uuid references trips(id) on delete set null,
  state         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '12 hours'
);
create index plan_sessions_household_idx on plan_sessions (household_id, updated_at desc);

-- Taste concepts: the normalised idea of a dish or an experience, with a type
-- discriminator (Requirements §5). Aliases hold the source wordings that were
-- resolved to the concept, so a wrong merge can be split again (Epic 2 C8).
create type concept_kind as enum ('dish', 'experience');

create table taste_concepts (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  kind          concept_kind not null,
  canonical     text not null,
  created_at    timestamptz not null default now(),
  unique (household_id, kind, canonical)
);

create table taste_concept_aliases (
  id            uuid primary key default gen_random_uuid(),
  concept_id    uuid not null references taste_concepts(id) on delete cascade,
  alias         text not null,
  confidence    real not null default 1.0,
  created_at    timestamptz not null default now(),
  unique (concept_id, alias)
);

-- A visit is a stop the household actually went to: the join between the
-- rented layer (venue identifier) and everything owned (Requirements §5, §8).
create table visits (
  id            uuid primary key default gen_random_uuid(),
  -- Client-generated on the device so an offline retry cannot create a
  -- duplicate (Epic 6 C5, Technical Constraints §13.10).
  client_id     uuid unique,
  household_id  uuid not null references households(id) on delete cascade,
  trip_id       uuid references trips(id) on delete set null,
  stop_id       uuid references trip_stops(id) on delete set null,
  venue_ref     text not null,
  -- Household-confirmed label at visit time: household-generated content, so
  -- history keeps a name even if the provider identifier goes stale.
  venue_label   text not null,
  visited_on    date not null,
  created_at    timestamptz not null default now()
);
create index visits_household_idx on visits (household_id, visited_on desc);

create table visit_attendees (
  visit_id      uuid not null references visits(id) on delete cascade,
  member_id     uuid not null references members(id) on delete cascade,
  primary key (visit_id, member_id)
);

-- Per person, per thing: a three-state take plus the transferable comment
-- (UX research §8.3). Attributed to the concept as well as the venue (Epic 7 C10).
create type take as enum ('loved', 'fine', 'not_for_me');

create table ratings (
  id            uuid primary key default gen_random_uuid(),
  visit_id      uuid not null references visits(id) on delete cascade,
  member_id     uuid not null references members(id) on delete cascade,
  concept_id    uuid references taste_concepts(id) on delete set null,
  subject       text not null,             -- 'visit' or the item name as ordered
  take          take not null,
  comment       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index ratings_member_concept_idx on ratings (member_id, concept_id, created_at desc);

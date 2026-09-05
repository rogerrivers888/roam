-- The atlas learns to hold places Wikipedia has never heard of.
--
-- Owner, 5 Sep 2026: "I'm not just looking for soft places. I'm looking for
-- kids' activities and all activities: go-karting, flying lessons, all of the
-- stuff that you can do in Surrey and Berkshire."
--
-- Wikidata cannot answer that. Chobham Adventure Farm has no item; nor has any
-- trampoline park, soft play or karting track. So a second discovery source is
-- needed, and Google Places is the one that knows they exist.
--
-- **What Google is allowed to be here.** Technical Constraints §4: "Place IDs
-- only. Coordinates 30 days; display fields uncacheable." So Google is a
-- *pointer*, never a record — exactly the role §13.10 already gives a rented
-- source: "used only as a description of what to go and find… and is never
-- written down". The sweep asks Google what exists, then goes and researches
-- each answer against OpenStreetMap, and it is the OpenStreetMap record that
-- gets stored. Where no match is found we keep the identifier and nothing else,
-- and the name has to be fetched live at display.
--
-- That distinction is the whole of this migration:
--
--   source        who told us this place exists
--   external_ref  their identifier for it — a place ID may be kept for ever
--   display_source  null when the row is ours to show; 'google' when the name
--                 and picture must be fetched at display and never written.
--
-- Ratings are bands, never numbers, and never Google's numbers. `crowd_band`
-- is one of four words; a dozen different ratings map to each, so the band
-- cannot be read backwards into the figure it came from. That is the same
-- device `scout_places` already uses for the food sweep.

-- ---------------------------------------------------------------------------
-- attractions becomes multi-source
-- ---------------------------------------------------------------------------

-- Wikidata was the only way in, so the id was mandatory and unique per region.
-- Neither holds once a place can arrive from Google or OpenStreetMap instead.
alter table attractions alter column wikidata_id drop not null;
alter table attractions add column if not exists source         text not null default 'wikidata';
alter table attractions add column if not exists external_ref   text;
alter table attractions add column if not exists display_source text;
alter table attractions add column if not exists crowd_band     text;
alter table attractions add column if not exists count_band     text;
-- What the sweep asked Google that found this place, so a category of thing
-- that turns out to be useless can be traced back to the query that produced it.
alter table attractions add column if not exists found_by       text;

-- Backfill before the constraints, so every existing row is a well-formed
-- Wikidata row rather than a special case for ever.
update attractions set external_ref = 'wikidata:' || wikidata_id
 where external_ref is null and wikidata_id is not null;

-- The old uniqueness only makes sense for rows that have a Wikidata id at all.
alter table attractions drop constraint if exists attractions_region_slug_wikidata_id_key;
create unique index if not exists attractions_region_wikidata_idx
  on attractions (region_slug, wikidata_id) where wikidata_id is not null;
create unique index if not exists attractions_region_external_idx
  on attractions (region_slug, external_ref) where external_ref is not null;
create index if not exists attractions_source_idx on attractions (source, state);

-- ---------------------------------------------------------------------------
-- what a sweep cost
-- ---------------------------------------------------------------------------

-- Every sweep, what it asked for and what it spent. `provider_calls` already
-- records that a call happened; this records what a *county* cost, which is the
-- unit the owner asked the question in: "report back on how much it cost, so we
-- can establish how much it will cost for the whole country."
create table if not exists sweep_runs (
  id           uuid primary key default gen_random_uuid(),
  region_slug  text references regions(slug) on delete cascade,
  provider     text not null default 'google',
  -- Requests actually issued. Google bills per request, not per result.
  calls        integer not null default 0,
  -- Roam's own estimate at list price, in US cents, and never an invoice: the
  -- console is where the real bill lives (sources/pricing.js).
  cost_cents   integer not null default 0,
  free_calls   integer not null default 0,   -- of `calls`, how many fell inside the monthly allowance
  found        integer not null default 0,   -- distinct places Google returned
  matched      integer not null default 0,   -- of those, how many we could match to OpenStreetMap and therefore own
  kept         integer not null default 0,   -- how many were written
  queries      integer not null default 0,
  cells        integer not null default 0,
  problems     jsonb   not null default '[]',
  started_by   text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists sweep_runs_at_idx on sweep_runs (started_at desc);

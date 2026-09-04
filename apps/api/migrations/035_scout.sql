-- Sweeping an area for the places worth knowing (owner, 4 Sep 2026).
--
-- > "For every postcode sector I need to find the top-rated restaurants… we're
-- > not beholden to anyone, and we don't actually need to call the APIs. We'll
-- > call them periodically to check if any new restaurants have come along that
-- > have a higher rating… We don't want every restaurant. We want a select
-- > number of highly rated restaurants in each postcode, and then we can cache
-- > them and load them extremely quickly."
--
-- Everything Roam has owned until now was claimed by a household act: somebody
-- shortlisted a place, or said they went, and only then did the researcher go
-- and look (migration 021). That builds a good dataset slowly and only where
-- somebody has already been. This is the other direction — go to an area, work
-- out which of its restaurants are actually good, and research those before
-- anyone asks. The tabs are full before the household opens them.
--
-- What is stored here, and what deliberately is not:
--
--   Stored      our own composite score, the bands that score was built from,
--               the accolades we found, and the identifiers. All of it either
--               our own judgement or open data.
--   Not stored  the licensed rating and review count that went into the crowd
--               band. They are fetched, folded into the score in memory, and
--               discarded in the same breath (Technical Constraints §3.1:
--               display fields, retention none).
--
-- The owner's question was whether a composite is enough to make the inputs
-- ours. The answer this schema takes is: the composite is ours, the band is a
-- judgement, and the figure is theirs and never lands. `roam_score` is
-- recomputed from scratch on every sweep rather than adjusted, so no sweep ever
-- needs to remember what the last one was told.

create table if not exists scout_areas (
  code            text primary key,           -- 'SL4' — the outward code, which is what people say
  label           text,                       -- 'Windsor'
  country_code    text not null default 'GB',
  lat             double precision not null,
  lng             double precision not null,
  radius_km       real    not null default 2.5,
  -- How many of the area's places we keep. Not every restaurant: "anyone who
  -- wants a chain can go to Google Maps".
  keep            integer not null default 25,
  state           text    not null default 'pending',  -- pending | sweeping | done | failed
  why             text,
  swept_at        timestamptz,
  next_sweep_at   timestamptz,
  -- What the last sweep saw, so the owner can tell a thin area from a failure.
  seen            integer not null default 0,   -- everything the passes returned
  chains          integer not null default 0,   -- thrown out for being a group
  kept            integer not null default 0,   -- made the cut
  sweeps          integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists scout_areas_due_idx on scout_areas (next_sweep_at) where state <> 'sweeping';

-- The selection for an area: which places are its best, and why we say so.
create table if not exists scout_places (
  area_code     text not null references scout_areas(code) on delete cascade,
  venue_ref     text not null,
  name          text,
  rank          integer not null,
  -- Ours: 0–10, composed at sweep time from everything below.
  roam_score    real,
  -- The same score with the licensed crowd signal taken out. This is the column
  -- that answers "if the key dies on a Tuesday, does Windsor still load?" — it
  -- is built only from open data and our own reading, so it survives alone.
  owned_score   real,
  -- A judgement, not a figure: 'top' | 'high' | 'good' | 'mixed'. A dozen
  -- different ratings map to each one, which is the point — the band cannot be
  -- read backwards into the number it came from.
  crowd_band    text,
  -- 'thousands' | 'many' | 'hundreds' | 'few'. Movement in this is the change
  -- detector; a rating is too damped by volume to move between sweeps.
  count_band    text,
  accolades     jsonb not null default '[]',   -- ['michelin-bib', 'aa-rosette'] — open facts, ours to keep
  cuisines      jsonb not null default '[]',
  chain         boolean not null default false,
  website       text,
  lat           double precision,
  lng           double precision,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  scored_at     timestamptz not null default now(),
  primary key (area_code, venue_ref)
);
create index if not exists scout_places_rank_idx on scout_places (area_code, rank);
create index if not exists scout_places_ref_idx on scout_places (venue_ref);

-- Our own score, over time. Entirely our number, so it may be kept for good,
-- and it is the series that answers "has this place changed?" without ever
-- having held the thing that changed.
create table if not exists scout_score_history (
  area_code   text        not null,
  venue_ref   text        not null,
  scored_at   timestamptz not null default now(),
  roam_score  real,
  owned_score real,
  crowd_band  text,
  count_band  text,
  rank        integer,
  primary key (area_code, venue_ref, scored_at)
);

-- A place claimed because a sweep found it, rather than because a household
-- chose it. The reason is kept like every other so the evidence still reads
-- honestly: this row says nobody asked for it, Roam went looking.
-- (place_claims.reason gains 'scouted'; no constraint to alter, it is free text.)

-- Why a menu is missing, so an empty tab becomes a queue with a cause.
--
-- Until now a menu that could not be read left nothing behind: the household
-- opened the tab, saw nothing, and there was no record that Roam had ever
-- tried or what stopped it (owner, 4 Sep 2026: "for lots of restaurants I'm
-- opening the tabs, and they are empty. There's nothing there"). These columns
-- turn that silence into a work list — how many failed, at which step, and
-- whether a change to the crawler moved the number.
alter table place_menus add column if not exists state text not null default 'read';  -- read | found | none | failed
alter table place_menus add column if not exists why text;
alter table place_menus add column if not exists attempts integer not null default 0;
alter table place_menus add column if not exists next_attempt_at timestamptz;
alter table place_menus add column if not exists menu_url text;
create index if not exists place_menus_state_idx on place_menus (state, next_attempt_at);

-- place_menus.source_url is not null, but a failed read has no source to point
-- at. A row that records why there is no menu needs to be insertable.
alter table place_menus alter column source_url drop not null;

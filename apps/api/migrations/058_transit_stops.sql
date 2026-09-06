-- Stations, held rather than asked for.
--
-- Owner, 6 Sep 2026: "I would like you to fix it all end to end, add trams as
-- well, and test it rigorously and document it rigorously, because it needs to
-- be reliable. If it's not reliable, it's not fit for purpose."
--
-- The reason it was not reliable is that every search asked Overpass, live, for
-- the stations near a point. Overpass is volunteer infrastructure and on
-- 6 Sep 2026 three of its four public mirrors were failing at once — one
-- refusing in three seconds, one taking forty to a timeout, and one answering
-- 200 in a tenth of a second with nothing in it because it turned out to hold
-- Switzerland only. A screen that cannot draw a list unless somebody else's
-- free server is having a good afternoon is not fit for purpose, and no amount
-- of choosing between mirrors fixes that.
--
-- So the stations are ours now. This is open data under ODbL — CLAUDE.md:
-- OpenStreetMap is among the sources "all of which we may keep for good" — and
-- the whole of Great Britain is about three and a half thousand rows, which is
-- a rounding error next to the atlas. Harvested once, refreshed when we choose,
-- and read from Postgres in a millisecond with nothing to go wrong.
--
-- Overpass does not disappear: an area nobody has harvested yet still falls
-- back to a live query, and what comes back is written here, so the system
-- fills itself in as it is used and is never worse than it was before.

create table if not exists transit_stops (
  -- OpenStreetMap's own identifier, 'node/25320412'. The stable thing to key
  -- on: a station can be renamed or re-tagged and is still the same station.
  ref            text primary key,
  name           text not null,
  -- rail | subway | tram | light_rail. Kept apart because they are different
  -- promises: "ten minutes from a tram stop" in Manchester and "ten minutes
  -- from a station" are not the same sentence, and a household choosing where
  -- to sleep is entitled to know which one it is.
  kind           text not null,
  lat            double precision not null,
  lng            double precision not null,
  -- "Metrolink", "London Underground", "Transport for Wales" — what the row
  -- says after the name, and how a household recognises the thing.
  network        text,
  operator       text,
  country_code   text,
  fetched_at     timestamptz not null default now(),
  constraint transit_stops_kind check (kind in ('rail', 'subway', 'tram', 'light_rail'))
);

-- Every read is "what is inside this box", so the box is the index. No PostGIS
-- in this database and none needed: Great Britain is 3,500 rows and the box
-- narrows it to a handful before the haversine runs in JavaScript.
create index if not exists transit_stops_bbox on transit_stops (lat, lng);
create index if not exists transit_stops_kind on transit_stops (kind);

-- What has been harvested, so a miss can be told from an empty area.
--
-- This is the distinction the old code could not make and the reason an
-- outage read on screen as "nowhere near here is by a station". No row for an
-- area means we have never looked; a row with zero stops means we looked and
-- there are none, which is a real and useful answer about a Welsh valley.
create table if not exists transit_coverage (
  area           text primary key,
  label          text,
  south          double precision not null,
  west           double precision not null,
  north          double precision not null,
  east           double precision not null,
  stops          integer not null default 0,
  harvested_at   timestamptz not null default now(),
  -- How it was filled: a deliberate country harvest, or the crumbs left behind
  -- by a live lookup somebody's search paid for.
  how            text not null default 'harvest'
);

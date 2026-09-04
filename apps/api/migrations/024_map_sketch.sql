-- The map a search is drawn on while the household waits (owner, 4 Sep 2026;
-- mock-up /mockups/waiting-options.html): the named areas around a point, with
-- their real outlines.
--
-- This is the owned layer, not a cache of somebody else's content. Nominatim
-- gives us an administrative boundary simplified to a few dozen points — open
-- data under ODbL, ours to keep with attribution (Technical Constraints §4) —
-- and a borough does not move, so a row here is written once and read for ever.
create table if not exists map_sketches (
  key         text primary key,                       -- centre rounded to ~1 km
  lat         double precision not null,
  lng         double precision not null,
  radius_km   double precision not null,              -- the widest search this row has covered
  place       text,                                   -- what the centre's area is called
  areas       jsonb not null default '[]'::jsonb,     -- [{ name, d, cx, cy }] in Mercator units
  complete    boolean not null default false,         -- whether the neighbours have been filled in
  fetched_at  timestamptz not null default now()
);

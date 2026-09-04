-- Which country the household lives in, so a box that asks for a city can put
-- their own country first and fold "Bath in 6 other countries" underneath
-- (owner, 4 Sep 2026: "I feel like I'm in the UK… I could very easily click on
-- the wrong 1").
--
-- Filled from the place picked for home; backfilled from the map the first time
-- it is needed, so an existing household does not have to re-enter its address.
alter table households add column if not exists home_country_code text;
alter table households add column if not exists home_country      text;

-- Depth per kind of food, not per label (owner, 5 Sep 2026).
--
-- > "I'm thinking the top 6 in each category… There should be a decent amount
-- > of Chinese restaurants, for example, that we have the menu for… Often, if
-- > I'm in London, all the top restaurants might be fully booked, so I might
-- > have to go a bit deeper."
--
-- Two columns and a measurement behind them. Measured across twelve swept
-- areas, "top four per cuisine" on the raw labels selected 89% of everything —
-- because the sources call a pizzeria "pizza" and the identical one next door
-- "italian", a café is variously coffee, coffee shop, cafe and tea, and every
-- singleton label is its own category with a guaranteed place in the top four.
-- Grouped first (domain/cuisines.js), the rule means what it says.
--
--   cuisine_group      the coarse kind, decided once at sweep time so the
--                      queue can use a window function rather than re-deriving
--                      it for every row on every tick.
--   menu_per_cuisine   how deep to go in each. Two is "somewhere else Chinese
--                      when the first is booked"; in London it wants to be more.
--
-- `menu_share` stays as the ceiling. Per-category depth without one is how a
-- rule meant to save money quietly reads every menu in the county.

alter table scout_places add column if not exists cuisine_group text;
create index if not exists scout_places_cuisine_idx on scout_places (area_code, cuisine_group, rank);

alter table scout_areas add column if not exists menu_per_cuisine integer not null default 2;

comment on column scout_areas.menu_per_cuisine is
  'How many of each kind of food get a menu read before anyone asks, inside the menu_share ceiling (migration 048).';

-- "Close to home" (owner, 4 Sep 2026): a destination the household never has to
-- create, holding everything within a few miles of the front door. The radius is
-- theirs to set — Settings › Home.

alter table households add column if not exists home_radius_miles integer not null default 10;

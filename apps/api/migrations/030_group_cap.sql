-- A cap on how many can join (owner, 4 Sep 2026: "maybe people do want to cap
-- the number of people"). Set beside the minimum and the number expected, so
-- the three numbers that describe a group's size are asked for together.
alter table trip_groups add column if not exists maximum_count integer;

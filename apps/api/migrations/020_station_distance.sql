-- How far the station is, so the drawer can say "6 min walk" (owner, 4 Sep 2026:
-- "we could actually show what line it's on or more information on getting there
-- on the side drawer").
--
-- The lookups are cleared so they run once more: they also record the station's
-- name, and the old cleanup turned "Battersea Power Station Underground Station"
-- into "Battersea Power" and kept Transport for London's line qualifier in
-- "Hammersmith (Dist&Picc Line)".

alter table household_places add column if not exists station_distance_m integer;

update household_places set where_checked = null where where_checked is not null;

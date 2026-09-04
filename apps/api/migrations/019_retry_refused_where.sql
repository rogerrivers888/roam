-- 018 cleared the empty lookups, but they ran again under the old code, which
-- stamped a row as checked even when Overpass had refused rather than answered.
-- Clear them once more: the lookup now only stamps a row when a provider
-- actually answered, so a place with no station within 5 km settles after one
-- successful pass and is not asked again.

update household_places set where_checked = null where where_checked is not null and station is null;

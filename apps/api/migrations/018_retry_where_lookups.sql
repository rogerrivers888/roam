-- The first station lookups asked Overpass without a user agent (406) and for
-- tags without geometry, so places outside Transport for London's area recorded
-- "no station" and were never asked again. Clear those so the fixed lookup runs
-- once more; rows that already found a station are left alone.

update household_places set where_checked = null where where_checked is not null and station is null;

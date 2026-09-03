-- Two fixes to how the atlas files places (owner, 3 Sep 2026).
--
-- 1. One London. Nominatim names the boroughs as cities ("City of Westminster",
--    "London Borough of Camden") and the whole as "Greater London", so the same
--    weekend landed in two atlas cities. Everything inside Greater London files
--    under "London" from now on (geocode.js localityOf); this folds what exists.
-- 2. A place must never be listed by its identifier. A save with no label fell
--    back to the venue ref ("google:ChIJ…"); take the household's own label for
--    the same place from a visit, shortlist entry or trip stop where one exists.

create or replace function roam_is_london(code text, loc text) returns boolean language sql immutable as $$
  select upper(coalesce(code, '')) = 'GB' and (
    lower(coalesce(loc, '')) in ('greater london', 'city of london', 'city of westminster', 'westminster')
    or lower(coalesce(loc, '')) like 'london borough of %'
    or lower(coalesce(loc, '')) in ('royal borough of greenwich', 'royal borough of kensington and chelsea', 'royal borough of kingston upon thames')
  )
$$;

-- atlas_cities has a unique (household, country, locality): merge before renaming.
update atlas_cities a set lat = coalesce(a.lat, b.lat), lng = coalesce(a.lng, b.lng)
  from atlas_cities b
 where a.household_id = b.household_id and a.country_code = 'GB' and a.locality = 'London' and roam_is_london(b.country_code, b.locality);
delete from atlas_cities b
 where roam_is_london(b.country_code, b.locality)
   and exists (select 1 from atlas_cities a where a.household_id = b.household_id and a.country_code = 'GB' and a.locality = 'London');
update atlas_cities set locality = 'London' where roam_is_london(country_code, locality);

update household_places set locality = 'London' where roam_is_london(country_code, locality);
update visits set locality = 'London' where roam_is_london(country_code, locality);
update trips set locality = 'London' where roam_is_london(country_code, locality);
update trips set place_label = regexp_replace(place_label, ', Greater London$', ', London') where place_label like '%, Greater London';
update trips set title = replace(title, ', Greater London', ', London') where title like '%, Greater London%';

drop function roam_is_london(text, text);

update household_places hp set label = fixed.label
  from (
    select hp2.id,
           coalesce(
             (select v.venue_label from visits v where v.household_id = hp2.household_id and v.venue_ref = hp2.venue_ref and v.venue_label <> hp2.venue_ref order by v.created_at desc limit 1),
             (select s.venue_label from trip_shortlist s join trips t on t.id = s.trip_id where t.household_id = hp2.household_id and s.venue_ref = hp2.venue_ref and s.venue_label <> hp2.venue_ref order by s.added_at desc limit 1),
             (select st.venue_name from trip_stops st join trips t on t.id = st.trip_id where t.household_id = hp2.household_id and st.venue_ref = hp2.venue_ref and st.venue_name <> hp2.venue_ref order by st.created_at desc limit 1),
             hp2.venue ->> 'name'
           ) as label
      from household_places hp2 where hp2.label = hp2.venue_ref
  ) fixed
 where hp.id = fixed.id and fixed.label is not null;

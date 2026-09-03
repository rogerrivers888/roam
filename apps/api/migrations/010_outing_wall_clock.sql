-- Outings created before the timezone fix (commit 7550398) stored day_start /
-- day_end and the day's start_time / end_time as UTC wall clock, so the trip
-- header read 14:12 while the day read 13:12. The instants (depart_at,
-- return_at) were always right; re-derive the wall clock from them in the
-- trip's timezone wherever the two disagree.
update trips
   set day_start = (depart_at at time zone coalesce(timezone, 'Europe/London'))::time,
       day_end   = (return_at at time zone coalesce(timezone, 'Europe/London'))::time
 where kind = 'outing'
   and depart_at is not null and return_at is not null
   and (day_start is distinct from (depart_at at time zone coalesce(timezone, 'Europe/London'))::time
     or day_end   is distinct from (return_at at time zone coalesce(timezone, 'Europe/London'))::time);

update trip_days d
   set start_time = (t.depart_at at time zone coalesce(t.timezone, 'Europe/London'))::time,
       end_time   = (t.return_at at time zone coalesce(t.timezone, 'Europe/London'))::time
  from trips t
 where t.id = d.trip_id and t.kind = 'outing'
   and d.start_time is not null
   and (d.start_time is distinct from (t.depart_at at time zone coalesce(t.timezone, 'Europe/London'))::time
     or d.end_time   is distinct from (t.return_at at time zone coalesce(t.timezone, 'Europe/London'))::time);

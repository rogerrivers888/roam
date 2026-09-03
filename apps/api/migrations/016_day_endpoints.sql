-- Where a day starts and ends (owner, 3 Sep 2026): every trip starts from
-- home and ends at home unless the household says otherwise. Null means the
-- rule: a day out is home to home; a trip away leaves home on its first day,
-- returns home on its last, and runs base to base in between.

alter table trip_days
  add column start_point jsonb,   -- { label, lat, lng, kind: 'home' | 'base' | 'custom' }
  add column end_point   jsonb;

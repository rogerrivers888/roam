-- Wall-clock times ("3 pm") belong to the household's timezone, not the server's.
alter table households add column timezone text not null default 'Europe/London';
alter table trips add column timezone text;
update trips t set timezone = h.timezone from households h where h.id = t.household_id and t.timezone is null;

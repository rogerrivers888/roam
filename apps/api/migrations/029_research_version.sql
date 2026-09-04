-- Which version of the research a record was made by (owner, 4 Sep 2026).
--
-- The researcher keeps getting better — it learned to ask the place ID what a
-- place is when nothing else said, to take a street address from the point
-- alone, to read a phone number a venue prints without marking up. None of that
-- reached the records already made: "already researched" was true, so they were
-- skipped, and they would have stayed as they were until the six-month refresh.
--
-- This is how a record catches up. The researcher carries a version; a record
-- remembers the version it was made by; the background pass picks up anything
-- behind. Improving the research and bumping the number is now the whole of
-- backfilling it.
alter table place_records add column if not exists research_version integer not null default 0;
create index if not exists place_records_version_idx on place_records (research_version);

-- A harvest cannot survive a restart, so the schema should not pretend it can.
--
-- The United Kingdom is a few hours of polite requests to Wikimedia, and it
-- runs inside the API process. Railway restarts that process for a deploy, for
-- a memory limit, for nothing in particular — and when it does, `harvest_runs`
-- is left holding a row that says `running` for a job with nobody behind it.
-- That row then refuses every new harvest, because one at a time is the rule
-- (routes/library.js), and the only way out is somebody with a psql prompt.
--
-- Two things fix it, and both are here rather than in code because both are
-- about what a row means:
--
--   touched_at  when the run last did anything. A run that has said nothing for
--               a while is a run that has stopped, whatever its state column
--               says, and `runningRun()` can tell the difference.
--   the sweep   at the bottom: anything left `running` by a previous process is
--               closed out now. The API calls the same statement on boot
--               (sources/harvest.js `recoverAbandonedRuns`), so this migration
--               is the first run of a rule rather than a one-off repair.

alter table harvest_runs add column if not exists touched_at timestamptz not null default now();
create index if not exists harvest_runs_live_idx on harvest_runs (state, touched_at desc) where state = 'running';

-- Whatever a previous process was doing, it is not doing it now.
update harvest_runs
   set state = 'failed',
       error = coalesce(error, 'The API restarted while this was running.'),
       finished_at = coalesce(finished_at, now()),
       stage = null
 where state = 'running';

-- And the regions it had claimed are free again. `queued` and `running` are
-- both states only a live run can be in; `never` is the honest description of a
-- region nothing has finished. `done` and `failed` are left alone — they are
-- results, and a restart does not undo a result.
update regions set harvest_state = 'never', updated_at = now()
 where harvest_state in ('queued', 'running');

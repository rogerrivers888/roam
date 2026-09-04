-- A group needs a front door (owner, 4 Sep 2026: "no one knows what it actually
-- means, and it's not even announcing it… it should be a sort of wizard").
--
-- `setup_done` is what tells the screen whether to run the wizard — one step at
-- a time, each saying what it is for — or to be the settings page it becomes
-- afterwards. Groups that already exist were set up by hand, so they are done.

alter table trip_groups add column if not exists setup_done boolean not null default false;
update trip_groups set setup_done = true where created_at < now();

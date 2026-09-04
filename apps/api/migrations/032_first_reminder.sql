-- When the chasing starts (owner, 4 Sep 2026: "maybe you could set the date of
-- the first reminder… and then the schedule gets decided based upon that").
-- The schedule is that date, the deadline, and how many reminders the cadence
-- asks for, spread evenly between them.
alter table trip_groups add column if not exists first_reminder_on date;

-- The owner's verdict on a served mock-up (Prototypes tab): approved, rejected
-- or archived, with an optional note. Not household data — this is the design
-- review record, like app_settings, and it must survive a new browser or a new
-- machine, so it lives here rather than in the browser.
create table if not exists prototype_reviews (
  file       text primary key,
  status     text not null check (status in ('new', 'approved', 'rejected', 'archived')),
  note       text,
  updated_at timestamptz not null default now()
);

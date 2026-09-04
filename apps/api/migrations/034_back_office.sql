-- The back office: doors, roles, capabilities, plans with prices, and a record
-- of what people actually do.
--
-- Owner, 4 Sep 2026: "Can I see their activity, like some stuff around what
-- they've done, like creating places, and the level of activity and time on
-- site… Maybe in the Roam desktop app we need to have 2 profiles: web client,
-- web admin, which has all the admin stuff… a full suite of back-office
-- applications, APIs, accounts, reporting, business insights… Also people,
-- roles, permissions, do it all."
--
-- The shape is Parcelvision's, because that is the suite he asked to mirror
-- (`portal/src/core/screens/users`, `backend/app/constants/identity.py`): a
-- **door** says which application you may enter, a **capability** says what you
-- may do once inside, and a **role** is a named bundle of both. Two things that
-- model gets right and a single `is_admin` flag does not:
--
--   * Reading and changing are separate capabilities. Somebody who needs to see
--     what a household has been doing is not thereby somebody who may delete it
--     — and PV's own note is the warning worth repeating: a capability that
--     "nearly fits" is the trap, so a new area declares its own pair.
--   * Money is its own capability. `view_financials` gates revenue and cost
--     everywhere it appears, and its refusal says "you may not see this" rather
--     than rendering an empty screen that reads as "there is nothing here".
--
-- Nothing here touches the rented layer. Activity is Roam's record of what this
-- household did in Roam; no provider content is copied into it.

-- ---------------------------------------------------------------------------
-- doors, capabilities and roles
-- ---------------------------------------------------------------------------

create table if not exists roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  label       text not null,
  description text,
  -- Which applications this role may enter: 'client' (the household's own Roam)
  -- and 'admin' (the back office). A role with no admin door cannot see that
  -- the back office exists, because its API answers 404 rather than 403.
  doors       text[] not null default '{client}',
  -- A system role is the ones Roam ships with. They can be described and their
  -- capabilities changed, but not renamed away or deleted, so a screen cannot
  -- leave the estate with nobody who can administer it.
  is_system   boolean not null default false,
  -- The owner's role, which always holds every capability there is. Held as a
  -- flag rather than by listing them, so a capability added next year is not
  -- silently withheld from the only person who can grant it.
  is_owner    boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists role_capabilities (
  role_id    uuid not null references roles(id) on delete cascade,
  capability text not null,
  primary key (role_id, capability)
);

-- Which role somebody holds. Null is the default member role, resolved in code,
-- so an account created before this migration is a household member and nothing
-- more until somebody says otherwise.
alter table accounts add column if not exists role_id uuid references roles(id) on delete set null;
create index if not exists accounts_role_idx on accounts (role_id);

-- ---------------------------------------------------------------------------
-- plans, with a price
-- ---------------------------------------------------------------------------

-- Plans were a constant in routes/accounts.js. They become rows because a plan
-- now carries a price, and revenue reporting is arithmetic over those prices.
--
-- **No money moves through Roam** — the rule group costs already follow. A price
-- is what a household is *on*, so the back office can report what is being
-- earned; there is no card, no Stripe id and no payout anywhere in this schema.
-- Where a figure would need a payment provider to be true (cash collected,
-- failed payments, churn by cancellation), the screen says it is missing rather
-- than drawing a zero.
create table if not exists plans (
  key            text primary key,
  label          text not null,
  note           text,
  -- Pence a month, ex VAT. Null means "not a paid plan" (trial, friend, owner)
  -- and is different from 0, which would be a paid plan priced at nothing.
  price_pence    integer,
  interval       text not null default 'month',
  -- The monthly ceiling on provider calls a new account on this plan starts at.
  call_bound     integer,
  active         boolean not null default true,
  position       integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Every change of plan, so revenue can be reported for a month that has already
-- gone rather than only for today's arrangement. Written by the API whenever an
-- account's plan or status changes.
create table if not exists account_plan_history (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts(id) on delete cascade,
  plan        text not null,
  status      text not null,
  price_pence integer,
  from_at     timestamptz not null default now(),
  note        text
);
create index if not exists account_plan_history_idx on account_plan_history (account_id, from_at desc);

-- ---------------------------------------------------------------------------
-- what people do
-- ---------------------------------------------------------------------------

-- Most of "what they have done" is already written down: a place saved is a row
-- in `household_places`, a rating is a row in `ratings`, a trip is a trip. The
-- activity feed reads those tables rather than a parallel log, so it reports
-- what actually happened instead of what somebody remembered to instrument.
--
-- This table is for the two things no other table knows:
--
--   * **being here** — a heartbeat while the app is open and visible, which is
--     the only honest way to answer "time on site";
--   * **looking** — which screen, which is behaviour that leaves no other trace.
--
-- It is deliberately coarse. No mouse movement, no scroll depth, no third-party
-- analytics, nothing leaving this database: it is a household's own use of an
-- app owned by the person they got it from, and the admin screen says as much.
create table if not exists activity_events (
  id           bigserial primary key,
  account_id   uuid references accounts(id) on delete cascade,
  household_id uuid references households(id) on delete cascade,
  -- 'screen' | 'heartbeat' | 'install' | 'action'
  kind         text not null,
  -- The tab or screen: 'plan', 'places', 'trips', 'admin.reporting'…
  screen       text,
  -- What it was about, when that is one thing: a venue ref, a trip id.
  subject      text,
  -- Seconds this event accounts for. Heartbeats carry their interval, so time
  -- on site is a sum rather than a guess from timestamps that cannot tell a
  -- closed laptop from a long read.
  seconds      integer,
  meta         jsonb,
  at           timestamptz not null default now()
);
create index if not exists activity_account_idx on activity_events (account_id, at desc);
create index if not exists activity_household_idx on activity_events (household_id, at desc);
create index if not exists activity_kind_idx on activity_events (kind, at desc);
-- Reporting groups by day across everybody constantly; a plain index on the
-- timestamp is what keeps that cheap. (Not an expression index on
-- `date_trunc('day', at)`: that is only stable, not immutable, because the
-- answer depends on the session's timezone — Postgres refuses it.)
create index if not exists activity_at_idx on activity_events (at desc);

-- ---------------------------------------------------------------------------
-- what administrators do
-- ---------------------------------------------------------------------------

-- Anything done *to* somebody rather than by them. Suspending an account,
-- changing a price, granting a capability: each is written here with who did it,
-- because a back office where the only record of an action is its result is one
-- where nobody can answer "who did this, and when".
create table if not exists admin_audit (
  id           bigserial primary key,
  actor_id     uuid references accounts(id) on delete set null,
  actor_label  text,                                   -- who it was, kept if the account goes
  action       text not null,                          -- 'account.suspend', 'plan.price', 'role.grant'…
  subject_type text,
  subject_id   text,
  subject_label text,
  before       jsonb,
  after        jsonb,
  at           timestamptz not null default now()
);
create index if not exists admin_audit_at_idx on admin_audit (at desc);
create index if not exists admin_audit_subject_idx on admin_audit (subject_type, subject_id, at desc);

-- ---------------------------------------------------------------------------
-- what Roam ships with
-- ---------------------------------------------------------------------------

insert into plans (key, label, note, price_pence, call_bound, position) values
  ('owner',    'Owner',    'The founding household. Every capability, and the estate default ceiling.', null, null, 0),
  ('trial',    'Trial',    'Free while they try it. Give it an end date and the screen counts down.',   null, null, 1),
  ('friend',   'Friend',   'Free, no end date, a smaller share of the provider allowance.',             null, null, 2),
  ('standard', 'Standard', 'A paying household. Set its price and it appears in revenue.',              null, null, 3)
on conflict (key) do nothing;

insert into roles (key, label, description, doors, is_system, is_owner, position) values
  ('owner',   'Owner',         'Everything, including who else may administer Roam.',            '{client,admin}', true, true,  0),
  ('admin',   'Administrator', 'Runs the back office: people, plans, reporting and the money.',  '{client,admin}', true, false, 1),
  ('support', 'Support',       'Helps households: sees people and what they have been doing, and can invite and suspend. No money, no roles.', '{client,admin}', true, false, 2),
  ('analyst', 'Analyst',       'Reads the reporting suite, including revenue. Changes nothing.', '{client,admin}', true, false, 3),
  ('member',  'Member',        'A household using Roam. No back office at all.',                 '{client}',       true, false, 4)
on conflict (key) do nothing;

insert into role_capabilities (role_id, capability)
select r.id, c.capability from roles r
  join (values
    ('admin', 'view_accounts'), ('admin', 'manage_accounts'), ('admin', 'view_activity'),
    ('admin', 'view_reporting'), ('admin', 'view_financials'), ('admin', 'manage_plans'),
    ('admin', 'view_audit'), ('admin', 'manage_settings'),
    ('support', 'view_accounts'), ('support', 'manage_accounts'), ('support', 'view_activity'),
    ('analyst', 'view_accounts'), ('analyst', 'view_activity'), ('analyst', 'view_reporting'),
    ('analyst', 'view_financials')
  ) as c(role_key, capability) on c.role_key = r.key
on conflict do nothing;

-- The account that already exists as owner takes the owner role.
update accounts set role_id = (select id from roles where key = 'owner')
 where role = 'owner' and role_id is null;
update accounts set role_id = (select id from roles where key = 'member')
 where role <> 'owner' and role_id is null;

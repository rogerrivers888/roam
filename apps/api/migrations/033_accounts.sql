-- Accounts: a household each, and an owner who can see them all.
--
-- Migration 031 put one shared passcode on the API because "V1 is still one
-- household (Requirements §3)", and said in as many words that "multi-household
-- onboarding in V2 brings real accounts, and this table is where they will
-- hang". This is that, brought forward: the owner is giving Roam to friends
-- (owner, 4 Sep 2026 — "I'd like to be able to enter their email into the site
-- and for you to send them a magic link... we need to build out an admin module
-- anyway where we can see all our customers").
--
-- Three things this has to get right, and each is a decision rather than a
-- default:
--
--   * One account, one household. A friend's account is not a member of the
--     owner's household — it owns a household of its own, and every query in
--     the API resolves to that household and no other. `currentHousehold()`
--     stays the single seam it has always been (routes/household.js) and now
--     reads the request's account instead of "the first row in the table".
--
--   * The passcode still opens the founding household. The owner's devices are
--     signed in on it today and there is no mail sender configured yet, so a
--     migration that made e-mail the only way in would lock him out of his own
--     app. A passcode session carries no account and resolves, exactly as
--     before, to the oldest household.
--
--   * A link is a credential, so only its hash is written down — the same rule
--     `api_sessions` already follows. A stolen backup must not be a stolen
--     account. Links are single-use and short-lived; sessions they open are
--     not, so somebody signs in from a link once and stays in for ninety days.
--
-- Licence note: nothing here touches the rented layer. An account holds a name,
-- an e-mail and dates. Usage figures on the admin screen are counted from
-- `provider_calls`, which is our own record of our own spending.

create table if not exists accounts (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references households(id) on delete cascade,
  -- Stored lowercased and unique: an invitation is addressed to a person, and
  -- the same person invited twice is the same account, not a second one.
  email               text not null,
  name                text,
  -- 'owner' sees the admin module and every account; 'customer' sees their own
  -- household and cannot tell the admin routes exist.
  role                text not null default 'customer',
  -- 'invited'  — created, never signed in
  -- 'active'   — has signed in at least once
  -- 'suspended'— sessions revoked, links refused, data untouched
  status              text not null default 'invited',
  -- What they are on. No money moves through Roam yet (the same rule group
  -- costs follow), so this is a label and a date, never a card or a payout.
  plan                text not null default 'trial',
  trial_ends_on       date,
  -- Their own monthly ceiling on provider calls. Null means the estate default
  -- (ROAM_HOUSEHOLD_MONTHLY_CALL_BOUND, claude.js): every household gets that
  -- bound, and the owner's free allowances are one pot shared between all of
  -- them, so this column is how a guest is given a smaller share.
  monthly_call_bound  integer,
  -- What the owner sees on the admin screen. Not shown to the account holder.
  note                text,
  invited_at          timestamptz,
  activated_at        timestamptz,
  last_seen_at        timestamptz,
  sign_in_count       integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists accounts_email_idx on accounts (lower(email));
create index if not exists accounts_household_idx on accounts (household_id);
-- One owner row is the intent; the index makes a second one impossible rather
-- than merely unlikely.
create unique index if not exists accounts_single_owner_idx on accounts (role) where role = 'owner';

-- A magic link. Never the link itself: only what it hashes to, so a database
-- dump cannot be signed in with.
create table if not exists sign_in_links (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  token_hash    text not null unique,
  -- Short by design. A link that lasts a month is a password somebody forwarded.
  expires_at    timestamptz not null default (now() + interval '7 days'),
  used_at       timestamptz,
  -- How it left here, and whether it did. 'email' when a sender is configured
  -- and accepted it, 'no_sender' when there is no key in Doppler and the owner
  -- copied the link by hand instead — which is the state of the world today.
  delivery      text,
  delivery_error text,
  sent_at       timestamptz,
  -- Who asked for it: the owner inviting somebody, or the person themselves
  -- from the sign-in screen.
  requested_by  text not null default 'owner',
  created_at    timestamptz not null default now()
);
create index if not exists sign_in_links_account_idx on sign_in_links (account_id, created_at desc);
create index if not exists sign_in_links_live_idx on sign_in_links (expires_at) where used_at is null;

-- Which account a session belongs to. Null is the founding household on the
-- shared passcode: today's behaviour, unchanged, so no device is signed out by
-- this migration.
alter table api_sessions add column if not exists account_id uuid references accounts(id) on delete cascade;
create index if not exists api_sessions_account_idx on api_sessions (account_id) where account_id is not null;

-- Every sign-in, so the admin screen can answer "when did they last log in" and
-- "how many times" without inferring it from sessions that get swept.
create table if not exists account_sign_ins (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts(id) on delete cascade,
  -- 'link' — a magic link; 'passcode' — the owner's shared passcode.
  method       text not null default 'link',
  label        text,
  created_at   timestamptz not null default now()
);
create index if not exists account_sign_ins_account_idx on account_sign_ins (account_id, created_at desc);

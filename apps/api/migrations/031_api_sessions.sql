-- A door on the API (Coding standards: the estate's engineering review, and the
-- owner's own words on 4 Sep 2026: "This is a public app. I need to make sure
-- we've taken the proper approaches").
--
-- Until now every request from anywhere on the internet resolved to the first
-- household in the table, so the family's home address, the children's names and
-- every rating they have ever given were readable by anyone who learned the
-- API's URL — and `delete /api/household` was two requests away.
--
-- V1 is still one household (Requirements §3), so this is one shared passcode
-- rather than accounts: the passcode itself never lands in the database, only
-- the sessions it opens. Multi-household onboarding in V2 brings real accounts,
-- and this table is where they will hang.

create table api_sessions (
  id            uuid primary key default gen_random_uuid(),
  -- Never the token itself. A stolen backup must not be a stolen session.
  token_hash    text not null unique,
  -- Which device this is, so Settings can show them and revoke one.
  label         text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Long enough that the family signs in once a quarter, not every morning.
  expires_at    timestamptz not null default (now() + interval '90 days'),
  revoked_at    timestamptz
);

create index api_sessions_live_idx on api_sessions (expires_at) where revoked_at is null;

-- Non-secret app configuration the owner sets from the app rather than the
-- environment: today, which live sources are switched off (Settings ›
-- Providers). Keys stay in Doppler; this only says whether a keyed source runs.
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

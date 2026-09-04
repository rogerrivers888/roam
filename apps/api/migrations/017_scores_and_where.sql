-- Places tab rebuild (owner, 3 Sep 2026): a row shows one number — your own
-- rating out of 5 — and where the place is at a glance (postcode district and
-- the nearest station with its line). The three-way take stays for the planner's
-- learning; the score is what the household sees.

alter table ratings add column if not exists score numeric(2,1)
  check (score is null or (score >= 0.5 and score <= 5 and (score * 2) = floor(score * 2)));

alter table household_places
  add column if not exists postcode       text,          -- district only: "W1T", "EC3M", "BA1" — never the full postcode
  add column if not exists station        text,          -- nearest station's name, cleaned ("Goodge Street")
  add column if not exists station_lines  jsonb,         -- ["Northern"] — the lines it serves, in the operator's words
  add column if not exists station_kind   text,          -- 'tube' | 'elizabeth-line' | 'dlr' | 'overground' | 'national-rail' | 'tram' | 'rail' | 'metro'
  add column if not exists where_checked  timestamptz;   -- when the lookup last ran (null = not yet)

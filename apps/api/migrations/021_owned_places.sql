-- The owned place layer (owner, 4 Sep 2026): "once they add that action to
-- store it, or say we visited it, we go off and get our own research… that way
-- we then own it, and we're building up that store."
--
-- Everything above this line in the stack is rented: Google's names, hours,
-- reviews and photos may not be kept (Technical Constraints §4 — place_id
-- indefinite, coordinates 30 days, display fields none). So this layer is not
-- a cache of theirs. It is a second, parallel record, researched from sources
-- whose licences permit keeping it for good, and triggered only by a household
-- act — shortlisting, saving, or saying they went.
--
-- Two tables, because retention is a per-field property and not a per-row one
-- (Technical Constraints §13, L7 "per-source retention compliance"):
--
--   place_records — the record itself, and only ever fields we may keep for
--                   good. This is what goes to the device for offline use.
--   place_facts   — every fact we have ever established, with the source, the
--                   licence and the moment it must be discarded. A field with
--                   an expiry never reaches place_records; it lives here and is
--                   swept. Enabling a 30-day source later changes this table
--                   and nothing else.
--
-- The record is not scoped to a household. A restaurant researched because one
-- family shortlisted it is known to every family after them: that is the point
-- of owning it. Nothing household-specific is here — verdicts, notes and scores
-- stay on household_places, visits and ratings where they always were.

create table place_records (
  venue_ref         text primary key,          -- 'google:ChIJ…', 'osm:node/123' — the identifier we are allowed to keep
  name              text,
  category          text,
  lat               double precision,
  lng               double precision,
  address           text,
  postcode          text,
  website           text,
  phone             text,
  email             text,
  booking_url       text,
  menu_url          text,
  menu_label        text,
  opening_hours     text,
  price_range       text,
  cuisines          jsonb        not null default '[]',
  experiences       jsonb        not null default '[]',
  dietary_options   jsonb        not null default '[]',
  accessibility     jsonb        not null default '{}',
  socials           jsonb        not null default '{}',
  good_for_children boolean,
  summary           text,                      -- from Wikipedia (CC BY-SA) or the venue's own page; never a licensed source
  summary_source    text,
  image_url         text,
  -- What this place is in the open world, which is what makes the record ours.
  osm_ref           text,                      -- 'node/12345' once matched
  wikidata_id       text,
  wikipedia_url     text,
  -- Licence lines that must appear on screen wherever this record is shown.
  attribution       jsonb        not null default '[]',
  -- How each match was made, so a wrong one can be understood and undone.
  matched           jsonb        not null default '{}',
  -- Which field came from where: { "phone": "site", "cuisines": "osm" }.
  provenance        jsonb        not null default '{}',
  first_owned       timestamptz  not null default now(),
  enriched_at       timestamptz,
  enrich_state      text         not null default 'pending',  -- pending | done | partial | failed
  enrich_error      text,
  enrich_attempts   integer      not null default 0,
  next_attempt_at   timestamptz,
  -- Bumped whenever anything changes, so a device can ask for "what is new since".
  updated_at        timestamptz  not null default now()
);
create index place_records_pending_idx on place_records (enrich_state, next_attempt_at) where enrich_state <> 'done';
create index place_records_updated_idx on place_records (updated_at);
create index place_records_osm_idx on place_records (osm_ref) where osm_ref is not null;

-- Every fact, with the terms it came under. `expires_at` null means the licence
-- lets us keep it: that is what makes it eligible for place_records.
create table place_facts (
  venue_ref   text        not null,
  field       text        not null,
  source      text        not null,            -- 'osm' | 'wikipedia' | 'wikidata' | 'site' | 'household'
  value       jsonb,
  licence     text        not null,            -- 'ODbL' | 'CC BY-SA 4.0' | 'CC0' | 'publisher's own page'
  retention   text        not null,            -- 'indefinite' | 'days:30' | 'none'
  confidence  real,
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz,                     -- null = indefinite
  primary key (venue_ref, field, source)
);
create index place_facts_expiry_idx on place_facts (expires_at) where expires_at is not null;
create index place_facts_ref_idx on place_facts (venue_ref);

-- What a household has asked to own, and when. The trigger is a household act,
-- so the reason is kept: it is the evidence that we only research what someone
-- actually cared about, rather than every row of every search.
create table place_claims (
  household_id  uuid        not null references households(id) on delete cascade,
  venue_ref     text        not null,
  reason        text        not null,          -- 'saved' | 'special' | 'shortlisted' | 'visited' | 'planned'
  claimed_at    timestamptz not null default now(),
  primary key (household_id, venue_ref, reason)
);
create index place_claims_ref_idx on place_claims (venue_ref);

-- Everything already saved, shortlisted or visited is claimed now, so the first
-- run of the enricher covers the household's existing research rather than only
-- what it does next.
insert into place_claims (household_id, venue_ref, reason, claimed_at)
select v.household_id, v.venue_ref, 'visited', min(v.created_at) from visits v group by v.household_id, v.venue_ref
on conflict do nothing;

insert into place_claims (household_id, venue_ref, reason, claimed_at)
select t.household_id, s.venue_ref, 'shortlisted', min(s.added_at) from trip_shortlist s join trips t on t.id = s.trip_id group by t.household_id, s.venue_ref
on conflict do nothing;

insert into place_claims (household_id, venue_ref, reason, claimed_at)
select l.household_id, l.source || ':' || l.source_place_id,
       case when l.status = 'special' then 'special' else 'saved' end, min(l.created_at)
  from place_ledger l where l.status in ('saved', 'special') group by 1, 2, 3
on conflict do nothing;

-- One record per claimed place, waiting to be researched. The enricher picks
-- these up a few at a time; nothing is fetched by this migration, and nothing
-- is seeded into the columns: every value in place_records has to arrive from a
-- source we may keep, which is the whole point of the table. What the household
-- already holds (its own label, the coordinates on household_places) is read as
-- a starting point for the research and is never copied in.
insert into place_records (venue_ref)
select distinct venue_ref from place_claims
on conflict (venue_ref) do nothing;

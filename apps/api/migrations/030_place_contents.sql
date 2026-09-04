-- What is inside a place (owner, 4 Sep 2026: "for all the big theme parks in
-- the UK, can you confirm whether we could do our own research… you could build
-- your ride order… that would be our own proprietary information that you've
-- gone sourced").
--
-- A theme park, a zoo, a water park or an aquarium is not one place: it is
-- forty. Those forty are not somewhere else to go — they are what you do while
-- you are there — so they hang off the parent rather than sitting beside it in
-- a list.
--
-- Everything here comes from sources whose licences let us keep the answer:
-- OpenStreetMap (ODbL, attribution required), Wikidata (CC0), Wikipedia
-- (CC BY-SA, attribution required) and the venue's own published pages. None of
-- it is Google's, none of it expires, and all of it may go to the device — the
-- same rule as place_records (migration 021).

create table place_contents (
  parent_ref   text        not null,            -- 'osm:way/123' or 'google:ChIJ…' — the park
  item_ref     text        not null,            -- 'osm:way/456' — the ride
  name         text        not null,
  kind         text,                            -- roller-coaster, water-slide, flat-ride, dark-ride, show, eat, facility
  kind_label   text,                            -- what to call it on screen: "Roller coaster"
  lat          double precision,
  lng          double precision,
  -- The facts worth having about a ride, each one keepable: height and speed
  -- from Wikidata, the minimum height to ride from the map or the park's page,
  -- the year it opened, who built it.
  facts        jsonb       not null default '{}',
  summary      text,                            -- Wikipedia's first paragraph, where there is an article
  summary_source text,
  website      text,
  wikidata_id  text,
  wikipedia_url text,
  attribution  jsonb       not null default '[]',
  provenance   jsonb       not null default '{}',
  position     integer     not null default 0,  -- a sensible order round the park
  first_seen   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (parent_ref, item_ref)
);
create index place_contents_parent_idx on place_contents (parent_ref, position);

-- When a park's contents were last researched, and how it went, so a second
-- household opening the same park is a read.
alter table place_records
  add column contents_state   text,             -- null (never asked) | pending | done | failed
  add column contents_count   integer not null default 0,
  add column contents_at      timestamptz;

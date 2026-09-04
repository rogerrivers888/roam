-- The atlas of things to do, and the image library underneath it.
--
-- Owner, 4 Sep 2026: "For the UK, I'd like to find the top 15 to 20 attractions
-- in each county and the top 100 or so in London. I would like to get images
-- that we can hold in a database… the source of it, whether we need to have an
-- attribution URL for any of the images, some form of index, a proper form of
-- indexing, so we can search and find the images that we own… Eventually we'd
-- like to support user-uploaded images as well, and we can reward users for
-- taking pictures and uploading them… I don't care about restaurant images…
-- the important ones are places to go and activities."
--
-- This is the first table in Roam that holds *content* rather than identifiers,
-- and it is only allowed to exist because of what it is made of. Everything
-- harvested here comes from sources that grant a standing licence to keep and
-- republish:
--
--   Wikidata      CC0        — what the place is, where it is, how notable
--   Wikipedia     CC BY-SA   — the description, and the pageview signal
--   Wikimedia     CC BY-SA / CC BY / CC0 / PD — the photographs themselves
--   Commons
--
-- No Google photo, no TripAdvisor photo and no scraped image is admissible.
-- Technical Constraints §4 gives Google's photos a retention allowance of
-- *none*, and there is no version of "store it on our CDN" that survives it —
-- `image_assets.may_store` is the column that says a licence was actually read,
-- and `routes/library.js` refuses to write a row without it.
--
-- The layering is the same one place_records established (migration 021):
-- rented content is fetched at display and never written down; owned content is
-- researched once and kept for good. An attraction here is owned outright. That
-- is what makes the answer instant — nothing on the read path talks to anybody
-- else's API — which is the whole point of the ask.

-- ---------------------------------------------------------------------------
-- where: the gazetteer
-- ---------------------------------------------------------------------------

-- The 107 areas the UK divides into for this purpose: 46 ceremonial counties of
-- England plus London on its own, 32 Scottish council areas, 22 Welsh principal
-- areas and the 6 counties of Northern Ireland. Taken from Wikidata rather than
-- typed from memory, which is why each row carries the QID it came from.
--
-- London is one region, not thirty-three boroughs, because migration 013
-- already made "one London" the rule everywhere else in Roam and a second
-- answer here would put Tate Modern in Southwark and the Tate in London.
create table regions (
  slug            text primary key,
  name            text not null,
  country_code    text not null default 'GB',
  nation          text not null,                 -- England | Scotland | Wales | Northern Ireland
  kind            text not null,                 -- Ceremonial county | Council area | Principal area | County | City
  wikidata_id     text,
  lat             double precision,
  lng             double precision,
  -- How many attractions this region should end up with. 18 for a county, 100
  -- for London; editable per region from the back office, because Rutland is
  -- not Kent and pretending otherwise pads one and truncates the other.
  target_count    integer not null default 18,
  -- What the last harvest did here.
  harvest_state   text not null default 'never', -- never | queued | running | done | failed
  harvest_error   text,
  harvested_at    timestamptz,
  candidate_count integer not null default 0,
  published_count integer not null default 0,
  image_count     integer not null default 0,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index regions_nation_idx on regions (nation, position);
create index regions_state_idx on regions (harvest_state);

-- ---------------------------------------------------------------------------
-- what counts as somewhere to go
-- ---------------------------------------------------------------------------

-- Wikidata says a place is a `Q23413` (castle) or a `Q194195` (amusement park)
-- or a `Q928830` (metro station). Deciding which of those is an attraction is a
-- judgement, and this table is where the judgement is written down instead of
-- being buried in a filter.
--
-- It is filled by asking Wikidata once for every type that is a subclass of one
-- of a dozen roots — ~5,300 of them — and cached, because a subclass tree does
-- not change between Tuesdays. `admit` starts as whatever that answer implied
-- and can be overridden from the back office: the override survives the next
-- refresh, so correcting "railway station is not a day out" is permanent.
create table place_kinds (
  qid          text primary key,                 -- 'Q23413'
  label        text,                             -- 'castle'
  root_qid     text,                             -- the attraction root it descends from
  root_label   text,
  -- Roam's own word for it, which is what a chip on a card says.
  category     text,                             -- landmark | museum | outdoors | family | heritage | arts | animals | active
  admit        boolean not null default true,
  overridden   boolean not null default false,   -- a person decided this, not the tree
  overridden_by text,
  seen_count   integer not null default 0,       -- how often it has come back, so the useless ones are obvious
  updated_at   timestamptz not null default now()
);
create index place_kinds_admit_idx on place_kinds (admit, category);

-- ---------------------------------------------------------------------------
-- what: the attractions
-- ---------------------------------------------------------------------------

-- One row per thing to go and do, scoped to a region. Everything in it is CC0
-- (Wikidata) or CC BY-SA (Wikipedia) and may be kept, shown and sent to a
-- device without an expiry.
--
-- `score` is the ranking, and the parts of it are kept beside it rather than
-- being thrown away, because "why is this fourth" is the question the back
-- office exists to answer. The blend is Wikipedia pageviews over twelve months
-- (what people actually look up), Wikidata sitelinks (how internationally
-- notable it is), whether it has a photograph at all, and heritage or
-- attraction designation. Pageviews dominate on purpose: they are the only
-- signal that reflects interest rather than encyclopedic completeness.
create table attractions (
  id              uuid primary key default gen_random_uuid(),
  region_slug     text not null references regions(slug) on delete cascade,
  wikidata_id     text not null,
  name            text not null,
  slug            text not null,
  summary         text,                          -- Wikipedia's first paragraph (CC BY-SA)
  summary_source  text,
  category        text,                          -- from place_kinds
  kinds           text[] not null default '{}',  -- the raw P31 QIDs, so a reclassification can be replayed
  lat             double precision,
  lng             double precision,
  wikipedia_title text,
  wikipedia_url   text,
  commons_category text,
  website         text,
  osm_ref         text,                          -- 'relation/123' via Wikidata P402
  heritage        text,                          -- Grade I listed, scheduled monument, World Heritage Site…
  -- the ranking, and its parts
  sitelinks       integer not null default 0,
  pageviews_year  integer,
  score           double precision not null default 0,
  rank            integer,
  score_parts     jsonb not null default '{}',
  -- What the back office has decided about it. `candidate` is harvested and not
  -- yet shown; `published` is in the top N and live; `hidden` is a person saying
  -- no. Pinned survives the next re-rank, which is how a hand correction sticks.
  state           text not null default 'candidate',   -- candidate | published | hidden
  pinned          boolean not null default false,
  note            text,                          -- why somebody pinned or hid it
  -- The join to the rest of Roam. Set once the place has been matched to an
  -- owned record, so a household saving it lands on the same row (migration 021).
  venue_ref       text,
  attribution     jsonb not null default '[]',
  first_seen      timestamptz not null default now(),
  -- The last harvest that still found this place inside this region. Wikidata's
  -- answer moves a little between runs, and without this a row listed once and
  -- never again would sit in the table competing for a place in the top
  -- eighteen on a score nothing has re-checked since.
  last_seen       timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (region_slug, wikidata_id)
);
create index attractions_region_idx on attractions (region_slug, state, rank);
create index attractions_score_idx on attractions (score desc);
create index attractions_wikidata_idx on attractions (wikidata_id);
create index attractions_venue_idx on attractions (venue_ref) where venue_ref is not null;

-- ---------------------------------------------------------------------------
-- the image library
-- ---------------------------------------------------------------------------

-- One row per photograph we hold, whoever it came from, with the licence it
-- came under sitting on the same row. The columns are not decoration: every one
-- of them is a thing somebody could be asked to produce.
--
--   source_page_url  where the picture came from and where its terms are stated
--                    — the "attribution URL" the owner asked for. On a Wikimedia
--                    image this is the Commons File: page.
--   licence_url      the deed itself (creativecommons.org/licenses/by-sa/4.0).
--   creator          who took it, and creator_url their page, because CC BY
--                    requires the photographer be named, not merely the site.
--   credit_line      the line to print, assembled once so no screen invents it.
--   attribution_required  false for CC0 and public domain, true for every BY.
--   may_store        a licence was read and it permits keeping the bytes. No
--                    row is written without it, and no row is served without it.
--
-- `search` is the index the owner asked for: a weighted tsvector over the
-- title, the caption, the tags, the attraction it is of and the region it is
-- in, so "castle kent" finds Leeds Castle whether the word is in the file name
-- or only in the place.
create table image_assets (
  id              uuid primary key default gen_random_uuid(),
  -- where it came from
  source          text not null,                 -- wikimedia | household | openverse | flickr | upload
  source_ref      text,                          -- 'File:Windsor Castle at Sunset - Nov 2006.jpg'
  source_page_url text,                          -- the attribution URL
  -- the licence
  licence         text not null,                 -- 'CC BY-SA 4.0', 'Public domain', 'Roam contributor licence'
  licence_url     text,
  usage_terms     text,
  restrictions    text,                          -- Commons' own warning field: trademarked, personality rights…
  attribution_required boolean not null default true,
  may_store       boolean not null default false,
  creator         text,
  creator_url     text,
  credit_line     text,
  -- what it is a picture of
  title           text,
  caption         text,
  tags            text[] not null default '{}',
  -- the file
  mime            text,
  width           integer,
  height          integer,
  bytes           integer,                       -- the largest variant held
  sha256          text,                          -- the same photograph twice is one row
  -- The 20px JPEG, base64, inlined into the JSON a card is drawn from. ~500
  -- bytes, renders before the network answers, and is why a page of twenty
  -- attractions looks finished immediately rather than looking broken for a
  -- second. Cheaper than BlurHash to produce because Wikimedia renders it for
  -- us, and no image library has to ship with the API to decode a JPEG.
  lqip            text,
  -- who uploaded it, when it is a household's own
  contributor_account_id uuid references accounts(id) on delete set null,
  contributor_household_id uuid references households(id) on delete set null,
  -- pending until a person looks at it. Harvested images land approved because
  -- their licence was machine-read; an upload never does.
  moderation      text not null default 'approved',  -- approved | pending | rejected
  moderation_note text,
  moderated_by    text,
  moderated_at    timestamptz,
  reward_points   integer not null default 0,
  search          tsvector,
  fetched_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index image_assets_source_ref_idx on image_assets (source, source_ref) where source_ref is not null;
create index image_assets_sha_idx on image_assets (sha256) where sha256 is not null;
create index image_assets_search_idx on image_assets using gin (search);
create index image_assets_moderation_idx on image_assets (moderation, fetched_at desc);
create index image_assets_source_idx on image_assets (source, fetched_at desc);
create index image_assets_contributor_idx on image_assets (contributor_account_id, fetched_at desc);
create index image_assets_tags_idx on image_assets using gin (tags);

-- The bytes, in their own table so that every metadata query — the library
-- grid, the search, the coverage report — reads a narrow row and never drags a
-- 200KB JPEG through the pool.
create table image_variants (
  image_id   uuid not null references image_assets(id) on delete cascade,
  -- The width asked for. Wikimedia renders to its own buckets, so `width` is
  -- what we asked for and `actual_width` is what came back.
  width      integer not null,
  actual_width  integer,
  actual_height integer,
  mime       text not null default 'image/jpeg',
  bytes      integer not null,
  body       bytea not null,
  fetched_at timestamptz not null default now(),
  primary key (image_id, width)
);

-- Which picture is of what. An image can be linked to more than one subject —
-- a photograph of the Cobb is of Lyme Regis and of Dorset — which is why this
-- is a table and not a column on either side.
create table image_links (
  image_id     uuid not null references image_assets(id) on delete cascade,
  subject_type text not null,                    -- attraction | region | place
  subject_id   text not null,                    -- attraction uuid, region slug, or venue_ref
  role         text not null default 'gallery',  -- hero | gallery
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  primary key (image_id, subject_type, subject_id)
);
create index image_links_subject_idx on image_links (subject_type, subject_id, role, position);
-- One hero per subject. The constraint is here rather than in code because
-- "which of these two is the card image" is not a question anybody wants to
-- answer at read time.
create unique index image_links_hero_idx on image_links (subject_type, subject_id) where role = 'hero';

-- What a household earned for a photograph. A ledger rather than a running
-- total, so "why do I have 40 points" has an answer, and so a rejected upload
-- can be reversed with a second row instead of a silent edit.
--
-- Points, not money: nothing in Roam moves money (migration 034), and a reward
-- that implied a payment would be a promise this schema cannot keep.
create table image_rewards (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid references accounts(id) on delete set null,
  household_id uuid references households(id) on delete cascade,
  image_id    uuid references image_assets(id) on delete set null,
  points      integer not null,
  reason      text not null,                     -- 'accepted' | 'first_of_place' | 'reversed'
  note        text,
  awarded_by  text,
  at          timestamptz not null default now()
);
create index image_rewards_account_idx on image_rewards (account_id, at desc);
create index image_rewards_household_idx on image_rewards (household_id, at desc);

-- ---------------------------------------------------------------------------
-- the harvest itself
-- ---------------------------------------------------------------------------

-- Every run, what it did and what it cost — which for this pipeline is nothing
-- but time and somebody else's bandwidth, and that is exactly why it is logged:
-- the Wikimedia terms ask for a User-Agent that identifies us and a rate we can
-- defend, and a run with no record is one nobody can defend.
create table harvest_runs (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null,                     -- 'region:kent' | 'kinds' | 'images:kent'
  stage       text,                              -- what it is doing right now
  state       text not null default 'running',   -- running | done | failed | cancelled
  counts      jsonb not null default '{}',       -- { regions, candidates, published, images, bytes, skipped }
  log         jsonb not null default '[]',       -- the lines the back office shows
  error       text,
  started_by  text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index harvest_runs_at_idx on harvest_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- the search index
-- ---------------------------------------------------------------------------

-- Weighted: the picture's own title and tags outrank the place it is of, which
-- outranks the region, so searching "windsor" puts a photograph called Windsor
-- Castle above one of a bench in Berkshire.
create or replace function roam_image_search(img_id uuid) returns tsvector language sql stable as $$
  select setweight(to_tsvector('english', coalesce(i.title, '')), 'A')
      || setweight(to_tsvector('english', array_to_string(i.tags, ' ')), 'A')
      || setweight(to_tsvector('english', coalesce(i.caption, '')), 'B')
      || setweight(to_tsvector('english', coalesce(string_agg(distinct a.name, ' '), '')), 'B')
      || setweight(to_tsvector('english', coalesce(string_agg(distinct r.name || ' ' || r.nation, ' '), '')), 'C')
      || setweight(to_tsvector('english', coalesce(i.creator, '') || ' ' || coalesce(i.licence, '') || ' ' || coalesce(i.source, '')), 'D')
    from image_assets i
    left join image_links l on l.image_id = i.id
    left join attractions a on l.subject_type = 'attraction' and a.id::text = l.subject_id
    left join regions r on (l.subject_type = 'region' and r.slug = l.subject_id)
                        or (a.region_slug is not null and r.slug = a.region_slug)
   where i.id = img_id
   group by i.id
$$;

-- Rebuilt when the row changes and when a link changes, because half of what
-- makes an image findable is what it was linked to afterwards.
create or replace function roam_reindex_image() returns trigger language plpgsql as $$
begin
  update image_assets set search = roam_image_search(new.image_id) where id = new.image_id;
  return null;
end $$;

create or replace function roam_reindex_after() returns trigger language plpgsql as $$
begin
  update image_assets set search = roam_image_search(new.id) where id = new.id and search is distinct from roam_image_search(new.id);
  return null;
end $$;

create trigger image_assets_reindex after insert or update of title, caption, tags, creator, licence, source
  on image_assets for each row execute function roam_reindex_after();
create trigger image_links_reindex after insert or update or delete
  on image_links for each row execute function roam_reindex_image();

-- ---------------------------------------------------------------------------
-- who may work on it
-- ---------------------------------------------------------------------------

insert into role_capabilities (role_id, capability)
select r.id, c.capability from roles r
  join (values
    ('admin', 'view_library'), ('admin', 'manage_library'),
    ('support', 'view_library'),
    ('analyst', 'view_library')
  ) as c(role_key, capability) on c.role_key = r.key
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- the United Kingdom, as Roam divides it
-- ---------------------------------------------------------------------------

insert into regions (slug, name, country_code, nation, kind, wikidata_id, lat, lng, target_count, position) values
  ('bedfordshire', 'Bedfordshire', 'GB', 'England', 'Ceremonial county', 'Q23143', 52.0833, -0.4167, 18, 0),
  ('berkshire', 'Berkshire', 'GB', 'England', 'Ceremonial county', 'Q23220', 51.42, -1, 18, 1),
  ('buckinghamshire', 'Buckinghamshire', 'GB', 'England', 'Ceremonial county', 'Q23229', 51.7667, -0.8, 18, 2),
  ('cambridgeshire', 'Cambridgeshire', 'GB', 'England', 'Ceremonial county', 'Q23112', 52.35, 0, 18, 3),
  ('cheshire', 'Cheshire', 'GB', 'England', 'Ceremonial county', 'Q23064', 53.1667, -2.5833, 18, 4),
  ('city-of-bristol', 'City of Bristol', 'GB', 'England', 'Ceremonial county', 'Q21693433', 51.45, -2.5833, 18, 5),
  ('cornwall', 'Cornwall', 'GB', 'England', 'Ceremonial county', 'Q48790202', null, null, 18, 6),
  ('county-durham', 'County Durham', 'GB', 'England', 'Ceremonial county', 'Q23082', 54.6667, -1.8333, 18, 7),
  ('cumbria', 'Cumbria', 'GB', 'England', 'Ceremonial county', 'Q23066', 54.5, -3.25, 18, 8),
  ('derbyshire', 'Derbyshire', 'GB', 'England', 'Ceremonial county', 'Q23098', 53.18, -1.61, 18, 9),
  ('devon', 'Devon', 'GB', 'England', 'Ceremonial county', 'Q23156', 50.7, -3.8, 18, 10),
  ('dorset', 'Dorset', 'GB', 'England', 'Ceremonial county', 'Q23159', 50.8333, -2.3333, 18, 11),
  ('east-riding-of-yorkshire', 'East Riding of Yorkshire', 'GB', 'England', 'Ceremonial county', 'Q23088', 53.9167, -0.5, 18, 12),
  ('east-sussex', 'East Sussex', 'GB', 'England', 'Ceremonial county', 'Q23293', 50.94, 0.37, 18, 13),
  ('essex', 'Essex', 'GB', 'England', 'Ceremonial county', 'Q23240', 51.75, 0.5833, 18, 14),
  ('gloucestershire', 'Gloucestershire', 'GB', 'England', 'Ceremonial county', 'Q23165', 51.8, -2.2, 18, 15),
  ('greater-manchester', 'Greater Manchester', 'GB', 'England', 'Ceremonial county', 'Q23099', 53.5025, -2.31, 18, 16),
  ('hampshire', 'Hampshire', 'GB', 'England', 'Ceremonial county', 'Q23204', 51.0575, -1.3075, 18, 17),
  ('herefordshire', 'Herefordshire', 'GB', 'England', 'Ceremonial county', 'Q23129', 52.0833, -2.75, 18, 18),
  ('hertfordshire', 'Hertfordshire', 'GB', 'England', 'Ceremonial county', 'Q3410', 51.9, -0.2, 18, 19),
  ('isle-of-wight', 'Isle of Wight', 'GB', 'England', 'Ceremonial county', 'Q9679', 50.7, -1.3, 18, 20),
  ('kent', 'Kent', 'GB', 'England', 'Ceremonial county', 'Q23298', 51.19, 0.73, 18, 21),
  ('lancashire', 'Lancashire', 'GB', 'England', 'Ceremonial county', 'Q23077', 53.8, -2.6, 18, 22),
  ('leicestershire', 'Leicestershire', 'GB', 'England', 'Ceremonial county', 'Q23106', 52.7167, -1.1833, 18, 23),
  ('lincolnshire', 'Lincolnshire', 'GB', 'England', 'Ceremonial county', 'Q23090', 53.1, -0.2, 18, 24),
  ('london', 'London', 'GB', 'England', 'City', 'Q23306', 51.5074, -0.1278, 100, 25),
  ('merseyside', 'Merseyside', 'GB', 'England', 'Ceremonial county', 'Q23100', 53.4167, -3, 18, 26),
  ('norfolk', 'Norfolk', 'GB', 'England', 'Ceremonial county', 'Q23109', 52.6725, 0.95, 18, 27),
  ('north-yorkshire', 'North Yorkshire', 'GB', 'England', 'Ceremonial county', 'Q23086', 54.1, -1.35, 18, 28),
  ('northamptonshire', 'Northamptonshire', 'GB', 'England', 'Ceremonial county', 'Q23115', 52.3, -0.8, 18, 29),
  ('northumberland', 'Northumberland', 'GB', 'England', 'Ceremonial county', 'Q23079', 55.1667, -2, 18, 30),
  ('nottinghamshire', 'Nottinghamshire', 'GB', 'England', 'Ceremonial county', 'Q23092', 53.1667, -1, 18, 31),
  ('oxfordshire', 'Oxfordshire', 'GB', 'England', 'Ceremonial county', 'Q23169', 51.75, -1.28, 18, 32),
  ('rutland', 'Rutland', 'GB', 'England', 'Ceremonial county', 'Q23107', 52.65, -0.6333, 18, 33),
  ('shropshire', 'Shropshire', 'GB', 'England', 'Ceremonial county', 'Q23103', 52.6167, -2.7167, 18, 34),
  ('somerset', 'Somerset', 'GB', 'England', 'Ceremonial county', 'Q23157', 51.3, -3, 18, 35),
  ('south-yorkshire', 'South Yorkshire', 'GB', 'England', 'Ceremonial county', 'Q23095', 53.5, -1.3333, 18, 36),
  ('staffordshire', 'Staffordshire', 'GB', 'England', 'Ceremonial county', 'Q23105', 52.8069, -2.1161, 18, 37),
  ('suffolk', 'Suffolk', 'GB', 'England', 'Ceremonial county', 'Q23111', 52.2, 1, 18, 38),
  ('surrey', 'Surrey', 'GB', 'England', 'Ceremonial county', 'Q23276', 51.25, -0.45, 18, 39),
  ('tyne-and-wear', 'Tyne and Wear', 'GB', 'England', 'Ceremonial county', 'Q23080', 54.974, -1.6132, 18, 40),
  ('warwickshire', 'Warwickshire', 'GB', 'England', 'Ceremonial county', 'Q23140', 52.3333, -1.5833, 18, 41),
  ('west-midlands', 'West Midlands', 'GB', 'England', 'Ceremonial county', 'Q23124', 52.4872, -1.9, 18, 42),
  ('west-sussex', 'West Sussex', 'GB', 'England', 'Ceremonial county', 'Q23287', 50.9167, -0.5, 18, 43),
  ('west-yorkshire', 'West Yorkshire', 'GB', 'England', 'Ceremonial county', 'Q23083', 53.75, -1.6667, 18, 44),
  ('wiltshire', 'Wiltshire', 'GB', 'England', 'Ceremonial county', 'Q23183', 51.3, -1.9, 18, 45),
  ('worcestershire', 'Worcestershire', 'GB', 'England', 'Ceremonial county', 'Q23135', 52.2, -2.1667, 18, 46),
  ('county-antrim', 'County Antrim', 'GB', 'Northern Ireland', 'County', 'Q189592', null, null, 18, 47),
  ('county-armagh', 'County Armagh', 'GB', 'Northern Ireland', 'County', 'Q192761', null, null, 18, 48),
  ('county-down', 'County Down', 'GB', 'Northern Ireland', 'County', 'Q190684', null, null, 18, 49),
  ('county-fermanagh', 'County Fermanagh', 'GB', 'Northern Ireland', 'County', 'Q190678', null, null, 18, 50),
  ('county-londonderry', 'County Londonderry', 'GB', 'Northern Ireland', 'County', 'Q192208', null, null, 18, 51),
  ('county-tyrone', 'County Tyrone', 'GB', 'Northern Ireland', 'County', 'Q192229', null, null, 18, 52),
  ('aberdeen-city', 'Aberdeen City', 'GB', 'Scotland', 'Council area', 'Q62274582', 57.15, -2.1, 18, 53),
  ('aberdeenshire', 'Aberdeenshire', 'GB', 'Scotland', 'Council area', 'Q189912', 57.151, -2.123, 18, 54),
  ('angus', 'Angus', 'GB', 'Scotland', 'Council area', 'Q202177', 56.6667, -2.9167, 18, 55),
  ('argyll-and-bute', 'Argyll and Bute', 'GB', 'Scotland', 'Council area', 'Q202174', 55.9833, -5.45, 18, 56),
  ('city-of-edinburgh', 'City of Edinburgh', 'GB', 'Scotland', 'Council area', 'Q2379199', 55.9497, -3.1933, 18, 57),
  ('clackmannanshire', 'Clackmannanshire', 'GB', 'Scotland', 'Council area', 'Q207268', 56.1667, -3.75, 18, 58),
  ('dumfries-and-galloway', 'Dumfries and Galloway', 'GB', 'Scotland', 'Council area', 'Q126514', 55.07, -3.6031, 18, 59),
  ('dundee-city', 'Dundee City', 'GB', 'Scotland', 'Council area', 'Q2357511', 56.4667, -2.9167, 18, 60),
  ('east-ayrshire', 'East Ayrshire', 'GB', 'Scotland', 'Council area', 'Q209135', 55.5, -4.25, 18, 61),
  ('east-dunbartonshire', 'East Dunbartonshire', 'GB', 'Scotland', 'Council area', 'Q211889', 55.9333, -4.2167, 18, 62),
  ('east-lothian', 'East Lothian', 'GB', 'Scotland', 'Council area', 'Q207257', 55.9167, -2.75, 18, 63),
  ('east-renfrewshire', 'East Renfrewshire', 'GB', 'Scotland', 'Council area', 'Q211925', 55.7984, -4.2907, 18, 64),
  ('falkirk', 'Falkirk', 'GB', 'Scotland', 'Council area', 'Q216802', 56.001, -3.784, 18, 65),
  ('fife', 'Fife', 'GB', 'Scotland', 'Council area', 'Q201149', 56.25, -3.2, 18, 66),
  ('glasgow-city', 'Glasgow City', 'GB', 'Scotland', 'Council area', 'Q55934339', 55.85, -4.25, 18, 67),
  ('highland', 'Highland', 'GB', 'Scotland', 'Council area', 'Q208279', 57.5, -5, 18, 68),
  ('inverclyde', 'Inverclyde', 'GB', 'Scotland', 'Council area', 'Q208271', 55.9, -4.75, 18, 69),
  ('midlothian', 'Midlothian', 'GB', 'Scotland', 'Council area', 'Q206934', 55.8942, -3.0686, 18, 70),
  ('moray', 'Moray', 'GB', 'Scotland', 'Council area', 'Q211106', 57.4167, -3.25, 18, 71),
  ('north-ayrshire', 'North Ayrshire', 'GB', 'Scotland', 'Council area', 'Q206926', 55.6667, -4.7833, 18, 72),
  ('north-lanarkshire', 'North Lanarkshire', 'GB', 'Scotland', 'Council area', 'Q207111', 55.829, -3.922, 18, 73),
  ('orkney-islands', 'Orkney Islands', 'GB', 'Scotland', 'Council area', 'Q100166', 59, -3, 18, 74),
  ('outer-hebrides', 'Outer Hebrides', 'GB', 'Scotland', 'Council area', 'Q80967', 57.76, -7.02, 18, 75),
  ('perth-and-kinross', 'Perth and Kinross', 'GB', 'Scotland', 'Council area', 'Q207679', 56.4167, -3.4833, 18, 76),
  ('renfrewshire', 'Renfrewshire', 'GB', 'Scotland', 'Council area', 'Q211091', 55.8773, -4.3895, 18, 77),
  ('scottish-borders', 'Scottish Borders', 'GB', 'Scotland', 'Council area', 'Q211113', 55.36, -2.49, 18, 78),
  ('shetland-islands', 'Shetland Islands', 'GB', 'Scotland', 'Council area', 'Q47134', 60.3567, -1.2606, 18, 79),
  ('south-ayrshire', 'South Ayrshire', 'GB', 'Scotland', 'Council area', 'Q209131', 55.2833, -4.7, 18, 80),
  ('south-lanarkshire', 'South Lanarkshire', 'GB', 'Scotland', 'Council area', 'Q209142', 55.6, -3.7833, 18, 81),
  ('stirling', 'Stirling', 'GB', 'Scotland', 'Council area', 'Q217838', 56.2533, -4.3259, 18, 82),
  ('west-dunbartonshire', 'West Dunbartonshire', 'GB', 'Scotland', 'Council area', 'Q208121', 55.99, -4.515, 18, 83),
  ('west-lothian', 'West Lothian', 'GB', 'Scotland', 'Council area', 'Q204940', 55.9167, -3.5, 18, 84),
  ('blaenau-gwent', 'Blaenau Gwent', 'GB', 'Wales', 'Principal area', 'Q596885', 51.7833, -3.2, 18, 85),
  ('bridgend-county-borough', 'Bridgend County Borough', 'GB', 'Wales', 'Principal area', 'Q697126', 51.5067, -3.5794, 18, 86),
  ('caerphilly-county-borough', 'Caerphilly County Borough', 'GB', 'Wales', 'Principal area', 'Q748065', 51.656, -3.183, 18, 87),
  ('cardiff', 'Cardiff', 'GB', 'Wales', 'Principal area', 'Q24342199', 51.5, -3.1667, 18, 88),
  ('carmarthenshire', 'Carmarthenshire', 'GB', 'Wales', 'Principal area', 'Q217840', 51.8561, -4.3106, 18, 89),
  ('ceredigion', 'Ceredigion', 'GB', 'Wales', 'Principal area', 'Q217829', 52.2528, -4.0003, 18, 90),
  ('conwy-county-borough', 'Conwy County Borough', 'GB', 'Wales', 'Principal area', 'Q817971', 53.1406, -3.7706, 18, 91),
  ('denbighshire', 'Denbighshire', 'GB', 'Wales', 'Principal area', 'Q650682', 53.0867, -3.3544, 18, 92),
  ('flintshire', 'Flintshire', 'GB', 'Wales', 'Principal area', 'Q505610', 53.2175, -3.1432, 18, 93),
  ('gwynedd', 'Gwynedd', 'GB', 'Wales', 'Principal area', 'Q109128', 52.8333, -3.9167, 18, 94),
  ('isle-of-anglesey', 'Isle of Anglesey', 'GB', 'Wales', 'Principal area', 'Q42617191', 53.25, -4.3333, 18, 95),
  ('merthyr-tydfil-county-borough', 'Merthyr Tydfil County Borough', 'GB', 'Wales', 'Principal area', 'Q3306663', 51.75, -3.3833, 18, 96),
  ('monmouthshire', 'Monmouthshire', 'GB', 'Wales', 'Principal area', 'Q207176', 51.7833, -2.8667, 18, 97),
  ('neath-port-talbot', 'Neath Port Talbot', 'GB', 'Wales', 'Principal area', 'Q748078', 51.6456, -3.745, 18, 98),
  ('newport', 'Newport', 'GB', 'Wales', 'Principal area', 'Q5283458', 51.588, -2.997, 18, 99),
  ('pembrokeshire', 'Pembrokeshire', 'GB', 'Wales', 'Principal area', 'Q213361', 51.845, -4.8422, 18, 100),
  ('powys', 'Powys', 'GB', 'Wales', 'Principal area', 'Q156150', 52.3, -3.4, 18, 101),
  ('rhondda-cynon-taf', 'Rhondda Cynon Taf', 'GB', 'Wales', 'Principal area', 'Q817960', 51.65, -3.44, 18, 102),
  ('swansea', 'Swansea', 'GB', 'Wales', 'Principal area', 'Q10996863', 51.5833, -4, 18, 103),
  ('the-vale-of-glamorgan', 'The Vale of Glamorgan', 'GB', 'Wales', 'Principal area', 'Q844784', 51.4167, -3.4167, 18, 104),
  ('torfaen', 'Torfaen', 'GB', 'Wales', 'Principal area', 'Q643919', 51.6986, -3.0533, 18, 105),
  ('wrexham-county-borough', 'Wrexham County Borough', 'GB', 'Wales', 'Principal area', 'Q843868', 53.0507, -3.0094, 18, 106)
on conflict (slug) do nothing;

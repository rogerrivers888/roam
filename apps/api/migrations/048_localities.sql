-- A place you can point at.
--
-- Owner, 5 Sep 2026: "I don't like having to just see SL4 Windsor in a list.
-- That should be a proper structure where I can select a county, or I can
-- select a city, or I can select a postcode, and I can see all my stats and all
-- my data for that particular location. That's a first-class citizen."
--
-- And, on how one should be named: "Take the place name from the OSM place
-- name."
--
-- **Why this is one table and not a tree.** A town nests inside a county; a
-- postcode district does not. The ONS's own answer for SL4 names five
-- administrative districts — Windsor and Maidenhead, Slough, Bracknell Forest,
-- Buckinghamshire and Runnymede — and an administrative county of Surrey. So a
-- strict parent-child hierarchy would have to lie about at least four of them.
--
-- What is true instead: every one of these is a *place*, each has a set of
-- points inside it, and the sets overlap. `parent_slug` is therefore a
-- convenience for the one case that genuinely nests (a town inside its county)
-- and is null for a postcode district, which is navigated to rather than
-- descended into. The owner's requirement — "be able to look at each one of
-- those through the same lens" — is met by one row shape and one page, not by
-- one ladder.
--
-- **Where the names come from, and why each is keyless.**
--   town      OpenStreetMap, via Nominatim reverse at zoom 12. Zoom 10 answers
--             with the council ("Royal Borough of Windsor and Maidenhead") and
--             zoom 14 with a suburb ("Clewer New Town"); 12 is the level that
--             says "Windsor". `localityOf()` in sources/geocode.js already
--             folds Greater London's 33 boroughs into one London, which is the
--             rule everywhere else in Roam.
--   county    `regions`, which the atlas harvest already fills.
--   postcode  the outward code, from api.postcodes.io — ONS's own postcode
--             directory, free and without an account, and already called by
--             sources/postcodeAreas.js.
--
-- Nothing here is licensed content: a place name and a boundary centroid from
-- OSM and ONS are open data we may keep for good (Technical Constraints §4).

-- ---------------------------------------------------------------------------
-- the places themselves
-- ---------------------------------------------------------------------------

create table if not exists localities (
  slug          text primary key,               -- 'windsor', 'berkshire', 'sl4'
  name          text not null,                  -- 'Windsor' — what a person says
  kind          text not null,                  -- county | town | postcode
  country_code  text not null default 'GB',
  nation        text,                           -- England | Scotland | Wales | Northern Ireland

  -- The one relationship that is actually true: a town sits in a county. Null
  -- for a county (nothing above it that we hold) and for a postcode district
  -- (which sits in several and belongs to none).
  parent_slug   text references localities(slug) on delete set null,

  -- Where it is, for the map and for ordering by distance.
  lat           double precision,
  lng           double precision,

  -- What it is called by the bodies that name it, kept beside the OSM name
  -- rather than instead of it. `council` is "Royal Borough of Windsor and
  -- Maidenhead"; `name` is "Windsor". Both are true and they answer different
  -- questions.
  council       text,
  osm_ref       text,                           -- 'relation/123' where Nominatim gave one

  -- Counts, refreshed rather than incremented, so a locality cannot drift out
  -- of step with the rows that point at it (the same rule as regions).
  to_go_count   integer not null default 0,
  to_eat_count  integer not null default 0,
  image_count   integer not null default 0,

  first_seen    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists localities_kind_idx   on localities (kind, name);
create index if not exists localities_parent_idx on localities (parent_slug, name);

-- ---------------------------------------------------------------------------
-- what each place holds
-- ---------------------------------------------------------------------------
--
-- A row carries both of its answers because they are two different lenses on
-- the same point and neither is derivable from the other: `locality_slug` is
-- the town OSM says it is in, `outcode` is the postal district ONS says it is
-- in, and SL4 is exactly the case where they disagree about which county that
-- makes it. Storing both means the place page can be opened either way without
-- a join through geometry we do not hold.

alter table attractions   add column if not exists locality_slug text references localities(slug) on delete set null;
alter table attractions   add column if not exists outcode       text;
alter table scout_places  add column if not exists locality_slug text references localities(slug) on delete set null;
alter table scout_places  add column if not exists outcode       text;

create index if not exists attractions_locality_idx  on attractions  (locality_slug, state);
create index if not exists attractions_outcode_idx   on attractions  (outcode);
create index if not exists scout_places_locality_idx on scout_places (locality_slug);
create index if not exists scout_places_outcode_idx  on scout_places (outcode);

-- Which places have been through the locality pass, so a run that is
-- interrupted — and every deploy interrupts one — resumes where it stopped
-- rather than asking Nominatim about 7,700 places again. Null means never
-- looked at; a stamp means looked at, whether or not an answer came back.
alter table attractions  add column if not exists located_at timestamptz;
alter table scout_places add column if not exists located_at timestamptz;
create index if not exists attractions_located_idx  on attractions  (located_at nulls first) where lat is not null;
create index if not exists scout_places_located_idx on scout_places (located_at nulls first);

-- ---------------------------------------------------------------------------
-- the counties we already have
-- ---------------------------------------------------------------------------
--
-- `regions` is already the county layer and there is no sense in a second copy
-- of it, so every region becomes a locality with the same slug. The atlas's own
-- foreign keys go on pointing at `regions`; this row is how a county is reached
-- through the same door as a town and a postcode district.

insert into localities (slug, name, kind, country_code, nation, lat, lng)
select r.slug, r.name, 'county', r.country_code, r.nation, r.lat, r.lng
  from regions r
on conflict (slug) do nothing;

-- Postcode districts the sweep already knows about, so SL4 is reachable on day
-- one. Its label is the town ONS gave when it was added; the locality pass
-- replaces that with OSM's name for the same point.
insert into localities (slug, name, kind, country_code, lat, lng)
select lower(a.code), coalesce(a.label, a.code), 'postcode', a.country_code, a.lat, a.lng
  from scout_areas a
on conflict (slug) do nothing;

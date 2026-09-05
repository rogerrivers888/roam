-- What there is to do, what it costs, and why it is worth the drive
-- (owner, 5 Sep 2026).
--
-- > "What there is to do… the rating system… I like to layer in descriptions,
-- > so when a user clicks on the side drawer, it can actually then open that
-- > location and read about it… all the key information, like how much
-- > something costs, what rides there are at Thorpe Park, all of that
-- > information we need to capture."
--
-- Migration 036 gave the atlas a name, a photograph and a rank. What it did not
-- give it was an answer to "and then what?". `attractions.summary` is the first
-- four sentences of a Wikipedia article, which says what a place *is* and never
-- once says what you would do there on a Saturday.
--
-- This adds the second half, and every source in it grants a standing licence
-- to keep and republish, because the whole point of the atlas is that it works
-- when the signal does not:
--
--   Wikipedia sections   CC BY-SA  — the read, in the sections its editors
--                                    chose: "The Gardens", "The Great Kitchen".
--   Wikivoyage listings  CC BY-SA  — a travel guide's own See and Do entries,
--                                    written for somebody deciding to visit
--                                    rather than for an encyclopedia.
--   OpenStreetMap        ODbL      — opening hours, whether there is a fee,
--                                    step-free access, toilets, parking, and
--                                    (through sources/inside.js) the rides.
--   Wikidata             CC0       — designations and awards.
--   Their own page       facts     — the admission prices, which nobody else
--                                    publishes and they publish on purpose.
--                                    Their figures, not their prose.
--
-- No provider's name, hours, rating, review or photograph is admissible here,
-- for the same reason as everywhere else: this table goes to a device, and a
-- device is somewhere we cannot reach to delete anything from.

-- ---------------------------------------------------------------------------
-- the long read, and the practicalities
-- ---------------------------------------------------------------------------

-- One row per attraction, in its own table rather than as eight more columns on
-- `attractions`, for the same reason `image_variants` is separate: the library
-- grid, the ranking and the coverage report all read the narrow row hundreds at
-- a time and none of them wants to drag six kilobytes of prose through the pool.
-- The detail is read one at a time, by a drawer, which is exactly when the cost
-- is affordable.
create table attraction_details (
  attraction_id uuid primary key references attractions(id) on delete cascade,
  -- Carried so a re-harvest that replaces the row can find its way back to the
  -- research rather than throwing it away and asking Wikipedia again.
  wikidata_id   text not null,

  -- The read. `sections` is the article as its editors divided it, each entry
  -- { heading, text, source, sourceUrl }, so a drawer can show "History" and
  -- "The Gardens" as headings rather than one undifferentiated wall.
  sections      jsonb not null default '[]',
  -- The things to do, named. Wikivoyage's See and Do listings are already a
  -- list of exactly this, written by people who went: { name, note, price,
  -- hours, source }. This is prose-derived and separate from `place_contents`,
  -- which is the same question answered by the map.
  highlights    jsonb not null default '[]',

  -- What it costs to walk in. { free, adult, child, family, concession, note,
  -- currency, source, sourceUrl, seenAt }. Held as text, not as a number:
  -- "£14.00 online, £16.50 on the day" is the true answer and rounding it to
  -- 14 would be inventing a price nobody charges.
  --
  -- A price is the one fact here that goes stale on a clock nobody tells us
  -- about, so `seenAt` travels with it and a screen that shows a price older
  -- than a season must say when it was read.
  admission     jsonb not null default '{}',
  -- How to go. { openingHours, seasonal, duration, booking, parking, dogs,
  -- toilets, cafe, wheelchair, stepFree, phone, address }.
  visit         jsonb not null default '{}',

  -- What is inside, counted here so the list can say "42 rides" without
  -- joining. The rows themselves live in `place_contents` (migration 030),
  -- keyed by 'wikidata:Q…', because a theme park's rides are the same rides
  -- whether a household saved it or the atlas published it.
  contents_ref   text,
  contents_count integer not null default 0,

  -- Every credit that must appear wherever any of this is shown, and which
  -- field came from where, so a wrong answer can be traced instead of argued
  -- about.
  attribution   jsonb not null default '[]',
  provenance    jsonb not null default '{}',

  state         text not null default 'pending',  -- pending | done | partial | failed
  error         text,
  attempts      integer not null default 0,
  next_attempt_at timestamptz,
  researched_at timestamptz,
  updated_at    timestamptz not null default now()
);
create index attraction_details_pending_idx on attraction_details (state, next_attempt_at) where state <> 'done';
create index attraction_details_wikidata_idx on attraction_details (wikidata_id);

-- ---------------------------------------------------------------------------
-- the designations, and the band
-- ---------------------------------------------------------------------------

-- Owner, 5 Sep 2026: "I want the same 4 wide bands as the restaurant, but then
-- layer in the World Heritage and Green Flag, etc., because that's of real
-- value and significantly differs from restaurant."
--
-- Both halves of that are here.
--
-- `accolades` is the attraction's answer to `sources/accolades.js`. A rating is
-- a licensed figure we may not keep; that somewhere is a World Heritage Site,
-- or holds a Green Flag, is a fact about who said what, published in order to
-- be quoted, and ours for good. Migration 036 already read one of these —
-- `heritage` — and threw the rest away, keeping the first designation and
-- dropping a place's other four. They are worth more than that, so they are
-- kept in full and scored.
--
-- `band` is the shared vocabulary: the same four words `crowdBand` gives a
-- restaurant, so an attraction and a restaurant can sit in one ranked list
-- without anybody having to explain which scale is which. What is behind the
-- word is different — a restaurant's band is a licensed crowd rating banded at
-- the moment of the fetch, an attraction's is a score made entirely of things
-- we own — and that difference is the point rather than a compromise.
--
-- `roam_score` is the same 0–10 the restaurant score reports, so the two sort
-- together. `score` stays 0–1 and region-relative and is still the working.
alter table attractions
  add column accolades  jsonb not null default '[]',   -- [{ key, label, source }]
  add column acclaim    double precision not null default 0,
  add column band       text,                          -- top | high | good | mixed
  add column roam_score double precision not null default 0,
  -- Whether anybody has been and looked at the detail. Denormalised from
  -- attraction_details so the grid can show a coverage column without a join.
  add column detail_state text;
create index attractions_band_idx on attractions (band, roam_score desc);

-- Existing rows keep their rank but have no band until the next re-rank, which
-- `rankRegion` now does as part of ranking. Setting it here from the score
-- already stored means the back office is not blank between deploying this and
-- running a harvest.
update attractions set
  roam_score = round((score * 10)::numeric, 1),
  band = case
    when score >= 0.62 then 'top'
    when score >= 0.52 then 'high'
    when score >= 0.43 then 'good'
    else 'mixed'
  end
where state = 'published';

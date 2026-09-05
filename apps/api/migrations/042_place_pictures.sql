-- A picture for a place to eat, without taking anybody's photographs.
--
-- Owner, 5 Sep 2026: "we need to go around the world and start digitising menus
-- in restaurants, and that is a monster job… on delivery, they have 1 photo of
-- the food for each restaurant, and it just provides something swipeable…  We
-- don't even have logos or anything like that, so it would just be a text
-- listing, which is okay but not ideal. The only other option is to use generic
-- images (a huge bank) and just mix and match them for all the different
-- restaurants, but that's a bit misleading."
--
-- He is right that it is misleading, and right that a text listing is thin. The
-- way out is that the delivery apps did not take those photographs either — the
-- restaurant uploaded one during onboarding, under a contract. We have no such
-- contract, so we go and find the pictures that are already ours to hold.
--
-- Migration 036 built the library for exactly this and said, of the atlas:
--
--     "No Google photo, no TripAdvisor photo and no scraped image is
--      admissible."
--
-- That sentence stays true of photographs. This migration adds two kinds of
-- picture that are not photographs of a place's food, and each stands on its
-- own footing rather than on the CC licences 036 was written around:
--
--   logo          The business's own mark, taken from the icon it publishes for
--                 other people's software to draw — apple-touch-icon, the
--                 favicon, schema.org Organization.logo. This is trade mark, not
--                 copyright, and showing a mark to identify the business it
--                 belongs to is referential use: it is what every map, review
--                 site and aggregator does, and it is the opposite of passing
--                 off. `licence` records that basis in words rather than
--                 pretending a CC deed was read, and `restrictions` says out
--                 loud that the mark is theirs. If the owner disagrees with this
--                 reading, deleting every row where source = 'logo' removes it
--                 completely and the ladder falls through to the next rung.
--
--   kartaview     Street-level photography of the actual shopfront, published
--   mapillary     under CC BY-SA 4.0 by the person who drove past with a camera.
--                 Ours to keep and republish with the credit, on the same
--                 footing as a Commons photograph, and more useful on a card
--                 than a plate of food: it is what the household will be looking
--                 at when they walk down the street.
--
-- What is still not admissible, and is not added here: a photograph from
-- Google, Tripadvisor, Yelp or Foursquare, and any photograph lifted from a
-- restaurant's own gallery. Those stay rented — fetched at display, credited,
-- never written down (Technical Constraints §4).

-- ---------------------------------------------------------------------------
-- what we have already looked for
-- ---------------------------------------------------------------------------

-- `attractions` carries its own image_state (migration 039). A place has no such
-- row — it is a venue_ref and a place_record — so the same idea needs a table.
--
-- The point of it is the negative answer. Most restaurants in the world have no
-- Commons photograph, no Wikidata item and no street-level frame pointing the
-- right way, and a sweep that does not remember that will walk KartaView and
-- their website again for every one of them, every run, for ever.
create table place_image_passes (
  venue_ref    text primary key,
  -- found: something is linked and the card has a picture.
  -- none:  we looked properly and there is nothing we may hold.
  -- failed: the looking broke — a site down, an API refusing — so try again.
  state        text not null,
  -- Which rung answered, or the last rung tried when nothing did. One of
  -- household | logo | wikimedia | kartaview | mapillary.
  rung         text,
  -- Every rung that was walked and what it said, so "why has this got no
  -- picture" has an answer without re-running anything.
  tried        jsonb not null default '[]',
  attempts     integer not null default 0,
  error        text,
  -- Bumped when the ladder learns a new rung, so places settled as 'none' by an
  -- older version are looked at again without a person having to find them.
  picture_version integer not null default 1,
  looked_at    timestamptz not null default now(),
  next_attempt_at timestamptz
);
create index place_image_passes_state_idx on place_image_passes (state, next_attempt_at);
create index place_image_passes_version_idx on place_image_passes (picture_version);

-- ---------------------------------------------------------------------------
-- the library, widened
-- ---------------------------------------------------------------------------

-- A logo is small and square and a shopfront is wide, and both are stored at
-- whatever size the source gave us — there is no image library on the API to
-- resize with, and asking a venue's server for a rendering it does not offer is
-- not a thing we get to do. So `image_variants.width` stops meaning "the width
-- we asked Wikimedia to render" and starts also meaning "the width it came in
-- at", which `actual_width` already recorded truthfully either way.
comment on column image_variants.width is
  'The width this row is addressed by. For Wikimedia it is the width we asked their renderer for; for a logo or a street-level frame it is the width the file arrived at. actual_width is always what the bytes really are.';

comment on column image_assets.source is
  'wikimedia | kartaview | mapillary | logo | household | openverse | flickr | upload. Every value except logo carries a licence deed in licence_url; logo carries a legal basis in words (see migration 042).';

comment on column image_assets.licence is
  'The words to show and defend. A CC deed for a photograph; "Trade mark - shown to identify the business" for a logo, which is a different basis and deliberately does not pretend to be a licence.';

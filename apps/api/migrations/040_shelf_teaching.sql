-- What a place is *for*, as opposed to what it is.
--
-- The home screen's six words — Fun, Food, Culture, Adrenaline, Relaxing,
-- Outdoors — are not a taxonomy of places, they are a taxonomy of days. Roam
-- had been deriving them from the atlas's eight words for what a thing *is*,
-- and those eight are far too coarse to answer the other question: `active`
-- covers a Formula One circuit and a football ground alike, so the Adrenaline
-- shelf near London filled with Wembley, Stamford Bridge, Twickenham and the
-- Royal Military Academy Sandhurst.
--
-- The owner, 5 Sep 2026: "it's showing football stadiums. That's not what I
-- consider adrenaline. Adrenaline might be an activity like a flying lesson…
-- water skiing… parachuting… go-karting". And: "I would like to be able to
-- train it on anything that appears in the categorisation where I believe it's
-- wrong."
--
-- So the mapping stops being a guess baked into code and becomes a table
-- somebody can teach. A rule says: this subject belongs on these shelves, with
-- this much weight each, and here is why. The weights are the answer to the
-- other half of what he asked for — "something could be adrenaline and it also
-- could be fun, we probably need to have some weighting around which category
-- it should sit in, because we don't want to have lots of duplication between
-- the categories, and that will also annoy people". A shelf below the floor is
-- true but not worth showing, and only the strongest two ever draw a card.
create table shelf_rules (
  id             uuid primary key default gen_random_uuid(),
  -- How this rule finds a place, narrowest first when they compete:
  --   place       one place, by the reference the home screen already carries
  --               ('wikidata:Q42' or 'osm:way/123')
  --   kind        a Wikidata type from `attractions.kinds` ('Q1154710', an
  --               association football venue) — teaching every stadium at once
  --   category    one of the atlas's eight words ('active')
  --   experience  one of the closed experience terms the live look-around
  --               returns ('climbing'), for the OpenStreetMap pool
  scope          text not null check (scope in ('place', 'kind', 'category', 'experience')),
  subject        text not null,
  -- What to call it on screen. A Q-number is not a thing anybody can teach
  -- against, so the label is carried here rather than looked up per render.
  subject_label  text,
  -- { "fun": 1, "adrenaline": 0.2 } over the six mood keys. A shelf that is
  -- absent is a shelf this subject is not on at all.
  weights        jsonb not null default '{}',
  -- Why, in the words of whoever taught it. Shown back on the screen: a rule
  -- nobody can account for is a rule nobody dares change.
  reason         text,
  taught_by      text,
  -- Rules that arrived with the code, so the screen can say which of them a
  -- person decided and which Roam merely started with.
  seeded         boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (scope, subject)
);
create index shelf_rules_scope_idx on shelf_rules (scope, subject);

-- ---------------------------------------------------------------------------
-- what we already know is wrong
-- ---------------------------------------------------------------------------
--
-- Only the types that are demonstrably miscategorised today, each with the
-- reason it is being moved. Everything else keeps the coarse default in
-- domain/shelves.js until somebody teaches it, because seeding a speculative
-- list of what *might* be adrenaline is the same guessing this table exists to
-- replace.

insert into shelf_rules (scope, subject, subject_label, weights, reason, taught_by, seeded) values
  -- Watching sport is a grand day out. The adrenaline is the players'.
  ('kind', 'Q1076486',  'sports venue',              '{"fun": 0.9}',                  'Somewhere sport happens. Watching it is a day out, not a thrill — the adrenaline belongs to whoever is playing.', 'Roam', true),
  ('kind', 'Q483110',   'stadium',                   '{"fun": 0.9}',                  'A stadium is somewhere you sit and watch. Fun, not Adrenaline.', 'Roam', true),
  ('kind', 'Q1049757',  'multi-purpose stadium',     '{"fun": 0.9}',                  'A stadium is somewhere you sit and watch. Fun, not Adrenaline.', 'Roam', true),
  ('kind', 'Q1154710',  'association football venue','{"fun": 0.9}',                  'The owner, 5 Sep 2026: football stadiums are not adrenaline.', 'Roam', true),
  ('kind', 'Q45290083', 'rugby league venue',        '{"fun": 0.9}',                  'Watching, not doing.', 'Roam', true),
  ('kind', 'Q15303456', 'rugby union venue',         '{"fun": 0.9}',                  'Watching, not doing.', 'Roam', true),
  ('kind', 'Q595452',   'baseball venue',            '{"fun": 0.9}',                  'Watching, not doing.', 'Roam', true),
  ('kind', 'Q682943',   'cricket field',             '{"fun": 0.9}',                  'Watching, not doing.', 'Roam', true),
  ('kind', 'Q11822917', 'horse racing venue',        '{"fun": 0.9}',                  'A race meeting is a day out — Ascot is a hat and a picnic, not a parachute.', 'Roam', true),
  -- Arenas and halls are where a gig or a show is, which is Fun and often Culture.
  ('kind', 'Q641226',   'arena',                     '{"fun": 0.9, "culture": 0.6}',  'An arena is where a gig or a show is.', 'Roam', true),
  ('kind', 'Q27951514', 'indoor arena',              '{"fun": 0.9, "culture": 0.6}',  'An arena is where a gig or a show is.', 'Roam', true),
  ('kind', 'Q1763828',  'multi-purpose hall',        '{"fun": 0.9, "culture": 0.6}',  'A hall is whatever is on in it — a show, not a sport.', 'Roam', true),
  ('kind', 'Q18674739', 'event venue',               '{"fun": 0.9, "culture": 0.6}',  'A venue is whatever is on in it.', 'Roam', true),
  -- The one thing on the Adrenaline shelf that has earned its place.
  ('kind', 'Q2338524',  'motorsport racing track',   '{"adrenaline": 1, "fun": 0.7}', 'A circuit you can drive or ride on. This is what Adrenaline means.', 'Roam', true),
  ('kind', 'Q1777138',  'race track',                '{"adrenaline": 0.8, "fun": 0.7}', 'A track built for speed.', 'Roam', true),
  -- Not a sports venue at all; Wikidata files it under one.
  ('kind', 'Q917182',   'military academy',          '{"culture": 0.9}',              'The Royal Military Academy Sandhurst is a historic institution you visit, not a sport. Wikidata files it under sports venue; it is Culture.', 'Roam', true)
on conflict (scope, subject) do nothing;

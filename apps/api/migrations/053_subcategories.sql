-- One category per place, and a second level under each.
--
-- The owner, 5 Sep 2026: "I don't want any duplication between categories, and
-- I'd actually like to have subcategories under each… We probably need a
-- settings page where we can add the subcategories manually. I'd like a way to
-- be able to, on the fly, just select something and change the category or
-- subcategory very quickly from the shelves page."
--
-- Three things follow, and this migration is the first two.
--
-- **The two levels become data.** They were a list in `domain/moods.js`, which
-- meant "add a subcategory" was a deploy. They are now two tables the back
-- office writes, and the code reads what is in them. The eight categories are
-- seeded exactly as they were, so nothing moves on the day this lands.
--
-- **No duplication is enforced, not remembered.** `shelf_subcategories.key` is
-- unique across the whole table rather than per category, so a subcategory
-- cannot exist under two parents — "Gardens" is Relaxing or it is Outdoors, and
-- the database will not let it be both. And a place now draws on exactly one
-- category (domain/moods.js: the highest weight wins, ties by the order the
-- chips are in), so the same card can never appear twice on one screen.
--
-- The weights survive that change and are still the mechanism: they used to
-- decide *how many* shelves a place drew on, and now they decide *which one*.
-- Everything already taught keeps working, and the second-strongest claim is
-- still recorded — it is what the back office shows when it explains why a
-- place went where it did.

-- ---------------------------------------------------------------------------
-- the first level
-- ---------------------------------------------------------------------------

create table shelf_categories (
  key         text primary key,                 -- 'fun', and what a rule's weights are keyed by
  label       text not null,                    -- 'Fun'
  blurb       text,                             -- what it means, in the owner's words where he gave them
  icon        text,                             -- a name from components/Icon.tsx
  position    integer not null default 100,
  -- Food is a chip that navigates rather than a shelf that fills (owner, 5 Sep
  -- 2026: "if I clicked on food, it would take me to the places tab"). The home
  -- screen needs to know that from the data now that the list is not in code.
  is_door     boolean not null default false,
  active      boolean not null default true,
  seeded      boolean not null default false,   -- arrived with the code rather than being typed
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- the second level
-- ---------------------------------------------------------------------------

create table shelf_subcategories (
  id           uuid primary key default gen_random_uuid(),
  category_key text not null references shelf_categories(key) on delete cascade,
  -- Unique across the table, not within the category. This one line is the
  -- owner's "no duplication between categories and subcategories": a
  -- subcategory has exactly one parent and the database is what says so.
  key          text not null unique,
  label        text not null,
  blurb        text,
  position     integer not null default 100,
  active       boolean not null default true,
  seeded       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index shelf_subcategories_category_idx on shelf_subcategories (category_key, position);

-- A rule may now name the drawer as well as the shelf.
alter table shelf_rules add column subcategory text references shelf_subcategories(key) on delete set null;

-- ---------------------------------------------------------------------------
-- the eight, exactly as they already were
-- ---------------------------------------------------------------------------

insert into shelf_categories (key, label, blurb, icon, position, is_door, seeded) values
  ('fun',        'Fun',        'A good day out. Somewhere you go and enjoy yourself.',                                     'festival',   10, false, true),
  ('food',       'Food',       'Somewhere you eat or drink. A door into Places rather than a shelf of its own.',           'restaurant', 20, true,  true),
  ('culture',    'Culture',    'Museums, galleries, castles, cathedrals, theatres, historic institutions.',                'museum',     30, false, true),
  ('sport',      'Sport',      'The ticket and the membership: a fixture, a race meeting, a club you belong to.',          'bowling',    40, false, true),
  ('activity',   'Active',     'What you turn up and do: the pool, the rink, the track, the leisure centre.',              'sport',      50, false, true),
  ('adrenaline', 'Adrenaline', 'Something you do that gets your heart going — karting, a flying lesson, water skiing.',    'climbing',   60, false, true),
  ('relaxing',   'Relaxing',   'A gentle day. A garden, a browse, a spa.',                                                 'walk',       70, false, true),
  ('outdoors',   'Outdoors',   'The point of it is being outside.',                                                        'park',       80, false, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- the drawers inside them
-- ---------------------------------------------------------------------------
--
-- A first pass, and deliberately a modest one: broad enough that every place in
-- the atlas has somewhere to sit, narrow enough that the name tells you what
-- you would do there. They are seeded rather than fixed — the whole point of
-- putting them in a table is that the back office adds, renames and reorders
-- them without a deploy.
--
-- Two rules held throughout. Nothing appears under two parents (a garden is
-- Relaxing, a country park is Outdoors, and they are different drawers rather
-- than the same one twice). And nothing is named for what a place *is* when the
-- category is about what a day there is *like* — "Theme parks & rides" rather
-- than "amusement park".

insert into shelf_subcategories (category_key, key, label, blurb, position, seeded) values
  -- Fun
  ('fun', 'theme-parks',      'Theme parks & rides',       'A day of rides.', 10, true),
  ('fun', 'zoos-wildlife',    'Zoos, farms & aquariums',   'Animals you go and see.', 20, true),
  ('fun', 'play',             'Play & soft play',          'Playgrounds, adventure play, trampolines.', 30, true),
  ('fun', 'cinema-bowling',   'Cinema, bowling & arcades', 'An afternoon indoors.', 40, true),
  ('fun', 'live-music',       'Live music & comedy',       'A gig, a show, a night out. The big arenas live here rather than under Culture.', 50, true),
  ('fun', 'lidos',            'Lidos & outdoor swimming',  'The owner, 5 Sep 2026: "the Lido… more like fun". An indoor pool you swim lengths in is Active; a lido is an afternoon.', 60, true),
  ('fun', 'days-out',         'Days out',                  'A good day somewhere that is not any of the above.', 90, true),

  -- Food
  ('food', 'restaurants',     'Restaurants',               null, 10, true),
  ('food', 'pubs-bars',       'Pubs & bars',               null, 20, true),
  ('food', 'cafes',           'Cafés & bakeries',          null, 30, true),
  ('food', 'food-markets',    'Street food & food markets', null, 40, true),

  -- Culture
  ('culture', 'museums',      'Museums',                   null, 10, true),
  ('culture', 'galleries',    'Art galleries',             null, 20, true),
  ('culture', 'castles',      'Castles & forts',           null, 30, true),
  ('culture', 'historic-houses', 'Historic houses & palaces', 'The great house and its state rooms.', 40, true),
  ('culture', 'churches',     'Cathedrals, churches & abbeys', null, 50, true),
  ('culture', 'ancient-sites', 'Ancient & archaeological sites', 'Stone circles, Roman remains, hill forts.', 60, true),
  ('culture', 'theatre',      'Theatre & concert halls',   'The building you buy a seat in.', 70, true),
  ('culture', 'landmarks',    'Landmarks & monuments',     'The thing you go and look at.', 80, true),

  -- Sport
  ('sport', 'football',       'Football grounds',          null, 10, true),
  ('sport', 'rugby-cricket',  'Rugby & cricket grounds',   null, 20, true),
  ('sport', 'racecourses',    'Racecourses',               'A race meeting: a hat, a picnic and a card.', 30, true),
  ('sport', 'golf',           'Golf clubs',                'Usually a membership, which is what makes it this rather than Active.', 40, true),
  ('sport', 'racquet-clubs',  'Tennis & racquet clubs',    null, 50, true),
  ('sport', 'arenas',         'Stadiums & arenas',         'The big grounds, and the venues that host several sports.', 60, true),

  -- Active
  ('activity', 'pools',       'Pools & leisure centres',   'You turn up and swim.', 10, true),
  ('activity', 'climbing',    'Climbing & bouldering',     null, 20, true),
  ('activity', 'skating',     'Ice rinks & skating',       null, 30, true),
  ('activity', 'cycling',     'Cycling & bike trails',     null, 40, true),
  ('activity', 'paddling',    'Rowing, paddling & sailing', 'Getting on the water yourself.', 50, true),
  ('activity', 'athletics',   'Athletics & running tracks', null, 60, true),

  -- Adrenaline
  ('adrenaline', 'karting',   'Karting & driving experiences', 'The owner''s own example.', 10, true),
  ('adrenaline', 'circuits',  'Motorsport circuits',       'Brands Hatch, Goodwood, the Top Gear track.', 20, true),
  ('adrenaline', 'flying',    'Flying & skydiving',        'A flying lesson, a jump, a wind tunnel.', 30, true),
  ('adrenaline', 'watersports', 'Water skiing & wakeboarding', null, 40, true),
  ('adrenaline', 'ropes',     'High ropes & zip lines',    null, 50, true),
  ('adrenaline', 'off-road',  'Off-road & quad biking',    null, 60, true),

  -- Relaxing
  ('relaxing', 'gardens',     'Gardens & arboretums',      'The formal garden you pay to walk round. A country park is Outdoors.', 10, true),
  ('relaxing', 'spas',        'Spas & wellness',           null, 20, true),
  ('relaxing', 'browsing',    'Bookshops & browsing',      null, 30, true),
  ('relaxing', 'markets',     'Markets & antiques',        'A wander and a rummage.', 40, true),
  ('relaxing', 'scenic',      'Scenic drives & rides',     'The heritage railway, the river cruise, the road worth taking.', 50, true),

  -- Outdoors
  ('outdoors', 'parks',       'Parks & commons',           null, 10, true),
  ('outdoors', 'woodland',    'Woodland & forests',        null, 20, true),
  ('outdoors', 'coast',       'Beaches & coast',           null, 30, true),
  ('outdoors', 'water',       'Lakes & rivers',            'Somewhere to be beside the water. Getting on it is Active.', 40, true),
  ('outdoors', 'hills',       'Hills, moors & peaks',      null, 50, true),
  ('outdoors', 'nature',      'Nature reserves',           'Wild animals where they live. A zoo is Fun.', 60, true),
  ('outdoors', 'viewpoints',  'Viewpoints',                null, 70, true),
  ('outdoors', 'trails',      'Trails & long walks',       null, 80, true),
  ('outdoors', 'caves-falls', 'Caves & waterfalls',        null, 90, true)
on conflict (key) do nothing;

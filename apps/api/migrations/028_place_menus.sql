-- The menu, once, for everyone (owner, 4 Sep 2026).
--
-- > "It should be stored forever in our systems. It's our proprietary
-- > information that we've gone off and extracted and stored in our system, and
-- > that builds up our ecosystem of data. If someone else goes and pulls that
-- > same menu, we can update it, and we get a new updated menu. We should be
-- > able to update it for other users also."
--
-- `menus` (migration 022) stays exactly as it is: the household's own copy of a
-- menu it fetched, with the same standing as one it photographed, never pooled.
-- This is the layer beside it — what Roam has established about a restaurant's
-- menu, keyed on the place rather than the household, kept for good, and
-- rewritten by whoever reads it next. The second household to open The Ivy sees
-- what the first one found, and a read in December replaces a read in June.
--
-- Where the line falls, and why it falls there:
--
--   Kept here      the dish names, the prices, the sections they sit in, the
--                  calories and the allergen statement, the address the menu
--                  was read from, and when. Facts a restaurant publishes in
--                  order to be quoted: a name is a short title and not
--                  copyrightable, a price is a fact.
--   Not kept here  the restaurant's own descriptive prose. That is their
--                  writing, and pooling it across households is precisely the
--                  thing Technical Constraints L9 gates on a copyright review.
--                  It stays on menu_items, with the household that fetched it,
--                  where it has always been.
--
-- So this table can be built out, searched and shared now, and the review only
-- ever governs whether one column may join it later.

create table if not exists place_menus (
  venue_ref     text primary key,
  venue_label   text,
  source_url    text not null,
  source_kind   text not null,               -- 'html' | 'pdf' | 'json' | 'rendered' | 'claude'
  currency      text,
  note          text,                        -- how the menu prices itself ("two courses £28")
  section_count integer not null default 0,
  item_count    integer not null default 0,
  first_read_at timestamptz not null default now(),
  read_at       timestamptz not null default now(),
  -- How many times a household has read this menu. The number that says which
  -- places the dataset is actually being built on.
  reads         integer not null default 0
);
create index if not exists place_menus_read_idx on place_menus (read_at desc);

create table if not exists place_menu_items (
  venue_ref   text    not null references place_menus(venue_ref) on delete cascade,
  position    integer not null,
  section     text    not null,
  section_note text,
  name        text    not null,
  price       numeric(8,2),
  price_text  text,                          -- as the menu prints it: "£19 per person"
  kcal        integer,
  allergens   text,                          -- only what the menu itself states
  vegetarian  boolean,
  primary key (venue_ref, position)
);

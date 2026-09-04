-- The table half of an evening (owner, 4 Sep 2026): read the menu from the
-- restaurant's own page, tick who wants what, show the order to the waiter,
-- then star the dishes that stood out.
--
-- What is stored here is the household's own copy of a menu it fetched, which
-- has the same standing as a menu it photographed (Requirements §4, Epic 6):
-- household-scoped, never pooled, never searchable across households — that
-- stays gated on the copyright review (Technical Constraints L9). Prices carry
-- the moment they were read so the screen can mark them indicative (C8).

create table if not exists menus (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  venue_ref     text not null,
  venue_label   text,
  source_url    text not null,               -- the page or PDF the dishes came from
  source_kind   text not null,               -- 'html' | 'pdf' | 'json' | 'rendered' | 'claude' | 'photo'
  how           jsonb,                       -- the openers that were tried, in words, for the screen
  currency      text,
  note          text,                        -- how the menu prices itself (a set menu's courses)
  fetched_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists menus_household_venue_idx on menus (household_id, venue_ref, fetched_at desc);

create table if not exists menu_items (
  id            uuid primary key default gen_random_uuid(),
  menu_id       uuid not null references menus(id) on delete cascade,
  section       text not null,
  section_note  text,
  position      integer not null,
  name          text not null,
  description   text,
  price         numeric(8,2),                -- for the running total, when the item has one of its own
  price_text    text,                        -- exactly as the menu prints it: "£19 per person"
  kcal          integer,
  allergens     text,                        -- only what the menu itself states
  vegetarian    boolean
);
create index if not exists menu_items_menu_idx on menu_items (menu_id, position);

-- An order is what the table is having. It is written before it is placed, so
-- it survives the phone losing signal in a basement restaurant (Epic 6 C4);
-- the client-generated id makes a retry idempotent (C5).
create table if not exists orders (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid unique,
  household_id  uuid not null references households(id) on delete cascade,
  menu_id       uuid references menus(id) on delete set null,
  venue_ref     text not null,
  venue_label   text,
  visit_id      uuid references visits(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists orders_household_venue_idx on orders (household_id, venue_ref, created_at desc);

create table if not exists order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  menu_item_id  uuid references menu_items(id) on delete set null,
  member_id     uuid references members(id) on delete cascade,   -- null is "for the table"
  name          text not null,               -- kept so the order still reads if the menu is refetched
  price         numeric(8,2),
  price_text    text,
  note          text,                        -- "no chilli", said to the waiter
  position      integer not null default 0
);
create index if not exists order_items_order_idx on order_items (order_id, position);

-- A star belongs to the plate that was eaten, so a rating can find its way back
-- to the order it came from as well as to the dish concept (Epic 7 C10).
alter table ratings add column if not exists order_item_id uuid references order_items(id) on delete set null;
create index if not exists ratings_order_item_idx on ratings (order_item_id);

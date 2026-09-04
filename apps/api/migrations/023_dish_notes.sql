-- "What's this?" (owner, 4 Sep 2026): "often when I go to a restaurant, there
-- might not be a description of what it is, and it's just a dish in another
-- language. Having a 'What's this?' option could be nice, where it maybe
-- expands the section and just explains what that dish is, where it came from,
-- or what its history is."
--
-- This is Roam's own writing about a dish in general — not the restaurant's
-- copy, which stays on their page — so unlike a captured menu it is not tied to
-- one household: "supplì alla romana" means the same in Rome as in Fitzrovia,
-- and the second household to ask should not pay for the answer again. Keyed on
-- the name as written, so a menu that spells it differently gets its own note
-- rather than a wrong match.

create table if not exists dish_notes (
  id          uuid primary key default gen_random_uuid(),
  name_key    text not null unique,        -- the dish name, folded for matching
  name        text not null,               -- as the menu wrote it, for reading back
  known       boolean not null default true, -- false when Claude does not recognise it, so the screen can say to ask
  what        text not null,               -- one sentence: what it is and what is in it
  origin      text,                        -- one sentence: where it is from, or a line of its history
  model       text,
  created_at  timestamptz not null default now()
);

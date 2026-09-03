-- Profiles that look like a family, taste vocabulary, and the place ledger's
-- household-facing side (visits with ratings) — Requirements Epics 1, 2 and 7.

-- Member identity: a photo, a relationship label and an age. Age is stored as a
-- birth year so "under 13" (Epic 1 C8) is derived, not asserted.
alter table members
  add column relationship  text,            -- 'parent', 'partner', 'child', 'grandparent', 'friend', 'other'
  add column birth_year    integer,
  add column avatar_url    text;            -- data URL or https; household-generated content

-- Diet is a rule about the person, distinct from allergens (safety) and
-- dislikes (preference). Vegetarian never excludes a venue; it ranks and
-- explains, because most venues have something.
alter type constraint_kind add value if not exists 'diet';

-- Constraints link to the taste vocabulary so "spaghetti arrabbiata" and
-- "penne all'arrabbiata" count as the same thing (Epic 2 C6).
alter table member_constraints
  add column concept_key text,              -- e.g. 'dish:arrabbiata', 'experience:museum'
  add column concept_kind text;             -- 'dish' | 'experience' | 'cuisine' | 'diet' | null (free text)
create index member_constraints_concept_idx on member_constraints (concept_key);

-- Ratings gain a concept key (vocabulary-level, not per-household table) so a
-- rating at one venue transfers to every venue serving the same concept (Epic 7 C10).
alter table ratings add column concept_key text;
create index ratings_concept_idx on ratings (member_id, concept_key, created_at desc);

-- Visits can carry a household-written note and the source's category at the
-- time, both household-generated content.
alter table visits
  add column note      text,
  add column category  text,
  add column lat       double precision,
  add column lng       double precision;

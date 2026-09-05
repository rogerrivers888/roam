-- Reading a place properly, and being taught what "properly" means
-- (owner, 5 Sep 2026).
--
-- > "Instead of just capturing the first 4 lines, I'm wondering whether we
-- > break down what sort of facts and information we want… if it's a historical
-- > site, a bit of information about the history… how much it costs, what there
-- > is to see there, and whether it's a 20-minute trip or a very big, extensive
-- > location… We could go 1 by 1, comparing the wiki page to a locations page,
-- > showing what you're extracting… We could then train the AI on whether
-- > that's the right data to capture… Once we've trained it, we can let it
-- > loose."
--
-- Migration 041 fetched the whole Wikipedia article instead of four sentences,
-- which is retrieval. This is the reading: the article, the travel guide entry
-- and the venue's own page go in, and a filled-in form comes out — how long to
-- spend, who it suits, what to look at, what it costs, whether rain ruins it.
--
-- Two tables, and the second is the point.
--
--   attraction_facts     what was read, per place, with the sentence behind
--                        every claim so the owner can check it rather than
--                        trust it.
--   extraction_lessons   what he said back. These are injected into the prompt
--                        on the next read, which is the whole of what "training"
--                        means here and is deliberately not a fine-tune: a
--                        rule you can read, edit and delete beats weights
--                        nobody can inspect, and this is a screen whose entire
--                        job is being able to see why.
--
-- Nothing here is licensed content. The sources are the ones migration 041
-- already established as ours to keep — Wikipedia and Wikivoyage CC BY-SA,
-- OpenStreetMap ODbL, and facts a venue publishes about itself — and a
-- structured reading of a fact is still that fact. The credits ride along on
-- `attraction_details.attribution` exactly as before.

-- ---------------------------------------------------------------------------
-- what was read
-- ---------------------------------------------------------------------------

create table attraction_facts (
  attraction_id uuid primary key references attractions(id) on delete cascade,

  -- The filled-in form. One jsonb rather than fifteen columns because the shape
  -- is the thing under review: the owner is expected to say "you should also
  -- have captured X", and adding X must not be a migration.
  facts        jsonb not null default '{}',

  -- Every claim's evidence, keyed by field: { dwell: { quote, source } }. Kept
  -- beside the facts rather than inside them so the review screen can show the
  -- sentence next to the claim without walking the whole structure, and so a
  -- field with no quote is obvious — that is a judgement, not a reading, and it
  -- is exactly the kind that needs a person to look.
  evidence     jsonb not null default '{}',

  -- What the model said it could not find. A read that knows what it is missing
  -- is worth more than one that quietly leaves a field blank, and this is the
  -- list the owner scans to decide whether another source is worth adding.
  missing      text[] not null default '{}',
  confidence   text,                            -- high | medium | low, the model's own

  -- Which lessons were in the prompt when this was read, so a bad extraction
  -- can be traced to the rule that caused it. Without this, "it got worse after
  -- Tuesday" has no answer.
  lessons_used uuid[] not null default '{}',
  model        text,
  prompt_hash  text,                            -- the system prompt this was read under
  cost_usd     double precision,

  -- The owner's verdict. `pending` is read and not yet looked at; `approved` is
  -- him saying this is right, which promotes it to few-shot for later reads;
  -- `corrected` is him having changed something, which is where a lesson comes
  -- from; `rejected` is a read bad enough to throw away.
  review       text not null default 'pending', -- pending | approved | corrected | rejected
  review_note  text,
  reviewed_by  text,
  reviewed_at  timestamptz,
  -- Which fields he marked wrong, so the next prompt can lead with them and so
  -- a per-field accuracy number is available without re-reading anything.
  wrong_fields text[] not null default '{}',

  read_at      timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index attraction_facts_review_idx on attraction_facts (review, read_at desc);
create index attraction_facts_approved_idx on attraction_facts (review) where review = 'approved';

-- ---------------------------------------------------------------------------
-- what he taught it
-- ---------------------------------------------------------------------------

-- Owner, 5 Sep 2026, on what a correction should travel to: the kind of place.
-- "Castles should always say whether you can go up the keep" is not a fact
-- about Dover Castle, it is a fact about castles, and a lesson that only fixed
-- one row would be data entry rather than teaching.
--
-- Scoped to a Wikidata type rather than to the atlas's own eight categories,
-- because the categories are too coarse to teach against: Q23413 castle and
-- Q33506 museum are both `heritage` on some rows, and a rule about keeps must
-- not reach a museum. `place_kinds` already holds the label for ~1,500 types.
create table extraction_lessons (
  id          uuid primary key default gen_random_uuid(),
  -- 'all' — every read. 'kind' — every place of this Wikidata type. 'place' —
  -- this one row, for when the article itself is the odd thing.
  scope       text not null default 'kind',      -- all | kind | place
  subject     text,                              -- 'Q23413', or an attraction id
  subject_label text,                            -- 'castle', so the table reads

  -- The rule, in the owner's words where possible. This is what is pasted into
  -- the system prompt, so it is written as an instruction rather than as a
  -- complaint: "always say whether the keep is climbable", not "you missed the
  -- keep".
  rule        text not null,
  -- Which field it is about, so the prompt can put it beside that field rather
  -- than in a heap at the end.
  field       text,
  -- What he actually said, kept verbatim beside the tidied rule. When a lesson
  -- turns out to be wrong it is nearly always because the tidying lost
  -- something, and this is the only way to see that.
  said        text,
  -- The read that prompted it.
  from_attraction uuid references attractions(id) on delete set null,

  active      boolean not null default true,
  -- How many reads have been made under this rule, and how many he approved
  -- afterwards. A lesson that makes things worse is visible rather than
  -- theoretical.
  used_count     integer not null default 0,
  approved_after integer not null default 0,

  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index extraction_lessons_scope_idx on extraction_lessons (scope, subject) where active;

-- The owner reads and teaches; support and analysts may look.
insert into role_capabilities (role_id, capability)
select r.id, c.capability from roles r
  join (values
    ('admin', 'read_attractions'), ('admin', 'teach_extraction'),
    ('support', 'read_attractions'),
    ('analyst', 'read_attractions')
  ) as c(role_key, capability) on c.role_key = r.key
on conflict do nothing;

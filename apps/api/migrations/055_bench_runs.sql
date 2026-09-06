-- Whether our ranking agrees with the licensed one, over time.
--
-- Owner, 5 Sep 2026: "I want to be able to hit the API, check this, check our
-- ratings, compare them to their ratings, and show them in a table… that's
-- absolutely fundamental to what we do."
--
-- **What is kept, and what deliberately is not.** A run fetches live, compares
-- two orderings, shows the table, and then keeps only the verdict: how well the
-- two agreed, how many places disagreed badly, and which they were. No rating
-- is stored, and no position derived from one either — the per-place ranks live
-- in the response and nowhere else.
--
-- That is a stricter line than the licence strictly requires, and it is drawn
-- here on purpose. The value of this table is the *trend*: whether a change to
-- `domain/scoring.js` moved our agreement up or down, which is a question about
-- our own number and needs nothing of theirs to answer. Keeping the ranks would
-- add nothing to that and would quietly turn a comparison into a cache
-- (Technical Constraints §4).

create table if not exists bench_runs (
  id            uuid primary key default gen_random_uuid(),
  area_code     text not null references scout_areas(code) on delete cascade,

  -- How many places both lists held, and how many only one of them did. A place
  -- we keep that they do not rank is a finding in itself, and so is the reverse.
  compared      integer not null default 0,
  only_ours     integer not null default 0,
  only_theirs   integer not null default 0,

  -- Spearman's ρ between our order and theirs. 1 is the same order, 0 unrelated.
  agreement     real,
  -- The same, between our composite and our owned score. This is the one that
  -- says whether the ranking survives the licensed source going away.
  owned_agreement real,

  -- Places five or more positions apart: the handful worth reading one at a
  -- time, as against the average, which can look healthy while they are wrong.
  disputes      integer not null default 0,
  -- Which ones, by name, so a run can be argued with a month later.
  disputed      jsonb not null default '[]',

  -- When every place in an area bands the same word, the band is carrying no
  -- information. Recorded because it is a fact about our own scoring, and it is
  -- the finding most likely to change what `scoring.js` does next.
  band_saturated text,

  -- What the run cost, at list price, in US cents. Never an invoice.
  calls         integer not null default 0,
  cost_cents    integer not null default 0,

  ran_by        text,
  ran_at        timestamptz not null default now()
);
create index if not exists bench_runs_area_idx on bench_runs (area_code, ran_at desc);

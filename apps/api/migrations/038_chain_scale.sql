-- Chains are sorted, not killed (owner, 5 Sep 2026).
--
-- > "I'm not sure if we should deliberately kill all chains because some people
-- > love chains. I think I just didn't want to prioritise a chain in my
-- > listings, but we could have some great chains. They could even just be 2 or
-- > 3 stores in a chain… let's roll back on my decision for now and add in the
-- > chains also, but then we can just sort them… so that we're not showing
-- > McDonald's on the best restaurants list."
--
-- Migration 035 dropped anything that looked like a group at the gate, and 78
-- places across the SL districts went out on a boolean that could not tell two
-- brothers with a second site from a global quick-service brand. Both were "a
-- chain" and nothing useful followed from saying so.
--
-- So the boolean stays (the planner's own "allow chains" toggle reads it and is
-- not this decision's business), and beside it goes the thing that carries the
-- weight: how big. `sites` is Roam's own count of how many of its swept areas
-- hold a place of this name — the only signal here that needs no list, and the
-- only one that will ever notice a nine-site regional group nobody has heard
-- of. It gets better as the sweep covers more of the country, and `rescore`
-- recomputes it for nothing.

alter table scout_places add column if not exists chain_scale text not null default 'independent';
  -- independent | small (2–3) | regional (4–9) | national
alter table scout_places add column if not exists sites integer not null default 1;
create index if not exists scout_places_scale_idx on scout_places (chain_scale);

-- The count of what a sweep threw away stops meaning "dropped" and starts
-- meaning "found and weighted down", which is what the column now records.
comment on column scout_areas.chains is 'How many of the area''s places belong to a group. They are kept and weighted, not dropped (migration 036).';

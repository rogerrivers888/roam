-- Not every menu, and the rest on request (owner, 5 Sep 2026).
--
-- > "Maybe we just take the top 20% of restaurants' menus. A user can request
-- > the menu if they add it to a trip, and then we can go get the menu as soon
-- > as it's added. If they click on the button to request it, we can also go
-- > get it, and that will save us a lot… we can take the top 30 restaurants,
-- > which are really going to appear in most people's searches… In the case of
-- > London, we might take the top 10%."
--
-- Reading a menu is the only expensive thing the sweep does — about 30 cents a
-- restaurant against a fraction of a penny for everything else — and most of
-- them are never opened. Surrey and Berkshire at twenty-five menus an area is
-- roughly $500; at the top fifth of thirty it is nearer $200, and the sixth
-- one down is still a place anybody would actually consider.
--
-- Two columns, because the two numbers are different questions:
--
--   keep        how many of an area's restaurants Roam owns at all. Research is
--               free — the open map, their own page, the encyclopedias — so
--               this stays generous. Thirty, for these counties.
--   menu_share  what fraction of them get a menu read before anyone asks.
--
-- The rest are not refused, they are deferred: a household act — shortlisting,
-- planning, or simply opening the Menu tab — promotes a place into the queue
-- whatever its rank, and the menu is fetched then. That is the whole saving,
-- and it costs the household nothing but the first wait.

alter table scout_areas add column if not exists menu_share real not null default 0.2;

-- What Roam has spent on a menu nobody asked for, against one somebody did.
comment on column scout_areas.menu_share is
  'Fraction of an area''s ranked places whose menu is read before anyone asks. The rest are read on a household act (migration 041).';

-- Thorpe Park was under Culture.
--
-- Found while checking the first shelf rules against the deployed atlas: Thorpe
-- Park's Wikidata type is `amusement park`, but the atlas category on its row
-- is `landmark`, and `landmark` starts at Culture 0.9 — so the biggest theme
-- park in the county sat on the same shelf as Windsor Castle and St George's
-- Chapel.
--
-- Which is the case for teaching against the *type* rather than the category,
-- made twice over: a rule here fixes it whatever the category says, and it
-- fixes every other park with it. The category being wrong is a separate
-- problem on a separate axis (the Atlas screen's "What counts as somewhere to
-- go"), and this does not paper over it — `place_kinds.category` is untouched.
--
-- **The types are Fun, and the individual parks decide Adrenaline.** A first
-- draft put amusement parks at Adrenaline 0.8, which is right for Thorpe Park
-- and plainly wrong for Legoland — and because the strongest claim per shelf
-- wins within a scope, the broader type dragged Legoland onto the Adrenaline
-- shelf and its own narrower rule could not pull it back down. That is the
-- design working as intended rather than a hole in it: a type that covers both
-- a white-knuckle park and a day out with a four-year-old cannot decide, so it
-- says Fun, keeps its Adrenaline claim below the floor, and the parks that
-- really are a thrill are named one at a time. Thorpe Park is the first.
insert into shelf_rules (scope, subject, subject_label, weights, reason, taught_by, seeded) values
  ('kind', 'Q194195',  'amusement park', '{"fun": 1, "adrenaline": 0.4}', 'A day of rides is a day out. Whether it is also a thrill depends on the park, not on the type — Legoland and Thorpe Park are both this — so the type says Fun and leaves Adrenaline to be said about the park.', 'Roam', true),
  ('kind', 'Q2416723', 'theme park',     '{"fun": 1, "adrenaline": 0.5}', 'As amusement park: the type cannot tell a rollercoaster from a carousel.', 'Roam', true),
  ('kind', 'Q740326',  'water park',     '{"fun": 1, "adrenaline": 0.6}', 'Slides and flumes: something you do rather than watch.', 'Roam', true),
  ('kind', 'Q253302',  'Legoland',       '{"fun": 1}',                    'A day out with small children. Fun, and not a thrill ride.', 'Roam', true),
  -- The one the owner would expect to find under Adrenaline: Stealth, Nemesis
  -- Inferno, The Swarm. Named as a place because that is the only scope that
  -- can say it without saying it about Legoland too.
  ('place', 'wikidata:Q2301819', 'Thorpe Park', '{"fun": 1, "adrenaline": 0.9}', 'A thrill-ride park — this is the one amusement park near here that really is Adrenaline.', 'Roam', true)
on conflict (scope, subject) do nothing;

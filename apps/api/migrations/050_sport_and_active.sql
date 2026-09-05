-- Forty-seven stadiums were burying the Fun shelf.
--
-- Moving the grounds off Adrenaline (migration 040) put them on Fun, and near
-- Ascot that meant Wembley, Twickenham, Stamford Bridge, Ascot, Epsom, Kempton,
-- Sandown, Lord's, the Oval and thirty-eight more sitting where the days out
-- should be. The owner, 5 Sep 2026:
--
--   "Sports stadiums are not really normal days out. You go book your football
--    tickets or your rugby tickets. Wentworth Golf, you have to have a
--    membership for those. Those are different things. Dorney Lake and the
--    Lido, those are, I would say, more like fun, and the leisure centre is
--    active. I would say sports and active, or just active."
--
-- Two shelves rather than one, because he named two different things and they
-- behave differently:
--
--   Sport   You buy a ticket for a fixture, or you belong to the club. A
--           stadium, a racecourse, a golf club. Not a day you can decide on
--           over breakfast, which is what the home screen is for — so these
--           get their own shelf rather than crowding the one that answers
--           "what shall we do today".
--   Active  You turn up and do it: the pool, the ice rink, the athletics
--           track. His leisure centre.
--
-- Adrenaline is untouched and remains the third thing: the thrill, not the
-- fixture and not the exercise.
--
-- Two of his rulings are written in exactly as he gave them, against the type
-- rather than the place, so they hold for every lake and every lido: a rowing
-- and canoeing venue is Fun (Dorney Lake) and an outdoor pool is Fun (the
-- Lido). Both keep an Active claim below the floor, so if he ever disagrees the
-- number to move is already sitting there on the screen.

insert into shelf_rules (scope, subject, subject_label, weights, reason, taught_by, seeded) values
  -- --- Sport: the ticket and the membership ---------------------------------
  ('kind', 'Q1076486',  'sports venue',               '{"sport": 0.9, "fun": 0.4}', 'Somewhere a fixture happens. The owner, 5 Sep 2026: "sports stadiums are not really normal days out — you go book your football tickets".', 'Roam', true),
  ('kind', 'Q483110',   'stadium',                    '{"sport": 1, "fun": 0.4}',   'You book a ticket for a fixture. Its own shelf, not the one that answers "what shall we do today".', 'Roam', true),
  ('kind', 'Q1049757',  'multi-purpose stadium',      '{"sport": 1, "fun": 0.4}',   'You book a ticket for a fixture.', 'Roam', true),
  ('kind', 'Q1154710',  'association football venue', '{"sport": 1, "fun": 0.4}',   'You book your football tickets.', 'Roam', true),
  ('kind', 'Q45290083', 'rugby league venue',         '{"sport": 1, "fun": 0.4}',   'You book your rugby tickets.', 'Roam', true),
  ('kind', 'Q15303456', 'rugby union venue',          '{"sport": 1, "fun": 0.4}',   'You book your rugby tickets.', 'Roam', true),
  ('kind', 'Q595452',   'baseball venue',             '{"sport": 1, "fun": 0.4}',   'You book a ticket for a fixture.', 'Roam', true),
  ('kind', 'Q682943',   'cricket field',              '{"sport": 1, "fun": 0.4}',   'You book a ticket for a fixture.', 'Roam', true),
  ('kind', 'Q11822917', 'horse racing venue',         '{"sport": 1, "fun": 0.5}',   'A race meeting: a ticket and a date, though more of a day out than a league fixture.', 'Roam', true),
  -- Membership is the owner's own test, and it is the right one: a place you
  -- have to belong to is not somewhere a family decides to go on Saturday.
  ('kind', 'Q2022036',  'golf club',                  '{"sport": 0.9, "activity": 0.5}', 'The owner, 5 Sep 2026: "Wentworth Golf, you have to have a membership for those. Those are different things."', 'Roam', true),
  ('kind', 'Q1048525',  'golf course',                '{"sport": 0.8, "activity": 0.5}', 'A round of golf, usually at a club you belong to.', 'Roam', true),
  ('kind', 'Q13380226', 'tennis venue',               '{"sport": 0.9, "activity": 0.5}', 'A ticket to watch, or a court at a club.', 'Roam', true),

  -- --- Active: turn up and do it --------------------------------------------
  ('kind', 'Q200023',   'swimming center',            '{"activity": 0.9, "fun": 0.5}',  'The owner''s leisure centre: you turn up and swim.', 'Roam', true),
  ('kind', 'Q1501',     'swimming pool',              '{"activity": 0.9, "fun": 0.5}',  'You turn up and swim.', 'Roam', true),
  ('kind', 'Q1004435',  'athletics track',            '{"activity": 0.9, "sport": 0.5}', 'A track you run on.', 'Roam', true),
  ('kind', 'Q10536908', 'ice rink',                   '{"activity": 0.8, "fun": 0.8}',  'You turn up and skate, and it is a proper afternoon out with it.', 'Roam', true),

  -- --- Two he ruled on by name, written against the type --------------------
  ('kind', 'Q2137251',  'rowing and canoeing venue',  '{"fun": 0.9, "activity": 0.5, "outdoors": 0.4}', 'The owner, 5 Sep 2026, on Dorney Lake: "more like fun". Active is recorded below the line rather than dropped, so the number to move is on the screen if he changes his mind.', 'Roam', true),
  ('kind', 'Q13586493', 'outdoor swimming pool',      '{"fun": 0.9, "activity": 0.5, "relaxing": 0.4}', 'A lido. The owner, 5 Sep 2026: "the Lido… more like fun" — a day out rather than a length count.', 'Roam', true),

  -- --- Not a sport at all; Wikidata files them under one ---------------------
  -- The O2 is the country's busiest music venue and Wikidata calls it a
  -- stadium, so the stadium rule swept it onto Sport. Nothing about the type is
  -- wrong for the type; this one place is the exception, which is precisely
  -- what the `place` scope is for.
  ('place', 'wikidata:Q5364202', 'The O2 Arena', '{"fun": 1, "culture": 0.7}', 'The busiest music venue in the country. Wikidata files it as a stadium and the stadium rule put it under Sport; it is a gig.', 'Roam', true),
  ('kind', 'Q1522839',  'staff college',              '{"culture": 0.9}', 'Staff College, Camberley is a historic institution, like Sandhurst next door. Wikidata puts it under sports venue; it is Culture.', 'Roam', true)
on conflict (scope, subject) do update
  set subject_label = excluded.subject_label,
      weights       = excluded.weights,
      reason        = excluded.reason,
      updated_at    = now()
  -- Nine of these already exist from migration 040, which put the grounds on
  -- Fun because there was no Sport shelf to put them on. Those are Roam's own
  -- seeds and this supersedes them — but a rule the owner has since edited by
  -- hand is his, and is left exactly where he put it.
  where shelf_rules.seeded;

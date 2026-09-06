-- Putting the atlas in the drawers.
--
-- A second level is worth nothing empty, so this files the Wikidata types the
-- atlas actually returns — every one that has come back more than forty times,
-- and the long tail of the ones that matter — into the subcategories migration
-- 053 created. About a hundred and ten types, covering the great majority of
-- published attractions.
--
-- **A rule that names a drawer names the shelf with it.** These rows carry a
-- subcategory and no weights, which `domain/moods.js` reads as "the category is
-- whatever this subcategory belongs to". That is what keeps the two levels from
-- ever disagreeing: there is no way to be filed under Gardens and shown on
-- Outdoors, because the drawer knows which cabinet it is in.
--
-- It also means a handful of these quietly move a place's category, and each
-- one is deliberate:
--   • a garden becomes Relaxing rather than Outdoors — a formal garden you pay
--     to walk round is a gentle afternoon, and a country park is still Outdoors;
--   • an arena becomes Fun under Live music, because the O2 and Wembley Arena
--     are gigs and were only ever on Sport because Wikidata calls them stadiums;
--   • a heritage railway and a distillery become Fun under Days out, which is
--     what they are.
--
-- Nothing here contradicts anything the owner has ruled on. His two by-name
-- rulings keep their own drawers: an outdoor pool is Fun under Lidos, and a
-- rowing and canoeing venue keeps its Fun weights and takes the Paddling drawer
-- only if he moves it there.

insert into shelf_rules (scope, subject, subject_label, weights, subcategory, reason, taught_by, seeded) values
  -- --- Culture: castles and forts -------------------------------------------
  ('kind', 'Q23413',    'castle',                        '{}', 'castles',        'A castle.', 'Roam', true),
  ('kind', 'Q92062',    'motte-and-bailey castle',       '{}', 'castles',        'A castle, in its earliest form.', 'Roam', true),
  ('kind', 'Q17715832', 'castle ruin',                   '{}', 'castles',        'A castle, ruined.', 'Roam', true),
  ('kind', 'Q88205',    'castrum',                       '{}', 'castles',        'A Roman fort.', 'Roam', true),
  ('kind', 'Q91312',    'tower house',                   '{}', 'castles',        'A fortified tower.', 'Roam', true),

  -- --- Culture: the great house ---------------------------------------------
  ('kind', 'Q16884952', 'country house',                 '{}', 'historic-houses', 'The great house and its rooms.', 'Roam', true),
  ('kind', 'Q1343246',  'English country house',         '{}', 'historic-houses', 'The great house and its rooms.', 'Roam', true),
  ('kind', 'Q1802963',  'mansion',                       '{}', 'historic-houses', 'A large private house you can go round.', 'Roam', true),
  ('kind', 'Q2087181',  'historic house museum',         '{}', 'historic-houses', 'A house kept as it was.', 'Roam', true),
  ('kind', 'Q12292478', 'estate',                        '{}', 'historic-houses', 'A house and its land.', 'Roam', true),
  ('kind', 'Q16560',    'palace',                        '{}', 'historic-houses', 'A palace.', 'Roam', true),
  ('kind', 'Q32164125', 'fortified manor house',         '{}', 'historic-houses', 'A manor with walls.', 'Roam', true),

  -- --- Culture: churches and abbeys -----------------------------------------
  ('kind', 'Q16970',    'church building',               '{}', 'churches',       'A church.', 'Roam', true),
  ('kind', 'Q108325',   'chapel',                        '{}', 'churches',       'A chapel.', 'Roam', true),
  ('kind', 'Q317557',   'parish church',                 '{}', 'churches',       'The parish church.', 'Roam', true),
  ('kind', 'Q1088552',  'Catholic church building',      '{}', 'churches',       'A church.', 'Roam', true),
  ('kind', 'Q56242063', 'Protestant church building',    '{}', 'churches',       'A church.', 'Roam', true),
  ('kind', 'Q56242250', 'Anglican or Episcopal cathedral', '{}', 'churches',     'A cathedral.', 'Roam', true),
  ('kind', 'Q2977',     'cathedral',                     '{}', 'churches',       'A cathedral.', 'Roam', true),
  ('kind', 'Q160742',   'abbey',                         '{}', 'churches',       'An abbey.', 'Roam', true),
  ('kind', 'Q2750108',  'priory',                        '{}', 'churches',       'A priory.', 'Roam', true),
  ('kind', 'Q44613',    'monastery',                     '{}', 'churches',       'A monastery.', 'Roam', true),
  ('kind', 'Q1701174',  'monastery ruins',               '{}', 'churches',       'A monastery, ruined.', 'Roam', true),
  ('kind', 'Q19899465', 'former church building',        '{}', 'churches',       'A church that is no longer one.', 'Roam', true),
  ('kind', 'Q4663971',  'abbey (institution)',           '{}', 'churches',       'An abbey.', 'Roam', true),

  -- --- Culture: what is left of the ancient world ---------------------------
  ('kind', 'Q839954',   'archaeological site',           '{}', 'ancient-sites',  'What has been dug up and left to look at.', 'Roam', true),
  ('kind', 'Q14752696', 'ancient Roman structure',       '{}', 'ancient-sites',  'Roman.', 'Roam', true),

  -- --- Culture: museums and galleries ---------------------------------------
  ('kind', 'Q33506',    'museum',                        '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q115154402', 'independent museum',           '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q115154345', 'local authority museum',       '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q1595639',  'local museum',                  '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q2772772',  'military museum',               '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q1863818',  'maritime museum',               '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q4828724',  'aviation museum',               '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q17431399', 'national museum',               '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q16735822', 'history museum',                '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q18704634', 'railway museum',                '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q2516357',  'transport museum',              '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q17000324', 'sports museum',                 '{}', 'museums',        'A museum.', 'Roam', true),
  ('kind', 'Q207694',   'art museum',                    '{}', 'galleries',      'Pictures on walls.', 'Roam', true),

  -- --- Culture: a seat, and a thing to look at ------------------------------
  ('kind', 'Q24354',    'theatre building',              '{}', 'theatre',        'A theatre.', 'Roam', true),
  ('kind', 'Q1060829',  'concert hall',                  '{}', 'theatre',        'A concert hall.', 'Roam', true),
  ('kind', 'Q179700',   'statue',                        '{}', 'landmarks',      'A statue.', 'Roam', true),
  ('kind', 'Q4989906',  'monument',                      '{}', 'landmarks',      'A monument.', 'Roam', true),
  ('kind', 'Q575759',   'war memorial',                  '{}', 'landmarks',      'A memorial.', 'Roam', true),
  ('kind', 'Q5003624',  'memorial',                      '{}', 'landmarks',      'A memorial.', 'Roam', true),
  ('kind', 'Q12280',    'bridge',                        '{}', 'landmarks',      'A bridge worth going to see.', 'Roam', true),
  ('kind', 'Q537127',   'road bridge',                   '{}', 'landmarks',      'A bridge.', 'Roam', true),
  ('kind', 'Q1210334',  'railway bridge',                '{}', 'landmarks',      'A bridge.', 'Roam', true),
  ('kind', 'Q39486269', 'railway viaduct',               '{}', 'landmarks',      'A viaduct.', 'Roam', true),
  ('kind', 'Q1068842',  'footbridge',                    '{}', 'landmarks',      'A bridge.', 'Roam', true),
  ('kind', 'Q158438',   'arch bridge',                   '{}', 'landmarks',      'A bridge.', 'Roam', true),
  ('kind', 'Q3397526',  'stone bridge',                  '{}', 'landmarks',      'A bridge.', 'Roam', true),
  ('kind', 'Q12570',    'suspension bridge',             '{}', 'landmarks',      'A bridge.', 'Roam', true),
  ('kind', 'Q39715',    'lighthouse',                    '{}', 'landmarks',      'A lighthouse.', 'Roam', true),
  ('kind', 'Q38720',    'windmill',                      '{}', 'landmarks',      'A windmill.', 'Roam', true),
  ('kind', 'Q39614',    'cemetery',                      '{}', 'landmarks',      'A cemetery people visit.', 'Roam', true),
  ('kind', 'Q1497364',  'building complex',              '{}', 'landmarks',      'A group of buildings worth looking at.', 'Roam', true),
  ('kind', 'Q15897166', 'pier',                          '{}', 'landmarks',      'A pier.', 'Roam', true),

  -- --- Fun ------------------------------------------------------------------
  ('kind', 'Q194195',   'amusement park',                '{}', 'theme-parks',    'A day of rides.', 'Roam', true),
  ('kind', 'Q2416723',  'theme park',                    '{}', 'theme-parks',    'A day of rides.', 'Roam', true),
  ('kind', 'Q253302',   'Legoland',                      '{}', 'theme-parks',    'A day of rides with small children.', 'Roam', true),
  ('kind', 'Q740326',   'water park',                    '{}', 'theme-parks',    'Slides and flumes.', 'Roam', true),
  ('kind', 'Q2137251',  'rowing and canoeing venue',     '{}', 'days-out',       'The owner, 5 Sep 2026, on Dorney Lake: "more like fun".', 'Roam', true),
  ('kind', 'Q43501',    'zoo',                           '{}', 'zoos-wildlife',  'Animals you go and see.', 'Roam', true),
  ('kind', 'Q2281788',  'public aquarium',               '{}', 'zoos-wildlife',  'Fish you go and see.', 'Roam', true),
  ('kind', 'Q420962',   'heritage railway',              '{}', 'days-out',       'A steam railway is a day out with the family.', 'Roam', true),
  ('kind', 'Q10373548', 'whisky distillery',             '{}', 'days-out',       'A tour and a tasting.', 'Roam', true),
  ('kind', 'Q1251750',  'distillery',                    '{}', 'days-out',       'A tour and a tasting.', 'Roam', true),
  -- The arenas. Wikidata files the O2 as a stadium, which is how the country's
  -- busiest music venue ended up under Sport; the drawer settles it.
  ('kind', 'Q641226',   'arena',                         '{}', 'live-music',     'An arena is where a gig or a show is.', 'Roam', true),
  ('kind', 'Q27951514', 'indoor arena',                  '{}', 'live-music',     'An arena is where a gig or a show is.', 'Roam', true),
  ('kind', 'Q1763828',  'multi-purpose hall',            '{}', 'live-music',     'A hall is whatever is on in it.', 'Roam', true),
  ('kind', 'Q18674739', 'event venue',                   '{}', 'live-music',     'A venue is whatever is on in it.', 'Roam', true),

  -- --- Sport ----------------------------------------------------------------
  ('kind', 'Q1154710',  'association football venue',    '{}', 'football',       'You book your football tickets.', 'Roam', true),
  ('kind', 'Q483110',   'stadium',                       '{}', 'arenas',         'A stadium.', 'Roam', true),
  ('kind', 'Q1049757',  'multi-purpose stadium',         '{}', 'arenas',         'A stadium.', 'Roam', true),
  ('kind', 'Q1076486',  'sports venue',                  '{}', 'arenas',         'Somewhere a fixture happens.', 'Roam', true),
  ('kind', 'Q45290083', 'rugby league venue',            '{}', 'rugby-cricket',  'You book your rugby tickets.', 'Roam', true),
  ('kind', 'Q15303456', 'rugby union venue',             '{}', 'rugby-cricket',  'You book your rugby tickets.', 'Roam', true),
  ('kind', 'Q682943',   'cricket field',                 '{}', 'rugby-cricket',  'A cricket ground.', 'Roam', true),
  ('kind', 'Q595452',   'baseball venue',                '{}', 'rugby-cricket',  'A ball ground.', 'Roam', true),
  ('kind', 'Q11822917', 'horse racing venue',            '{}', 'racecourses',    'A race meeting.', 'Roam', true),
  ('kind', 'Q2022036',  'golf club',                     '{}', 'golf',           'The owner, 5 Sep 2026: "you have to have a membership for those".', 'Roam', true),
  ('kind', 'Q1048525',  'golf course',                   '{}', 'golf',           'A round of golf.', 'Roam', true),
  ('kind', 'Q13380226', 'tennis venue',                  '{}', 'racquet-clubs',  'A court, or a ticket to watch.', 'Roam', true),

  -- --- Active ---------------------------------------------------------------
  ('kind', 'Q200023',   'swimming center',               '{}', 'pools',          'The leisure centre.', 'Roam', true),
  ('kind', 'Q1501',     'swimming pool',                 '{}', 'pools',          'You turn up and swim.', 'Roam', true),
  ('kind', 'Q1004435',  'athletics track',               '{}', 'athletics',      'A track you run on.', 'Roam', true),
  ('kind', 'Q10536908', 'ice rink',                      '{}', 'skating',        'You turn up and skate.', 'Roam', true),
  -- His ruling: the Lido is Fun. It gets a Fun drawer rather than an Active one.
  ('kind', 'Q13586493', 'outdoor swimming pool',         '{}', 'lidos',          'The owner, 5 Sep 2026: "the Lido… more like fun".', 'Roam', true),

  -- --- Adrenaline -----------------------------------------------------------
  ('kind', 'Q2338524',  'motorsport racing track',       '{}', 'circuits',       'A circuit you can drive or ride on.', 'Roam', true),
  ('kind', 'Q1777138',  'race track',                    '{}', 'circuits',       'A track built for speed.', 'Roam', true),

  -- --- Relaxing -------------------------------------------------------------
  -- A formal garden is a gentle afternoon; a country park is Outdoors. This is
  -- the one place the two levels deliberately disagree with where the atlas put
  -- the place, and it is the right way round.
  ('kind', 'Q1107656',  'garden',                        '{}', 'gardens',        'A garden you pay to walk round is a gentle afternoon, not a hike.', 'Roam', true),
  ('kind', 'Q167346',   'botanical garden',              '{}', 'gardens',        'A garden.', 'Roam', true),

  -- --- Outdoors -------------------------------------------------------------
  ('kind', 'Q22698',    'park',                          '{}', 'parks',          'A park.', 'Roam', true),
  ('kind', 'Q22746',    'urban park',                    '{}', 'parks',          'A park.', 'Roam', true),
  ('kind', 'Q350723',   'country park',                  '{}', 'parks',          'A country park is a walk, not a garden.', 'Roam', true),
  ('kind', 'Q2259176',  'common land',                   '{}', 'parks',          'The common.', 'Roam', true),
  ('kind', 'Q179049',   'nature reserve',                '{}', 'nature',         'Wild animals where they live.', 'Roam', true),
  ('kind', 'Q3457526',  'local nature reserve',          '{}', 'nature',         'Wild animals where they live.', 'Roam', true),
  ('kind', 'Q473972',   'protected area',                '{}', 'nature',         'Land left alone.', 'Roam', true),
  ('kind', 'Q422211',   'Site of Special Scientific Interest', '{}', 'nature',   'Land left alone.', 'Roam', true),
  ('kind', 'Q54050',    'hill',                          '{}', 'hills',          'A hill worth climbing.', 'Roam', true),
  ('kind', 'Q23397',    'lake',                          '{}', 'water',          'A lake to be beside.', 'Roam', true),
  ('kind', 'Q131681',   'reservoir',                     '{}', 'water',          'Water to walk round.', 'Roam', true),
  ('kind', 'Q4421',     'forest',                        '{}', 'woodland',       'Trees.', 'Roam', true),
  ('kind', 'Q3241565',  'woodland',                      '{}', 'woodland',       'Trees.', 'Roam', true),
  ('kind', 'Q13405588', 'long-distance trail',           '{}', 'trails',         'A long walk.', 'Roam', true),
  ('kind', 'Q34038',    'waterfall',                     '{}', 'caves-falls',    'A waterfall.', 'Roam', true),
  ('kind', 'Q35509',    'cave',                          '{}', 'caves-falls',    'A cave.', 'Roam', true),
  ('kind', 'Q6017969',  'scenic viewpoint',              '{}', 'viewpoints',     'Somewhere to look from.', 'Roam', true),

  -- --- The institutions Wikidata files under sport --------------------------
  ('kind', 'Q917182',   'military academy',              '{}', 'landmarks',      'Sandhurst is a historic institution you go and look at.', 'Roam', true),
  ('kind', 'Q1522839',  'staff college',                 '{}', 'landmarks',      'As Sandhurst next door.', 'Roam', true),

  -- --- And the one place already ruled on by name ---------------------------
  ('place', 'wikidata:Q5364202', 'The O2 Arena',          '{}', 'live-music',     'The busiest music venue in the country.', 'Roam', true)
on conflict (scope, subject) do update
  -- Only ever adds the drawer. The weights already taught are left exactly as
  -- they are, including the owner's own — a rule that says "this is Fun" keeps
  -- saying it, and now says which drawer of Fun as well.
  set subcategory   = excluded.subcategory,
      subject_label = coalesce(shelf_rules.subject_label, excluded.subject_label),
      updated_at    = now()
  where shelf_rules.seeded;

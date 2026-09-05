// What kind of food this is, coarsely (owner, 5 Sep 2026).
//
// > "I'm thinking the top 6 in each category… There should be a decent amount
// > of Chinese restaurants, for example, that we have the menu for… Often, if
// > I'm in London, all the top restaurants might be fully booked, so I might
// > have to go a bit deeper."
//
// Depth per category only means something if the categories are the ones a
// person would use. The open map and the licensed source between them label a
// pizzeria "pizza", an identical one "italian", and a café variously "coffee",
// "coffee shop", "cafe" and "tea" — so "the top four Italians" quietly becomes
// the top four of each of two half-lists, and every singleton label is its own
// category with a guaranteed place in the top four. Measured across twelve
// swept areas, top-four-per-label selected 89% of everything: not a shortlist.
//
// A quarter of places carry no cuisine at all. They are one group — "not said"
// — ranked among themselves, rather than one group each.

const GROUPS = {
  italian: ['italian', 'pizza', 'pizzeria', 'pasta', 'sicilian', 'sardinian', 'neapolitan', 'trattoria'],
  indian: ['indian', 'pakistani', 'bangladeshi', 'punjabi', 'south indian', 'north indian', 'curry', 'balti', 'tandoori', 'nepalese', 'sri lankan'],
  chinese: ['chinese', 'cantonese', 'szechuan', 'sichuan', 'dim sum', 'hong kong', 'taiwanese'],
  japanese: ['japanese', 'sushi', 'ramen', 'izakaya', 'teppanyaki', 'katsu'],
  thai: ['thai', 'laotian'],
  vietnamese: ['vietnamese', 'pho'],
  korean: ['korean'],
  'east asian': ['asian', 'oriental', 'malaysian', 'indonesian', 'singaporean', 'filipino', 'pan asian'],
  turkish: ['turkish', 'kebab', 'ottoman', 'anatolian'],
  'middle eastern': ['lebanese', 'persian', 'iranian', 'middle eastern', 'syrian', 'israeli', 'falafel', 'shawarma', 'afghan'],
  greek: ['greek', 'cypriot'],
  spanish: ['spanish', 'tapas', 'basque', 'catalan'],
  french: ['french', 'brasserie', 'bistro', 'crepe', 'creperie'],
  mediterranean: ['mediterranean', 'moroccan', 'north african', 'tunisian', 'egyptian'],
  american: ['american', 'burger', 'bbq', 'barbecue', 'steak', 'steakhouse', 'steak house', 'grill', 'diner', 'hot dog', 'wings', 'chicken', 'fried chicken', 'southern'],
  mexican: ['mexican', 'tex-mex', 'burrito', 'taco', 'latin american', 'brazilian', 'peruvian', 'argentinian'],
  british: ['british', 'english', 'pub', 'pub food', 'gastropub', 'sunday roast', 'pie', 'regional'],
  'fish and chips': ['fish and chips', 'fish_and_chips', 'chippy', 'seafood', 'fish'],
  caribbean: ['caribbean', 'jamaican', 'african', 'ethiopian', 'nigerian', 'ghanaian'],
  'café': ['coffee', 'coffee shop', 'cafe', 'café', 'tea', 'tea house', 'breakfast', 'brunch', 'bakery', 'patisserie', 'sandwich', 'sandwiches', 'deli', 'bagel', 'juice', 'smoothie'],
  dessert: ['dessert', 'desserts', 'ice cream', 'gelato', 'crepes', 'waffle', 'chocolate', 'donut', 'doughnut', 'cake'],
  'plant based': ['vegan', 'vegetarian', 'plant based', 'salad', 'health food'],
  'bar': ['bar', 'wine bar', 'wine', 'cocktail', 'beer', 'brewery', 'taproom', 'pub bar'],
};

const LOOKUP = new Map();
for (const [group, labels] of Object.entries(GROUPS)) for (const l of labels) LOOKUP.set(l, group);

const clean = (s) => String(s ?? '').toLowerCase().trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** The group a place belongs to for "the best Chinese round here". */
export const NOT_SAID = 'not said';

export function cuisineGroup(cuisines = []) {
  for (const raw of cuisines) {
    const c = clean(raw);
    if (LOOKUP.has(c)) return LOOKUP.get(c);
  }
  // A label nobody has grouped yet: match on a word inside it before giving up,
  // so "modern indian" and "authentic thai" land where they belong.
  for (const raw of cuisines) {
    const c = clean(raw);
    for (const [label, group] of LOOKUP) if (c.includes(label)) return group;
  }
  return cuisines.length ? clean(cuisines[0]) : NOT_SAID;
}

export const CUISINE_GROUPS = Object.keys(GROUPS);

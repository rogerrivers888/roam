// Local fixture source.
//
// Every venue below is INVENTED. No licensed provider is called and no
// third-party content is stored — the private beta cannot start until the
// credentials in Requirements §3 exist, and the retention rules in §4 mean
// licensed content could not be committed to this repo in any case.
//
// This source exists so the discovery, ranking and trip-budget behaviour can be
// built and exercised now, behind the same interface a real source will use.
// Allergen vocabulary is the FDA 9; the canonical list is still open (Epic 1 Q&A).

const VENUES = [
  {
    id: 'v-001', name: 'Harbour & Vine', category: 'restaurant',
    cuisines: ['seafood', 'american'], allergens: ['shellfish', 'fish', 'milk'],
    priceLevel: 3, rating: 4.5, goodForChildren: true, lat: 42.3601, lng: -71.0589,
    dishes: [
      { concept: 'clam-chowder', name: 'New England clam chowder', comment: 'The chowder is the reason to come here — thick, not gluey.' },
      { concept: 'grilled-octopus', name: 'Charred octopus', comment: 'Octopus was tender the whole way through.' },
    ],
  },
  {
    id: 'v-002', name: 'The Copper Kettle', category: 'pub', dietaryOptions: ["vegetarian"],
    cuisines: ['british', 'pub'], allergens: ['wheat', 'milk', 'eggs'],
    priceLevel: 2, rating: 4.2, goodForChildren: true, lat: 42.3554, lng: -71.0640,
    dishes: [
      { concept: 'fish-and-chips', name: 'Beer-battered haddock and chips', comment: 'Batter stays crisp even at the back of the room.' },
      { concept: 'sunday-roast', name: 'Roast sirloin', comment: 'Yorkshire puddings the size of your hand.' },
    ],
  },
  {
    id: 'v-003', name: 'Sabor de Lima', category: 'restaurant',
    cuisines: ['peruvian', 'latin'], allergens: ['fish', 'shellfish', 'soybeans'],
    priceLevel: 3, rating: 4.6, goodForChildren: false, lat: 42.3489, lng: -71.0812,
    dishes: [
      { concept: 'ceviche', name: 'Ceviche clásico', comment: 'Sharpest ceviche in the neighbourhood, and they mean the chilli.' },
      { concept: 'lomo-saltado', name: 'Lomo saltado', comment: 'Beef properly seared, chips soaked in the sauce.' },
    ],
  },
  {
    id: 'v-004', name: "Nonna's Table", category: 'restaurant', dietaryOptions: ["vegetarian", "gluten-free"],
    cuisines: ['italian'], allergens: ['wheat', 'milk', 'eggs'],
    priceLevel: 2, rating: 4.4, goodForChildren: true, lat: 42.3638, lng: -71.0554,
    dishes: [
      { concept: "arrabbiata", veg: true, name: "Penne all'arrabbiata", comment: 'Arrabbiata has real heat rather than just tomato.' },
      { concept: "tiramisu", veg: true, name: 'Tiramisu', comment: 'Made in-house, and you can tell.' },
    ],
  },
  {
    id: 'v-005', name: 'Ember & Ash', category: 'restaurant',
    cuisines: ['barbecue', 'american'], allergens: ['soybeans', 'wheat'],
    priceLevel: 2, rating: 4.3, goodForChildren: true, lat: 42.3395, lng: -71.0921,
    dishes: [
      { concept: 'brisket', name: 'Twelve-hour brisket', comment: 'Brisket had a proper bark and did not need the sauce.' },
      { concept: 'burnt-ends', name: 'Burnt ends', comment: 'Order the burnt ends early, they run out.' },
    ],
  },
  {
    id: 'v-006', name: 'Little Kettle Café', category: 'cafe', dietaryOptions: ["vegetarian", "vegan"],
    cuisines: ['cafe'], allergens: ['milk', 'wheat', 'tree nuts'],
    priceLevel: 1, rating: 4.1, goodForChildren: true, lat: 42.3572, lng: -71.0668,
    dishes: [
      { concept: "flat-white", veg: true, name: 'Flat white', comment: 'Best flat white within walking distance of the theatre.' },
      { concept: "cinnamon-bun", veg: true, name: 'Cinnamon bun', comment: 'Buns come out warm at eleven.' },
    ],
  },
  {
    id: 'v-007', name: 'Green Fig', category: 'restaurant', dietaryOptions: ["vegetarian", "vegan", "gluten-free"],
    cuisines: ['mediterranean', 'vegetarian'], allergens: ['sesame', 'tree nuts'],
    priceLevel: 2, rating: 4.5, goodForChildren: true, lat: 42.3701, lng: -71.0705,
    dishes: [
      { concept: "falafel", veg: true, name: 'Herb falafel plate', comment: 'Falafel green all the way through, not beige.' },
      { concept: "mezze", veg: true, name: 'Mezze board', comment: 'Enough mezze for four without ordering mains.' },
    ],
  },
  {
    id: 'v-008', name: 'The Lantern Room', category: 'bar',
    cuisines: ['cocktails'], allergens: [],
    priceLevel: 3, rating: 4.4, goodForChildren: false, lat: 42.3520, lng: -71.0602,
    dishes: [
      { concept: 'old-fashioned', name: 'House old fashioned', comment: 'They batch it, and it is better for it.' },
    ],
  },
  {
    id: 'v-009', name: 'Sagano Ramen', category: 'restaurant', dietaryOptions: [],
    cuisines: ['japanese'], allergens: ['wheat', 'soybeans', 'eggs'],
    priceLevel: 2, rating: 4.7, goodForChildren: true, lat: 42.3455, lng: -71.0748,
    dishes: [
      { concept: 'ramen', name: 'Tonkotsu ramen', comment: 'Broth is the real thing — eighteen hours, they say.' },
      { concept: 'gyoza', name: 'Pork gyoza', comment: 'Gyoza crisped on one side exactly as they should be.' },
    ],
  },
  {
    id: 'v-010', name: 'Bramble Bakehouse', category: 'cafe', dietaryOptions: ["vegetarian"],
    cuisines: ['bakery', 'cafe'], allergens: ['wheat', 'milk', 'eggs', 'tree nuts'],
    priceLevel: 1, rating: 4.6, goodForChildren: true, lat: 42.3663, lng: -71.0836,
    dishes: [
      { concept: "almond-croissant", veg: true, name: 'Almond croissant', comment: 'Croissants sell out by ten on a Saturday.' },
    ],
  },
  {
    id: 'v-011', name: 'Tidewater Maritime Museum', category: 'attraction',
    experiences: ["museum"],
    cuisines: [], allergens: [],
    priceLevel: 2, rating: 4.3, goodForChildren: true, lat: 42.3548, lng: -71.0480,
    dishes: [],
  },
  {
    id: 'v-012', name: 'Rowan Park Gardens', category: 'attraction',
    experiences: ["park", "walk"],
    cuisines: [], allergens: [],
    priceLevel: 0, rating: 4.6, goodForChildren: true, lat: 42.3742, lng: -71.0965,
    dishes: [],
  },
  {
    id: 'v-013', name: 'Pike & Pepper', category: 'restaurant', dietaryOptions: ["vegetarian", "vegan"],
    cuisines: ['mexican'], allergens: ['milk', 'wheat'],
    priceLevel: 1, rating: 4.2, goodForChildren: true, lat: 42.3412, lng: -71.0655,
    dishes: [
      { concept: 'carnitas-taco', name: 'Carnitas tacos', comment: 'Carnitas crisped on the edges, three to a plate.' },
    ],
  },
  {
    id: 'v-014', name: 'The Anchor Tap', category: 'pub', dietaryOptions: ["vegetarian"],
    cuisines: ['pub'], allergens: ['wheat'],
    priceLevel: 2, rating: 4.0, goodForChildren: false, lat: 42.3812, lng: -71.0537,
    dishes: [
      { concept: 'fish-and-chips', name: 'Fish and chips', comment: 'Cheap, large, and does the job before a game.' },
    ],
  },
  {
    id: 'v-015', name: 'Cinder House Pizza', category: 'restaurant', dietaryOptions: ["vegetarian", "gluten-free"],
    cuisines: ['italian', 'pizza'], allergens: ['wheat', 'milk'],
    priceLevel: 2, rating: 4.5, goodForChildren: true, lat: 42.3327, lng: -71.0588,
    dishes: [
      { concept: "margherita", veg: true, name: 'Margherita', comment: 'Base is charred and chewy, not cracker-thin.' },
      { concept: "arrabbiata", veg: true, name: 'Arrabbiata pizza', comment: 'Hot enough that the children left it alone.' },
    ],
  },
];

// Timed events, shaped the way a Ticketmaster Discovery v2 result would reduce
// to (Technical Constraints §8). Start times are resolved relative to the outing
// window so the fixtures do not go stale.
const EVENT_TEMPLATES = [
  {
    id: 'e-001', name: 'Bandstand Jazz Hour', experiences: ["live-music"],
    venueName: 'Rowan Park Bandstand', lat: 42.3738, lng: -71.0958,
    startOffsetHours: 1.5, durationMinutes: 60, priceLevel: 2, goodForChildren: true,
  },
  {
    id: 'e-002', name: 'Harbour Lights Market', experiences: ["market"],
    venueName: 'Tidewater Quay', lat: 42.3556, lng: -71.0472,
    startOffsetHours: 0.5, durationMinutes: 150, priceLevel: 1, goodForChildren: true,
  },
  {
    id: 'e-003', name: 'Comedy at the Copper Kettle', experiences: ["comedy"],
    venueName: 'The Copper Kettle', lat: 42.3554, lng: -71.0640,
    startOffsetHours: 3, durationMinutes: 90, priceLevel: 2, goodForChildren: false,
  },
];

const norm = (s) => s.toLowerCase().trim();

function matchesQuery(venue, q) {
  if (!q) return null;
  const needle = norm(q);
  const dish = venue.dishes.find(
    (d) => norm(d.name).includes(needle) || d.concept.includes(needle.replace(/\s+/g, '-')),
  );
  if (dish) return { kind: 'dish', dish };
  const hit = norm(venue.name).includes(needle) || venue.cuisines.some((c) => c.includes(needle));
  return hit ? { kind: 'venue' } : null;
}

/**
 * The fixture implementation of the source interface. Returns raw, un-resolved
 * records exactly as a real provider adapter would, so entity resolution has
 * something of the right shape to operate on.
 */
export const fixturesSource = {
  key: 'fixtures',
  label: 'Roam fixtures (development only)',
  // Real sources carry per-field retention; fixtures are ours, so nothing expires.
  retention: { placeId: 'indefinite', displayFields: 'indefinite' },
  attribution: { text: 'Local fixture data — not a licensed source', requiresAuthorCredit: false },

  async search({ categories, query, includeEvents, outingStart } = {}) {
    const results = [];

    for (const venue of VENUES) {
      if (categories?.length && !categories.includes(venue.category)) continue;
      const match = matchesQuery(venue, query);
      if (query && !match) continue;
      results.push({
        source: 'fixtures',
        sourcePlaceId: venue.id,
        name: venue.name,
        category: venue.category,
        cuisines: venue.cuisines,
        allergens: venue.allergens,
        priceLevel: venue.priceLevel,
        rating: venue.rating,
        goodForChildren: venue.goodForChildren,
        lat: venue.lat,
        lng: venue.lng,
        dishes: venue.dishes,
        experiences: venue.experiences ?? [],
        dietaryOptions: venue.dietaryOptions ?? [],
        // The evidence behind a dish-level match (Epic 3 C4). Google returns the
        // equivalent as contextualContent.justifications; it is display-only and
        // must never be persisted once a licensed source supplies it.
        justification: match?.kind === 'dish' ? match.dish.comment : null,
        matchedDish: match?.kind === 'dish' ? match.dish.name : null,
      });
    }

    if (includeEvents) {
      const base = outingStart ? new Date(outingStart) : new Date();
      for (const tpl of EVENT_TEMPLATES) {
        if (query && !norm(tpl.name).includes(norm(query))) continue;
        const startsAt = new Date(base.getTime() + tpl.startOffsetHours * 3600_000);
        results.push({
          source: 'fixtures',
          sourcePlaceId: tpl.id,
          name: tpl.name,
          category: 'event',
          cuisines: [],
          allergens: [],
          priceLevel: tpl.priceLevel,
          rating: null,
          goodForChildren: tpl.goodForChildren,
          lat: tpl.lat,
          lng: tpl.lng,
          dishes: [],
          justification: null,
          matchedDish: null,
          venueName: tpl.venueName,
          experiences: tpl.experiences ?? [],
          dietaryOptions: [],
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + tpl.durationMinutes * 60_000).toISOString(),
        });
      }
    }

    return results;
  },
};

export const ALL_FIXTURE_VENUES = VENUES;

// Named places a household can say out loud as an origin or destination.
// Stands in for geocoding until a routing provider is enabled.
export const KNOWN_PLACES = [
  { label: 'Home', aliases: ['home', 'the house', 'ours'], lat: 42.3529, lng: -71.0621 },
  { label: 'Boston Opera House', aliases: ['opera house', 'the theatre', 'the theater', 'the show'], lat: 42.3536, lng: -71.0619 },
  { label: 'South Station', aliases: ['south station', 'the station', 'train station'], lat: 42.3519, lng: -71.0552 },
  { label: 'Fenway Park', aliases: ['fenway', 'the ballpark', 'the game', 'the stadium'], lat: 42.3467, lng: -71.0972 },
  ...VENUES.map((v) => ({ label: v.name, aliases: [norm(v.name)], lat: v.lat, lng: v.lng })),
];

/** Resolve a spoken or typed place name to coordinates. Null when unknown. */
export function resolvePlace(text) {
  if (!text) return null;
  const needle = norm(text).replace(/^(the|at|from|to)\s+/, '');
  const exact = KNOWN_PLACES.find(
    (p) => norm(p.label) === needle || p.aliases.some((a) => norm(a) === needle),
  );
  if (exact) return { label: exact.label, lat: exact.lat, lng: exact.lng };
  const partial = KNOWN_PLACES.find(
    (p) => norm(p.label).includes(needle) || needle.includes(norm(p.label)) ||
      p.aliases.some((a) => a.includes(needle) || needle.includes(a)),
  );
  return partial ? { label: partial.label, lat: partial.lat, lng: partial.lng } : null;
}

/** One venue by fixture id, in the same shape search returns. */
fixturesSource.get = async (id) => {
  const venue = VENUES.find((v) => v.id === id);
  if (!venue) return null;
  const [hit] = await fixturesSource.search({ query: venue.name });
  return hit && hit.sourcePlaceId === id ? hit : null;
};

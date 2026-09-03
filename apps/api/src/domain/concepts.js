// Taste concepts — the normalised idea of a dish, a cuisine, a kind of outing
// or a way of eating, independent of any one venue's wording (Requirements §5).
//
// "Spaghetti arrabbiata", "arabiata" and "penne all'arrabbiata" must resolve to
// one concept; so must "museum", "the museum" and "art gallery" (Epic 2 C6).
// Below the confidence threshold two things stay separate (C7) — the household
// can always keep a free-text entry that matched nothing.
//
// This is the seed vocabulary; the household's own captured menus and ratings
// add aliases to it over time.

const DISHES = [
  ['arrabbiata', 'Arrabbiata', ['spaghetti arrabbiata', 'penne arrabbiata', "penne all'arrabbiata", 'arabiata', 'arrabiata', 'spicy tomato pasta']],
  ['carbonara', 'Carbonara', ['spaghetti carbonara', 'pasta carbonara']],
  ['bolognese', 'Bolognese', ['spaghetti bolognese', 'ragu', 'ragù', 'tagliatelle al ragu']],
  ['lasagne', 'Lasagne', ['lasagna']],
  ['margherita', 'Margherita pizza', ['pizza margherita', 'cheese pizza']],
  ['pepperoni-pizza', 'Pepperoni pizza', ['pepperoni']],
  ['pizza', 'Pizza', ['pizzas']],
  ['risotto', 'Risotto', ['mushroom risotto']],
  ['gnocchi', 'Gnocchi', []],
  ['tiramisu', 'Tiramisu', []],
  ['ramen', 'Ramen', ['tonkotsu ramen', 'tonkotsu', 'miso ramen', 'shoyu ramen', 'noodle soup']],
  ['gyoza', 'Gyoza', ['dumplings', 'pork dumplings', 'potstickers']],
  ['sushi', 'Sushi', ['nigiri', 'maki', 'sashimi', 'sushi rolls']],
  ['katsu-curry', 'Katsu curry', ['chicken katsu', 'katsu']],
  ['pad-thai', 'Pad thai', ['phad thai']],
  ['green-curry', 'Thai green curry', ['green curry']],
  ['pho', 'Pho', ['phở', 'beef pho']],
  ['banh-mi', 'Bánh mì', ['banh mi']],
  ['fish-and-chips', 'Fish and chips', ['fish n chips', 'battered fish', 'haddock and chips', 'cod and chips']],
  ['sunday-roast', 'Sunday roast', ['roast dinner', 'roast beef', 'roast chicken', 'roast lamb']],
  ['burger', 'Burger', ['burgers', 'cheeseburger', 'hamburger', 'smash burger']],
  ['steak', 'Steak', ['ribeye', 'sirloin', 'fillet steak', 'steak frites']],
  ['brisket', 'Brisket', ['smoked brisket']],
  ['burnt-ends', 'Burnt ends', []],
  ['ribs', 'Ribs', ['bbq ribs', 'pork ribs', 'baby back ribs']],
  ['pulled-pork', 'Pulled pork', []],
  ['fried-chicken', 'Fried chicken', ['chicken wings', 'wings', 'hot wings']],
  ['tacos', 'Tacos', ['taco', 'carnitas tacos', 'fish tacos', 'street tacos']],
  ['carnitas-taco', 'Carnitas tacos', ['carnitas']],
  ['burrito', 'Burrito', ['burritos']],
  ['quesadilla', 'Quesadilla', ['quesadillas']],
  ['nachos', 'Nachos', []],
  ['ceviche', 'Ceviche', []],
  ['lomo-saltado', 'Lomo saltado', []],
  ['clam-chowder', 'Clam chowder', ['chowder', 'new england clam chowder']],
  ['lobster-roll', 'Lobster roll', []],
  ['grilled-octopus', 'Grilled octopus', ['octopus', 'charred octopus']],
  ['fish-pie', 'Fish pie', []],
  ['moules', 'Moules', ['mussels', 'moules frites']],
  ['falafel', 'Falafel', ['falafel wrap', 'falafel plate']],
  ['hummus', 'Hummus', ['houmous']],
  ['mezze', 'Mezze', ['meze', 'mezze board']],
  ['shawarma', 'Shawarma', ['doner', 'döner', 'kebab']],
  ['butter-chicken', 'Butter chicken', ['murgh makhani']],
  ['tikka-masala', 'Tikka masala', ['chicken tikka masala']],
  ['biryani', 'Biryani', []],
  ['dosa', 'Dosa', ['masala dosa']],
  ['dal', 'Dal', ['dhal', 'daal', 'lentil curry']],
  ['pancakes', 'Pancakes', ['stack of pancakes', 'buttermilk pancakes']],
  ['waffles', 'Waffles', []],
  ['eggs-benedict', 'Eggs Benedict', ['benedict']],
  ['avocado-toast', 'Avocado toast', ['avo toast']],
  ['full-breakfast', 'Full breakfast', ['fry up', 'full english', 'cooked breakfast']],
  ['croissant', 'Croissant', ['almond croissant', 'pain au chocolat']],
  ['cinnamon-bun', 'Cinnamon bun', ['cinnamon roll']],
  ['flat-white', 'Flat white', []],
  ['cappuccino', 'Cappuccino', ['latte', 'coffee']],
  ['hot-chocolate', 'Hot chocolate', []],
  ['milkshake', 'Milkshake', ['shake']],
  ['ice-cream', 'Ice cream', ['gelato', 'sundae']],
  ['old-fashioned', 'Old fashioned', []],
  ['margarita', 'Margarita', ['margaritas']],
  ['craft-beer', 'Craft beer', ['ipa', 'beer', 'ale']],
  ['salad', 'Salad', ['caesar salad', 'greek salad']],
  ['soup', 'Soup', ['tomato soup', 'soup of the day']],
  ['mac-and-cheese', 'Mac and cheese', ['macaroni cheese', 'mac n cheese']],
  ['chips', 'Chips', ['fries', 'french fries']],
];

const CUISINES = [
  ['italian', 'Italian', ['pasta', 'trattoria']],
  ['japanese', 'Japanese', []],
  ['chinese', 'Chinese', ['dim sum', 'cantonese', 'szechuan', 'sichuan']],
  ['thai', 'Thai', []],
  ['vietnamese', 'Vietnamese', []],
  ['korean', 'Korean', ['korean bbq', 'kbbq']],
  ['indian', 'Indian', ['curry house', 'curry']],
  ['mexican', 'Mexican', ['tex-mex']],
  ['peruvian', 'Peruvian', ['latin', 'latin american']],
  ['mediterranean', 'Mediterranean', ['greek', 'lebanese', 'turkish', 'middle eastern']],
  ['seafood', 'Seafood', ['fish restaurant']],
  ['barbecue', 'Barbecue', ['bbq', 'smokehouse']],
  ['american', 'American', ['diner']],
  ['british', 'British', ['gastropub']],
  ['french', 'French', ['bistro', 'brasserie']],
  ['spanish', 'Spanish', ['tapas']],
  ['pub', 'Pubs', ['pub food']],
  ['bar', 'Bars', ['cocktail bar', 'cocktails', 'wine bar']],
  ['cafe', 'Cafés', ['café', 'coffee shop', 'bakery']],
  ['steakhouse', 'Steakhouse', ['grill']],
  ['vegetarian-restaurant', 'Vegetarian restaurants', ['vegan restaurant', 'plant-based']],
];

const EXPERIENCES = [
  ['museum', 'Museums', ['the museum', 'history museum', 'science museum', 'maritime museum']],
  ['art-gallery', 'Art galleries', ['gallery', 'modern art', 'art museum']],
  ['aquarium', 'Aquarium', ['the aquarium', 'sea life']],
  ['zoo', 'Zoo', ['the zoo', 'safari park', 'wildlife park']],
  ['park', 'Parks', ['the park', 'gardens', 'botanical garden', 'green space']],
  ['playground', 'Playgrounds', ['play park', 'adventure playground']],
  ['walk', 'A walk', ['hike', 'hiking', 'trail', 'stroll', 'ramble']],
  ['beach', 'Beach', ['the beach', 'seaside']],
  ['swimming', 'Swimming', ['pool', 'lido', 'water park']],
  ['cinema', 'Cinema', ['movies', 'film', 'the movies']],
  ['theatre', 'Theatre', ['the theatre', 'a show', 'musical', 'play']],
  ['live-music', 'Live music', ['gig', 'concert', 'jazz', 'band']],
  ['comedy', 'Comedy', ['stand-up', 'comedy night']],
  ['sports-game', 'Watching sport', ['the game', 'baseball', 'football', 'soccer', 'basketball', 'match']],
  ['bowling', 'Bowling', ['ten-pin']],
  ['mini-golf', 'Mini golf', ['crazy golf', 'putt putt']],
  ['climbing', 'Climbing', ['bouldering', 'climbing wall']],
  ['trampoline', 'Trampoline park', ['trampolining']],
  ['ice-skating', 'Ice skating', ['skating rink']],
  ['cycling', 'Cycling', ['bike ride', 'bikes']],
  ['boat-trip', 'Boat trip', ['boat tour', 'ferry', 'kayaking', 'paddleboarding']],
  ['market', 'Markets', ['food market', 'night market', 'farmers market', 'flea market']],
  ['shopping', 'Shopping', ['the mall', 'shops']],
  ['bookshop', 'Bookshops', ['library', 'bookstore']],
  ['arcade', 'Arcade', ['video games', 'games arcade']],
  ['escape-room', 'Escape room', []],
  ['castle', 'Castles', ['historic house', 'stately home', 'ruins']],
  ['viewpoint', 'Viewpoints', ['observation deck', 'lookout', 'tower']],
  ['farm', 'Farms', ['petting zoo', 'pick your own']],
  ['festival', 'Festivals', ['fair', 'carnival']],
  ['theme-park', 'Theme parks', ['amusement park', 'rides', 'funfair']],
];

const DIETS = [
  ['vegetarian', 'Vegetarian', ['veggie', 'no meat']],
  ['vegan', 'Vegan', ['plant-based', 'no animal products']],
  ['pescatarian', 'Pescatarian', ['fish but no meat']],
  ['halal', 'Halal', []],
  ['kosher', 'Kosher', []],
  ['gluten-free', 'Gluten-free', ['coeliac', 'celiac', 'no gluten']],
  ['dairy-free', 'Dairy-free', ['lactose free', 'no dairy']],
  ['no-pork', 'No pork', []],
  ['no-alcohol', 'No alcohol', ['teetotal', 'alcohol free']],
];

// The canonical allergen list. US FDA nine; the EU/UK fourteen remain an open
// question in Epic 1 — adding them later is a vocabulary change, not a schema one.
export const ALLERGENS = ['milk', 'eggs', 'fish', 'shellfish', 'tree nuts', 'peanuts', 'wheat', 'soybeans', 'sesame'];

function build(kind, rows) {
  return rows.map(([slug, label, aliases]) => ({
    key: `${kind}:${slug}`,
    kind,
    slug,
    label,
    aliases: [label.toLowerCase(), slug.replace(/-/g, ' '), ...aliases.map((a) => a.toLowerCase())],
  }));
}

export const CONCEPTS = [
  ...build('dish', DISHES),
  ...build('cuisine', CUISINES),
  ...build('experience', EXPERIENCES),
  ...build('diet', DIETS),
];

const BY_KEY = new Map(CONCEPTS.map((c) => [c.key, c]));
export const conceptByKey = (key) => BY_KEY.get(key) ?? null;

export const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity of a query to one alias: exact, containment, then edit distance. */
function similarity(query, alias) {
  if (query === alias) return 1;
  if (!query || !alias) return 0;
  if (alias.startsWith(query)) return 0.92;
  if (alias.includes(query) || query.includes(alias)) return 0.85;
  // Token overlap handles "spaghetti arribata" vs "spaghetti arrabbiata".
  const qt = query.split(' ');
  const at = alias.split(' ');
  let tokenScore = 0;
  for (const q of qt) {
    let best = 0;
    for (const a of at) {
      const d = levenshtein(q, a);
      const s = 1 - d / Math.max(q.length, a.length);
      if (s > best) best = s;
    }
    tokenScore += best;
  }
  tokenScore /= qt.length;
  const whole = 1 - levenshtein(query, alias) / Math.max(query.length, alias.length);
  return Math.max(tokenScore * 0.95, whole);
}

/** Score every concept against free text; best alias wins. */
export function matchConcepts(text, { kinds = null, limit = 8 } = {}) {
  const q = norm(text);
  if (!q) return [];
  const out = [];
  for (const c of CONCEPTS) {
    if (kinds && !kinds.includes(c.kind)) continue;
    let best = 0;
    let via = null;
    for (const alias of c.aliases) {
      const s = similarity(q, norm(alias));
      if (s > best) { best = s; via = alias; }
    }
    if (best >= 0.6) out.push({ ...c, score: Number(best.toFixed(3)), via });
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.slice(0, limit);
}

// Above this a free-text entry is treated as the concept; below it the text is
// kept as written and offered as a suggestion (Epic 2 C7 — no silent merges).
export const RESOLVE_THRESHOLD = 0.8;

/** Resolve free text to one concept, or null when not confident. */
export function resolveConcept(text, { kinds = null } = {}) {
  const [top, second] = matchConcepts(text, { kinds, limit: 2 });
  if (!top || top.score < RESOLVE_THRESHOLD) return null;
  // Two near-equal candidates is ambiguity, not a match.
  if (second && second.score >= RESOLVE_THRESHOLD && top.score - second.score < 0.03 && second.kind === top.kind) return null;
  return top;
}

/** Does a venue carry this concept? Uses its dish concept slugs, cuisines and category. */
export function venueHasConcept(venue, concept) {
  if (!concept) return false;
  const slugs = new Set([
    ...(venue.dishes || []).map((d) => `dish:${d.concept}`),
    ...(venue.cuisines || []).map((c) => `cuisine:${c}`),
    `cuisine:${venue.category}`,
    ...(venue.experiences || []).map((e) => `experience:${e}`),
  ]);
  if (slugs.has(concept.key)) return true;
  // Cuisine ↔ dish adjacency: liking ramen makes a Japanese place relevant, and
  // liking Italian makes a place that serves arrabbiata relevant.
  const hay = [
    ...(venue.dishes || []).flatMap((d) => [d.name, d.concept]),
    ...(venue.cuisines || []),
    venue.category,
    ...(venue.experiences || []),
  ].map(norm);
  return concept.aliases.some((a) => hay.some((h) => h === norm(a) || h.includes(norm(a))));
}

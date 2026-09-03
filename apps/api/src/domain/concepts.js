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
  ['arrabbiata', 'Arrabbiata', ['spaghetti arrabbiata', 'penne arrabbiata', "penne all'arrabbiata", 'arabiata', 'arrabiata', 'spicy tomato pasta'], 'italian'],
  ['carbonara', 'Carbonara', ['spaghetti carbonara', 'pasta carbonara'], 'italian'],
  ['bolognese', 'Bolognese', ['spaghetti bolognese', 'ragu', 'ragù', 'tagliatelle al ragu'], 'italian'],
  ['lasagne', 'Lasagne', ['lasagna'], 'italian'],
  ['margherita', 'Margherita pizza', ['pizza margherita', 'cheese pizza'], 'italian'],
  ['pepperoni-pizza', 'Pepperoni pizza', ['pepperoni'], 'italian'],
  ['pizza', 'Pizza', ['pizzas'], 'italian'],
  ['risotto', 'Risotto', ['mushroom risotto'], 'italian'],
  ['gnocchi', 'Gnocchi', [], 'italian'],
  ['tiramisu', 'Tiramisu', [], 'italian'],
  ['ramen', 'Ramen', ['tonkotsu ramen', 'tonkotsu', 'miso ramen', 'shoyu ramen', 'noodle soup'], 'japanese'],
  ['gyoza', 'Gyoza', ['dumplings', 'pork dumplings', 'potstickers'], 'japanese'],
  ['sushi', 'Sushi', ['nigiri', 'maki', 'sashimi', 'sushi rolls'], 'japanese'],
  ['katsu-curry', 'Katsu curry', ['chicken katsu', 'katsu'], 'japanese'],
  ['pad-thai', 'Pad thai', ['phad thai'], 'thai'],
  ['green-curry', 'Thai green curry', ['green curry'], 'thai'],
  ['pho', 'Pho', ['phở', 'beef pho'], 'vietnamese'],
  ['banh-mi', 'Bánh mì', ['banh mi'], 'vietnamese'],
  ['fish-and-chips', 'Fish and chips', ['fish n chips', 'battered fish', 'haddock and chips', 'cod and chips'], 'british'],
  ['sunday-roast', 'Sunday roast', ['roast dinner', 'roast beef', 'roast chicken', 'roast lamb'], 'british'],
  ['burger', 'Burger', ['burgers', 'cheeseburger', 'hamburger', 'smash burger'], 'american'],
  ['steak', 'Steak', ['ribeye', 'sirloin', 'fillet steak', 'steak frites'], 'steakhouse'],
  ['brisket', 'Brisket', ['smoked brisket'], 'barbecue'],
  ['burnt-ends', 'Burnt ends', [], 'barbecue'],
  ['ribs', 'Ribs', ['bbq ribs', 'pork ribs', 'baby back ribs'], 'barbecue'],
  ['pulled-pork', 'Pulled pork', [], 'barbecue'],
  ['fried-chicken', 'Fried chicken', ['chicken wings', 'wings', 'hot wings'], 'american'],
  ['tacos', 'Tacos', ['taco', 'carnitas tacos', 'fish tacos', 'street tacos'], 'mexican'],
  ['carnitas-taco', 'Carnitas tacos', ['carnitas'], 'mexican'],
  ['burrito', 'Burrito', ['burritos'], 'mexican'],
  ['quesadilla', 'Quesadilla', ['quesadillas'], 'mexican'],
  ['nachos', 'Nachos', [], 'mexican'],
  ['ceviche', 'Ceviche', [], 'peruvian'],
  ['lomo-saltado', 'Lomo saltado', [], 'peruvian'],
  ['clam-chowder', 'Clam chowder', ['chowder', 'new england clam chowder'], 'seafood'],
  ['lobster-roll', 'Lobster roll', [], 'seafood'],
  ['grilled-octopus', 'Grilled octopus', ['octopus', 'charred octopus'], 'seafood'],
  ['fish-pie', 'Fish pie', [], 'british'],
  ['moules', 'Moules', ['mussels', 'moules frites'], 'seafood'],
  ['falafel', 'Falafel', ['falafel wrap', 'falafel plate'], 'mediterranean'],
  ['hummus', 'Hummus', ['houmous'], 'mediterranean'],
  ['mezze', 'Mezze', ['meze', 'mezze board'], 'mediterranean'],
  ['shawarma', 'Shawarma', ['doner', 'döner', 'kebab'], 'mediterranean'],
  ['butter-chicken', 'Butter chicken', ['murgh makhani'], 'indian'],
  ['tikka-masala', 'Tikka masala', ['chicken tikka masala'], 'indian'],
  ['biryani', 'Biryani', [], 'indian'],
  ['dosa', 'Dosa', ['masala dosa'], 'indian'],
  ['dal', 'Dal', ['dhal', 'daal', 'lentil curry'], 'indian'],
  ['pancakes', 'Pancakes', ['stack of pancakes', 'buttermilk pancakes'], 'american'],
  ['waffles', 'Waffles', [], 'american'],
  ['eggs-benedict', 'Eggs Benedict', ['benedict'], 'american'],
  ['avocado-toast', 'Avocado toast', ['avo toast'], 'cafe'],
  ['full-breakfast', 'Full breakfast', ['fry up', 'full english', 'cooked breakfast'], 'british'],
  ['croissant', 'Croissant', ['almond croissant', 'pain au chocolat'], 'cafe'],
  ['cinnamon-bun', 'Cinnamon bun', ['cinnamon roll'], 'cafe'],
  ['flat-white', 'Flat white', [], 'cafe'],
  ['cappuccino', 'Cappuccino', ['latte', 'coffee'], 'cafe'],
  ['hot-chocolate', 'Hot chocolate', [], 'cafe'],
  ['milkshake', 'Milkshake', ['shake'], 'american'],
  ['ice-cream', 'Ice cream', ['gelato', 'sundae'], 'cafe'],
  ['old-fashioned', 'Old fashioned', [], 'bar'],
  ['margarita', 'Margarita', ['margaritas'], 'mexican'],
  ['craft-beer', 'Craft beer', ['ipa', 'beer', 'ale'], 'pub'],
  ['salad', 'Salad', ['caesar salad', 'greek salad']],
  ['soup', 'Soup', ['tomato soup', 'soup of the day']],
  ['mac-and-cheese', 'Mac and cheese', ['macaroni cheese', 'mac n cheese'], 'american'],
  ['chips', 'Chips', ['fries', 'french fries'], 'pub'],
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
  ['history', 'Historical things', ['history', 'historic sites', 'heritage', 'old buildings', 'monuments', 'historical']],
  ['viewpoint', 'Viewpoints', ['observation deck', 'lookout', 'tower']],
  ['farm', 'Farms', ['petting zoo', 'pick your own']],
  ['festival', 'Festivals', ['fair', 'carnival']],
  ['theme-park', 'Theme parks', ['amusement park', 'rides', 'funfair']],
];

// Things people say they like without naming a dish: an ingredient or a style.
const INGREDIENTS = [
  ['chicken', 'Chicken', ['chicken dishes', 'poultry']],
  ['beef', 'Beef', []],
  ['pork', 'Pork', ['bacon', 'ham']],
  ['lamb', 'Lamb', []],
  ['duck', 'Duck', []],
  ['fish', 'Fish', ['white fish', 'salmon', 'cod', 'tuna']],
  ['prawns', 'Prawns', ['shrimp', 'king prawns']],
  ['cheese', 'Cheese', ['cheesy']],
  ['eggs', 'Eggs', ['egg dishes']],
  ['mushrooms', 'Mushrooms', ['mushroom']],
  ['tomatoes', 'Tomatoes', ['tomato']],
  ['vegetables', 'Vegetables', ['veg', 'greens', 'veggies']],
  ['noodles', 'Noodles', ['noodle']],
  ['rice', 'Rice', ['rice dishes']],
  ['bread', 'Bread', ['sourdough', 'flatbread']],
  ['chocolate', 'Chocolate', ['chocolatey']],
  ['garlic', 'Garlic', []],
  ['chilli', 'Chilli', ['chili', 'hot sauce']],
];

const STYLES = [
  ['healthy-food', 'Healthy food', ['healthy', 'light and healthy', 'fresh food', 'clean eating', 'nutritious']],
  ['fried-food', 'Fried food', ['fried', 'deep fried', 'greasy food', 'fast food', 'junk food', 'takeaway']],
  ['spicy-food', 'Spicy food', ['spicy', 'hot food', 'heat']],
  ['light-food', 'Light food', ['something light', 'light bites', 'small plates']],
  ['comfort-food', 'Comfort food', ['hearty', 'stodge', 'home cooking']],
  ['fine-dining', 'Fine dining', ['posh', 'fancy', 'tasting menu', 'special occasion']],
  ['sharing-plates', 'Sharing plates', ['sharing', 'family style', 'tapas style']],
  ['kids-menu', "Kids' menu", ["children's menu", 'child friendly food', 'kid friendly']],
  ['big-portions', 'Big portions', ['generous portions', 'hungry']],
  ['grilled-food', 'Grilled food', ['grilled', 'chargrilled', 'from the grill']],
  ['sweet-treats', 'Sweet treats', ['dessert', 'desserts', 'puddings', 'cake', 'pastries']],
];

// What a style means in terms of the dishes and cuisines a venue actually lists.
const STYLE_HINTS = {
  'style:healthy-food': { dishes: ['salad', 'soup', 'falafel', 'mezze', 'avocado-toast', 'hummus', 'ceviche', 'sushi', 'pho'], cuisines: ['vegetarian', 'vegan', 'mediterranean', 'salad', 'juice', 'health', 'japanese', 'vietnamese'] },
  'style:fried-food': { dishes: ['fried-chicken', 'fish-and-chips', 'chips', 'burger', 'nachos'], cuisines: ['fast food', 'fried chicken', 'chicken', 'burger', 'fish and chips', 'chip shop', 'kebab'] , styles: ['fast-food'] },
  'style:spicy-food': { dishes: ['arrabbiata', 'green-curry', 'ceviche', 'tikka-masala', 'biryani', 'shawarma', 'tacos', 'pad-thai'], cuisines: ['thai', 'indian', 'mexican', 'szechuan', 'sichuan', 'korean', 'peruvian', 'caribbean'] },
  'style:light-food': { dishes: ['salad', 'soup', 'mezze', 'sushi', 'avocado-toast', 'flat-white'], cuisines: ['cafe', 'tapas', 'mediterranean', 'japanese'] },
  'style:comfort-food': { dishes: ['mac-and-cheese', 'lasagne', 'sunday-roast', 'fish-pie', 'burger', 'pancakes', 'full-breakfast'], cuisines: ['british', 'american', 'diner', 'pub'] },
  'style:fine-dining': { dishes: [], cuisines: ['fine dining', 'french', 'steakhouse'] },
  'style:sharing-plates': { dishes: ['mezze', 'nachos', 'gyoza'], cuisines: ['tapas', 'spanish', 'mediterranean', 'dim sum', 'korean'] },
  'style:kids-menu': { dishes: ['margherita', 'chips', 'pancakes', 'ice-cream'], cuisines: ['pizza', 'diner', 'american'] },
  'style:big-portions': { dishes: ['burger', 'sunday-roast', 'full-breakfast', 'burrito', 'ribs'], cuisines: ['american', 'barbecue', 'diner', 'steakhouse'] },
  'style:grilled-food': { dishes: ['steak', 'brisket', 'ribs', 'grilled-octopus', 'shawarma'], cuisines: ['barbecue', 'steakhouse', 'grill', 'korean', 'turkish'] },
  'style:sweet-treats': { dishes: ['tiramisu', 'ice-cream', 'cinnamon-bun', 'croissant', 'pancakes', 'waffles', 'hot-chocolate', 'milkshake'], cuisines: ['bakery', 'cafe', 'dessert', 'ice cream', 'patisserie'] },
};

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
  return rows.map(([slug, label, aliases, cuisine]) => ({
    key: `${kind}:${slug}`,
    kind,
    slug,
    label,
    cuisine: cuisine ?? null,
    aliases: [label.toLowerCase(), slug.replace(/-/g, ' '), ...aliases.map((a) => a.toLowerCase())],
  }));
}

export const CONCEPTS = [
  ...build('dish', DISHES),
  ...build('cuisine', CUISINES),
  ...build('ingredient', INGREDIENTS),
  ...build('style', STYLES),
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

function bestTokenMatch(token, others) {
  let best = 0;
  for (const o of others) {
    const s = 1 - levenshtein(token, o) / Math.max(token.length, o.length);
    if (s > best) best = s;
  }
  return best;
}

/**
 * 0..1 similarity of a query to one alias.
 *
 * Only genuine equivalents score high enough to be linked automatically:
 * exact matches, and misspellings of the same words ("spaghetti arribata" ≈
 * "spaghetti arrabbiata"). A shorter word inside a longer name ("chicken" in
 * "fried chicken") is a suggestion, never a match — the matcher must not turn
 * what someone typed into something more specific than they said.
 */
function similarity(query, alias) {
  if (query === alias) return 1;
  if (!query || !alias) return 0;
  const qt = query.split(' ');
  const at = alias.split(' ');
  // Symmetric token overlap: every word on both sides has to be accounted for.
  let sum = 0;
  for (const q of qt) sum += bestTokenMatch(q, at);
  for (const a of at) sum += bestTokenMatch(a, qt);
  const tokenScore = sum / (qt.length + at.length);
  const whole = 1 - levenshtein(query, alias) / Math.max(query.length, alias.length);
  let score = Math.max(tokenScore, whole);
  // Containment is worth surfacing as a pill, but capped below the link threshold.
  if (score < 0.75 && (alias.includes(query) || query.includes(alias))) score = 0.72;
  else if (score < 0.7 && alias.startsWith(query)) score = 0.7;
  return score;
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

// "not fried chicken", "no seafood", "anything but pubs": a negation is a
// dislike wearing a like's clothes. It is never linked; the caller is told.
const NEGATION = /^(not|no|never|without|anything but|nothing)\b/i;
export const isNegated = (text) => NEGATION.test(String(text || '').trim());

/** Resolve free text to one concept, or null when not confident. */
export function resolveConcept(text, { kinds = null } = {}) {
  if (isNegated(text)) return null;
  const [top, second] = matchConcepts(text, { kinds, limit: 2 });
  if (!top || top.score < RESOLVE_THRESHOLD) return null;
  // Two near-equal candidates is ambiguity, not a match.
  if (second && second.score >= RESOLVE_THRESHOLD && top.score - second.score < 0.03 && second.kind === top.kind) return null;
  return top;
}

/** Does a venue carry this concept? Uses its dish concept slugs, cuisines and category. */
export function venueHasConcept(venue, concept) {
  if (!concept) return false;
  if (concept.kind === 'style') {
    const hint = STYLE_HINTS[concept.key] || { dishes: [], cuisines: [], styles: [] };
    const dishSlugs = new Set((venue.dishes || []).map((d) => d.concept));
    if (hint.dishes.some((d) => dishSlugs.has(d))) return true;
    const cuisines = (venue.cuisines || []).map(norm);
    if (hint.cuisines.some((c) => cuisines.some((v) => v.includes(norm(c))))) return true;
    if ((hint.styles || []).some((st) => (venue.styles || []).includes(st))) return true;
  }
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


// ---------------------------------------------------------------------------
// Browse: broad things first, expandable into specifics, so a household can
// tap ten favourites instead of typing and guessing (owner feedback, 3 Sep 2026).
// ---------------------------------------------------------------------------

const ACTIVITY_GROUPS = [
  ['Outdoors', ['park', 'walk', 'beach', 'cycling', 'boat-trip', 'viewpoint', 'farm']],
  ['Culture', ['museum', 'art-gallery', 'history', 'castle', 'theatre', 'cinema', 'bookshop']],
  ['Family fun', ['playground', 'zoo', 'aquarium', 'theme-park', 'trampoline', 'arcade', 'mini-golf', 'bowling', 'escape-room']],
  ['Active', ['swimming', 'climbing', 'ice-skating', 'sports-game']],
  ['Out at night', ['live-music', 'comedy', 'festival', 'market', 'shopping']],
];

export function browseVocabulary() {
  const dishesByCuisine = new Map();
  for (const d of CONCEPTS.filter((c) => c.kind === 'dish')) {
    if (!d.cuisine) continue;
    if (!dishesByCuisine.has(d.cuisine)) dishesByCuisine.set(d.cuisine, []);
    dishesByCuisine.get(d.cuisine).push({ key: d.key, label: d.label });
  }
  const pick = (kind, slugs) => slugs.map((sl) => conceptByKey(`${kind}:${sl}`)).filter(Boolean).map((c) => ({ key: c.key, label: c.label }));
  return {
    food: [
      { title: 'Cuisines', hint: 'Broad is fine — expand one to pick favourite dishes.',
        items: CONCEPTS.filter((c) => c.kind === 'cuisine' && !['pub', 'bar', 'cafe'].includes(c.slug)).map((c) => ({ key: c.key, label: c.label, children: dishesByCuisine.get(c.slug) ?? [] })) },
      { title: 'Styles', hint: 'How you like to eat.', items: CONCEPTS.filter((c) => c.kind === 'style').map((c) => ({ key: c.key, label: c.label, children: [] })) },
      { title: 'Ingredients', hint: 'Things you always go for — or avoid.', items: CONCEPTS.filter((c) => c.kind === 'ingredient').map((c) => ({ key: c.key, label: c.label, children: [] })) },
      { title: 'Places to drink and snack', hint: '', items: [...pick('cuisine', ['cafe', 'pub', 'bar']).map((c) => ({ ...c, children: dishesByCuisine.get(c.key.split(':')[1]) ?? [] }))] },
    ],
    activities: ACTIVITY_GROUPS.map(([title, slugs]) => ({ title, hint: '', items: pick('experience', slugs).map((c) => ({ ...c, children: [] })) })),
    diets: CONCEPTS.filter((c) => c.kind === 'diet').map((c) => ({ key: c.key, label: c.label })),
  };
}

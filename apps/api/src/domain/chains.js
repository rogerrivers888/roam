// Chains and independents (owner feedback, 3 Sep 2026: "anyone can recommend a
// pizza or burger place; a unique family-run one is a different thing").
//
// A chain is not bad, it is a choice the household makes for the day — so this
// only labels; options.js decides whether labelled places are offered. The
// OpenStreetMap `brand` tag is the primary signal (Google has no such flag); a
// short list of well-known groups catches the many places mappers never tagged.

const KNOWN_GROUPS = [
  // UK casual dining and fast food
  'pizza express', 'pizzaexpress', 'nando', 'wagamama', 'franco manca', 'spaghetti house', 'bella italia', 'prezzo', 'zizzi', 'ask italian',
  'byron', 'five guys', 'mcdonald', 'burger king', 'kfc', 'subway', 'costa', 'costa coffee', 'starbucks', 'pret a manger', 'caffe nero', 'greggs',
  'wetherspoon', 'slug and lettuce', 'all bar one', 'cote brasserie', 'cote', 'giraffe', 'leon', 'itsu', 'wasabi', 'yo sushi', 'pizza hut', 'domino', 'papa john',
  'tgi friday', 'frankie benny', 'harvester', 'toby carvery', 'beefeater', 'miller carter', 'gourmet burger kitchen', 'gbk', 'honest burgers', 'dishoom',
  'the ivy', 'ivy brasserie', 'wahaca', 'tortilla', 'chipotle', 'shake shack', 'busaba', 'banana tree', 'las iguanas', 'turtle bay', 'the real greek',
  'le pain quotidien', 'gail s', 'ole steen', 'joe the juice', 'black sheep coffee', 'hard rock cafe', 'bubba gump', 'brasserie blanc', 'loch fyne',
  'stonehouse', 'hungry horse', 'ember inns', 'nicholson s', 'bill s restaurant', 'carluccio', 'jamie s italian', 'rosa s thai', 'pho cafe', 'mowgli', 'zaza', 'coco di mama', 'tossed',
  // US and European groups a travelling household will meet
  'olive garden', 'applebee', 'cheesecake factory', 'p f chang', 'ihop', 'denny s', 'taco bell', 'wendy s', 'chick fil a', 'dunkin', 'tim hortons', 'panera',
  'autogrill', 'roadhouse', 'old wild west', 'la piadineria', 'rossopomodoro', 'vapiano', 'l osteria', 'hans im gluck', 'nordsee', 'quick', 'paul bakery', 'brioche doree', 'hippopotamus', 'buffalo grill', 'flunch', 'la boqueria', '100 montaditos', 'telepizza', 'foster s hollywood', 'vips', 'ginos',
];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const PATTERNS = KNOWN_GROUPS.map((k) => new RegExp(`(^|\\s)${norm(k).replace(/\s+/g, '\\s')}(s)?(\\s|$)`));

/** { chain: boolean, brand: string|null } — brand is the tagged group name when known. */
export function detectChain(venue) {
  const brand = venue.brand || venue.tags?.brand || null;
  if (brand) return { chain: true, brand };
  const n = norm(venue.name);
  if (!n) return { chain: false, brand: null };
  return { chain: PATTERNS.some((p) => p.test(n)), brand: null };
}

/**
 * How big a chain is, rather than whether it is one (owner, 5 Sep 2026).
 *
 * > "I'm not sure if we should deliberately kill all chains because some people
 * > love chains… They could even just be 2 or 3 stores in a chain. Let's roll
 * > back on my decision… but then we can just sort them… so that we're not
 * > showing McDonald's on the best restaurants list."
 *
 * A boolean could not carry that. Two brothers with a second site in the next
 * town and a global quick-service brand are both "a chain" and nothing useful
 * follows from saying so. What follows from *scale* is a weight.
 *
 * Three signals, in order of how much they are worth trusting:
 *
 *   the known list  a name everybody would recognise as a group. Blunt, but it
 *                   is right about the ones that matter most.
 *   the OSM brand   a mapper has said this place belongs to a brand, which they
 *                   do for groups rather than for a family's second restaurant.
 *   our own count   how many of Roam's own areas hold a place of this name. This
 *                   is the signal that needs no list and gets better as the
 *                   sweep covers more of the country — the only one that will
 *                   ever notice a nine-site regional group nobody has heard of.
 */
export function chainScale({ name, brand = null, sites = 1 } = {}) {
  const n = norm(name);
  const known = n ? PATTERNS.some((p) => p.test(n)) : false;
  if (known || sites >= 10) return { chain: true, scale: 'national' };
  // A mapper tags `brand` for a group, not for somebody's second restaurant.
  if (brand) return { chain: true, scale: sites >= 4 ? 'national' : 'regional' };
  if (sites >= 4) return { chain: true, scale: 'regional' };
  if (sites >= 2) return { chain: true, scale: 'small' };
  return { chain: false, scale: 'independent' };
}

/**
 * What being that size is worth, as a multiplier on the score.
 *
 * Not a cut. A national group that people genuinely rate can still appear —
 * the owner's objection was to McDonald's topping a list of the best, and
 * McDonald's is held down by its own crowd band and by having nothing
 * particular to say about its food, not by this line alone. Two or three sites
 * is very nearly nothing, because that is a local success rather than a chain
 * in the sense anybody minds about.
 */
export const CHAIN_WEIGHT = { independent: 1, small: 0.97, regional: 0.9, national: 0.72 };

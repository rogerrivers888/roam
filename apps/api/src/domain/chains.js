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

// Who else rates this place (owner, 4 Sep 2026: "maybe we can find independent
// reviews and build up our own database").
//
// A rating is a licensed figure we may not keep. An accolade is not: that a
// restaurant holds two AA rosettes, or is in the Good Food Guide, is a fact
// about who said what, published in order to be quoted, and ours to keep for
// good. It is also a better signal for the thing the owner actually wants —
// "the highly rated restaurants in each postcode", not the ones with the most
// four-star reviews for parking.
//
// Restaurants advertise their accolades on their own front page, because that
// is the point of having one. So this reads the page we already have to fetch
// and looks for the badge, which costs nothing and asks nobody's permission.
//
// What this deliberately does not do is trust the word on its own. "Michelin"
// appears on a page that sells Michelin tyres and on one that says "our chef
// trained at a Michelin-starred kitchen", so each pattern has to match the
// claim rather than the word.

const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; accolade check)';
const FETCH_TIMEOUT_MS = 9000;
const MAX_BYTES = 800_000;

/** Each accolade, and the shape of an actual claim to hold it. */
const PATTERNS = [
  ['michelin-star', /\b(?:michelin[- ](?:one|two|three|1|2|3)?[- ]?star(?:red|s)?\b(?!\s+(?:kitchen|chef|trained|restaurants?\s+in))|awarded\s+(?:a|our)\s+michelin\s+star)/i],
  ['michelin-bib', /\bbib\s+gourmand\b/i],
  ['michelin-listed', /\b(?:in|featured\s+in|listed\s+in|recommended\s+by)\s+the\s+michelin\s+guide\b|\bmichelin\s+guide\s+(?:listed|recommended)\b/i],
  ['good-food-guide', /\b(?:the\s+)?good\s+food\s+guide\b/i],
  ['aa-rosette', /\b(?:aa\s+)?(?:one|two|three|four|five|1|2|3|4|5)\s+(?:aa\s+)?rosettes?\b|\baa\s+rosettes?\b/i],
  ['top-100-gastropub', /\btop\s+50\s+gastropubs?\b|\btop\s+100\s+gastropubs?\b|\bestrella\s+damm\s+(?:top|gastropub)/i],
  ['national-restaurant-award', /\bnational\s+restaurant\s+awards?\b/i],
  ['hardens', /\bharden'?s\b/i],
  ['squaremeal', /\bsquaremeal\b/i],
  ['camra', /\bcamra\b|\bgood\s+beer\s+guide\b/i],
];

const strip = (html) => String(html ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/\s+/g, ' ');

/**
 * The accolades a page claims. Pure, so the patterns can be tested without a
 * network — which matters, because a false positive here inflates a score.
 */
export function accoladesFrom(html) {
  const text = strip(html);
  if (!text) return [];
  const out = [];
  for (const [key, pattern] of PATTERNS) if (pattern.test(text)) out.push(key);
  // A star implies the guide; saying both twice would double-count in scoring.
  if (out.includes('michelin-star') || out.includes('michelin-bib')) {
    const i = out.indexOf('michelin-listed');
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

/** Read a venue's own front page for its badges. One request, free, theirs. */
export async function accoladesFor(website) {
  if (!/^https?:\/\//i.test(String(website ?? ''))) return { accolades: [], why: 'no website' };
  try {
    const res = await fetch(website, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return { accolades: [], why: `their site answered ${res.status}` };
    if (!/text\/html|xhtml/i.test(res.headers.get('content-type') || '')) return { accolades: [], why: 'their site is not a page' };
    const html = (await res.text()).slice(0, MAX_BYTES);
    return { accolades: accoladesFrom(html), why: null };
  } catch (err) {
    return { accolades: [], why: err.name === 'AbortError' ? 'their site timed out' : 'their site did not answer' };
  }
}

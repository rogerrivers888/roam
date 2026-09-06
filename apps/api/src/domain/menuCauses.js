/**
 * Why a menu could not be read, in words a person can count.
 *
 * Owner, 5 Sep 2026, on the back office: "There's definitely some reporting
 * required on places we haven't been able to recover… areas where, in
 * restaurants, it's menus you haven't been able to read."
 *
 * The crawler already says why, and says it well — "Nothing on
 * www.caldesi.com says menu — it may be a picture, or on their booking page."
 * is a better sentence than any code. But on production those sentences came in
 * **sixty-three distinct shapes for a hundred and twenty-six failures**, because
 * most of them carry a hostname or an anchor label. Sixty-three sentences is an
 * anecdote: it cannot be counted, charted, or worked in priority order, and a
 * change to the crawler cannot be shown to have helped.
 *
 * So a cause is written *beside* the sentence rather than instead of it. The
 * sentence stays, because it is what tells you what to do about this one place;
 * the cause is what makes a hundred of them a number that moves.
 *
 * The set is closed and deliberately small. Each one names a different fix, and
 * a cause nobody can act on differently from its neighbour has no business
 * being its own row.
 */

/**
 * The causes, in the order the report should read them: most places first is
 * decided at query time, but where two are equal this is the tie-break, and it
 * runs from "we can fix this in the crawler" to "there is nothing to fix".
 */
export const CAUSES = [
  {
    key: 'seasonal_anchor',
    label: 'Followed a seasonal or partial menu',
    detail: 'The crawler took a link named for one occasion — a Christmas, festive or Sunday menu — instead of the everyday one.',
    fix: 'Rank the anchors: prefer an unqualified "Menu" over a named one.',
  },
  {
    key: 'wrong_branch',
    label: 'The only menu link is another branch',
    detail: 'A group site whose menu link goes to a different town.',
    fix: 'Match the branch to the town before following it.',
  },
  {
    key: 'delivery_platform',
    label: 'The menu is on a delivery platform',
    detail: 'Deliveroo, Just Eat or an ordering page rather than the venue’s own.',
    fix: 'A decision, not a bug: whether Roam reads a platform’s copy of a menu.',
  },
  {
    key: 'social_only',
    label: 'Their website is a social profile',
    detail: 'Instagram or Facebook, which has no menu page to open.',
    fix: 'Find the real site, or accept there is not one.',
  },
  {
    key: 'no_menu_link',
    label: 'Nothing on their site says menu',
    detail: 'The site answered and the crawler found no menu anchor on it.',
    fix: 'Try the conventional paths, and read the navigation with a browser.',
  },
  {
    key: 'menu_empty',
    label: 'The menu page has no dishes on it',
    detail: 'It opened, and there was nothing to read — a picture, a PDF, or a page that only links elsewhere.',
    fix: 'Read the PDF, and read an image menu.',
  },
  {
    key: 'menu_unreadable',
    label: 'Nothing readable, even in a browser',
    detail: 'The page rendered and still produced no text.',
    fix: 'Worth a look by hand: these are usually a single image.',
  },
  {
    key: 'site_dead',
    label: 'Their site did not answer',
    detail: 'A timeout, a refused connection or a server error.',
    fix: 'Retry — some of these are temporary, and the rest have closed.',
  },
  {
    key: 'no_website',
    label: 'No website at all',
    detail: 'Nothing to open.',
    fix: 'Nothing to do here; the place may still be worth keeping.',
  },
  {
    key: 'ours',
    label: 'Roam’s own fault',
    detail: 'A missing key, a quota, or an error inside Roam — not anything about their site.',
    fix: 'Fix it here and re-queue. These must never be counted as a place we cannot read.',
  },
  {
    key: 'unknown',
    label: 'Not yet classified',
    detail: 'A sentence the classifier has not been taught to read.',
    fix: 'Add it to domain/menuCauses.js — an unknown that grows is the thing to watch.',
  },
];

export const CAUSE_KEYS = CAUSES.map((c) => c.key);
export const causeByKey = Object.fromEntries(CAUSES.map((c) => [c.key, c]));

/** Anchor labels that name an occasion rather than the everyday menu. */
const SEASONAL = /\b(christmas|festive|easter|valentine|mother'?s day|father'?s day|new year|sunday|breakfast|brunch|lunch|kids|children|drinks|wine|cocktail|dessert|bottomless|set|tasting|party|function|events?)\b/i;

const PLATFORM = /(deliveroo|just ?eat|ubereats|uber eats|order ?online|orderonline|slerp|storekit|hungryhouse|foodhub|order-?food)/i;
const SOCIAL = /(instagram\.com|facebook\.com|linktr\.ee|twitter\.com|x\.com|tiktok\.com)/i;

/**
 * Read a recorded failure into one of the closed causes.
 *
 * Takes everything known about the row rather than the sentence alone: a
 * "Followed …" sentence means the crawler *found* a link, so whether it was the
 * wrong one is decided by the anchor's label, and a website that is an Instagram
 * profile is a different problem from a site that would not answer even though
 * both can end up saying "nothing on … says menu".
 *
 * Order matters. The specific causes are tested before the general ones,
 * because "Nothing on www.instagram.com says menu" is a social profile first and
 * a missing anchor second, and only the first of those has a fix.
 */
export function causeOf({ why = null, state = null, website = null, menuUrl = null } = {}) {
  const w = String(why ?? '');
  const site = String(website ?? '');
  const url = String(menuUrl ?? '');

  // Ours before theirs. A read that failed because Roam had no key, or hit a
  // quota, or threw inside the SDK, says nothing whatever about the restaurant
  // — and counting it as "a menu we cannot read" would put our own outage in
  // the middle of a report about their websites. It is a retry, not a finding.
  if (/could not resolve authentication|api[_ ]?key|unauthori[sz]ed|rate.?limit|quota|429|credit balance|overloaded|insufficient|ECONNRESET|socket hang up|internal server error/i.test(w)) {
    return 'ours';
  }

  // The crawler's own codes, thrown from menuRead.js, are already causes.
  if (w === 'menu_had_no_items') return 'menu_empty';
  if (w === 'menu_unreadable') return 'menu_unreadable';
  if (w === 'menu_url_required') return 'no_website';

  if (/another branch/i.test(w)) return 'wrong_branch';
  if (PLATFORM.test(w) || PLATFORM.test(url)) return 'delivery_platform';
  if (SOCIAL.test(w) || SOCIAL.test(site) || SOCIAL.test(url)) return 'social_only';

  // "Followed “Christmas Menu” on thecoachmarlow.co.uk." — a link was found, so
  // the failure is downstream of finding it; the label says whether the wrong
  // one won.
  const followed = w.match(/^Followed\s+[“"']?(.+?)[”"']?\s+on\s/i);
  if (followed) return SEASONAL.test(followed[1]) ? 'seasonal_anchor' : 'menu_empty';

  if (/no website/i.test(w)) return 'no_website';
  if (/did not answer|timed out|unreachable/i.test(w)) return 'site_dead';
  if (/says menu|nothing linked|no menu found|their website is the menu/i.test(w)) return 'no_menu_link';

  // A row the finder gave an address to and the reader never got to is not a
  // failure at all; it is work outstanding, and saying otherwise would inflate
  // every number on the report.
  if (state === 'found') return null;

  return 'unknown';
}

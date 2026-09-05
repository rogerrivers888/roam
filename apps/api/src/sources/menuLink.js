// Where a place publishes its menu (owner, 4 Sep 2026: "the menu website
// address also, because I'm physically going into a restaurant at this point.
// Maybe you can even pull it in real time if it's not something readily
// available").
//
// No source we pay for has a menu field — Google returns `websiteUri` and
// nothing else — so the address is found the way a person would: open the
// restaurant's own site and look for the link that says Menu. That is one HTTP
// request to their own public page, so it is free, it is not a provider call,
// and it is not written to provider_calls.
//
// This module only ever finds *where* the menu is. Reading what is on it is a
// different job with a different bill (sources/menu.js) and only happens on a
// tap.
//
// Rules this keeps:
//   • Nothing is stored. The address lives in memory for a few hours so that
//     opening the same restaurant twice does not fetch their site twice.
//   • Nothing of theirs is reproduced: we keep a URL and the words on the link.
//   • Only the address Google gave us is fetched, only over http(s), with a
//     five-second cap and a one-megabyte cap, and never more than four
//     requests for one restaurant.

// Five seconds was enough from a desk and not from the server: a branch's home
// page can be a third of a megabyte from a small host (owner, 4 Sep 2026 — the
// Windsor menu was there and we still missed it).
const FETCH_TIMEOUT_MS = Number(process.env.ROAM_MENU_TIMEOUT_MS || 9000);
const MAX_BYTES = 1_000_000;
const CACHE_TTL_MS = 6 * 3600_000;
// Roam identifies itself: a restaurant's host should be able to see who asked.
const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; household menu lookup)';

const cache = new Map();
const inflight = new Map();

/** Paths worth trying when their front page carries no link we recognise. */
const GUESSES = ['/menu', '/menus', '/food', '/order', '/our-menu', '/menu.pdf'];

const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim();

async function get(url, { method = 'GET' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf' } });
    const type = res.headers.get('content-type') || '';
    if (method === 'HEAD' || !res.ok) return { ok: res.ok, url: res.url || url, type, html: '' };
    if (!/text\/html|xhtml/i.test(type)) return { ok: true, url: res.url || url, type, html: '' };
    const html = (await res.text()).slice(0, MAX_BYTES);
    return { ok: true, url: res.url || url, type, html };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Score one link. A restaurant's menu link says "Menu" and goes somewhere;
 * a navigation toggle also says "menu" and goes nowhere, which is why an
 * anchor with no path of its own scores below zero rather than being ignored —
 * a site whose only "menu" is its burger button should come back empty.
 */
function score(href, text) {
  const t = text.toLowerCase();
  const h = href.toLowerCase();
  let n = 0;
  if (/^(the |our |view |see |our full |full )?(food |drinks? |dinner |lunch |brunch |breakfast |bar |wine |all day |sample |set |kids'? |children'?s )?menus?$/.test(t)) n += 6;
  else if (/\bmenus?\b/.test(t)) n += 4;
  // A great many restaurants publish no menu of their own and put the whole
  // thing — every dish, every price — on the page you order from. Intoku's
  // site has eight links and not one of them says menu; it says Delivery and
  // Pickup (owner, 5 Sep 2026). Worth less than a menu proper, because an
  // ordering page can also be a booking form, but far better than giving up.
  else if (/\b(order (online|now|here)?|delivery|takeaway|take away|pickup|collection|click and collect)\b/.test(t)) n += 3;
  if (/\/menus?\b|\/menus?$|[?&]menu|\bmenu-|carte|speisekarte/.test(h)) n += 3;
  else if (/\/order\b|\/ordering\b|\/delivery\b|\/takeaway\b|deliveroo|just-?eat|ubereats|chownow|slerp|toasttab|square(up|site)|orderyoyo/.test(h)) n += 2;
  if (/\bfood\b|\bwhat we serve\b|\beat\b/.test(t)) n += 1;
  if (/\.pdf($|\?)/.test(h) && n > 0) n += 1;
  if (/^menus?\./.test(new URL(href, 'https://x.invalid').hostname)) n += 2;
  // Things that say menu and are not one.
  if (/^(#|javascript:|mailto:|tel:)/.test(h) || h === '') n -= 10;
  if (/toggle|hamburger|burger-menu|nav-menu|menu-(icon|button|toggle)|skip/.test(h + ' ' + t)) n -= 8;
  if (/gift|voucher|christmas card|newsletter/.test(t)) n -= 2;
  return n;
}

/**
 * Every way out of a page, not only its anchors. Sebastian's landing page has
 * no links at all: each restaurant is a `<button onclick="document.location=…">`,
 * so a scan that only reads `<a>` sees an empty page (owner, 4 Sep 2026).
 */
function links(html, baseUrl) {
  const out = [];
  const add = (href, text) => {
    if (!href || !text) return;
    let absolute;
    try { absolute = new URL(href, baseUrl).toString(); } catch { return; }
    if (!/^https?:/i.test(absolute)) return;
    out.push({ href, url: absolute, text });
  };
  for (const [, attrs, inner] of html.matchAll(/<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi)) {
    const href = (attrs.match(/\bhref\s*=\s*"([^"]*)"/i) || attrs.match(/\bhref\s*=\s*'([^']*)'/i) || [])[1];
    add(href, clean(inner) || clean((attrs.match(/\baria-label\s*=\s*"([^"]*)"/i) || [])[1]));
  }
  // A button that navigates in script: onclick="document.location='…'".
  for (const [, attrs, inner] of html.matchAll(/<(?:button|div|span|li)\b([^>]*\bon[a-z]+\s*=\s*["'][^"']*(?:document|window)\.location[^"']*["'][^>]*)>([\s\S]{0,400}?)<\/(?:button|div|span|li)>/gi)) {
    const href = (attrs.match(/(?:document|window)\.location(?:\.href)?\s*=\s*\\?['"]([^'"\\]+)/i) || [])[1];
    add(href, clean(inner));
  }
  return out;
}

function bestLink(html, baseUrl) {
  let best = null;
  for (const { href, url, text } of links(html, baseUrl)) {
    const n = score(href, text);
    if (n <= 0) continue;
    if (!best || n > best.n || (n === best.n && text.length < best.label.length)) best = { n, url, label: text.slice(0, 60) };
  }
  return best;
}

/**
 * The way into one restaurant of several. A group's front page asks which one
 * you want before it will show you a menu, and the answer is the town this
 * place is in — "it was 1 click, but you still missed it" (owner, 4 Sep 2026).
 */
function branchLink(html, baseUrl, words) {
  if (!words.length) return null;
  let best = null;
  for (const { url, text } of links(html, baseUrl)) {
    const hay = `${text} ${url}`.toLowerCase();
    const word = words.find((w) => hay.includes(w));
    if (!word) continue;
    // A link naming the town beats one that merely happens to contain it.
    const n = (text.toLowerCase().includes(word) ? 2 : 0) + (url.toLowerCase().includes(word) ? 1 : 0) + (text.length < 30 ? 1 : 0);
    if (!best || n > best.n) best = { n, url, label: text.slice(0, 60), word };
  }
  return best;
}

/**
 * The menu address for one place, found now.
 *
 * Returns `{ url, label, how, checkedAt }` when there is one, and the same
 * shape with `url: null` and a plain reason when there is not — the caller
 * shows the reason rather than an empty row, because "their site has no menu
 * on it" is an answer.
 */
export async function findMenuUrl({ website, name = '', locality = null, address = null } = {}) {
  const site = String(website ?? '').trim();
  if (!/^https?:\/\//i.test(site)) return { url: null, label: null, how: null, why: 'No website for this place, so there is nothing to follow.', checkedAt: new Date().toISOString() };

  // The words that say which restaurant this is: two branches of one group
  // share a website, so the town is part of the question and part of the key.
  // The venue's own name is in here too — Megan's Windsor is "megans-by-the-
  // crown", with no Windsor in it anywhere (owner, 5 Sep 2026).
  const words = [...new Set(`${name ?? ''} ${locality ?? ''} ${address ?? ''}`.toLowerCase().match(/[a-z]{4,}/g) ?? [])]
    .filter((w) => !['road', 'street', 'lane', 'unit', 'high', 'avenue', 'close', 'place', 'square', 'united', 'kingdom', 'restaurant', 'kitchen'].includes(w));
  const key = `${site}|${words.join(',')}`;

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cached: true };
  if (inflight.has(key)) return { ...(await inflight.get(key)), cached: true };

  const run = (async () => {
    const at = () => new Date().toISOString();

    // The site's own index first (owner, 5 Sep 2026). It is two requests, it
    // needs no rendering and no model, and it is the only method that answers
    // "which of your thirteen restaurants is the one in Windsor" without
    // guessing: the branch is a line in location-sitemap.xml.
    try {
      const indexed = menusInIndex(await siteIndex(site), words);
      // Only when the index actually distinguishes this branch, or there is
      // exactly one menu page on the whole site. A group's bare /menus/ is a
      // chooser and the page scan handles that better.
      const best = indexed[0];
      if (best && (best.n >= 4 || indexed.length === 1)) {
        return { url: best.url, label: best.label, how: `Found it in their own site index (${indexed.length} menu page${indexed.length === 1 ? '' : 's'} listed).`, checkedAt: at() };
      }
    } catch { /* no index, or it would not answer: carry on and look at the page */ }

    let page;
    try {
      page = await get(site);
    } catch (err) {
      return { url: null, label: null, how: null, why: `Their site did not answer (${err.name === 'AbortError' ? 'timed out' : 'unreachable'}).`, checkedAt: at() };
    }
    if (!page.ok) return { url: null, label: null, how: null, why: 'Their site did not answer.', checkedAt: at() };

    // The website Google gave us may already be the menu.
    if (/\/menus?\b/i.test(page.url)) return { url: page.url, label: 'Menu', how: 'Their website is the menu.', checkedAt: at() };

    const found = page.html ? bestLink(page.html, page.url) : null;
    if (found && !branchLooksWrong(found.url, words, locality)) {
      return { url: found.url, label: found.label, how: `Followed “${found.label}” on ${new URL(page.url).hostname}.`, checkedAt: at() };
    }
    if (found) {
      // We found something and it is somebody else's branch. Say so rather than
      // storing it: a menu for the wrong town is worse than no menu.
      return {
        url: null, label: null, how: null,
        why: `The only menu link on their site goes to another branch (${new URL(found.url).pathname.slice(0, 48)}), not the one in ${locality ?? 'this town'}.`,
        checkedAt: at(),
      };
    }

    // A group's front page: pick this restaurant, then look again.
    const branch = page.html ? branchLink(page.html, page.url, words) : null;
    if (branch) {
      // The link may land on a page of its own — Sebastian's Windsor button
      // goes to an old notice — so their front door is worth a look too: that
      // is where the navigation, and the word Menu, lives.
      const tries = [branch.url];
      try {
        const root = new URL('/', branch.url).toString();
        if (root !== branch.url) tries.push(root);
      } catch { /* the branch link stands alone */ }
      for (const candidate of tries) {
        try {
          const inner = await get(candidate);
          if (!inner.ok || !inner.html) continue;
          if (/\/menus?\b/i.test(inner.url)) return { url: inner.url, label: 'Menu', how: `Chose “${branch.label}”, which is the menu.`, checkedAt: at() };
          const there = bestLink(inner.html, inner.url);
          if (there) return { url: there.url, label: there.label, how: `Chose “${branch.label}”, then followed “${there.label}”.`, checkedAt: at() };
        } catch { /* try the next one */ }
      }
    }

    // Nothing on the page — try the addresses a restaurant usually uses. Their
    // own site, three requests, still free.
    for (const guess of GUESSES) {
      let candidate;
      try { candidate = new URL(guess, page.url).toString(); } catch { continue; }
      try {
        const probe = await get(candidate, { method: 'HEAD' });
        // A site with no menu page often redirects /menu back to its front
        // page and answers 200; that is a no, not a menu.
        if (probe.ok && /\/menus?\b|\/food\b|\/order\b|\/our-menu\b/i.test(new URL(probe.url).pathname)) {
          return { url: probe.url, label: 'Menu', how: `Nothing linked on their site; ${guess} answers.`, checkedAt: at() };
        }
      } catch { /* try the next one */ }
    }
    return { url: null, label: null, how: null, why: `Nothing on ${new URL(page.url).hostname} says menu — it may be a picture, or on their booking page.`, checkedAt: at() };
  })();

  inflight.set(key, run);
  run.then((value) => cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS })).catch(() => {}).finally(() => inflight.delete(key));
  return { ...(await run), cached: false };
}

/**
 * The menus a menu page lists, when the page is an index rather than a menu.
 *
 * "Select a menu to view" is a page with no dishes on it and four links that
 * each have plenty — Sebastian's Windsor is exactly this, which is why a read
 * of the page we correctly found still came back with nothing (5 Sep 2026).
 * It is the same click-through the owner opened this whole thread with, one
 * level further in.
 *
 * Returns the child menus, best first: a PDF or a page whose link says Lunch,
 * Dinner, À la carte, Drinks. Never the page it was given, and never something
 * off-site that merely says menu.
 */
const NOT_A_MENU_HOST = /(^|\.)(facebook|instagram|twitter|x|tiktok|youtube|linkedin|pinterest|google|goo\.gl|maps\.app|tripadvisor|yelp|wordpress|wix|squarespace|godaddy|cookiebot|gstatic)\./i;

export async function childMenus(menuUrl, { max = 4, render = true, words = [] } = {}) {
  let page;
  try { page = await get(menuUrl); } catch { return []; }
  if (!page.ok || !page.html) return [];

  let host;
  try { host = new URL(page.url).hostname.replace(/^www\./, ''); } catch { return []; }

  let candidates = links(page.html, page.url);
  // A page whose navigation is built in JavaScript has no anchors to read, and
  // the menus are behind exactly those. Rendering costs a browser, so it is
  // only done when reading the markup found nothing worth following.
  if (render && !candidates.some(({ url, text }) => /\bmenus?\b/i.test(text) || /\/menus?\b/i.test(url))) {
    try {
      const { renderLinks } = await import('./menuRead.js');
      const { links: drawn } = await renderLinks(page.url);
      if (drawn?.length) candidates = drawn;
    } catch { /* no browser here; the markup is all there is */ }
  }

  const named = /\b(lunch|dinner|brunch|breakfast|evening|a la carte|à la carte|carte|tasting|set|sunday|pre[- ]theatre|kids|children|wine|drinks|cocktail|bar|dessert|specials?|takeaway|main|food)\b/i;
  const seen = new Set([page.url.replace(/#.*$/, '')]);
  const out = [];
  for (const { url, text } of candidates) {
    const clean = url.replace(/#.*$/, '');
    if (seen.has(clean)) continue;
    let u;
    try { u = new URL(clean); } catch { continue; }
    // Somewhere else entirely is usually noise, but not always: a small
    // restaurant's menu often lives on the ordering portal its web company
    // runs, and Sebastian's is one of those. So another host is allowed and
    // ranked below their own, and the places that are never a menu are named.
    const elsewhere = u.hostname.replace(/^www\./, '') !== host;
    if (elsewhere && NOT_A_MENU_HOST.test(u.hostname)) continue;
    const isPdf = /\.pdf($|\?)/i.test(clean);
    const looksMenu = /\/menus?\b|\/menus?\//i.test(u.pathname) || /\bmenus?\b/i.test(text);
    if (!isPdf && !looksMenu) continue;
    // An index links to its own children; it also links back to itself and to
    // the page that sent us here. A child names which menu it is.
    // Which branch this is. A group's menu page asks which restaurant you mean
    // before it will show you anything, and reading Kingston's menu for a
    // Windsor pub is worse than reading none (Megan's, 5 Sep 2026).
    // Every Megan's link matches "megans", so a yes/no on the venue's words puts
    // all thirteen branches level and picks one at random. Count how many of the
    // words hit instead: "megans-by-the-crown" matches two, the rest match one.
    const hay = `${text} ${u.pathname}`.toLowerCase();
    const branch = words.filter((w) => hay.includes(w)).length * 3;
    // Food before drink when we can only afford a few.
    const drinkOnly = /\b(drinks?|wine|cocktail|beer|bar)\b/i.test(text) && !/\bfood\b/i.test(text) ? 1 : 0;
    // A page underneath the one we are standing on is a child of it, whatever
    // it is called. Megan's Windsor is /menus/megans-by-the-crown/ — no town in
    // it, no menu word beyond the section it sits in, and it scored exactly on
    // the threshold and was dropped (5 Sep 2026).
    let child = 0;
    try {
      const here = new URL(page.url).pathname.replace(/\/+$/, '');
      child = !elsewhere && here && u.pathname.startsWith(`${here}/`) ? 1 : 0;
    } catch { /* not a path we can compare */ }
    const n = (isPdf ? 3 : 0) + (named.test(text) ? 2 : 0) + (named.test(u.pathname) ? 1 : 0)
      + (looksMenu ? 1 : 0) + branch + child - (elsewhere ? 1 : 0) - drinkOnly;
    if (n <= 1) continue;
    seen.add(clean);
    out.push({ url: clean, label: text.slice(0, 60), n });
  }
  return out.sort((a, b) => b.n - a.n).slice(0, max);
}

/* -------------------------------------------------------------- the site index */

/**
 * Every page a site admits to having, from its sitemap.
 *
 * Owner, 5 Sep 2026: "you should be able to check the site index, see if
 * there's a menu, go to the menu page if there is a menu… check whether you
 * need to search by location, because for a lot of chains you have to select
 * the venue."
 *
 * This is the step that was missing, and it is the cheapest one available: a
 * site publishes a list of its own URLs so that search engines can find them,
 * and everything the crawler was guessing at is simply written down in it.
 * Megan's has a `location-sitemap.xml` naming all thirteen branches; The Alma's
 * lists its menu page directly. Two requests, no rendering, no model.
 *
 * Where the address is: robots.txt names it, and where robots is silent the two
 * conventional filenames are tried.
 */
export async function siteIndex(website, { maxSitemaps = 5, maxUrls = 3000 } = {}) {
  let origin;
  try { origin = new URL(website).origin; } catch { return []; }

  const roots = [];
  try {
    const robots = await get(new URL('/robots.txt', origin).toString());
    if (robots.ok) {
      // `get` only returns a body for HTML; robots is text, so ask plainly.
      const res = await fetch(new URL('/robots.txt', origin).toString(), {
        redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': UA },
      });
      if (res.ok) {
        const text = (await res.text()).slice(0, 100_000);
        for (const [, loc] of text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.push(loc.trim());
      }
    }
  } catch { /* robots is a convenience, not a requirement */ }
  if (!roots.length) roots.push(new URL('/sitemap_index.xml', origin).toString(), new URL('/sitemap.xml', origin).toString());

  const xml = async (url) => {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': UA, accept: 'application/xml,text/xml' } });
      if (!res.ok) return '';
      const type = res.headers.get('content-type') || '';
      if (!/xml/i.test(type)) return '';
      return (await res.text()).slice(0, 4_000_000);
    } catch { return ''; }
  };

  const urls = new Set();
  const queue = [...roots];
  let fetched = 0;
  while (queue.length && fetched < maxSitemaps && urls.size < maxUrls) {
    const next = queue.shift();
    const body = await xml(next);
    if (!body) continue;
    fetched += 1;
    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    // A sitemap index points at more sitemaps. Follow the ones that could hold
    // a menu or a branch and ignore the pictures and the blog.
    if (/<sitemapindex/i.test(body)) {
      for (const loc of locs) {
        if (/image|video|author|category|tag|post-sitemap/i.test(loc)) continue;
        queue.push(loc);
      }
      continue;
    }
    for (const loc of locs) urls.add(loc);
  }
  return [...urls];
}

/**
 * The menu pages in a site's own index, best first.
 *
 * `words` are the ones that say which branch this is — the venue's name and
 * where it is — because a group's index lists every restaurant it owns and
 * only one of them is the one we are standing outside.
 */
export function menusInIndex(urls, words = []) {
  const out = [];
  for (const url of urls) {
    let u;
    try { u = new URL(url); } catch { continue; }
    const path = u.pathname.toLowerCase();
    const isPdf = /\.pdf$/.test(path);
    const menuish = /\/menus?\b|\/menus?\/|\/food\b|\/eat\b|\/drinks?\b|\/a-la-carte\b|\/order\b|\/ordering\b|\/takeaway\b/.test(path) || (isPdf && /menu/.test(path));
    if (!menuish) continue;
    if (/gift|voucher|news|blog|job|career|privacy|terms|cookie/.test(path)) continue;
    const branch = words.filter((w) => path.includes(w)).length * 3;
    const depth = path.replace(/\/$/, '').split('/').filter(Boolean).length;
    // A deeper page under /menus/ is the specific menu; /menus/ itself is the
    // chooser. Prefer the specific one when the branch words point at it.
    const n = (isPdf ? 2 : 0) + branch + (depth >= 2 ? 1 : 0) + 1;
    out.push({ url: u.toString(), label: decodeURIComponent(path.split('/').filter(Boolean).pop() ?? 'Menu').replace(/[-_]/g, ' ').slice(0, 60), n });
  }
  return out.sort((a, b) => b.n - a.n);
}

/**
 * Is this address plausibly *this* branch's menu?
 *
 * Intoku's site has one Delivery link and it goes to
 * order.store/gb/store/intoku-reading — the Reading branch, for a restaurant in
 * Windsor (found 5 Sep 2026). Storing that would be worse than storing nothing:
 * a household would open the menu, order from it, and turn up to a different
 * town's prices and dishes.
 *
 * So an address on somebody else's host has to earn it. Either it names this
 * branch — the town, or a word from the venue's own name — or it names no
 * branch at all, which is the ordinary case for a single-site restaurant. What
 * it may not do is name a different one.
 */
export function branchLooksWrong(url, words = [], locality = null) {
  let path;
  try { path = `${new URL(url).pathname}`.toLowerCase(); } catch { return false; }
  const town = String(locality ?? '').toLowerCase().match(/[a-z]{4,}/g)?.[0] ?? null;
  if (!town) return false;                      // nothing to contradict
  if (path.includes(town)) return false;        // it names our town: right branch

  // The brand's own name is not the reassurance it looks like. "intoku-reading"
  // contains "intoku", and letting that settle it is exactly how a Windsor
  // household ends up with Reading's menu. So the segment that carries the
  // brand is read for what follows it, and a different town there is decisive.
  const segments = path.split('/').filter(Boolean);
  for (const segment of segments) {
    const brand = words.find((w) => segment.includes(w));
    if (!brand) continue;
    const rest = segment.split(brand).join(' ').split(/[^a-z]+/).filter((x) => x.length >= 4);
    // Words a branch slug uses that are not places.
    const notPlaces = new Set(['restaurant', 'restaurants', 'group', 'store', 'menu', 'menus', 'online', 'order', 'takeaway', 'delivery']);
    const other = rest.find((x) => !notPlaces.has(x) && !words.includes(x));
    if (other && other !== town) return true;
  }
  return false;
}

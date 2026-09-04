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
const GUESSES = ['/menu', '/menus', '/food'];

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
  if (/\/menus?\b|\/menus?$|[?&]menu|\bmenu-|carte|speisekarte/.test(h)) n += 3;
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
  const words = [...new Set(`${locality ?? ''} ${address ?? ''}`.toLowerCase().match(/[a-z]{4,}/g) ?? [])]
    .filter((w) => !['road', 'street', 'lane', 'unit', 'high', 'avenue', 'close', 'place', 'square', 'united', 'kingdom'].includes(w));
  const key = `${site}|${words.join(',')}`;

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cached: true };
  if (inflight.has(key)) return { ...(await inflight.get(key)), cached: true };

  const run = (async () => {
    const at = () => new Date().toISOString();
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
    if (found) return { url: found.url, label: found.label, how: `Followed “${found.label}” on ${new URL(page.url).hostname}.`, checkedAt: at() };

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
        if (probe.ok && /\/menus?\b|\/food\b/i.test(new URL(probe.url).pathname)) {
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

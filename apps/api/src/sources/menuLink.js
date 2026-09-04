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

const FETCH_TIMEOUT_MS = 5000;
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

function bestLink(html, baseUrl) {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi)];
  let best = null;
  for (const [, attrs, inner] of anchors) {
    const href = (attrs.match(/\bhref\s*=\s*"([^"]*)"/i) || attrs.match(/\bhref\s*=\s*'([^']*)'/i) || [])[1];
    if (!href) continue;
    const text = clean(inner) || clean((attrs.match(/\baria-label\s*=\s*"([^"]*)"/i) || [])[1]);
    if (!text) continue;
    let absolute;
    try { absolute = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(absolute)) continue;
    const n = score(href, text);
    if (n <= 0) continue;
    if (!best || n > best.n || (n === best.n && text.length < best.label.length)) best = { n, url: absolute, label: text.slice(0, 60) };
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
export async function findMenuUrl({ website, name = '' } = {}) {
  const site = String(website ?? '').trim();
  if (!/^https?:\/\//i.test(site)) return { url: null, label: null, how: null, why: 'No website for this place, so there is nothing to follow.', checkedAt: new Date().toISOString() };

  const hit = cache.get(site);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cached: true };
  if (inflight.has(site)) return { ...(await inflight.get(site)), cached: true };

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

  inflight.set(site, run);
  run.then((value) => cache.set(site, { value, expires: Date.now() + CACHE_TTL_MS })).catch(() => {}).finally(() => inflight.delete(site));
  return { ...(await run), cached: false };
}

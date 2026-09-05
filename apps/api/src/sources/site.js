// What a place says about itself, on its own page.
//
// This is the best-licensed source there is and nobody sells it: the venue
// publishes it, for machines, on purpose. Most restaurants and attractions
// carry a schema.org JSON-LD block — the same one that puts their hours and
// address into a Google result — and that block has the telephone number, the
// street address, the opening hours, the cuisine, the price band and often the
// menu URL. Reading it is one request to their own public page, so like the
// menu lookup (sources/menuLink.js) it is free and is not a provider call.
//
// What is taken is facts a business publishes to be republished: how to reach
// them, where they are, when they open, how to book. Their prose is not taken,
// with the single exception of the meta description, which exists solely to be
// quoted by other people's software and is stored with their own URL beside it.
//
// Same manners as the menu lookup: identify ourselves, one page, five seconds,
// one megabyte, and never follow the site into a crawl.

import { findMenuUrl } from './menuLink.js';

const TIMEOUT_MS = 6000;
const MAX_BYTES = 1_500_000;
const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; household place record)';

const BOOKING_HOSTS = /opentable|resdiary|sevenrooms|bookatable|quandoo|thefork|exploretock|tock\.|resy\.|dishcult|collinsbookings|designmynight|eveve|tablepath|now-book-it|obee|guestline|toasttab|booking\.resos/i;
const SOCIAL = {
  instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^"'\s?#]+/i,
  facebook: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/[^"'\s?#]+/i,
  x: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/[^"'\s?#]+/i,
  tiktok: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[^"'\s?#]+/i,
};

const text = (v) => (typeof v === 'string' ? v.trim() : null);

/** Every JSON-LD object on the page, including the ones nested in @graph. */
function jsonLd(html) {
  const out = [];
  for (const [, block] of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    // Sites emit trailing commas and stray HTML comments in these blocks often
    // enough that one bad block must not lose the others.
    try { parsed = JSON.parse(block.replace(/<!--[\s\S]*?-->/g, '').trim()); } catch { continue; }
    const push = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(push); return; }
      out.push(node);
      if (node['@graph']) push(node['@graph']);
    };
    push(parsed);
  }
  return out;
}

const BUSINESS = /Restaurant|LocalBusiness|FoodEstablishment|CafeOrCoffeeShop|BarOrPub|Museum|TouristAttraction|Hotel|LodgingBusiness|Place|Organization|EntertainmentBusiness|AmusementPark|Zoo|Aquarium|ArtGallery|Winery|Brewery/i;

/** The business node, if the page has one — the most specific type wins over a bare Organization. */
function business(nodes) {
  const typed = nodes.filter((n) => {
    const t = [].concat(n['@type'] ?? []).join(' ');
    return BUSINESS.test(t);
  });
  if (!typed.length) return null;
  const generic = (n) => /^(Place|Organization)$/i.test([].concat(n['@type'] ?? [])[0] ?? '');
  return typed.find((n) => !generic(n)) ?? typed[0];
}

/** schema.org openingHours in any of its three shapes, as one line. */
function hoursFrom(node) {
  const spec = node.openingHoursSpecification;
  if (Array.isArray(spec) && spec.length) {
    const parts = spec.map((s) => {
      const days = [].concat(s.dayOfWeek ?? []).map((d) => String(d).split('/').pop().slice(0, 3)).join(', ');
      if (!days) return null;
      return s.opens && s.closes ? `${days} ${s.opens}–${s.closes}` : `${days} closed`;
    }).filter(Boolean);
    if (parts.length) return parts.join(' · ');
  }
  const plain = [].concat(node.openingHours ?? []).filter((h) => typeof h === 'string');
  return plain.length ? plain.join(' · ') : null;
}

function addressFrom(node) {
  const a = node.address;
  if (typeof a === 'string') return { address: a.trim(), postcode: null };
  if (!a || typeof a !== 'object') return { address: null, postcode: null };
  const line = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].map(text).filter(Boolean).join(', ');
  return { address: line || null, postcode: text(a.postalCode) };
}

/**
 * A telephone number a place prints on its page but does not mark up.
 *
 * Plenty of small restaurants publish no schema.org block and no `tel:` link —
 * the number is simply typed into the footer. It is a fact they publish in
 * order to be rung, so it is worth reading, but only when we can be reasonably
 * sure it is a phone number and not a date, a price or a company number. So:
 * it has to look like one, and it has to sit near a word that introduces one.
 */
export function printedPhone(html) {
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/gi, ' ').replace(/\s+/g, ' ');
  // +44 20 7946 0958 · 020 7946 0958 · 01225 460705 — nine to eleven digits,
  // in the groupings people actually write.
  const pattern = /(?:\+\d{1,3}[\s(]?)?(?:\(?0\)?[\s-]?)?\d[\d\s().-]{8,16}\d/g;
  for (const m of flat.matchAll(pattern)) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) continue;
    // A year, a price, a VAT number or a run of dates is not a phone number.
    if (/^\d{4}\s?[-–]\s?\d{4}$/.test(raw)) continue;
    const before = flat.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    if (!/(tel|phone|call|reservations?|bookings?|contact|enquir)/.test(before)) continue;
    return raw.replace(/[().]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return null;
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok) return null;
    if (!/text\/html|xhtml/i.test(res.headers.get('content-type') || '')) return null;
    return { url: res.url || url, html: (await res.text()).slice(0, MAX_BYTES) };
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// what it costs to walk in
// ---------------------------------------------------------------------------

// Who a ticket is for, and every word a UK attraction actually prints for them.
// Ordered longest-first inside each group so "adult" does not match first in
// "adult carer" and mislabel a concession as the full price.
const TICKETS = [
  ['adult', /\b(?:adults?(?:\s*\(\s*1[6-8]\+?\s*\))?|grown[- ]ups?)\b/i],
  ['child', /\b(?:child(?:ren)?|kids?|juniors?|under[- ]?1[0-8]s?)\b/i],
  ['family', /\bfamily(?:\s*(?:ticket|of\s*\d))?\b/i],
  ['concession', /\b(?:concessions?|seniors?|students?|over[- ]?60s?|65\+)\b/i],
];

// £14, £14.50, £14 per adult. Not "£14m", not a year, not a phone number.
const MONEY = /£\s?\d{1,3}(?:\.\d{2})?(?!\d|\s?(?:m\b|bn\b|k\b|million|billion))/;
const FREE = /\b(?:free\s+(?:admission|entry|entrance|to\s+enter|of\s+charge)|admission\s+(?:is\s+)?free|entry\s+(?:is\s+)?free|no\s+admission\s+charge)\b/gi;

// What turns "free entry" into somebody else's free entry. English Heritage's
// Dover Castle page says "FREE ENTRY FOR UP TO SIX CHILDREN … accompanied by an
// adult member", and read without this the atlas told a family that a £26 day
// out cost nothing. A price that is confidently wrong is worse than no price,
// so a free claim counts only when nothing qualifies it.
const QUALIFIED = /\b(?:members?|membership|subscriber|annual pass|children|child|under[- ]?\d|accompanied|carers?|when you|if you|with (?:a|an|any|your)|for (?:up to|the first)|residents?|students?|locals?|nhs|blue light)\b/i;

const flatten = (html) => String(html)
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;?/gi, ' ').replace(/&amp;/gi, '&').replace(/&pound;/gi, '£')
  .replace(/\s+/g, ' ');

/**
 * What a place charges to get in, from the page it publishes to be read.
 *
 * The one fact about an attraction that nobody gives away and everybody needs.
 * Wikidata does not carry it, OpenStreetMap carries only whether there is a fee
 * at all, and a licensed provider's copy would be theirs and not ours. The
 * venue's own ticket page is the source that is both authoritative and free to
 * use, for the same reason as the rest of this module: they publish it in order
 * to be read.
 *
 * Two ways, in order of how much they can be trusted:
 *
 *   1. The `offers` block, where a site has one. Marked up by the site itself
 *      for exactly this purpose, so the number and what it is for are already
 *      separated and there is nothing to infer.
 *   2. The printed price, read the way `printedPhone` reads a phone number: the
 *      shape has to be right *and* it has to sit next to a word that says what
 *      it is. A bare £14 on a page is as likely to be a gift shop mug.
 *
 * The prices are kept as they are written, not parsed to numbers. "£14.00
 * online, £16.50 on the day" is the true answer to what it costs, and rounding
 * that to 14 would put a price on the screen that nobody charges.
 *
 * Never guesses. Everything null and `free` null means the page did not say,
 * which is a different and more useful answer than a wrong £14.
 */
export function admissionFrom(html, node = {}) {
  const found = { free: null, adult: null, child: null, family: null, concession: null, note: null };

  // 1. What they marked up.
  if (node.isAccessibleForFree === true || node.isAccessibleForFree === 'true') found.free = true;
  for (const offer of [].concat(node.offers ?? []).flatMap((o) => [].concat(o?.offers ?? o))) {
    if (!offer || typeof offer !== 'object') continue;
    const price = offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price;
    if (price == null || price === '') continue;
    const currency = offer.priceCurrency ?? offer.priceSpecification?.priceCurrency ?? 'GBP';
    const shown = currency === 'GBP' ? `£${price}` : `${price} ${currency}`;
    if (Number(price) === 0) { found.free = true; continue; }
    const label = String(offer.name ?? offer.category ?? '');
    const slot = TICKETS.find(([, re]) => re.test(label))?.[0] ?? 'adult';
    found[slot] ??= shown;
  }

  const flat = flatten(html);

  // 2. What they printed. Either side of the word, because sites write it both
  // ways round — "Adults £32.00" and "£14.50 per adult" — and the nearer of the
  // two wins, so a list does not hand each label its neighbour's price.
  //
  // What may sit between a label and its price is the whole test. Only glue:
  // punctuation, and the handful of words that join a thing to its cost. An
  // "and" or a comma is not glue, it is the start of the next ticket, which is
  // the difference between reading "£14.50 per adult and £7.25 per child" right
  // and giving the grown-ups the child's price.
  // The bracketed aside is allowed because half of them write the age range
  // there — "Children (4-15) £24.00" — and refusing it loses the child price on
  // exactly the sites that were clearest about who it was for.
  const GLUE = /^[\s:.\u2013\u2014-]*(?:\([^)]{0,24}\))?[\s:.\u2013\u2014-]*(?:(?:from|only|just|each|per|price[sd]?|ticket[s]?|entry|admission|is|are|at|costs?|of|=)[\s:.\u2013\u2014-]*)*$/i;
  for (const [slot, re] of TICKETS) {
    if (found[slot]) continue;
    let best = null;
    for (const m of flat.matchAll(new RegExp(re.source, 'gi'))) {
      const end = m.index + m[0].length;
      const after = flat.slice(end, end + 40).match(MONEY);
      if (after && GLUE.test(flat.slice(end, end + after.index))) {
        best = { gap: after.index, price: after[0] };
      }
      const window = flat.slice(Math.max(0, m.index - 40), m.index);
      for (const b of window.matchAll(new RegExp(MONEY.source, 'gi'))) {
        const gap = window.length - (b.index + b[0].length);
        if (!GLUE.test(window.slice(b.index + b[0].length))) continue;
        if (!best || gap < best.gap) best = { gap, price: b[0] };
      }
      if (best) break;
    }
    if (best) found[slot] = best.price.replace(/\s/g, '');
  }

  if (found.free === null && !found.adult) {
    for (const m of flat.matchAll(FREE)) {
      if (!QUALIFIED.test(flat.slice(m.index + m[0].length, m.index + m[0].length + 80))) { found.free = true; break; }
    }
  }
  // A place that charges is not free, whatever a "free parking" line elsewhere
  // on the page said.
  if (found.adult) found.free = false;

  const said = Object.entries(found).filter(([, v]) => v !== null && v !== false);
  if (!said.length) return null;
  return { ...found, currency: 'GBP' };
}

/**
 * Read one venue's own page.
 *
 * Returns `{ phone, email, address, postcode, openingHours, cuisines,
 * priceRange, bookingUrl, socials, summary, menu, how }` — every field null
 * when the page does not say. Never throws: a site that is down simply gives us
 * nothing this time, and the record stays as it was.
 */
export async function siteFacts({ website, name = '', category = null, locality = null, knownAddress = null } = {}) {
  const url = String(website ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;

  const [page, menu] = await Promise.all([
    fetchPage(url),
    // The menu lookup already knows how to follow their site; for somewhere you
    // eat it runs beside this read rather than after it.
    ['restaurant', 'cafe', 'bar', 'pub'].includes(category) ? findMenuUrl({ website: url, name, locality, address: knownAddress }).catch(() => null) : Promise.resolve(null),
  ]);
  if (!page) return menu?.url ? { menu, how: 'Their site did not answer, but the menu lookup found a page.' } : null;

  const { html } = page;
  const node = business(jsonLd(html)) ?? {};
  const { address, postcode } = addressFrom(node);

  const links = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const socials = {};
  for (const [key, re] of Object.entries(SOCIAL)) {
    const hit = links.find((h) => re.test(h));
    if (hit) { try { socials[key] = new URL(hit, page.url).toString().split('?')[0]; } catch { /* skip */ } }
  }
  const booking = links.find((h) => BOOKING_HOSTS.test(h));
  const linked = (scheme) => {
    const hit = links.find((h) => scheme.test(h));
    return hit ? hit.replace(scheme, '').split('?')[0].trim() || null : null;
  };
  const tel = text(node.telephone) ?? linked(/^tel:/i) ?? printedPhone(html);
  const mail = text(node.email) ?? linked(/^mailto:/i);

  // The one piece of their prose that is written to be quoted elsewhere.
  const meta = (html.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']{20,400})["']/i)
    || html.match(/<meta[^>]+property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']{20,400})["']/i) || [])[1] ?? null;

  const cuisines = [].concat(node.servesCuisine ?? []).map((c) => String(c).toLowerCase().trim()).filter(Boolean);

  return {
    phone: tel,
    email: mail && /@/.test(mail) ? mail : null,
    address,
    postcode,
    openingHours: hoursFrom(node),
    cuisines,
    priceRange: text(node.priceRange),
    admission: admissionFrom(html, node),
    bookingUrl: booking ? (() => { try { return new URL(booking, page.url).toString(); } catch { return null; } })() : null,
    socials,
    summary: meta ? meta.replace(/\s+/g, ' ').trim() : null,
    menu: menu ?? null,
    sourceUrl: page.url,
    how: node['@type'] ? `Read the ${[].concat(node['@type'])[0]} details they publish on ${new URL(page.url).hostname}.` : `Read ${new URL(page.url).hostname}.`,
  };
}

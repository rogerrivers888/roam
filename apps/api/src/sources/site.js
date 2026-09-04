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

/**
 * Read one venue's own page.
 *
 * Returns `{ phone, email, address, postcode, openingHours, cuisines,
 * priceRange, bookingUrl, socials, summary, menu, how }` — every field null
 * when the page does not say. Never throws: a site that is down simply gives us
 * nothing this time, and the record stays as it was.
 */
export async function siteFacts({ website, name = '', category = null } = {}) {
  const url = String(website ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;

  const [page, menu] = await Promise.all([
    fetchPage(url),
    // The menu lookup already knows how to follow their site; for somewhere you
    // eat it runs beside this read rather than after it.
    ['restaurant', 'cafe', 'bar', 'pub'].includes(category) ? findMenuUrl({ website: url, name }).catch(() => null) : Promise.resolve(null),
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
  const tel = text(node.telephone) ?? linked(/^tel:/i);
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
    bookingUrl: booking ? (() => { try { return new URL(booking, page.url).toString(); } catch { return null; } })() : null,
    socials,
    summary: meta ? meta.replace(/\s+/g, ' ').trim() : null,
    menu: menu ?? null,
    sourceUrl: page.url,
    how: node['@type'] ? `Read the ${[].concat(node['@type'])[0]} details they publish on ${new URL(page.url).hostname}.` : `Read ${new URL(page.url).hostname}.`,
  };
}

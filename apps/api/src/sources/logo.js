// A business's own mark.
//
// The single most useful picture on a restaurant card is not a photograph of
// the food. It is the thing on the sign, because that is what the household is
// looking for when they get to the street — and for a chain it is recognised
// instantly at 56px, which no photograph of a burger ever is.
//
// This is a different legal footing from everything else in the library and it
// is worth being exact about it, because the difference is the whole reason
// this file is allowed to exist.
//
//   * A photograph of a dish is copyright. It belongs to the restaurant or, far
//     more often, to the agency that shot it, and publishing it on their own
//     site licenses nobody. We do not take those. (Owner, 5 Sep 2026 — the
//     question that started this.)
//   * A logo is a trade mark. Using a mark to identify the business it belongs
//     to is referential use: it is what Google Maps, Tripadvisor, Deliveroo and
//     every other listing on earth does, and it is the opposite of the harm
//     trade mark law exists to prevent, which is pretending to be them.
//
// Two consequences run through the code below. We take the icon a site
// publishes *for other people's software to draw* — the apple-touch-icon, the
// favicon, the schema.org Organization.logo — and not an image from their
// gallery that happens to have "logo" in the file name; the first is offered,
// the second is theirs. And we store the basis in words on the row rather than
// inventing a licence, so anybody looking at the library can see this was a
// judgement and reverse it. Deleting `where source = 'logo'` undoes it whole.
//
// One page, one fetch, eight seconds, and we never follow a site into a crawl.

import { fetchHtml, fetchPicture } from './pictureBytes.js';

// Below this a mark is a browser tab decoration, not a card image: it will be
// a blurred smear at the size the home screen draws. 64px is the smallest that
// survives a 56px tile on a 2× screen.
const MIN_PX = 64;
// A logo is square or nearly so. A 1200×630 sharing card is not a logo, and
// this ratio is what keeps `og:image` out by the back door.
const MAX_RATIO = 1.6;

const abs = (href, base) => {
  const raw = String(href ?? '').trim();
  // Sites ship `href="#"` and `href="data:,"` placeholders where a designer
  // meant to put an icon and never did. Resolved against the page they become
  // the page's own URL, which then fetches HTML and is thrown away by the
  // sniff — correct, but a wasted request on every venue on that platform.
  if (!raw || raw === '#' || raw.startsWith('#') || /^(javascript|data|about):/i.test(raw)) return null;
  try { return new URL(raw, base).toString(); } catch { return null; }
};

/** The site's own root, for the conventional paths and for a dead deep link. */
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/** Every `<link rel=…>` on the page, as `{ rel, href, sizes, type }`. */
function links(html, base) {
  const out = [];
  for (const [, tag] of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attr = (n) => (tag.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, 'i')) || [])[1] ?? null;
    const href = attr('href');
    if (!href) continue;
    out.push({ rel: (attr('rel') || '').toLowerCase(), href: abs(href, base), sizes: attr('sizes'), type: (attr('type') || '').toLowerCase() });
  }
  return out.filter((l) => l.href);
}

/** The largest square edge a `sizes="32x32 180x180"` attribute claims. */
function claimedPx(sizes) {
  if (!sizes) return null;
  const found = [...String(sizes).matchAll(/(\d+)x(\d+)/gi)].map(([, w]) => Number(w));
  return found.length ? Math.max(...found) : null;
}

/**
 * What a schema.org block says its logo is.
 *
 * This is the best of the three: it is not an icon that happens to be the mark,
 * it is the business stating "this is our logo" in a block written to be read
 * by other people's software. `sources/site.js` already reads these blocks for
 * hours and phone numbers; this pulls the one field it does not need.
 */
function fromJsonLd(html, base) {
  const out = [];
  for (const [, block] of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;
    try { parsed = JSON.parse(block.replace(/<!--[\s\S]*?-->/g, '').trim()); } catch { continue; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const logo = node.logo;
      const href = typeof logo === 'string' ? logo : logo && typeof logo === 'object' ? logo.url ?? logo.contentUrl : null;
      if (typeof href === 'string') {
        const url = abs(href, base);
        if (url) out.push({ url, why: 'the logo they publish in their schema.org block', rank: 0, claimed: Number(logo?.width) || null });
      }
      if (node['@graph']) walk(node['@graph']);
    };
    walk(parsed);
  }
  return out;
}

/**
 * The icons a site offers, best first.
 *
 * apple-touch-icon before favicon, deliberately: it is specified at 180px, it
 * is the version a site's designer made for a home screen rather than for a
 * 16px tab, and it is almost always the mark on a solid ground — which is
 * exactly the card image we want.
 */
function fromIcons(html, base) {
  const out = [];
  for (const l of links(html, base)) {
    const rel = l.rel;
    // A mask-icon is a monochrome SVG silhouette; `fetchPicture` refuses SVG.
    if (!/\b(apple-touch-icon|apple-touch-icon-precomposed|icon|shortcut icon|fluid-icon)\b/.test(rel)) continue;
    if (/mask-icon/.test(rel)) continue;
    const claimed = claimedPx(l.sizes);
    // "Any" is an SVG's way of saying it scales; it is not a pixel promise.
    if (claimed !== null && claimed < MIN_PX) continue;
    const apple = /apple-touch/.test(rel);
    out.push({
      url: l.href,
      why: apple ? 'the touch icon they publish for a home screen' : 'the site icon they publish',
      // Bigger wins, and an apple-touch-icon wins a tie.
      rank: 1 + (apple ? 0 : 0.5) - Math.min(claimed ?? 0, 512) / 10000,
      claimed,
    });
  }
  return out;
}

/**
 * Find the mark for one venue.
 *
 * Returns `{ url, why, mime, body, bytes, width, height, sitePage }` — the
 * bytes included, because the only way to know a favicon is 16px is to look at
 * it, and having looked there is no sense in fetching it twice. Returns null
 * when the site does not answer, offers nothing, or offers only things too
 * small or too wide to be a mark.
 *
 * Never throws.
 */
export async function findLogo({ website } = {}) {
  const url = String(website ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;

  const page = await fetchHtml(url);
  // A site that will not serve its home page can still be serving the icon at
  // the path every browser tries first, so this is worth one attempt.
  const base = page?.url ?? url;
  const candidates = page
    ? [...fromJsonLd(page.html, base), ...fromIcons(page.html, base)]
    : [{ url: abs('/apple-touch-icon.png', base), why: 'the touch icon at the path browsers try by convention', rank: 2, claimed: null }];
  if (page && !candidates.length) {
    const fallback = abs('/apple-touch-icon.png', base);
    if (fallback) candidates.push({ url: fallback, why: 'the touch icon at the path browsers try by convention', rank: 2, claimed: null });
  }

  const seen = new Set();
  const ordered = candidates.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url)).sort((a, b) => a.rank - b.rank).slice(0, 5);

  for (const c of ordered) {
    const got = await fetchPicture(c.url, { maxBytes: 1_000_000 });
    if (!got) continue;
    // Now that the pixels are known, hold them to the bar the `sizes`
    // attribute only claimed. A site that says 180x180 and serves 16x16 is
    // common enough that trusting the attribute would fill the library with
    // smears.
    if (got.width !== null && got.width < MIN_PX) continue;
    if (got.height !== null && got.height < MIN_PX) continue;
    if (got.width && got.height) {
      const ratio = Math.max(got.width / got.height, got.height / got.width);
      if (ratio > MAX_RATIO) continue;
    }
    return { ...got, why: c.why, sitePage: base };
  }
  return null;
}

/**
 * The words that go on the row.
 *
 * Not a licence, and it says so. `attribution_required` is false because a mark
 * shown to identify its own owner needs no credit line — naming the business is
 * the credit — but `restrictions` carries the thing anybody reading the library
 * needs to know, which is that this is somebody's trade mark and it is here on
 * a narrower footing than the photographs beside it.
 */
export const LOGO_BASIS = {
  licence: 'Trade mark — shown to identify the business',
  licenceUrl: null,
  usageTerms: 'Not a copyright licence. The mark belongs to the business and is drawn only on that business’s own card, to identify it.',
  restrictions: 'Trade mark of the business. Referential use only: never on another place, never as Roam’s own mark, never altered.',
  attributionRequired: false,
};

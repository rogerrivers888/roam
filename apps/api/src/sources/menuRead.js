// Reading a menu into dishes you can tap (owner, 4 Sep 2026: "are you just
// saying that you need to build something to be able to read the PDFs and the
// JavaScript thing? If so, can you please do that?").
//
// `menuLink.js` finds *where* the menu is. This reads *what is on it* into
// sections and items with prices, so the household can tick who wants what.
// A menu comes in one of four states and each needs a different opener:
//
//   1. An HTML page. Strip the tags and the text is there. Free.
//   2. A PDF. The bytes are a page description, not words: pdfjs walks the
//      text runs and puts them back in reading order. Free.
//   3. A JavaScript app — the page arrives as an empty shell and draws itself
//      in the browser. There is nothing in the HTML to read, so the page has
//      to be *rendered*: run it in a headless browser, let it fetch its own
//      data, then take the text the browser laid out. Free where a browser
//      binary exists (ROAM_CHROME_PATH, or one of the usual paths).
//   4. Nothing readable at all — a photograph of a blackboard, a menu behind a
//      booking flow. Claude reads it with web search and web fetch. This is
//      the only step that costs money beyond the parse.
//
// Whatever the opener, the text lands in the same place: one Claude call turns
// it into sections and items. That call is the bill, it is attributed to the
// household and session in provider_calls like every other, and it happens
// once per restaurant, not once per look.
//
// Rules this keeps (CLAUDE.md, Requirements §4 and Epic 6, Technical Constraints §13):
//   • The menu is fetched from the restaurant's own public page, and what comes
//     back is held against the household that fetched it — the same standing as
//     a menu they photographed (Requirements §4: "A household's own captured
//     copy is acceptable; a publicly searchable database is not"). Nothing here
//     builds a searchable menu database; that stays gated on the L9 review.
//   • It never says a dish is safe. Allergens are quoted as the menu prints
//     them, and an allergen outside the fourteen a menu must declare can only
//     ever be a prompt to ask.
//   • Prices are recorded as printed, with the date they were printed, so the
//     screen can mark them indicative once they are old (Epic 6 C8).

import { parseStructured } from '../claude.js';
import { searchWeb } from '../claude.js';
import { z } from 'zod/v4';

const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; household menu read)';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 12_000_000;
const RENDER_TIMEOUT_MS = Number(process.env.ROAM_RENDER_TIMEOUT_MS || 25_000);
// Below this much readable text a page is a shell, not a menu.
const THIN_TEXT = 700;
// A page of markup this small has not been drawn for anybody: no menu, and no
// pictures of one either.
const THIN_HTML = 2_000;
// One Claude call reads this much and answers with rather more than it read:
// a chunk of menu text becomes JSON with a line per dish, so the piece has to
// be small enough that the answer fits in one reply.
const CHUNK_CHARS = 9_000;
const MAX_CHUNKS = 8;
const MAX_ANSWER_TOKENS = 16_000;
// Menus are read by the model the owner is paying for; a menu is mechanical
// extraction, not reasoning, so the default is the cheaper current-generation
// model. ROAM_MENU_MODEL moves it without a deploy.
const MODEL = process.env.ROAM_MENU_MODEL || 'claude-sonnet-5';

/* ------------------------------------------------------------------ fetching */

/**
 * An ordinary browser's user agent, for the one case it is warranted.
 *
 * Roam identifies itself everywhere by default, and that is the right thing:
 * a restaurant's host should be able to see who asked. But a great many small
 * sites sit behind an IIS or Cloudflare rule that refuses anything not shaped
 * like a browser — switched on by their host, never thought about by them.
 * Boleros Pizzeria answers 403 to RoamBot and 200 to Chrome, and its
 * robots.txt is itself a 403, so there is no stated policy to respect
 * (owner approved, 5 Sep 2026).
 */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Does their robots.txt forbid this path?
 *
 * An explicit Disallow is a decision and is respected. A robots that cannot be
 * read — because the same blanket rule refuses us that page too — is not a
 * decision, and is treated as silence.
 */
async function robotsForbids(url) {
  let target;
  try { target = new URL(url); } catch { return false; }
  try {
    const res = await fetch(new URL('/robots.txt', target.origin).toString(), {
      redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': UA },
    });
    if (!res.ok) return false;
    const text = (await res.text()).slice(0, 100_000);
    // Only the rules addressed to everybody, or to us by name.
    const blocks = text.split(/^user-agent:/gim).slice(1);
    for (const block of blocks) {
      const who = block.split(/\r?\n/)[0].trim().toLowerCase();
      if (who !== '*' && !who.includes('roam')) continue;
      for (const [, path] of block.matchAll(/^\s*disallow:\s*(\S+)/gim)) {
        if (path === '/') return true;
        if (path && target.pathname.startsWith(path)) return true;
      }
    }
    return false;
  } catch { return false; }
}

async function grab(url, { as = UA } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': as, accept: 'text/html,application/xhtml+xml,application/pdf,*/*' },
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      // Refused for being a robot rather than for asking for this page. Try
      // once as an ordinary browser, and only where robots does not object.
      if ((res.status === 403 || res.status === 406 || res.status === 429) && as === UA && !(await robotsForbids(url))) {
        return grab(url, { as: BROWSER_UA });
      }
      return { ok: false, url: res.url || url, type, status: res.status };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    // Answered, and with nothing in it. Some sites do not refuse a robot, they
    // just serve it an empty shell: thesunningdale.co.uk gave us fifty-one
    // characters and gives a browser a hundred and forty kilobytes with five
    // photographs of the menu in it (found 6 Sep 2026). One more request, and
    // only where robots does not object.
    if (as === UA && /html/i.test(type) && buffer.length < THIN_HTML && !(await robotsForbids(url))) {
      const again = await grab(url, { as: BROWSER_UA });
      if (again.ok && (again.buffer?.length ?? 0) > buffer.length) return again;
    }
    return { ok: true, url: res.url || url, type, buffer: buffer.subarray(0, MAX_BYTES), as };
  } finally {
    clearTimeout(timer);
  }
}

const looksPdf = (res) => /application\/pdf/.test(res.type) || res.buffer?.subarray(0, 5).toString('latin1') === '%PDF-';

/* ------------------------------------------------------------- text openers */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–' };
const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);

/** The words a reader would see, with the line breaks that make a menu a menu. */
export function visibleText(html) {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|td|dt|dd)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(body)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** A page that draws itself often still ships its data as JSON in the shell. */
export function embeddedJson(html) {
  const blocks = [];
  for (const [, block] of html.matchAll(/<script[^>]+type\s*=\s*["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) blocks.push(block);
  for (const [, block] of html.matchAll(/<script[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)) blocks.push(block);
  for (const [, block] of html.matchAll(/window\.__(?:NUXT|INITIAL_STATE|APOLLO_STATE)__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/gi)) blocks.push(block);
  const useful = blocks
    .map((b) => b.trim())
    .filter((b) => b.length > 400 && /\d+(?:[.,]\d{2})?/.test(b) && /(price|menu|item|dish|product|section|course)/i.test(b));
  return useful.length ? useful.join('\n').slice(0, CHUNK_CHARS * MAX_CHUNKS) : null;
}

/** The text runs of a PDF, put back into reading order line by line. */
export async function pdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= Math.min(doc.numPages, 12); n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    // Group runs into lines by their y position: a menu's price sits on the
    // same line as its dish and must not become a line of its own.
    const lines = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 3);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: item.transform[4], s: item.str });
    }
    const text = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, runs]) => runs.sort((a, b) => a.x - b.x).map((r) => r.s).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    pages.push(text);
  }
  await doc.destroy();
  return pages.join('\n\n');
}

/* ------------------------------------------------------------------ rendering */

const CHROME_PATHS = [
  process.env.ROAM_CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/root/.cache/ms-playwright/chromium/chrome-linux/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** The browser this machine has, if it has one. Cached: the answer never changes. */
let browserPath;
export async function chromePath() {
  if (browserPath !== undefined) return browserPath;
  const { access } = await import('node:fs/promises');
  browserPath = null;
  for (const p of CHROME_PATHS) {
    try { await access(p); browserPath = p; break; } catch { /* next */ }
  }
  if (!browserPath) {
    // Playwright installs under a versioned directory; take whichever is newest.
    try {
      const { readdir, access: ac } = await import('node:fs/promises');
      const os = await import('node:os');
      const root = `${os.homedir()}/Library/Caches/ms-playwright`;
      const dirs = (await readdir(root)).filter((d) => d.startsWith('chromium-')).sort().reverse();
      for (const d of dirs) {
        const p = `${root}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
        try { await ac(p); browserPath = p; break; } catch { /* next */ }
      }
    } catch { /* no playwright cache */ }
  }
  return browserPath;
}

// A container is not a laptop: no sandbox, no shared-memory device worth the
// name, one process, and a heap small enough that a heavy page cannot take the
// API down with it.
const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--no-zygote', '--single-process', '--hide-scrollbars', '--mute-audio',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--blink-settings=imagesEnabled=false', '--js-flags=--max-old-space-size=320',
];

/**
 * The links a page has once it has drawn itself.
 *
 * `childMenus` reads anchors out of the HTML, which is the right answer for
 * most sites and no answer at all for the ones that build their navigation in
 * JavaScript. Sebastian's Windsor is one of those: the page says "Select a menu
 * to view" and the four menus behind it are not in the markup, so the crawler
 * found the index, read it, and correctly reported no dishes (5 Sep 2026).
 *
 * Same browser, same limits as `renderText` — this asks it for hrefs instead of
 * words, and for the ones a script would navigate to as well.
 */
export async function renderLinks(url) {
  const executablePath = await chromePath();
  if (!executablePath) return { links: [], why: 'no browser on this machine' };
  const puppeteer = (await import('puppeteer-core')).default;
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: BROWSER_ARGS, protocolTimeout: RENDER_TIMEOUT_MS + 10_000 });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1100, height: 1800 });
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const type = r.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') r.abort().catch(() => {});
      else r.continue().catch(() => {});
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: RENDER_TIMEOUT_MS });
    const links = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        if (href) out.push({ url: href, text: (a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() });
      }
      // A card that navigates in script is a link to everyone except the parser.
      for (const el of document.querySelectorAll('[onclick], [data-href], [data-url], [data-link]')) {
        const attr = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link')
          || (el.getAttribute('onclick') || '').match(/['"]([^'"]*\/[^'"]*)['"]/)?.[1];
        if (!attr) continue;
        try { out.push({ url: new URL(attr, location.href).toString(), text: (el.textContent || '').replace(/\s+/g, ' ').trim() }); }
        catch { /* not an address */ }
      }
      return out;
    });
    return { links: links.filter((l) => /^https?:/i.test(l.url)), why: null };
  } catch (err) {
    return { links: [], why: `render failed: ${err.message}` };
  } finally {
    try { await browser?.close(); } catch { /* it may already be gone */ }
  }
}

/**
 * Run the page the way a diner's phone would, and take the text it drew.
 *
 * This is the step a JavaScript menu needs: the shell arrives with nothing in
 * it, the browser executes its code, the code fetches the menu, and only then
 * are there words on the page.
 */
export async function renderText(url) {
  const executablePath = await chromePath();
  if (!executablePath) return { text: '', why: 'no browser on this machine' };
  const puppeteer = (await import('puppeteer-core')).default;
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      // A container is not a laptop: no sandbox, no shared-memory device worth
      // the name, one process, and a heap small enough that a heavy page cannot
      // take the API down with it.
      args: BROWSER_ARGS,
      protocolTimeout: RENDER_TIMEOUT_MS + 10_000,
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1100, height: 1800 });
    // A menu is words. Everything else is weight we would pay for in memory.
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const type = r.resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') r.abort().catch(() => {});
      else r.continue().catch(() => {});
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    // The shell arrives first, then the navigation, then the dishes. Waiting for
    // "enough text" stops too early — the section headings alone clear the bar —
    // so wait for the text to stop growing instead.
    let text = '';
    let settled = 0;
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const next = await page.evaluate(() => document.body?.innerText || '');
      settled = next.length > 0 && next.length === text.length ? settled + 1 : 0;
      text = next;
      if (settled >= 2 && text.length >= THIN_TEXT) break;
      await new Promise((r) => setTimeout(r, 600));
    }
    return { text: text.replace(/\n{3,}/g, '\n\n').trim(), why: null };
  } catch (err) {
    return { text: '', why: `render failed: ${err.message}` };
  } finally {
    try { await browser?.close(); } catch { /* it may already be gone */ }
  }
}

/**
 * Click through a menu that is a set of tabs, and take all of it.
 *
 * The last shape of the click-through problem, and the most common one on a
 * restaurant's site. Sebastian's Windsor renders to a page that says "Select a
 * menu to view" and then lists Main Menu, Desserts, Kids Menu, Drinks — none of
 * them links, all of them calling a script that swaps the dishes in place. To a
 * crawler that reads anchors it is an empty page; to a crawler that reads the
 * rendered text it is 162 characters; to a diner it is four full menus
 * (owner, 4 Sep 2026: "you needed to click through on a single page").
 *
 * So: render, find the things that look like a menu chooser, click each one,
 * and keep whatever appears. Every tab's text is labelled with the tab, so the
 * parser sees "Desserts" as a section heading rather than one long run.
 */
export async function renderTabbedText(url, { maxTabs = 8 } = {}) {
  const executablePath = await chromePath();
  if (!executablePath) return { text: '', tabs: [], why: 'no browser on this machine' };
  const puppeteer = (await import('puppeteer-core')).default;
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: BROWSER_ARGS, protocolTimeout: RENDER_TIMEOUT_MS + 10_000 });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1100, height: 1800 });
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const type = r.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') r.abort().catch(() => {});
      else r.continue().catch(() => {});
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, 1200));

    // What a menu chooser looks like: a short piece of text naming a menu, on
    // something clickable, that is not the site's own navigation.
    const tabs = await page.evaluate(() => {
      const NAMES = /^(the |our |view )?(main|full|a la carte|à la carte|lunch|dinner|brunch|breakfast|evening|kids?|children'?s?|dessert|pudding|drink|wine|cocktail|bar|beer|set|tasting|sunday|christmas|festive|specials?|takeaway|small plates|sides|starters?|pizza|pasta|grill|sushi|vegan|vegetarian)s?( menu| list)?$/i;
      const seen = new Set();
      const out = [];
      for (const el of document.querySelectorAll('a, button, li, span, div, option, [role="tab"], [onclick]')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 32 || seen.has(text.toLowerCase())) continue;
        // Strip a price the tab happens to carry ("Kids Menu@14.50").
        const name = text.replace(/[@£$€]\s*[\d.,]+$/, '').trim();
        if (!NAMES.test(name)) continue;
        // Their own navigation is a link that goes somewhere else entirely.
        if (el.tagName === 'A' && el.getAttribute('href') && !/^#|javascript:/i.test(el.getAttribute('href'))) {
          try { if (new URL(el.href, location.href).pathname !== location.pathname) continue; } catch { /* keep it */ }
        }
        if (el.querySelector('a, button, li')) continue;   // a container, not the control
        seen.add(text.toLowerCase());
        el.setAttribute('data-roam-tab', String(out.length));
        out.push(name);
      }
      return out;
    });

    const baseline = await page.evaluate(() => document.body?.innerText || '');
    if (!tabs.length) return { text: baseline.trim(), tabs: [], why: baseline.length < THIN_TEXT ? 'nothing on the page looked like a menu chooser' : null };

    const parts = [];
    const deadline = Date.now() + RENDER_TIMEOUT_MS * 2;
    for (let i = 0; i < Math.min(tabs.length, maxTabs); i += 1) {
      if (Date.now() > deadline) break;
      try {
        await page.evaluate((n) => document.querySelector(`[data-roam-tab="${n}"]`)?.click(), i);
      } catch { continue; }
      // Let the swap happen, then wait for it to stop growing.
      let text = '';
      let settled = 0;
      const tabDeadline = Date.now() + 8000;
      while (Date.now() < tabDeadline) {
        await new Promise((r) => setTimeout(r, 500));
        const next = await page.evaluate(() => document.body?.innerText || '');
        settled = next.length === text.length ? settled + 1 : 0;
        text = next;
        if (settled >= 2) break;
      }
      // Only what this tab added: the chooser itself is on every one of them.
      const added = text.length > baseline.length ? text.slice(baseline.length) : (text === baseline ? '' : text);
      if (added.trim().length > 40) parts.push(`\n\n${tabs[i]}\n${added.trim()}`);
    }

    const text = parts.length ? `${baseline.trim()}${parts.join('')}` : baseline.trim();
    return { text, tabs: tabs.slice(0, maxTabs), why: null };
  } catch (err) {
    return { text: '', tabs: [], why: `render failed: ${err.message}` };
  } finally {
    try { await browser?.close(); } catch { /* it may already be gone */ }
  }
}

/** How much memory this container is actually allowed — a browser lives or dies by it. */
export async function memoryCeiling() {
  const { readFile } = await import('node:fs/promises');
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = (await readFile(path, 'utf8')).trim();
      if (raw === 'max') return null;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < 1e15) return Math.round(n / 1048576);
    } catch { /* not this one */ }
  }
  return null;
}

/** Can this machine actually drive its browser? A one-page check for the openers endpoint. */
export async function renderProbe(url) {
  const executablePath = await chromePath();
  if (!executablePath) return { ok: false, why: 'no browser on this machine' };
  const started = Date.now();
  const target = url && /^https?:\/\//i.test(url) ? url : 'data:text/html,<h1>Roam can render</h1>' + 'x'.repeat(THIN_TEXT);
  const { text, why } = await renderText(target);
  return {
    ok: !why && text.length > 0, why, ms: Date.now() - started, executablePath, chars: text.length,
    memoryLimitMb: await memoryCeiling(),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

/* ----------------------------------------------------------- the last resort */

const READ_SYSTEM = `You read one restaurant's own menu and write it out as plain text for a family standing at the table.

Open the menu the user gives you. If that address is a shell, a picture, or out of date, look for the same restaurant's current menu elsewhere on their own site (a PDF, a booking page, an ordering page).

Write out every section and every item exactly as the menu prints them: the section heading, then one line per item as "Name — description — price". Keep the menu's own words for names and prices. Keep any allergen or calorie note the menu gives against an item. Do not invent items, do not summarise, do not add commentary. If you cannot find a menu, answer with the single line NO MENU FOUND.`;

/* --------------------------------------------------------------- the parsing */

const Item = z.object({
  name: z.string(),
  description: z.string().nullable(),
  price: z.string().nullable(),
  kcal: z.number().int().nullable(),
  allergens: z.string().nullable(),
  vegetarian: z.boolean().nullable(),
});
const MenuShape = z.object({
  currency: z.string().nullable(),
  note: z.string().nullable(),
  sections: z.array(z.object({ title: z.string(), note: z.string().nullable(), items: z.array(Item) })),
});

const PARSE_SYSTEM = `You turn the text of a restaurant menu into structured sections and items for a family choosing at the table.

Rules:
- Every item the text lists, in the order it lists them, under the section heading it sits beneath. Never invent an item, a price or an allergen.
- "name" is the dish as the menu names it, in the menu's own words.
- "description" is the menu's line about what is in it, kept short; null when the menu gives none. It is what tells the family whether a dish suits them, so keep the ingredients.
- "price" is exactly as printed, with its currency symbol ("£16", "£19 per person", "£4 / £7.50"); null when the item has no price of its own (a set-menu course, for instance).
- "allergens" is only what the menu itself states against that item; null otherwise. Never infer one.
- "vegetarian" is true only where the menu marks it or the ingredients make it plain; null when unclear.
- "note" on a section carries how that section is priced or served (a set menu's course prices, a minimum for two).
- Skip navigation, addresses, opening hours, booking blurb, cookie notices and anything that is not the menu.
- Sections in the menu's own order: food before drinks.`;

const chunks = (text) => {
  const out = [];
  for (let i = 0; i < text.length && out.length < MAX_CHUNKS; i += CHUNK_CHARS) out.push(text.slice(i, i + CHUNK_CHARS));
  return out;
};

/* ------------------------------------------------------- menus that are pictures */

// Names that are never a menu, whatever else is true of them.
const NOT_A_MENU_IMAGE = /logo|favicon|icon|avatar|badge|banner|header|hero|sprite|placeholder|cropped-|thumb|-\d{2,3}x\d{2,3}\.|instagram|facebook|tripadvisor|award|star-|arrow|cookie/i;
// Names that usually are one.
const MENU_WORDS = /menu|a-?la-?carte|carte|food|drink|wine|lunch|dinner|brunch|breakfast|sunday|roast|specials?|tasting|set-|kids|children|dessert|front|back|takeaway/i;
/** Four is enough for a pub with a front, a back and a Sunday, and bounds the bill. */
const MAX_MENU_IMAGES = Number(process.env.ROAM_MENU_IMAGES || 4);
const MAX_IMAGE_BYTES = 5_000_000;

/**
 * The pictures on a page that might be a menu, best first.
 *
 * The owner, 5 Sep 2026: "the menu is an image, and so I want to understand
 * from you how complicated it is to extract that image. What I do not want is
 * for you to exclude something just because they have a basic website, because
 * that will cut out 10% or more of all the rest of the restaurants in the
 * country, and we could miss some diamonds."
 *
 * He is right about the proportion, and a pub that photographs its printed menu
 * and uploads it is not a worse pub. So the crawler stops treating "no text" as
 * "no menu".
 *
 * Choosing which pictures to send is a cost question rather than a correctness
 * one: the model can tell a menu from a photograph of a burger perfectly well,
 * but not for free, so the obvious rubbish is dropped by name first and the
 * rest are ranked. The Alma's are called Alma-Front-April26 and
 * Alma-Back-April26, which is the ordinary case — people name these files.
 */
export function menuImageCandidates(html, baseUrl) {
  const seen = new Set();
  const out = [];
  const consider = (raw) => {
    if (!raw) return;
    let url;
    try { url = new URL(raw.trim(), baseUrl).toString().replace(/#.*$/, ''); } catch { return; }
    if (!/^https?:/i.test(url) || seen.has(url)) return;
    if (!/\.(jpe?g|png|webp)($|\?)/i.test(url)) return;
    seen.add(url);
    const name = decodeURIComponent(url.split('/').pop() ?? '');
    if (NOT_A_MENU_IMAGE.test(name)) return;
    // A dimension in the file name is WordPress telling us this is a thumbnail.
    const sized = name.match(/-(\d{3,4})x(\d{3,4})\./);
    if (sized && Math.max(Number(sized[1]), Number(sized[2])) < 700) return;
    let n = 0;
    if (MENU_WORDS.test(name)) n += 3;
    if (/scaled|full|large|original/i.test(name)) n += 1;
    // A menu is a document: taller than it is wide, or nearly square.
    if (sized && Number(sized[2]) >= Number(sized[1])) n += 1;
    out.push({ url, name, n });
  };

  for (const [, attrs] of html.matchAll(/<img\b([^>]*)>/gi)) {
    consider((attrs.match(/\bsrc\s*=\s*"([^"]*)"/i) || attrs.match(/\bsrc\s*=\s*'([^']*)'/i) || [])[1]);
    consider((attrs.match(/\bdata-(?:src|lazy-src|large_image)\s*=\s*"([^"]*)"/i) || [])[1]);
  }
  // A gallery links the full-size picture from a thumbnail; that link is the
  // one worth reading, because the thumbnail is unreadable by design.
  for (const [, href] of html.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*\.(?:jpe?g|png|webp))"/gi)) consider(href);

  return out.sort((a, b) => b.n - a.n).slice(0, MAX_MENU_IMAGES * 2);
}

/** Fetch a picture, small enough to send and large enough to read. */
async function grabImage(url) {
  const res = await grab(url);
  if (!res.ok || !res.buffer?.length || res.buffer.length > MAX_IMAGE_BYTES) return null;
  const type = /png/i.test(res.type) ? 'image/png' : /webp/i.test(res.type) ? 'image/webp' : 'image/jpeg';
  if (!/^image\//i.test(res.type || '')) return null;
  return { data: res.buffer.toString('base64'), type };
}

/**
 * Read menus that were published as pictures.
 *
 * Everything goes in one call: a pub's front and back are one menu, and asking
 * separately would produce two half-menus with duplicated section names. The
 * model is told to ignore anything that is not a menu, which is what makes the
 * candidate list allowed to be approximate.
 */
export async function readMenuImages({ urls, venueLabel, householdId, sessionId }) {
  const images = [];
  for (const url of urls.slice(0, MAX_MENU_IMAGES * 2)) {
    if (images.length >= MAX_MENU_IMAGES) break;
    try {
      const img = await grabImage(url);
      if (img) images.push({ ...img, url });
    } catch { /* one picture that will not load is not the menu failing */ }
  }
  if (!images.length) return { sections: [], images: 0, why: 'none of the pictures could be fetched' };

  console.log(`menu.read: reading ${images.length} picture(s) for ${venueLabel ?? 'a venue'} → ${MODEL}`);
  const parsed = await parseStructured({
    system: `${PARSE_SYSTEM}

These are photographs or scans of a printed menu rather than text. Read what is printed. Some of the pictures may not be menus at all — a photograph of a dish, a logo, a picture of the room. Ignore those completely and say nothing about them. If none of the pictures is a menu, answer with no sections.`,
    messages: [{
      role: 'user',
      content: [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } })),
        { type: 'text', text: `These pictures are from the menu page of ${venueLabel || 'a restaurant'}. Write out every menu you can read across all of them.` },
      ],
    }],
    schema: MenuShape,
    householdId,
    sessionId,
    purpose: 'menu.read.image',
    effort: 'low',
    thinking: 'off',
    model: MODEL,
    maxTokens: MAX_ANSWER_TOKENS,
  });
  const sections = (parsed.sections || []).filter((s) => s.items?.length);
  return { sections, currency: parsed.currency ?? null, note: parsed.note ?? null, images: images.length, read: images.map((i) => i.url) };
}

async function parseMenuText({ text, venueLabel, householdId, sessionId }) {
  const parts = chunks(text);
  const sections = [];
  const failed = [];
  let currency = null;
  let note = null;
  // The parts do not depend on each other, so they are read at once: a long
  // menu costs the same and takes as long as its slowest part.
  const results = await Promise.all(parts.map(async (part, i) => {
    console.log(`menu.read: part ${i + 1}/${parts.length} (${part.length} chars) → ${MODEL}`);
    try {
      const parsed = await parseStructured({
        system: PARSE_SYSTEM,
        messages: [{
          role: 'user',
          content: `Menu text for ${venueLabel || 'this restaurant'}${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ''}:\n\n${part}`,
        }],
        schema: MenuShape,
        householdId,
        sessionId,
        purpose: 'menu.read',
        effort: 'low',
        thinking: 'off',
        model: MODEL,
        maxTokens: MAX_ANSWER_TOKENS,
      });
      console.log(`menu.read: part ${i + 1} gave ${(parsed.sections || []).reduce((n, x) => n + (x.items?.length || 0), 0)} items`);
      return parsed;
    } catch (err) {
      // One unreadable stretch must not lose the rest of the menu — but every
      // stretch failing for the same reason is not an unreadable menu, and a
      // ceiling of ours is a reason worth carrying up rather than counting.
      console.log(`menu.read: part ${i + 1} failed — ${err.message}`);
      if (err?.code === 'spend_bound_reached' || err?.code === 'model_budget_reached') throw err;
      failed.push(`part ${i + 1}: ${err.message}`);
      return null;
    }
  }));

  for (const parsed of results) {
    if (!parsed) continue;
    currency = currency || parsed.currency;
    note = note || parsed.note;
    for (const section of parsed.sections || []) {
      const existing = sections.find((s) => s.title.toLowerCase() === section.title.toLowerCase());
      if (existing) existing.items.push(...(section.items || []));
      else sections.push({ title: section.title, note: section.note ?? null, items: section.items || [] });
    }
  }
  return { currency, note, failed, sections: sections.filter((s) => s.items.length) };
}

/* ---------------------------------------------------------- what is this dish */

const DISH_SYSTEM = `You tell a family at a restaurant table what a dish is, in a sentence or two, when the menu gives them only a name.

Write plainly, as a well-travelled friend would across the table. No marketing words, no adjectives for their own sake, no "delicious".

- "what" is one sentence: what the dish actually is and what is mainly in it. If it is usually meat, or fish, or vegetarian, that belongs here, because that is what the table wants to know.
- "origin" is one short sentence: where it comes from, or the one thing about it worth knowing. Null if there is nothing worth saying.
- "known" is false when you do not recognise the dish or would be guessing. Say so rather than inventing: a family may be choosing around an allergy.`;

const DishNote = z.object({
  known: z.boolean(),
  what: z.string(),
  origin: z.string().nullable(),
});

/** Roam's own line about a dish, for a menu that gives only a name. */
export async function describeDish({ name, hint, householdId, sessionId }) {
  return parseStructured({
    system: DISH_SYSTEM,
    messages: [{ role: 'user', content: `Dish: ${name}${hint ? `\nOn the menu of: ${hint}` : ''}` }],
    schema: DishNote,
    householdId,
    sessionId,
    purpose: 'menu.dish',
    effort: 'low',
    thinking: 'off',
    model: MODEL,
    maxTokens: 500,
  });
}

/* ------------------------------------------------------------------- the job */

/**
 * Open a menu address and read it into sections and items.
 *
 * Returns the menu plus `how`: which opener worked, in words the screen can
 * show — "read their PDF", "rendered their page", "read by Claude" — because
 * a household should be able to see where the dishes on their phone came from.
 */
/**
 * The pictures on a page, read as a menu — or null if there are none worth
 * sending, or none of them was a menu.
 *
 * This is the last opener and it is the one the owner asked for by name (5 Sep
 * 2026: "the menu is an image, and so I want to understand from you how
 * complicated it is to extract that image… I do not want you to exclude
 * something just because they have a basic website"). It is reached from two
 * different dead ends — a page with words but no dishes, and a page with no
 * words at all — because a menu published as a photograph looks like both.
 */
async function readThePictures({ html, url, venueLabel, householdId, sessionId, steps, why }) {
  if (!html) return null;
  const candidates = menuImageCandidates(html, url);
  if (!candidates.length) return null;
  steps.push(`${why}; ${candidates.length} picture(s) on the page look like a menu`);
  try {
    const shot = await readMenuImages({ urls: candidates.map((c) => c.url), venueLabel, householdId, sessionId });
    const found = shot.sections.reduce((n, x) => n + x.items.length, 0);
    if (found) {
      steps.push(`read ${shot.images} picture(s) of their printed menu`);
      return { sections: shot.sections, currency: shot.currency, note: shot.note, failed: [], kind: 'photo', items: found };
    }
    steps.push('the pictures were not menus');
  } catch (err) {
    // Being stopped by our own ceiling is not the same as a menu we cannot
    // read, and it must not be reported as one: the pictures were found, and
    // nothing was wrong with them (owner, 6 Sep 2026, on tapping to read the
    // Sunningdale menu and being told to photograph it).
    // A ceiling of ours or a budget of the owner's stopped us; the pictures
    // were found and nothing was wrong with them.
    if (err?.code === 'spend_bound_reached' || err?.code === 'model_budget_reached') {
      err.steps = [...steps, `found ${candidates.length} picture(s) of their menu, and stopped before reading them`];
      throw err;
    }
    steps.push(`reading the pictures failed (${String(err.message).slice(0, 80)})`);
  }
  return null;
}

export async function readMenu({ url, venueLabel, householdId, sessionId, dryRun = false, searchTheWeb = false }) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw Object.assign(new Error('menu_url_required'), { status: 400 });

  const steps = [];
  let text = '';
  let kind = null;
  // Kept for the last resort: a page whose menu is a picture still has the
  // picture in its markup.
  let html = '';

  let res = null;
  try {
    res = await grab(url);
  } catch (err) {
    steps.push(`their site did not answer (${err.name === 'AbortError' ? 'timed out' : err.message})`);
  }

  if (res?.ok && looksPdf(res)) {
    try {
      text = await pdfText(res.buffer);
      kind = 'pdf';
      steps.push(`read their PDF (${text.length.toLocaleString()} characters)`);
    } catch (err) {
      steps.push(`their PDF would not open (${err.message})`);
    }
  } else if (res?.ok) {
    html = res.buffer.toString('utf8');
    text = visibleText(html);
    kind = 'html';
    steps.push(`read the page (${text.length.toLocaleString()} characters)`);

    if (text.length < THIN_TEXT) {
      const json = embeddedJson(html);
      if (json) {
        text = json;
        kind = 'json';
        steps.push('the page was a shell, but its data was in the page');
      }
    }
    if (text.length < THIN_TEXT) {
      steps.push('the page draws itself, so nothing was in the HTML');
      const rendered = await renderText(res.url || url);
      if (rendered.text.length >= THIN_TEXT) {
        text = rendered.text;
        kind = 'rendered';
        steps.push(`rendered it in a headless browser (${rendered.text.length.toLocaleString()} characters)`);
      } else {
        steps.push(rendered.why || 'rendering it gave nothing');
        // Still nothing: the page may be a chooser rather than a menu, with the
        // dishes one click away and no link to follow.
        const tabbed = await renderTabbedText(res.url || url);
        if (tabbed.text.length >= THIN_TEXT) {
          text = tabbed.text;
          kind = 'rendered';
          steps.push(`clicked through ${tabbed.tabs.length} menus on the page (${tabbed.text.length.toLocaleString()} characters)`);
        } else if (tabbed.why) {
          steps.push(tabbed.why);
        }
      }
    }
  }

  // Still nothing readable. Claude searches the open web for the menu and
  // writes it out — and this step has to earn its place, because it does not.
  //
  // Measured over 127 menus (5 Sep 2026): 61 calls, 14 menus, $12.22 — 11% of
  // the menus we hold and 52% of everything the sweep has ever spent. Seventy-
  // seven per cent of the calls produced nothing at all and still cost twenty
  // cents each. Worse than the price: it is the only opener that *writes* a
  // menu rather than reading one, from search results rather than from a page
  // we chose, so a dish or a price it invents is indistinguishable from one it
  // found. Everything else here transcribes something we are looking at.
  //
  // So it is off unless the caller asks for it, and the caller only asks for
  // the places worth it — the top few of an area, or one a household has
  // actually chosen. Everywhere else the honest answer is "they publish no
  // menu we could read", which is a fact worth recording (owner, 5 Sep 2026).
  // Nothing readable. Before anything else is tried or given up on, look at the
  // page's pictures: a menu published as a photograph has no text to fail on,
  // which is exactly why it used to fall out here without the pictures ever
  // being looked at (owner, 6 Sep 2026, tapping Menu on the Sunningdale).
  // `dryRun` stops before anything is spent, and reading a picture is spending.
  if (text.length < THIN_TEXT && !dryRun) {
    const shot = await readThePictures({ html, url: res?.url || url, venueLabel, householdId, sessionId, steps, why: 'no readable text on the page' });
    if (shot) return { ...shot, how: steps, sourceUrl: res?.url || url, chars: text.length };
  }

  if (text.length < THIN_TEXT && !searchTheWeb) {
    const err = new Error('menu_unreadable');
    err.status = 422;
    err.steps = [...steps, 'nothing readable on the page, and searching the web for it was not worth the cost here'];
    throw err;
  }

  // Still nothing readable: Claude opens it, and anything the restaurant
  // publishes instead, and writes the menu out. This is the step that costs.
  if (text.length < THIN_TEXT) {
    const { text: read } = await searchWeb({
      system: READ_SYSTEM,
      prompt: `Menu address: ${url}\nRestaurant: ${venueLabel || 'unknown'}\n\nWrite out their current menu.`,
      householdId,
      sessionId,
      purpose: 'menu.read.web',
      maxSearches: 4,
      maxFetches: 4,
      effort: 'low',
    });
    if (read && !/^NO MENU FOUND/i.test(read.trim())) {
      text = read;
      kind = 'claude';
      steps.push('Claude read it from the open web');
    }
  }

  if (text.length < THIN_TEXT) {
    const err = new Error('menu_unreadable');
    err.status = 422;
    err.steps = steps;
    throw err;
  }

  if (dryRun) return { dryRun: true, kind, how: steps, sourceUrl: res?.url || url, chars: text.length, sample: text.slice(0, 600) };

  const menu = await parseMenuText({ text, venueLabel, householdId, sessionId });
  let items = menu.sections.reduce((n, s) => n + s.items.length, 0);
  if (menu.failed?.length) steps.push(`${menu.failed.length} of ${Math.ceil(text.length / CHUNK_CHARS)} parts would not read`);

  if (!items) {
    // The page had words but no dishes in them, which is what a page whose menu
    // is a photograph looks like: kitchen hours, "click to enlarge each photo",
    // and four pictures of a printed menu.
    const shot = await readThePictures({ html, url: res?.url || url, venueLabel, householdId, sessionId, steps, why: 'no dishes in the text' });
    if (shot) return { ...shot, how: steps, sourceUrl: res?.url || url, chars: text.length };
  }

  if (!items) {
    const err = new Error('menu_had_no_items');
    err.status = 422;
    err.steps = steps;
    throw err;
  }
  return { ...menu, kind, how: steps, sourceUrl: res?.url || url, chars: text.length, items };
}

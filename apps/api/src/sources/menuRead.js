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
import { z } from 'zod';

const UA = 'RoamBot/1.0 (+https://web-production-afce9.up.railway.app; household menu read)';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 12_000_000;
const RENDER_TIMEOUT_MS = Number(process.env.ROAM_RENDER_TIMEOUT_MS || 25_000);
// Below this much readable text a page is a shell, not a menu.
const THIN_TEXT = 700;
// One Claude call reads this much; a long menu is split and merged.
const CHUNK_CHARS = 20_000;
const MAX_CHUNKS = 4;
// Menus are read by the model the owner is paying for; a menu is mechanical
// extraction, not reasoning, so the default is the cheaper current-generation
// model. ROAM_MENU_MODEL moves it without a deploy.
const MODEL = process.env.ROAM_MENU_MODEL || 'claude-sonnet-5';

/* ------------------------------------------------------------------ fetching */

async function grab(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf,*/*' },
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) return { ok: false, url: res.url || url, type, status: res.status };
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, url: res.url || url, type, buffer: buffer.subarray(0, MAX_BYTES) };
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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1200, height: 2400 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: RENDER_TIMEOUT_MS });
    // Menus lazily draw section by section; give the last fetch a moment.
    await new Promise((r) => setTimeout(r, 1200));
    const text = await page.evaluate(() => document.body?.innerText || '');
    return { text: text.replace(/\n{3,}/g, '\n\n').trim(), why: null };
  } catch (err) {
    return { text: '', why: `render failed: ${err.message}` };
  } finally {
    await browser?.close().catch(() => {});
  }
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

async function parseMenuText({ text, venueLabel, householdId, sessionId }) {
  const parts = chunks(text);
  const sections = [];
  let currency = null;
  let note = null;
  for (const [i, part] of parts.entries()) {
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
      maxTokens: 8000,
    });
    currency = currency || parsed.currency;
    note = note || parsed.note;
    for (const section of parsed.sections || []) {
      const existing = sections.find((s) => s.title.toLowerCase() === section.title.toLowerCase());
      if (existing) existing.items.push(...(section.items || []));
      else sections.push({ title: section.title, note: section.note ?? null, items: section.items || [] });
    }
  }
  return { currency, note, sections: sections.filter((s) => s.items.length) };
}

/* ------------------------------------------------------------------- the job */

/**
 * Open a menu address and read it into sections and items.
 *
 * Returns the menu plus `how`: which opener worked, in words the screen can
 * show — "read their PDF", "rendered their page", "read by Claude" — because
 * a household should be able to see where the dishes on their phone came from.
 */
export async function readMenu({ url, venueLabel, householdId, sessionId }) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw Object.assign(new Error('menu_url_required'), { status: 400 });

  const steps = [];
  let text = '';
  let kind = null;

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
    const html = res.buffer.toString('utf8');
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
      }
    }
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

  const menu = await parseMenuText({ text, venueLabel, householdId, sessionId });
  const items = menu.sections.reduce((n, s) => n + s.items.length, 0);
  if (!items) {
    const err = new Error('menu_had_no_items');
    err.status = 422;
    err.steps = steps;
    throw err;
  }
  return { ...menu, kind, how: steps, sourceUrl: res?.url || url, chars: text.length, items };
}

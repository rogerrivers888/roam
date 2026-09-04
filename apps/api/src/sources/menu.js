// Reading a place's own menu, on a tap (owner, 4 Sep 2026: "maybe you could
// check the menu to see whether their foods are accommodated").
//
// This is not a place source and it is not in the registry: nothing here is
// ever part of a search. It answers one question about one restaurant the
// household is already looking at — does it do our dish, is there something
// for the vegetarian, does the allergen appear — by reading that restaurant's
// own menu page.
//
// Rules this keeps (CLAUDE.md, Requirements §4, Technical Constraints §13):
//   • It spends money, so it runs only when the household taps it, one place
//     at a time, and every call is written to provider_calls with the
//     household and session inside the planner's existing spend bounds.
//   • Menu item names and prices are facts and may be shown; descriptive menu
//     prose is the restaurant's copy and is never reproduced. A publicly
//     searchable menu database is out of scope until the copyright review
//     (Requirements §4) — this is one household reading one menu.
//   • Nothing is stored: answers live in memory for a few hours so tapping the
//     same place twice does not pay twice.
//   • It never says "safe". An allergen answer is what the published menu
//     says, and the card says to check at the table — Requirements §5 keeps
//     allergens on the safety path, not the preference path.

import { searchWeb } from '../claude.js';
import { query } from '../db.js';

export const MENU_ATTRIBUTION = 'Read from the venue’s own menu';
const CACHE_TTL_MS = 6 * 3600_000;
// The month's purse for menu reads (each ≈ $0.05–0.20), separate from the
// scout's and from the Anthropic workspace limit, which remains the hard stop.
export const MENU_CHECKS_MONTHLY = Number(process.env.ROAM_MENU_CHECKS_MONTHLY || 120);

const cache = new Map();
const inflight = new Map();

export const menuCheckEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim());

async function assertMenuBudget(householdId) {
  const { rows: [{ n }] } = await query(
    `select count(*)::int as n from provider_calls
      where household_id = $1 and purpose = 'menu.check' and created_at >= date_trunc('month', now())`,
    [householdId],
  );
  if (n >= MENU_CHECKS_MONTHLY) throw new Error(`menu reading paused: ${n} of ${MENU_CHECKS_MONTHLY} reads used this month (ROAM_MENU_CHECKS_MONTHLY)`);
  return n;
}

const SYSTEM = `You read one restaurant's own menu for a family planning where to eat, and answer about that one restaurant only.

Find the venue's current menu: its own website first (look for "menu", "food", "eat", "drinks", a PDF menu, or the menu on its booking page), then a page that reproduces it (Deliveroo, Just Eat, TheFork, OpenTable, SquareMeal) if the venue publishes none. Open the page and read it. Do not guess from reviews, photographs or the venue's category.

Answer only from what the menu actually lists.

What matters:
- The dish asked about: is it on the menu, under what name, at what price. A close relative counts and must be named as what it is (e.g. asked for arrabbiata, the menu has "Penne all'arrabbiata" — that is the dish; "spicy tomato penne" is a relative, say so).
- Each person's requirement: whether the menu has main courses that meet it, with two or three example item names.
- Each allergen: whether it appears in the items the menu lists, and whether the menu states anything about allergen information at all. Never say a place is safe. If the menu does not list ingredients, the verdict is "unknown".
- Whether there is a children's menu.

Rules:
- Item names and prices only. Never copy a menu's descriptive sentences — write your own short words.
- "verdict" is exactly one of "yes", "no" or "unknown". Unknown is the honest answer when the menu is a photograph, out of date, behind a booking flow, or does not say.
- If you cannot find a menu for this venue, set checked to false and say why in one line.

Answer with ONLY a JSON object inside a \`\`\`json fence, no prose:
{"checked": true|false, "menu_url": string|null, "menu_dated": string|null,
 "dish": {"asked": string, "verdict": "yes"|"no"|"unknown", "named": string|null, "price": string|null, "note": string|null},
 "people": [{"person": string, "need": string, "verdict": "yes"|"no"|"unknown", "examples": [string], "note": string|null}],
 "allergens": [{"person": string, "allergen": string, "verdict": "yes"|"no"|"unknown", "note": string}],
 "kids_menu": true|false|null,
 "summary": string,
 "why_not": string|null}`;

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!fenced) return null;
  try { const v = JSON.parse(fenced); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

const VERDICTS = new Set(['yes', 'no', 'unknown']);
const verdict = (v) => (VERDICTS.has(String(v)) ? String(v) : 'unknown');
// Kept short, but cut at a word and finished with an ellipsis rather than
// stopping mid-word ("hidden carrot cannot be rul").
const line = (s, max = 220) => {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trim()}…`;
};

/**
 * What one venue's menu says for the people coming.
 *
 * `venue` needs a name and enough to identify it (address or website);
 * `people` is what to look for, built by the caller from the household's own
 * records so this module never reaches into the database for preferences.
 */
export async function checkMenu({ householdId, sessionId = null, venue, dish = null, people = [], allergens = [], kidsMatter = false }) {
  if (!menuCheckEnabled()) throw new Error('Reading a menu needs the planner’s Anthropic key, which is not set here.');
  if (!venue?.name) throw new Error('venue_required');
  const key = [venue.venueRef || venue.name, dish?.label ?? '', people.map((p) => `${p.person}:${p.need}`).join(','), allergens.map((a) => `${a.person}:${a.allergen}`).join(','), kidsMatter ? 'kids' : ''].join('|');
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cached: true };
  if (inflight.has(key)) return { ...(await inflight.get(key)), cached: true };

  const run = (async () => {
    await assertMenuBudget(householdId);
    const prompt = [
      `Venue: ${venue.name}`,
      venue.address ? `Address: ${venue.address}` : null,
      venue.website ? `Website: ${venue.website}` : null,
      venue.mapsUrl ? `On the map: ${venue.mapsUrl}` : null,
      venue.cuisines?.length ? `Listed as: ${venue.cuisines.join(', ')}` : null,
      '',
      dish ? `Dish asked about: ${dish.label}${dish.aliases?.length ? ` (also written: ${dish.aliases.slice(0, 4).join(', ')})` : ''}` : 'No particular dish — answer the requirements only.',
      people.length ? `Requirements: ${people.map((p) => `${p.person} — ${p.need}`).join('; ')}` : 'No dietary requirements.',
      allergens.length ? `Allergens: ${allergens.map((a) => `${a.person} — ${a.allergen}`).join('; ')}` : 'No allergens.',
      kidsMatter ? 'A child is coming: say whether there is a children\'s menu.' : '',
    ].filter((l) => l !== null).join('\n');

    const { text } = await searchWeb({ system: SYSTEM, prompt, householdId, sessionId, purpose: 'menu.check', maxSearches: 4, maxFetches: 5 });
    const raw = extractJson(text);
    if (!raw) throw new Error('The menu reader did not answer in a form Roam could read — try again.');
    const value = {
      checked: raw.checked === true,
      menuUrl: line(raw.menu_url, 300),
      menuDated: line(raw.menu_dated, 40),
      dish: dish ? {
        label: dish.label,
        verdict: verdict(raw.dish?.verdict),
        named: line(raw.dish?.named, 80),
        price: line(raw.dish?.price, 20),
        note: line(raw.dish?.note),
      } : null,
      people: (Array.isArray(raw.people) ? raw.people : []).slice(0, 6).map((p) => ({
        person: line(p.person, 40), need: line(p.need, 40), verdict: verdict(p.verdict),
        examples: (Array.isArray(p.examples) ? p.examples : []).slice(0, 3).map((e) => line(e, 60)).filter(Boolean),
        note: line(p.note, 260),
      })).filter((p) => p.person),
      allergens: (Array.isArray(raw.allergens) ? raw.allergens : []).slice(0, 6).map((a) => ({
        person: line(a.person, 40), allergen: line(a.allergen, 40), verdict: verdict(a.verdict), note: line(a.note),
      })).filter((a) => a.person),
      kidsMenu: raw.kids_menu === true ? true : raw.kids_menu === false ? false : null,
      summary: line(raw.summary, 360),
      whyNot: line(raw.why_not, 200),
      readAt: new Date().toISOString(),
      attribution: MENU_ATTRIBUTION,
    };
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  })();

  inflight.set(key, run);
  run.finally(() => inflight.delete(key)).catch(() => {});
  return { ...(await run), cached: false };
}

/** How many menus this household has read this month, against the month's purse. */
export async function menuCheckUsage(householdId) {
  const { rows: [{ n }] } = await query(
    `select count(*)::int as n from provider_calls
      where household_id = $1 and purpose = 'menu.check' and created_at >= date_trunc('month', now())`,
    [householdId],
  );
  return { used: n, limit: MENU_CHECKS_MONTHLY };
}

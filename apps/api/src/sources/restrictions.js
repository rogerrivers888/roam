// Who may ride (owner, 4 Sep 2026: "they are useless without any age rating or
// info on the ride").
//
// The open map knows a ride exists and where it stands. It almost never knows
// who is allowed on it: of forty rides at Thorpe Park, one carried a height
// tag, and that one said "*". Wikidata knows how high and how fast, which is
// interesting, but a parent standing at a gate is asking one question — can
// this child go on it.
//
// Every park publishes the answer itself, because it has to: a rides page, a
// height-restrictions page, an accessibility guide. So this reads the park's
// own pages once, for all of its rides at once, and keeps the answer. That is
// the venue's own published information about itself, the same source
// sources/own.js and sources/menu.js already use, and it does not expire.
//
// It costs one model call per park, ever, so it runs when a household actually
// opens that park and never on a search.

import { searchWeb } from '../claude.js';
import * as placeContents from '../repositories/placeContents.js';
import { contentsOf } from './inside.js';

export const restrictionsEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim());

const SYSTEM = `You find out who is allowed on each ride at one theme park, zoo or attraction, from that place's own published information.

Nearly every park publishes one table or PDF covering every ride at once — "ride restrictions", "rider requirements", "body measurements", "height guide", often inside the accessibility pages. Find that document first: it answers the whole list in one read, and it is the park's own word. Only then go to individual ride pages for what it leaves out. Use a well-known enthusiast reference to fill a last gap, and say when you have.

For each ride you are given, find:
- the minimum height to ride, in centimetres
- the maximum height, where there is one (small children's rides often have one)
- the minimum age, where the park states one rather than a height
- whether a child under a certain height must be accompanied by an adult, in a few words ("under 120 cm with an adult")
- how intense it is, in the park's own words if it grades them ("thrill", "family", "little ones")

Rules:
- Only what the park actually publishes. A ride you cannot find restrictions for gets nulls — never a guess, never a number carried over from a similar ride.
- Heights in centimetres, as a whole number.
- Match the ride names you were given. If the park calls it something slightly different, use the name you were given and say the park's name in "as_published".
- Ignore rides that are closed or being rebuilt, but say so in "note".

Answer with ONLY a JSON object inside a \`\`\`json fence:
{"source_urls": [string], "rides": [{"name": string, "as_published": string|null, "min_height_cm": number|null, "max_height_cm": number|null, "min_age": number|null, "supervision": string|null, "thrill": string|null, "note": string|null}]}`;

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!fenced) return null;
  try { const v = JSON.parse(fenced); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cm = (v) => { const n = Number(v); return Number.isFinite(n) && n > 20 && n < 250 ? Math.round(n) : null; };

/**
 * Read one park's own restrictions and write them onto the rides we already
 * hold. Returns how many rides learned something.
 */
export async function researchRestrictions({ parentRef, parentName, website, householdId = null, sessionId = null }) {
  if (!restrictionsEnabled()) return { learned: 0, skipped: 'no-key' };
  const held = await contentsOf(parentRef);
  const rides = held.filter((i) => !['eat', 'shop', 'facility'].includes(i.kind));
  if (!rides.length) return { learned: 0, skipped: 'nothing-inside' };
  // Already answered for every ride: nothing to ask.
  if (rides.every((r) => r.facts?.minHeightM != null || r.facts?.minAge != null || r.facts?.restrictionsChecked)) {
    return { learned: 0, skipped: 'already-known' };
  }

  const prompt = [
    `Place: ${parentName || parentRef}`,
    website ? `Its website: ${website}` : null,
    '',
    'Its rides, as the open map names them:',
    ...rides.slice(0, 45).map((r) => `- ${r.name}${r.kindLabel ? ` (${r.kindLabel.toLowerCase()})` : ''}`),
  ].filter((l) => l !== null).join('\n');

  const { text } = await searchWeb({ system: SYSTEM, prompt, householdId, sessionId, purpose: 'inside.restrictions', maxSearches: 6, maxFetches: 14, effort: 'medium' });
  const answer = extractJson(text);
  if (!answer?.rides?.length) return { learned: 0, skipped: 'no-answer' };

  const byName = new Map(rides.map((r) => [norm(r.name), r]));
  const sources = (answer.source_urls || []).filter((u) => typeof u === 'string').slice(0, 4);
  let learned = 0;
  for (const said of answer.rides) {
    const ride = byName.get(norm(said.name));
    if (!ride) continue;
    const minH = cm(said.min_height_cm);
    const maxH = cm(said.max_height_cm);
    const age = Number.isFinite(Number(said.min_age)) && Number(said.min_age) > 0 && Number(said.min_age) < 21 ? Math.round(Number(said.min_age)) : null;
    const facts = {
      ...ride.facts,
      // Everything the park itself said, and a mark that it was asked — so a
      // ride with genuinely no restriction is not asked about again forever.
      restrictionsChecked: new Date().toISOString().slice(0, 10),
      ...(minH ? { minHeightM: minH / 100 } : {}),
      ...(maxH ? { maxHeightM: maxH / 100 } : {}),
      ...(age ? { minAge: age } : {}),
      ...(said.supervision ? { supervision: String(said.supervision).slice(0, 80) } : {}),
      ...(said.thrill ? { thrill: String(said.thrill).slice(0, 40) } : {}),
      ...(said.note ? { note: String(said.note).slice(0, 200) } : {}),
    };
    if (minH || maxH || age || said.supervision) learned += 1;
    await placeContents.updateFacts(parentRef, ride.itemRef, facts, sources);
  }
  return { learned, sources };
}

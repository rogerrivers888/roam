/**
 * Reading a place properly (owner, 5 Sep 2026).
 *
 * > "Instead of just capturing the first 4 lines, I'm wondering whether we
 * > break down what sort of facts and information we want. We definitely want
 * > to have, if it's a historical site, a bit of information about the history
 * > of the site… There's other information, like how much it costs, what there
 * > is to see there, and whether it's a 20-minute trip or a very big, extensive
 * > location."
 *
 * Migration 041 stopped taking four sentences and started taking the whole
 * article. That is retrieval. This is the reading: the article, the travel
 * guide entry, the map's tags and the venue's own page go in, and a filled-in
 * form comes out — the form below.
 *
 * Two rules run through the whole design, and both exist because the next
 * screen the owner sees is one where he checks this work:
 *
 *   1. **Every claim carries the sentence it came from.** A field with a quote
 *      is a reading and can be checked in two seconds; a field without one is a
 *      judgement and is exactly what he needs to look at. Marking the
 *      difference is worth more than getting the judgement right.
 *   2. **Nothing is optional.** Every field is present and required, filled
 *      with an empty string or an empty list when the sources are silent. A
 *      model that may omit a field omits the ones it is least sure about, and
 *      then "the sources did not say" and "I did not think about it" look
 *      identical on screen. `missing` says the first out loud.
 *
 * The same reasoning as domain/teaching.js, which fills every shelf weight
 * rather than letting the model leave one out — and it also keeps this schema
 * clear of the sixteen-nullable-field ceiling, since there are no nullable
 * fields at all.
 */

import { z } from 'zod/v4';
import { parseStructured, MODEL } from '../claude.js';

// ---------------------------------------------------------------------------
// the form
// ---------------------------------------------------------------------------

/**
 * How long it takes, in the words a family uses. Not minutes: nobody says "83
 * minutes", and a number invites a precision none of these sources support.
 * The owner's own framing was "whether it's a 20-minute trip or a very big,
 * extensive location", which is a scale of five.
 */
const Dwell = z.enum(['under an hour', 'an hour or two', 'half a day', 'a full day', 'more than a day']);

const Source = z.enum(['wikipedia', 'wikivoyage', 'their own site', 'openstreetmap', 'judgement']);

/** One thing worth looking at, and why anybody would. */
const Highlight = z.object({
  name: z.string(),
  why: z.string(),
  source: Source,
  quote: z.string(),
});

/**
 * Who a place rewards. A closed list, because the point of it is filtering —
 * an open string would give us forty ways to say "good for young children" and
 * no way to search for one.
 */
const Audience = z.enum([
  'toddlers', 'young children', 'older children', 'teenagers',
  'adults', 'anybody', 'the less mobile', 'dog walkers', 'a special occasion',
]);

export const AttractionFacts = z.object({
  // The sentence you would say to a friend. First because it is the hardest to
  // write and the model does it better when it is not summarising its own
  // earlier answers.
  whyGo: z.string(),

  // "If it's a historical site, a bit of information about the history of the
  // site, so that's useful." Empty where the place has no history worth the
  // name — a country park does not need one, and inventing one is worse than
  // leaving it out.
  history: z.string(),
  historyQuote: z.string(),

  // What there is to see and do, named. This is the field the owner asked for
  // most directly and the one a drawer leads on.
  highlights: z.array(Highlight),

  // How long, and why. The reason is required because the reason is the part he
  // is reviewing: "a full day" with no argument behind it is a guess wearing a
  // confident face.
  dwell: Dwell,
  dwellWhy: z.string(),

  // Does rain ruin it.
  cover: z.enum(['indoors', 'mostly indoors', 'both', 'mostly outdoors', 'outdoors']),

  suits: z.array(Audience),
  suitsWhy: z.string(),
  // Said plainly, because a family with a bored eight-year-old has had their
  // afternoon decided for them and nothing else on the card warns about it.
  wouldBore: z.string(),

  bestTime: z.string(),
  // '' when it is open all year and nothing changes. Anything else is what
  // closes, when, and what that costs you.
  seasonal: z.string(),

  booking: z.enum(['not needed', 'advised', 'required', 'the sources do not say']),

  // What the sources did not answer. A read that knows its own gaps is worth
  // more than one that leaves a field blank and hopes, and this list is what
  // the owner scans to decide whether another source is worth adding.
  missing: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
});

// ---------------------------------------------------------------------------
// the prompt
// ---------------------------------------------------------------------------

/**
 * The part that never changes, which is therefore the part that is cached.
 *
 * The lessons go *after* this in the same system block. That does invalidate
 * the cache whenever a lesson is added — which is right: lessons change a few
 * times an afternoon while he is teaching, and stay still for the hours a
 * region takes to read. Within one run the prompt is constant and every place
 * after the first is a cache read.
 */
const BASE = `You are reading about a place to go, for Roam — a trip planner used by one family at a time to decide what to do this weekend.

You will be given everything we hold about one attraction: the Wikipedia article in sections, a travel guide entry where one exists, what OpenStreetMap records about it, and what the venue publishes on its own site. You fill in a form about it.

Who you are writing for: a parent deciding, on a Thursday, whether to take the family here on Saturday. They want to know what they would actually do when they arrived, how long it takes, whether the children will be bored and whether rain ruins it. They do not want an encyclopedia entry — they can already read one.

Rules that matter more than fluency:

1. QUOTE WHAT YOU READ. Every highlight and the history carry the sentence you took them from, verbatim, in the quote field. If you are inferring rather than reading, set the source to "judgement" and leave the quote empty. Never put a sentence in a quote field that is not in the sources word for word.

2. DO NOT INVENT. If the sources do not say what it costs, do not estimate. If they do not say when it opens, do not guess from what similar places do. Put the gap in "missing" instead. A blank we know about is useful; a plausible invention is a family driving to a closed gate.

3. HISTORY ONLY WHERE THERE IS HISTORY. A castle, an abbey, a battlefield: yes, and lead with what happened rather than with the architecture. A country park, a soft play, a modern gallery: leave history empty. Two or three sentences at most — this is the reason to be interested, not the article.

4. DWELL IS ABOUT THE VISIT, NOT THE PLACE. A cathedral you walk round in forty minutes is "an hour or two" even though it took three centuries to build. Base it on what there is to do: the number of things to see, whether there is a walk, whether people eat there. Say what you based it on in dwellWhy. If the sources genuinely do not support a judgement, say so in dwellWhy and set confidence low.

5. WOULD BORE IS NOT OPTIONAL AND IS NOT A DISCLAIMER. Name who would actually have a bad time and why: "under-eights — it is one room of cabinets and nothing to touch". If nobody would, say so plainly.

6. WRITE LIKE A PERSON. Short sentences. No marketing ("nestled", "a hidden gem", "something for everyone"), no hedging stacks ("may possibly offer"). If you would not say it out loud to a friend, do not write it.

7. THE MODEL DOES NOT SET PRICES. Admission is read from the venue's own page elsewhere in Roam and is not your job. If the sources mention a price, put it in missing as something to verify rather than in a field.`;

/** The lessons, as an instruction block, in the order they should be read. */
export function lessonBlock(lessons = []) {
  if (!lessons.length) return '';
  const byScope = { all: [], kind: [], place: [] };
  for (const l of lessons) (byScope[l.scope] ?? byScope.kind).push(l);
  const lines = [];
  const section = (title, rows) => {
    if (!rows.length) return;
    lines.push('', title);
    for (const l of rows) lines.push(`- ${l.field ? `[${l.field}] ` : ''}${l.rule}`);
  };
  section('Rules the owner has given about every place:', byScope.all);
  section('Rules about this kind of place:', byScope.kind);
  section('Rules about this place in particular:', byScope.place);
  return [
    '',
    '---',
    '',
    'The owner of Roam has reviewed earlier readings and corrected them. These are his corrections. Where one of them conflicts with the general rules above, his correction wins — he is describing what he wants, and the rules above are only the starting point.',
    ...lines,
  ].join('\n');
}

/**
 * The reads he approved, as worked examples.
 *
 * Few-shot rather than more instructions, because "write like a person" is
 * hard to say and easy to show. Capped at three: they are the largest thing in
 * the prompt and a fourth has never been the difference in any prompt I have
 * seen tuned.
 */
export function exampleBlock(examples = []) {
  if (!examples.length) return '';
  return [
    '',
    '---',
    '',
    'Readings the owner approved. Match this level of specificity and this tone.',
    ...examples.slice(0, 3).map((e) => `\n${e.name}:\n${JSON.stringify(e.facts, null, 1)}`),
  ].join('\n');
}

export const systemFor = ({ lessons = [], examples = [] } = {}) =>
  BASE + lessonBlock(lessons) + exampleBlock(examples);

// ---------------------------------------------------------------------------
// what we hand it
// ---------------------------------------------------------------------------

const trim = (s, n) => (s && s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : (s ?? ''));

/**
 * Everything we hold about one place, as the text the model reads.
 *
 * Built from the row and its detail rather than fetched: migration 041's pass
 * has already been and got all of this, so a read costs one Claude call and no
 * requests to anybody else.
 */
export function briefFor(a, detail = {}, contents = []) {
  const sections = detail.sections ?? [];
  const visit = detail.visit ?? {};
  const lines = [
    `PLACE: ${a.name}`,
    `WHERE: ${a.region_name ?? a.region_slug}`,
    a.category ? `ROAM CALLS IT: ${a.category}` : null,
    a.heritage ? `DESIGNATED: ${a.heritage}` : null,
    (a.accolades ?? []).length ? `ALSO: ${(a.accolades ?? []).map((x) => x.label).join(', ')}` : null,
    '',
    '--- WIKIPEDIA ---',
    ...sections.map((s) => `${s.heading ? `## ${s.heading}\n` : ''}${trim(s.text, 1200)}`),
  ];

  if (visit.travellerNote) {
    lines.push('', '--- A TRAVEL GUIDE (Wikivoyage) ---', visit.travellerNote);
  }
  const guide = (detail.highlights ?? []).slice(0, 25);
  if (guide.length) {
    lines.push('', '--- WHAT THE TRAVEL GUIDE LISTS HERE ---');
    for (const h of guide) lines.push(`- ${h.name}${h.note ? `: ${trim(h.note, 200)}` : ''}${h.price ? ` (${h.price})` : ''}`);
  }

  // The map's answer to "what is inside", which for a theme park is the ride
  // list and is the best evidence there is for how long a visit takes.
  if (contents.length) {
    const by = new Map();
    for (const c of contents) {
      if (!by.has(c.kindLabel)) by.set(c.kindLabel, []);
      by.get(c.kindLabel).push(c.name);
    }
    lines.push('', `--- WHAT IS INSIDE IT, FROM THE MAP (${contents.length} things) ---`);
    for (const [kind, names] of by) lines.push(`${kind}: ${names.slice(0, 30).join(', ')}`);
  }

  const facts = Object.entries({
    'Opening hours': visit.openingHours, Operator: visit.operator,
    'Step-free access': visit.stepFree, Wheelchair: visit.wheelchair,
    Toilets: visit.toilets ? 'yes' : null, Parking: visit.parking,
    Dogs: visit.dogs, Website: visit.website,
  }).filter(([, v]) => v);
  if (facts.length) {
    lines.push('', '--- THE MAP AND THEIR OWN SITE ---');
    for (const [k, v] of facts) lines.push(`${k}: ${v}`);
  }

  return lines.filter((l) => l !== null).join('\n');
}

// ---------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------

/**
 * Read one place. One Claude call, attributed like every other (claude.js), so
 * the back office's own spend lands beside the planner's in provider_calls.
 */
export async function readAttraction({
  attraction, detail, contents = [], lessons = [], examples = [], householdId, effort = 'medium',
}) {
  // Said plainly rather than as an SDK stack trace. The key is injected by
  // Doppler on the deployed API and is absent from a local checkout by design,
  // so this is the ordinary state of the button on a laptop.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw Object.assign(
      new Error('No Claude key on this API, so nothing can be read. This runs on the deployed API, where Doppler injects the key.'),
      { status: 503, code: 'no_model_key' },
    );
  }

  const system = systemFor({ lessons, examples });
  const facts = await parseStructured({
    system,
    messages: [{ role: 'user', content: briefFor(attraction, detail, contents) }],
    schema: AttractionFacts,
    householdId,
    sessionId: null,
    purpose: 'atlas.read',
    effort,
    maxTokens: 4096,
  });

  // The evidence is lifted out of the answer and kept beside it, so the review
  // screen can put a quote next to a claim without walking the structure, and
  // so a claim with no quote — a judgement — is visible at a glance.
  const evidence = {};
  if (facts.historyQuote) evidence.history = { quote: facts.historyQuote, source: 'wikipedia' };
  facts.highlights.forEach((h, i) => {
    evidence[`highlights.${i}`] = { quote: h.quote, source: h.source, of: h.name };
  });
  evidence.dwell = { quote: '', source: 'judgement', why: facts.dwellWhy };

  return {
    facts, evidence,
    missing: facts.missing ?? [],
    confidence: facts.confidence,
    model: MODEL,
    promptHash: hashOf(system),
    lessonsUsed: lessons.map((l) => l.id),
  };
}

/** Which prompt a reading was made under, short enough to sit in a column. */
export function hashOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
}

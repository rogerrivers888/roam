/**
 * "Tell it why this activity belongs there and not there."
 *
 * The owner asked for a box he can talk into rather than six sliders he has to
 * reason about: "I can paste the new category I found on the homepage into the
 * AI learning and tell it why this activity belongs there and not there."
 * (5 Sep 2026.) So this takes a sentence about a place or a type and turns it
 * into the same weights the form below it holds.
 *
 * It proposes and never writes. What comes back fills the form, he moves
 * whatever he disagrees with, and the rule reaches `shelf_rules` only when he
 * saves it — because a categorisation nobody read is precisely the silent
 * guessing the teaching screen exists to end.
 *
 * One Claude call, attributed to the household like every other (claude.js), so
 * the back office's own spend lands in the same place as the planner's.
 */

import { z } from 'zod/v4';
import { parseStructured } from '../claude.js';
import { MAX_SHELVES, MOODS, SHELF_FLOOR } from './moods.js';

/**
 * The answer. A weight per shelf and a sentence saying what was decided — the
 * sentence is stored on the rule, so the table stays readable by a person who
 * was not in the room.
 *
 * Every shelf is present and required rather than optional: a model that may
 * omit a field will omit the ones it is least sure about, and "not on this
 * shelf" and "I did not think about this shelf" would then look identical. Zero
 * says it outright.
 */
const Weight = z.number().min(0).max(1);
const Proposal = z.object({
  fun: Weight,
  food: Weight,
  culture: Weight,
  adrenaline: Weight,
  relaxing: Weight,
  outdoors: Weight,
  // Whether this is really about this one place or about everything of its
  // type. The owner's own example is the second kind: a football ground is not
  // a special case, every football ground is the same case.
  scope: z.enum(['place', 'kind', 'category', 'experience']),
  reason: z.string(),
});

const SYSTEM = `You are helping the owner of Roam, a family trip planner, correct how it sorts places onto the six shelves its home screen shows.

The six shelves and what each means to this household:
- Fun — a good day out. Somewhere you go and enjoy yourself. Watching sport is here: a stadium, a racecourse, an arena.
- Food — somewhere you eat or drink. Nothing on the home screen's other shelves is ever food.
- Culture — museums, galleries, castles, cathedrals, theatres, historic institutions.
- Adrenaline — something you *do* that gets your heart going. The owner's own words: "Adrenaline might be an activity like a flying lesson… if there are any water skiing-type activities or anything like that around, that would be adrenaline… parachuting, anything like that: those are adrenaline-type activities. Go-karting, etc." Watching other people do something is never adrenaline.
- Relaxing — a gentle day. A garden, a walk, a browse, a spa.
- Outdoors — the point of it is being outside.

You answer with a weight from 0 to 1 for each shelf.
- 1.0 — this is what the place is for.
- ${SHELF_FLOOR} to 0.9 — genuinely also this, and worth its own card.
- 0.1 to ${SHELF_FLOOR - 0.1} — true, but not enough to draw a card. Use this generously: it is how a place stays off a shelf it only half belongs on.
- 0 — not this at all.

Only the ${MAX_SHELVES} strongest shelves at or above ${SHELF_FLOOR} are ever drawn, so a place you weight highly on four shelves will still appear on two. The owner's constraint: "we don't want to have lots of duplication between the categories, and that will also annoy people." When two shelves are close, decide which one somebody looking for this place would look under first, and put clear water between them.

Also say what the correction is really about:
- "place" — this one place is unusual and the rule should not travel.
- "kind" — everything of this Wikidata type is the same case (the usual answer when the subject is a type).
- "category" — one of the atlas's own eight words is wrong across the board.
- "experience" — an OpenStreetMap experience tag is wrong across the board.

Answer with the weights, the scope, and one plain sentence giving the reason, written so somebody reading the rule in six months knows why it is there. Do not repeat the instructions back.`;

/** What the shelves are called, for the sentence handed to the model. */
const named = (weights) => MOODS
  .map((m) => `${m.label} ${Number(weights?.[m.key] ?? 0).toFixed(2)}`)
  .join(', ');

export async function readTeaching({ said, subject, subjectLabel, scope, current, householdId }) {
  // Said plainly rather than as an SDK stack trace. The key is injected by
  // Doppler on the deployed API and is absent from a local checkout by design,
  // so this is the ordinary state of the button on a laptop.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw Object.assign(
      new Error('No Claude key on this API, so the sentence cannot be read. Type the numbers below instead — they do the same thing.'),
      { status: 503, code: 'no_model_key' },
    );
  }

  const lines = [
    subjectLabel || subject ? `The subject: ${subjectLabel ?? subject}${subject && subjectLabel ? ` (${subject})` : ''}.` : null,
    scope ? `Roam thinks this is a rule about a ${scope}.` : null,
    current ? `Where it sits today: ${named(current)}.` : null,
    '',
    'What the owner says about it:',
    said,
  ].filter((l) => l !== null);

  const parsed = await parseStructured({
    system: SYSTEM,
    messages: [{ role: 'user', content: lines.join('\n') }],
    schema: Proposal,
    householdId,
    // The back office is not a planning session, so there is no session to
    // bound this against; the household's monthly bound still holds.
    sessionId: null,
    purpose: 'shelves.teach',
    effort: 'low',
    maxTokens: 1024,
  });

  const { scope: proposedScope, reason, ...weights } = parsed;
  return {
    scope: scope || proposedScope,
    suggestedScope: proposedScope,
    reason,
    weights,
  };
}

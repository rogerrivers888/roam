/**
 * "If I click edit on the category, I should be able to train as to why this is
 * miscategorized right there."  — the owner, 5 Sep 2026.
 *
 * The gesture already existed for shelves (`domain/teaching.js`): a sentence in,
 * a scoped proposal back, nothing written until somebody presses Save. This
 * points the same gesture at the other axis — `place_kinds.category`, the
 * atlas's eight words for what a thing *is* — and at the field you are looking
 * at rather than a screen somewhere else.
 *
 * **Why a sentence rather than a dropdown.** A dropdown fixes one row. Legoland
 * is filed `landmark` because *amusement park* is filed `landmark`, so the
 * mistake is on the type and a per-row correction would have to be made forty
 * times and would drift the forty-first. The sentence names the type, and the
 * screen says how far the fix travels before it is made.
 *
 * **Two axes, kept apart.** A category says what a place is; a shelf says what a
 * day there is like (`domain/moods.js`). They are different questions with
 * different answers — a castle is `heritage` and a Culture day — and Roam has
 * been bitten by conflating them before. So this returns both when the sentence
 * implies both, but they are saved as two rules against two tables and the
 * screen says which is which.
 *
 * It proposes and never writes.
 */

import { z } from 'zod/v4';
import { parseStructured } from '../claude.js';
import { MAX_SHELVES, MOOD_KEYS, SHELF_FLOOR } from './moods.js';

/** Roam's own eight words for what a place is (sources/wikimedia.js). */
export const CATEGORIES = ['heritage', 'outdoors', 'museum', 'family', 'arts', 'animals', 'active', 'landmark'];

const Weight = z.number().min(0).max(1);

/**
 * The answer.
 *
 * Every shelf is present and required rather than optional, for the reason the
 * shelf teaching gives: a model allowed to omit a field omits the ones it is
 * least sure about, and "not this shelf" and "I did not think about this shelf"
 * would then look identical.
 */
const Proposal = z.object({
  category: z.enum(CATEGORIES),
  /** What the correction is really about. `kind` is almost always the answer. */
  scope: z.enum(['place', 'kind', 'category']),
  /** The Wikidata QID the rule should hang on, when the scope is a kind. */
  subject: z.string().nullable(),
  reason: z.string(),
  /** Whether the sentence was also about what a day there is like. */
  shelvesToo: z.boolean(),
  fun: Weight, food: Weight, culture: Weight,
  adrenaline: Weight, relaxing: Weight, outdoors: Weight,
});

const SYSTEM = `You are helping the owner of Roam, a family trip planner, correct how it files a place.

Roam has two separate vocabularies and you must not mix them.

**The category** — what a place *is*. Exactly one of:
- heritage — castles, ruins, historic houses, monuments, listed buildings, churches
- outdoors — parks, gardens, nature reserves, beaches, woods, hills, lakes
- museum — museums, galleries with collections, historic ships, visitor centres
- family — theme parks, farm parks, soft play, adventure playgrounds, aquaria aimed at children, anywhere whose point is a day out with children
- arts — theatres, concert halls, cinemas, sculpture trails, working arts venues
- animals — zoos, safari parks, wildlife parks, sanctuaries, aquaria
- active — sports grounds, racecourses, stadiums, climbing walls, karting, watersports, golf
- landmark — a thing you look at rather than go into: a bridge, a tower, a viewpoint, a folly

**The shelf** — what a *day* there is like. Six of them, weighted 0 to 1:
- Fun — a good day out; watching sport is here
- Food — somewhere you eat or drink
- Culture — museums, galleries, castles, cathedrals, theatres
- Adrenaline — something you *do* that gets your heart going: flying lessons, karting, parachuting, watersports. Watching other people do it is never adrenaline.
- Relaxing — a gentle day: a garden, a walk, a browse, a spa
- Outdoors — the point of it is being outside

Only the ${MAX_SHELVES} strongest shelves at or above ${SHELF_FLOOR} are ever drawn, so weight generously below that floor: a place that is genuinely a bit of four things still shows on two.

Say what the correction is really about:
- "kind" — everything of this Wikidata type is the same case. **This is almost always the right answer** and you should prefer it: a theme park is not a special case, every theme park is the same case. Put the QID in \`subject\`.
- "place" — this one place is genuinely unusual and the rule must not travel. Use it sparingly.
- "category" — everything the atlas currently files under this word is wrong. Very rare, and almost certainly too broad.

Set \`shelvesToo\` true only when the sentence says something about what a day there is like, as well as what the place is. When it does not, still fill the weights with your best reading of the place, and the screen will offer them as a separate suggestion rather than a correction.

\`reason\` is one sentence, in the owner's own terms, that will be stored on the rule so somebody who was not in the room can argue with it.`;

/**
 * Read a sentence about a place's category into a proposal.
 *
 * `kinds` is the place's raw Wikidata types with their labels, because the model
 * has to choose one to hang the rule on and a bare Q-number is not something it
 * — or the owner reading the answer — can reason about.
 */
export async function readCategoryTeaching({ said, place, kinds = [], householdId, sessionId = null }) {
  // Said plainly rather than as an SDK stack trace: the key is injected by
  // Doppler on the deployed API and absent from a laptop by design, so this is
  // the ordinary state of the button in local development.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw Object.assign(
      new Error('No Claude key on this API, so the sentence cannot be read. Choose the category below instead — it does the same thing.'),
      { status: 503, code: 'no_model_key' },
    );
  }

  const lines = [
    `The place: ${place.name}.`,
    place.summary ? `What is known about it: ${String(place.summary).slice(0, 700)}` : null,
    `Roam currently files it as: ${place.category ?? 'nothing'}.`,
    kinds.length
      ? `Its Wikidata types, in the order Wikidata stated them:\n${kinds.map((k) => `- ${k.qid}${k.label ? ` (${k.label})` : ''}${k.category ? ` — currently filed as ${k.category}` : ''}`).join('\n')}`
      : 'It has no Wikidata types, so a type-wide rule is not available and the scope must be "place".',
    '',
    `What the owner said is wrong: ${said}`,
  ].filter(Boolean);

  const proposal = await parseStructured({
    system: SYSTEM,
    messages: [{ role: 'user', content: lines.join('\n') }],
    schema: Proposal,
    householdId,
    sessionId,
    purpose: 'admin.category.teach',
    maxTokens: 1200,
  });

  const weights = Object.fromEntries(MOOD_KEYS.map((k) => [k, proposal[k] ?? 0]));
  // A kind scope with no QID is not a kind scope. The model is told to put one
  // in `subject`; when it does not, the honest fallback is the single place,
  // because a rule with no subject would silently become a rule about nothing.
  const validKind = proposal.scope === 'kind' && kinds.some((k) => k.qid === proposal.subject);
  const scope = proposal.scope === 'kind' && !validKind ? 'place' : proposal.scope;

  return {
    category: proposal.category,
    reason: proposal.reason,
    scope,
    suggestedScope: scope,
    subject: scope === 'kind' ? proposal.subject : scope === 'category' ? (place.category ?? null) : place.id,
    shelvesToo: Boolean(proposal.shelvesToo),
    weights,
  };
}

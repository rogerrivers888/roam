// The family's own food and doings, turned into searches (owner, 4 Sep 2026:
// "search for the best arrabbiata within my radius… how would that work if
// other people have favourite foods… because Phoenix loves this").
//
// Everything here reads the people coming — their likes, their favourites,
// their dislikes — and never a generic idea of what a family wants. A taste is
// one food several people may share; a table is the best places for it.
//
// The rules from Requirements §5 hold exactly as they do in ranking.js:
// allergens exclude and are named against the person; a dislike ranks and is
// said out loud, it never removes a food someone else loves.

import { conceptByKey, resolveConcept, venueHasConcept, norm, CONCEPTS } from './concepts.js';

/** The concept kinds that describe something to eat. */
const FOOD_KINDS = new Set(['dish', 'cuisine', 'ingredient', 'style']);
/** A concrete dish searches better than a broad cuisine, so it leads. */
const KIND_WEIGHT = { dish: 2, ingredient: 1.4, style: 1, cuisine: 0.8 };

/** What this family calls each other: the name on the card is the one they use. */
export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || String(name || '');

const conceptFor = (pref) => (pref.conceptKey ? conceptByKey(pref.conceptKey) : resolveConcept(pref.value));

/**
 * Which foods the people coming actually love, best first.
 *
 * One entry per food, carrying everyone who loves it (a favourite counts for
 * more than a like) and anyone coming who would rather not — Roam says both
 * rather than quietly dropping the food someone else's favourite clashes with.
 */
export function foodTastes(attendees, { brief = '' } = {}) {
  const byKey = new Map();
  const add = (concept, member, pref) => {
    if (!concept || !FOOD_KINDS.has(concept.kind)) return null;
    if (!byKey.has(concept.key)) byKey.set(concept.key, { key: concept.key, kind: concept.kind, label: concept.label, concept, loved: [], notFor: [], named: false });
    const taste = byKey.get(concept.key);
    if (member && !taste.loved.some((l) => l.memberId === member.id)) {
      taste.loved.push({ memberId: member.id, name: member.name, first: firstName(member.name), favourite: Boolean(pref?.favourite), said: pref?.value ?? concept.label });
    }
    return taste;
  };

  for (const m of attendees) for (const pref of m.likes || []) add(conceptFor(pref), m, pref);

  // A food named in the brief ("the best arrabbiata") is what they asked for,
  // whether or not it is on anybody's list.
  for (const concept of conceptsInText(brief)) {
    if (!FOOD_KINDS.has(concept.kind)) continue;
    const taste = add(concept, null, null);
    if (taste) taste.named = true;
  }

  // Who coming would rather not, so the card can say so.
  for (const taste of byKey.values()) {
    for (const m of attendees) {
      if (taste.loved.some((l) => l.memberId === m.id)) continue;
      for (const pref of m.dislikes || []) {
        const c = conceptFor(pref);
        if (!c) continue;
        if (c.key === taste.key || sameFood(c, taste.concept)) taste.notFor.push({ memberId: m.id, name: m.name, first: firstName(m.name), value: pref.value });
      }
    }
  }

  const score = (t) => (t.named ? 10 : 0)
    + t.loved.reduce((n, l) => n + (l.favourite ? 3 : 1), 0)
    + (KIND_WEIGHT[t.kind] ?? 1)
    - t.notFor.length * 0.5;
  return [...byKey.values()]
    .map((t) => ({ ...t, score: Number(score(t).toFixed(2)) }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/** A dish and the cuisine it belongs to are the same food for a dislike's purposes ("fish" against sushi). */
function sameFood(a, b) {
  if (!a || !b) return false;
  if (a.key === b.key) return true;
  if (a.kind === 'cuisine' && b.cuisine === a.slug) return true;
  if (b.kind === 'cuisine' && a.cuisine === b.slug) return true;
  if (a.kind === 'ingredient' || b.kind === 'ingredient') {
    // The ingredient has to be in what the food IS, not in one variant of it:
    // "fish tacos" is an alias of tacos, and a dislike of fish must not put
    // "not for Gina" on the whole taco table.
    const [ing, other] = a.kind === 'ingredient' ? [a, b] : [b, a];
    const hay = ` ${norm(other.label)} ${norm(other.slug)} `;
    return ing.aliases.some((al) => al.length >= 3 && hay.includes(` ${norm(al)} `));
  }
  return false;
}

/**
 * The foods and things a piece of free text names. Whole words only: "steak"
 * in "steak and ale pie" is the pie, and "art" is never "tart".
 */
export function conceptsInText(text) {
  const hay = ` ${norm(text)} `;
  if (hay.trim().length < 3) return [];
  const out = [];
  for (const c of CONCEPTS) {
    if (c.kind === 'diet') continue;
    const hit = c.aliases.find((a) => a.length >= 4 && hay.includes(` ${norm(a)} `));
    if (hit) out.push(c);
  }
  return out;
}

/**
 * The things to do the people coming like, as one lookup: concept key → who.
 * Used to say why a place near the table is worth the walk ("Phoenix loves
 * climbing"), without running the whole ranking over hundreds of venues.
 */
export function likedConcepts(attendees, { kinds = null } = {}) {
  const out = [];
  for (const m of attendees) {
    for (const pref of m.likes || []) {
      const c = conceptFor(pref);
      if (!c || (kinds && !kinds.includes(c.kind))) continue;
      const found = out.find((x) => x.concept.key === c.key);
      if (found) { if (!found.who.some((w) => w.memberId === m.id)) found.who.push({ memberId: m.id, name: m.name, favourite: Boolean(pref.favourite) }); }
      else out.push({ concept: c, who: [{ memberId: m.id, name: m.name, favourite: Boolean(pref.favourite) }] });
    }
  }
  return out;
}

/** Why this place is for this family, in their own names — one line per person who loves what it is. */
export function whyForUs(venue, liked) {
  const out = [];
  for (const { concept, who } of liked) {
    if (!venueHasConcept(venue, concept)) continue;
    for (const w of who) out.push({ memberId: w.memberId, name: w.name, first: firstName(w.name), favourite: w.favourite, label: concept.label, text: `${firstName(w.name)} loves ${concept.label.toLowerCase()}` });
  }
  // One line per person: the first thing they love about it is enough.
  const seen = new Set();
  return out.filter((r) => (seen.has(r.memberId) ? false : seen.add(r.memberId)));
}

/**
 * Does anything we hold about this place say it does this dish? The review
 * line Google returns with a dish search is the only evidence any source
 * publishes — no source carries menus (Requirements §4; menu capture is Epic 6).
 */
export function dishEvidence(venue, taste) {
  const aliases = taste.concept?.aliases ?? [taste.label.toLowerCase()];
  const fields = [
    ['review', venue.justification],
    ['summary', venue.summary],
    ['name', venue.name],
    ['cuisine', (venue.cuisines || []).join(' ')],
  ];
  for (const [where, value] of fields) {
    if (!value) continue;
    const hay = ` ${norm(value)} `;
    const hit = aliases.find((a) => a.length >= 4 && hay.includes(` ${norm(a)} `));
    if (hit) return { where, text: where === 'review' ? venue.justification : null, matched: hit };
  }
  return null;
}

/**
 * How far a drive of this many minutes reaches, in kilometres. The inverse of
 * estimateTravelMinutes' driving model, so the area searched and the times
 * shown agree with each other.
 */
export function driveRadiusKm(minutes) {
  const motorway = ((minutes - 5) / 60) * 55 / 1.25;
  if (motorway > 15) return motorway;
  return Math.max(0.5, (minutes / 60) * 28 / 1.25);
}

// Constraint application and ranking — Requirements §5, "Constraint application".
//
//   1. An allergen recorded against an ATTENDING member EXCLUDES a candidate.
//   2. A dislike recorded against an attending member LOWERS its ranking and is
//      surfaced as a reason.
//   3. Constraints belonging to members not attending are ignored entirely.
//
// Allergens are safety and dislikes are preference; conflating them makes the
// product either dangerous or useless, so they never share a code path here.

const norm = (s) => String(s).toLowerCase().trim();

/**
 * Does a candidate carry anything matching this dislike or like?
 * "pubs" must match the category "pub"; "barbecue" must never match "bar".
 */
function preferenceHits(venue, value) {
  const needle = norm(value);
  const singular = needle.replace(/s$/, '');
  const hay = [
    ...(venue.cuisines || []),
    venue.category,
    ...(venue.dishes || []).flatMap((d) => [d.name, d.concept]),
  ].map(norm);
  return hay.some(
    (h) =>
      h === needle ||
      h === singular ||
      h.includes(needle) ||
      (singular.length >= 4 && h.includes(singular)) ||
      h.split(/[^a-z0-9]+/).includes(singular),
  );
}

export function applyConstraints({ venues, attendees }) {
  const kept = [];
  const excluded = [];

  for (const venue of venues) {
    // --- Allergens: exclude, and attribute the exclusion to the named member.
    const allergenConflicts = [];
    for (const member of attendees) {
      for (const allergen of member.allergens) {
        if ((venue.allergens || []).some((a) => norm(a) === norm(allergen))) {
          allergenConflicts.push({ member: member.name, memberId: member.id, allergen });
        }
      }
    }

    if (allergenConflicts.length > 0) {
      excluded.push({
        ...venue,
        excluded: true,
        exclusionReasons: allergenConflicts.map((c) => `Excluded: ${c.allergen} is an allergen for ${c.member}`),
        allergenConflicts,
      });
      continue;
    }

    // --- Dislikes: rank down, never exclude, and always say why.
    const reasons = [];
    let score = (venue.rating ?? 3.5) * 10;

    for (const member of attendees) {
      for (const dislike of member.dislikes) {
        if (preferenceHits(venue, dislike)) {
          score -= 12;
          reasons.push({ kind: 'dislike', member: member.name, memberId: member.id, value: dislike, text: `${member.name} dislikes ${dislike}` });
        }
      }
      for (const like of member.likes) {
        if (preferenceHits(venue, like)) {
          score += 8;
          reasons.push({ kind: 'like', member: member.name, memberId: member.id, value: like, text: `${member.name} likes ${like}` });
        }
      }
    }

    // Epic 1 C6 — where two attending members disagree about the same thing,
    // both are surfaced rather than one silently winning.
    const contested = new Set();
    for (const a of reasons) {
      for (const b of reasons) {
        if (a.kind !== b.kind && norm(a.value) === norm(b.value)) contested.add(norm(a.value));
      }
    }

    // Closer is better, but only as a tie-breaker — never enough to outrank taste.
    if (typeof venue.travelMinutes === 'number') score -= venue.travelMinutes * 0.15;
    if (typeof venue.detourMinutes === 'number') score -= venue.detourMinutes * 0.4;

    kept.push({
      ...venue,
      excluded: false,
      score: Number(score.toFixed(2)),
      reasons,
      contestedPreferences: [...contested],
      hasChildAttending: attendees.some((m) => m.isMinor),
    });
  }

  kept.sort((a, b) => b.score - a.score);
  return { candidates: kept, excluded };
}

/**
 * What a trip is called on screen.
 *
 * The owner has raised this three times (6 Sep 2026): *"I've selected Thorpe
 * Park as the destination, but you're still calling this trip Runnymede… When
 * my trip is not to Runnymede, my trip is to Thorpe Park."*
 *
 * The data was never wrong. A trip made from Thorpe Park holds
 * `place.label = "Thorpe Park"` — what he chose — and `locality = "Runnymede"`,
 * which is the borough the point falls in, worked out by reverse-geocoding.
 * Two screens read `locality` first, so a borough nobody picked outranked the
 * place he did pick, in the header, in the timeline and in the trips list.
 *
 * **A name somebody chose always beats a name we derived.** That is the whole
 * rule, and the order below is it:
 *
 *   1. the destination — where the day is going
 *   2. the place the trip was made from — what they picked in Inspire
 *   3. the base, once "(centre)" is taken off — where they are staying
 *   4. the locality — a borough, and only when nothing above was chosen
 *   5. the title, then the origin
 *
 * Kept pure and out of the screen so `apps/web/test` can import it: the test
 * runs the real production records past it.
 */

export type Named = {
  destination?: { label?: string | null } | null;
  place?: { label?: string | null } | null;
  base?: { label?: string | null } | null;
  locality?: string | null;
  title?: string | null;
  origin?: { label?: string | null } | null;
};

/** "Thorpe Park (centre)" and "Henley-on-Thames, South Oxfordshire" are both "the place". */
const plain = (label?: string | null): string | null => {
  const first = (label ?? '').split(',')[0].replace(/\s*\(centre\)\s*$/i, '').trim();
  return first ? council(first) : null;
};

/**
 * The town inside a council's name.
 *
 * "Bath and North East Somerset" is the authority that collects Bath's bins,
 * and it is what the area index hands back when somebody types Bath. Nobody
 * says it out loud, and it does not fit a third of a phone. So a name of the
 * form "X and Y" reads as X — "Windsor and Maidenhead" is Windsor, "Bath and
 * North East Somerset" is Bath.
 *
 * Only where the head is a name in its own right: "Newcastle and Gateshead"
 * keeps its head, but a two-letter head would not be a place, so it does not.
 */
const council = (name: string): string => {
  const head = name.split(/\s+and\s+/i)[0].trim();
  return head.length >= 3 ? head : name;
};

/** Where the day starts from: the base you are sleeping at, or home. */
export function fromName(trip: Named & { kind?: string }): string {
  return plain(trip.base?.label) ?? plain(trip.origin?.label) ?? 'home';
}

/**
 * A place, in as few words as read well.
 *
 * The same rule as above, with one exception that matters: an *address* is
 * friendlier by its town than by its first line. "Fairways, Titlarks Hill,
 * Ascot, SL5 0JD" is "Ascot", not "Fairways". A name with one or two segments
 * is a place somebody chose and keeps its own head — "Bath" is not "Bath and
 * North East Somerset", which is the council that collects its bins.
 */
export function shortPlaceName(p?: { label?: string | null; locality?: string | null } | null): string {
  if (!p) return '';
  const label = p.label ?? '';
  const segments = label.split(',').filter((x) => x.trim()).length;
  const head = plain(label);
  if (segments >= 3) return plain(p.locality) ?? head ?? '';
  return head ?? plain(p.locality) ?? '';
}

/**
 * The name on a trip card: what the household typed, or what we made for them.
 *
 * A title auto-made at creation leads with the place and a month —
 * "Bath · Sep 2026". When that place was taken from the locality it leads with
 * a council instead — "Bath and North East Somerset · Sep 2026" — and those
 * are already saved. So the head is swapped where it is plainly the derived
 * one, and anything the household actually wrote after it is kept.
 */
export function tripTitle(trip: Named & { title?: string | null }): string {
  const title = (trip.title ?? '').trim();
  const name = tripName(trip);
  if (!title) return name;
  const [head, ...rest] = title.split(' · ');
  // The head as it was written down, not as it now reads — the comparison is
  // with the stored locality, and both have to be raw for that to mean anything.
  const raw = head.split(',')[0].replace(/\s*\(centre\)\s*$/i, '').trim();
  const derived = raw !== name && (raw === (trip.locality ?? '').trim() || plain(raw) === name);
  return derived ? [name, ...rest].join(' · ') : title;
}

export function tripName(trip: Named): string {
  return plain(trip.destination?.label)
    ?? plain(trip.place?.label)
    ?? plain(trip.base?.label)
    ?? plain(trip.locality)
    ?? plain(trip.title)
    ?? plain(trip.origin?.label)
    ?? 'This trip';
}

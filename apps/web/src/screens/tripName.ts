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
  return first || null;
};

/** Where the day starts from: the base you are sleeping at, or home. */
export function fromName(trip: Named & { kind?: string }): string {
  return plain(trip.base?.label) ?? plain(trip.origin?.label) ?? 'home';
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

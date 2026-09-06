/**
 * How tall the sheet over the map is, at each of its three stops.
 *
 * Its own file, with nothing imported into it, so the arithmetic can be tested
 * without a React tree or react-native behind it — the same reason `routes.ts`
 * is separate from `router.tsx`.
 *
 * The numbers are the handoff's (6 Sep 2026): peek 112px is the header alone,
 * half is 470, and full stops 60px from the top of the screen. The two guards
 * are for the sizes a phone never has and a browser window often does — a short
 * window must not end up with a `half` taller than its `full`, and a very short
 * one must still leave something to take hold of.
 */

export type Detent = 'peek' | 'half' | 'full';
export const DETENTS: Detent[] = ['peek', 'half', 'full'];

export function detentHeights(screenHeight: number, insetBottom: number): Record<Detent, number> {
  const full = Math.max(320, screenHeight - 60 - insetBottom);
  // 470 on the 844-tall phone the handoff draws, and two thirds of whatever is
  // there on anything else — so a short window shrinks the half rather than
  // ending up with a half taller than its full.
  return { peek: Math.min(112, full), half: Math.min(470, Math.round(full * 0.66)), full };
}

import { Platform } from 'react-native';

/**
 * Where you were, when you come back (owner, 4 Sep 2026).
 *
 * > "When I click Inspire me, for example, and I do a search, and then I come
 * > back 10 minutes later after navigating off that tab, everything's
 * > disappeared. Surely we can at least save that data for the day until I come
 * > back, and then I can have an option to refresh it should I wish."
 *
 * Switching tabs unmounts the whole screen (App.tsx renders one at a time), so
 * every bit of state went with it — the brief, the mood trail, the ideas, the
 * tables. The ideas themselves were never lost: they are on the planning
 * session on the server, for twelve hours. What was lost was the app's memory
 * of *which* session it had been showing.
 *
 * So that is all this keeps: the identifier, and the words the household typed
 * or tapped. Nothing a provider gave us is written here — the ideas are fetched
 * back from the session, which costs nothing, and this file is not the place a
 * new decision about licensed content should ever be made (offline/policy.ts
 * is). Keeping only the identifier is also what makes "Refresh" honest: the
 * screen can say how old the answer is, because it went and asked.
 *
 * Twelve hours, to match how long the server keeps the session. A run started
 * this morning is still there this evening; yesterday's is not, and asking for
 * it would only produce a 404.
 */

const PREFIX = 'roam.screen.';
const LIFE_MS = 12 * 3600_000;

const store = (): Storage | null =>
  (Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage : null);

type Held<T> = { savedAt: string; data: T };

/** Remember where this screen was. Pass null to forget it. */
export function rememberScreen<T>(name: string, data: T | null): void {
  const s = store();
  if (!s) return;
  try {
    if (data == null) s.removeItem(PREFIX + name);
    else s.setItem(PREFIX + name, JSON.stringify({ savedAt: new Date().toISOString(), data } satisfies Held<T>));
  } catch { /* a full or blocked store just means the screen starts empty */ }
}

/**
 * Where this screen was, and how long ago — or null if it was never here, or
 * was here yesterday.
 */
export function recallScreen<T>(name: string): { data: T; savedAt: string; ageMs: number } | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + name);
    if (!raw) return null;
    const held = JSON.parse(raw) as Held<T>;
    const ageMs = Date.now() - new Date(held.savedAt).getTime();
    if (!(ageMs >= 0) || ageMs > LIFE_MS) { s.removeItem(PREFIX + name); return null; }
    return { data: held.data, savedAt: held.savedAt, ageMs };
  } catch { return null; }
}

/** "just now", "10 minutes ago", "3 hours ago" — for the line that offers a refresh. */
export function howLongAgo(ageMs: number): string {
  const mins = Math.round(ageMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return 'a minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
}

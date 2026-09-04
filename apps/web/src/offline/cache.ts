/**
 * Everything they have seen, kept.
 *
 * Owner, 4 Sep 2026: "Sometimes, often, users will be offline or not have
 * signal. It's very important to me that when a user does research, that
 * research is stored: the hotels, the activities, the restaurants. They do not
 * have to research every time they come back to the page."
 *
 * So every answer the app is given, if the licence allows it (offline/policy.ts),
 * is written to the device as it arrives. When a request cannot be made — no
 * signal, aeroplane mode, the API down — the saved answer is served instead and
 * the screen says so. Nothing here changes what a screen renders: it is the same
 * shape from the same endpoint, only older.
 *
 * `warm()` goes further and fetches the pages the household has not opened this
 * session, so that a phone put in a pocket at home has the whole atlas, every
 * trip and every owned place record on it before the signal goes.
 */

import { storable } from './policy';
import { getAnswer, putAnswer, allAnswers, forgetEverything, getMeta, setMeta, keepCopy, roomUsed, offlineStorageAvailable } from './store';

export type OfflineStatus = {
  /** Whether the browser thinks there is a connection. */
  online: boolean;
  /** Whether anything on screen right now came from the saved copy. */
  serving: boolean;
  /** How many answers are held, and when the copy was last filled. */
  pages: number;
  filledAt: string | null;
  /** Set while warm() is running. */
  filling: boolean;
  fillProgress: { done: number; total: number } | null;
  usedBytes: number | null;
  /** Whether the browser has agreed not to evict the copy. */
  kept: boolean;
  available: boolean;
};

let status: OfflineStatus = {
  online: true, serving: false, pages: 0, filledAt: null, filling: false,
  fillProgress: null, usedBytes: null, kept: false, available: offlineStorageAvailable(),
};

const listeners = new Set<(s: OfflineStatus) => void>();
const publish = (patch: Partial<OfflineStatus>) => {
  status = { ...status, ...patch };
  listeners.forEach((l) => l(status));
};

export const offlineStatus = () => status;
export function onOfflineChange(fn: (s: OfflineStatus) => void) {
  listeners.add(fn);
  fn(status);
  return () => { listeners.delete(fn); };
}

// ---------------------------------------------------------------------------
// reading and writing
// ---------------------------------------------------------------------------

/** Save an answer, if this endpoint's answers may be saved. Never throws. */
export async function remember(path: string, body: unknown): Promise<void> {
  try {
    const keepable = storable(path, body);
    if (keepable == null) return;
    await putAnswer(path, keepable);
    // The count is only refreshed occasionally: it is a number on a settings
    // card, not something worth a database read on every request.
    if (status.pages === 0) void refreshCounts();
  } catch { /* an offline copy that cannot be written is not an error the household needs */ }
}

/** The saved answer for a path, or null. */
export async function recall<T>(path: string): Promise<{ body: T; savedAt: string } | null> {
  try {
    const hit = await getAnswer<T>(path);
    return hit ? { body: hit.body, savedAt: hit.savedAt } : null;
  } catch { return null; }
}

/** Say that a screen is showing saved data, so the banner can appear. */
export const servingSaved = (on: boolean) => { if (status.serving !== on) publish({ serving: on }); };

// ---------------------------------------------------------------------------
// filling it
// ---------------------------------------------------------------------------

let warming: Promise<void> | null = null;

/**
 * Fetch everything worth having offline. The API says what that is
 * (/api/offline/manifest): the household, the atlas, every city, every trip,
 * the visit history, and every place record Roam owns for the places this
 * household claimed.
 *
 * Sequential on purpose — this runs behind whatever the household is doing and
 * must not compete with it for connections.
 */
export async function warm(fetchJson: (path: string) => Promise<any>, { onlyFree = false } = {}): Promise<void> {
  if (warming) return warming;
  warming = (async () => {
    publish({ filling: true, fillProgress: null });
    try {
      const manifest = await fetchJson('/api/offline/manifest');
      // `free` is everything the API can answer from its own database. The rest
      // can cost a provider call, so it is only fetched when somebody asks.
      const paths: string[] = (onlyFree ? manifest?.free : manifest?.paths) ?? manifest?.paths ?? [];
      let done = 0;
      publish({ fillProgress: { done, total: paths.length } });
      for (const path of paths) {
        try { await fetchJson(path); } catch { /* one page missing is not a failed copy */ }
        done += 1;
        publish({ fillProgress: { done, total: paths.length } });
      }
      await setMeta('filledAt', new Date().toISOString());
      // Ask the browser to hold on to it, now that there is something to hold.
      const kept = await keepCopy();
      publish({ kept });
      await refreshCounts();
    } finally {
      publish({ filling: false, fillProgress: null });
      warming = null;
    }
  })();
  return warming;
}

export async function refreshCounts(): Promise<void> {
  const [answers, filledAt, room] = await Promise.all([allAnswers(), getMeta<string>('filledAt'), roomUsed()]);
  publish({ pages: answers.length, filledAt: filledAt ?? null, usedBytes: room.usedBytes });
}

/** Throw the copy away — Settings, and anything that changes household. */
export async function forgetCopy(): Promise<void> {
  await forgetEverything();
  await setMeta('filledAt', null);
  publish({ pages: 0, filledAt: null, serving: false });
}

// Once a day is enough for the quiet fill: it is the same load as the household
// opening each of their own trips once, and it means a phone that has been in a
// drawer all week still has this week's changes before it loses signal.
const QUIET_FILL_EVERY_MS = 24 * 3600_000;

/**
 * Fill the copy in the background, if it has not been filled today.
 *
 * Runs on start-up, once there is a connection, and never fetches anything that
 * could cost a provider call — see `free` in routes/offline.js.
 */
export async function warmQuietly(fetchJson: (path: string) => Promise<any>): Promise<void> {
  if (!offlineStorageAvailable() || status.filling) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const filledAt = await getMeta<string>('filledAt');
  if (filledAt && Date.now() - new Date(filledAt).getTime() < QUIET_FILL_EVERY_MS) return;
  await warm(fetchJson, { onlyFree: true }).catch(() => null);
}

/** Every owned place record held on this device, for the screens to read directly. */
export async function savedRecords(): Promise<Record<string, any>> {
  const hit = await recall<{ records: Record<string, any> }>('/api/offline/records');
  return hit?.body?.records ?? {};
}

/**
 * The owned record for one place, from the device.
 *
 * A place's own drawer answer is only saved once the household has opened it;
 * the whole set of records arrives in one piece when the copy is filled. So a
 * place shortlisted last week and never opened since still has its address and
 * its phone number on the phone, which is the point.
 */
export async function savedRecord(venueRef: string): Promise<any | null> {
  const records = await savedRecords();
  return records[venueRef] ?? null;
}

// ---------------------------------------------------------------------------
// knowing whether there is signal
// ---------------------------------------------------------------------------

export function watchConnection(): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  const set = () => publish({ online: navigator.onLine !== false, ...(navigator.onLine === false ? {} : {}) });
  set();
  window.addEventListener('online', set);
  window.addEventListener('offline', set);
  void refreshCounts();
  return () => { window.removeEventListener('online', set); window.removeEventListener('offline', set); };
}

/**
 * Writes that have not been sent yet.
 *
 * The device already keeps everything the household has *read* (cache.ts). The
 * other half was missing: a rating typed in a restaurant basement, a stop moved
 * on a train, a note added in a car park — anything written without signal —
 * threw a network error and was gone the moment the screen unmounted. The whole
 * promise at the top of cache.ts was only ever kept in one direction.
 *
 * So a write that cannot be sent is written here first, in the order it was
 * made, and sent when there is signal again. Three rules hold it together:
 *
 *  - **Only what still means the same later.** `queueable` in policy.ts decides;
 *    a planning session's answer is not on the list, because it expires.
 *  - **In order.** The store's key auto-increments, so two edits to the same
 *    trip land the way they were made.
 *  - **Nothing is ever dropped.** A write the server rejects outright is kept
 *    and shown, not discarded. "Never lost" has to include the awkward ones.
 */

import { allPending, countPending, forgetPending, putPending, type Pending } from './store';
import { queueable } from './policy';

export type OutboxStatus = {
  /** Waiting to be sent. */
  waiting: number;
  /** Sent, refused, and still here — the household has to decide what to do. */
  rejected: number;
  /** True while a flush is running. */
  sending: boolean;
};

let status: OutboxStatus = { waiting: 0, rejected: 0, sending: false };
const listeners = new Set<(s: OutboxStatus) => void>();

const publish = (patch: Partial<OutboxStatus>) => {
  status = { ...status, ...patch };
  listeners.forEach((l) => l(status));
};

export const outboxStatus = () => status;
export function onOutboxChange(fn: (s: OutboxStatus) => void) {
  listeners.add(fn);
  fn(status);
  return () => { listeners.delete(fn); };
}

export async function refreshOutbox(): Promise<void> {
  const all = await allPending();
  publish({ waiting: all.filter((p) => !p.rejected).length, rejected: all.filter((p) => p.rejected).length });
}

/**
 * How long an identical write counts as the same tap rather than a new one.
 *
 * A queued write does not change what is on screen, so somebody with no signal
 * taps the star again — and without this, that is two visits, not one. Only an
 * exact match counts (same verb, same path, same body) and only within the
 * minute: beyond that, two identical writes are two things the household meant,
 * and keeping both is the safer way to be wrong.
 */
const DOUBLE_TAP_MS = 60_000;

/**
 * Keep a write for later. Returns false when it could not be kept — no
 * IndexedDB (private browsing), or this path is not one that may wait — and the
 * caller must then tell the household the write did not happen.
 */
export async function queue(method: string, path: string, body: unknown): Promise<boolean> {
  if (!queueable(method, path)) return false;
  const verb = method.toUpperCase();

  const already = (await allPending()).some((p) => (
    !p.rejected
    && p.method === verb
    && p.path === path
    && JSON.stringify(p.body ?? null) === JSON.stringify(body ?? null)
    && Date.now() - new Date(p.queuedAt).getTime() < DOUBLE_TAP_MS
  ));
  if (already) { await refreshOutbox(); return true; }

  const entry: Pending = { method: verb, path, body, queuedAt: new Date().toISOString(), tries: 0 };
  const key = await putPending(entry);
  if (key == null) return false;
  await refreshOutbox();
  return true;
}

/** Statuses that mean "the server heard you and said no" rather than "not now". */
const refused = (status: number) => status >= 400 && status < 500 && ![401, 408, 425, 429].includes(status);

let flushing: Promise<void> | null = null;

/**
 * Send everything waiting, oldest first.
 *
 * Stops at the first one that cannot be sent at all, so order is never broken by
 * skipping ahead. `send` is the app's own request function, so a replayed write
 * carries the session header exactly as a live one would.
 */
export async function flush(send: (method: string, path: string, body: unknown) => Promise<unknown>): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    publish({ sending: true });
    try {
      const all = (await allPending()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      for (const entry of all) {
        if (entry.rejected || entry.id == null) continue;
        try {
          await send(entry.method, entry.path, entry.body);
          await forgetPending(entry.id);
        } catch (err: any) {
          const status = Number(err?.status) || 0;
          if (status === 401) {
            // Signed out. Everything stays exactly where it is and goes when
            // they sign in again — being signed out must not cost anybody a
            // week of ratings.
            await putPending({ ...entry, tries: entry.tries + 1, lastError: 'Waiting until you sign in again.' });
            break;
          }
          if (refused(status)) {
            // The server understood and refused: a trip that has since been
            // deleted, a stop that is no longer there. Replaying it again will
            // never work, so it stops being retried — but it is kept, with what
            // the server said, and Settings shows it. Nothing is thrown away
            // without the household seeing it.
            await putPending({ ...entry, tries: entry.tries + 1, rejected: true, lastError: err?.message || `Refused (${status})` });
            continue;
          }
          // No signal, or the API is down. Leave it and stop: the next one may
          // depend on this one having landed.
          await putPending({ ...entry, tries: entry.tries + 1, lastError: err?.message || 'No signal' });
          break;
        }
      }
    } finally {
      await refreshOutbox();
      publish({ sending: false });
      flushing = null;
    }
  })();
  return flushing;
}

/**
 * Give up on the writes the server refused.
 *
 * Only ever from Settings, only ever by a person who has been shown what they
 * are. Nothing in the app calls this on the household's behalf.
 */
export async function discardRejected(): Promise<void> {
  const all = await allPending();
  for (const p of all) if (p.rejected && p.id != null) await forgetPending(p.id);
  await refreshOutbox();
}

/** What is waiting, for the line Settings shows. Never the bodies. */
export async function pendingSummary(): Promise<{ id: number; method: string; path: string; queuedAt: string; rejected: boolean; lastError: string | null }[]> {
  const all = await allPending();
  return all
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    .map((p) => ({ id: p.id as number, method: p.method, path: p.path, queuedAt: p.queuedAt, rejected: Boolean(p.rejected), lastError: p.lastError ?? null }));
}

export { countPending };

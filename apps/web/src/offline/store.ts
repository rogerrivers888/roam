/**
 * The device's own copy, in IndexedDB.
 *
 * Small on purpose: two object stores, one for answers the app has already been
 * given and one for a handful of facts about the copy itself (when it was last
 * filled, what it holds). No dependency — a wrapper this size is easier to read
 * than the library that would replace it, and the bundle carries no provider
 * key or storage SDK (Technical Constraints §13.7).
 *
 * Everything here is per-browser. Nothing is encrypted, so nothing that is not
 * already on the household's own screen may be written: see offline/policy.ts,
 * which decides that and is the only thing allowed to call `put`.
 */

const DB = 'roam-offline';
const VERSION = 1;
const ANSWERS = 'answers';
const META = 'meta';

export type Answer<T = unknown> = { path: string; body: T; savedAt: string };

const available = () => typeof indexedDB !== 'undefined';

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (!available()) return Promise.resolve(null);
  if (opening) return opening;
  opening = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB, VERSION); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ANSWERS)) db.createObjectStore(ANSWERS, { keyPath: 'path' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    // A browser in private mode, or one that has run out of room, simply has no
    // offline copy. The app must still work, so this never throws.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return open().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      let req: IDBRequest;
      try { req = fn(db.transaction(store, mode).objectStore(store)); } catch { resolve(null); return; }
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(null);
    });
  });
}

export const getAnswer = <T,>(path: string) => run<Answer<T>>(ANSWERS, 'readonly', (s) => s.get(path));
export const putAnswer = <T,>(path: string, body: T) =>
  run<IDBValidKey>(ANSWERS, 'readwrite', (s) => s.put({ path, body, savedAt: new Date().toISOString() } satisfies Answer<T>));
export const allAnswers = () => run<Answer[]>(ANSWERS, 'readonly', (s) => s.getAll()).then((a) => a ?? []);
export const answerPaths = () => run<IDBValidKey[]>(ANSWERS, 'readonly', (s) => s.getAllKeys()).then((k) => (k ?? []).map(String));
export const forgetAnswer = (path: string) => run(ANSWERS, 'readwrite', (s) => s.delete(path));
export const forgetEverything = () => run(ANSWERS, 'readwrite', (s) => s.clear());

export const getMeta = <T,>(key: string) => run<T>(META, 'readonly', (s) => s.get(key));
export const setMeta = <T,>(key: string, value: T) => run(META, 'readwrite', (s) => s.put(value, key));

/** How much room the copy is taking, when the browser will say. */
export async function roomUsed(): Promise<{ usedBytes: number | null; quotaBytes: number | null }> {
  try {
    const e = await (navigator as any)?.storage?.estimate?.();
    return { usedBytes: e?.usage ?? null, quotaBytes: e?.quota ?? null };
  } catch { return { usedBytes: null, quotaBytes: null }; }
}

/**
 * Ask the browser not to evict the copy when it is short of room. Chrome grants
 * this silently to an installed app; Safari asks. Either way it is a request,
 * not a guarantee, which is why nothing irreplaceable is ever only here.
 */
export async function keepCopy(): Promise<boolean> {
  try { return Boolean(await (navigator as any)?.storage?.persist?.()); } catch { return false; }
}

export const offlineStorageAvailable = available;

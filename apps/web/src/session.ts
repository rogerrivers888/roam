/**
 * The token this device signs in with.
 *
 * One passcode opens the household's Roam (api/src/auth.js); what comes back is
 * a token that lasts ninety days, so the family types the passcode about four
 * times a year rather than every morning.
 *
 * `localStorage`, not the offline database: it has to be readable synchronously
 * on the very first request the app makes, before IndexedDB has opened. It is
 * not a secret about a person — it is a key to this API, revocable from
 * Settings on any device, and the device already holds the household's own data
 * beside it.
 */

import { Platform } from 'react-native';

export const TOKEN_KEY = 'roam.session';

const store = Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage : null;

let token: string | null = store?.getItem(TOKEN_KEY) ?? null;

const listeners = new Set<(t: string | null) => void>();

export const sessionToken = () => token;
export const signedIn = () => Boolean(token);

export function setSessionToken(next: string | null) {
  if (token === next) return;
  token = next;
  if (store) {
    if (next) store.setItem(TOKEN_KEY, next);
    else store.removeItem(TOKEN_KEY);
  }
  listeners.forEach((fn) => fn(token));
}

/**
 * Called when the API says the token is no longer good. Separate from signing
 * out on purpose: the app needs to tell "you asked to leave" from "you were
 * away too long", because the second one has to keep whatever is in the outbox
 * and send it once they are back in.
 */
export const sessionExpired = () => setSessionToken(null);

export function onSessionChange(fn: (t: string | null) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** What this device calls itself in Settings › Devices. Never anything identifying. */
export function deviceLabel(): string {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return Platform.OS;
  const ua = navigator.userAgent || '';
  const kind = /iPhone|Android.*Mobile/.test(ua) ? 'Phone' : /iPad|Tablet/.test(ua) ? 'Tablet' : 'Computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
  return `${kind} · ${browser}`;
}


/**
 * Whose data the device's saved copy is.
 *
 * Signing out deliberately keeps the offline copy — it is the same household's
 * data and they will sign back in. With accounts that reasoning only holds while
 * it is the *same* household: a friend signing in on a browser the owner used
 * would otherwise be served the owner's atlas out of IndexedDB, with no request
 * to the API to refuse it.
 *
 * So the copy is stamped with who it belongs to, and a sign-in by anybody else
 * throws it away before the first screen is drawn. The owner on the shared
 * passcode is 'owner', and stays 'owner' when he later claims an account row,
 * so claiming does not cost him the copy on his phone.
 */
const HOLDER_KEY = 'roam.copyHolder';

export const copyHolder = (): string | null => store?.getItem(HOLDER_KEY) ?? null;

export function setCopyHolder(holder: string) {
  store?.setItem(HOLDER_KEY, holder);
}

/** Who a signed-in session's saved copy belongs to: the account, or the owner. */
export const holderOf = (account: { id: string; role: string } | null | undefined): string =>
  (!account || account.role === 'owner' ? 'owner' : account.id);

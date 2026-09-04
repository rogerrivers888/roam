/**
 * Whose request this is, carried without threading it through everything.
 *
 * `currentHousehold()` is called 86 times across twelve route files, always
 * with no arguments, because for a year there was only one household and it was
 * simply "the first row in the table". Accounts make that answer wrong, and
 * there were two ways to fix it: pass the request into all 86, or make the
 * answer depend on which request is being served.
 *
 * This is the second, and the reason is not typing effort. Threading a
 * parameter through 86 call sites and the helpers beneath them is a change
 * where one missed site is invisible — it does not fail, it quietly serves one
 * household's data to another. An async-local store cannot be missed: the
 * middleware sets it for every request that has a session, and anything that
 * reads it inside that request gets that account or nothing at all.
 *
 * The honest cost, named: this only works because Roam is plain async/await on
 * one process. Anything that breaks the async chain — a callback handed to a
 * library that queues it outside the request, a worker thread — loses the store
 * and falls back to the founding household. That is why `runOutsideRequest`
 * exists and why background work (the reminder loop, the research loop) passes
 * a household id explicitly rather than expecting one to be in the air.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Serve the rest of this request as `account` (null for the shared passcode). */
export const runAsAccount = (account, fn) => storage.run({ account }, fn);

/** The account this request belongs to, or null: no session, or the passcode. */
export const currentAccount = () => storage.getStore()?.account ?? null;

/**
 * Run something with no account at all, whatever the surrounding request is.
 *
 * For work that is deliberately not on anybody's behalf — a scheduled sweep, a
 * loop over every household — so that it cannot pick up the account of whoever
 * happened to trigger it.
 */
export const runOutsideRequest = (fn) => storage.run({ account: null }, fn);

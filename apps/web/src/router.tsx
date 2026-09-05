/**
 * The address bar, as the app's only idea of where it is.
 *
 * The owner, 4 Sep 2026: "we need a unique URL structure, so wherever I am,
 * there is a unique URL" — and again, 5 Sep 2026:
 *
 * > "Every page of our site needs a unique URL. When I go 1 layer in, that
 * > should also have a unique URL. Or, 2 layers in, I should be able to share a
 * > URL with someone, and they should be able to get to the exact point that I
 * > was on."
 *
 * Roam used to keep where you were in React state and write a summary of it
 * (`?tab=trips&trip=…`) to the address bar afterwards, which meant the address
 * was a description of the app rather than the thing that decided what it drew.
 * Anything the description left out — which day of a trip, which place's drawer,
 * how a list was filtered — could not be sent to anybody.
 *
 * So this is the other way round. The path is the page (`/trips/<id>/day/<dayId>`)
 * and the query is how that page is set (`?kind=eat&sort=recent`); every screen
 * reads its position from here and changes it by navigating. Reload, bookmark,
 * paste into a message: the same screen comes back.
 *
 * Two rules that fall out of that split, and are worth keeping:
 *
 *  - **A move is a push; a filter is a replace.** Opening a trip is a step the
 *    browser's back button should walk back over. Changing a sort order is not —
 *    otherwise Back becomes a tour of every chip somebody tapped.
 *  - **Back has to have somewhere to go.** Somebody who arrives on a shared
 *    link has no history behind them, so `back()` takes the address one layer
 *    up rather than leaving the site.
 *
 * On iOS and Android there is no address bar, so the same router drives an
 * in-memory one. Screens do not have to know which they are on.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { recallScreen, rememberScreen } from './screenState';
import { splitHref, withQuery } from './routes';

const onWeb = Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.history !== 'undefined';

// The in-memory address, for the native apps. One string, the same shape the
// browser would hold: "/trips/abc/day?who=1".
let memoryHref = '/';
const memoryStack: string[] = [];
const memoryListeners = new Set<() => void>();
const tellMemoryListeners = () => memoryListeners.forEach((f) => f());

function readHref(): string {
  if (onWeb) return `${window.location.pathname}${window.location.search}`;
  return memoryHref;
}

export type RouterValue = {
  /** The whole address: path and query together. */
  href: string;
  path: string;
  /** The path, decoded, without its empty ends. */
  segments: string[];
  query: URLSearchParams;
  /** Go somewhere. A move pushes; pass `replace` for a correction to the address that is not a step. */
  navigate: (to: string, opts?: { replace?: boolean }) => void;
  /** Change part of the query and leave the path alone. Replaces by default: a filter is not a step. */
  setQuery: (patch: Record<string, string | null | undefined>, opts?: { replace?: boolean }) => void;
  /**
   * One step back — or, for somebody who arrived on a shared link and has no
   * step behind them, to `fallback`, which is the layer above.
   */
  back: (fallback: string) => void;
};

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [href, setHref] = useState(readHref);
  /**
   * How many moves deep into Roam this history entry is. Zero means the entry
   * behind it is somebody else's page — the shared link itself — so Back must
   * be answered by going one layer up rather than handed to the browser.
   *
   * It is carried on the history entry rather than counted, because counting
   * cannot tell Back from Forward: walking forward again would leave Roam
   * thinking it was at the start of its own history.
   */
  const [depth, setDepth] = useState(() => (onWeb ? Number(window.history.state?.roamDepth) || 0 : 0));

  useEffect(() => {
    if (onWeb) {
      const onPop = () => { setHref(readHref()); setDepth(Number(window.history.state?.roamDepth) || 0); };
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    }
    const listener = () => setHref(readHref());
    memoryListeners.add(listener);
    return () => { memoryListeners.delete(listener); };
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    const next = to.startsWith('/') ? to : `/${to}`;
    if (next === readHref()) return;
    if (onWeb) {
      const at = Number(window.history.state?.roamDepth) || 0;
      if (opts?.replace) window.history.replaceState({ roamDepth: at }, '', next);
      else { window.history.pushState({ roamDepth: at + 1 }, '', next); setDepth(at + 1); }
    } else {
      if (!opts?.replace) { memoryStack.push(memoryHref); setDepth((d) => d + 1); }
      memoryHref = next;
      tellMemoryListeners();
    }
    setHref(next);
  }, []);

  const value = useMemo<RouterValue>(() => {
    const { path, segments, query } = splitHref(href);
    return {
      href, path, segments, query,
      navigate,
      setQuery: (patch, opts) => {
        /**
         * Read the address as it is *now*, not as it was when this render
         * started. One tap often changes two things — the Food & drink tab
         * also clears the Type filter — and those are two calls in the same
         * handler, before React has re-rendered anything. Built from the
         * render's query they would each start from the old address and the
         * last one would undo the first, which is exactly how the segment
         * ended up looking unclickable (owner, 5 Sep 2026: "I go into Places,
         * Food and Drink, and it's simply not clickable").
         */
        navigate(withQuery(readHref(), patch), { replace: opts?.replace !== false });
      },
      back: (fallback: string) => {
        if (depth > 0) {
          if (onWeb) window.history.back();
          else { const prev = memoryStack.pop(); if (prev != null) { memoryHref = prev; setDepth((d) => Math.max(0, d - 1)); setHref(prev); tellMemoryListeners(); } }
          return;
        }
        navigate(fallback, { replace: true });
      },
    };
  }, [href, depth, navigate]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const r = useContext(RouterContext);
  if (!r) throw new Error('useRouter outside a RouterProvider');
  return r;
}

/**
 * A piece of a screen's state that lives in the query string.
 *
 * The default is not written down: a screen nobody has touched keeps a clean
 * address (`/inspire`), and only what somebody actually chose shows up in it
 * (`/inspire?travel=30`). That is what makes a shared link readable and what
 * stops "the same page" having a dozen spellings.
 */
export function useQueryState<T>(
  key: string,
  fallback: T,
  codec: { read: (raw: string) => T | null; write: (value: T) => string | null },
): [T, (value: T, opts?: { replace?: boolean }) => void] {
  const { query, setQuery } = useRouter();
  const raw = query.get(key);
  const value = raw == null ? fallback : codec.read(raw) ?? fallback;
  const set = useCallback((next: T, opts?: { replace?: boolean }) => {
    const written = codec.write(next);
    setQuery({ [key]: written }, opts);
  }, [key, setQuery]);
  return [value, set];
}

/** The codecs every screen needs; anything odder passes its own. */
export const asText = {
  read: (raw: string) => raw,
  write: (v: string | null) => (v == null || v === '' ? null : v),
};

export const asOneOf = <T extends string>(allowed: readonly T[], dflt: T | null) => ({
  read: (raw: string) => (allowed.includes(raw as T) ? (raw as T) : null),
  write: (v: T | null) => (v == null || v === dflt ? null : v),
});

export const asNumber = (dflt: number | null) => ({
  read: (raw: string) => (raw === 'any' ? null : Number.isFinite(Number(raw)) ? Number(raw) : null),
  write: (v: number | null) => (v === dflt ? null : v == null ? 'any' : String(v)),
});

export const asList = {
  read: (raw: string) => raw.split(',').map((s) => s.trim()).filter(Boolean),
  write: (v: string[]) => (v.length ? v.join(',') : null),
};

export const asFlag = {
  read: (raw: string) => raw === '1' || raw === 'true',
  write: (v: boolean) => (v ? '1' : null),
};

// ---------------------------------------------------------------------------
// Coming back to where you were
// ---------------------------------------------------------------------------

/**
 * The address is now the whole of where you are, which means the thing worth
 * remembering between visits is an address (owner, 4 Sep 2026: "I come back 10
 * minutes later after navigating off that tab, everything's disappeared").
 *
 * Two hooks, and neither of them redirects anybody:
 *
 *  - `useRememberedAddress` writes down where a tab was left. The tab button in
 *    the rail then carries that address instead of the bare one, so tapping
 *    Places goes back to London. A *typed* `/places` still means the atlas
 *    list, because an address that quietly turns into a different page is not
 *    an address.
 *  - `useStickyQuery` does the same for how one page was filtered — per city,
 *    per trip — and only fills in what the address has left unsaid.
 *
 * Both keep choices and never content: what is written down is a path and a
 * handful of the household's own words, which is the same rule `screenState.ts`
 * has always been under.
 */

const ADDRESS = (tab: string) => `at.${tab}`;

/** Remember where this tab was left. */
export function useRememberedAddress(tab: string, href: string): void {
  useEffect(() => { rememberScreen(ADDRESS(tab), href); }, [tab, href]);
}

/** Where this tab was left, or the bare address if it has never been opened. */
export function rememberedAddress(tab: string, fallback: string): string {
  const held = recallScreen<string>(ADDRESS(tab));
  return typeof held?.data === 'string' && held.data.startsWith(fallback) ? held.data : fallback;
}

/**
 * How this page was last set, filled in when the address does not say.
 *
 * `name` is the page, not the screen: `places.city.GB.London` and
 * `places.city.PT.Lisbon` remember separately, so coming back to London does
 * not bring Lisbon's "food only, been" with it.
 */
export function useStickyQuery(name: string, keys: string[]): void {
  const { query, setQuery } = useRouter();
  const signature = keys.map((k) => `${k}=${query.get(k) ?? ''}`).join('&');
  const opened = useRef<string | null>(null);
  const persisted = useRef<string | null>(null);

  useEffect(() => {
    if (opened.current === name) return;
    opened.current = name;
    // The address wins: somebody following a link meant what it says.
    if (keys.some((k) => query.get(k) != null)) return;
    const held = recallScreen<Record<string, string>>(`q.${name}`);
    if (!held?.data || !Object.keys(held.data).length) return;
    const patch: Record<string, string | null> = {};
    for (const k of keys) patch[k] = held.data[k] ?? null;
    setQuery(patch, { replace: true });
  }, [name, signature, setQuery]);

  useEffect(() => {
    // The first run for a page is the page arriving, not somebody changing it.
    if (persisted.current !== name) { persisted.current = name; return; }
    const now: Record<string, string> = {};
    for (const k of keys) { const v = query.get(k); if (v != null) now[k] = v; }
    rememberScreen(`q.${name}`, now);
  }, [name, signature]);
}

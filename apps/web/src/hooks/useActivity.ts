/**
 * Telling the API that somebody is here, and where.
 *
 * Two events and no more: a `screen` when the tab changes, and a `heartbeat`
 * while the app is open *and visible*. That second word is the whole design —
 * a tab left open behind a browser window is not somebody using Roam, and
 * counting it would make "time on site" a number that flatters itself.
 *
 * Batched and fire-and-forget. Reporting must never be something the household
 * notices: a failed send is dropped, never retried into a queue that grows, and
 * never blocks a screen.
 *
 * Nothing identifying is sent. Which tab, and that the tab was open — the API
 * writes it against the session's own household and no client can name another.
 */

import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { api } from '../api';

const BEAT_SECONDS = 60;
/** Sent when this many are waiting, or on the next beat, or when the page goes. */
const BATCH = 8;

type Event = { kind: string; screen?: string; seconds?: number; at: string };

export function useActivity(screen: string, { enabled = true }: { enabled?: boolean } = {}) {
  const queue = useRef<Event[]>([]);
  const current = useRef(screen);
  current.current = screen;

  // One flusher for the life of the app, so a screen change does not restart
  // the heartbeat and reset what it has counted.
  const flush = useRef(async (beacon = false) => {
    const events = queue.current.splice(0, queue.current.length);
    if (!events.length) return;
    // On the way out, `sendBeacon` is the only thing a browser promises to
    // deliver; a fetch from an unloading page is cancelled about half the time.
    if (beacon && Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      try {
        const url = `${(process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '')}/api/activity`;
        // No auth header on a beacon; the API's cookie is not accepted for a
        // write, so this only lands when the app is same-origin. It is the last
        // beat of a session — losing it is a rounding error, and inventing a
        // way to authenticate it is not worth a cross-site write path.
        navigator.sendBeacon(url, new Blob([JSON.stringify({ events })], { type: 'application/json' }));
        return;
      } catch { /* fall through to the normal send */ }
    }
    void api.reportActivity(events);
  });

  const visible = () =>
    Platform.OS !== 'web' || typeof document === 'undefined' ? AppState.currentState === 'active' : document.visibilityState === 'visible';

  // The screen they are on.
  useEffect(() => {
    if (!enabled) return;
    queue.current.push({ kind: 'screen', screen, at: new Date().toISOString() });
    if (queue.current.length >= BATCH) void flush.current();
  }, [screen, enabled]);

  // Still here.
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => {
      if (!visible()) return;
      queue.current.push({ kind: 'heartbeat', screen: current.current, seconds: BEAT_SECONDS, at: new Date().toISOString() });
      void flush.current();
    }, BEAT_SECONDS * 1000);
    return () => clearInterval(timer);
  }, [enabled]);

  /**
   * Installed, and running as an installed app.
   *
   * Roam is an installable web app (public/manifest.json), which is as close as
   * it has to a store listing — so "installs" is the App Store figure that can
   * honestly be reported. Two signals, and both are one event each:
   *
   *   * `appinstalled` — the browser confirming somebody added it, once;
   *   * `display-mode: standalone` — this session running from the home screen
   *     rather than a browser tab, which is the number that says whether an
   *     install actually gets used.
   *
   * There is no store, no download count and no crash reporting, and the back
   * office does not pretend otherwise.
   */
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
      || (navigator as any)?.standalone === true;
    if (standalone) {
      queue.current.push({ kind: 'install', screen: 'standalone', at: new Date().toISOString() });
      void flush.current();
    }
    const installed = () => {
      queue.current.push({ kind: 'install', screen: 'added', at: new Date().toISOString() });
      void flush.current();
    };
    window.addEventListener('appinstalled', installed);
    return () => window.removeEventListener('appinstalled', installed);
  }, [enabled]);

  // On the way out.
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const leave = () => flush.current(true);
    window.addEventListener('pagehide', leave);
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('beforeunload', leave);
    };
  }, [enabled]);
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, Place } from '../api';

/**
 * Where the household is standing, when they ask for it (owner, 4 Sep 2026:
 * "in the real world, I'm out in London and I suddenly want to find somewhere
 * to go. Rather than me having to tell you, you could just use my location").
 *
 * Two rules the rest of the app relies on:
 *
 * - **Nothing is asked until something is tapped.** A browser permission prompt
 *   on load is a question nobody asked, and once it is refused the answer is
 *   remembered by the browser and we cannot ask again. `ask()` is only ever
 *   called from a press.
 * - **A fix is not stored.** It lives in this module for a few minutes so that
 *   the picker, the Plan screen and a new trip do not each set off the prompt,
 *   and it goes when the tab does. Where somebody is standing this minute is
 *   not a fact about them to keep.
 *
 * The coordinates come from the device; the name comes from our own API, which
 * reverse-geocodes against OpenStreetMap — so what comes back is a `Place` that
 * any picker can hold, not a pair of numbers.
 */
export type HereState = 'idle' | 'asking' | 'ready' | 'denied' | 'failed';

/** How long a fix stays good enough to reuse without asking the device again. */
const KEEP_MS = 5 * 60_000;

type Held = { place: Place; accuracyM: number | null; at: number };
let held: Held | null = null;
/** One request in flight for the whole app, however many screens ask at once. */
let inFlight: Promise<Held> | null = null;
const listeners = new Set<() => void>();
const announce = () => { for (const l of [...listeners]) l(); };

const supported = typeof navigator !== 'undefined' && !!navigator.geolocation;

/** The browser's own words are not for reading; these are. */
function reasonFor(err: any): { state: HereState; message: string } {
  const code = err?.code;
  if (code === 1) {
    return {
      state: 'denied',
      message: 'This browser is set to keep your location private. Turn it back on for this site in the address bar, or just type where you are.',
    };
  }
  if (code === 3) return { state: 'failed', message: 'Your device took too long to find you. Try again, or type where you are.' };
  if (code === 2) return { state: 'failed', message: "Your device couldn't work out where it is. Indoors this is common — try again outside, or type where you are." };
  return { state: 'failed', message: 'We could not get your location. Type where you are instead.' };
}

function fix(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      // Long enough for a cold GPS lock on a phone, short enough that the
      // button does not sit spinning with nothing to say.
      timeout: 15_000,
      maximumAge: KEEP_MS,
    });
  });
}

async function locate(): Promise<Held> {
  const pos = await fix();
  const { latitude, longitude, accuracy } = pos.coords;
  const { place } = await api.where(latitude, longitude);
  return { place, accuracyM: accuracy == null ? null : Math.round(accuracy), at: Date.now() };
}

export function useHere() {
  const fresh = held && Date.now() - held.at < KEEP_MS ? held : null;
  const [state, setState] = useState<HereState>(fresh ? 'ready' : 'idle');
  const [place, setPlace] = useState<Place | null>(fresh?.place ?? null);
  const [accuracyM, setAccuracyM] = useState<number | null>(fresh?.accuracyM ?? null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    // A fix found by one screen is a fix for all of them: no second prompt.
    const onHeld = () => {
      if (!alive.current || !held) return;
      setPlace(held.place); setAccuracyM(held.accuracyM); setState('ready'); setError(null);
    };
    listeners.add(onHeld);
    return () => { alive.current = false; listeners.delete(onHeld); };
  }, []);

  const ask = useCallback(async (): Promise<Place | null> => {
    if (!supported) {
      setState('failed');
      setError('This browser cannot tell us where you are. Type where you are instead.');
      return null;
    }
    if (held && Date.now() - held.at < KEEP_MS) {
      setPlace(held.place); setAccuracyM(held.accuracyM); setState('ready'); setError(null);
      return held.place;
    }
    setState('asking'); setError(null);
    try {
      inFlight = inFlight ?? locate();
      const got = await inFlight;
      held = got;
      announce();
      if (alive.current) { setPlace(got.place); setAccuracyM(got.accuracyM); setState('ready'); }
      return got.place;
    } catch (err: any) {
      const { state: s, message } = err?.code ? reasonFor(err) : { state: 'failed' as HereState, message: err?.message || 'We could not get your location.' };
      if (alive.current) { setState(s); setError(message); }
      return null;
    } finally { inFlight = null; }
  }, []);

  /** Forget the fix — after that, asking looks it up again. */
  const forget = useCallback(() => {
    held = null;
    setPlace(null); setAccuracyM(null); setState('idle'); setError(null);
  }, []);

  return { supported, state, place, accuracyM, error, ask, forget, busy: state === 'asking' };
}

/** "to within 20 m" / "to within about 2 km" — how much to trust the pin. */
export function accuracyWords(m: number | null): string | null {
  if (m == null) return null;
  if (m <= 50) return `to within ${Math.max(5, Math.round(m / 5) * 5)} m`;
  if (m < 1000) return `to within about ${Math.round(m / 50) * 50} m`;
  return `to within about ${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

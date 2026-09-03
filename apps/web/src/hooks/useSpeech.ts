import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

/**
 * Speech in, speech out — on the web via the browser's own recognition and
 * synthesis. Tap to start, tap to stop; never hold (research §9). Where
 * recognition is unavailable the mic is simply absent and typing does the
 * same job: voice is a way of filling the same controls, not a separate mode.
 *
 * Listening runs until the household taps Done (owner, 3 Sep 2026: "it cut me
 * off in the middle"): recognition is continuous, every final phrase is kept,
 * and the browser's habit of ending after a pause is undone by starting again
 * until Done or Cancel. Nothing is sent while listening; Done sends the whole
 * transcript at once.
 *
 * A native build (V2) swaps this for the platform recogniser; the transcript
 * goes to the same API endpoints either way.
 */
type Recognizer = any;

function getRecognizer(): Recognizer | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const w = window as any;
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(' ');

export function useSpeech({ onFinal, lang = 'en-GB' }: { onFinal: (text: string) => void; lang?: string }) {
  const recRef = useRef<Recognizer | null>(null);
  const wantRef = useRef(false);          // the household has not tapped Done or Cancel yet
  const finalRef = useRef('');            // phrases the recogniser has settled on, across restarts
  const interimRef = useRef('');          // what it is still deciding on — kept if it stops mid-phrase
  const restartsRef = useRef(0);
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    const rec = getRecognizer();
    if (!rec) return;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event: any) => {
      let settled = '';
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) settled += chunk;
        else pending += chunk;
      }
      if (settled) {
        finalRef.current = join(finalRef.current, settled);
        setFinalText(finalRef.current);
      }
      interimRef.current = pending;
      setInterim(pending);
    };
    rec.onerror = (event: any) => {
      const code = event?.error || 'error';
      // Silence and network blips are not the household's problem; the restart in onend carries on.
      if (code === 'no-speech' || code === 'network' || code === 'aborted') return;
      wantRef.current = false;
      setError(code === 'not-allowed' || code === 'audio-capture' ? 'Microphone permission was declined.' : `Couldn't hear that (${code}).`);
      setListening(false);
    };
    rec.onend = () => {
      // Browsers stop after a pause, a network blip or a minute or so; keep
      // going until Done. Words it had not settled on are kept, not dropped,
      // and a restart that the browser refuses straight away is tried again
      // a moment later rather than treated as the household stopping.
      if (!wantRef.current) { setListening(false); return; }
      if (interimRef.current) {
        finalRef.current = join(finalRef.current, interimRef.current);
        interimRef.current = '';
        setFinalText(finalRef.current);
        setInterim('');
      }
      const attempt = (n: number) => {
        if (!wantRef.current) { setListening(false); return; }
        try { rec.start(); restartsRef.current += 1; } catch {
          if (n < 5) setTimeout(() => attempt(n + 1), 150 * (n + 1));
          else { wantRef.current = false; setListening(false); setError('The microphone stopped — tap Speak to carry on.'); }
        }
      };
      attempt(0);
    };

    recRef.current = rec;
    setSupported(true);
    return () => {
      wantRef.current = false;
      try { rec.abort(); } catch { /* noop */ }
    };
  }, [lang]);

  const start = useCallback(() => {
    if (!recRef.current) return;
    setError(null);
    finalRef.current = '';
    interimRef.current = '';
    restartsRef.current = 0;
    setFinalText('');
    setInterim('');
    wantRef.current = true;
    try {
      recRef.current.start();
      setListening(true);
    } catch {
      wantRef.current = false;
      try { recRef.current.stop(); } catch { /* noop */ }
      setListening(false);
    }
  }, []);

  /** Done: stop listening and send everything heard, in one go. */
  const stop = useCallback(() => {
    wantRef.current = false;
    try { recRef.current?.stop(); } catch { /* noop */ }
    setListening(false);
    const text = join(finalRef.current, interimRef.current);
    interimRef.current = '';
    setInterim('');
    if (text) onFinalRef.current(text);
  }, []);

  /** Cancel: stop listening and keep nothing. */
  const cancel = useCallback(() => {
    wantRef.current = false;
    try { recRef.current?.abort(); } catch { /* noop */ }
    finalRef.current = '';
    interimRef.current = '';
    setFinalText('');
    setInterim('');
    setListening(false);
  }, []);

  const toggle = useCallback(() => (listening ? stop() : start()), [listening, start, stop]);

  const transcript = join(finalText, interim);
  return { supported, listening, interim, transcript, error, start, stop, cancel, toggle };
}

/** Speak a reply back when the household used their voice to ask. */
export function speak(text: string) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const synth = (window as any).speechSynthesis;
  if (!synth || !text) return;
  synth.cancel();
  const u = new (window as any).SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  synth.speak(u);
}

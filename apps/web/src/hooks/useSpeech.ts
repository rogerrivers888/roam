import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

/**
 * Speech in, speech out — on the web via the browser's own recognition and
 * synthesis. Tap to start, tap to stop; never hold (research §9). Where
 * recognition is unavailable the mic is simply absent and typing does the
 * same job: voice is a way of filling the same controls, not a separate mode.
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

export function useSpeech({ onFinal, lang = 'en-US' }: { onFinal: (text: string) => void; lang?: string }) {
  const recRef = useRef<Recognizer | null>(null);
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    const rec = getRecognizer();
    if (!rec) return;
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event: any) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += chunk;
        else interimText += chunk;
      }
      if (interimText) setInterim(interimText);
      if (finalText) {
        setInterim('');
        onFinalRef.current(finalText.trim());
      }
    };
    rec.onerror = (event: any) => {
      setError(event?.error === 'not-allowed' ? 'Microphone permission was declined.' : `Couldn't hear that (${event?.error || 'error'}).`);
      setListening(false);
    };
    rec.onend = () => setListening(false);

    recRef.current = rec;
    setSupported(true);
    return () => {
      try { rec.abort(); } catch { /* noop */ }
    };
  }, [lang]);

  const start = useCallback(() => {
    if (!recRef.current) return;
    setError(null);
    setInterim('');
    try {
      recRef.current.start();
      setListening(true);
    } catch {
      // start() throws if already running; treat as a stop request
      recRef.current.stop();
      setListening(false);
    }
  }, []);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
  }, []);

  const toggle = useCallback(() => (listening ? stop() : start()), [listening, start, stop]);

  return { supported, listening, interim, error, start, stop, toggle };
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

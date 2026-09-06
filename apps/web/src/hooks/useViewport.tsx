import React, { createContext, useContext, useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

// The size the app believes it is drawing into. Normally the window; when the
// owner flips the shell to "Mobile" on a wide screen, App wraps the content in a
// phone-sized frame and every layout decision (side-by-side columns, drawer vs
// sheet, card widths) follows the frame instead of the browser window.
// `origin` is where the frame's screen sits in the real window, for anything that
// portals out of the tree (Modal) and has to draw itself back inside the frame.
export type Viewport = { width: number; height: number; framed: boolean; origin?: { x: number; y: number } };

const ViewportContext = createContext<Viewport | null>(null);

export const ViewportProvider = ViewportContext.Provider;

const isWeb = Platform.OS === 'web' && typeof document !== 'undefined';

/**
 * The screen, not what is left of it above the keyboard.
 *
 * react-native-web measures the window with `visualViewport`, which is the
 * right answer to a different question: on a phone that shrinks by half the
 * moment a field is tapped. Every layout that reads a height then re-lays-out
 * around the keyboard — the sheet over the map collapsed to a letterbox as soon
 * as the organiser typed into it (owner, 6 Sep 2026: "Every time I click into a
 * box, it makes the bottom drawer half the page… I can see nothing").
 *
 * The layout viewport (`documentElement.clientHeight`) is the screen, and it
 * does not move when a keyboard opens over it. So that is what a layout gets;
 * how much of it the keyboard is covering is a separate question with its own
 * hook (`useKeyboardInset`), asked only by the things that must scroll clear of
 * it.
 */
function useScreen(): { width: number; height: number } {
  const win = useWindowDimensions();
  const [size, setSize] = useState(() => (isWeb
    ? { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
    : { width: win.width, height: win.height }));

  useEffect(() => {
    if (!isWeb) { setSize({ width: win.width, height: win.height }); return; }
    // `win` changing is the signal that something moved — a resize, a rotation,
    // or a keyboard. The layout viewport is then re-read, and answers the first
    // two while ignoring the third.
    const next = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    setSize((s) => (s.width === next.width && s.height === next.height ? s : next));
  }, [win.width, win.height]);

  return size;
}

export function useViewport(): Viewport {
  const screen = useScreen();
  const framed = useContext(ViewportContext);
  return framed ?? { width: screen.width, height: screen.height, framed: false };
}

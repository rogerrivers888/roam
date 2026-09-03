import React, { createContext, useContext } from 'react';
import { useWindowDimensions } from 'react-native';

// The size the app believes it is drawing into. Normally the window; when the
// owner flips the shell to "Mobile" on a wide screen, App wraps the content in a
// phone-sized frame and every layout decision (side-by-side columns, drawer vs
// sheet, card widths) follows the frame instead of the browser window.
// `origin` is where the frame's screen sits in the real window, for anything that
// portals out of the tree (Modal) and has to draw itself back inside the frame.
export type Viewport = { width: number; height: number; framed: boolean; origin?: { x: number; y: number } };

const ViewportContext = createContext<Viewport | null>(null);

export const ViewportProvider = ViewportContext.Provider;

export function useViewport(): Viewport {
  const window = useWindowDimensions();
  const framed = useContext(ViewportContext);
  return framed ?? { width: window.width, height: window.height, framed: false };
}

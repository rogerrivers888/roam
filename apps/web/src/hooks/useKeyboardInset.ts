import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined';

/**
 * How much of the screen the on-screen keyboard is covering, in pixels.
 *
 * A form inside a sheet has to be able to scroll its fields clear of the
 * keyboard, and the only honest way to do that is to know how tall the keyboard
 * is. On the web that is the gap between the layout viewport and the visual one
 * (`visualViewport`); on a device it is the keyboard events themselves.
 *
 * It is deliberately not part of `useViewport`: a layout must not resize itself
 * because somebody tapped a field (see the note there). This is padding, and
 * only the component with the fields in it asks for it.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!isWeb) {
      const show = Keyboard.addListener('keyboardDidShow', (e) => setInset(e.endCoordinates?.height ?? 0));
      const hide = Keyboard.addListener('keyboardDidHide', () => setInset(0));
      return () => { show.remove(); hide.remove(); };
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const read = () => {
      const covered = document.documentElement.clientHeight - (vv.height + vv.offsetTop);
      // Under about 80px it is browser chrome moving, not a keyboard.
      setInset(covered > 80 ? Math.round(covered) : 0);
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => { vv.removeEventListener('resize', read); vv.removeEventListener('scroll', read); };
  }, []);

  return inset;
}

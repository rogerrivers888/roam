import { useEffect, useState } from 'react';
import { getThemePref, onThemeChange, resolveTheme, setThemePref, ThemeName, ThemePref } from '../theme';

/** The current theme and the household's preference (light, dark, or follow the device). */
export function useTheme(): { theme: ThemeName; pref: ThemePref; setPref: (p: ThemePref) => void } {
  const [theme, setTheme] = useState<ThemeName>(resolveTheme());
  const [pref, setPrefState] = useState<ThemePref>(getThemePref());
  useEffect(() => onThemeChange(setTheme), []);
  return { theme, pref, setPref: (p) => { setThemePref(p); setPrefState(p); } };
}

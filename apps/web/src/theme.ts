// Visual system for the prototype. Calm by default; colour is reserved for
// meaning — allergen exclusions, overrun, and the household's own people.
//
// Two palettes, one set of names. On the web every colour is a CSS variable
// (react-native-web passes `var(--…)` through untouched), so switching the
// theme is setting the variables on <html>; nothing re-renders and every
// StyleSheet keeps working. Dark is its own set of steps chosen against the
// dark surface, not an automatic flip: accents lighten so they read as text on
// the dark ground and still carry dark text as fills.

import { Platform } from 'react-native';

export type ThemeName = 'light' | 'dark';
export type ThemePref = ThemeName | 'system';

const LIGHT = {
  bg: '#F7F6F2',
  surface: '#FFFFFF',
  surfaceMuted: '#F0EEE8',
  ink: '#1D1B16',
  inkMuted: '#6B675E',
  inkFaint: '#A8A399',
  line: '#E4E0D6',
  accent: '#1F5F5B',
  accentSoft: '#DCEBE9',
  travel: '#C9C3B5',
  dwell: '#1F5F5B',
  slack: '#EDE9DF',
  overrun: '#C0392B',
  overrunSoft: '#F8E1DE',
  allergen: '#B3261E',
  allergenSoft: '#FBE9E7',
  like: '#2E7D32',
  likeSoft: '#E3F2E4',
  dislike: '#8A6D1F',
  dislikeSoft: '#F6EFD8',
  want: '#4A4A8A',
  wantSoft: '#E6E6F5',
  rating: '#B0771E',
};

const DARK: typeof LIGHT = {
  bg: '#14130F',
  surface: '#1E1C18',
  surfaceMuted: '#282520',
  ink: '#F1EEE6',
  inkMuted: '#ABA69A',
  inkFaint: '#7A7565',
  line: '#35322B',
  accent: '#5FB3AB',
  accentSoft: '#1E3634',
  travel: '#4B473D',
  dwell: '#5FB3AB',
  slack: '#26231E',
  overrun: '#E8776B',
  overrunSoft: '#3E1F1B',
  allergen: '#EA7A70',
  allergenSoft: '#3D1E1B',
  like: '#7CC47F',
  likeSoft: '#1D3321',
  dislike: '#D3B15A',
  dislikeSoft: '#35301B',
  want: '#A5A5E6',
  wantSoft: '#26264B',
  rating: '#E2AA4E',
};

export const PALETTES: Record<ThemeName, typeof LIGHT> = { light: LIGHT, dark: DARK };
export type ColorName = keyof typeof LIGHT;

const isWeb = Platform.OS === 'web' && typeof document !== 'undefined';
// Text that sits on a filled shape (a primary button, a numbered stop) uses
// `colors.bg`: it is the inverse of ink in both palettes, so it stays readable
// on ink, accent and status fills whichever theme is on.
export const colors: typeof LIGHT = isWeb
  ? (Object.fromEntries(Object.keys(LIGHT).map((k) => [k, `var(--roam-${k})`])) as typeof LIGHT)
  : LIGHT;

export const THEME_KEY = 'roam.theme';
export const getThemePref = (): ThemePref => {
  if (!isWeb || typeof localStorage === 'undefined') return 'light';
  const v = localStorage.getItem(THEME_KEY);
  return v === 'dark' || v === 'light' || v === 'system' ? v : 'system';
};
const systemTheme = (): ThemeName => (isWeb && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
export const resolveTheme = (pref: ThemePref = getThemePref()): ThemeName => (pref === 'system' ? systemTheme() : pref);

const listeners = new Set<(t: ThemeName) => void>();
export const onThemeChange = (fn: (t: ThemeName) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Write the palette onto <html> so every var(--roam-…) resolves; also the browser chrome colour and the map tiles. */
export function applyTheme(name: ThemeName = resolveTheme()) {
  if (!isWeb) return;
  const root = document.documentElement;
  const p = PALETTES[name];
  for (const [k, v] of Object.entries(p)) root.style.setProperty(`--roam-${k}`, v);
  root.setAttribute('data-theme', name);
  root.style.colorScheme = name;
  document.body.style.backgroundColor = p.bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', name === 'dark' ? p.surface : LIGHT.accent);
  listeners.forEach((fn) => fn(name));
}

export function setThemePref(pref: ThemePref) {
  if (isWeb && typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, pref);
  applyTheme(resolveTheme(pref));
}

if (isWeb) {
  applyTheme();
  if (typeof window.matchMedia === 'function') window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme(); });
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

export const type = {
  title: { fontSize: 24, fontWeight: '700' as const, color: colors.ink, letterSpacing: -0.3 },
  h2: { fontSize: 18, fontWeight: '700' as const, color: colors.ink },
  h3: { fontSize: 15, fontWeight: '600' as const, color: colors.ink },
  body: { fontSize: 15, color: colors.ink, lineHeight: 21 },
  small: { fontSize: 13, color: colors.inkMuted, lineHeight: 18 },
  tiny: { fontSize: 11, color: colors.inkFaint, lineHeight: 15 },
};

// Every interactive target is at least 44pt (research §12).
export const TARGET = 44;

export const memberColors = ['#1F5F5B', '#8A4B2F', '#3F5AA8', '#9C3D7A', '#5C7A2E', '#B0771E'];
export const memberColor = (index: number) => memberColors[index % memberColors.length];

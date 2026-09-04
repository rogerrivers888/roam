// Visual system, from the Roam colour & style guidelines v1 (September 2026,
// Supporting docs/Roam Style Guide.pdf): light mode "Mint", dark mode "Night ·
// mint". Bright, airy and mostly white. One mint field carries the header;
// everything else is ink on white with soft rules. Red belongs to the heart —
// the mark of a place you love — and to nothing else. Buttons are ink, icons
// are one deeper green, and there is no colour-coding of rows.
//
// Two palettes, one set of names. On the web every colour is a CSS variable
// (react-native-web passes `var(--…)` through untouched), so switching the
// theme is setting the variables on <html>; nothing re-renders and every
// StyleSheet keeps working.

import { Platform } from 'react-native';

export type ThemeName = 'light' | 'dark';
export type ThemePref = ThemeName | 'system';

const LIGHT = {
  // Ground and surfaces
  bg: '#FFFFFF',           // screen ground
  surface: '#FFFFFF',      // cards, tab bar
  surfaceMuted: '#EFF8F3', // mint tint: open-panel ground, second picture tile, neutral chips
  panel: '#EFF8F3',
  well: '#EFF8F3',         // row icon squares (dark mode has a real well)
  tabbar: '#FFFFFF',
  headerBg: '#B6E3CF',     // the one mint field
  headerSub: '#2F6A52',    // deep leaf: sub-copy on mint
  mint: '#B6E3CF',
  // Type
  ink: '#201E1D',
  inkMuted: '#6B6663',     // labels, placeholders, inactive tabs
  inkFaint: '#8B8784',
  line: '#E5EFEA',         // 1px rules, chip outlines, slider track
  // The single icon colour, links, focus, slider range
  accent: '#2E8A63',       // leaf
  accentSoft: '#EFF8F3',
  icon: '#2E8A63',
  // Buttons and selection are ink
  primary: '#201E1D',
  primaryFg: '#FFFFFF',
  // The heart, and nothing else
  red: '#EC3013',
  // Time bar
  travel: '#CFD9D3',
  dwell: '#2E8A63',
  slack: '#EFF8F3',
  // Meaning that must still read: overruns and allergens keep a warning red,
  // the one deliberate exception to "red is the heart".
  overrun: '#C0392B',
  overrunSoft: '#FBE9E7',
  allergen: '#B3261E',
  allergenSoft: '#FBE9E7',
  // Household verdicts are tints of the one green and of ink, not new colours
  like: '#2E8A63',
  likeSoft: '#EFF8F3',
  dislike: '#6B6663',
  dislikeSoft: '#F3F2F2',
  want: '#2F6A52',
  wantSoft: '#EFF8F3',
  rating: '#2E8A63',
};

const DARK: typeof LIGHT = {
  bg: '#17171A',           // charcoal
  surface: '#1E1E23',      // raised
  surfaceMuted: '#24242A',
  panel: '#1E1E23',
  well: '#24242A',
  tabbar: '#101013',
  headerBg: '#17171A',
  headerSub: '#8F8D93',
  mint: '#B6E3CF',
  ink: '#F3F2F2',          // off-white
  inkMuted: '#8F8D93',
  inkFaint: '#6E6C72',
  line: '#2B2B30',
  accent: '#B6E3CF',       // mint carries links, slider, selection
  accentSoft: '#24242A',
  icon: '#F3F2F2',
  primary: '#B6E3CF',
  primaryFg: '#17171A',
  red: '#EC3013',
  travel: '#3A3A42',
  dwell: '#B6E3CF',
  slack: '#24242A',
  overrun: '#E8776B',
  overrunSoft: '#3E1F1B',
  allergen: '#EA7A70',
  allergenSoft: '#3D1E1B',
  like: '#B6E3CF',
  likeSoft: '#24242A',
  dislike: '#8F8D93',
  dislikeSoft: '#24242A',
  want: '#B6E3CF',
  wantSoft: '#24242A',
  rating: '#B6E3CF',
};

export const PALETTES: Record<ThemeName, typeof LIGHT> = { light: LIGHT, dark: DARK };
export type ColorName = keyof typeof LIGHT;

const isWeb = Platform.OS === 'web' && typeof document !== 'undefined';
// Text that sits on a filled shape uses `colors.primaryFg` on a primary fill
// and `colors.bg` on a status fill: each is the inverse of its ground in both palettes.
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
  if (meta) meta.setAttribute('content', p.headerBg);
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

// Corners: 4px on controls and tiles; chips are pills.
export const radius = { sm: 4, md: 4, lg: 8, pill: 999 };

// Type: Archivo — headings 800 with tight tracking, body 400/600 at 15px,
// labels 12px 700 uppercase. Caveat is the wordmark only, never UI text.
// The fonts load from Google Fonts on the web (public/index.html); native
// falls back to the system face until a font pack is bundled.
export const fonts = {
  heading: Platform.OS === 'web' ? 'Archivo, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif' : undefined,
  body: Platform.OS === 'web' ? 'Archivo, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif' : undefined,
  wordmark: Platform.OS === 'web' ? 'Caveat, cursive' : undefined,
};

export const type = {
  title: { fontFamily: fonts.heading, fontSize: 28, fontWeight: '800' as const, color: colors.ink, letterSpacing: -0.56, lineHeight: 32 },
  h2: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '800' as const, color: colors.ink, letterSpacing: -0.4 },
  h3: { fontFamily: fonts.body, fontSize: 15, fontWeight: '600' as const, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, color: colors.ink, lineHeight: 21 },
  small: { fontFamily: fonts.body, fontSize: 13, color: colors.inkMuted, lineHeight: 18 },
  tiny: { fontFamily: fonts.body, fontSize: 11, color: colors.inkFaint, lineHeight: 15 },
  // A label needs room between it and the thing it names (owner, 4 Sep 2026:
  // "you need to give the headers room to breathe").
  label: { fontFamily: fonts.body, fontSize: 12, fontWeight: '700' as const, color: colors.inkMuted, letterSpacing: 0.72, textTransform: 'uppercase' as const, marginBottom: 6, marginTop: 4 },
};

// Every interactive target is at least 44pt (research §12).
export const TARGET = 44;

// The household's own people keep their colours: they are people, not rows.
export const memberColors = ['#2E8A63', '#8A4B2F', '#3F5AA8', '#9C3D7A', '#5C7A2E', '#B0771E'];
export const memberColor = (index: number) => memberColors[index % memberColors.length];

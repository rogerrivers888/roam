// Visual system for the prototype. Calm by default; colour is reserved for
// meaning — allergen exclusions, overrun, and the household's own people.

export const colors = {
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
};

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

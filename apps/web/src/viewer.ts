// Whose rating a place's row shows (owner, 3 Sep 2026: "just need to see my own
// rating"). There is no sign-in yet, so the device remembers who is looking;
// Settings › Preferences › Ratings shown as. Defaults to the first person in
// the household.
import { Platform } from 'react-native';

export const VIEWER_KEY = 'roam.viewer';
const isWeb = Platform.OS === 'web' && typeof localStorage !== 'undefined';

export function getViewer(members: { id: string }[]): string | null {
  const saved = isWeb ? localStorage.getItem(VIEWER_KEY) : null;
  if (saved && members.some((m) => m.id === saved)) return saved;
  return members[0]?.id ?? null;
}

export function setViewer(memberId: string) {
  if (isWeb) localStorage.setItem(VIEWER_KEY, memberId);
  listeners.forEach((fn) => fn(memberId));
}

const listeners = new Set<(id: string) => void>();
export const onViewerChange = (fn: (id: string) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

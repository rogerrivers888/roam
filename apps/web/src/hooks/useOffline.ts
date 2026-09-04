import { useEffect, useState } from 'react';
import { offlineStatus, onOfflineChange, watchConnection, refreshCounts, type OfflineStatus } from '../offline/cache';

/**
 * Whether there is signal, whether the screen is showing the saved copy, and
 * how much is saved. One watcher for the whole app: the connection listeners are
 * attached once and every caller reads the same state.
 */
let watching = false;

export function useOffline(): OfflineStatus {
  const [state, setState] = useState<OfflineStatus>(offlineStatus);
  useEffect(() => {
    if (!watching) { watching = true; watchConnection(); }
    return onOfflineChange(setState);
  }, []);
  return state;
}

export { refreshCounts };

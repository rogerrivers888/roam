/**
 * Whether this device is signed in, asked once and then watched.
 *
 * Three states, not two: `checking` while the API is being asked, and
 * `unconfigured` for an API that has no passcode set at all — which is a
 * different thing to tell somebody than "wrong passcode" (LockScreen).
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { onSessionChange, sessionToken } from '../session';

export type SessionState = 'checking' | 'in' | 'out' | 'unconfigured' | 'unreachable';

export function useSession(): { state: SessionState; recheck: () => void } {
  const [state, setState] = useState<SessionState>('checking');

  const check = useCallback(async () => {
    try {
      const r = await api.sessionState();
      if (!r.configured) return setState('unconfigured');
      setState(r.signedIn ? 'in' : 'out');
    } catch (err: any) {
      // A 401 is a clear answer; anything else means the API could not be
      // reached, and a device that was signed in stays in rather than being
      // thrown out to a passcode screen it cannot get past with no signal.
      if (err?.status === 401) return setState('out');
      setState(sessionToken() ? 'in' : 'unreachable');
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  // A token dropped mid-session (the API answered 401 to something) puts the
  // passcode screen up without a reload.
  useEffect(() => onSessionChange((token) => setState(token ? 'in' : 'out')), []);

  return { state, recheck: check };
}

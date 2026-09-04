/**
 * Whether this device is signed in, asked once and then watched.
 *
 * Three states, not two: `checking` while the API is being asked, and
 * `unconfigured` for an API that has no passcode set at all — which is a
 * different thing to tell somebody than "wrong passcode" (LockScreen).
 */

import { useCallback, useEffect, useState } from 'react';
import { api, Access, AccountSummary } from '../api';
import { onSessionChange, sessionToken } from '../session';

export type SessionState = 'checking' | 'in' | 'out' | 'unconfigured' | 'unreachable';

export function useSession(): { state: SessionState; isOwner: boolean; account: AccountSummary | null; access: Access | null; recheck: () => void } {
  const [state, setState] = useState<SessionState>('checking');
  // Whether the admin module is theirs to see. The API decides this and the app
  // only draws what it is told: a customer who edited their own copy of the
  // bundle would still get 404 from every route behind `requireOwner`.
  const [isOwner, setIsOwner] = useState(false);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  // Which applications this session may enter (api/src/access.js). The shell
  // draws the Admin profile from this; the API refuses it regardless.
  const [access, setAccess] = useState<Access | null>(null);

  const check = useCallback(async () => {
    try {
      const r = await api.sessionState();
      if (!r.configured) return setState('unconfigured');
      setIsOwner(Boolean(r.isOwner));
      setAccount(r.account ?? null);
      setAccess(r.access ?? null);
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
  useEffect(() => onSessionChange((token) => {
    setState(token ? 'in' : 'out');
    if (!token) { setIsOwner(false); setAccount(null); setAccess(null); }
  }), []);

  return { state, isOwner, account, access, recheck: check };
}

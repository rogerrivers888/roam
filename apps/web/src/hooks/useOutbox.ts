/**
 * How many writes are waiting to be sent, and sending them when there is signal.
 *
 * One watcher for the whole app: the connection listener is attached once, and
 * a flush is asked for on start, whenever the browser says the connection is
 * back, and whenever the app is looked at again after being in a pocket.
 */

import { useEffect, useState } from 'react';
import { api } from '../api';
import { onOutboxChange, outboxStatus, refreshOutbox, type OutboxStatus } from '../offline/outbox';

let watching = false;

function watch() {
  if (watching || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  watching = true;
  void refreshOutbox();
  const send = () => { void api.sendWaitingWrites(); };
  // On start, on the connection coming back, and when the app is brought back
  // to the front — the moment a phone comes out of a pocket is exactly when
  // yesterday's ratings should go.
  send();
  window.addEventListener('online', send);
  document?.addEventListener?.('visibilitychange', () => { if (!document.hidden) send(); });
}

export function useOutbox(): OutboxStatus {
  const [state, setState] = useState<OutboxStatus>(outboxStatus);
  useEffect(() => { watch(); return onOutboxChange(setState); }, []);
  return state;
}

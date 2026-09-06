/**
 * Settings › Account: the door, from the inside.
 *
 * Two things live here, and the second is the more important one.
 *
 * **Devices.** Which devices are signed in and when each was last used, so a
 * phone left in a taxi can be signed out from the one at home.
 *
 * **Waiting to send.** Every write made without signal is kept on the device
 * and sent when there is signal (offline/outbox.ts). Almost always that happens
 * without anybody noticing. When it cannot — the server refused it, because the
 * trip it belonged to has since been deleted — the write is *still kept*, and
 * this is where it is shown. Nothing Roam is given is thrown away without the
 * person who wrote it seeing it first.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, SessionSummary } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Button, Card, Row } from './ui';
import { Icon } from './Icon';
import { FreeMonth } from './FreeMonth';
import { useOutbox } from '../hooks/useOutbox';
import { discardRejected, pendingSummary } from '../offline/outbox';

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
};

/** A queued write, said in words rather than as a method and a path. */
function describe(method: string, path: string): string {
  if (path.startsWith('/api/visits')) return method === 'DELETE' ? 'A visit you removed' : 'What you thought of a place';
  if (path.startsWith('/api/orders')) return 'What you ordered, and the stars';
  if (path.startsWith('/api/atlas')) return 'A place you claimed';
  if (path.startsWith('/api/household')) return 'A change to the household';
  if (path.startsWith('/api/trips')) return 'A change to a trip';
  return 'A change';
}

export function AccountCard() {
  const outbox = useOutbox();
  const [devices, setDevices] = useState<(SessionSummary & { lastSeen: string })[] | null>(null);
  const [waiting, setWaiting] = useState<Awaited<ReturnType<typeof pendingSummary>>>([]);
  const [busy, setBusy] = useState(false);
  // Somebody who arrived through a friend's invite is on a trial they did not
  // ask for, so the account page leads with what happens at the end of it
  // (Group Trips v2, Epic 7).
  const [trial, setTrial] = useState<{ endsOn: string | null } | null>(null);

  const load = useCallback(async () => {
    setWaiting(await pendingSummary());
    try { setDevices((await api.devices()).sessions); } catch { setDevices(null); }
    try {
      const st = await api.sessionState();
      const acc: any = st.account ?? null;
      setTrial(acc && acc.plan === 'trial' ? { endsOn: acc.trialEndsOn ?? null } : null);
    } catch { setTrial(null); }
  }, []);

  useEffect(() => { void load(); }, [load, outbox.waiting, outbox.rejected]);

  const rejected = waiting.filter((w) => w.rejected);
  const queued = waiting.filter((w) => !w.rejected);

  return (
    <>
      {trial ? <Card><FreeMonth trialEndsOn={trial.endsOn} /></Card> : null}
      <Card>
        <Text style={type.body}>This household signs in with one passcode.</Text>
        <Text style={type.small}>
          Everything Roam holds is behind it — the people, the places you've been and what each of you thought of them.
          A device stays signed in for 90 days.
        </Text>

        {devices?.length ? (
          <View style={styles.list}>
            {devices.map((d) => (
              <Row key={d.id} style={styles.device}>
                <Icon name="mobile" size={16} color={colors.inkMuted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={type.small} numberOfLines={1}>{d.label ?? 'A device'}</Text>
                  <Text style={type.tiny}>Last used {when(d.lastSeen)}</Text>
                </View>
              </Row>
            ))}
          </View>
        ) : null}

        <Row style={{ marginTop: spacing.sm, flexWrap: 'wrap' }}>
          <Button
            label="Sign out"
            kind="secondary"
            icon="locked"
            onPress={async () => {
              setBusy(true);
              await api.signOut();
              setBusy(false);
            }}
            disabled={busy}
          />
          <Button
            label="Sign out every device"
            kind="ghost"
            onPress={async () => {
              setBusy(true);
              await api.signOut({ everywhere: true });
              setBusy(false);
            }}
            disabled={busy}
          />
        </Row>
        {queued.length ? (
          <Text style={[type.tiny, { color: colors.overrun }]}>
            {queued.length} change{queued.length === 1 ? '' : 's'} {queued.length === 1 ? 'is' : 'are'} still waiting to be sent. They will go when you sign back in.
          </Text>
        ) : null}
      </Card>

      {waiting.length ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={type.body}>Waiting to send</Text>
            {outbox.sending ? <Text style={type.tiny}>Sending…</Text> : null}
          </Row>
          <Text style={type.small}>
            Written without signal and kept on this device. They send themselves as soon as Roam can reach the API.
          </Text>

          <View style={styles.list}>
            {waiting.map((w) => (
              <Row key={w.id} style={styles.device}>
                <Icon name={w.rejected ? 'allergen' : 'offline'} size={16} color={w.rejected ? colors.overrun : colors.inkMuted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={type.small} numberOfLines={1}>{describe(w.method, w.path)}</Text>
                  <Text style={type.tiny} numberOfLines={2}>
                    {when(w.queuedAt)}{w.rejected ? ` · couldn't be sent: ${w.lastError ?? 'refused'}` : ''}
                  </Text>
                </View>
              </Row>
            ))}
          </View>

          <Row style={{ flexWrap: 'wrap' }}>
            <Button label="Try again now" kind="secondary" icon="refresh" onPress={() => { void api.sendWaitingWrites(); }} />
            {rejected.length ? (
              // The only way anything leaves the outbox unsent, and it takes a
              // person who has just read what each one was.
              <Button
                label={`Discard ${rejected.length} that can't be sent`}
                kind="ghost"
                onPress={async () => { await discardRejected(); await load(); }}
              />
            ) : null}
          </Row>
        </Card>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: spacing.sm, gap: spacing.xs, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm },
  device: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.md },
});

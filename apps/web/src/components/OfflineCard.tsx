import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api, OfflineManifest } from '../api';
import { colors, spacing, type } from '../theme';
import { Button, Card, Meter, Row, StatusLine, Wrap } from './ui';
import { Icon, IconText } from './Icon';
import { useOffline, refreshCounts } from '../hooks/useOffline';
import { forgetCopy } from '../offline/cache';

/**
 * Settings › On this device (owner, 4 Sep 2026): "It's very important to me
 * that when a user does research, that research is stored… They do not have to
 * research every time they come back to the page."
 *
 * The card says three things, because a household is entitled to know all three:
 * what is on the phone, what Roam owns outright, and what is deliberately not
 * kept. The last one is not an apology — it is why the hours in the drawer come
 * from the venue's own page rather than from a provider's copy of them.
 */

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const megabytes = (bytes: number | null) => (bytes == null ? null : `${(bytes / 1_048_576).toFixed(1)} MB`);

export function OfflineCard() {
  const offline = useOffline();
  const [manifest, setManifest] = useState<OfflineManifest | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.offlineManifest().then((m) => { if (live) setManifest(m); }).catch(() => null);
    void refreshCounts();
    return () => { live = false; };
  }, []);

  const owned = manifest?.owned;
  const save = async () => {
    setSaving(true); setProblem(null);
    try {
      await api.saveForOffline();
      setManifest(await api.offlineManifest());
    } catch (err: any) {
      setProblem(err?.message ?? 'Could not finish saving.');
    } finally {
      setSaving(false);
    }
  };

  if (!offline.available) {
    return (
      <Card>
        <StatusLine tone="warn">This browser will not keep anything offline — usually private browsing. Everything still works with a connection.</StatusLine>
      </Card>
    );
  }

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          <IconText name={offline.online ? 'download' : 'offline'}>
            <Text style={{ fontWeight: '700', color: colors.ink }}>
              {offline.pages ? `${offline.pages} page${offline.pages === 1 ? '' : 's'} saved on this device` : 'Nothing saved on this device yet'}
            </Text>
          </IconText>
          <Text style={type.tiny}>
            Last filled {ago(offline.filledAt)}
            {offline.usedBytes != null ? ` · ${megabytes(offline.usedBytes)}` : ''}
            {offline.kept ? ' · the browser has agreed to keep it' : ''}
          </Text>
        </View>
      </Row>

      <Text style={[type.small, { marginTop: spacing.sm }]}>
        Your places, your trips, your visits and what everyone thought are all here without a connection — including opening a place
        and reading its details. Searching for somewhere new still needs signal.
      </Text>

      {owned ? (
        <View style={{ gap: 4, marginTop: spacing.md }}>
          <IconText name="owned">
            <Text style={{ fontWeight: '700', color: colors.ink }}>{owned.researched} of {owned.claimed}</Text> places researched and owned outright
          </IconText>
          <Meter used={owned.researched} limit={Math.max(owned.claimed, 1)} label="researched" />
          <Text style={type.tiny}>
            {owned.inOpenMap} matched in OpenStreetMap · {owned.described} with a description
            {owned.waiting ? ` · ${owned.waiting} still to look at` : ''}
            {owned.failed ? ` · ${owned.failed} could not be found` : ''}
          </Text>
          <Text style={type.tiny}>
            When you shortlist, save or say you have been somewhere, Roam goes and researches it from OpenStreetMap, the venue's own
            published details and Wikipedia. Those licences let us keep the answer for good, so it is on your phone and it never expires.
          </Text>
        </View>
      ) : null}

      <Text style={[type.tiny, { marginTop: spacing.sm }]}>
        Roam fills this quietly once a day on its own, using only what costs nothing to fetch. Saving everything also fetches your
        city lists, which can ask Google what kind of place a few unlabelled rows are — the same lookup as opening the Places tab.
      </Text>

      <Wrap style={{ marginTop: spacing.md }}>
        <Button label={saving ? 'Saving…' : 'Save everything for offline'} icon="download" onPress={save} disabled={saving || !offline.online} />
        <Button label="Forget the copy" kind="ghost" onPress={async () => { await forgetCopy(); setProblem(null); }} disabled={saving || !offline.pages} />
      </Wrap>
      {offline.filling && offline.fillProgress ? (
        <Text style={type.tiny}>Saving {offline.fillProgress.done} of {offline.fillProgress.total}…</Text>
      ) : null}
      {!offline.online ? <StatusLine tone="warn">No signal — you are reading the saved copy. It will fill again when you are back.</StatusLine> : null}
      {problem ? <StatusLine tone="warn">{problem}</StatusLine> : null}

      <Text style={[type.tiny, { marginTop: spacing.sm }]}>
        Not kept on the device, on purpose: ratings, reviews, photos and live opening times from Google or Tripadvisor. Those are
        licensed and rented by the minute, and a phone is somewhere we could not delete them from. Everything above is open data,
        the venue's own published details, or something your household wrote.
      </Text>
    </Card>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, JoinView } from '../api';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, StatusLine, Wrap } from '../components/ui';
import { Icon, IconName } from '../components/Icon';
import { Wordmark } from '../components/Wordmark';
import { useViewport } from '../hooks/useViewport';

/**
 * What an invite link opens (Group Trips, Epic 3).
 *
 * The person holding it has never heard of Roam and is not signed in to
 * anything: they see what is being asked of them first, and are asked who they
 * are at the first thing they tap. Possession of the link is not proof of
 * identity, so their name is whatever they type — and the screen says so.
 *
 * They see their own list and nothing about anybody else: no roster, no other
 * person's payment or booking state, no contact details. That is enforced by
 * the API (routes/groups.js) and by the offline policy, which lets this page
 * be saved to their device and lets the organiser's view nowhere near it.
 */

const KEY = 'roam.join';
const money = (p?: number | null) => (p == null ? '' : `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`);
const day = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) : '');
const shortDay = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const ICON: Record<string, IconName> = { stay: 'hotel', activity: 'ticket', fee: 'money' };

const remembered = (token: string): string | null =>
  (Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage.getItem(`${KEY}.${token}`) : null);
const remember = (token: string, participantToken: string) => {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.setItem(`${KEY}.${token}`, participantToken);
};

export function JoinScreen({ token }: { token: string }) {
  const { width } = useViewport();
  const [me, setMe] = useState<string | null>(() => remembered(token));
  const [v, setV] = useState<JoinView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);

  const load = useCallback(async () => {
    try { setV(await api.joinView(token, me)); setError(null); } catch (e: any) { setError(e.message); }
  }, [token, me]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<JoinView>) => {
    setBusy(true);
    try { setV(await fn()); setError(null); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (error && !v) {
    return (
      <View style={styles.page}>
        <Wordmark height={34} />
        <Card><Text style={type.h2}>This link is closed</Text><Text style={type.small}>{error}</Text></Card>
      </View>
    );
  }
  if (!v) return <View style={styles.page}><Wordmark height={34} /><Text style={type.small}>Opening…</Text></View>;

  const you = v.you;
  const required = v.items.filter((i) => i.required);
  const optional = v.items.filter((i) => !i.required);
  const outstanding = you ? required.filter((i) => !i.mine || !['booked', 'declared', 'paid'].includes(i.mine.status)).length : required.length;

  return (
    <ScrollView contentContainerStyle={[styles.page, width >= 900 && { maxWidth: 720, alignSelf: 'center' }]}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Wordmark height={30} />
        {v.group.organiser ? <Text style={type.tiny}>INVITED BY {v.group.organiser.toUpperCase()}</Text> : null}
      </Row>
      <View style={{ gap: 2 }}>
        <Text style={type.title}>{v.group.name ?? v.trip.title ?? 'A trip'}</Text>
        <Text style={type.small}>
          {v.trip.startDate ? `${shortDay(v.trip.startDate)} – ${shortDay(v.trip.endDate)}` : ''}
          {v.trip.place ? ` · ${v.trip.place}` : ''}
          {v.group.joined ? ` · ${v.group.joined} going${v.group.heads > v.group.joined ? ` (${v.group.heads} people)` : ''}` : ''}
        </Text>
      </View>

      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}

      <Card style={{ backgroundColor: colors.surfaceMuted }}>
        <Row style={{ alignItems: 'flex-start' }}>
          <Icon name="list" size={16} />
          <Text style={[type.small, { flex: 1 }]}>
            {you
              ? outstanding ? `${outstanding} thing${outstanding === 1 ? '' : 's'} still to do${v.group.wantedBy ? `, by ${day(v.group.wantedBy)}` : ''}.` : 'That is everything. Nothing else is needed from you.'
              : `${required.length} thing${required.length === 1 ? '' : 's'} ${v.group.organiser ?? 'the organiser'} needs from you${v.group.wantedBy ? `, by ${day(v.group.wantedBy)}` : ''}. Start any of them and you will be asked your name once.`}
          </Text>
        </Row>
      </Card>

      {v.items.map((i) => (
        <ItemCard
          key={i.id}
          item={i}
          organiser={v.group.organiser}
          joined={Boolean(you)}
          trip={v.trip}
          onAsk={() => setJoining(true)}
          onSet={(body) => act(() => api.setJoinItem(token, i.id, { participantToken: me!, ...body }))}
        />
      ))}

      {!you ? (
        joining || v.group.closed ? null : <Button label={`Tell ${v.group.organiser ?? 'them'} I'm coming`} icon="add" onPress={() => setJoining(true)} />
      ) : (
        <Text style={type.tiny}>
          You are in this trip as {you.name}{you.heads > 1 ? ` and ${you.heads - 1} other${you.heads > 2 ? 's' : ''}${you.brings ? ` (${you.brings})` : ''}` : ''}.
          {' '}Only {v.group.organiser ?? 'the organiser'} sees this list. Nobody else in the group does, and you cannot see theirs.
        </Text>
      )}

      {joining && !you ? (
        <JoinForm
          v={v}
          busy={busy}
          onCancel={() => setJoining(false)}
          onJoin={async (body) => {
            setBusy(true);
            try {
              const r = await api.join(token, body);
              remember(token, r.participantToken);
              setMe(r.participantToken); setV(r); setJoining(false); setError(null);
            } catch (e: any) { setError(e.message); } finally { setBusy(false); }
          }}
        />
      ) : null}

      {v.group.closed ? <StatusLine tone="warn">This group is not taking any more people. Ask {v.group.organiser ?? 'the organiser'} if you think that is wrong.</StatusLine> : null}
      <Text style={type.tiny}>
        No account, no password. Roam keeps your name and the one way to reach you that you gave, for this trip.
        {optional.length ? ' Saying yes or no to the optional things is how a table gets booked for the right number.' : ''}
      </Text>
    </ScrollView>
  );
}

function ItemCard({ item, organiser, joined, trip, onAsk, onSet }: {
  item: JoinView['items'][number]; organiser: string | null; joined: boolean; trip: JoinView['trip'];
  onAsk: () => void; onSet: (body: any) => void;
}) {
  const [declaring, setDeclaring] = useState(false);
  const [where, setWhere] = useState('');
  const [ref, setRef] = useState('');
  // The nights, for a room: the trip's own dates to begin with, so booking the
  // wrong weekend takes effort rather than happening by accident.
  const [from, setFrom] = useState(trip.startDate ?? '');
  const [to, setTo] = useState(trip.endDate ?? '');
  const s = item.mine;
  const tap = (fn: () => void) => () => (joined ? fn() : onAsk());

  return (
    <Card>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ paddingTop: 2 }}><Icon name={ICON[item.kind] ?? 'place'} size={16} color={s ? colors.like : colors.icon} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.h3}>{item.label}{item.kind === 'fee' && item.amountPence ? ` · ${money(item.amountPence)}` : ''}</Text>
          {item.detail ? <Text style={type.small}>{item.detail}</Text> : null}
          {!item.required ? <Text style={type.tiny}>OPTIONAL — {organiser ?? 'they'} just need{organiser ? 's' : ''} to know if you are coming</Text> : null}
          {item.kind === 'fee' && item.refundRule === 'until' && item.refundUntil ? (
            <Text style={type.tiny}>Refundable until {day(item.refundUntil)}. Pay {organiser ?? 'the organiser'} directly — Roam does not take the money.</Text>
          ) : null}
          {s ? (
            <Text style={[type.small, { color: colors.like, fontWeight: '700' }]}>
              {s.status === 'declared' ? `You said you booked this${s.whereBooked ? ` with ${s.whereBooked}` : ''}${s.bookingRef ? ` · ${s.bookingRef}` : ''}`
                : s.status === 'booked' ? 'Booked'
                : s.status === 'paid' ? `Paid · ${shortDay(s.on)}`
                : s.status === 'in' ? "You're coming" : 'You said no thanks'}
            </Text>
          ) : null}
        </View>
      </Row>

      {item.kind === 'fee' ? (
        <Text style={type.tiny}>{s?.status === 'paid' ? `${organiser ?? 'The organiser'} has ticked this off.` : `${organiser ?? 'The organiser'} ticks this off when it reaches them.`}</Text>
      ) : item.required ? (
        declaring ? (
          <View style={{ gap: spacing.sm }}>
            <Text style={type.tiny}>WHERE DID YOU BOOK?</Text>
            <TextInput value={where} onChangeText={setWhere} placeholder="Booking.com, or the hotel itself" placeholderTextColor={colors.inkFaint} style={styles.input} />
            <Text style={type.tiny}>REFERENCE, IF YOU HAVE ONE</Text>
            <TextInput value={ref} onChangeText={setRef} placeholder="Only so they can ask about it" placeholderTextColor={colors.inkFaint} style={styles.input} />
            {item.kind === 'stay' ? (
              <View style={{ gap: spacing.sm }}>
                <Text style={type.tiny}>WHICH NIGHTS?</Text>
                <Row>
                  <TextInput value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
                  <TextInput value={to} onChangeText={setTo} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
                </Row>
              </View>
            ) : null}
            <Text style={type.tiny}>Because you booked it away from Roam, nobody can confirm it. It shows on their list as your word for it.</Text>
            <Row>
              <Button label="That's booked" onPress={() => { onSet({ status: 'declared', whereBooked: where.trim() || null, bookingRef: ref.trim() || null, startsOn: item.kind === 'stay' ? from || null : null, endsOn: item.kind === 'stay' ? to || null : null }); setDeclaring(false); }} />
              <Button label="Cancel" kind="ghost" onPress={() => setDeclaring(false)} />
            </Row>
          </View>
        ) : (
          <Wrap>
            {s
              ? <Chip label="Undo" icon="close" onPress={tap(() => onSet({ status: 'clear' }))} />
              : <Chip label="I've booked it" icon="check" onPress={tap(() => setDeclaring(true))} />}
          </Wrap>
        )
      ) : (
        <Wrap>
          <Chip label="I'm in" icon="check" selected={s?.status === 'in'} onPress={tap(() => onSet({ status: s?.status === 'in' ? 'clear' : 'in' }))} />
          <Chip label="Not for me" icon="close" selected={s?.status === 'out'} onPress={tap(() => onSet({ status: s?.status === 'out' ? 'clear' : 'out' }))} />
        </Wrap>
      )}
    </Card>
  );
}

/** Joining is a name, one contact, and how many are with them. Nothing else. */
function JoinForm({ v, busy, onJoin, onCancel }: { v: JoinView; busy: boolean; onJoin: (body: any) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [heads, setHeads] = useState(1);
  const [brings, setBrings] = useState('');
  const [matchId, setMatchId] = useState<string | null>(null);
  return (
    <Card>
      <Text style={type.h2}>Who shall I say you are?</Text>
      <Text style={type.small}>{v.group.organiser ?? 'The organiser'} sees your name and how to reach you, and nothing else about you.</Text>
      {v.expecting.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.tiny}>THEY ARE EXPECTING</Text>
          <Wrap>
            {v.expecting.map((p) => (
              <Chip key={p.id} label={p.name} selected={matchId === p.id} onPress={() => { setMatchId(p.id); setName(p.name); }} />
            ))}
          </Wrap>
        </View>
      ) : null}
      <Text style={type.tiny}>YOUR NAME</Text>
      <TextInput value={name} onChangeText={(t) => { setName(t); setMatchId(null); }} placeholder="The name they know you by" placeholderTextColor={colors.inkFaint} style={styles.input} autoFocus />
      <Text style={type.tiny}>MOBILE OR EMAIL</Text>
      <TextInput value={contact} onChangeText={setContact} placeholder="So they can remind you — nothing else uses it" placeholderTextColor={colors.inkFaint} style={styles.input} autoCapitalize="none" />
      <Text style={type.tiny}>ANYONE WITH YOU?</Text>
      <Wrap>
        <Chip label="Just me" selected={heads === 1} onPress={() => { setHeads(1); setBrings(''); }} />
        <Chip label="One other" selected={heads === 2} onPress={() => setHeads(2)} />
        <Chip label="Two others" selected={heads === 3} onPress={() => setHeads(3)} />
      </Wrap>
      {heads > 1 ? <TextInput value={brings} onChangeText={setBrings} placeholder="Who is with you — a name and an age if they are a child" placeholderTextColor={colors.inkFaint} style={styles.input} /> : null}
      <Button
        label={busy ? 'Telling them…' : "That's me — I'm coming"}
        onPress={() => { if (!name.trim() || busy) return; onJoin({ name: name.trim(), contact: contact.trim() || undefined, heads, brings: brings.trim() || undefined, matchId }); }}
      />
      <Button label="Not now" kind="ghost" onPress={onCancel} />
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, width: '100%' },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink, fontFamily: fonts.body,
  },
});

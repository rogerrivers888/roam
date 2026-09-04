import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, GroupItem, GroupItemKind, GroupParticipant, TripDetail, TripGroup } from '../api';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Meter, Row, Segmented, StatusLine, Wrap } from './ui';
import { Icon, IconName } from './Icon';
import { useViewport } from '../hooks/useViewport';
import { getViewer } from '../viewer';

/**
 * The group, from the organiser's side (owner, 4 Sep 2026, on the mock-ups).
 *
 * The screen is the work, not the roster: what is still outstanding comes
 * first, the people are underneath it, and the same tree lays out as two
 * columns once there is room. Two of the owner's rules live here:
 *
 *   * Roam chases, the organiser does not. The reminder card says when the next
 *     run goes, who it will go to, and how many have gone; sending by hand is
 *     one button inside it rather than the way the screen works.
 *   * An item is either wanted from everybody or asked about. A required item
 *     is outstanding until it is done; an optional one is waiting for a yes or
 *     a no, and its number is a headcount for booking a table.
 */

const WIDE = 1000;
const money = (p?: number | null) => (p == null ? '' : `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`);
const day = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const daysUntil = (iso?: string | null) => (iso ? Math.round((new Date(`${iso.slice(0, 10)}T12:00:00`).getTime() - Date.now()) / 86400000) : null);
const ICON: Record<GroupItemKind, IconName> = { stay: 'hotel', activity: 'ticket', fee: 'money' };

export function GroupPanel({ d, onChanged }: { d: TripDetail; onChanged?: () => Promise<void> }) {
  const { width } = useViewport();
  const wide = width >= WIDE;
  const [g, setG] = useState<TripGroup | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPerson, setOpenPerson] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.tripGroup(d.trip.id);
      setG('group' in r && r.group === null ? null : (r as TripGroup));
    } catch (e: any) { setError(e.message); } finally { setLoaded(true); }
  }, [d.trip.id]);
  useEffect(() => { load(); }, [load]);

  /** Every write returns the whole group, so the screen is never guessing. */
  const run = async (fn: () => Promise<TripGroup>) => {
    setBusy(true); setError(null);
    try { setG(await fn()); await onChanged?.(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (!loaded) return <Text style={type.small}>Loading…</Text>;
  if (!g) return <StartGroup d={d} onCreated={(created) => { setG(created); void onChanged?.(); }} />;

  const { group, items, participants, summary, reminders, warnings } = g;
  const active = participants.filter((p) => !p.withdrawnAt);
  const notJoined = active.filter((p) => !p.joinedAt);
  const left = participants.filter((p) => p.withdrawnAt);
  const days = daysUntil(group.wantedBy);

  const outstanding = (
    <View style={{ gap: spacing.md }}>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={type.h2}>Still to chase</Text>
          <Text style={type.small}>{summary.joined} of {group.expectedCount ?? '—'} joined</Text>
        </Row>
        <Text style={type.small}>
          {group.wantedBy
            ? days != null && days >= 0 ? `Everything wanted by ${day(group.wantedBy)} — ${days} day${days === 1 ? '' : 's'} to go` : `Wanted by ${day(group.wantedBy)}`
            : 'No date set, so nobody is being chased yet.'}
          {summary.heads ? ` · ${summary.heads} head${summary.heads === 1 ? '' : 's'}` : ''}
        </Text>
        <Meter used={summary.complete} limit={Math.max(1, summary.joined)} label={`${summary.complete} of ${summary.joined} have done everything`} />
      </Card>

      {notJoined.length ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <Row><Icon name="person" size={16} /><Text style={type.h3}>{notJoined.length} {notJoined.length === 1 ? 'person has' : 'people have'} not joined</Text></Row>
            <Text style={[type.small, { color: colors.overrun, fontWeight: '700' }]}>{notJoined.length}</Text>
          </Row>
          <Text style={type.small}>{notJoined.map((p) => p.name).join(', ')}</Text>
        </Card>
      ) : null}

      {items.map((i) => (
        <ItemCard key={i.id} item={i} joined={summary.joined} onEdit={(body) => run(() => api.updateGroupItem(group.id, i.id, body))} onRemove={() => run(() => api.removeGroupItem(group.id, i.id))} busy={busy} />
      ))}

      <AddItem onAdd={(body) => run(() => api.addGroupItem(group.id, body))} busy={busy} />

      {warnings.length ? (
        <Card style={{ borderColor: colors.overrun }}>
          <Row><Icon name="allergen" size={16} color={colors.overrun} /><Text style={type.h3}>Worth a look</Text></Row>
          {warnings.map((w, n) => (
            <Text key={n} style={type.small}>
              <Text style={{ fontWeight: '700', color: colors.ink }}>{w.name}</Text> has “{w.item}” for {w.said}. The trip is {w.wanted}.
            </Text>
          ))}
        </Card>
      ) : null}
    </View>
  );

  const roster = (
    <View style={{ gap: spacing.md }}>
      <Chasing group={g} busy={busy} onChange={(body) => run(() => api.updateGroup(group.id, body))} onSendNow={() => run(() => api.chaseGroup(group.id))} />
      <Invite group={g} busy={busy} onChange={(body) => run(() => api.updateGroup(group.id, body))} onAdd={(body) => run(() => api.addGroupParticipant(group.id, body))} />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={type.h2}>Everyone</Text>
          <Text style={type.small}>{active.length} · {summary.heads} heads</Text>
        </Row>
        {active.map((p) => (
          <PersonRow
            key={p.id}
            p={p}
            items={items}
            open={openPerson === p.id}
            busy={busy}
            onOpen={() => setOpenPerson(openPerson === p.id ? null : p.id)}
            onMark={(itemId, body) => run(() => api.markGroupItem(group.id, p.id, itemId, body))}
            onChange={(body) => run(() => api.updateGroupParticipant(group.id, p.id, body))}
            onRemind={() => run(() => api.chaseGroup(group.id, { participantIds: [p.id] }))}
          />
        ))}
        {left.length ? (
          <View style={{ gap: 4, marginTop: spacing.sm }}>
            <Text style={type.tiny}>DROPPED OUT</Text>
            {left.map((p) => (
              <Row key={p.id} style={{ justifyContent: 'space-between' }}>
                <Text style={type.small}>{p.name} · left {when(p.withdrawnAt)}</Text>
                <Chip label="Back in" onPress={() => run(() => api.updateGroupParticipant(group.id, p.id, { withdrawn: false }))} />
              </Row>
            ))}
          </View>
        ) : null}
      </Card>
    </View>
  );

  return (
    <View style={{ gap: spacing.md }}>
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <View style={wide ? styles.columns : undefined}>
        <View style={wide ? styles.colLeft : undefined}>{outstanding}</View>
        <View style={wide ? styles.colRight : { marginTop: spacing.md }}>{roster}</View>
      </View>
    </View>
  );
}

/** Before there is a group: the dashed row at the bottom of a trip. */
function StartGroup({ d, onCreated }: { d: TripDetail; onCreated: (g: TripGroup) => void }) {
  const [expected, setExpected] = useState('');
  const [name, setName] = useState(d.trip.title ?? d.trip.place?.label ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card style={{ borderStyle: 'dashed' }}>
      <Row><Icon name="household" size={18} /><Text style={type.h2}>Is anyone else coming?</Text></Row>
      <Text style={type.small}>
        Turn this into a group trip and Roam will chase them for you: who is in, who has booked what, and who still owes you money.
        Everything you have already planned becomes the list they work from.
      </Text>
      <Text style={type.tiny}>WHAT TO CALL IT</Text>
      <TextInput value={name} onChangeText={setName} placeholder="The group" placeholderTextColor={colors.inkFaint} style={styles.input} />
      <Text style={type.tiny}>HOW MANY ARE YOU EXPECTING?</Text>
      <Row>
        <TextInput value={expected} onChangeText={setExpected} placeholder="24" placeholderTextColor={colors.inkFaint} keyboardType="number-pad" style={[styles.input, { width: 110 }]} />
        <Text style={type.tiny}>A target, not a limit. More can join; fewer is fine.</Text>
      </Row>
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <Button
        label={busy ? 'Making the group…' : 'Make this a group trip'}
        icon="add"
        onPress={async () => {
          if (busy) return;
          setBusy(true); setError(null);
          try {
            onCreated(await api.createTripGroup(d.trip.id, {
              name: name.trim() || undefined,
              expectedCount: expected ? Number(expected) : null,
              organiserMemberId: getViewer(d.attendees),
            }));
          } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}
      />
    </Card>
  );
}

/** One thing wanted from everybody, or asked about. */
function ItemCard({ item, joined, onEdit, onRemove, busy }: {
  item: GroupItem; joined: number; busy: boolean;
  onEdit: (body: any) => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const answered = item.required ? item.done : item.coming + item.notComing;
  return (
    <Card>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button">
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Row style={{ flex: 1, alignItems: 'flex-start' }}>
            <View style={{ paddingTop: 2 }}><Icon name={ICON[item.kind]} size={16} /></View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={type.h3}>{item.label}{item.kind === 'fee' && item.amountPence ? ` · ${money(item.amountPence)}` : ''}</Text>
              <Text style={type.small}>
                {item.kind === 'fee'
                  ? `${item.done} paid you · ${item.outstanding} to go`
                  : item.required
                    ? `${item.confirmed} booked${item.declared ? ` · ${item.declared} said so` : ''} · ${item.outstanding} to go`
                    : `${item.coming} coming (${item.heads} head${item.heads === 1 ? '' : 's'}) · ${item.notComing} not · ${item.outstanding} haven't said`}
              </Text>
              {item.detail ? <Text style={type.tiny}>{item.detail}</Text> : null}
            </View>
          </Row>
          <Text style={[type.small, { fontWeight: '700', color: item.outstanding && item.required ? colors.overrun : colors.inkMuted }]}>{item.outstanding}</Text>
        </Row>
      </Pressable>
      <Meter used={answered} limit={Math.max(1, joined)} />
      {item.outstandingNames.length ? (
        <Text style={type.tiny}>{item.required ? 'Waiting on' : 'Not heard from'}: {item.outstandingNames.join(', ')}{item.outstanding > item.outstandingNames.length ? ` and ${item.outstanding - item.outstandingNames.length} more` : ''}</Text>
      ) : null}
      {item.kind === 'fee' ? (
        <Text style={type.small}>{money(item.paidPence)} in · {money(item.duePence)} still owed to you. Tick people off as it reaches you — Roam does not take the money.</Text>
      ) : null}
      {open ? (
        <Wrap>
          <Chip label={item.required ? 'Wanted from everyone' : 'Just asking'} icon={item.required ? 'check' : 'info'} selected onPress={() => onEdit({ required: !item.required })} />
          {!busy ? <Chip label="Remove" icon="close" onPress={onRemove} /> : null}
        </Wrap>
      ) : null}
    </Card>
  );
}

function AddItem({ onAdd, busy }: { onAdd: (body: any) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<GroupItemKind>('activity');
  const [label, setLabel] = useState('');
  const [detail, setDetail] = useState('');
  const [amount, setAmount] = useState('');
  const [required, setRequired] = useState(true);
  if (!open) return <Button label="Ask for something else" icon="add" kind="ghost" onPress={() => setOpen(true)} />;
  return (
    <Card>
      <Text style={type.h3}>Something else you want from everyone</Text>
      <Segmented
        value={kind}
        options={[{ value: 'activity' as GroupItemKind, label: 'Something to book' }, { value: 'stay' as GroupItemKind, label: 'Somewhere to stay' }, { value: 'fee' as GroupItemKind, label: 'Money to you' }]}
        onChange={(k) => { setKind(k); setRequired(k !== 'activity' ? true : required); }}
      />
      <TextInput value={label} onChangeText={setLabel} placeholder={kind === 'fee' ? 'What the money is for' : 'What they need to book'} placeholderTextColor={colors.inkFaint} style={styles.input} />
      <TextInput value={detail} onChangeText={setDetail} placeholder="In your own words — this is what they read" placeholderTextColor={colors.inkFaint} style={styles.input} />
      {kind === 'fee' ? <TextInput value={amount} onChangeText={setAmount} placeholder="45.00" placeholderTextColor={colors.inkFaint} keyboardType="decimal-pad" style={[styles.input, { width: 140 }]} /> : null}
      <Wrap>
        <Chip label="Wanted from everyone" selected={required} onPress={() => setRequired(true)} />
        <Chip label="Just asking who's in" selected={!required} onPress={() => setRequired(false)} />
      </Wrap>
      <Row>
        <Button
          label="Add it"
          onPress={() => {
            if (!label.trim() || busy) return;
            onAdd({ kind, label: label.trim(), detail: detail.trim() || undefined, required, amountPence: kind === 'fee' ? Math.round(Number(amount || 0) * 100) : undefined });
            setOpen(false); setLabel(''); setDetail(''); setAmount('');
          }}
        />
        <Button label="Not now" kind="ghost" onPress={() => setOpen(false)} />
      </Row>
    </Card>
  );
}

/**
 * The chasing card: what Roam is doing on the organiser's behalf, and when.
 * The point of it is that they do not have to do anything (owner, 4 Sep 2026),
 * so it leads with the next run and the count, and hides sending by hand
 * behind the settings.
 */
function Chasing({ group: g, busy, onChange, onSendNow }: { group: TripGroup; busy: boolean; onChange: (body: any) => void; onSendNow: () => void }) {
  const [open, setOpen] = useState(false);
  const [wantedBy, setWantedBy] = useState(g.group.wantedBy ?? '');
  const r = g.reminders;
  const nextIn = r.next ? daysUntil(r.next.date) : null;
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row><Icon name="hours" size={16} /><Text style={type.h2}>Roam is chasing</Text></Row>
        <Chip label={r.on ? 'On' : 'Off'} icon={r.on ? 'check' : 'close'} selected={r.on} onPress={() => onChange({ remindersOn: !r.on })} />
      </Row>
      {r.on ? (
        <Text style={type.small}>
          {r.next
            ? `Next reminder ${day(r.next.date)}${nextIn != null && nextIn >= 0 ? nextIn === 0 ? ', today' : ` — in ${nextIn} day${nextIn === 1 ? '' : 's'}` : ''}, to ${r.next.recipients} ${r.next.recipients === 1 ? 'person' : 'people'} with something outstanding.`
            : g.group.wantedBy ? 'Every reminder for this group has been sent.' : 'Set a date everything is wanted by and Roam will start chasing.'}
        </Text>
      ) : (
        <Text style={type.small}>Nobody is being chased. You are doing it yourself.</Text>
      )}
      <Row style={{ flexWrap: 'wrap' }}>
        <Text style={type.small}><Text style={{ fontWeight: '700', color: colors.ink }}>{r.written}</Text> written so far</Text>
        {r.schedule.length ? <Text style={type.small}>· {r.schedule.filter((s) => s.done).length} of {r.schedule.length} runs done</Text> : null}
      </Row>
      {!r.channelReady && r.on ? (
        <View style={styles.warnBox}>
          <Icon name="allergen" size={15} color={colors.overrun} />
          <Text style={[type.small, { flex: 1 }]}>
            {r.undelivered > 0
              ? `${r.undelivered} ${r.undelivered === 1 ? 'reminder is' : 'reminders are'} written and waiting. `
              : 'Roam will write these and keep them for you. '}
            <Text style={{ fontWeight: '700', color: colors.ink }}>Nothing can be delivered yet</Text> — no way to send messages is connected.
            Add one and every reminder goes out on the next run.
          </Text>
        </View>
      ) : null}
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button"><Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>{open ? 'Hide the schedule' : 'See the schedule'}</Text></Pressable>
      {open ? (
        <View style={{ gap: spacing.sm }}>
          {r.schedule.map((s) => (
            <Row key={s.date} style={{ justifyContent: 'space-between' }}>
              <Row><Icon name={s.done ? 'booked' : 'hours'} size={14} color={s.done ? colors.like : colors.inkMuted} /><Text style={type.small}>{day(s.date)} · 9am</Text></Row>
              <Text style={type.tiny}>{s.done ? 'sent' : `${s.daysBefore} days before`}</Text>
            </Row>
          ))}
          <Text style={type.tiny}>HOW OFTEN</Text>
          <Segmented value={g.group.cadence} options={r.cadences.map((c) => ({ value: c.key, label: `${c.label} (${c.runs})` }))} onChange={(c) => onChange({ cadence: c })} />
          <Text style={type.tiny}>EVERYTHING WANTED BY</Text>
          <Row>
            <TextInput value={wantedBy} onChangeText={setWantedBy} onBlur={() => wantedBy !== g.group.wantedBy && onChange({ wantedBy: wantedBy || null })} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { width: 160 }]} />
            <Text style={type.tiny}>The date the schedule counts back from.</Text>
          </Row>
          <Button label={busy ? 'Writing…' : 'Send one now'} icon="forward" kind="secondary" onPress={onSendNow} />
          <Text style={type.tiny}>You should not need this. It is here for the week everything changes.</Text>
          {r.recent.length ? (
            <View style={{ gap: 4 }}>
              <Text style={type.tiny}>WHAT HAS GONE OUT</Text>
              {r.recent.filter((x) => x.who).slice(0, 6).map((x) => (
                <Text key={x.id} style={type.tiny}>{when(x.on)} · {x.who} · {x.status === 'sent' ? 'sent' : 'waiting to send'} — “{x.body.slice(0, 90)}…”</Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function Invite({ group: g, busy, onChange, onAdd }: { group: TripGroup; busy: boolean; onChange: (body: any) => void; onAdd: (body: any) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [copied, setCopied] = useState(false);
  const link = useMemo(() => {
    const base = Platform.OS === 'web' && typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : 'https://roam.app/';
    return `${base}?join=${g.group.inviteToken}`;
  }, [g.group.inviteToken]);
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row><Icon name="shortlist" size={16} /><Text style={type.h2}>Ask them in</Text></Row>
        <Chip label={g.group.closed ? 'Closed' : 'Open'} icon={g.group.closed ? 'locked' : 'check'} selected={!g.group.closed} onPress={() => onChange({ closed: !g.group.closed })} />
      </Row>
      <Text style={type.tiny} selectable numberOfLines={2}>{link}</Text>
      <Wrap>
        <Chip
          label={copied ? 'Copied' : 'Copy the link'}
          icon={copied ? 'check' : 'external'}
          onPress={async () => {
            if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }
          }}
        />
        <Chip label="New link" icon="refresh" onPress={() => onChange({ newLink: true })} />
        <Chip label="Add someone by name" icon="add" onPress={() => setOpen(!open)} />
      </Wrap>
      <Text style={type.tiny}>Anyone with the link can join, so what they type is all we know about them. Adding a name first means their join lands on that row.</Text>
      {open ? (
        <View style={{ gap: spacing.sm }}>
          <TextInput value={name} onChangeText={setName} placeholder="Their name" placeholderTextColor={colors.inkFaint} style={styles.input} />
          <TextInput value={contact} onChangeText={setContact} placeholder="Mobile or email, so Roam can remind them" placeholderTextColor={colors.inkFaint} style={styles.input} autoCapitalize="none" />
          <Button
            label="Add them"
            onPress={() => { if (!name.trim() || busy) return; onAdd({ name: name.trim(), contact: contact.trim() || undefined }); setName(''); setContact(''); }}
          />
        </View>
      ) : null}
    </Card>
  );
}

function PersonRow({ p, items, open, busy, onOpen, onMark, onChange, onRemind }: {
  p: GroupParticipant; items: GroupItem[]; open: boolean; busy: boolean;
  onOpen: () => void; onMark: (itemId: string, body: any) => void; onChange: (body: any) => void; onRemind: () => void;
}) {
  const [note, setNote] = useState(p.note ?? '');
  const done = items.filter((i) => i.required).length - p.outstanding.length;
  return (
    <View style={styles.person}>
      <Pressable onPress={onOpen} accessibilityRole="button">
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Row>
              <Text style={type.h3}>{p.name}</Text>
              {p.memberId ? <Chip label="You" selected /> : null}
              {p.heads > 1 ? <Text style={type.tiny}>{p.heads} heads</Text> : null}
            </Row>
            <Text style={type.small}>
              {!p.joinedAt ? `Not joined${p.invitedAt ? ` · link sent ${when(p.invitedAt)}` : ''}`
                : p.outstanding.length ? `${p.outstanding.map((o) => o.label).slice(0, 2).join(', ')}${p.outstanding.length > 2 ? ` and ${p.outstanding.length - 2} more` : ''} outstanding`
                : 'All done'}
              {p.lastRemindedAt ? ` · chased ${when(p.lastRemindedAt)}` : ''}
            </Text>
          </View>
          <Icon name={open ? 'collapse' : 'more'} size={16} />
        </Row>
      </Pressable>
      {open ? (
        <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
          {items.map((i) => {
            const s = p.states[i.id];
            const label = !s ? 'Nothing yet'
              : s.status === 'declared' ? `Their word: ${s.whereBooked ?? 'booked elsewhere'}${s.bookingRef ? ` · ${s.bookingRef}` : ''}`
              : s.status === 'booked' ? `Booked${s.bookingRef ? ` · ${s.bookingRef}` : ''}`
              : s.status === 'paid' ? `Paid ${money(s.amountPence ?? i.amountPence)} · ${when(s.on)}`
              : s.status === 'in' ? 'Coming' : 'Not coming';
            return (
              <Row key={i.id} style={{ justifyContent: 'space-between' }}>
                <Row style={{ flex: 1 }}>
                  <Icon name={ICON[i.kind]} size={14} color={s ? colors.like : colors.inkMuted} />
                  <View style={{ flex: 1 }}>
                    <Text style={type.small}>{i.label}</Text>
                    <Text style={type.tiny}>{label}</Text>
                  </View>
                </Row>
                {i.kind === 'fee'
                  ? <Chip label={s?.status === 'paid' ? 'Paid' : 'Mark as paid'} selected={s?.status === 'paid'} onPress={() => onMark(i.id, { status: s?.status === 'paid' ? 'clear' : 'paid' })} />
                  : <Chip label={s ? 'Undo' : 'Mark done'} selected={Boolean(s)} onPress={() => onMark(i.id, { status: s ? 'clear' : 'booked' })} />}
              </Row>
            );
          })}
          <Text style={type.tiny}>A NOTE, JUST FOR YOU</Text>
          <TextInput value={note} onChangeText={setNote} onBlur={() => note !== (p.note ?? '') && onChange({ note })} placeholder="They never see this" placeholderTextColor={colors.inkFaint} style={styles.input} />
          {p.reminders.length ? <Text style={type.tiny}>Chased {p.reminders.length} time{p.reminders.length === 1 ? '' : 's'} — last {when(p.lastRemindedAt)}</Text> : null}
          <Wrap>
            {p.contact
              ? <Chip
                  label={p.contact}
                  icon={p.contactKind === 'email' ? 'info' : 'phone'}
                  onPress={() => { if (Platform.OS === 'web' && typeof window !== 'undefined') window.open(`${p.contactKind === 'email' ? 'mailto:' : 'tel:'}${p.contact}`); }}
                />
              : <Chip label="No way to reach them" icon="allergen" />}
            <Chip label="Remind now" icon="forward" onPress={onRemind} />
            <Chip label="They're out" icon="close" onPress={() => onChange({ withdrawn: true })} />
          </Wrap>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  columns: { flexDirection: 'row', gap: spacing.lg, alignItems: 'flex-start' },
  colLeft: { flex: 1, minWidth: 0 },
  colRight: { width: 380 },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink, fontFamily: fonts.body,
  },
  person: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm, marginTop: spacing.sm },
  warnBox: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.overrun, backgroundColor: colors.overrunSoft },
});

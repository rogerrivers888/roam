import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, GroupItem, GroupItemInput, GroupItemKind, GroupParticipant, TripDetail, TripGroup } from '../api';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Meter, Row, Segmented, StatusLine, Wrap } from './ui';
import { Icon, IconName } from './Icon';
import { QrCode } from './QrCode';
import { useViewport } from '../hooks/useViewport';
import { getViewer } from '../viewer';

/**
 * The group, from the organiser's side.
 *
 * Setting one up is four numbered questions in the owner's order (4 Sep 2026):
 * what everyone must do, how people get in, how often Roam chases, and what you
 * are charging for. They read as a wizard the first time — numbered, the one
 * you are on is the one that is open — and are a settings page ever after,
 * because the second visit is always "the coach quote came back higher".
 *
 * Chasing appears above them only once somebody has joined: an empty group is
 * not behind on anything.
 */


/**
 * The six things setting a group up asks, in the order they build on each
 * other. Each carries a line saying what it is for, because a title and a count
 * assume the organiser already knows what a group is — and they do not (owner,
 * 4 Sep 2026). The same six are the wizard on the first run and the settings
 * afterwards.
 */
type StepKey = 'what' | 'wanted' | 'minimum' | 'costs' | 'chasing' | 'invite';
const STEPS: { key: StepKey; title: string; blurb: string }[] = [
  { key: 'what', title: 'What this is', blurb: 'Give it a name the people you invite will recognise, and say roughly how many you are expecting. Both can be changed later.' },
  { key: 'wanted', title: 'What must everyone do?', blurb: 'Not everyone has to do everything. Mark what you want from every single person, and what you are only asking about — a dinner you need a number for, say.' },
  { key: 'minimum', title: 'How many do you need?', blurb: 'If this only works with a certain number of people, say so. Below it on the closing day the trip is called off and everybody is told. Most trips do not need one — leave it empty and it goes ahead with whoever comes.' },
  { key: 'costs', title: 'Anything you are paying for?', blurb: 'Things you are out of pocket for that others should chip in on: a coach, tickets, a kitty. A coach can be an extra that only some people want, priced by how many say yes — cheaper the more of them there are.' },
  { key: 'chasing', title: 'How often Roam chases', blurb: 'You should not have to ask anybody twice. Roam writes to whoever still has something outstanding, on a schedule counting back from the date you want it all by.' },
  { key: 'invite', title: 'Ask them in', blurb: 'A code to hold up at training, a link to paste, a WhatsApp group, or the names you already know. Anyone holding the link can join, so what they type is all anybody knows about them.' },
];

const WIDE = 1000;
const money = (p?: number | null) => (p == null ? '—' : `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`);
const day = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const daysUntil = (iso?: string | null) => (iso ? Math.round((new Date(`${iso.slice(0, 10)}T12:00:00`).getTime() - Date.now()) / 86400000) : null);
const ICON: Record<GroupItemKind, IconName> = { stay: 'hotel', activity: 'ticket', fee: 'money' };
const pence = (text: string) => (text.trim() === '' ? null : Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100));
const numberOrNull = (text: string) => (text.trim() === '' ? null : Math.max(0, Math.round(Number(text.replace(/[^0-9]/g, '')))));

/** A number is typed, never nudged (owner, 4 Sep 2026). */
function NumberBox({ value, onChange, placeholder, width = 88, prefix }: {
  value: string; onChange: (v: string) => void; placeholder?: string; width?: number; prefix?: string;
}) {
  return (
    <View style={[styles.numberBox, { width }]}>
      {prefix ? <Text style={[type.small, { color: colors.inkMuted }]}>{prefix}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.inkFaint}
        keyboardType="number-pad"
        returnKeyType="done"
        selectTextOnFocus
        style={styles.numberInput}
      />
    </View>
  );
}

/** One of the four numbered questions: open, or folded to a line. */
function Block({ n, title, blurb, summary, open, onToggle, children }: {
  n: number; title: string; blurb: string; summary: string; open: boolean; onToggle: () => void; children?: React.ReactNode;
}) {
  return (
    <Card style={{ gap: open ? spacing.sm : 0 }}>
      <Pressable onPress={onToggle} accessibilityRole="button">
        <Row style={{ alignItems: 'flex-start' }}>
          <View style={[styles.blockNumber, open && { backgroundColor: colors.primary }]}>
            <Text style={[styles.blockNumberText, open && { color: colors.primaryFg }]}>{n}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={type.h3}>{title}</Text>
            <Text style={type.small}>{summary}</Text>
          </View>
          <Icon name={open ? 'collapse' : 'expand'} size={16} />
        </Row>
      </Pressable>
      {open ? <Text style={type.small}>{blurb}</Text> : null}
      {open ? children : null}
    </Card>
  );
}


export function GroupPanel({ d, onChanged }: { d: TripDetail; onChanged?: () => Promise<void> }) {
  const { width } = useViewport();
  const wide = width >= WIDE;
  const [g, setG] = useState<TripGroup | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [block, setBlock] = useState<number | null>(1);

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
  const settingUp = !active.some((p) => p.joinedAt && !p.memberId);
  const wanted = items.filter((i) => i.kind !== 'fee' || !i.pricing);
  const costs = items.filter((i) => Boolean(i.pricing));
  const toGo = items.filter((i) => i.required && i.outstanding > 0);
  const owed = costs.reduce((n, i) => n + (i.money?.duePence ?? 0), 0);
  const gotIn = costs.reduce((n, i) => n + (i.money?.paidPence ?? 0), 0);

  const setItem = (id: string, body: Partial<GroupItemInput>) => run(() => api.updateGroupItem(group.id, id, body));

  // --- what is still outstanding, once there is somebody to chase ------------
  const chase = (
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
          {group.minimumCount ? ` · needs ${group.minimumCount}` : ''}
        </Text>
        <Meter used={summary.complete} limit={Math.max(1, summary.joined)} label={`${summary.complete} of ${summary.joined} have done everything`} />
        {group.minimumCount && summary.heads < group.minimumCount ? (
          <View style={styles.warnBox}>
            <Icon name="allergen" size={15} color={colors.overrun} />
            <Text style={[type.small, { flex: 1 }]}>
              {group.minimumCount - summary.heads} more needed by {day(group.wantedBy)} or the trip is cancelled.
            </Text>
          </View>
        ) : null}
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

      {toGo.map((i) => (
        <Card key={i.id}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Row style={{ flex: 1, alignItems: 'flex-start' }}>
              <View style={{ paddingTop: 2 }}><Icon name={ICON[i.kind]} size={16} /></View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.h3}>{i.label}</Text>
                <Text style={type.small}>{itemLine(i)}</Text>
              </View>
            </Row>
            <Text style={[type.small, { fontWeight: '700', color: colors.overrun }]}>{i.outstanding}</Text>
          </Row>
          <Meter used={i.done} limit={Math.max(1, summary.joined)} />
          {i.outstandingNames.length ? <Text style={type.tiny}>Waiting on: {i.outstandingNames.join(', ')}</Text> : null}
        </Card>
      ))}

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

  // --- the four questions ---------------------------------------------------
  // Each step's content, written once: the wizard shows one at a time, the
  // settings page shows them folded.
  const content: Record<StepKey, React.ReactNode> = {
    what: <WhatThisIs group={g} onChange={(body) => run(() => api.updateGroup(group.id, body))} />,
    wanted: (
      <>
        {wanted.map((i) => (
          <View key={i.id} style={styles.wantedRow}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ paddingTop: 2 }}><Icon name={ICON[i.kind]} size={15} /></View>
              <View style={{ flex: 1 }}>
                <Text style={type.small}>{i.label}</Text>
                {i.detail ? <Text style={type.tiny}>{i.detail}</Text> : null}
              </View>
            </Row>
            <Wrap>
              <Chip label="Everyone" icon="check" selected={i.required} onPress={() => setItem(i.id, { required: true })} />
              <Chip label="Just asking" icon="info" selected={!i.required} onPress={() => setItem(i.id, { required: false })} />
              <Chip label="Not in it" icon="close" onPress={() => run(() => api.removeGroupItem(group.id, i.id))} />
            </Wrap>
          </View>
        ))}
        {wanted.length === 0 ? <Text style={type.small}>Nothing on this trip yet. Add what people need to book or bring.</Text> : null}
        <AddWanted onAdd={(body) => run(() => api.addGroupItem(group.id, body))} />
      </>
    ),
    minimum: <Minimum group={g} joinedHeads={summary.heads} onChange={(body) => run(() => api.updateGroup(group.id, body))} />,
    costs: (
      <>
        {costs.map((i) => (
          <CostCard
            key={i.id}
            item={i}
            group={g}
            busy={busy}
            onEdit={(body) => setItem(i.id, body)}
            onClose={(body) => run(() => api.closeGroupItem(group.id, i.id, body))}
            onRemove={() => run(() => api.removeGroupItem(group.id, i.id))}
          />
        ))}
        <AddCost group={g} onAdd={(body) => run(() => api.addGroupItem(group.id, body))} />
      </>
    ),
    chasing: <Chasing group={g} busy={busy} settingUp={settingUp} onChange={(body) => run(() => api.updateGroup(group.id, body))} onSendNow={() => run(() => api.chaseGroup(group.id))} />,
    invite: <Invite group={g} settingUp={settingUp} onChange={(body) => run(() => api.updateGroup(group.id, body))} onAdd={(body) => run(() => api.addGroupParticipant(group.id, body))} />,
  };

  const summaries: Record<StepKey, string> = {
    what: `${group.name ?? 'Unnamed'}${group.expectedCount ? ` · ${group.expectedCount} expected` : ''}`,
    wanted: `${wanted.filter((i) => i.required).length} wanted from everyone, ${wanted.filter((i) => !i.required).length} asked about`,
    minimum: group.minimumCount ? `${group.minimumCount} needed, or it is off` : 'No minimum — it goes ahead with whoever comes',
    costs: costs.length ? `${costs.length} cost${costs.length === 1 ? '' : 's'} · ${money(gotIn)} in, ${money(owed)} owed` : 'Nothing — you are not charging for anything',
    chasing: !reminders.on ? 'Off — you are chasing them yourself'
      : reminders.next ? `${reminders.cadence} — next on ${day(reminders.next.date)}`
      : group.wantedBy ? 'Every reminder has been sent' : 'Set a date and Roam will chase',
    invite: settingUp ? 'Nobody asked in yet' : `${summary.joined} joined of ${group.expectedCount ?? '—'}`,
  };

  // First run: one step at a time, each saying what it is for.
  if (!group.setupDone) {
    return (
      <View style={{ gap: spacing.md }}>
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
        <Wizard
          content={content}
          summaries={summaries}
          onDone={() => run(() => api.updateGroup(group.id, { setupDone: true }))}
        />
      </View>
    );
  }

  const blocks = (
    <View style={{ gap: spacing.md }}>
      {STEPS.map((s, n) => (
        <Block
          key={s.key}
          n={n + 1}
          title={s.title}
          blurb={s.blurb}
          summary={summaries[s.key]}
          open={block === n + 1}
          onToggle={() => setBlock(block === n + 1 ? null : n + 1)}
        >
          {content[s.key]}
        </Block>
      ))}
    </View>
  );

  const roster = (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.h2}>{settingUp ? 'Who you have added' : 'Everyone'}</Text>
        <Text style={type.small}>{active.length} · {summary.heads} heads</Text>
      </Row>
      {settingUp ? <Text style={type.small}>Nobody has joined yet. A name added here means their join lands on that row rather than making a second one.</Text> : null}
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
  );

  // The trip itself can be called off by its own minimum; say so above everything.
  const cancelled = group.cancelledAt ? (
    <Card style={{ borderColor: colors.overrun }}>
      <Row><Icon name="allergen" size={16} color={colors.overrun} /><Text style={type.h2}>This trip was called off</Text></Row>
      <Text style={type.small}>{group.cancelledNote} Everybody has been told, and nothing was taken from anyone.</Text>
    </Card>
  ) : null;

  return (
    <View style={{ gap: spacing.md }}>
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      {cancelled}
      <View style={wide ? styles.columns : undefined}>
        <View style={wide ? styles.colLeft : undefined}>{settingUp ? blocks : chase}</View>
        <View style={wide ? styles.colRight : { marginTop: spacing.md }}>{settingUp ? roster : <View style={{ gap: spacing.md }}>{roster}{blocks}</View>}</View>
      </View>
    </View>
  );
}

/** The one line under an item's name: what is done, or who has said yes. */
function itemLine(i: GroupItem) {
  if (i.pricing) return costLine(i);
  return i.required
    ? `${i.confirmed} booked${i.declared ? ` · ${i.declared} said so` : ''} · ${i.outstanding} to go`
    : `${i.coming} coming (${i.heads} head${i.heads === 1 ? '' : 's'}) · ${i.notComing} not · ${i.outstanding} haven't said`;
}

/** A cost, in one line: what it is worth knowing before opening it. */
function costLine(i: GroupItem) {
  const m = i.money;
  if (!m) return '';
  if (i.state === 'cancelled') return `Called off — ${i.cancelledNote ?? 'it did not reach its minimum'}`;
  if (i.state === 'closed') return `${money(i.settledPence)} each × ${i.settledHeads} · ${money(m.paidPence)} in, ${money(m.duePence)} owed · due ${day(i.dueOn)}`;
  if (i.pricing === 'fixed') return `${money(i.amountPence)} each · ${money(m.paidPence)} in, ${money(m.duePence)} owed`;
  return `${money(i.totalPence)} to get back · no more than ${money(m.ceilingPence)} each · ${m.shares} on it${m.minimum ? `, needs ${m.minimum}` : ''}`;
}


/**
 * The first run: one step at a time, with what the step is for at the top of
 * it, and a way past anything that does not apply. Nothing here is compulsory —
 * every step can be skipped and changed later from the same six blocks.
 */
function Wizard({ content, summaries, onDone }: {
  content: Record<StepKey, React.ReactNode>; summaries: Record<StepKey, string>; onDone: () => void;
}) {
  const [at, setAt] = useState(0);
  const step = STEPS[at];
  const last = at === STEPS.length - 1;
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.tiny}>STEP {at + 1} OF {STEPS.length}</Text>
        <Text style={type.tiny}>{summaries[step.key]}</Text>
      </Row>
      <View style={styles.progress}>
        {STEPS.map((s, i) => <View key={s.key} style={[styles.progressBar, i <= at && { backgroundColor: colors.accent }]} />)}
      </View>
      <Text style={type.h2}>{step.title}</Text>
      <Text style={type.small}>{step.blurb}</Text>
      <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>{content[step.key]}</View>
      <Row style={{ marginTop: spacing.md }}>
        {at > 0 ? <Button label="Back" icon="back" kind="ghost" onPress={() => setAt(at - 1)} /> : null}
        <View style={{ flex: 1 }} />
        {!last ? <Button label="Skip" kind="ghost" onPress={() => setAt(at + 1)} /> : null}
        <Button label={last ? "That's my group set up" : 'Next'} icon={last ? 'check' : 'forward'} onPress={() => (last ? onDone() : setAt(at + 1))} />
      </Row>
    </Card>
  );
}

/** Step 1: what the group is called, and roughly how big it is. */
function WhatThisIs({ group: g, onChange }: { group: TripGroup; onChange: (body: any) => void }) {
  const [name, setName] = useState(g.group.name ?? '');
  const [expected, setExpected] = useState(g.group.expectedCount == null ? '' : String(g.group.expectedCount));
  useEffect(() => { setName(g.group.name ?? ''); }, [g.group.name]);
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={type.tiny}>WHAT TO CALL IT</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        onBlur={() => name.trim() !== (g.group.name ?? '') && onChange({ name: name.trim() })}
        placeholder="Cardiff · rugby tour"
        placeholderTextColor={colors.inkFaint}
        style={styles.input}
      />
      <Text style={type.tiny}>This is what people see when they open your link.</Text>
      <Text style={type.tiny}>HOW MANY ARE YOU EXPECTING?</Text>
      <Row>
        <NumberBox value={expected} onChange={setExpected} placeholder="24" />
        <Button label="Save" kind="secondary" onPress={() => onChange({ name: name.trim(), expectedCount: numberOrNull(expected) })} />
      </Row>
      <Text style={type.tiny}>A target, not a limit — more can join and fewer is fine. It is also the number a cost divided by numbers uses until people actually say yes.</Text>
    </View>
  );
}

/** Step 3: the number below which none of it happens. */
function Minimum({ group: g, joinedHeads, onChange }: { group: TripGroup; joinedHeads: number; onChange: (body: any) => void }) {
  const [minimum, setMinimum] = useState(g.group.minimumCount == null ? '' : String(g.group.minimumCount));
  const [wantedBy, setWantedBy] = useState(g.group.wantedBy ?? '');
  useEffect(() => { setMinimum(g.group.minimumCount == null ? '' : String(g.group.minimumCount)); }, [g.group.minimumCount]);
  return (
    <View style={{ gap: spacing.sm }}>
      <Row style={{ alignItems: 'flex-start', gap: spacing.lg }}>
        <View style={{ gap: 4 }}>
          <Text style={type.tiny}>MINIMUM</Text>
          <NumberBox value={minimum} onChange={setMinimum} placeholder="—" />
        </View>
        <View style={{ gap: 4, flex: 1 }}>
          <Text style={type.tiny}>JUDGED ON</Text>
          <TextInput
            value={wantedBy}
            onChangeText={setWantedBy}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.inkFaint}
            style={[styles.input, { width: 160 }]}
          />
        </View>
        <Button label="Save" kind="secondary" style={{ marginTop: 18 }} onPress={() => onChange({ minimumCount: numberOrNull(minimum), wantedBy: wantedBy || null })} />
      </Row>
      <Text style={type.small}>
        {g.group.minimumCount
          ? `If ${g.group.minimumCount} have not joined by ${day(g.group.wantedBy)}, the trip is cancelled and everybody is told. ${joinedHeads} so far.`
          : 'Nothing is cancelled: the trip goes ahead with whoever comes.'}
      </Text>
      <Text style={type.tiny}>A coach or anything else you are paying for can have a minimum of its own, at the next step. That one only calls off the coach.</Text>
    </View>
  );
}

/** The front door: what a group is, before there is one. */
/**
 * The Group tab before there is a group: a page about what the feature is,
 * with nothing to fill in (owner, 4 Sep 2026: "a proper page, big, big, big
 * letters, with some design features to make it nice… like an advert for the
 * group section"). Big display type on the one mint field, six benefits in the
 * organiser's language, and one button. No names, no numbers, no form — every
 * question comes afterwards, in the wizard.
 */
function StartGroup({ d, onCreated }: { d: TripDetail; onCreated: (g: TripGroup) => void }) {
  const { width } = useViewport();
  const wide = width >= 720;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      onCreated(await api.createTripGroup(d.trip.id, {
        name: d.trip.title ?? d.trip.place?.label ?? undefined,
        organiserMemberId: getViewer(d.attendees),
      }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.hero}>
        {/* The splash: a crowd, drawn as the people it is about. */}
        <View style={styles.crowd}>
          {['P', 'T', 'D', 'A', 'N'].map((initial, i) => (
            <View key={initial} style={[styles.crowdFace, i > 0 && { marginLeft: -10 }]}>
              <Text style={styles.crowdInitial}>{initial}</Text>
            </View>
          ))}
          <View style={[styles.crowdFace, styles.crowdMore, { marginLeft: -10 }]}><Text style={[styles.crowdInitial, { color: colors.primaryFg }]}>+19</Text></View>
        </View>
        <Text style={styles.eyebrow}>GROUP TRIPS</Text>
        <Text style={[styles.hugeText, wide && { fontSize: 46, lineHeight: 48 }]}>Twenty-four people.{'\n'}One weekend.{'\n'}No spreadsheet.</Text>
        <Text style={styles.heroSub}>
          The rooms, the coach, the money and the chasing — held in one place, so you stop being the group's admin.
        </Text>
        <Wrap>
          <View style={styles.heroChip}><Text style={styles.heroChipText}>Three minutes to set up</Text></View>
          <View style={styles.heroChip}><Text style={styles.heroChipText}>No accounts for anybody</Text></View>
          <View style={styles.heroChip}><Text style={styles.heroChipText}>One link</Text></View>
        </Wrap>
      </View>

      <View style={wide ? styles.sellGrid : { gap: spacing.md }}>
        {SELL.map((f) => (
          <View key={f.title} style={[styles.sell, wide && styles.sellHalf]}>
            <View style={styles.sellIcon}><Icon name={f.icon} size={20} /></View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.sellTitle}>{f.title}</Text>
              <Text style={type.small}>{f.line}</Text>
            </View>
          </View>
        ))}
      </View>

      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <Button label={busy ? 'Setting it up…' : 'Start a group trip'} icon="forward" onPress={start} />
      <Text style={[type.tiny, { textAlign: 'center' }]}>
        Six questions, every one of them skippable, and every answer changeable afterwards.
      </Text>
    </View>
  );
}

/** What a group actually gives the person carrying it. */
const SELL: { icon: IconName; title: string; line: string }[] = [
  { icon: 'shortlist', title: 'One link and they are in', line: 'Hold up a code or paste a link. No account, no password, nothing to download — they see the trip and say they are coming.' },
  { icon: 'list', title: 'Everyone gets their own list', line: 'The room to book, the tour, the money owed. They see theirs and nobody else\u2019s; you see all of it on one screen.' },
  { icon: 'hours', title: 'The chasing sends itself', line: 'Roam writes to whoever still has something outstanding, on a schedule, in your name. You never ask the same person twice.' },
  { icon: 'money', title: 'A cost that falls as people join', line: 'A £360 coach is £30 each at twelve and £15 at twenty-four — and everybody can watch it get cheaper as more say yes.' },
  { icon: 'booked', title: 'Nobody pays into thin air', line: 'Nothing is owed until the day it settles. Then the bill goes out with its own arithmetic on it, and a date.' },
  { icon: 'household', title: 'A minimum that means something', line: 'Not enough people by the closing day? It is called off, everybody is told that morning, and nothing was ever taken.' },
];

/** Block 1's one addition: something to do that is not already on the trip. */
function AddWanted({ onAdd }: { onAdd: (body: GroupItemInput) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [required, setRequired] = useState(true);
  if (!open) return <Button label="Something that isn't on the trip" icon="add" kind="ghost" onPress={() => setOpen(true)} />;
  return (
    <View style={{ gap: spacing.sm }}>
      <TextInput value={label} onChangeText={setLabel} placeholder="What they need to book or bring" placeholderTextColor={colors.inkFaint} style={styles.input} autoFocus />
      <Wrap>
        <Chip label="Everyone" icon="check" selected={required} onPress={() => setRequired(true)} />
        <Chip label="Just asking" icon="info" selected={!required} onPress={() => setRequired(false)} />
      </Wrap>
      <Row>
        <Button label="Add it" onPress={() => { if (!label.trim()) return; onAdd({ kind: 'activity', label: label.trim(), required }); setLabel(''); setOpen(false); }} />
        <Button label="Not now" kind="ghost" onPress={() => setOpen(false)} />
      </Row>
    </View>
  );
}

/**
 * Block 2. The code comes first, because the fastest way to get twenty-four
 * people into a group is to hold up a phone in a clubhouse. Then the link, then
 * a WhatsApp group — which needs no integration at all, it is a wa.me link —
 * then the names the organiser already knows.
 */
function Invite({ group: g, settingUp, onChange, onAdd }: {
  group: TripGroup; settingUp: boolean; onChange: (body: any) => void; onAdd: (body: any) => void;
}) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [copied, setCopied] = useState(false);

  const link = useMemo(() => {
    const base = Platform.OS === 'web' && typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : 'https://roam.app/';
    return `${base}?join=${g.group.inviteToken}`;
  }, [g.group.inviteToken]);
  const message = `${g.group.name ?? 'A trip'} — say you're coming and see what's needed: ${link}`;

  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ alignItems: 'flex-start' }}>
        <QrCode value={link} size={132} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={type.h3}>Point a phone at this</Text>
          <Text style={type.tiny}>It opens their list — what you want from them, and nothing about anybody else. No account, no password.</Text>
          <Text style={type.tiny} selectable numberOfLines={2}>{link}</Text>
        </View>
      </Row>
      <Wrap>
        <Chip
          label={copied ? 'Copied' : 'Copy the link'}
          icon={copied ? 'check' : 'external'}
          onPress={async () => {
            if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
              await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000);
            }
          }}
        />
        <Chip
          label="Send to a WhatsApp group"
          icon="message"
          onPress={() => { if (Platform.OS === 'web' && typeof window !== 'undefined') window.open(`https://wa.me/?text=${encodeURIComponent(message)}`); }}
        />
        <Chip label={g.group.closed ? 'Closed to new people' : 'Open'} icon={g.group.closed ? 'locked' : 'check'} selected={!g.group.closed} onPress={() => onChange({ closed: !g.group.closed })} />
        <Chip label="New link" icon="refresh" onPress={() => onChange({ newLink: true })} />
      </Wrap>

      <View style={{ gap: spacing.sm }}>
        <Text style={type.tiny}>ADD THE ONES YOU KNOW</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Their name" placeholderTextColor={colors.inkFaint} style={styles.input} />
        <TextInput value={contact} onChangeText={setContact} placeholder="Mobile or email, so Roam can remind them" placeholderTextColor={colors.inkFaint} style={styles.input} autoCapitalize="none" />
        <Button label="Add them" kind="secondary" onPress={() => { if (!name.trim()) return; onAdd({ name: name.trim(), contact: contact.trim() || undefined }); setName(''); setContact(''); }} />
        <Text style={type.tiny}>
          {settingUp ? 'Nobody has this yet. ' : ''}Anyone holding the link can join, so what they type is all we know about them. A name added first means their join lands on that row.
        </Text>
      </View>
    </View>
  );
}

/**
 * A cost, with its life on it: open while people are joining and nobody pays,
 * closed on the day the headcount fixes the price and the bill goes out, or
 * cancelled because it never reached its minimum.
 */
function CostCard({ item, group: g, busy, onEdit, onClose, onRemove }: {
  item: GroupItem; group: TripGroup; busy: boolean;
  onEdit: (body: Partial<GroupItemInput>) => void;
  onClose: (body: { action: 'close' | 'extend' | 'cancel' | 'reopen'; closesOn?: string; anyway?: boolean }) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const m = item.money;
  const short = Boolean(m?.minimum && m.shares < m.minimum);
  const closesIn = daysUntil(m?.closesOn);

  return (
    <Card style={item.state === 'cancelled' ? { borderStyle: 'dashed' } : undefined}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button">
        <Row style={{ alignItems: 'flex-start' }}>
          <View style={{ paddingTop: 2 }}><Icon name={item.kind === 'fee' ? 'money' : ICON[item.kind]} size={16} /></View>
          <View style={{ flex: 1, gap: 2 }}>
            <Row>
              <Text style={[type.h3, { flex: 1 }]}>{item.label}</Text>
              {item.state === 'closed' ? <Chip label="Settled" icon="check" selected /> : null}
              {item.state === 'cancelled' ? <Chip label="Off" icon="close" /> : null}
              {item.applies === 'extra' && item.state === 'open' ? <Chip label="An extra" /> : null}
            </Row>
            <Text style={type.small}>{costLine(item)}</Text>
            {item.detail ? <Text style={type.tiny}>{item.detail}</Text> : null}
          </View>
          <Icon name={open ? 'collapse' : 'expand'} size={16} />
        </Row>
      </Pressable>

      {item.pricing === 'variable' && item.state === 'open' && m ? (
        <View style={{ gap: 4 }}>
          <Meter used={m.shares} limit={Math.max(1, m.minimum ?? m.expected ?? m.shares)} />
          <Text style={type.tiny}>
            {m.shares} on it now — {money(m.perSharePence)} each at that number.
            {m.minimum && short ? ` ${m.minimum - m.shares} more and it runs.` : ''}
            {m.likelyPence ? ` Probably ${money(m.likelyPence)}.` : ''}
          </Text>
          <Text style={type.tiny}>Nobody pays anything until it closes on {day(m.closesOn)}{closesIn != null && closesIn >= 0 ? ` — ${closesIn} day${closesIn === 1 ? '' : 's'}` : ''}.</Text>
        </View>
      ) : null}

      {open ? (
        <View style={{ gap: spacing.sm }}>
          {item.state === 'open' && item.pricing === 'variable' ? (
            <>
              {short ? (
                <View style={styles.warnBox}>
                  <Icon name="allergen" size={15} color={colors.overrun} />
                  <Text style={[type.small, { flex: 1 }]}>
                    {m?.shares} of the {m?.minimum} it needs. Closing it now would be {money(m?.perSharePence)} each, and you told them no more than {money(m?.ceilingPence)}.
                  </Text>
                </View>
              ) : null}
              <Wrap>
                <Chip label="Close it and send the bill" icon="check" selected onPress={() => onClose({ action: 'close' })} />
                <Chip label="Give it a week" icon="hours" onPress={() => onClose({ action: 'extend', closesOn: plusWeek(m?.closesOn) })} />
                <Chip label="Call it off" icon="close" onPress={() => onClose({ action: 'cancel' })} />
              </Wrap>
              <Text style={type.tiny}>Roam does this by itself on {day(m?.closesOn)}. This is for the week everything changes.</Text>
            </>
          ) : null}
          {item.state === 'closed' ? (
            <>
              <Text style={type.small}>
                {money(item.settledPence)} each × {item.settledHeads} = {money((item.settledPence ?? 0) * (item.settledHeads ?? 0))}, due {day(item.dueOn)}.
                Everyone on it has been told. It is not refundable now.
              </Text>
              <Wrap><Chip label="Open it again" icon="refresh" onPress={() => onClose({ action: 'reopen' })} /></Wrap>
            </>
          ) : null}
          {item.state === 'cancelled' ? <Wrap><Chip label="Put it back" icon="refresh" onPress={() => onClose({ action: 'reopen' })} /></Wrap> : null}
          <Wrap>
            <Chip label={item.perHead ? 'A share each head' : 'A share each party'} icon="household" onPress={() => onEdit({ perHead: !item.perHead })} />
            <Chip label={item.required ? 'Everyone pays it' : 'An extra'} icon={item.required ? 'check' : 'info'} onPress={() => onEdit({ required: !item.required })} />
            {!busy && item.money?.paidPence === 0 ? <Chip label="Remove" icon="close" onPress={onRemove} /> : null}
          </Wrap>
        </View>
      ) : null}
    </Card>
  );
}

const plusWeek = (iso?: string | null) => {
  const d = iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`) : new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
};

/**
 * Adding a cost, in the three steps the mock-up settled on: what it is, how the
 * price works, and when it closes. A varying price is three numbers — what you
 * have to get back, how many you expect on it, and the fewest it works with —
 * and the share at each is shown as they are typed.
 */
function AddCost({ group: g, onAdd }: { group: TripGroup; onAdd: (body: GroupItemInput) => void }) {
  const [step, setStep] = useState(0);
  const [label, setLabel] = useState('');
  const [detail, setDetail] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [perHead, setPerHead] = useState(true);
  const [pricing, setPricing] = useState<'fixed' | 'variable'>('variable');
  const [amount, setAmount] = useState('');
  const [total, setTotal] = useState('');
  const [expected, setExpected] = useState('');
  const [minimum, setMinimum] = useState('');
  const [closesOn, setClosesOn] = useState(g.group.wantedBy ?? '');
  const [lateJoiners, setLateJoiners] = useState<'capacity' | 'no' | 'ask'>('capacity');
  const [capacity, setCapacity] = useState('');
  const [refund, setRefund] = useState<'until' | 'always' | 'never'>('until');

  const totalP = pence(total);
  const exp = numberOrNull(expected) ?? (everyone ? g.group.expectedCount : null);
  const min = numberOrNull(minimum) ?? (everyone ? g.group.minimumCount : null);
  const per = (n: number | null) => (totalP && n ? Math.ceil(totalP / n) : null);

  if (step === 0) {
    return <Button label="Something you are paying for" icon="add" kind="ghost" onPress={() => setStep(1)} />;
  }

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.h3}>{step === 1 ? 'What is it?' : step === 2 ? 'What does it cost?' : 'When does it close?'}</Text>
        <Text style={type.tiny}>{step} of 3</Text>
      </Row>

      {step === 1 ? (
        <View style={{ gap: spacing.sm }}>
          <TextInput value={label} onChangeText={setLabel} placeholder="The coach" placeholderTextColor={colors.inkFaint} style={styles.input} autoFocus />
          <TextInput value={detail} onChangeText={setDetail} placeholder="What it covers, in your words — they read this" placeholderTextColor={colors.inkFaint} style={styles.input} />
          <Text style={type.tiny}>WHO PAYS A SHARE?</Text>
          <Wrap>
            <Chip label="Every head" icon="household" selected={perHead} onPress={() => setPerHead(true)} />
            <Chip label="Every party" icon="person" selected={!perHead} onPress={() => setPerHead(false)} />
          </Wrap>
          <Text style={type.tiny}>EVERYONE, OR AN EXTRA?</Text>
          <Wrap>
            <Chip label="Everyone on the trip" selected={everyone} onPress={() => setEveryone(true)} />
            <Chip label="An extra — only those who want it" selected={!everyone} onPress={() => setEveryone(false)} />
          </Wrap>
          <Text style={type.tiny}>An extra is a yes-or-no: only the yeses are counted, divided by and billed. A coach, a band, a boat, a private room.</Text>
          <Row><Button label="Next" icon="forward" onPress={() => label.trim() && setStep(2)} /><Button label="Not now" kind="ghost" onPress={() => setStep(0)} /></Row>
        </View>
      ) : null}

      {step === 2 ? (
        <View style={{ gap: spacing.sm }}>
          <Segmented
            value={pricing}
            options={[{ value: 'fixed' as const, label: 'Same for everyone' }, { value: 'variable' as const, label: 'Depends on numbers' }]}
            onChange={setPricing}
          />
          {pricing === 'fixed' ? (
            <>
              <Text style={type.tiny}>AMOUNT, EACH</Text>
              <NumberBox value={amount} onChange={setAmount} placeholder="32" prefix="£" width={110} />
              <Text style={type.tiny}>A price each that does not move: a ticket, an entry fee, a kitty.</Text>
            </>
          ) : (
            <>
              <Text style={type.tiny}>WHAT YOU NEED TO GET BACK</Text>
              <NumberBox value={total} onChange={setTotal} placeholder="360" prefix="£" width={120} />
              <Row style={{ alignItems: 'flex-start', gap: spacing.lg }}>
                <View style={{ gap: 4 }}>
                  <Text style={type.tiny}>{everyone ? 'EXPECTING (THE TRIP’S)' : 'EXPECTING ON IT'}</Text>
                  <NumberBox value={everyone ? String(g.group.expectedCount ?? '') : expected} onChange={setExpected} placeholder="24" />
                  <Text style={type.h3}>{per(exp) ? `${money(per(exp))} each` : ' '}</Text>
                  <Text style={type.tiny}>probably</Text>
                </View>
                <View style={{ gap: 4 }}>
                  <Text style={type.tiny}>MINIMUM</Text>
                  <NumberBox value={everyone ? String(g.group.minimumCount ?? '') : minimum} onChange={setMinimum} placeholder="12" />
                  <Text style={type.h3}>{per(min) ? `${money(per(min))} each` : ' '}</Text>
                  <Text style={type.tiny}>at worst</Text>
                </View>
              </Row>
              <Text style={type.tiny}>
                {everyone
                  ? 'It uses the trip’s own numbers, set in block 2.'
                  : min
                    ? `If ${min} have not said yes by the closing day, it does not happen and the trip carries on.`
                    : 'Without a minimum it runs whatever the numbers, however dear that gets.'}
              </Text>
            </>
          )}
          <Row><Button label="Next" icon="forward" onPress={() => setStep(3)} /><Button label="Back" kind="ghost" onPress={() => setStep(1)} /></Row>
        </View>
      ) : null}

      {step === 3 ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.tiny}>LAST DAY TO JOIN IT</Text>
          <TextInput value={closesOn} onChangeText={setClosesOn} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { width: 170 }]} />
          <Text style={type.tiny}>On that day the price stops moving, everybody on it gets the bill, and you book it.</Text>
          <Text style={type.tiny}>AFTER IT CLOSES</Text>
          <Wrap>
            <Chip label="Up to capacity" selected={lateJoiners === 'capacity'} onPress={() => setLateJoiners('capacity')} />
            <Chip label="No, that's it" selected={lateJoiners === 'no'} onPress={() => setLateJoiners('no')} />
            <Chip label="Ask me" selected={lateJoiners === 'ask'} onPress={() => setLateJoiners('ask')} />
          </Wrap>
          {lateJoiners === 'capacity' ? <Row><Text style={type.tiny}>Seats</Text><NumberBox value={capacity} onChange={setCapacity} placeholder="24" width={80} /></Row> : null}
          <Text style={type.tiny}>MONEY BACK?</Text>
          <Wrap>
            <Chip label="Until it closes" selected={refund === 'until'} onPress={() => setRefund('until')} />
            <Chip label="Always" selected={refund === 'always'} onPress={() => setRefund('always')} />
            <Chip label="Never" selected={refund === 'never'} onPress={() => setRefund('never')} />
          </Wrap>
          <Text style={type.tiny}>Until it closes is the honest one: that is the day you pay for it, and before it nobody has paid you anything.</Text>
          <Row>
            <Button
              label="Add it"
              icon="check"
              onPress={() => {
                onAdd({
                  kind: 'fee', label: label.trim(), detail: detail.trim() || undefined, required: everyone, perHead,
                  pricing, amountPence: pricing === 'fixed' ? pence(amount) : null, totalPence: pricing === 'variable' ? totalP : null,
                  expectedCount: everyone ? null : numberOrNull(expected), minimumCount: everyone ? null : numberOrNull(minimum),
                  capacity: numberOrNull(capacity), closesOn: closesOn || null, lateJoiners,
                  refundRule: refund, refundUntil: refund === 'until' ? (closesOn || null) : null,
                });
                setStep(0); setLabel(''); setDetail(''); setTotal(''); setAmount(''); setExpected(''); setMinimum(''); setCapacity('');
              }}
            />
            <Button label="Back" kind="ghost" onPress={() => setStep(2)} />
          </Row>
        </View>
      ) : null}
    </Card>
  );
}
function Chasing({ group: g, busy, settingUp, onChange, onSendNow }: { group: TripGroup; busy: boolean; settingUp: boolean; onChange: (body: any) => void; onSendNow: () => void }) {
  const [open, setOpen] = useState(false);
  const [wantedBy, setWantedBy] = useState(g.group.wantedBy ?? '');
  const r = g.reminders;
  const nextIn = r.next ? daysUntil(r.next.date) : null;
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row><Icon name="hours" size={16} /><Text style={type.h2}>{settingUp ? 'Roam will do the chasing' : 'Roam is chasing'}</Text></Row>
        <Chip label={r.on ? 'On' : 'Off'} icon={r.on ? 'check' : 'close'} selected={r.on} onPress={() => onChange({ remindersOn: !r.on })} />
      </Row>
      {r.on ? (
        <Text style={type.small}>
          {r.next
            ? `Next reminder ${day(r.next.date)}${nextIn != null && nextIn >= 0 ? nextIn === 0 ? ', today' : ` — in ${nextIn} day${nextIn === 1 ? '' : 's'}` : ''}` +
              (r.next.recipients
                ? `, to ${r.next.recipients} ${r.next.recipients === 1 ? 'person' : 'people'} with something outstanding.`
                : settingUp ? ', to anyone who has joined by then and still has something to do.' : ' — nobody has anything outstanding, so it may go to no one.')
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
  blockNumber: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: colors.line,
    alignItems: 'center', justifyContent: 'center',
  },
  blockNumberText: { fontFamily: fonts.body, fontSize: 12, fontWeight: '800', color: colors.inkMuted },
  numberBox: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm,
    minHeight: TARGET - 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  numberInput: { flex: 1, textAlign: 'center', fontFamily: fonts.body, fontSize: 17, fontWeight: '700', color: colors.ink, minWidth: 40 },
  wantedRow: { gap: 6, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  hero: {
    // The one mint field in light; in dark the header ground is the page ground,
    // so a rule gives the panel its edge back.
    backgroundColor: colors.headerBg, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.line,
  },
  crowd: { flexDirection: 'row', alignItems: 'center' },
  crowdFace: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.headerBg,
    alignItems: 'center', justifyContent: 'center',
  },
  crowdMore: { backgroundColor: colors.primary },
  crowdInitial: { fontFamily: fonts.body, fontSize: 12, fontWeight: '800', color: colors.ink },
  eyebrow: { fontFamily: fonts.body, fontSize: 11, fontWeight: '800', letterSpacing: 1.4, color: colors.headerSub },
  hugeText: { fontFamily: fonts.heading, fontSize: 34, lineHeight: 36, fontWeight: '800', letterSpacing: -1, color: colors.ink },
  heroSub: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.headerSub, maxWidth: 520 },
  heroChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.headerSub,
  },
  heroChipText: { fontFamily: fonts.body, fontSize: 12, fontWeight: '700', color: colors.headerSub },
  sellGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  sell: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  sellHalf: { width: '48%', flexGrow: 1 },
  sellIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  sellTitle: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '800', letterSpacing: -0.3, color: colors.ink },
  progress: { flexDirection: 'row', gap: 3 },
  progressBar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.line },
  colLeft: { flex: 1, minWidth: 0 },
  colRight: { width: 380 },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink, fontFamily: fonts.body,
  },
  person: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm, marginTop: spacing.sm },
  warnBox: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.overrun, backgroundColor: colors.overrunSoft },
});

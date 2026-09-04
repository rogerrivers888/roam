import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, GroupItem, GroupItemInput, GroupItemKind, GroupParticipant, TripDetail, TripGroup } from '../api';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Meter, Row, Segmented, StatusLine, Wrap } from './ui';
import { Icon, IconName } from './Icon';
import { QrCode } from './QrCode';
import { DateRangePicker } from './DateRangePicker';
import Svg, { Circle, ClipPath, Defs, G, Image as SvgImage, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
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
 * The five things setting a group up asks, in the order they build on each
 * other. Each carries a line saying what it is for, because a title and a count
 * assume the organiser already knows what a group is — and they do not (owner,
 * 4 Sep 2026). The same five are the wizard on the first run and the settings
 * afterwards.
 */
type StepKey = 'what' | 'wanted' | 'costs' | 'chasing' | 'invite';
const STEPS: { key: StepKey; title: string; blurb: string }[] = [
  { key: 'what', title: 'What this is', blurb: 'Name it, and say how many it needs, expects and can take.' },
  { key: 'wanted', title: 'What must everyone do?', blurb: 'Mark which of these are mandatory. The rest are optional — Roam only asks who is coming to them.' },
  { key: 'costs', title: 'Anything you are paying for?', blurb: 'A coach, tickets, a kitty. Everyone pays a share, or only the people who opt in.' },
  { key: 'chasing', title: 'Notifications and reminders', blurb: 'Roam writes to whoever still has something outstanding, so you never ask twice.' },
  { key: 'invite', title: 'Ask them in', blurb: 'A code to hold up, a link, a WhatsApp group, or the names you already know.' },
];

const WIDE = 1000;
const money = (p?: number | null) => (p == null ? '—' : `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`);
const longDay = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const day = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const daysUntil = (iso?: string | null) => (iso ? Math.round((new Date(`${iso.slice(0, 10)}T12:00:00`).getTime() - Date.now()) / 86400000) : null);
const ICON: Record<GroupItemKind, IconName> = { stay: 'hotel', activity: 'ticket', fee: 'money' };
const pence = (text: string) => (text.trim() === '' ? null : Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100));
const numberOrNull = (text: string) => (text.trim() === '' ? null : Math.max(0, Math.round(Number(text.replace(/[^0-9]/g, '')))));

/** A number is typed, never nudged (owner, 4 Sep 2026). */
function NumberBox({ value, onChange, onCommit, onFocus, placeholder, width = 88, prefix }: {
  value: string; onChange: (v: string) => void; onCommit?: () => void; onFocus?: () => void;
  placeholder?: string; width?: number; prefix?: string;
}) {
  // The box is the control, so the box takes the focus ring — a browser drawing
  // its own outline round the input inside it is a box in a box (owner, 4 Sep 2026).
  const [on, setOn] = useState(false);
  return (
    <View style={[styles.numberBox, { width }, on && styles.numberBoxOn]}>
      {prefix ? <Text style={[type.small, { color: colors.inkMuted }]}>{prefix}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={() => { setOn(true); onFocus?.(); }}
        onBlur={() => { setOn(false); onCommit?.(); }}
        onSubmitEditing={onCommit}
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
          {i.outstandingNames.length ? <Text style={type.small}>Waiting on: {i.outstandingNames.join(', ')}</Text> : null}
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
            <Row>
              <Icon name={ICON[i.kind]} size={15} />
              <Text style={[type.h3, { flex: 1 }]}>{i.label}</Text>
            </Row>
            <Wrap>
              <Chip label="Everyone" icon="check" selected={i.required} onPress={() => setItem(i.id, { required: true })} />
              <Chip label="Just asking" icon="info" selected={!i.required} onPress={() => setItem(i.id, { required: false })} />
              <Chip label="Not in it" icon="close" onPress={() => run(() => api.removeGroupItem(group.id, i.id))} />
            </Wrap>
          </View>
        ))}
        {wanted.length === 0 ? <Text style={type.small}>Nothing on this trip yet.</Text> : null}
        <AddWanted onAdd={(body) => run(() => api.addGroupItem(group.id, body))} />
      </>
    ),
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
    chasing: <Chasing group={g} settingUp={settingUp} onChange={(body) => run(() => api.updateGroup(group.id, body))} />,
    invite: <Invite group={g} settingUp={settingUp} onChange={(body) => run(() => api.updateGroup(group.id, body))} onAdd={(body) => run(() => api.addGroupParticipant(group.id, body))} />,
  };

  const summaries: Record<StepKey, string> = {
    what: `${group.name ?? 'Unnamed'}${group.expectedCount ? ` · ${group.expectedCount} expected` : ''}${group.minimumCount ? ` · needs ${group.minimumCount}` : ''}`,
    wanted: `${wanted.filter((i) => i.required).length} wanted from everyone, ${wanted.filter((i) => !i.required).length} asked about`,
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
          <Text style={type.label}>DROPPED OUT</Text>
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
 * every step can be skipped and changed later from the same five blocks.
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
        <Text style={type.label}>Step {at + 1} of {STEPS.length}</Text>
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

/** The sentence under the three numbers, about whichever one is being typed in. */
function sizeLine(at: 'minimum' | 'expecting' | 'maximum' | null, g: TripGroup['group'], minimum: string, maximum: string) {
  const min = numberOrNull(minimum) ?? g.minimumCount;
  const max = numberOrNull(maximum) ?? g.maximumCount;
  if (at === 'minimum') return min ? `Under ${min} and the trip is called off — everybody is told and nothing is taken.` : 'The fewest people it works with. Below it the trip is called off.';
  if (at === 'maximum') return max ? `Nobody can join once ${max} are in.` : 'The most people who can join. Leave it empty for no limit.';
  if (at === 'expecting') return 'Roughly how many will come. A shared cost divides by this until people actually join.';
  return min ? `Under ${min} and the trip is called off.${max ? ` Nobody can join past ${max}.` : ''}` : 'Leave the minimum empty and it goes ahead with whoever comes.';
}

/** Step 1: what it is called, and the three numbers that describe its size. */
function WhatThisIs({ group: g, onChange }: { group: TripGroup; onChange: (body: any) => void }) {
  const [at, setAt] = useState<'minimum' | 'expecting' | 'maximum' | null>(null);
  const [name, setName] = useState(g.group.name ?? '');
  const [minimum, setMinimum] = useState(g.group.minimumCount == null ? '' : String(g.group.minimumCount));
  const [expected, setExpected] = useState(g.group.expectedCount == null ? '' : String(g.group.expectedCount));
  const [maximum, setMaximum] = useState(g.group.maximumCount == null ? '' : String(g.group.maximumCount));
  useEffect(() => { setName(g.group.name ?? ''); }, [g.group.name]);
  const save = () => onChange({
    name: name.trim(),
    minimumCount: numberOrNull(minimum),
    expectedCount: numberOrNull(expected),
    maximumCount: numberOrNull(maximum),
  });
  return (
    <View style={{ gap: spacing.md }}>
      <TextInput
        value={name}
        onChangeText={setName}
        onBlur={save}
        placeholder="What to call it"
        placeholderTextColor={colors.inkFaint}
        style={styles.input}
      />
      <Row style={{ gap: spacing.lg }}>
        <View>
          <Text style={type.label}>Minimum</Text>
          <NumberBox value={minimum} onChange={setMinimum} onCommit={save} onFocus={() => setAt('minimum')} />
        </View>
        <View>
          <Text style={type.label}>Expecting</Text>
          <NumberBox value={expected} onChange={setExpected} onCommit={save} onFocus={() => setAt('expecting')} placeholder="24" />
        </View>
        <View>
          <Text style={type.label}>Maximum</Text>
          <NumberBox value={maximum} onChange={setMaximum} onCommit={save} onFocus={() => setAt('maximum')} />
        </View>
      </Row>
      <Text style={type.small}>{sizeLine(at, g.group, minimum, maximum)}</Text>
    </View>
  );
}

/** The front door: what a group is, before there is one. */
/**
 * The Group tab before there is a group: a page somebody who tapped Group by
 * accident can scan in five seconds (owner, 4 Sep 2026). A headline, one
 * sentence, a picture of what it does, three bullets, one button — and nothing
 * to fill in, because every question is asked in the wizard afterwards.
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
      <View style={[styles.hero, wide && { flexDirection: 'row', alignItems: 'center', gap: spacing.xl }]}>
        <View style={{ flex: 1, gap: spacing.sm }}>
          <Text style={[styles.hugeText, wide && { fontSize: 38, lineHeight: 40 }]}>Create a group trip.{'\n'}Pay separately.</Text>
          <Text style={styles.heroSub}>
            Build the trip, invite a group, and set the reminders and the money once.
          </Text>
        </View>
        <GroupScene wide={wide} />
      </View>

      <View style={wide ? styles.sellGrid : { gap: spacing.sm }}>
        {SELL.map((f, i) => (
          <View key={f.title} style={[styles.sell, wide && styles.sellThird]}>
            <View style={styles.sellIcon}><Text style={styles.sellNumber}>{i + 1}</Text></View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.sellTitle}>{f.title}</Text>
              <Text style={type.small}>{f.line}</Text>
            </View>
          </View>
        ))}
      </View>

      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <Button label={busy ? 'Setting it up…' : 'Create a group trip'} icon="forward" onPress={start} />
      <Text style={[type.small, { textAlign: 'center' }]}>Three minutes. Five questions, all skippable.</Text>
    </View>
  );
}

/**
 * The picture, because the sentence cannot be made short enough: the trip on
 * the left, and three of the people on it each holding their own bill.
 *
 * The faces are real people (owner, 4 Sep 2026), three Unsplash portraits
 * served by us rather than hot-linked, so the page costs no third-party request
 * and works with no signal. Provenance and licence: public/people/README.md.
 * Drop other files in and rename them here and nothing else changes.
 */
const FACES = ['/people/1.jpg', '/people/2.jpg', '/people/3.jpg'];

function GroupScene({ wide }: { wide: boolean }) {
  const rows = [
    { y: 42, amount: '£15' },
    { y: 90, amount: '£15' },
    { y: 138, amount: '£15' },
  ];
  return (
    <View style={[styles.scene, wide && { width: 300, height: 190 }]}>
      <Svg width="100%" height="100%" viewBox="0 0 300 186">
        <Defs>
          {rows.map((r, i) => <ClipPath key={r.y} id={`face${i}`}><Circle cx={168} cy={r.y} r={16} /></ClipPath>)}
        </Defs>

        {/* the trip itself */}
        <Rect x={14} y={28} width={92} height={124} rx={10} fill={colors.surface} stroke={colors.ink} strokeWidth={2} />
        <Rect x={28} y={44} width={64} height={9} rx={4.5} fill={colors.ink} opacity={0.85} />
        <Rect x={28} y={60} width={44} height={6} rx={3} fill={colors.ink} opacity={0.25} />
        <Rect x={28} y={76} width={64} height={20} rx={4} fill={colors.mint} />
        <Rect x={28} y={106} width={64} height={6} rx={3} fill={colors.ink} opacity={0.25} />
        <Rect x={28} y={119} width={38} height={6} rx={3} fill={colors.ink} opacity={0.25} />

        {rows.map((r, i) => (
          <G key={r.y}>
            <Line x1={106} y1={90} x2={150} y2={r.y} stroke={colors.ink} strokeWidth={1.2} strokeOpacity={0.3} strokeDasharray="3 4" />
            <Circle cx={168} cy={r.y} r={16} fill={colors.surfaceMuted} stroke={colors.ink} strokeWidth={2} />
            {FACES[i] ? (
              <SvgImage x={152} y={r.y - 16} width={32} height={32} href={{ uri: FACES[i] }} preserveAspectRatio="xMidYMid slice" clipPath={`url(#face${i})`} />
            ) : (
              <G>
                {/* a person, rather than their initial */}
                <Circle cx={168} cy={r.y - 4} r={5.4} fill={colors.ink} opacity={0.75} />
                <Path d={`M158.5 ${r.y + 12} a9.8 9.8 0 0 1 19 0 z`} fill={colors.ink} opacity={0.75} />
              </G>
            )}
            {/* their own share, paid their own way */}
            <Rect x={194} y={r.y - 13} width={74} height={26} rx={6} fill={colors.ink} />
            <SvgText x={231} y={r.y + 5} fontSize={13} fontWeight="800" fill={colors.bg} textAnchor="middle" fontFamily={fonts.body}>{r.amount}</SvgText>
          </G>
        ))}
        <SvgText x={231} y={178} fontSize={11} fontWeight="700" fill={colors.ink} opacity={0.55} textAnchor="middle" fontFamily={fonts.body}>and 21 more</SvgText>
      </Svg>
    </View>
  );
}

/**
 * Three lines, one sentence each.
 *
 * The middle one is deliberately not "we collect the cash and pay you
 * directly": Roam holds no money yet, so it works out every share and tells you
 * who has paid, and you are paid directly. The day a payment account exists
 * that line becomes the owner's original.
 */
const SELL: { title: string; line: string }[] = [
  { title: 'Mandatory or not, you choose', line: 'Say what everyone must do and what is only being asked about, and let each person pay their own way.' },
  { title: 'Add your own events', line: 'A coach, a band, a boat: Roam works out what each person owes, and you are paid directly.' },
  { title: 'A minimum to go ahead', line: 'Set the fewest people it works with, and below it nothing runs and nothing is taken.' },
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
        <Button label="Cancel" kind="ghost" onPress={() => setOpen(false)} />
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
          <Text style={type.small}>It opens their own list. No account, no password.</Text>
          <Text style={type.small} selectable numberOfLines={2}>{link}</Text>
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
        <Text style={type.label}>ADD THE ONES YOU KNOW</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Their name" placeholderTextColor={colors.inkFaint} style={styles.input} />
        <TextInput value={contact} onChangeText={setContact} placeholder="Mobile or email, so Roam can remind them" placeholderTextColor={colors.inkFaint} style={styles.input} autoCapitalize="none" />
        <Button label="Add them" kind="secondary" onPress={() => { if (!name.trim()) return; onAdd({ name: name.trim(), contact: contact.trim() || undefined }); setName(''); setContact(''); }} />
        <Text style={type.small}>
          Anyone holding the link can join. A name added first means their join lands on that row.
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
            {item.detail ? <Text style={type.small}>{item.detail}</Text> : null}
          </View>
          <Icon name={open ? 'collapse' : 'expand'} size={16} />
        </Row>
      </Pressable>

      {item.pricing === 'variable' && item.state === 'open' && m ? (
        <View style={{ gap: 4 }}>
          <Meter used={m.shares} limit={Math.max(1, m.minimum ?? m.expected ?? m.shares)} />
          <Text style={type.small}>
            {m.shares} on it now — {money(m.perSharePence)} each at that number.
            {m.minimum && short ? ` ${m.minimum - m.shares} more and it runs.` : ''}
            {m.likelyPence ? ` Probably ${money(m.likelyPence)}.` : ''}
          </Text>
          <Text style={type.small}>Nobody pays anything until it closes on {day(m.closesOn)}{closesIn != null && closesIn >= 0 ? ` — ${closesIn} day${closesIn === 1 ? '' : 's'}` : ''}.</Text>
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
              <Text style={type.small}>Roam does this by itself on {day(m?.closesOn)}. This is for the week everything changes.</Text>
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
            <Chip label={item.perHead ? 'Per person' : 'Per household'} icon="household" onPress={() => onEdit({ perHead: !item.perHead })} />
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
 * A date, written the way it is said, with a calendar to change it — not a box
 * of hyphens (owner, 4 Sep 2026).
 */
function DayPick({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: spacing.sm }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button">
        <Row>
          <Icon name="calendar" size={16} />
          <Text style={type.h3}>{value ? longDay(value) : 'Pick a date'}</Text>
          <Icon name={open ? 'collapse' : 'expand'} size={14} />
        </Row>
      </Pressable>
      {open ? (
        <DateRangePicker
          single
          start={value || null}
          end={value || null}
          onApply={(start) => { onChange(start); setOpen(false); }}
        />
      ) : null}
    </View>
  );
}

/**
 * Adding a cost: one form, not a wizard inside a wizard (owner, 4 Sep 2026 —
 * "we've got 2 Next buttons on this screen"). Every control is one row of two
 * choices, and nothing has a sentence under it explaining what it meant.
 */
function AddCost({ group: g, onAdd }: { group: TripGroup; onAdd: (body: GroupItemInput) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [perHead, setPerHead] = useState(true);
  const [pricing, setPricing] = useState<'fixed' | 'variable'>('variable');
  const [amount, setAmount] = useState('');
  const [total, setTotal] = useState('');
  const [expected, setExpected] = useState('');
  const [minimum, setMinimum] = useState('');
  const [closesOn, setClosesOn] = useState(g.group.wantedBy ?? '');

  const totalP = pence(total);
  const exp = numberOrNull(expected) ?? (everyone ? g.group.expectedCount : null);
  const min = numberOrNull(minimum) ?? (everyone ? g.group.minimumCount : null);
  const per = (n: number | null) => (totalP && n ? Math.ceil(totalP / n) : null);

  if (!open) return <Button label="Something you are paying for" icon="add" kind="ghost" onPress={() => setOpen(true)} />;

  return (
    <Card>
      <TextInput
        value={label}
        onChangeText={setLabel}
        placeholder="What is it? A coach, tickets, a kitty"
        placeholderTextColor={colors.inkFaint}
        style={styles.input}
        autoFocus
      />
      <Text style={type.label}>Who pays</Text>
      <Wrap>
        <Chip label="Everyone" selected={everyone} onPress={() => setEveryone(true)} />
        <Chip label="Only those who opt in" selected={!everyone} onPress={() => setEveryone(false)} />
      </Wrap>
      <Text style={type.label}>A share each</Text>
      <Wrap>
        <Chip label="Per person" selected={perHead} onPress={() => setPerHead(true)} />
        <Chip label="Per household" selected={!perHead} onPress={() => setPerHead(false)} />
      </Wrap>
      <Text style={type.label}>Price</Text>
      <Segmented
        value={pricing}
        options={[{ value: 'fixed' as const, label: 'Same for everyone' }, { value: 'variable' as const, label: 'Depends on numbers' }]}
        onChange={setPricing}
      />

      {pricing === 'fixed' ? (
        <Row>
          <NumberBox value={amount} onChange={setAmount} placeholder="32" prefix="£" width={120} />
          <Text style={type.small}>each</Text>
        </Row>
      ) : (
        <View style={{ gap: spacing.md }}>
          <Row>
            <NumberBox value={total} onChange={setTotal} placeholder="360" prefix="£" width={130} />
            <Text style={type.small}>to get back in total</Text>
          </Row>
          <Row style={{ gap: spacing.lg, alignItems: 'flex-start' }}>
            <View>
              <Text style={type.label}>Expecting</Text>
              <NumberBox value={everyone ? String(g.group.expectedCount ?? '') : expected} onChange={setExpected} placeholder="24" />
              <Text style={[type.h2, { marginTop: 6 }]}>{per(exp) ? `${money(per(exp))} each` : ' '}</Text>
            </View>
            <View>
              <Text style={type.label}>Minimum</Text>
              <NumberBox value={everyone ? String(g.group.minimumCount ?? '') : minimum} onChange={setMinimum} placeholder="12" />
              <Text style={[type.h2, { marginTop: 6 }]}>{per(min) ? `${money(per(min))} each` : ' '}</Text>
            </View>
          </Row>
        </View>
      )}

      <Text style={type.label}>Settles on</Text>
      <DayPick value={closesOn} onChange={setClosesOn} />
      <Text style={type.small}>
        {pricing === 'variable'
          ? `Nobody pays until then. ${min ? `Under ${min} and it does not run.` : ''}`
          : 'Owed from the moment they join.'}
      </Text>

      <Row>
        <Button
          label="Add it"
          icon="check"
          onPress={() => {
            if (!label.trim()) return;
            onAdd({
              kind: 'fee', label: label.trim(), required: everyone, perHead, pricing,
              amountPence: pricing === 'fixed' ? pence(amount) : null,
              totalPence: pricing === 'variable' ? totalP : null,
              expectedCount: everyone ? null : numberOrNull(expected),
              minimumCount: everyone ? null : numberOrNull(minimum),
              closesOn: closesOn || null,
              refundRule: 'until', refundUntil: closesOn || null,
            });
            setOpen(false); setLabel(''); setTotal(''); setAmount(''); setExpected(''); setMinimum('');
          }}
        />
        <Button label="Cancel" kind="ghost" onPress={() => setOpen(false)} />
      </Row>
    </Card>
  );
}

/**
 * The chasing card: what Roam is doing on the organiser's behalf, and when.
 */
function Chasing({ group: g, settingUp, onChange }: {
  group: TripGroup; settingUp: boolean; onChange: (body: any) => void;
}) {
  const r = g.reminders;
  const sent = r.schedule.filter((x) => x.done).length;
  const howMany = r.schedule.length || r.cadences.find((c) => c.key === g.group.cadence)?.runs || 0;
  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[type.h3, { flex: 1 }]}>
          {r.on
            ? `${howMany} reminders, spread evenly between the first and the day it is all wanted by.`
            : 'Nobody is being chased. You are doing it yourself.'}
        </Text>
        <Chip label={r.on ? 'On' : 'Off'} icon={r.on ? 'check' : 'close'} selected={r.on} onPress={() => onChange({ remindersOn: !r.on })} />
      </Row>

      {r.on ? (
        <>
          <View>
            <Text style={type.label}>First one on</Text>
            <DayPick value={g.group.firstReminderOn ?? r.schedule[0]?.date ?? ''} onChange={(iso) => onChange({ firstReminderOn: iso })} />
          </View>
          <View>
            <Text style={type.label}>Everything wanted by</Text>
            <DayPick value={g.group.wantedBy ?? ''} onChange={(iso) => onChange({ wantedBy: iso })} />
          </View>
          <View>
            <Text style={type.label}>How often</Text>
            <Segmented
              value={g.group.cadence}
              options={r.cadences.map((c) => ({ value: c.key, label: `${c.label} · ${c.runs}` }))}
              onChange={(c) => onChange({ cadence: c })}
            />
          </View>
          {r.schedule.length ? (
            <View style={{ gap: spacing.sm }}>
              {r.schedule.map((x) => (
                <Row key={x.date} style={{ justifyContent: 'space-between' }}>
                  <Row>
                    <Icon name={x.done ? 'booked' : 'hours'} size={14} color={x.done ? colors.like : colors.inkMuted} />
                    <Text style={type.small}>{longDay(x.date)}, 9am</Text>
                  </Row>
                  {x.done ? <Text style={type.small}>sent</Text> : null}
                </Row>
              ))}
              <Text style={type.small}>
                {settingUp
                  ? 'Each one goes to whoever still has something outstanding, and to nobody who has finished.'
                  : `${sent} of ${r.schedule.length} sent. Each goes to whoever still has something outstanding.`}
              </Text>
            </View>
          ) : (
            <Text style={type.small}>Pick the two dates and Roam spaces the reminders between them.</Text>
          )}
        </>
      ) : null}
    </View>
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
              {p.heads > 1 ? <Chip label={`Household of ${p.heads}`} icon="household" /> : null}
            </Row>
            {p.brings ? <Text style={type.small}>With {p.brings}</Text> : null}
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
                    <Text style={type.small}>{label}</Text>
                  </View>
                </Row>
                {i.kind === 'fee'
                  ? <Chip label={s?.status === 'paid' ? 'Paid' : 'Mark as paid'} selected={s?.status === 'paid'} onPress={() => onMark(i.id, { status: s?.status === 'paid' ? 'clear' : 'paid' })} />
                  : <Chip label={s ? 'Undo' : 'Mark done'} selected={Boolean(s)} onPress={() => onMark(i.id, { status: s ? 'clear' : 'booked' })} />}
              </Row>
            );
          })}
          <Text style={type.label}>Their household</Text>
          <Row>
            <NumberBox value={String(p.heads)} onChange={(v) => onChange({ heads: Math.max(1, Number(v) || 1) })} width={72} />
            <TextInput
              value={p.brings ?? ''}
              onChangeText={(v) => onChange({ brings: v })}
              placeholder="Who else is coming"
              placeholderTextColor={colors.inkFaint}
              style={[styles.input, { flex: 1 }]}
            />
          </Row>
          <Text style={type.label}>A note, just for you</Text>
          <TextInput value={note} onChangeText={setNote} onBlur={() => note !== (p.note ?? '') && onChange({ note })} placeholder="They never see this" placeholderTextColor={colors.inkFaint} style={styles.input} />
          {p.reminders.length ? <Text style={type.small}>Chased {p.reminders.length} time{p.reminders.length === 1 ? '' : 's'} — last {when(p.lastRemindedAt)}</Text> : null}
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
  numberBoxOn: { borderColor: colors.accent, borderWidth: 2 },
  numberInput: { flex: 1, textAlign: 'center', fontFamily: fonts.body, fontSize: 17, fontWeight: '700', color: colors.ink, minWidth: 40, outlineStyle: 'none' as any },
  wantedRow: { gap: 6, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  hero: {
    // The one mint field in light; in dark the header ground is the page ground,
    // so a rule gives the panel its edge back.
    backgroundColor: colors.headerBg, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.line,
  },
  scene: { width: 280, height: 175, alignSelf: 'center' },
  eyebrow: { fontFamily: fonts.body, fontSize: 11, fontWeight: '800', letterSpacing: 1.4, color: colors.headerSub },
  hugeText: { fontFamily: fonts.heading, fontSize: 34, lineHeight: 36, fontWeight: '800', letterSpacing: -1, color: colors.ink },
  heroSub: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.headerSub, maxWidth: 520 },
  sellGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  sell: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  sellHalf: { width: '48%', flexGrow: 1 },
  sellThird: { width: '31%', flexGrow: 1, minWidth: 220 },
  sellNumber: { fontFamily: fonts.heading, fontSize: 17, fontWeight: '800', color: colors.ink },
  sellIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  sellTitle: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '800', letterSpacing: -0.3, color: colors.ink },
  progress: { flexDirection: 'row', gap: 3 },
  progressBar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.line },
  colLeft: { flex: 1, minWidth: 0 },
  colRight: { width: 380 },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink, fontFamily: fonts.body,
    // The focus ring is the leaf, not the browser's blue (style guide).
    outlineColor: colors.accent as any, outlineWidth: 2 as any, outlineOffset: 1 as any,
  },
  person: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm, marginTop: spacing.sm },
  warnBox: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.overrun, backgroundColor: colors.overrunSoft },
});

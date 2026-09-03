import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { api, ApiError, HouseholdResponse, PlanAction, PlanResponse, PlanRow, PlanRowKey } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Stepper, Wrap, minutes, clock } from '../components/ui';
import { TimeBar } from '../components/TimeBar';
import { PricePointControl, ChainsControl } from '../components/PlanControls';
import { BrowsePool } from '../components/BrowsePool';
import { speak as speakRaw, useSpeech } from '../hooks/useSpeech';
import { InspireMe } from '../components/InspireMe';
import { Icon } from '../components/Icon';
import { getSpeakPref } from './SettingsScreen';

const speak = (text: string) => { if (getSpeakPref()) speakRaw(text); };

type Turn = { role: 'user' | 'assistant'; text: string; voice?: boolean };

const firstName = (n: string) => n.split(' ')[0];
type Mode = 'tell' | 'inspire';
// The rows are the screen from the first moment: empty until something is said.
// Home and the family are the standing assumptions, so they are one line above the rows, not two rows.
const EMPTY_ROWS: PlanRow[] = (['to', 'when', 'do', 'eat', 'budget'] as PlanRowKey[]).map((key) => ({
  key, label: key === 'to' ? 'To' : key[0].toUpperCase() + key.slice(1), value: null, detail: null, state: 'empty',
}));
const PRICE_CHIPS = [{ label: 'Any', say: 'Budget: any price' }, { label: 'Affordable', say: 'Budget: affordable' }, { label: 'Mid-range', say: 'Budget: mid-range' }, { label: 'Upmarket', say: 'Budget: upmarket' }];

// The Plan tab unmounts when another tab is shown; the session it was in is
// remembered here so coming back shows the same conversation and options.
let remembered: { sessionId: string; turns: Turn[]; viewing: string | null } | null = null;

export type OpenTripOptions = { section?: 'find' | 'shortlist' | 'day'; findRadiusKm?: number; findPrices?: string[] };
export function PlanScreen({ household, onOpenTrip }: { household: HouseholdResponse | null; onOpenTrip?: (tripId: string, opts?: OpenTripOptions) => void }) {
  const { width } = useViewport();
  const cardWidth = Math.min(width, 760) - spacing.lg * 2;

  const [sessionId, setSessionId] = useState<string | null>(null);
  // Who's coming: everyone until a tick is taken off. Ticking is the same statement as saying the names.
  const [attendingIds, setAttendingIds] = useState<Set<string> | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const [travelOpen, setTravelOpen] = useState(false);
  const [fromText, setFromText] = useState('');
  const [mode, setMode] = useState<Mode>('tell');
  const [inspireQuery, setInspireQuery] = useState('');
  // A tapped row opens in place; its own mic scopes the words to that row alone.
  const [editing, setEditing] = useState<PlanRowKey | null>(null);
  const [editText, setEditText] = useState('');
  const fieldRef = useRef<PlanRowKey | null>(null);
  // Rows fill while the household is still talking (a quicker read of the words so far).
  const [previewRows, setPreviewRows] = useState<PlanRow[] | null>(null);
  const previewCount = useRef(0);
  const lastPreviewed = useRef('');
  // "was: …" for one turn after a row changes, so a wrong correction is caught too.
  const [changed, setChanged] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<false | 'thinking' | 'updating'>(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [differences, setDifferences] = useState(false);
  const [committed, setCommitted] = useState<string | null>(null);
  const pagerRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!remembered) return;
    const r = remembered;
    setSessionId(r.sessionId); setTurns(r.turns); setViewing(r.viewing);
    api.planGet(r.sessionId).then((p) => setPlan(p)).catch(() => { remembered = null; });
  }, []);
  useEffect(() => { remembered = sessionId ? { sessionId, turns, viewing } : null; }, [sessionId, turns, viewing]);

  const hasOptions = !!plan?.trip && (plan?.options?.length ?? 0) > 0;

  // Voice and typing land in the same function — that is the whole point.
  // Whatever comes back replaces the rows and the queue; a row that changed remembers what it was for one turn.
  const take = useCallback((next: PlanResponse, viaVoice: boolean) => {
    setSessionId(next.sessionId);
    setPlan((prev) => {
      const before = new Map((prev?.rows ?? []).map((r) => [r.key, r.value]));
      const diff: Record<string, string> = {};
      for (const r of next.rows ?? []) { const was = before.get(r.key); if (was && r.value && was !== r.value) diff[r.key] = was; }
      setChanged(diff);
      return { ...(prev ?? {} as PlanResponse), ...next, question: next.question ?? null, checks: next.checks ?? [], rows: next.rows ?? prev?.rows ?? null };
    });
    if (next.reply) {
      setTurns((t) => [...t, { role: 'assistant', text: next.reply! }]);
      if (viaVoice) speak(next.reply);
    }
    if (!viewing && next.options?.[0]) setViewing(next.options[0].id);
    // An overnight stay was set up as a dated trip: carry on in Trips.
    if (next.handoff) onOpenTrip?.(next.handoff.tripId);
  }, [viewing, onOpenTrip]);

  const send = useCallback(async (text: string, viaVoice = false, field: PlanRowKey | null = null) => {
    const utterance = text.trim();
    if (!utterance || busy) return;
    setError(null);
    setInput('');
    setPreviewRows(null);
    setEditing(null);
    setTurns((t) => [...t, { role: 'user', text: utterance, voice: viaVoice }]);
    setBusy('thinking');
    try {
      const next = plan?.trip
        ? await api.planRefine(sessionId!, utterance, viewing)
        : await api.planStart(utterance, sessionId, null, attendingIds ? [...attendingIds] : null, { field });
      take(next, viaVoice);
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : String(e?.message || e);
      setError(msg);
      if (viaVoice) speak(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, plan?.trip, sessionId, viewing, attendingIds, take]);

  // Plan it: the rows are settled, run the plan. The server answers at once and
  // works on; the screen asks every few seconds until the trip or the pool lands.
  const go = useCallback(async () => {
    if (!sessionId || busy) return;
    setError(null);
    setBusy('thinking');
    try { take(await api.planGo(sessionId), false); } catch (e: any) { setError(e instanceof ApiError ? e.message : String(e?.message || e)); } finally { setBusy(false); }
  }, [sessionId, busy, take]);
  useEffect(() => {
    if (!plan?.running || !sessionId) return;
    let live = true;
    const started = Date.now();
    const tick = async () => {
      try {
        const next = await api.planGet(sessionId);
        if (!live) return;
        if (next.running) { if (Date.now() - started > 8 * 60_000) { setError('Still working after eight minutes — try Plan it again in a moment.'); setPlan((p) => (p ? { ...p, running: false } : p)); } return; }
        take({ ...next, sessionId }, false);
        if (next.failed) setError(next.reply ?? 'That did not work.');
      } catch { /* a dropped poll is harmless; the next one asks again */ }
    };
    const h = setInterval(tick, 3000);
    return () => { live = false; clearInterval(h); };
  }, [plan?.running, sessionId, take]);

  const skip = useCallback(async (id: string) => {
    if (!sessionId || busy) return;
    setBusy('thinking');
    try { take(await api.planStart('', sessionId, null, attendingIds ? [...attendingIds] : null, { skip: id }), false); } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  }, [sessionId, busy, attendingIds, take]);

  const speech = useSpeech({
    onFinal: (text) => {
      if (mode === 'inspire') { setInspireQuery((q) => (q ? `${q} ` : '') + text); return; }
      const field = fieldRef.current; fieldRef.current = null;
      send(text, true, field);
    },
  });

  // While the household is talking, the words so far are read every few
  // seconds and the rows fill. A fixed beat, not a debounce: the transcript
  // changes with every word, so a timer that resets on change would never fire.
  const transcriptRef = useRef('');
  transcriptRef.current = speech.transcript;
  const previewBusy = useRef(false);
  useEffect(() => {
    if (!speech.listening || mode !== 'tell' || plan?.trip) return;
    const beat = async () => {
      if (fieldRef.current || previewBusy.current || previewCount.current >= 8) return;
      const t = transcriptRef.current.trim();
      if (t.length < 15 || t === lastPreviewed.current || t.length - lastPreviewed.current.length < 10) return;
      previewBusy.current = true;
      lastPreviewed.current = t;
      previewCount.current += 1;
      try {
        const r = await api.planPreview(t, sessionId);
        setSessionId((cur) => cur ?? r.sessionId);
        setPreviewRows(r.rows);
      } catch { /* the rows fill when they stop */ } finally { previewBusy.current = false; }
    };
    const first = setTimeout(beat, 1200);
    const h = setInterval(beat, 3000);
    return () => { clearTimeout(first); clearInterval(h); };
  }, [speech.listening, mode, sessionId, plan?.trip]);
  useEffect(() => { if (!speech.listening) { previewCount.current = 0; lastPreviewed.current = ''; } }, [speech.listening]);

  const act = useCallback(async (action: PlanAction) => {
    if (!sessionId || busy) return;
    setBusy('updating');
    setError(null);
    try {
      const next = await api.planAct(sessionId, action);
      setPlan((prev) => ({ ...(prev ?? {} as PlanResponse), ...next }));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, busy]);

  const commit = useCallback(async (optionId: string) => {
    if (!sessionId) return;
    setBusy('updating');
    try {
      await api.planCommit(sessionId, optionId);
      setCommitted(optionId);
      const msg = 'Saved as your trip.';
      setTurns((t) => [...t, { role: 'assistant', text: msg }]);
      if (turns[turns.length - 1]?.voice) speak(msg);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, turns]);

  const reset = () => {
    remembered = null;
    setSessionId(null); setPlan(null); setTurns([]); setViewing(null); setCommitted(null); setError(null);
    setPreviewRows(null); setEditing(null); setChanged({});
  };

  const members = household?.members ?? [];
  // Everyone is ticked to begin with; the server's list wins once a plan exists.
  useEffect(() => { if (members.length && !attendingIds) setAttendingIds(new Set(members.map((m) => m.id))); }, [members, attendingIds]);
  useEffect(() => { if (plan?.attending?.length) setAttendingIds(new Set(plan.attending.map((m) => m.id))); }, [plan?.attending]);
  const toggleMember = (id: string) => {
    const next = new Set(attendingIds ?? members.map((m) => m.id));
    if (next.has(id)) { if (next.size === 1) return; next.delete(id); } else next.add(id);
    setAttendingIds(next);
    if (plan?.trip) act({ type: 'set', attendingMemberIds: [...next] });
  };
  const baseLabel = plan?.journey?.to ?? plan?.trip?.destination?.label ?? plan?.trip?.origin.label ?? 'here';
  const picks = plan?.options?.find((o) => o.id === 'pinned') ?? null;
  // Keep "viewing" in step with the pager so "the first one" means what's on screen.
  const onPagerScroll = (e: any) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / (cardWidth + spacing.md));
    const opt = plan?.options?.[idx];
    if (opt && opt.id !== viewing) setViewing(opt.id);
  };

  useEffect(() => {
    if (plan?.options?.length && !plan.options.some((o) => o.id === viewing)) setViewing(plan.options[0].id);
  }, [plan?.options, viewing]);

  const rows: PlanRow[] = previewRows && (speech.listening || busy === 'thinking') ? previewRows : (plan?.rows ?? EMPTY_ROWS);
  const checks = plan?.checks ?? [];
  const answered = plan?.answered ?? [];
  const lastReply = [...turns].reverse().find((t) => t.role === 'assistant')?.text ?? null;
  const ready = Boolean(plan?.ready) && !plan?.trip;

  const whoTicks = (
    <Row style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
      {members.map((m) => {
        const on = attendingIds?.has(m.id) ?? true;
        return <Chip key={m.id} label={firstName(m.name)} icon={on ? 'check' : undefined} selected={on} onPress={() => toggleMember(m.id)} />;
      })}
    </Row>
  );
  const lastSaid = [...turns].reverse().find((t) => t.role === 'user')?.text ?? null;
  const fromRow = rows.find((r) => r.key === 'from');
  const whoInRows = rows.find((r) => r.key === 'who');
  const travelBits = [fromRow ? null : 'from home', whoInRows ? null : 'with the family'].filter(Boolean);
  const whoRow = members.length > 1 ? (
    <View>
      {/* One line: "The family" until someone is left out. Tap to open the ticks. */}
      <Pressable onPress={() => setWhoOpen((o) => !o)} style={styles.whoRow} accessibilityRole="button" accessibilityLabel="Who's coming" accessibilityState={{ expanded: whoOpen }}>
        <Text style={type.tiny}>Who's coming</Text>
        <Text style={[type.small, { fontWeight: '600', color: colors.ink, flex: 1 }]} numberOfLines={1}>
          {!attendingIds || attendingIds.size === members.length ? 'The family' : members.filter((m) => attendingIds.has(m.id)).map((m) => firstName(m.name)).join(', ')}
        </Text>
        <Icon name={whoOpen ? 'expand' : 'more'} size={14} color={colors.inkMuted} />
      </Pressable>
      {whoOpen ? (
        <Row style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
          {members.map((m) => {
            const on = attendingIds?.has(m.id) ?? true;
            return <Chip key={m.id} label={firstName(m.name)} icon={on ? 'check' : undefined} selected={on} onPress={() => toggleMember(m.id)} />;
          })}
        </Row>
      ) : null}
    </View>
  ) : null;

  const openRow = (r: PlanRow) => {
    if (speech.listening || busy) return;
    if (r.key === 'who') { setWhoOpen((o) => !o); return; }
    setEditing(editing === r.key ? null : r.key);
    setEditText(r.value ?? '');
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Text style={[type.title, { flex: 1 }]}>Where should we go?</Text>
        {turns.length || plan ? <Button label="Start over" kind="ghost" onPress={reset} /> : null}
      </View>
      {!plan?.trip ? (
        <Segmented value={mode} options={[{ value: 'tell', label: 'Tell me' }, { value: 'inspire', label: 'Inspire me' }]} onChange={(v) => { if (!speech.listening) setMode(v as Mode); }} />
      ) : null}

      {mode === 'inspire' && !plan?.trip ? (
        <InspireMe
          query={inspireQuery} setQuery={setInspireQuery}
          attendingIds={attendingIds ? [...attendingIds] : null}
          who={whoRow}
          onPlan={(utterance) => { setMode('tell'); send(utterance); }}
          onOpenTrip={onOpenTrip}
          listening={speech.listening} transcript={speech.transcript} supported={speech.supported}
          onSpeak={() => { fieldRef.current = null; speech.start(); }} onStop={speech.stop}
        />
      ) : (
        <>
          {/* The rows are the screen: what was said, in its slot. A row the planner is not sure of carries a Check; tap any row to change it. */}
          <Card style={{ gap: 0 }}>
            {travelBits.length ? (
              <View>
                {/* "Travelling from home with the family": the assumptions, one line. Tap to change either; say "from Bristol" or "just me and Phoenix" and a row appears instead. */}
                <Pressable onPress={() => { if (!speech.listening) setTravelOpen((o) => !o); }} style={[styles.row, styles.travel]} accessibilityRole="button" accessibilityLabel={`Travelling ${travelBits.join(' ')}. Tap to change`}>
                  <Text style={[type.body, { flex: 1, color: colors.inkMuted }]}>Travelling <Text style={{ fontWeight: '600', color: colors.ink }}>{travelBits.join(' ')}</Text></Text>
                  <Icon name={travelOpen ? 'expand' : 'more'} size={14} color={colors.inkMuted} />
                </Pressable>
                {travelOpen ? (
                  <View style={styles.editor}>
                    {!fromRow ? (
                      <>
                        <Text style={type.tiny}>Starting somewhere other than home?</Text>
                        <TextInput value={fromText} onChangeText={setFromText} style={styles.editInput} placeholder="From…" placeholderTextColor={colors.inkFaint} onSubmitEditing={() => { setTravelOpen(false); send(fromText, false, 'from'); }} accessibilityLabel="Change where you start" />
                        <Row>
                          {speech.supported ? <Pressable onPress={() => { fieldRef.current = 'from'; speech.start(); }} style={styles.mic} accessibilityRole="button" accessibilityLabel="Say where you start"><Icon name="mic" size={16} color={colors.ink} /><Text style={[type.small, { fontWeight: '600' }]}>Say it</Text></Pressable> : null}
                          <Button label="Done" onPress={() => { setTravelOpen(false); send(fromText, false, 'from'); }} disabled={!fromText.trim() || !!busy} />
                        </Row>
                      </>
                    ) : null}
                    {!whoInRows && members.length > 1 ? (<><Text style={type.tiny}>Who's coming</Text>{whoTicks}</>) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
            {rows.map((r, i) => {
              const isEditing = editing === r.key;
              return (
                <View key={r.key}>
                  <Pressable onPress={() => openRow(r)} style={[styles.row, (i > 0 || travelBits.length > 0) && styles.rowLine, r.state === 'check' && styles.rowCheck, isEditing && styles.rowEditing]} accessibilityRole="button" accessibilityLabel={`${r.label}: ${r.value ?? 'not said'}`}>
                    <Text style={styles.rowKey}>{r.label}</Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[type.body, { fontWeight: '600' }, !r.value && { color: colors.inkFaint, fontWeight: '400' }]}>{r.value ?? (r.key === 'budget' ? 'any' : r.key === 'to' && r.detail ? r.detail : 'not said')}</Text>
                      {r.value && r.detail ? <Text style={type.tiny}>{r.detail}</Text> : null}
                      {changed[r.key] ? <Text style={[type.tiny, { color: colors.accent }]}>was: {changed[r.key]}</Text> : null}
                    </View>
                    {r.state === 'check' ? <View style={styles.flag}><Text style={styles.flagText}>Check</Text></View> : null}
                  </Pressable>
                  {r.key === 'who' && whoOpen ? <View style={styles.editor}>{whoTicks}</View> : null}
                  {isEditing ? (
                    <View style={styles.editor}>
                      {r.key === 'budget' ? (
                        <Wrap>{PRICE_CHIPS.map((c) => <Chip key={c.label} label={c.label} selected={r.value === c.label} onPress={() => send(c.say, false, 'budget')} />)}</Wrap>
                      ) : (
                        <>
                          <TextInput value={editText} onChangeText={setEditText} style={styles.editInput} placeholder={`${r.label}…`} placeholderTextColor={colors.inkFaint} onSubmitEditing={() => send(editText, false, r.key)} accessibilityLabel={`Change ${r.label}`} />
                          <Row>
                            {speech.supported ? <Pressable onPress={() => { fieldRef.current = r.key; speech.start(); }} style={styles.mic} accessibilityRole="button" accessibilityLabel={`Say ${r.label} again`}><Icon name="mic" size={16} color={colors.ink} /><Text style={[type.small, { fontWeight: '600' }]}>Say it again</Text></Pressable> : null}
                            <Button label="Done" onPress={() => send(editText, false, r.key)} disabled={!editText.trim() || !!busy} />
                            <Button label="Cancel" kind="ghost" onPress={() => setEditing(null)} />
                          </Row>
                        </>
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })}
            {speech.listening && fieldRef.current ? <Text style={[type.tiny, { marginTop: 6 }]}>Listening for {fieldRef.current} only…</Text> : null}
          </Card>

          {/* The box is small on purpose: the rows are what you watch. One control: Stop while listening, else Speak and Plan it (Send only once something is typed). */}
          {!plan?.trip || true ? (
            <Card style={{ gap: spacing.sm }}>
              <TextInput
                value={speech.listening ? speech.transcript : input}
                onChangeText={setInput}
                multiline
                editable={!speech.listening}
                placeholder={plan?.trip ? 'I like this, but not that…' : plan?.rows ? 'Add or change anything…' : 'Where, when, how long, who is coming, and anything you must fit in…'}
                placeholderTextColor={colors.inkFaint}
                style={[styles.input, speech.listening && styles.inputLive]}
                accessibilityLabel="What do you want to do"
              />
              {speech.listening ? (
                <Pressable onPress={speech.stop} style={styles.stop} accessibilityRole="button" accessibilityLabel="Stop"><Icon name="stop" size={14} color={colors.bg} /><Text style={styles.stopText}>Stop</Text></Pressable>
              ) : (
                <Row style={{ justifyContent: 'space-between' }}>
                  {speech.supported ? (
                    <Pressable onPress={() => { fieldRef.current = null; speech.start(); }} style={styles.mic} accessibilityRole="button" accessibilityLabel="Speak">
                      <Icon name="mic" size={20} color={colors.ink} />
                      <Text style={[type.small, { fontWeight: '600' }]}>Speak</Text>
                    </Pressable>
                  ) : <View />}
                  {input.trim() ? (
                    <Button label="Send" onPress={() => send(input)} disabled={!!busy} />
                  ) : plan?.trip ? null : (
                    <Button label={plan?.running ? 'Working…' : 'Plan it'} icon="plan" onPress={go} disabled={!ready || !!busy || !!plan?.running} />
                  )}
                </Row>
              )}
              {busy === 'thinking' ? <Row><ActivityIndicator color={colors.accent} /><Text style={type.small}>Working it out…</Text></Row> : null}
              {lastSaid && !speech.listening && !plan?.trip ? <Text style={type.tiny} numberOfLines={3}>You said: {lastSaid}</Text> : null}
              {!speech.supported ? <Text style={type.tiny}>Voice input isn't available in this browser — typing does exactly the same thing.</Text> : null}
              {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
              {speech.error ? <StatusLine tone="warn">{speech.error}</StatusLine> : null}
            </Card>
          ) : null}

          {/* Things to check: every doubt, one open at a time, answered by tap or by saying it; answered ones fold to a record. */}
          {!plan?.trip && (checks.length || answered.length) ? (
            <Card style={[styles.checks, !checks.length && { borderLeftColor: colors.accent }]}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={type.h3}>{checks.length ? 'Things to check' : 'All set — nothing left to check'}</Text>
                {checks.length ? <Text style={type.tiny}>{answered.length + 1} of {answered.length + checks.length}</Text> : null}
              </Row>
              {answered.map((a) => (
                <Row key={a.id} style={styles.check}>
                  <View style={[styles.num, { backgroundColor: colors.accent }]}><Icon name="check" size={12} color={colors.bg} /></View>
                  <Text style={[type.small, { flex: 1 }]} numberOfLines={2}>{a.text} <Text style={{ fontWeight: '700', color: colors.ink }}>{a.answer}</Text></Text>
                </Row>
              ))}
              {checks.map((c, i) => (
                <View key={c.id} style={[styles.check, i > 0 && { opacity: 0.45 }]}>
                  <Row style={{ alignItems: 'flex-start' }}>
                    <View style={[styles.num, { backgroundColor: colors.dislike }]}><Text style={styles.numText}>{answered.length + i + 1}</Text></View>
                    <Text style={[type.body, { flex: 1, fontWeight: '600' }]}>{c.text}</Text>
                  </Row>
                  {i === 0 && !busy ? (
                    <View style={{ paddingLeft: 30, gap: 4 }}>
                      {c.choices.length ? <Wrap>{c.choices.map((ch) => <Chip key={ch.say} label={ch.label} tone="accent" onPress={() => send(ch.say)} />)}</Wrap> : null}
                      <Text style={type.tiny}>{c.choices.length ? 'Tap one, or say it' : 'Say it or type it below'}{c.skippable ? <Text onPress={() => skip(c.id)} style={{ textDecorationLine: 'underline' }}> · skip</Text> : null}</Text>
                    </View>
                  ) : null}
                </View>
              ))}
            </Card>
          ) : null}

          {plan?.running ? (
            <Card style={{ borderColor: colors.accent }}>
              <Row><ActivityIndicator color={colors.accent} /><Text style={[type.body, { flex: 1 }]}>Setting it up — finding places, working out the day. A minute or two; you can leave this tab and come back.</Text></Row>
            </Card>
          ) : null}
          {plan?.handoff ? (
            <Card style={{ borderColor: colors.accent }}>
              <Text style={type.h3}>{plan.handoff.title} is set up</Text>
              {lastReply ? <Text style={type.small}>{lastReply}</Text> : null}
              <Button label="Open the trip" icon="trips" onPress={() => onOpenTrip?.(plan.handoff!.tripId)} />
            </Card>
          ) : lastReply && !plan?.trip ? <Text style={[type.small, { paddingHorizontal: 4 }]}>{lastReply}</Text> : null}
        </>
      )}

      {/* Trip controls */}
      {plan?.trip ? (
        <Card>
          <Text style={type.h3}>
            {plan.journey ? `${plan.journey.to}` : `${plan.trip.origin.label}${plan.trip.destination ? ` → ${plan.trip.destination.label}` : ' and back'}`}
          </Text>
          <Text style={type.small}>
            {plan.date ? `${new Date(`${plan.date}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ` : ''}
            {clock(plan.trip.departAt)} – {clock(plan.trip.returnAt)} there · {plan.trip.travelMode}
            {plan.reach ? ` · reach ~${plan.reach.maxTravelMinutes} min (estimated)` : ''}
          </Text>
          {plan.journey && plan.journey.minutes > 20 ? <Text style={type.small}>Getting there: {plan.journey.from} → {plan.journey.to}, about {minutes(plan.journey.minutes)} by {plan.journey.mode} (estimated) — not counted in your time there.</Text> : null}
          {plan.anchor ? <Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>Fixed: {plan.anchor.name}{plan.anchor.start_time ? ` at ${plan.anchor.start_time}` : ''} · {plan.anchor.place.label}</Text> : null}
          <Stepper
            label="Time we have"
            value={Math.round((new Date(plan.trip.returnAt).getTime() - new Date(plan.trip.departAt).getTime()) / 60000)}
            min={60} max={720} step={30} format={minutes}
            onChange={(v) => act({ type: 'set', durationMinutes: v })}
          />
          <Stepper label="Things to do, at least" value={plan.constraints?.minActivities ?? 0} onChange={(v) => act({ type: 'set', minActivities: v })} max={5} />
          <Stepper label="Places to eat or drink, at least" value={plan.constraints?.minFood ?? 0} onChange={(v) => act({ type: 'set', minFood: v })} max={4} />
          <PricePointControl value={plan.constraints?.pricePoint ?? 'any'} onChange={(v) => act({ type: 'set', pricePoint: v })} />
          <ChainsControl includeChains={plan.constraints?.includeChains ?? false} hidden={plan.pool?.hiddenChains ?? 0} onChange={(v) => act({ type: 'set', includeChains: v })} />
          <Text style={[type.small, { marginTop: 4 }]}>How full should the day be?</Text>
          <Segmented
            value={plan.trip.intensity}
            options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'packed', label: 'Packed' }]}
            onChange={(v) => act({ type: 'set', intensity: v })}
          />
        </Card>
      ) : null}

      {/* Everything found, browse-first; picks are kept in every plan and saved as the day */}
      {hasOptions ? (
        <>
          <Text style={type.h2}>Everything Roam found near {baseLabel}</Text>
          <Text style={type.tiny}>Built from the same {plan!.pool?.size ?? '—'} places — filtering and sorting here makes no new lookups. Tap a place for reviews, hours and photos.</Text>
          <BrowsePool
            items={plan!.browse ?? []}
            eventsSource={plan!.eventsSource}
            baseLabel={baseLabel}
            pinned={new Set(plan!.selection?.pinned ?? [])}
            busy={busy === 'updating'}
            addLabel="+ Add to plan"
            addedLabel="In the plan"
            onAdd={(b) => act({ type: 'like', stopId: b.id })}
            onRemove={(b) => act({ type: 'unlike', stopId: b.id })}
            onDislike={(b) => act({ type: 'dislike', stopId: b.id })}
          />
          <Card style={{ borderColor: colors.accent }}>
            <Text style={type.h3}>Your day</Text>
            {picks ? (
              <>
                <TimeBar budget={picks.budget} stops={picks.stops} compact />
                {picks.stops.map((s) => <Text key={s.id} style={type.body}>{s.arriveAt ? `${clock(s.arriveAt)} · ` : ''}{s.name}{s.fixed ? ' (your booking)' : ''} · {minutes(s.dwellMinutes)}</Text>)}
                <Text style={type.tiny}>{minutes(picks.budget.travelMinutes)} travelling · {picks.budget.remainingMinutes >= 0 ? `${minutes(picks.budget.remainingMinutes)} free` : `over by ${minutes(-picks.budget.remainingMinutes)}`}</Text>
              </>
            ) : <Text style={type.small}>Nothing added yet. Add places above, or let Roam fill the day.</Text>}
            <Row>
              <Button icon={committed ? 'check' : undefined} label={committed ? 'Saved as your day' : picks ? 'Save these as the day' : 'Let Roam fill the day'} onPress={() => commit(picks?.id ?? plan!.options[0]?.id)} disabled={busy === 'updating' || !!committed || !plan!.options.length} />
              {picks && !committed ? <Button label="Let Roam fill the rest" kind="secondary" onPress={() => commit(plan!.options.find((o) => o.id !== 'pinned')?.id ?? picks.id)} disabled={busy === 'updating'} /> : null}
            </Row>
          </Card>

          {plan!.selection?.excluded?.length ? (
            <Card>
              <Text style={type.h3}>Not for us this time</Text>
              <Wrap>
                {plan!.selection.excluded.map((key) => (
                  <Chip key={key} label={labelFor(key, plan!)} tone="dislike" onRemove={() => act({ type: 'restore', stopId: key })} />
                ))}
              </Wrap>
              <Text style={type.tiny}>Tap the cross on a place to let it back in.</Text>
            </Card>
          ) : null}

          {plan!.pool?.excludedByAllergen?.length ? (
            <Card>
              <Text style={type.h3}>{plan!.pool.excludedByAllergen.length} hidden for an allergen</Text>
              {plan!.pool.excludedByAllergen.map((e) => (
                <Text key={e.name} style={type.small}>{e.name} — {e.reasons.join('; ')}</Text>
              ))}
            </Card>
          ) : null}

          {plan!.suggestedPreferences?.length ? (
            <Card style={{ borderColor: colors.accentSoft }}>
              <Text style={type.h3}>Worth remembering?</Text>
              <Text style={type.tiny}>Nothing is saved to a profile unless you say so.</Text>
              {plan!.suggestedPreferences.map((p, i) => (
                <SuggestedPreferenceRow key={i} pref={p} members={members} />
              ))}
            </Card>
          ) : null}

          {plan!.spend ? (
            <Text style={type.tiny}>
              {plan!.spend.session_calls} of {plan!.spend.sessionBound} planning requests used this session · ~${plan!.spend.session_cost_usd.toFixed(3)}{plan!.spend.trip_cost_usd != null ? ` · this outing $${plan!.spend.trip_cost_usd.toFixed(2)}` : ''} · this month ${plan!.spend.month_cost_usd.toFixed(2)}
            </Text>
          ) : null}
        </>
      ) : plan?.trip ? (
        <Card>
          <Text style={type.h3}>Nothing fits yet</Text>
          <Text style={type.small}>Try a longer window, fewer must-haves, or a lower intensity — the controls above do it, or just say so.</Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

function labelFor(key: string, plan: PlanResponse): string {
  for (const o of plan.options) for (const s of o.stops) if (s.id === key) return s.name;
  return key.split(':').pop() ?? key;
}

function SuggestedPreferenceRow({ pref, members }: { pref: { member: string | null; kind: 'like' | 'dislike'; value: string }; members: HouseholdResponse['members'] }) {
  const [state, setState] = useState<'offer' | 'saved' | 'dismissed'>('offer');
  const target = pref.member ? members.find((m) => m.name.toLowerCase() === pref.member!.toLowerCase()) : null;
  if (state === 'dismissed') return null;
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Text style={[type.small, { flex: 1 }]}>
        {pref.member ?? 'The household'} {pref.kind === 'like' ? 'likes' : 'dislikes'} <Text style={{ fontWeight: '700' }}>{pref.value}</Text>
      </Text>
      {state === 'saved' ? <Text style={[type.small, { color: colors.like }]}>Saved</Text> : (
        <Row>
          {target ? (
            <Button label={`Save to ${target.name}`} kind="secondary" onPress={async () => {
              await api.addConstraint(target.id, { kind: pref.kind, value: pref.value });
              setState('saved');
            }} />
          ) : null}
          <Button label="Not now" kind="ghost" onPress={() => setState('dismissed')} />
        </Row>
      )}
    </Row>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, maxWidth: 760, width: '100%', alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.xs },
  bubble: { padding: spacing.md, borderRadius: radius.md, maxWidth: '92%' },
  bubbleUser: { backgroundColor: colors.accent, alignSelf: 'flex-end' },
  bubbleAssistant: { backgroundColor: colors.surfaceMuted, alignSelf: 'flex-start' },
  input: {
    minHeight: 72, padding: spacing.md, borderRadius: radius.md, textAlignVertical: 'top',
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 16, lineHeight: 22, color: colors.ink,
  },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32, paddingHorizontal: 4 },
  inputLive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  stop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, minHeight: TARGET, borderRadius: radius.pill, backgroundColor: colors.overrun },
  stopText: { color: colors.bg, fontWeight: '700', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 9, paddingHorizontal: 6, borderRadius: radius.sm },
  rowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  rowCheck: { backgroundColor: '#FBF6EA' },
  rowEditing: { backgroundColor: colors.accentSoft },
  rowKey: { width: 64, fontSize: 11, letterSpacing: 0.3, textTransform: 'uppercase', color: colors.inkFaint },
  travel: { paddingVertical: 10 },
  flag: { backgroundColor: '#F6EBD5', paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill },
  flagText: { fontSize: 11, fontWeight: '700', color: colors.dislike, letterSpacing: 0.2 },
  editor: { gap: spacing.sm, padding: spacing.sm, marginBottom: 4, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.md, backgroundColor: colors.surface },
  editInput: { minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink },
  checks: { borderLeftWidth: 3, borderLeftColor: colors.dislike, gap: spacing.sm },
  check: { gap: 6, paddingTop: 6 },
  num: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  numText: { color: colors.bg, fontSize: 11, fontWeight: '700' },
  mic: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line,
  },
  optionsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  toggle: { minHeight: TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm },
  optionCard: { gap: spacing.md },
  optionCardViewing: { borderColor: colors.inkFaint },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.line },
  dotOn: { backgroundColor: colors.accent },
});

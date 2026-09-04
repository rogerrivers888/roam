import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { api, ApiError, HouseholdResponse, Place, PlanAction, PlanResponse, PlanRow, PlanRowKey, PlanSet, PricePoint } from '../api';
import { DateRangePicker } from '../components/DateRangePicker';
import { RangeSlider } from '../components/RangeSlider';
import { IconName } from '../components/Icon';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Stepper, Wrap, minutes, clock } from '../components/ui';
import { TimeBar } from '../components/TimeBar';
import { PricePointControl, ChainsControl } from '../components/PlanControls';
import { BrowsePool } from '../components/BrowsePool';
import { OnTheWay } from '../components/OnTheWay';
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
// Every row is a control: tap it and choose, no typing except a place name. Speaking fills the same rows.
const ROW_ICON: Record<string, IconName> = { from: 'home', to: 'address', when: 'calendar', who: 'household', stay: 'hotel', do: 'plan', eat: 'restaurant', budget: 'list' };
const HOURS = [{ label: '2 hours', value: 120 }, { label: '3 hours', value: 180 }, { label: 'Half a day', value: 300 }, { label: 'All day', value: 600 }];
const MEALS = ['Breakfast', 'Coffee', 'Lunch', 'Dinner'];
const MEAL_KINDS = ['Pub', 'Café', 'Italian', 'Indian', 'Japanese', 'Chinese', 'Thai', 'Mexican', 'Seafood', 'Steak', 'Picnic'];
const PRICE_POINTS: { label: string; value: 'any' | PricePoint }[] = [{ label: 'Any', value: 'any' }, { label: 'Affordable', value: 'affordable' }, { label: 'Mid-range', value: 'mid' }, { label: 'Upmarket', value: 'upmarket' }];
const BUDGET_BARS = [0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1, 0.85, 0.7, 0.55, 0.42, 0.3, 0.22, 0.16, 0.1, 0.07, 0.05, 0.04];
// A price point is a band per head for the day's food and things to do (never the hotel): the pill sets the slider, the slider sets the pill.
const BAND_PER_HEAD: Record<Exclude<PricePoint, 'any'>, [number, number]> = { affordable: [0, 25], mid: [25, 60], upmarket: [60, 150] };
const bandFor = (pp: 'any' | PricePoint, per: 'everyone' | 'person', heads: number): [number, number] | null => {
  if (pp === 'any') return null;
  const [lo, hi] = BAND_PER_HEAD[pp as Exclude<PricePoint, 'any'>];
  const k = per === 'person' ? 1 : Math.max(1, heads);
  return [Math.round((lo * k) / 10) * 10, Math.round((hi * k) / 10) * 10];
};
const pointFor = (high: number, per: 'everyone' | 'person', heads: number): 'any' | PricePoint => {
  const perHead = per === 'person' ? high : high / Math.max(1, heads);
  return perHead < 25 ? 'affordable' : perHead < 60 ? 'mid' : 'upmarket';
};
type Controls = {
  when: { mode: 'day' | 'stay'; start: string | null; end: string | null; duration: number | null };
  do: { kinds: string[]; named: string[]; count: number | null };
  eat: { meals: Record<string, string | null>; avoidChains: boolean | null; special: boolean };
  budget: { pricePoint: 'any' | PricePoint; low: number; high: number; per: 'everyone' | 'person' };
};
const EMPTY_CONTROLS: Controls = { when: { mode: 'day', start: null, end: null, duration: null }, do: { kinds: [], named: [], count: null }, eat: { meals: {}, avoidChains: null, special: false }, budget: { pricePoint: 'any', low: 40, high: 140, per: 'everyone' } };

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
  const [ctl, setCtl] = useState<Controls>(EMPTY_CONTROLS);
  const [kinds, setKinds] = useState<{ key: string; label: string }[]>([]);
  const [moreKinds, setMoreKinds] = useState(false);
  const [namedText, setNamedText] = useState('');
  // The To search: the planner's own ranking (a town first, roads last and labelled), a rough drive from home on each.
  const [toQuery, setToQuery] = useState('');
  const [toHits, setToHits] = useState<{ label: string; where: string; kind: string; isRoad: boolean; travelMinutes: number | null; place: Place }[] | null>(null);
  const [toBusy, setToBusy] = useState(false);
  useEffect(() => {
    const q = toQuery.trim();
    if (q.length < 2) { setToHits(null); return; }
    setToBusy(true);
    const h = setTimeout(async () => { try { const r = await api.planPlaces(q); setToHits(r.places); } catch { setToHits([]); } finally { setToBusy(false); } }, 450);
    return () => clearTimeout(h);
  }, [toQuery]);
  const setTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      return { ...(prev ?? {} as PlanResponse), ...next, question: next.question ?? null, checks: next.checks ?? [], rows: next.rows ?? prev?.rows ?? null, running: next.running ?? false };
    });
    if (next.reply) {
      setTurns((t) => [...t, { role: 'assistant', text: next.reply! }]);
      if (viaVoice) speak(next.reply);
    }
    if (!viewing && next.options?.[0]) setViewing(next.options[0].id);
    // An overnight stay was set up as a dated trip: carry on in Trips.
    if (next.handoff) onOpenTrip?.(next.handoff.tripId, next.handoff.section ? { section: next.handoff.section } : undefined);
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

  // A tapped control lands in the rows as tapped, no interpretation. Quick taps
  // are batched over half a second so a run of pills is one request.
  const pendingSet = useRef<PlanSet>({});
  const applySet = useCallback((patch: PlanSet) => {
    pendingSet.current = { ...pendingSet.current, ...patch };
    if (setTimer.current) clearTimeout(setTimer.current);
    setTimer.current = setTimeout(async () => {
      const body = pendingSet.current; pendingSet.current = {};
      setError(null);
      try { take(await api.planSet(body, sessionId, attendingIds ? [...attendingIds] : null), false); }
      catch (e: any) { setError(e instanceof ApiError ? e.message : String(e?.message || e)); }
    }, 500);
  }, [sessionId, attendingIds, take]);
  useEffect(() => { api.browse().then((b) => setKinds(b.activities.flatMap((sec) => sec.items.map((i) => ({ key: i.key, label: i.label }))))).catch(() => {}); }, []);
  const update = <K extends keyof Controls>(key: K, next: Controls[K]) => setCtl((c) => ({ ...c, [key]: next }));
  const heads = attendingIds?.size ?? (household?.members.length ?? 1);

  // Plan it: the rows are settled, run the plan. The server answers at once and
  // works on; the screen asks every few seconds until the trip or the pool lands.
  const go = useCallback(async () => {
    if (!sessionId || busy) return;
    setError(null);
    setBusy('thinking');
    try { take(await api.planGo(sessionId), false); } catch (e: any) { setError(e instanceof ApiError ? e.message : String(e?.message || e)); } finally { setBusy(false); }
  }, [sessionId, busy, take]);
  const retriedRef = useRef(false);
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
        if (next.failed) {
          // A deploy mid-run: try once more by itself before bothering anyone.
          if ((next as any).interrupted && !retriedRef.current) { retriedRef.current = true; setError(null); try { take(await api.planGo(sessionId), false); } catch { /* the message below stands */ } return; }
          setError(next.reply ?? 'That did not work.');
        }
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
  // Who is coming, in the few words Inspire me puts on its one settings line.
  const whoLabel = !attendingIds || attendingIds.size === members.length
    ? 'The family'
    : members.filter((m) => attendingIds.has(m.id)).map((m) => firstName(m.name)).join(', ') || 'The family';
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
          who={members.length > 1 ? <View style={{ gap: 4 }}><Text style={type.tiny}>Who's coming</Text>{whoTicks}</View> : null}
          whoLabel={whoLabel}
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
              const isControl = ['to', 'when', 'do', 'eat', 'budget'].includes(r.key);
              return (
                <View key={r.key}>
                  <Pressable onPress={() => openRow(r)} style={[styles.row, (i > 0 || travelBits.length > 0) && styles.rowLine, r.state === 'check' && styles.rowCheck, isEditing && styles.rowEditing]} accessibilityRole="button" accessibilityLabel={`${r.label}: ${r.value ?? 'not said'}`}>
                    <View style={styles.well}><Icon name={ROW_ICON[r.key] ?? 'info'} size={18} /></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.rowKey}>{r.label}</Text>
                      <Text style={[type.body, { fontWeight: '600' }, !r.value && { color: colors.inkMuted, fontWeight: '400' }]}>{r.value ?? ({ to: 'Search a place or a city', when: 'Pick a date · day out or a stay', do: 'Pick what you fancy', eat: 'Meals and what kind', budget: 'Any · set a range' } as Record<string, string>)[r.key] ?? 'not said'}</Text>
                      {r.value && r.detail ? <Text style={type.tiny}>{r.detail}</Text> : null}
                      {changed[r.key] ? <Text style={[type.tiny, { color: colors.accent }]}>was: {changed[r.key]}</Text> : null}
                    </View>
                    {r.state === 'check' ? <View style={styles.flag}><Text style={styles.flagText}>Check</Text></View> : null}
                    <Icon name={isEditing ? 'expand' : 'more'} size={16} color={colors.inkMuted} />
                  </Pressable>
                  {r.key === 'who' && whoOpen ? <View style={styles.editor}>{whoTicks}</View> : null}
                  {isEditing && r.key === 'to' ? (
                    <View style={styles.panel}>
                      <Row>
                        <Icon name="search" size={18} />
                        <TextInput value={toQuery} onChangeText={setToQuery} style={[styles.editInput, { flex: 1 }]} placeholder="Search a place or a city" placeholderTextColor={colors.inkFaint} autoFocus accessibilityLabel="Search a place or a city" />
                      </Row>
                      {toBusy ? <Row><ActivityIndicator color={colors.accent} /><Text style={type.tiny}>Looking…</Text></Row> : null}
                      {toHits?.length === 0 && !toBusy ? <Text style={type.small}>Nothing on the map by that name — try the town as well.</Text> : null}
                      {(toHits ?? []).map((h) => (
                        <Pressable key={`${h.place.lat},${h.place.lng}`} onPress={() => { applySet({ destination: h.place }); setEditing(null); setToQuery(''); setToHits(null); }} style={styles.hit} accessibilityRole="button" accessibilityLabel={`${h.label}, ${h.where}`}>
                          <Icon name={h.isRoad ? 'directions' : h.kind === 'city' || h.kind === 'town' || h.kind === 'village' ? 'address' : 'attraction'} size={18} />
                          <View style={{ flex: 1 }}>
                            <Text style={[type.body, { fontWeight: '600' }]}>{h.label}</Text>
                            <Text style={type.tiny}>{[h.kind[0].toUpperCase() + h.kind.slice(1), h.where, h.travelMinutes != null ? `${minutes(h.travelMinutes)} from home` : null].filter(Boolean).join(' · ')}</Text>
                          </View>
                          <Icon name="more" size={16} color={colors.inkMuted} />
                        </Pressable>
                      ))}
                      <Row>
                        {speech.supported ? <Pressable onPress={() => { fieldRef.current = 'to'; speech.start(); }} style={styles.mic} accessibilityRole="button" accessibilityLabel="Say where to"><Icon name="mic" size={16} color={colors.ink} /><Text style={[type.small, { fontWeight: '600' }]}>Say it</Text></Pressable> : null}
                        <Text style={[type.tiny, { flex: 1 }]}>Your places first, then the map. A road never stands in for a town.</Text>
                      </Row>
                    </View>
                  ) : null}
                  {isEditing && r.key === 'when' ? (
                    <View style={styles.panel}>
                      <Segmented value={ctl.when.mode} options={[{ value: 'day', label: 'Day out' }, { value: 'stay', label: 'Night away' }]} onChange={(v) => { const mode = v as 'day' | 'stay'; update('when', { ...ctl.when, mode }); if (mode === 'day') applySet({ nights: null, end_date: null }); }} />
                      <DateRangePicker
                        single={ctl.when.mode === 'day'}
                        start={ctl.when.start} end={ctl.when.end}
                        onApply={(start, end) => {
                          const nights = ctl.when.mode === 'stay' ? Math.max(1, Math.round((new Date(`${end}T12:00:00`).getTime() - new Date(`${start}T12:00:00`).getTime()) / 86_400_000)) : null;
                          update('when', { ...ctl.when, start, end });
                          applySet(ctl.when.mode === 'stay' ? { date: start, end_date: end, nights, duration_minutes: null } : { date: start, end_date: null, nights: null });
                        }}
                      />
                      {ctl.when.mode === 'day' ? (
                        <>
                          <Text style={styles.h}>How long there</Text>
                          <Wrap>{HOURS.map((h) => <Chip key={h.value} label={h.label} selected={ctl.when.duration === h.value} onPress={() => { update('when', { ...ctl.when, duration: h.value }); applySet({ duration_minutes: h.value }); }} />)}</Wrap>
                        </>
                      ) : <Text style={type.tiny}>Say when you arrive ("we get there in the evening") and the first day is planned around it.</Text>}
                    </View>
                  ) : null}
                  {isEditing && r.key === 'do' ? (
                    <View style={styles.panel}>
                      <Text style={styles.h}>What kind of thing</Text>
                      <Wrap>
                        {(moreKinds ? kinds : kinds.slice(0, 12)).map((k) => {
                          const on = ctl.do.kinds.includes(k.label);
                          return <Chip key={k.key} label={k.label} selected={on} icon={on ? 'check' : undefined} onPress={() => { const next = on ? ctl.do.kinds.filter((x) => x !== k.label) : [...ctl.do.kinds, k.label]; const d = { ...ctl.do, kinds: next }; update('do', d); applySet({ do: d }); }} />;
                        })}
                        {kinds.length > 12 ? <Chip label={moreKinds ? 'Fewer' : `+ ${kinds.length - 12} more`} onPress={() => setMoreKinds((m) => !m)} /> : null}
                      </Wrap>
                      <Text style={styles.h}>A specific place</Text>
                      <Row>
                        <TextInput value={namedText} onChangeText={setNamedText} style={[styles.editInput, { flex: 1 }]} placeholder="The Roman Baths…" placeholderTextColor={colors.inkFaint} onSubmitEditing={() => { if (!namedText.trim()) return; const d = { ...ctl.do, named: [...ctl.do.named, namedText.trim()] }; update('do', d); applySet({ do: d }); setNamedText(''); }} accessibilityLabel="A specific place to do" />
                        <Button label="Add" kind="secondary" onPress={() => { if (!namedText.trim()) return; const d = { ...ctl.do, named: [...ctl.do.named, namedText.trim()] }; update('do', d); applySet({ do: d }); setNamedText(''); }} disabled={!namedText.trim()} />
                      </Row>
                      {ctl.do.named.length ? <Wrap>{ctl.do.named.map((n) => <Chip key={n} label={n} selected icon="check" onRemove={() => { const d = { ...ctl.do, named: ctl.do.named.filter((x) => x !== n) }; update('do', d); applySet({ do: d }); }} />)}</Wrap> : null}
                      <Text style={styles.h}>How many things</Text>
                      <Segmented value={String(ctl.do.count ?? '')} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} onChange={(v) => { const d = { ...ctl.do, count: Number(v) }; update('do', d); applySet({ do: d }); }} />
                    </View>
                  ) : null}
                  {isEditing && r.key === 'eat' ? (
                    <View style={styles.panel}>
                      <Text style={styles.h}>Which meals</Text>
                      <Wrap>{MEALS.map((m) => { const key = m.toLowerCase(); const on = key in ctl.eat.meals; return <Chip key={m} label={m} selected={on} icon={on ? 'check' : undefined} onPress={() => { const meals = { ...ctl.eat.meals }; if (on) delete meals[key]; else meals[key] = null; const e = { ...ctl.eat, meals }; update('eat', e); applySet({ eat: { meals: e.meals, avoid_chains: e.avoidChains, special: e.special } }); }} />; })}</Wrap>
                      {Object.keys(ctl.eat.meals).map((meal) => (
                        <View key={meal} style={{ gap: 6 }}>
                          <Text style={styles.h}>{meal[0].toUpperCase() + meal.slice(1)}</Text>
                          <Wrap>
                            <Chip label="Anything" selected={ctl.eat.meals[meal] == null} onPress={() => { const e = { ...ctl.eat, meals: { ...ctl.eat.meals, [meal]: null } }; update('eat', e); applySet({ eat: { meals: e.meals, avoid_chains: e.avoidChains, special: e.special } }); }} />
                            {MEAL_KINDS.map((k) => <Chip key={k} label={k} selected={ctl.eat.meals[meal] === k} onPress={() => { const e = { ...ctl.eat, meals: { ...ctl.eat.meals, [meal]: k } }; update('eat', e); applySet({ eat: { meals: e.meals, avoid_chains: e.avoidChains, special: e.special } }); }} />)}
                          </Wrap>
                        </View>
                      ))}
                      <Wrap>
                        <Chip label="No chains" selected={ctl.eat.avoidChains === true} onPress={() => { const e = { ...ctl.eat, avoidChains: ctl.eat.avoidChains === true ? null : true }; update('eat', e); applySet({ eat: { meals: e.meals, avoid_chains: e.avoidChains, special: e.special } }); }} />
                        <Chip label="Chains fine" selected={ctl.eat.avoidChains === false} onPress={() => { const e = { ...ctl.eat, avoidChains: ctl.eat.avoidChains === false ? null : false }; update('eat', e); applySet({ eat: { meals: e.meals, avoid_chains: e.avoidChains, special: e.special } }); }} />
                        <Chip label="Somewhere special" selected={ctl.eat.special} onPress={() => { const e = { ...ctl.eat, special: !ctl.eat.special }; update('eat', e); applySet({ eat: { meals: e.meals, avoid_chains: e.avoidChains, special: e.special } }); }} />
                      </Wrap>
                    </View>
                  ) : null}
                  {isEditing && r.key === 'budget' ? (
                    <View style={styles.panel}>
                      <Wrap>{PRICE_POINTS.map((pp) => <Chip key={pp.value} label={pp.label} selected={ctl.budget.pricePoint === pp.value} onPress={() => { const band = bandFor(pp.value, ctl.budget.per, heads); const b = { ...ctl.budget, pricePoint: pp.value, low: band ? band[0] : ctl.budget.low, high: band ? band[1] : ctl.budget.high }; update('budget', b); applySet({ budget: { price_point: b.pricePoint, low: band ? b.low : null, high: band ? b.high : null, per: b.per } }); }} />)}</Wrap>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={type.small}>{ctl.budget.per === 'person' ? 'A head, for the day' : `For the day, all ${heads}`}</Text>
                        <Text style={[type.body, { fontWeight: '700' }]}>£{ctl.budget.low} – £{ctl.budget.high}</Text>
                      </Row>
                      <RangeSlider min={0} max={ctl.budget.per === 'person' ? 200 : 600} step={10} low={ctl.budget.low} high={ctl.budget.high} bars={BUDGET_BARS} onChange={(low, high) => { const b = { ...ctl.budget, low, high, pricePoint: pointFor(high, ctl.budget.per, heads) }; update('budget', b); applySet({ budget: { price_point: b.pricePoint, low, high, per: b.per } }); }} />
                      <Segmented value={ctl.budget.per} options={[{ value: 'everyone', label: 'For everyone' }, { value: 'person', label: 'Per person' }]} onChange={(v) => { const per = v as 'everyone' | 'person'; const k = per === 'person' ? 1 / Math.max(1, heads) : Math.max(1, heads); const b = { ...ctl.budget, per, low: Math.round((ctl.budget.low * k) / 10) * 10, high: Math.round((ctl.budget.high * k) / 10) * 10 }; update('budget', b); applySet({ budget: { price_point: b.pricePoint, low: b.low, high: b.high, per } }); }} />
                      <Text style={type.tiny}>For food, tickets and things to do on the day — not the hotel. A night away asks about the hotel separately on the trip's Stay tab. The bars are the spread of what days like this cost.</Text>
                    </View>
                  ) : null}
                  {isEditing && !isControl ? (
                    <View style={styles.editor}>
                      <TextInput value={editText} onChangeText={setEditText} style={styles.editInput} placeholder={`${r.label}…`} placeholderTextColor={colors.inkFaint} onSubmitEditing={() => send(editText, false, r.key)} accessibilityLabel={`Change ${r.label}`} />
                      <Row>
                        {speech.supported ? <Pressable onPress={() => { fieldRef.current = r.key; speech.start(); }} style={styles.mic} accessibilityRole="button" accessibilityLabel={`Say ${r.label} again`}><Icon name="mic" size={16} color={colors.ink} /><Text style={[type.small, { fontWeight: '600' }]}>Say it again</Text></Pressable> : null}
                        <Button label="Done" onPress={() => send(editText, false, r.key)} disabled={!editText.trim() || !!busy} />
                        <Button label="Cancel" kind="ghost" onPress={() => setEditing(null)} />
                      </Row>
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
              <Button label="Open the trip" icon="trips" onPress={() => onOpenTrip?.(plan.handoff!.tripId, plan.handoff!.section ? { section: plan.handoff!.section } : undefined)} />
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
          {plan.journey && plan.journey.minutes > 20 && !plan.route ? <Text style={type.small}>Getting there: {plan.journey.from} → {plan.journey.to}, about {minutes(plan.journey.minutes)} by {plan.journey.mode} (estimated) — not counted in your time there.</Text> : null}
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

      {/* The journey is part of the day: what is worth stopping for on the way */}
      {plan?.route ? (
        <Card>
          <OnTheWay
            route={plan.route}
            busy={busy === 'updating'}
            onAdd={(s) => act({ type: 'route_add', stopId: s.id })}
            onDrop={(s) => act({ type: 'route_drop', stopId: s.id })}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 10, paddingHorizontal: 6, borderRadius: radius.sm },
  well: { width: 32, height: 32, borderRadius: 4, backgroundColor: colors.well, alignItems: 'center', justifyContent: 'center' },
  panel: { gap: spacing.sm, padding: spacing.md, marginHorizontal: -6, marginBottom: 4, backgroundColor: colors.panel, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line },
  hit: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  h: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.inkMuted },
  rowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  rowCheck: { backgroundColor: colors.panel },
  rowEditing: { backgroundColor: colors.accentSoft },
  rowKey: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.inkMuted },
  travel: { paddingVertical: 10 },
  flag: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.ink, paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill },
  flagText: { fontSize: 11, fontWeight: '700', color: colors.dislike, letterSpacing: 0.2 },
  editor: { gap: spacing.sm, padding: spacing.sm, marginBottom: 4, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.md, backgroundColor: colors.surface },
  editInput: { minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink },
  checks: { borderLeftWidth: 3, borderLeftColor: colors.dislike, gap: spacing.sm },
  check: { gap: 6, paddingTop: 6 },
  num: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  numText: { color: colors.bg, fontSize: 11, fontWeight: '700' },
  mic: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.ink,
  },
  optionsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  toggle: { minHeight: TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm },
  optionCard: { gap: spacing.md },
  optionCardViewing: { borderColor: colors.inkFaint },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.line },
  dotOn: { backgroundColor: colors.accent },
});

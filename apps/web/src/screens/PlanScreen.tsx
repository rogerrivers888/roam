import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { api, ApiError, HouseholdResponse, PlanAction, PlanResponse } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Stepper, Wrap, minutes, clock } from '../components/ui';
import { TimeBar } from '../components/TimeBar';
import { PricePointControl, ChainsControl } from '../components/PlanControls';
import { BrowsePool } from '../components/BrowsePool';
import { speak as speakRaw, useSpeech } from '../hooks/useSpeech';
import { Listening } from '../components/Listening';
import { Icon } from '../components/Icon';
import { getSpeakPref } from './SettingsScreen';

const speak = (text: string) => { if (getSpeakPref()) speakRaw(text); };

type Turn = { role: 'user' | 'assistant'; text: string; voice?: boolean };

const SUGGESTIONS_START = [
  'From home, three hours, at least two things to do and somewhere to eat, everyone is coming',
  'Around home for two hours this afternoon, something relaxed with the kids',
  'From home to the British Museum, four hours, one activity and lunch, walking',
];
const firstName = (n: string) => n.split(' ')[0];

// The Plan tab unmounts when another tab is shown; the session it was in is
// remembered here so coming back shows the same conversation and options.
let remembered: { sessionId: string; turns: Turn[]; viewing: string | null } | null = null;

const MISSING_LABEL: Record<string, string> = {
  origin: 'where from', origin_unknown: "where from (couldn't place it)", duration: 'how long', destination_unknown: "where to (couldn't place it)",
  anchor_place: 'which venue', attending: "who's coming", origin_which: 'which place (from)', destination_which: 'which place (to)',
  stay: 'trip or day out', question: 'one more thing',
};

export function PlanScreen({ household, onOpenTrip }: { household: HouseholdResponse | null; onOpenTrip?: (tripId: string) => void }) {
  const { width } = useViewport();
  const cardWidth = Math.min(width, 760) - spacing.lg * 2;

  const [sessionId, setSessionId] = useState<string | null>(null);
  // Who's coming: everyone until a tick is taken off. Ticking is the same statement as saying the names.
  const [attendingIds, setAttendingIds] = useState<Set<string> | null>(null);
  const [whoOpen, setWhoOpen] = useState(false);
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
  const send = useCallback(async (text: string, viaVoice = false) => {
    const utterance = text.trim();
    if (!utterance || busy) return;
    setError(null);
    setInput('');
    setTurns((t) => [...t, { role: 'user', text: utterance, voice: viaVoice }]);
    setBusy('thinking');
    try {
      const next = plan?.trip
        ? await api.planRefine(sessionId!, utterance, viewing)
        : await api.planStart(utterance, sessionId, null, attendingIds ? [...attendingIds] : null);
      setSessionId(next.sessionId);
      // A question is only ever the latest one: an answered one must not linger.
      setPlan((prev) => ({ ...(prev ?? {} as PlanResponse), ...next, question: next.question ?? null }));
      if (next.reply) {
        setTurns((t) => [...t, { role: 'assistant', text: next.reply! }]);
        if (viaVoice) speak(next.reply);
      }
      if (!viewing && next.options?.[0]) setViewing(next.options[0].id);
      // An overnight stay was set up as a dated trip: carry on in Trips.
      if (next.handoff) onOpenTrip?.(next.handoff.tripId);
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : String(e?.message || e);
      setError(msg);
      if (viaVoice) speak(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, plan?.trip, sessionId, viewing, onOpenTrip, attendingIds]);

  const speech = useSpeech({ onFinal: (text) => send(text, true) });

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

  // While speaking, the page is the transcript and nothing else (owner, 3 Sep 2026).
  if (speech.listening) {
    return (
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Listening
          transcript={speech.transcript}
          hint={hasOptions ? 'Say what you like and what you don\'t about these options.' : undefined}
          onDone={speech.stop}
          onCancel={speech.cancel}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Text style={[type.title, { flex: 1 }]}>Where should we go?</Text>
        {turns.length ? <Button label="Start over" kind="ghost" onPress={reset} /> : null}
      </View>

      {/* The box comes first and is big: a whole spoken paragraph fits in it. Speak and Send sit under it. */}
      <Card style={{ gap: spacing.sm }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          multiline
          placeholder={hasOptions ? 'I like this, but not that…' : 'Where, when, how long, who is coming, and anything you must fit in…'}
          placeholderTextColor={colors.inkFaint}
          style={styles.input}
          editable={!speech.listening}
          accessibilityLabel="What do you want to do"
        />
        <Row style={{ justifyContent: 'space-between' }}>
          {speech.supported ? (
            <Pressable onPress={speech.toggle} style={styles.mic} accessibilityRole="button" accessibilityLabel="Speak">
              <Icon name="mic" size={20} color={colors.ink} />
              <Text style={[type.small, { fontWeight: '600' }]}>Speak</Text>
            </Pressable>
          ) : <View />}
          <Button label="Send" onPress={() => send(input)} disabled={!input.trim() || !!busy} />
        </Row>
        {members.length > 1 ? (
          <View>
            {/* One line: "The family" until someone is left out. Tap to open the ticks. */}
            <Pressable onPress={() => setWhoOpen((o) => !o)} style={styles.whoRow} accessibilityRole="button" accessibilityLabel="Who's coming" accessibilityState={{ expanded: whoOpen }}>
              <Text style={type.tiny}>Who's coming</Text>
              <Text style={[type.small, { fontWeight: '600', color: colors.ink, flex: 1 }]} numberOfLines={1}>
                {!attendingIds || attendingIds.size === members.length ? 'The family' : members.filter((m) => attendingIds.has(m.id)).map((m) => firstName(m.name)).join(', ')}
              </Text>
              <Text style={type.tiny}>{whoOpen ? '▾' : '▸'}</Text>
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
        ) : null}
        {!speech.supported ? <Text style={type.tiny}>Voice input isn't available in this browser — typing does exactly the same thing.</Text> : null}
        {turns.length === 0 ? (
          <Wrap>{SUGGESTIONS_START.map((s) => <Chip key={s} label={s} onPress={() => send(s)} />)}</Wrap>
        ) : null}
      </Card>

      {/* Conversation */}
      {turns.length ? (
        <Card>
          <View style={{ gap: spacing.sm }}>
            {turns.slice(-8).map((t, i) => (
              <View key={i} style={[styles.bubble, t.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant, { flexDirection: 'row', alignItems: 'flex-start', gap: 6 }]}>
                {t.voice ? <View style={{ paddingTop: 3 }}><Icon name="mic" size={14} color={t.role === 'user' ? '#fff' : colors.inkMuted} /></View> : null}
                <Text style={[type.body, { flexShrink: 1 }, t.role === 'user' && { color: '#fff' }]}>{t.text}</Text>
              </View>
            ))}
          </View>
          {busy === 'thinking' ? (
            <Row><ActivityIndicator color={colors.accent} /><Text style={type.small}>Working it out…</Text></Row>
          ) : null}
          {/* The planner asks rather than guesses: each answer can be tapped or said in the same words. */}
          {plan?.question && !busy ? (
            <Wrap>
              {plan.question.choices.map((c) => <Chip key={c.say} label={c.label} tone="accent" onPress={() => send(c.say)} />)}
            </Wrap>
          ) : null}
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
          {speech.error ? <StatusLine tone="warn">{speech.error}</StatusLine> : null}
        </Card>
      ) : null}

      {/* Missing details */}
      {plan && !plan.trip && !plan.question && plan.missing?.length ? (
        <Card>
          <Text style={type.h3}>Still need</Text>
          <Wrap>{plan.missing.map((m) => <Chip key={m} label={MISSING_LABEL[m] ?? m.replace(/_/g, ' ')} tone="accent" />)}</Wrap>
          {/* Every question has a tap answer that sends the same words as saying them. */}
          {plan.missing.includes('origin') && household?.household.home && !plan.question ? (
            <Wrap><Chip label="From home" onPress={() => send('From home')} /></Wrap>
          ) : null}
          {plan.missing.includes('attending') && !plan.question ? (
            <Wrap>
              <Chip label="Yes, everyone" tone="accent" onPress={() => send('Yes, everyone is coming')} />
              {members.map((m) => <Chip key={m.id} label={`Without ${m.name}`} onPress={() => send(`Everyone except ${m.name}`)} />)}
            </Wrap>
          ) : null}
        </Card>
      ) : null}

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
    minHeight: 150, padding: spacing.md, borderRadius: radius.md, textAlignVertical: 'top',
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 16, lineHeight: 22, color: colors.ink,
  },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32, paddingHorizontal: 4 },
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

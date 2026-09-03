import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { api, ApiError, HouseholdResponse, OptionStop, PlanAction, PlanResponse, TripOption } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Stepper, Wrap, minutes, clock } from '../components/ui';
import { TimeBar } from '../components/TimeBar';
import { FaceRow } from '../components/Faces';
import { speak as speakRaw, useSpeech } from '../hooks/useSpeech';
import { getSpeakPref } from './SettingsScreen';

const speak = (text: string) => { if (getSpeakPref()) speakRaw(text); };

type Turn = { role: 'user' | 'assistant'; text: string; voice?: boolean };

const SUGGESTIONS_START = [
  'From home, three hours, at least two things to do and somewhere to eat, everyone is coming',
  'Around home for two hours this afternoon, something relaxed with the kids',
  'From home to the British Museum, four hours, one activity and lunch, walking',
];
const SUGGESTIONS_REFINE = [
  'I like the museum but not the pub',
  'Swap the café for a park',
  'Make it more relaxed',
  'Go with the first plan',
];

const CATEGORY_ICON: Record<string, string> = {
  restaurant: '🍽', cafe: '☕', pub: '🍺', bar: '🍸', attraction: '🏛', event: '🎟',
};

const MISSING_LABEL: Record<string, string> = {
  origin: 'where from', origin_unknown: "where from (couldn't place it)", duration: 'how long', destination_unknown: "where to (couldn't place it)",
  anchor_place: 'which venue', attending: "who's coming",
};

export function PlanScreen({ household }: { household: HouseholdResponse | null }) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(width, 760) - spacing.lg * 2;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<false | 'thinking' | 'updating'>(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [differences, setDifferences] = useState(false);
  const [committed, setCommitted] = useState<string | null>(null);
  const pagerRef = useRef<ScrollView>(null);

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
        : await api.planStart(utterance, sessionId);
      setSessionId(next.sessionId);
      setPlan((prev) => ({ ...(prev ?? {} as PlanResponse), ...next }));
      if (next.reply) {
        setTurns((t) => [...t, { role: 'assistant', text: next.reply! }]);
        if (viaVoice) speak(next.reply);
      }
      if (!viewing && next.options?.[0]) setViewing(next.options[0].id);
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : String(e?.message || e);
      setError(msg);
      if (viaVoice) speak(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, plan?.trip, sessionId, viewing]);

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
    setSessionId(null); setPlan(null); setTurns([]); setViewing(null); setCommitted(null); setError(null);
  };

  const members = household?.members ?? [];
  const attending = useMemo(
    () => new Set((plan?.attending ?? members).map((m) => m.id)),
    [plan?.attending, members],
  );

  // Keep "viewing" in step with the pager so "the first one" means what's on screen.
  const onPagerScroll = (e: any) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / (cardWidth + spacing.md));
    const opt = plan?.options?.[idx];
    if (opt && opt.id !== viewing) setViewing(opt.id);
  };

  useEffect(() => {
    if (plan?.options?.length && !plan.options.some((o) => o.id === viewing)) setViewing(plan.options[0].id);
  }, [plan?.options, viewing]);

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={type.title}>Where should we go?</Text>
          <Text style={type.small}>Say it or type it. React to what comes back the same way.</Text>
        </View>
        {hasOptions ? <Button label="Start over" kind="ghost" onPress={reset} /> : null}
      </View>

      {members.length > 1 ? (
        <Card style={{ gap: spacing.sm }}>
          <Text style={type.h3}>Who's coming</Text>
          <FaceRow members={members} attending={attending} />
          <Text style={type.tiny}>Say "just me and {members.find((m) => m.isMinor)?.name ?? members[1]?.name}" to change who's coming. Allergens of everyone coming exclude places; dislikes only rank them.</Text>
          {!household?.household.home ? <Text style={[type.tiny, { color: colors.dislike }]}>No home address yet — set it in Settings so you can just say "from home".</Text> : null}
        </Card>
      ) : null}

      {/* Conversation */}
      <Card>
        {turns.length === 0 ? (
          <Text style={type.body}>Tell me where you're starting, where you're ending up if it's different, how long you've got, and anything you must fit in.</Text>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {turns.slice(-6).map((t, i) => (
              <View key={i} style={[styles.bubble, t.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant]}>
                <Text style={[type.body, t.role === 'user' && { color: '#fff' }]}>
                  {t.voice ? '🎙 ' : ''}{t.text}
                </Text>
              </View>
            ))}
          </View>
        )}

        {busy === 'thinking' ? (
          <Row><ActivityIndicator color={colors.accent} /><Text style={type.small}>Working it out…</Text></Row>
        ) : null}
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
        {speech.error ? <StatusLine tone="warn">{speech.error}</StatusLine> : null}

        <View style={styles.composer}>
          <TextInput
            value={speech.listening && speech.interim ? speech.interim : input}
            onChangeText={setInput}
            placeholder={speech.listening ? 'Listening…' : hasOptions ? 'I like this, but not that…' : 'Home to the opera house, three hours…'}
            placeholderTextColor={colors.inkFaint}
            style={[styles.input, speech.listening && styles.inputListening]}
            onSubmitEditing={() => send(input)}
            returnKeyType="send"
            editable={!speech.listening}
            accessibilityLabel="What do you want to do"
          />
          {speech.supported ? (
            <Pressable
              onPress={speech.toggle}
              style={[styles.mic, speech.listening && styles.micOn]}
              accessibilityRole="button"
              accessibilityLabel={speech.listening ? 'Stop listening' : 'Speak'}
            >
              <Text style={{ fontSize: 20 }}>{speech.listening ? '■' : '🎙'}</Text>
            </Pressable>
          ) : null}
          <Button label="Send" onPress={() => send(input)} disabled={!input.trim() || !!busy} />
        </View>
        {speech.listening ? <Text style={type.tiny}>Tap ■ when you're done. The recording isn't kept.</Text> : null}
        {!speech.supported ? <Text style={type.tiny}>Voice input isn't available in this browser — typing does exactly the same thing.</Text> : null}

        <Wrap>
          {(hasOptions ? SUGGESTIONS_REFINE : SUGGESTIONS_START).map((s) => (
            <Chip key={s} label={s} onPress={() => send(s)} />
          ))}
        </Wrap>
      </Card>

      {/* Missing details */}
      {plan && !plan.trip && plan.missing?.length ? (
        <Card>
          <Text style={type.h3}>Still need</Text>
          <Wrap>{plan.missing.map((m) => <Chip key={m} label={MISSING_LABEL[m] ?? m.replace(/_/g, ' ')} tone="accent" />)}</Wrap>
          {/* Every question has a tap answer that sends the same words as saying them. */}
          {plan.missing.includes('origin') && household?.household.home ? (
            <Wrap><Chip label="From home" onPress={() => send('From home')} /></Wrap>
          ) : null}
          {plan.missing.includes('attending') ? (
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
          <Text style={[type.small, { marginTop: 4 }]}>How full should the day be?</Text>
          <Segmented
            value={plan.trip.intensity}
            options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'packed', label: 'Packed' }]}
            onChange={(v) => act({ type: 'set', intensity: v })}
          />
        </Card>
      ) : null}

      {/* Options */}
      {hasOptions ? (
        <>
          <View style={styles.optionsHeader}>
            <Text style={type.h2}>{plan!.options.length === 1 ? 'One plan fits' : `${plan!.options.length} ways to do it`}</Text>
            <Pressable onPress={() => setDifferences((d) => !d)} style={styles.toggle} accessibilityRole="switch" accessibilityState={{ checked: differences }}>
              <Text style={[type.small, differences && { color: colors.accent, fontWeight: '700' }]}>Differences</Text>
            </Pressable>
          </View>
          <Text style={type.tiny}>
            Built from the same {plan!.pool?.size ?? '—'} places — changing things here makes no new lookups.
          </Text>

          <ScrollView
            ref={pagerRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={cardWidth + spacing.md}
            decelerationRate="fast"
            onMomentumScrollEnd={onPagerScroll}
            onScrollEndDrag={onPagerScroll}
            contentContainerStyle={{ gap: spacing.md, paddingVertical: spacing.sm }}
            style={{ marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg }}
          >
            {plan!.options.map((option) => (
              <OptionCard
                key={option.id}
                option={option}
                width={cardWidth}
                trip={plan!.trip!}
                pinned={new Set(plan!.selection?.pinned ?? [])}
                differences={differences}
                viewing={viewing === option.id}
                chosen={plan!.selection?.chosenOptionId === option.id}
                committed={committed === option.id}
                busy={busy === 'updating'}
                onAct={act}
                onCommit={() => commit(option.id)}
              />
            ))}
          </ScrollView>

          <Row style={{ justifyContent: 'center' }}>
            {plan!.options.map((o) => (
              <View key={o.id} style={[styles.dot, viewing === o.id && styles.dotOn]} />
            ))}
          </Row>

          {plan!.selection?.excluded?.length ? (
            <Card>
              <Text style={type.h3}>Not for us this time</Text>
              <Wrap>
                {plan!.selection.excluded.map((key) => (
                  <Chip key={key} label={labelFor(key, plan!)} tone="dislike" onRemove={() => act({ type: 'restore', stopId: key })} />
                ))}
              </Wrap>
              <Text style={type.tiny}>Tap ✕ to let a place back in.</Text>
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
              {plan!.spend.session_calls} of {plan!.spend.sessionBound} planning requests used this session · ~${plan!.spend.session_cost_usd.toFixed(3)} · this month ${plan!.spend.month_cost_usd.toFixed(2)}
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

function OptionCard({
  option, width, trip, pinned, differences, viewing, chosen, committed, busy, onAct, onCommit,
}: {
  option: TripOption; width: number; trip: NonNullable<PlanResponse['trip']>;
  pinned: Set<string>; differences: boolean; viewing: boolean; chosen: boolean; committed: boolean; busy: boolean;
  onAct: (a: PlanAction) => void; onCommit: () => void;
}) {
  return (
    <Card style={[styles.optionCard, { width }, viewing && styles.optionCardViewing, chosen && { borderColor: colors.accent }]}>
      <View>
        <Text style={type.h2}>{option.title}</Text>
        <Text style={type.small}>{option.basis}</Text>
      </View>
      <TimeBar budget={option.budget} stops={option.stops} compact />
      <Text style={type.tiny}>
        {option.stops.length} stops · {minutes(option.budget.travelMinutes)} travelling · {option.budget.remainingMinutes >= 0 ? `${minutes(option.budget.remainingMinutes)} free` : `over by ${minutes(-option.budget.remainingMinutes)}`}
      </Text>
      {option.shortfall.activities || option.shortfall.food ? (
        <StatusLine tone="warn">
          Couldn't fit {option.shortfall.activities ? `${option.shortfall.activities} more thing${option.shortfall.activities > 1 ? 's' : ''} to do` : ''}
          {option.shortfall.activities && option.shortfall.food ? ' and ' : ''}
          {option.shortfall.food ? `${option.shortfall.food} more place${option.shortfall.food > 1 ? 's' : ''} to eat` : ''} in the window.
        </StatusLine>
      ) : null}

      <View style={{ gap: spacing.sm }}>
        {option.stops.map((stop) => (
          <StopRow
            key={stop.id}
            stop={stop}
            dim={differences && !stop.uniqueToThisOption}
            pinned={pinned.has(stop.id)}
            busy={busy}
            onLike={() => onAct({ type: pinned.has(stop.id) ? 'unlike' : 'like', stopId: stop.id })}
            onDislike={() => onAct({ type: 'dislike', stopId: stop.id })}
          />
        ))}
      </View>

      <Button
        label={committed ? 'Saved as your trip ✓' : chosen ? 'Use this plan' : 'Use this plan'}
        kind={committed ? 'secondary' : 'primary'}
        onPress={onCommit}
        disabled={busy || committed}
      />
    </Card>
  );
}

function StopRow({ stop, dim, pinned, busy, onLike, onDislike }: {
  stop: OptionStop; dim: boolean; pinned: boolean; busy: boolean; onLike: () => void; onDislike: () => void;
}) {
  return (
    <View style={[styles.stop, dim && { opacity: 0.35 }]}>
      <View style={{ flex: 1, gap: 3 }}>
        <Row>
          <Text style={styles.stopPos}>{stop.position}</Text>
          <Text style={[type.h3, { flex: 1 }]} numberOfLines={2}>
            {stop.fixed ? '📌 ' : CATEGORY_ICON[stop.category] ?? '•'} {stop.name}{stop.fixed ? ' (fixed)' : ''}
          </Text>
        </Row>
        <Text style={type.small}>
          +{stop.travelFromPrevMinutes} min to get there · stay {minutes(stop.dwellMinutes)}
          {stop.startsAt ? ` · ${clock(stop.startsAt)}–${clock(stop.endsAt!)}` : ''}
        </Text>
        {stop.reasons.length ? (
          <Wrap>
            {stop.reasons.slice(0, 3).map((r, i) => (
              <Chip key={i} label={r.text} tone={r.kind === 'dislike' ? 'dislike' : r.kind === 'want' ? 'want' : 'like'} icon={r.kind === 'favourite' ? '★' : undefined} />
            ))}
          </Wrap>
        ) : null}
        {stop.justification ? <Text style={type.tiny}>"{stop.justification}"</Text> : null}
      </View>
      <View style={{ gap: 6 }}>
        <Pressable onPress={onLike} disabled={busy} style={[styles.reactBtn, pinned && styles.reactBtnOn]} accessibilityRole="button" accessibilityLabel={pinned ? `Stop keeping ${stop.name}` : `Keep ${stop.name}`}>
          <Text style={[styles.reactText, pinned && { color: '#fff' }]}>{pinned ? '♥ Keeping' : '♡ Keep'}</Text>
        </Pressable>
        <Pressable onPress={onDislike} disabled={busy} style={styles.reactBtn} accessibilityRole="button" accessibilityLabel={`Not ${stop.name}`}>
          <Text style={styles.reactText}>✕ Not this</Text>
        </Pressable>
      </View>
    </View>
  );
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
  composer: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    flex: 1, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  inputListening: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  mic: {
    width: TARGET, height: TARGET, borderRadius: TARGET / 2, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line,
  },
  micOn: { backgroundColor: colors.overrunSoft, borderColor: colors.overrun },
  optionsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  toggle: { minHeight: TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm },
  optionCard: { gap: spacing.md },
  optionCardViewing: { borderColor: colors.inkFaint },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.line },
  dotOn: { backgroundColor: colors.accent },
  stop: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  stopPos: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.dwell, color: '#fff',
    textAlign: 'center', lineHeight: 22, fontSize: 12, fontWeight: '700', overflow: 'hidden',
  },
  reactBtn: {
    minHeight: 40, minWidth: 96, paddingHorizontal: 10, borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center',
  },
  reactBtnOn: { backgroundColor: colors.like },
  reactText: { fontSize: 13, fontWeight: '700', color: colors.ink },
});

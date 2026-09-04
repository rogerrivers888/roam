import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, IdeaBudget, Idea, IdeaThing, Taste, TasteTable } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, StatusLine, Wrap, minutes } from './ui';
import { Icon } from './Icon';
import { TasteTables } from './TasteTables';
import type { OpenTripOptions } from '../screens/PlanScreen';

/**
 * In the mood for, as a trail rather than a list (owner, 4 Sep 2026: "can this
 * not be a bit more like a sort of breadcrumb trail? If I select fun, it could
 * be outdoor / indoor / don't care, intense or not intense… intense and
 * relaxing shouldn't be in the same list because I could select both of them,
 * which would be confusing").
 *
 * Three questions, one answer each, so the day cannot contradict itself: what
 * it is about, whether it is outside, and how hard it goes. Every question has
 * "Don't mind", and Inspire me works at any point in the trail — it is a trail,
 * not a form to complete. The labels the model is told are the old mood words,
 * so nothing behind this screen has to change.
 */
type StepKey = 'about' | 'where' | 'pace';
const STEPS: { key: StepKey; question: string; options: { label: string; mood: string | null }[] }[] = [
  {
    key: 'about',
    question: "What's the day about?",
    options: [
      { label: 'Fun', mood: 'Fun' },
      { label: 'Food', mood: 'Food-focused' },
      { label: 'Culture', mood: 'Educational' },
      { label: 'Somewhere new', mood: 'Somewhere new' },
      { label: "Don't mind", mood: null },
    ],
  },
  {
    key: 'where',
    question: 'Indoors or out?',
    options: [
      { label: 'Outdoors', mood: 'Outdoors' },
      { label: 'Indoors', mood: 'Indoors' },
      { label: "Don't mind", mood: null },
    ],
  },
  {
    key: 'pace',
    question: 'How full-on?',
    options: [
      { label: 'Full-on', mood: 'Intensive' },
      { label: 'Gentle', mood: 'Relaxing' },
      { label: "Don't mind", mood: null },
    ],
  },
];
const CAPS: { label: string; value: number | null }[] = [{ label: '1 h', value: 60 }, { label: '2 h', value: 120 }, { label: '3 h', value: 180 }, { label: 'Anywhere', value: null }];
/** Find looks the same distance around the place as the ideas did, so the trip opens on what was already fetched. */
const THINGS_RADIUS_KM = 5;
// How much the day should cost (owner, 3 Sep 2026): told to the model, and a
// free day opens the trip's Find tab on the places that are free to enter.
const BUDGETS: { value: IdeaBudget; label: string }[] = [
  { value: 'any', label: 'Any' }, { value: 'free', label: 'Free things' }, { value: 'cheap', label: 'Cheap and cheerful' }, { value: 'mid', label: 'Middling' }, { value: 'treat', label: 'A treat' },
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// What is there, in a few words: kinds of thing first, then where to eat.
const KIND_LABELS: [string, string][] = [
  ['museum', 'museums'], ['art-gallery', 'galleries'], ['park', 'parks'], ['history', 'landmarks'], ['market', 'markets'], ['viewpoint', 'views'],
  ['zoo', 'zoos'], ['aquarium', 'aquariums'], ['theme-park', 'theme parks'], ['walk', 'walks'], ['beach', 'beaches'], ['playground', 'playgrounds'],
  ['theatre', 'theatres'], ['cinema', 'cinemas'], ['shopping', 'shops'], ['bookshop', 'bookshops'], ['swimming', 'swimming'], ['bowling', 'bowling'],
  ['ice-skating', 'ice rinks'], ['climbing', 'climbing'], ['boat-trip', 'boat trips'], ['sports-game', 'stadiums'],
];
const EAT_LABELS: Record<string, string> = { restaurant: 'restaurants', cafe: 'cafés', pub: 'pubs', bar: 'bars' };
function summarise(things: IdeaThing[]): string {
  const kinds = new Map<string, number>();
  const eats = new Map<string, number>();
  let other = 0;
  for (const t of things) {
    if (t.kind === 'eat') { eats.set(t.category, (eats.get(t.category) ?? 0) + 1); continue; }
    const k = KIND_LABELS.find(([key]) => t.experiences.includes(key));
    if (k) kinds.set(k[1], (kinds.get(k[1]) ?? 0) + 1); else other += 1;
  }
  const top = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => `${n} ${l}`);
  if (other && top.length < 5) top.push(`${other} other sight${other === 1 ? '' : 's'}`);
  const eat = [...eats.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${EAT_LABELS[c] ?? c}`);
  return [top.join(', '), eat.join(', ')].filter(Boolean).join(' · ');
}

type Things = { status: 'loading' | 'ready' | 'error'; items: IdeaThing[] };

/**
 * Inspire me: a loose brief (typed or spoken), a mood or two, a travel cap →
 * ideas that say why. As the ideas land, Roam looks around each one in the
 * background and says what is there. "Things to do and see" opens the idea as
 * a day out in Trips — the Find tab already filled, what Roam named on the
 * shortlist — and "Plan this" hands the idea to the rows instead.
 */
export function InspireMe({ query, setQuery, attendingIds, who, whoLabel = 'The family', onPlan, onOpenTrip, listening, transcript, supported, onSpeak, onStop }: {
  query: string; setQuery: (q: string) => void;
  attendingIds: string[] | null;
  /** The ticks, shown when the one-line row is opened. */
  who: React.ReactNode;
  /** Who is coming, in a few words, for that line. */
  whoLabel?: string;
  onPlan: (utterance: string) => void;
  onOpenTrip?: (tripId: string, opts?: OpenTripOptions) => void;
  listening: boolean; transcript: string; supported: boolean; onSpeak: () => void; onStop: () => void;
}) {
  // One answer per question, and which question is open. Nothing is answered to
  // begin with, so the first question is the only thing on screen.
  const [picks, setPicks] = useState<Partial<Record<StepKey, string>>>({});
  const [editing, setEditing] = useState<StepKey | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The defaults are the answer most days want, on one line, so they need no
  // attention (owner, 4 Sep 2026): an hour from home, any budget, everyone.
  const [cap, setCap] = useState<number | null>(60);
  const [budget, setBudget] = useState<IdeaBudget>('any');
  const moods = useMemo(
    () => STEPS.map((step) => step.options.find((o) => o.label === picks[step.key])?.mood).filter((m): m is string => Boolean(m)),
    [picks],
  );
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [things, setThings] = useState<Record<string, Things>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, { tripId: string; title: string; seeded: string[] }>>({});
  // The family's table runs beside the ideas and lands first: it is a search,
  // not a model call (owner, 4 Sep 2026).
  const [tasteSession, setTasteSession] = useState<string | null>(null);
  const [tastes, setTastes] = useState<Taste[]>([]);
  const [tables, setTables] = useState<TasteTable[]>([]);
  const [tablesRunning, setTablesRunning] = useState(false);
  const [tastesNote, setTastesNote] = useState<string | null>(null);
  const [tastesError, setTastesError] = useState<string | null>(null);
  const [tastesCap, setTastesCap] = useState<{ minutes: number | null; said: boolean }>({ minutes: null, said: false });
  const run = useRef(0);
  const tasteRun = useRef(0);

  /**
   * The tables: one search per food the people coming love, polled until the
   * last one lands. Nothing here waits on the model, so "Best arrabbiata" is
   * on screen while the ideas are still being thought about.
   */
  const findTables = async () => {
    const id = ++tasteRun.current;
    setTastes([]); setTables([]); setTasteSession(null); setTastesNote(null); setTastesError(null); setTablesRunning(true);
    try {
      const started = await api.tastes({ brief: query, moods: [...moods], maxTravelMinutes: cap, budget, attendingMemberIds: attendingIds });
      if (tasteRun.current !== id) return;
      setTasteSession(started.sessionId); setTastes(started.tastes); setTables(started.tables); setTastesNote(started.note);
      setTastesCap({ minutes: started.capMinutes ?? cap, said: Boolean(started.capFromWords) });
      if (!started.running) { setTablesRunning(false); return; }
      for (;;) {
        await wait(2000);
        if (tasteRun.current !== id) return;
        let s: Awaited<ReturnType<typeof api.tastesStatus>> | null = null;
        try { s = await api.tastesStatus(started.sessionId); } catch { /* a dropped poll is harmless */ }
        if (!s) continue;
        setTastes(s.tastes); setTables(s.tables); setTastesNote(s.note); setTastesError(s.error);
        if (!s.running) { setTablesRunning(false); return; }
      }
    } catch (e: any) {
      if (tasteRun.current === id) { setTastesError(e?.message || String(e)); setTablesRunning(false); }
    }
  };

  // Inspire me runs on the server in the background: the request is retried
  // through a redeploy, then the session is polled until the ideas are on it,
  // so a slow model call or a restart mid-way never ends in "Failed to fetch".
  // The tables are started first and land long before it.
  const inspire = async () => {
    setBusy(true); setError(null);
    findTables();
    try {
      let started: { sessionId: string } | null = null;
      for (let attempt = 0; attempt < 4 && !started; attempt += 1) {
        try { started = await api.inspire({ query, moods: [...moods], maxTravelMinutes: cap, budget, attendingMemberIds: attendingIds }); }
        catch (e: any) { if (attempt === 3 || !/fetch|network/i.test(String(e?.message))) throw e; await wait(5000); }
      }
      const startedAt = Date.now();
      for (;;) {
        await wait(2500);
        let s: Awaited<ReturnType<typeof api.inspireStatus>> | null = null;
        try { s = await api.inspireStatus(started!.sessionId); } catch { /* a dropped poll is harmless; the next one asks again */ }
        if (!s) { if (Date.now() - startedAt > 4 * 60_000) throw new Error('Roam has not answered for four minutes — try Inspire me again in a moment.'); continue; }
        if (s.error) throw new Error(s.error);
        if (!s.running && s.ideas) { setIdeas(s.ideas); setReply(s.reply); setSessionId(s.sessionId); setThings({}); setOpened({}); break; }
      }
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  };

  // Look around every idea as soon as they land, one after another, so a tap
  // on any of them is a read: the API keeps what it found for hours.
  useEffect(() => {
    if (!ideas) return;
    const id = ++run.current;
    (async () => {
      for (const idea of ideas) {
        if (!idea.place || run.current !== id) continue;
        setThings((s) => ({ ...s, [idea.id]: { status: 'loading', items: [] } }));
        try {
          const r = await api.inspireThings({ lat: idea.place.lat, lng: idea.place.lng, label: idea.place.label, locality: idea.place.locality ?? undefined });
          if (run.current === id) setThings((s) => ({ ...s, [idea.id]: { status: 'ready', items: r.items } }));
        } catch {
          if (run.current === id) setThings((s) => ({ ...s, [idea.id]: { status: 'error', items: [] } }));
        }
      }
    })();
  }, [ideas]);

  // The trip opens on Find at the look-around's radius; a free day starts on the places that are free to enter.
  const openOpts = (): OpenTripOptions => ({ section: 'find', findRadiusKm: THINGS_RADIUS_KM, findPrices: budget === 'free' ? ['Free to enter'] : undefined });

  // The idea becomes a day out in Trips; a second tap opens the same day.
  const openTrip = async (idea: Idea) => {
    if (!sessionId || opening) return;
    const already = opened[idea.id];
    if (already) { onOpenTrip?.(already.tripId, openOpts()); return; }
    setOpening(idea.id); setError(null);
    try {
      const r = await api.inspireTrip({ sessionId, ideaId: idea.id, attendingMemberIds: attendingIds });
      setOpened((s) => ({ ...s, [idea.id]: { tripId: r.tripId, title: r.title, seeded: r.seeded } }));
      onOpenTrip?.(r.tripId, openOpts());
    } catch (e: any) { setError(e?.message || String(e)); } finally { setOpening(null); }
  };

  // The whole idea as one sentence the rows understand.
  const planIdea = (idea: Idea) => {
    const parts = [
      `From home to ${idea.place?.label ?? idea.placeText}.`,
      idea.overnight ? 'Stay one night.' : '',
      idea.do.length ? `We want to do: ${idea.do.join(', ')}.` : '',
      idea.eat.length ? `${idea.eat.join(', ')}.` : '',
      cap ? `No more than ${minutes(cap)} away.` : '',
    ].filter(Boolean);
    onPlan(parts.join(' '));
  };

  // The questions already answered, and the one to ask next — or the one a
  // tapped crumb has reopened.
  const answered = STEPS.filter((step) => picks[step.key]);
  const nextUnanswered = STEPS.find((step) => !picks[step.key]) ?? null;
  const openStep = editing ? STEPS.find((step) => step.key === editing) ?? null : nextUnanswered;
  const budgetLabel = budget === 'any' ? 'any budget' : (BUDGETS.find((b) => b.value === budget)?.label ?? 'any budget').toLowerCase();

  const summaries = useMemo(() => Object.fromEntries(Object.entries(things).map(([id, t]) => [id, t.status === 'ready' ? summarise(t.items) : ''])), [things]);

  return (
    <>
      <Card style={{ gap: spacing.sm }}>
        <TextInput
          value={listening ? transcript : query}
          onChangeText={setQuery}
          multiline
          editable={!listening}
          placeholder="Somewhere fun within an hour, with climbing…"
          placeholderTextColor={colors.inkFaint}
          style={[styles.box, listening && styles.boxLive]}
          accessibilityLabel="What are you in the mood for"
        />
        <Row style={{ justifyContent: 'space-between' }}>
          {listening ? (
            <Pressable onPress={onStop} style={styles.stop} accessibilityRole="button" accessibilityLabel="Stop"><Icon name="stop" size={14} color={colors.bg} /><Text style={styles.stopText}>Stop</Text></Pressable>
          ) : supported ? (
            <Pressable onPress={onSpeak} style={styles.mic} accessibilityRole="button" accessibilityLabel="Speak"><Icon name="mic" size={18} color={colors.ink} /><Text style={[type.small, { fontWeight: '600' }]}>Speak</Text></Pressable>
          ) : <View />}
          {!listening ? <Button label={busy ? 'Thinking…' : 'Inspire me'} icon="plan" onPress={inspire} disabled={busy} /> : null}
        </Row>
        {/* In the mood for: the answers so far as a trail, then the next question. */}
        <View style={{ gap: 8 }}>
          <Text style={type.tiny}>IN THE MOOD FOR</Text>
          {answered.length ? (
            <Row style={{ flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              {answered.map((step, i) => (
                <React.Fragment key={step.key}>
                  {i ? <Icon name="more" size={12} color={colors.inkFaint} /> : null}
                  <Chip label={picks[step.key]!} selected={editing !== step.key} icon="check" onPress={() => setEditing(editing === step.key ? null : step.key)} />
                </React.Fragment>
              ))}
              {answered.length ? <Chip label="Start again" icon="close" onPress={() => { setPicks({}); setEditing(null); }} /> : null}
            </Row>
          ) : null}
          {openStep ? (
            <View style={{ gap: 6 }}>
              <Text style={type.small}>{openStep.question}</Text>
              <Wrap>
                {openStep.options.map((o) => (
                  <Chip
                    key={o.label}
                    label={o.label}
                    selected={picks[openStep.key] === o.label}
                    onPress={() => { setPicks((p) => ({ ...p, [openStep.key]: o.label })); setEditing(null); }}
                  />
                ))}
              </Wrap>
            </View>
          ) : null}
        </View>

        {/* Everything else on one line, because most days want the same answer. */}
        <View style={styles.settings}>
          <Pressable onPress={() => setSettingsOpen((o) => !o)} style={styles.settingsRow} accessibilityRole="button" accessibilityState={{ expanded: settingsOpen }} accessibilityLabel={`${whoLabel}, within ${cap ? minutes(cap) : 'any distance'}, ${budgetLabel}. Tap to change`}>
            <Text style={[type.small, { flex: 1 }]} numberOfLines={1}>
              <Text style={{ fontWeight: '600', color: colors.ink }}>{whoLabel}</Text>
              {cap ? ` · within ${minutes(cap)}` : ' · anywhere'}
              {` · ${budgetLabel}`}
            </Text>
            <Icon name={settingsOpen ? 'expand' : 'more'} size={14} color={colors.inkMuted} />
          </Pressable>
          {settingsOpen ? (
            <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
              {who}
              <Row style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <Text style={type.tiny}>Up to</Text>
                {CAPS.map((c) => <Chip key={c.label} label={c.label} selected={cap === c.value} onPress={() => setCap(c.value)} />)}
                <Text style={type.tiny}>from home</Text>
              </Row>
              <Row style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <Text style={type.tiny}>Budget</Text>
                {BUDGETS.map((b) => <Chip key={b.value} label={b.label} selected={budget === b.value} icon={budget === b.value && b.value !== 'any' ? 'check' : undefined} onPress={() => setBudget(b.value)} />)}
              </Row>
            </View>
          ) : null}
        </View>
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      </Card>

      <TasteTables
        sessionId={tasteSession} tastes={tastes} tables={tables} running={tablesRunning}
        note={tastesNote} error={tastesError} capMinutes={tastesCap.minutes} capFromWords={tastesCap.said}
        attendingIds={attendingIds} onOpenTrip={onOpenTrip}
      />

      {busy ? <Row><ActivityIndicator color={colors.accent} /><Text style={type.small}>Looking through your atlas and what's around…</Text></Row> : null}

      {ideas ? (
        <Card>
          {reply ? <Text style={type.small}>{reply}</Text> : null}
          {ideas.length === 0 ? <Text style={type.small}>Nothing came to mind for that — try \u2018Don\u2019t mind\u2019 on one of the questions, or a wider distance.</Text> : null}
          {ideas.map((idea) => {
            const t = things[idea.id];
            const done = opened[idea.id];
            const isOpening = opening === idea.id;
            return (
              <View key={idea.id} style={styles.idea}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={type.h3}>{idea.title}</Text>
                  <Text style={type.small}>{idea.travelMinutes != null ? `${minutes(idea.travelMinutes)} by car · ` : ''}{idea.why}</Text>
                  {idea.do.length || idea.eat.length ? <Text style={type.tiny}>{[...idea.do, ...idea.eat].slice(0, 4).join(' · ')}</Text> : null}
                  {!idea.place ? <Text style={type.tiny}>Roam couldn't pin this one on the map, so there is no list to browse — Plan this still works from the idea itself.</Text>
                    : t?.status === 'ready' ? <Text style={type.tiny}>{t.items.length ? `What's there: ${summaries[idea.id]}` : 'Nothing found around it yet — the sources may be off.'}</Text>
                    : t?.status === 'error' ? <Text style={type.tiny}>Couldn't look around it just now; Things to do and see will try again.</Text>
                    : <Row style={{ gap: 6 }}><ActivityIndicator size="small" color={colors.accent} /><Text style={type.tiny}>Looking around {idea.placeText.split(',')[0]}…</Text></Row>}
                  <Row style={{ marginTop: 4, flexWrap: 'wrap' }}>
                    {idea.place ? <Chip label={isOpening ? 'Setting up the day…' : done ? 'Open in Trips' : 'Things to do and see'} icon={done ? 'trips' : 'more'} tone="accent" onPress={() => openTrip(idea)} /> : null}
                    <Chip label="Plan this" onPress={() => planIdea(idea)} />
                  </Row>
                  {done ? <Text style={type.tiny}>{done.title} is in Trips{done.seeded.length ? ` with ${done.seeded.join(', ')} on the shortlist` : ''}.</Text> : null}
                </View>
              </View>
            );
          })}
          <Text style={type.tiny}>Ideas come from your atlas first, then the sources. Things to do and see opens the day in Trips with everything around it to browse; Plan this fills the rows instead. Nothing is booked.</Text>
        </Card>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  box: { minHeight: 64, padding: spacing.md, borderRadius: radius.md, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 16, lineHeight: 22, color: colors.ink },
  boxLive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  mic: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.ink },
  stop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: TARGET, paddingHorizontal: spacing.lg, borderRadius: radius.pill, backgroundColor: colors.overrun },
  stopText: { color: colors.bg, fontWeight: '700', fontSize: 15 },
  idea: { paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', gap: spacing.sm },
  settings: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm },
  settingsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32 },
});

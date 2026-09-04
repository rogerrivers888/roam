import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, IdeaBudget, Idea, IdeaHeadline, IdeaThing, InspireStage, Taste, TasteTable } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, StatusLine, Wrap, minutes } from './ui';
import { Icon, CategoryIcon, Rating } from './Icon';
import { VenuePhoto } from './VenuePhoto';
import { TasteTables } from './TasteTables';
import type { OpenTripOptions } from '../screens/PlanScreen';
import { howLongAgo, recallScreen, rememberScreen } from '../screenState';

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
/**
 * How many ideas are looked around at once (owner, 4 Sep 2026: "it loaded 1,
 * and then about a minute later, it loaded the second 1, which is very, very
 * slow").
 *
 * The pictures were never the slow part — they are 240px thumbnails. The
 * look-around was: one idea at a time, each a place search of several seconds,
 * so the fifth idea's picture arrived five searches later. They are independent
 * questions about different towns, so they are asked together, and a normal set
 * of ideas is therefore one round rather than six. Six and not unbounded because
 * each of these can turn into two provider searches behind the API, and there is
 * no reason to let a long list arrive as a stampede.
 */
const LOOKS_AT_ONCE = 6;

/** Find looks the same distance around the place as the ideas did, so the trip opens on what was already fetched. */
const THINGS_RADIUS_KM = 5;
// How much the day should cost (owner, 3 Sep 2026): told to the model, and a
// free day opens the trip's Find tab on the places that are free to enter.
const BUDGETS: { value: IdeaBudget; label: string }[] = [
  { value: 'any', label: 'Any' }, { value: 'free', label: 'Free things' }, { value: 'cheap', label: 'Cheap and cheerful' }, { value: 'mid', label: 'Middling' }, { value: 'treat', label: 'A treat' },
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Things = { status: 'loading' | 'ready' | 'error'; items: IdeaThing[]; headline?: IdeaHeadline | null };

/**
 * What is worth remembering when you leave this tab (owner, 4 Sep 2026).
 *
 * The brief, the trail and the two session identifiers — and nothing else. The
 * ideas themselves stay on the server where they already were; coming back
 * fetches them from the session, which costs nothing and asks no provider.
 * Keeping only the identifier is what lets the screen say honestly how old the
 * answer is.
 */
type InspireMemory = {
  picks: Partial<Record<StepKey, string>>;
  cap: number | null;
  budget: IdeaBudget;
  query: string;
  sessionId: string | null;
  tasteSession: string | null;
  /** When the ideas on screen were actually found — not when the screen was last saved. */
  foundAt: string | null;
};

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
  // Where this screen was when it was last left. Read once, before the first
  // render, so a return to the tab does not flash an empty form and then fill it.
  const held = useRef(recallScreen<InspireMemory>('inspire')).current;
  const [picks, setPicks] = useState<Partial<Record<StepKey, string>>>(held?.data.picks ?? {});
  const [editing, setEditing] = useState<StepKey | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The defaults are the answer most days want, on one line, so they need no
  // attention (owner, 4 Sep 2026): an hour from home, any budget, everyone.
  const [cap, setCap] = useState<number | null>(held?.data.cap ?? 60);
  const [budget, setBudget] = useState<IdeaBudget>(held?.data.budget ?? 'any');
  // When the ideas on screen were found, so the screen can offer a refresh
  // rather than pretending they are new.
  const [foundAt, setFoundAt] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(Boolean(held?.data.sessionId));
  const moods = useMemo(
    () => STEPS.map((step) => step.options.find((o) => o.label === picks[step.key])?.mood).filter((m): m is string => Boolean(m)),
    [picks],
  );
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What the run is doing and how long it has been doing it, so a slow answer
  // is a progress line rather than a spinner (owner, 4 Sep 2026).
  const [stage, setStage] = useState<InspireStage | null>(null);
  const [runRef, setRunRef] = useState<string | null>(null);
  const [placed, setPlaced] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [things, setThings] = useState<Record<string, Things>>({});
  // What has already been looked around, readable without making the effect
  // below depend on it — depending on it would restart the very loop that fills it.
  const thingsRef = useRef<Record<string, Things>>({});
  const putThings = (next: Record<string, Things>) => { thingsRef.current = next; setThings(next); };
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
  // The poll's own counter: the look-around effect below bumps `run` as soon
  // as ideas land, which would otherwise stop the polling that fetched them.
  const inspireRun = useRef(0);

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
  /**
   * Watch a run until it stops, putting whatever it has so far on screen. Split
   * out from starting one so that coming back to the tab can rejoin a run that
   * is still thinking, rather than either starting a second one or showing
   * nothing at all.
   */
  const watchRun = async (id: number, ofSession: string, ref: string | null, startedAt: number) => {
    for (;;) {
      await wait(2000);
      if (inspireRun.current !== id) return;
      let s: Awaited<ReturnType<typeof api.inspireStatus>> | null = null;
      try { s = await api.inspireStatus(ofSession); } catch { /* a dropped poll is harmless; the next one asks again */ }
      if (!s) {
        if (Date.now() - startedAt > 100_000) throw new Error(`Roam has not answered for over a minute and a half. Try Inspire me again${ref ? ` — quote run ${ref} if it keeps happening` : ''}.`);
        continue;
      }
      // Whatever it has so far goes on screen now: the titles arrive before
      // the pins do, and the pins arrive one at a time.
      if (s.ideas) { setIdeas(s.ideas); setReply(s.reply); setFoundAt(new Date().toISOString()); }
      setStage(s.stage); setPlaced(s.placed ?? 0);
      if (s.error) throw new Error(`${s.error}${ref ? ` (run ${ref})` : ''}`);
      if (!s.running) break;
    }
  };

  // Inspire me runs on the server in the background: the request is retried
  // through a redeploy, then the session is polled until the ideas are on it,
  // so a slow model call or a restart mid-way never ends in "Failed to fetch".
  // The tables are started first and land long before it.
  const inspire = async () => {
    const id = ++inspireRun.current;
    setBusy(true); setError(null); setIdeas(null); setStage('thinking'); setPlaced(0); setElapsed(0); setRunRef(null); putThings({}); setOpened({}); setFoundAt(null); setRestoring(false);
    findTables();
    const startedAt = Date.now();
    const ticking = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    try {
      let started: Awaited<ReturnType<typeof api.inspire>> | null = null;
      for (let attempt = 0; attempt < 4 && !started; attempt += 1) {
        try { started = await api.inspire({ query, moods: [...moods], maxTravelMinutes: cap, budget, attendingMemberIds: attendingIds }); }
        catch (e: any) { if (attempt === 3 || !/fetch|network/i.test(String(e?.message))) throw e; await wait(5000); }
      }
      if (inspireRun.current !== id) return;
      setRunRef(started!.ref); setSessionId(started!.sessionId);
      await watchRun(id, started!.sessionId, started!.ref, startedAt);
    } catch (e: any) {
      if (inspireRun.current === id) setError(e?.message || String(e));
    } finally {
      clearInterval(ticking);
      if (inspireRun.current === id) { setBusy(false); setStage(null); }
    }
  };

  /**
   * Come back to what was here (owner, 4 Sep 2026: "everything's disappeared").
   *
   * The ideas were never lost — they are on the planning session for twelve
   * hours. This asks the session for them again, which is a read of our own
   * database and costs nothing. A run still thinking is rejoined; a session the
   * server has since let go is forgotten, so the screen starts clean rather
   * than showing an error nobody can act on.
   */
  /**
   * An idea from a session, made safe to render.
   *
   * Restoring means showing something written by whatever build was running
   * when the run happened — this morning's, or the one before the deploy at
   * lunchtime. A field this screen expects and an older session does not carry
   * used to be a white screen. It is a missing chip now.
   */
  const usableIdea = (i: any): Idea | null => (i && typeof i.id === 'string' && typeof i.title === 'string' ? {
    id: i.id, title: i.title, why: i.why ?? '', placeText: i.placeText ?? '', place: i.place ?? null,
    travelMinutes: i.travelMinutes ?? null, distanceKm: i.distanceKm ?? null, overnight: Boolean(i.overnight),
    do: Array.isArray(i.do) ? i.do : [], eat: Array.isArray(i.eat) ? i.eat : [], placing: Boolean(i.placing),
  } : null);

  const restore = async (memory: InspireMemory, savedAt: string) => {
    const id = ++inspireRun.current;
    try {
      if (memory.tasteSession) void rejoinTables(memory.tasteSession);
      if (!memory.sessionId) return;
      const s = await api.inspireStatus(memory.sessionId);
      if (inspireRun.current !== id) return;
      setSessionId(memory.sessionId);
      setRunRef(s.ref ?? null);
      const kept = (s.ideas ?? []).map(usableIdea).filter((i): i is Idea => Boolean(i));
      // When the ideas were found, not when the screen was last put away: the
      // session knows, and its answer survives the tab being opened and closed
      // all afternoon.
      if (kept.length) { setIdeas(kept); setReply(s.reply); setFoundAt(s.startedAt ?? memory.foundAt ?? savedAt); }
      if (s.running) {
        setBusy(true); setStage(s.stage ?? 'thinking');
        const startedAt = s.startedAt ? new Date(s.startedAt).getTime() : Date.now();
        const ticking = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
        try { await watchRun(id, memory.sessionId, s.ref ?? null, startedAt); }
        finally { clearInterval(ticking); if (inspireRun.current === id) { setBusy(false); setStage(null); } }
      }
    } catch {
      // Expired, or from a household that has since been deleted. Nothing to say.
      rememberScreen('inspire', null);
      if (inspireRun.current === id) { setIdeas(null); setSessionId(null); }
    } finally {
      if (inspireRun.current === id) setRestoring(false);
    }
  };

  /** The tables, from the session they were found in, without searching again. */
  const rejoinTables = async (ofSession: string) => {
    const id = ++tasteRun.current;
    try {
      const s = await api.tastesStatus(ofSession);
      if (tasteRun.current !== id) return;
      setTasteSession(ofSession);
      setTastes(s.tastes); setTables(s.tables); setTastesNote(s.note); setTastesError(s.error);
      setTablesRunning(Boolean(s.running));
      while (s.running) {
        await wait(2000);
        if (tasteRun.current !== id) return;
        let next: Awaited<ReturnType<typeof api.tastesStatus>> | null = null;
        try { next = await api.tastesStatus(ofSession); } catch { continue; }
        setTastes(next.tastes); setTables(next.tables); setTastesNote(next.note); setTastesError(next.error);
        if (!next.running) { setTablesRunning(false); return; }
      }
    } catch { /* the tables are a bonus; a lost session simply leaves them off */ }
  };

  // Put the screen back where it was, once, on the way in.
  useEffect(() => {
    if (held) { void restore(held.data, held.savedAt); if (held.data.query && !query) setQuery(held.data.query); }
    else setRestoring(false);
    // Deliberately once: this is the return to the tab, not a reaction to state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // And remember it as it changes, so leaving mid-thought loses nothing.
  useEffect(() => {
    rememberScreen<InspireMemory>('inspire', { picks, cap, budget, query, sessionId, tasteSession, foundAt });
  }, [picks, cap, budget, query, sessionId, tasteSession, foundAt]);

  /** Stop waiting. The run carries on server-side; its number still finds it. */
  const stopWaiting = () => { inspireRun.current += 1; setBusy(false); setStage(null); };

  // Look around every idea as soon as they land, one after another, so a tap
  // on any of them is a read: the API keeps what it found for hours.
  useEffect(() => {
    // Not while the run is still going: the ideas arrive again with each pin,
    // and this loop would start over every time.
    if (!ideas || busy) return;
    const id = ++run.current;
    // Only the ideas that have not been looked around yet. The ideas arrive as
    // a new array whenever anything about them is set, and this effect used to
    // start the whole look-around again each time — five places became fifteen
    // searches, at the provider's price (owner, 4 Sep 2026).
    const queue = ideas.filter((i) => i.place && !thingsRef.current[i.id]);
    if (!queue.length) return;
    // Every idea says it is looking straight away, rather than each one waiting
    // its turn to admit it has not started.
    const starting = { ...thingsRef.current };
    for (const idea of queue) starting[idea.id] = { status: 'loading', items: [] };
    putThings(starting);
    (async () => {
      let cursor = 0;
      const look = async () => {
        for (;;) {
          const at = cursor;
          cursor += 1;
          if (at >= queue.length || run.current !== id) return;
          const idea = queue[at];
          try {
            // The name to look the place up by is the one the idea used — the map
            // often answers "London" for the National Gallery, and no picture of
            // London is a picture of the National Gallery.
            const r = await api.inspireThings({ lat: idea.place!.lat, lng: idea.place!.lng, label: idea.placeText.split(',')[0].trim() || idea.place!.label, locality: idea.place!.locality ?? undefined });
            if (run.current === id) putThings({ ...thingsRef.current, [idea.id]: { status: 'ready', items: r.items, headline: r.headline } });
          } catch {
            // The entry stays, marked failed: without it the next render would
            // queue the same failing look-around again, and again.
            if (run.current === id) putThings({ ...thingsRef.current, [idea.id]: { status: 'error', items: [] } });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(LOOKS_AT_ONCE, queue.length) }, look));
    })();
  }, [ideas, busy]);

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

      {busy ? (
        <Row style={{ alignItems: 'center', gap: spacing.sm }}>
          <ActivityIndicator color={colors.accent} />
          <Text style={[type.small, { flex: 1 }]}>
            {stage === 'placing' ? `Putting them on the map${ideas?.length ? ` (${placed} of ${ideas.length})` : ''}…`
              : stage === 'thinking-again' ? 'Nothing came back first time — asking again…'
              : 'Thinking of days out for you…'}
            {elapsed > 3 ? ` · ${elapsed}s` : ''}
          </Text>
          <Chip label="Stop waiting" icon="stop" onPress={stopWaiting} />
        </Row>
      ) : null}
      {busy && elapsed > 25 && runRef ? <Text style={type.tiny}>Taking longer than it should. This is run {runRef} — quote that number and Roam can say exactly where it got stuck.</Text> : null}

      {restoring && !ideas ? <Text style={type.tiny}>Putting back what you were looking at…</Text> : null}

      {ideas ? (
        <Card>
          {/* These are the ideas from earlier today, not new ones: say so, and
              make asking again a tap rather than a guess (owner, 4 Sep 2026). */}
          {foundAt && !busy ? (
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={type.tiny}>Found {howLongAgo(Date.now() - new Date(foundAt).getTime())} · kept for the day</Text>
              <Chip label="Refresh" icon="refresh" onPress={inspire} />
            </Row>
          ) : null}
          {reply ? <Text style={type.small}>{reply}</Text> : null}
          {ideas.length === 0 ? <Text style={type.small}>Nothing came to mind for that — try \u2018Don\u2019t mind\u2019 on one of the questions, or a wider distance.</Text> : null}
          {ideas.map((idea) => {
            const t = things[idea.id];
            const done = opened[idea.id];
            const isOpening = opening === idea.id;
            const head = t?.headline ?? null;
            const far = [
              idea.travelMinutes != null ? `${minutes(idea.travelMinutes)} by car` : null,
              idea.distanceKm != null ? `${idea.distanceKm} km` : head?.distanceKm != null ? `${head.distanceKm} km` : null,
            ].filter(Boolean).join(' · ');
            return (
              <View key={idea.id} style={styles.idea}>
                {/* The picture is the first thing, and it is the place itself. */}
                {head?.photos?.length ? <VenuePhoto photos={head.photos} size={84} credit={false} />
                  : <View style={styles.tile}><CategoryIcon category={head?.category ?? 'attraction'} size={22} color={colors.accent} /></View>}
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={type.h3} numberOfLines={2}>{idea.title}</Text>
                  <Row style={{ flexWrap: 'wrap', gap: 10 }}>
                    {head?.rating != null ? <Rating value={head.rating}>{head.ratingCount ? ` (${head.ratingCount.toLocaleString()})` : ''}</Rating> : null}
                    {far ? <Text style={type.small}>{far}</Text> : null}
                  </Row>
                  <Text style={type.small} numberOfLines={2}>{idea.why}</Text>
                  {idea.do.length || idea.eat.length ? <Text style={type.tiny} numberOfLines={1}>{[...idea.do, ...idea.eat].slice(0, 3).join(' · ')}</Text> : null}
                  <Row style={{ marginTop: 4, flexWrap: 'wrap' }}>
                    {idea.place ? <Chip label={isOpening ? 'Setting up the day…' : done ? 'Open in Trips' : 'Plan the day'} icon={done ? 'trips' : 'more'} tone="accent" onPress={() => openTrip(idea)} /> : null}
                    <Chip label="Plan this" onPress={() => planIdea(idea)} />
                  </Row>
                  {done ? <Text style={type.tiny} numberOfLines={1}>In Trips as {done.title}.</Text> : null}
                </View>
              </View>
            );
          })}
          <Text style={type.tiny}>Nothing is booked.{runRef ? ` Run ${runRef}` : ''}</Text>
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
  idea: { paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  tile: { width: 84, height: 84, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  settings: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm },
  settingsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32 },
});

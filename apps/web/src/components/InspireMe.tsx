import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, IdeaBudget, Idea, IdeaThing } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, StatusLine, Wrap, minutes } from './ui';
import { Icon } from './Icon';
import type { OpenTripOptions } from '../screens/PlanScreen';

const MOODS = ['Easygoing', 'Intensive', 'Fun', 'Relaxing', 'Food-focused', 'Activity-focused', 'Educational', 'Outdoors', 'Somewhere new'];
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
export function InspireMe({ query, setQuery, attendingIds, who, onPlan, onOpenTrip, listening, transcript, supported, onSpeak, onStop }: {
  query: string; setQuery: (q: string) => void;
  attendingIds: string[] | null;
  who: React.ReactNode;
  onPlan: (utterance: string) => void;
  onOpenTrip?: (tripId: string, opts?: OpenTripOptions) => void;
  listening: boolean; transcript: string; supported: boolean; onSpeak: () => void; onStop: () => void;
}) {
  const [moods, setMoods] = useState<Set<string>>(new Set());
  const [cap, setCap] = useState<number | null>(120);
  const [budget, setBudget] = useState<IdeaBudget>('any');
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [things, setThings] = useState<Record<string, Things>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, { tripId: string; title: string; seeded: string[] }>>({});
  const run = useRef(0);

  // Inspire me runs on the server in the background: the request is retried
  // through a redeploy, then the session is polled until the ideas are on it,
  // so a slow model call or a restart mid-way never ends in "Failed to fetch".
  const inspire = async () => {
    setBusy(true); setError(null);
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

  const summaries = useMemo(() => Object.fromEntries(Object.entries(things).map(([id, t]) => [id, t.status === 'ready' ? summarise(t.items) : ''])), [things]);

  return (
    <>
      <Card style={{ gap: spacing.sm }}>
        <TextInput
          value={listening ? transcript : query}
          onChangeText={setQuery}
          multiline
          editable={!listening}
          placeholder="Somewhere fun within two hours, with climbing…"
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
        <View style={{ gap: 6 }}>
          <Text style={type.tiny}>In the mood for</Text>
          <Wrap>{MOODS.map((m) => <Chip key={m} label={m} selected={moods.has(m)} icon={moods.has(m) ? 'check' : undefined} onPress={() => setMoods((s) => { const n = new Set(s); if (n.has(m)) n.delete(m); else n.add(m); return n; })} />)}</Wrap>
        </View>
        <Row style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Text style={type.tiny}>Up to</Text>
          {CAPS.map((c) => <Chip key={c.label} label={c.label} selected={cap === c.value} onPress={() => setCap(c.value)} />)}
          <Text style={type.tiny}>from home</Text>
        </Row>
        <Row style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Text style={type.tiny}>Budget</Text>
          {BUDGETS.map((b) => <Chip key={b.value} label={b.label} selected={budget === b.value} icon={budget === b.value && b.value !== 'any' ? 'check' : undefined} onPress={() => setBudget(b.value)} />)}
        </Row>
        {who}
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      </Card>

      {busy ? <Row><ActivityIndicator color={colors.accent} /><Text style={type.small}>Looking through your atlas and what's around…</Text></Row> : null}

      {ideas ? (
        <Card>
          {reply ? <Text style={type.small}>{reply}</Text> : null}
          {ideas.length === 0 ? <Text style={type.small}>Nothing came to mind for that — try fewer moods or a wider cap.</Text> : null}
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
  mic: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line },
  stop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: TARGET, paddingHorizontal: spacing.lg, borderRadius: radius.pill, backgroundColor: colors.overrun },
  stopText: { color: colors.bg, fontWeight: '700', fontSize: 15 },
  idea: { paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', gap: spacing.sm },
});

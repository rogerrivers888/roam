import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, Idea, IdeaThing } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, StatusLine, Wrap, minutes } from './ui';
import { Icon } from './Icon';
import { SideSheet } from './SideSheet';

const MOODS = ['Easygoing', 'Intensive', 'Fun', 'Relaxing', 'Food-focused', 'Activity-focused', 'Educational', 'Outdoors', 'Somewhere new'];
const CAPS: { label: string; value: number | null }[] = [{ label: '1 h', value: 60 }, { label: '2 h', value: 120 }, { label: '3 h', value: 180 }, { label: 'Anywhere', value: null }];
const KIND_LABEL = { do: 'Do', eat: 'Eat', see: 'See' } as const;

/**
 * Inspire me: a loose brief (typed or spoken), a mood or two, a travel cap →
 * ideas that say why. An idea opens as a sheet of things to do and see there;
 * each can be picked, and "Plan this day" hands the lot to the rows.
 */
export function InspireMe({ query, setQuery, attendingIds, who, onPlan, listening, transcript, supported, onSpeak, onStop }: {
  query: string; setQuery: (q: string) => void;
  attendingIds: string[] | null;
  who: React.ReactNode;
  onPlan: (utterance: string) => void;
  listening: boolean; transcript: string; supported: boolean; onSpeak: () => void; onStop: () => void;
}) {
  const [moods, setMoods] = useState<Set<string>>(new Set());
  const [cap, setCap] = useState<number | null>(120);
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Idea | null>(null);
  const [things, setThings] = useState<IdeaThing[] | null>(null);
  const [thingsBusy, setThingsBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'do' | 'eat' | 'see'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const inspire = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.inspire({ query, moods: [...moods], maxTravelMinutes: cap, attendingMemberIds: attendingIds });
      setIdeas(r.ideas); setReply(r.reply);
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  };

  const openIdea = async (idea: Idea) => {
    setOpen(idea); setThings(null); setPicked(new Set()); setFilter('all');
    if (!idea.place) return;
    setThingsBusy(true);
    try { const r = await api.inspireThings({ lat: idea.place.lat, lng: idea.place.lng, label: idea.place.label }); setThings(r.items); }
    catch (e: any) { setError(e?.message || String(e)); } finally { setThingsBusy(false); }
  };

  // The whole idea, or the things picked from it, as one sentence the rows understand.
  const planIdea = (idea: Idea) => {
    const chosen = (things ?? []).filter((t) => picked.has(t.venueRef));
    const dos = chosen.filter((t) => t.kind !== 'eat').map((t) => t.name);
    const eats = chosen.filter((t) => t.kind === 'eat').map((t) => t.name);
    const doList = dos.length ? dos : idea.do;
    const eatList = eats.length ? eats.map((n) => `eat at ${n}`) : idea.eat;
    const parts = [
      `From home to ${idea.place?.label ?? idea.placeText}.`,
      idea.overnight ? 'Stay one night.' : '',
      doList.length ? `We want to do: ${doList.join(', ')}.` : '',
      eatList.length ? `${eatList.join(', ')}.` : '',
      cap ? `No more than ${minutes(cap)} away.` : '',
    ].filter(Boolean);
    setOpen(null);
    onPlan(parts.join(' '));
  };

  const shown = useMemo(() => (things ?? []).filter((t) => filter === 'all' || t.kind === filter), [things, filter]);

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
            <Pressable onPress={onStop} style={styles.stop} accessibilityRole="button" accessibilityLabel="Stop"><Icon name="stop" size={14} color="#fff" /><Text style={styles.stopText}>Stop</Text></Pressable>
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
        {who}
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      </Card>

      {busy ? <Row><ActivityIndicator color={colors.accent} /><Text style={type.small}>Looking through your atlas and what's around…</Text></Row> : null}

      {ideas ? (
        <Card>
          {reply ? <Text style={type.small}>{reply}</Text> : null}
          {ideas.length === 0 ? <Text style={type.small}>Nothing came to mind for that — try fewer moods or a wider cap.</Text> : null}
          {ideas.map((idea) => (
            <Pressable key={idea.id} onPress={() => openIdea(idea)} style={styles.idea} accessibilityRole="button" accessibilityLabel={idea.title}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={type.h3}>{idea.title}</Text>
                <Text style={type.small}>{idea.travelMinutes != null ? `${minutes(idea.travelMinutes)} by car · ` : ''}{idea.why}</Text>
                <Row style={{ marginTop: 4 }}>
                  <Chip label="Things to do and see" icon="more" tone="accent" onPress={() => openIdea(idea)} />
                  <Chip label="Plan this" onPress={() => { setThings(null); setPicked(new Set()); planIdea(idea); }} />
                </Row>
              </View>
            </Pressable>
          ))}
          <Text style={type.tiny}>Ideas come from your atlas first, then the sources. Each says why it is here. Nothing is booked or saved.</Text>
        </Card>
      ) : null}

      {open ? (
        <SideSheet
          title={open.title}
          subtitle={[open.place?.label ?? open.placeText, open.travelMinutes != null ? `${minutes(open.travelMinutes)} by car from home` : null, open.why].filter(Boolean).join(' · ')}
          onClose={() => setOpen(null)}
          footer={(
            <Row>
              <Button label={picked.size ? `Plan this day with ${picked.size} picked` : 'Plan this day'} onPress={() => planIdea(open)} />
              <Button label="Close" kind="ghost" onPress={() => setOpen(null)} />
            </Row>
          )}
        >
          <Wrap>{(['all', 'do', 'eat', 'see'] as const).map((f) => <Chip key={f} label={f === 'all' ? 'All' : KIND_LABEL[f]} selected={filter === f} onPress={() => setFilter(f)} />)}</Wrap>
          {open.do.length || open.eat.length ? (
            <View style={{ gap: 2 }}>
              <Text style={type.tiny}>Roam suggested</Text>
              <Text style={type.small}>{[...open.do, ...open.eat].slice(0, 5).join(' · ')}</Text>
            </View>
          ) : null}
          {!open.place ? <Text style={type.small}>Roam couldn't pin this one on the map, so there is no list to browse — Plan this still works from the idea itself.</Text> : null}
          {thingsBusy ? <Row><ActivityIndicator color={colors.accent} /><Text style={type.small}>Looking around {open.place?.label}…</Text></Row> : null}
          {things && shown.length === 0 && !thingsBusy ? <Text style={type.small}>Nothing of that kind found nearby.</Text> : null}
          {shown.map((t) => {
            const on = picked.has(t.venueRef);
            return (
              <View key={t.venueRef} style={styles.thing}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[type.body, { fontWeight: '600' }]}>{t.name}</Text>
                  <Text style={type.tiny}>
                    {[KIND_LABEL[t.kind], t.rating != null ? `${t.rating.toFixed(1)}${t.ratingCount ? ` (${t.ratingCount.toLocaleString()})` : ''}` : null, t.priceLevel != null ? '£'.repeat(Math.max(1, t.priceLevel)) : null, t.distanceKm != null ? `${t.distanceKm} km` : null, ...t.reasons.slice(0, 1)].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Chip label={on ? 'Picked' : t.kind === 'eat' ? '+ Eat' : '+ Do'} tone="accent" icon={on ? 'check' : undefined} selected={on} onPress={() => setPicked((s) => { const n = new Set(s); if (n.has(t.venueRef)) n.delete(t.venueRef); else n.add(t.venueRef); return n; })} />
              </View>
            );
          })}
          <Text style={type.tiny}>Plan this day fills the rows (To, Do, Eat) and switches to Tell me — nothing is booked.</Text>
        </SideSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  box: { minHeight: 64, padding: spacing.md, borderRadius: radius.md, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 16, lineHeight: 22, color: colors.ink },
  boxLive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  mic: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line },
  stop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: TARGET, paddingHorizontal: spacing.lg, borderRadius: radius.pill, backgroundColor: colors.overrun },
  stopText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  idea: { paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', gap: spacing.sm },
  thing: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
});

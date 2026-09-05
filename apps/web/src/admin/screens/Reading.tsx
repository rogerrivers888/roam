/**
 * Reading a place, side by side with what it was read from.
 *
 * Owner, 5 Sep 2026: "We could go 1 by 1, comparing the wiki page to a
 * locations page, showing what you're extracting and what you're going to be
 * showing to the user. We could then train the AI on whether that's the right
 * data to capture, or whether it should have also captured other data… Once
 * we've trained it, we can let it loose."
 *
 * So the screen is a comparison and not a form. The sources sit on the left in
 * the state they were fetched in, the filled-in form sits on the right, and
 * every field that was *read* carries the sentence it came from underneath it.
 * A field with no sentence is a judgement, and it is marked as one — that
 * distinction is the whole reason this screen exists, because a judgement is
 * what he is actually being asked to check.
 *
 * Three things he can do with a reading, and only the first is free:
 *
 *   Approve   it is right. The reading becomes a worked example in the prompt
 *             for the next place of the same kind.
 *   Correct   something is wrong. He marks which fields, says what it should
 *             have caught, and that sentence becomes a lesson — scoped to the
 *             kind of place by default, so it travels to every castle rather
 *             than fixing this castle.
 *   Reject    the reading is not worth keeping.
 *
 * Correcting without teaching is possible and is deliberately awkward: the box
 * is open and focused, because "this is wrong" with no account of what right
 * would have been improves nothing.
 *
 * Layout, per the working agreements: `useViewport` rather than the window, a
 * wide layout and a phone layout decided from that width, one tree shape across
 * both so flipping the toggle does not lose the reading, and nothing that
 * overflows 390px.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  api, AttractionFacts, AttractionFactsRow, ExtractionLesson,
  LibraryAttraction, LibraryAttractionDetail, PlaceContent, ReadingStats,
} from '../../api';
import { colors, radius, spacing, TARGET, type } from '../../theme';
import { Icon } from '../../components/Icon';
import { Button, Chip, Row, Wrap } from '../../components/ui';
import { useViewport } from '../../hooks/useViewport';
import { AdminPage, Banner, FilterChip, FilterRow, Panel, Pill, Tile, TileRow, ago, count, plural } from '../kit';
import { asText, useQueryState } from '../../router';

const WIDE = 1000;

/** The fields he reviews, in the order the drawer will show them. */
const FIELDS: { key: keyof AttractionFacts; label: string; kind: 'read' | 'judged' }[] = [
  { key: 'whyGo', label: 'Why go', kind: 'judged' },
  { key: 'history', label: 'The history', kind: 'read' },
  { key: 'highlights', label: 'What there is to see', kind: 'read' },
  { key: 'dwell', label: 'How long it takes', kind: 'judged' },
  { key: 'cover', label: 'Indoors or out', kind: 'judged' },
  { key: 'suits', label: 'Who it suits', kind: 'judged' },
  { key: 'wouldBore', label: 'Who would be bored', kind: 'judged' },
  { key: 'bestTime', label: 'When to go', kind: 'judged' },
  { key: 'seasonal', label: 'What closes when', kind: 'read' },
  { key: 'booking', label: 'Booking', kind: 'read' },
];

const REVIEW_TONE: Record<string, 'plain' | 'ok' | 'warn' | 'crit' | 'accent'> = {
  pending: 'accent', approved: 'ok', corrected: 'warn', rejected: 'crit',
};

export function Reading({ canManage }: { canManage: boolean }) {
  const { width } = useViewport();
  const wide = width >= WIDE;
  const [region, setRegion] = useQueryState<string | null>('readRegion', 'berkshire', asText);
  const [openId, setOpenId] = useQueryState<string | null>('place', null, asText);

  const [rows, setRows] = useState<LibraryAttraction[]>([]);
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [lessons, setLessons] = useState<ExtractionLesson[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, taught] = await Promise.all([
        api.libraryAttractions({ region: region ?? undefined, state: 'published', limit: 300 }),
        api.libraryLessons({ region: region ?? undefined }),
      ]);
      setRows(list.attractions);
      setLessons(taught.lessons);
      setStats(taught.stats);
      setError(null);
    } catch (e: any) { setError(e.message); }
  }, [region]);
  useEffect(() => { load(); }, [load]);

  // Only the two counties the owner asked for, until the reading is trusted
  // enough to let loose on the rest (5 Sep 2026: "lets do Berkshire and Surrey
  // for now only").
  const REGIONS = [{ slug: 'berkshire', name: 'Berkshire' }, { slug: 'surrey', name: 'Surrey' }];

  return (
    <AdminPage>
      {error ? <Banner tone="crit">{error}</Banner> : null}

      <TileRow>
        <Tile label="Published" value={count(Number(stats?.published ?? 0))} />
        <Tile label="Read" value={count(Number(stats?.read ?? 0))} sub={`${count(Number(stats?.pending ?? 0))} not looked at`} />
        <Tile label="You approved" value={count(Number(stats?.approved ?? 0))} tone="ok"
              sub={`${count(Number(stats?.corrected ?? 0))} corrected`} />
        <Tile label="Lessons" value={count(Number(stats?.lessons?.active ?? 0))} tone="accent"
              sub="taught from your corrections" />
      </TileRow>

      <FilterRow>
        {REGIONS.map((r) => (
          <FilterChip key={r.slug} label={r.name} on={region === r.slug} onPress={() => { setRegion(r.slug); setOpenId(null); }} />
        ))}
      </FilterRow>

      <View style={[wide && styles.split]}>
        <View style={[{ minWidth: 0 }, wide && { flex: 2 }]}>
          <Panel title={openId ? 'The reading' : 'Pick a place to read'}
                 sub={openId ? undefined : `${plural(rows.length, 'published place')} in ${REGIONS.find((r) => r.slug === region)?.name ?? region}`}
                 padded={false}>
            {openId ? (
              <Compare id={openId} canManage={canManage} wide={wide}
                       onClose={() => setOpenId(null)} onChanged={load} />
            ) : (
              <PlaceList rows={rows} onOpen={setOpenId} />
            )}
          </Panel>
        </View>

        <View style={[{ minWidth: 0 }, wide && { flex: 1 }]}>
          <Lessons lessons={lessons} canManage={canManage} onChanged={load} />
        </View>
      </View>
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------
// picking one
// ---------------------------------------------------------------------------

function PlaceList({ rows, onOpen }: { rows: LibraryAttraction[]; onOpen: (id: string) => void }) {
  if (!rows.length) {
    return (
      <View style={{ padding: spacing.lg }}>
        <Text style={type.small}>Nothing published here yet — harvest the region on Coverage first.</Text>
      </View>
    );
  }
  return (
    <View>
      {rows.map((a) => (
        <Pressable key={a.id} onPress={() => onOpen(a.id)} style={styles.pick} accessibilityRole="button">
          <Text style={[type.small, { flex: 1, minWidth: 0, fontWeight: '600' }]} numberOfLines={1}>
            {a.rank ? `${a.rank}. ` : ''}{a.name}
          </Text>
          <Wrap>
            {(a as any).band ? <Pill label={(a as any).band} tone={(a as any).band === 'top' ? 'ok' : 'plain'} /> : null}
            {(a as any).detail_state ? <Pill label={(a as any).detail_state === 'done' ? 'sources in' : (a as any).detail_state} /> : <Pill label="no sources" tone="warn" />}
          </Wrap>
          <Icon name="more" size={16} color={colors.inkMuted} />
        </Pressable>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// the comparison
// ---------------------------------------------------------------------------

function Compare({ id, canManage, wide, onClose, onChanged }: {
  id: string; canManage: boolean; wide: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [attraction, setAttraction] = useState<LibraryAttractionDetail | null>(null);
  const [facts, setFacts] = useState<AttractionFactsRow | null>(null);
  const [contents, setContents] = useState<PlaceContent[]>([]);
  const [lessons, setLessons] = useState<ExtractionLesson[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await api.libraryAttraction(id);
      setAttraction(out.attraction); setFacts(out.facts);
      setContents(out.contents ?? []); setLessons(out.lessons ?? []);
      setError(null);
    } catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setError(null);
    try { await fn(); await load(); onChanged(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  if (!attraction) {
    return <View style={{ padding: spacing.lg }}><Text style={type.small}>{error ?? 'Opening…'}</Text></View>;
  }

  const hasSources = Boolean(attraction.sections?.length);

  return (
    <View>
      <View style={styles.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.body, { fontWeight: '700' }]} numberOfLines={1}>{attraction.name}</Text>
          <Text style={type.tiny}>
            {attraction.region_name}
            {attraction.band ? ` · ${attraction.band}` : ''}
            {attraction.roam_score ? ` · ${attraction.roam_score.toFixed(1)}` : ''}
            {attraction.contents_count ? ` · ${plural(attraction.contents_count, 'thing')} inside` : ''}
          </Text>
        </View>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
          <Icon name="close" size={18} color={colors.inkMuted} />
        </Pressable>
      </View>

      {error ? <View style={{ padding: spacing.sm }}><Banner tone="crit">{error}</Banner></View> : null}

      {canManage ? (
        <View style={{ padding: spacing.sm }}>
          <Wrap>
            <Button label={hasSources ? 'Fetch the sources again' : 'Go and read the sources'} kind="secondary"
                    icon="refresh" disabled={busy !== null}
                    onPress={() => act('detail', () => api.libraryFetchDetail(id, hasSources))} />
            <Button label={facts ? 'Read it again' : 'Read it'} icon="plan"
                    disabled={busy !== null || !hasSources}
                    onPress={() => act('read', () => api.libraryRead(id))} />
          </Wrap>
          {busy === 'read' ? <Text style={[type.tiny, { marginTop: spacing.xs }]}>Reading — this takes a few seconds.</Text> : null}
          {!hasSources ? (
            <Text style={[type.tiny, { marginTop: spacing.xs }]}>
              Nothing has been fetched about this place yet. Fetch the sources first — that part is free.
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={[wide && styles.split]}>
        <View style={[{ minWidth: 0 }, wide && { flex: 1 }]}>
          <Sources attraction={attraction} contents={contents} />
        </View>
        <View style={[{ minWidth: 0 }, wide && { flex: 1 }]}>
          {facts ? (
            <Extracted facts={facts} attraction={attraction} lessons={lessons}
                       canManage={canManage} onReviewed={() => { load(); onChanged(); }} />
          ) : (
            <View style={{ padding: spacing.md }}>
              <Text style={type.small}>Not read yet. Press “Read it” and the form will fill in here, beside what it read.</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// the left: what it read from
// ---------------------------------------------------------------------------

function Sources({ attraction, contents }: { attraction: LibraryAttractionDetail; contents: PlaceContent[] }) {
  const [openSection, setOpenSection] = useState<number | null>(0);
  const sections = attraction.sections ?? [];
  const visit = attraction.visit ?? {};
  const admission = attraction.admission ?? {};

  return (
    <View style={{ padding: spacing.sm, gap: spacing.sm }}>
      <Text style={styles.columnHead}>What it read</Text>

      {attraction.wikipedia_url ? (
        <Chip label="The Wikipedia article" icon="external"
              onPress={() => Linking.openURL(attraction.wikipedia_url!)} />
      ) : null}

      {!sections.length ? (
        <Banner tone="warn">Nothing fetched yet.</Banner>
      ) : sections.map((s, i) => (
        <View key={i} style={styles.source}>
          <Pressable onPress={() => setOpenSection(openSection === i ? null : i)} accessibilityRole="button">
            <Row style={{ gap: spacing.xs }}>
              <Icon name={openSection === i ? 'expand' : 'more'} size={14} color={colors.inkMuted} />
              <Text style={[type.small, { flex: 1, minWidth: 0, fontWeight: '600' }]} numberOfLines={1}>
                {s.heading ?? 'The opening'}
              </Text>
              {s.doing ? <Pill label="what to do" tone="accent" /> : null}
            </Row>
          </Pressable>
          {openSection === i ? <Text style={[type.tiny, { marginTop: spacing.xs }]}>{s.text}</Text> : null}
        </View>
      ))}

      {visit.travellerNote ? (
        <View style={styles.source}>
          <Text style={[type.small, { fontWeight: '600' }]}>A travel guide</Text>
          <Text style={[type.tiny, { marginTop: 2 }]}>{visit.travellerNote}</Text>
        </View>
      ) : null}

      {Object.keys(admission).length ? (
        <View style={styles.source}>
          <Text style={[type.small, { fontWeight: '600' }]}>What it costs</Text>
          <Text style={[type.tiny, { marginTop: 2 }]}>
            {admission.free ? 'Free' : [admission.adult && `Adult ${admission.adult}`, admission.child && `child ${admission.child}`,
              admission.family && `family ${admission.family}`].filter(Boolean).join(' · ') || admission.note || '—'}
          </Text>
          <Text style={type.tiny}>
            from {admission.source}{admission.seenAt ? `, read ${ago(admission.seenAt)}` : ''}
            {admission.stale ? ' — undated, treat with suspicion' : ''}
          </Text>
        </View>
      ) : null}

      {contents.length ? (
        <View style={styles.source}>
          <Text style={[type.small, { fontWeight: '600' }]}>{plural(contents.length, 'thing')} inside, from the map</Text>
          <Text style={[type.tiny, { marginTop: 2 }]}>
            {contents.slice(0, 40).map((c) => c.name).join(' · ')}
            {contents.length > 40 ? ` … and ${contents.length - 40} more` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// the right: what it made of it
// ---------------------------------------------------------------------------

function Extracted({ facts, attraction, lessons, canManage, onReviewed }: {
  facts: AttractionFactsRow; attraction: LibraryAttractionDetail;
  lessons: ExtractionLesson[]; canManage: boolean; onReviewed: () => void;
}) {
  const f = facts.facts;
  const [wrong, setWrong] = useState<string[]>(facts.wrong_fields ?? []);
  const [said, setSaid] = useState('');
  const [scope, setScope] = useState<'all' | 'kind' | 'place'>('kind');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setWrong(facts.wrong_fields ?? []); setSaid(''); }, [facts.attraction_id, facts.read_at]);

  const toggle = (key: string) =>
    setWrong((w) => (w.includes(key) ? w.filter((k) => k !== key) : [...w, key]));

  // The type this lesson would attach to. The atlas's own eight words are too
  // coarse to teach against — a rule about keeps must not reach a museum — so
  // a lesson hangs off the Wikidata type where there is one.
  const kindQid = (attraction.kinds ?? [])[0] ?? null;

  const send = async (review: 'approved' | 'corrected' | 'rejected') => {
    setBusy(true); setError(null);
    try {
      await api.libraryReview(facts.attraction_id, {
        review, wrongFields: wrong, note: said || undefined,
        lesson: said.trim()
          ? {
            scope,
            subject: scope === 'kind' ? kindQid : scope === 'place' ? attraction.id : null,
            subjectLabel: scope === 'kind' ? (attraction.category ?? null) : attraction.name,
            rule: said.trim(), field: wrong[0] ?? null, said: said.trim(),
          }
          : undefined,
      });
      onReviewed();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <View style={{ padding: spacing.sm, gap: spacing.sm }}>
      <Row style={{ gap: spacing.xs }}>
        <Text style={[styles.columnHead, { flex: 1, minWidth: 0 }]}>What it captured</Text>
        <Pill label={facts.review} tone={REVIEW_TONE[facts.review] ?? 'plain'} />
        {facts.confidence ? <Pill label={`${facts.confidence} confidence`} /> : null}
      </Row>
      <Text style={type.tiny}>
        Read {ago(facts.read_at)}{facts.model ? ` by ${facts.model}` : ''}
        {lessons.length ? ` · under ${plural(lessons.length, 'lesson')}` : ' · with nothing taught yet'}
      </Text>

      {FIELDS.map(({ key, label, kind }) => {
        const value = f[key];
        const shown = renderValue(key, value);
        if (!shown) return null;
        const evidence = key === 'history' ? facts.evidence?.history : key === 'dwell' ? facts.evidence?.dwell : null;
        const marked = wrong.includes(String(key));
        return (
          <View key={String(key)} style={[styles.field, marked && styles.fieldWrong]}>
            <Row style={{ gap: spacing.xs }}>
              <Text style={[type.tiny, { flex: 1, minWidth: 0, fontWeight: '700' }]}>{label}</Text>
              {kind === 'judged' ? <Pill label="judgement" tone="warn" /> : null}
              {canManage ? (
                <Pressable onPress={() => toggle(String(key))} accessibilityRole="button"
                           accessibilityLabel={marked ? `${label} is marked wrong` : `Mark ${label} wrong`}
                           hitSlop={8}>
                  <Icon name={marked ? 'close' : 'check'} size={15}
                        color={marked ? colors.overrun : colors.inkFaint} />
                </Pressable>
              ) : null}
            </Row>
            <Text style={[type.small, { marginTop: 2 }]}>{shown}</Text>
            {key === 'highlights' && f.highlights?.length ? (
              <View style={{ marginTop: spacing.xs, gap: 2 }}>
                {f.highlights.map((h, i) => (
                  <View key={i}>
                    <Text style={type.tiny}>· <Text style={{ fontWeight: '700' }}>{h.name}</Text> — {h.why}</Text>
                    {h.quote ? <Text style={styles.quote}>“{h.quote}”</Text>
                      : <Text style={styles.judged}>no sentence behind this — a judgement</Text>}
                  </View>
                ))}
              </View>
            ) : null}
            {evidence?.quote ? <Text style={styles.quote}>“{evidence.quote}”</Text> : null}
            {key === 'dwell' && f.dwellWhy ? <Text style={styles.judged}>because {f.dwellWhy}</Text> : null}
            {key === 'suits' && f.suitsWhy ? <Text style={styles.judged}>{f.suitsWhy}</Text> : null}
          </View>
        );
      })}

      {f.missing?.length ? (
        <View style={styles.field}>
          <Text style={[type.tiny, { fontWeight: '700' }]}>It could not find</Text>
          {f.missing.map((m, i) => <Text key={i} style={type.tiny}>· {m}</Text>)}
        </View>
      ) : null}

      {canManage ? (
        <View style={{ gap: spacing.xs }}>
          <Text style={[type.tiny, { fontWeight: '700' }]}>
            What should it have captured, or got right?
          </Text>
          <TextInput value={said} onChangeText={setSaid} multiline
                     placeholder="e.g. For a castle, always say whether you can climb the keep and whether the grounds are walkable in the rain."
                     placeholderTextColor={colors.inkFaint} style={styles.teach} />
          <Wrap>
            <Chip label="Every place like this" selected={scope === 'kind'} onPress={() => setScope('kind')} />
            <Chip label="Every place" selected={scope === 'all'} onPress={() => setScope('all')} />
            <Chip label="Just this one" selected={scope === 'place'} onPress={() => setScope('place')} />
          </Wrap>
          <Text style={type.tiny}>
            {scope === 'kind'
              ? `This becomes a rule for every ${attraction.category ?? 'place'} the atlas reads${kindQid ? ` (${kindQid})` : ''}.`
              : scope === 'all' ? 'This becomes a rule for every place the atlas reads.'
                : 'This fixes this one place and teaches nothing.'}
          </Text>

          {error ? <Banner tone="crit">{error}</Banner> : null}
          <Wrap>
            <Button label="This is right" icon="check" disabled={busy} onPress={() => send('approved')} />
            <Button label={said.trim() ? 'Correct it and teach that' : 'Mark it wrong'} kind="secondary"
                    disabled={busy} onPress={() => send('corrected')} />
            <Button label="Throw it away" kind="secondary" disabled={busy} onPress={() => send('rejected')} />
          </Wrap>
          {wrong.length && !said.trim() ? (
            <Text style={type.tiny}>
              {plural(wrong.length, 'field')} marked wrong. Saying what right looks like is what makes the next one better.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One field as a line of text. Lists become sentences; empty means nothing to show. */
function renderValue(key: keyof AttractionFacts, value: unknown): string | null {
  if (value == null || value === '') return null;
  if (key === 'highlights') {
    const n = (value as unknown[]).length;
    return n ? `${plural(n, 'thing')} to see` : null;
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : null;
  return String(value);
}

// ---------------------------------------------------------------------------
// what it has been taught
// ---------------------------------------------------------------------------

function Lessons({ lessons, canManage, onChanged }: {
  lessons: ExtractionLesson[]; canManage: boolean; onChanged: () => void;
}) {
  return (
    <Panel title="What you have taught it" sub={`${plural(lessons.filter((l) => l.active).length, 'rule')} in the prompt`}
           padded={false}>
      {!lessons.length ? (
        <View style={{ padding: spacing.md }}>
          <Text style={type.small}>
            Nothing yet. Correct a reading and say what it should have caught, and the rule appears here and goes
            into the prompt for the next place of that kind.
          </Text>
        </View>
      ) : lessons.map((l) => (
        <View key={l.id} style={[styles.lesson, !l.active && { opacity: 0.5 }]}>
          <Row style={{ gap: spacing.xs }}>
            <Pill label={l.scope === 'kind' ? (l.subject_label ?? 'this kind') : l.scope === 'all' ? 'every place' : 'one place'}
                  tone={l.scope === 'all' ? 'accent' : 'plain'} />
            {l.field ? <Pill label={l.field} /> : null}
            <View style={{ flex: 1 }} />
            {canManage ? (
              <Pressable onPress={async () => { await api.librarySetLesson(l.id, { active: !l.active }); onChanged(); }}
                         accessibilityRole="button" hitSlop={8}
                         accessibilityLabel={l.active ? 'Stop using this rule' : 'Use this rule again'}>
                <Icon name={l.active ? 'close' : 'refresh'} size={14} color={colors.inkMuted} />
              </Pressable>
            ) : null}
          </Row>
          <Text style={[type.small, { marginTop: 2 }]}>{l.rule}</Text>
          <Text style={type.tiny}>
            {l.from_name ? `from ${l.from_name} · ` : ''}
            used {count(l.used_count)}×
            {l.used_count ? `, approved after ${count(l.approved_after)}` : ''}
          </Text>
        </View>
      ))}
    </Panel>
  );
}

const styles = StyleSheet.create({
  split: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  columnHead: { ...type.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  pick: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, minHeight: TARGET,
  },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line,
  },
  source: {
    backgroundColor: colors.surfaceMuted, borderRadius: radius.sm,
    padding: spacing.sm, gap: 2,
  },
  field: {
    borderLeftWidth: 2, borderLeftColor: colors.line,
    paddingLeft: spacing.sm, paddingVertical: spacing.xs,
  },
  fieldWrong: { borderLeftColor: colors.overrun },
  quote: {
    ...type.tiny, fontStyle: 'italic', color: colors.inkMuted,
    marginTop: 2, paddingLeft: spacing.xs,
  },
  judged: { ...type.tiny, color: colors.inkFaint, marginTop: 2 },
  teach: {
    ...type.small, color: colors.ink, backgroundColor: colors.surfaceMuted,
    borderRadius: radius.sm, padding: spacing.sm, minHeight: 72, textAlignVertical: 'top',
  },
  lesson: {
    padding: spacing.sm, gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line,
  },
});

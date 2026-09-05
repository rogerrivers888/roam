/**
 * Shelves — teaching Roam what a day somewhere is like.
 *
 * The owner, 5 Sep 2026, looking at the home screen: "currently, on the
 * homepage under the adrenaline section, it's showing football stadiums. That's
 * not what I consider adrenaline. Adrenaline might be an activity like a flying
 * lesson… Go-karting, etc. I would like to be able to train it on anything that
 * appears in the categorisation where I believe it's wrong. I think we need an
 * admin section in the back office where we can train it on categories."
 *
 * So the screen is built around that exact motion, and in that order:
 *
 *   On a shelf     The shelf as the home screen composes it — the same list he
 *                  objected to — with why each place is there, and what nearly
 *                  made it. Tap the wrong one.
 *   Find a place   The same thing by name, for when the card has scrolled away.
 *   What you       Every rule, what it says and who said it. A rule is a
 *   have taught    sentence somebody can argue with, and taking one back is one
 *                  button.
 *
 * **Weights, because the shelves overlap.** His other constraint: "something
 * could be adrenaline and it also could be fun, we probably need to have some
 * weighting around which category it should sit in… we don't want to have lots
 * of duplication between the categories, and that will also annoy people." So a
 * rule is not a list of shelves, it is a number per shelf, and only the two
 * strongest above the floor draw a card. The form shows what will actually
 * appear before it is saved.
 *
 * **Teach the type, not the place.** Every atlas place carries the Wikidata
 * types it was harvested with, so "this is not adrenaline" said once against
 * `association football venue` answers for every ground in the country. The
 * form offers the types first and the single place last, because the single
 * place is almost never the right answer.
 *
 * Numbers are typed, never nudged (owner, 4 Sep 2026), so each shelf is a
 * `Stepper` reading 0–100 with the meaning of the number in words beside it.
 * Layout follows the shell's rule (CLAUDE.md): width from `useViewport`, one
 * tree with different styles rather than two returns, nothing over 390px.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, MoodKey, ShelfPlace, ShelfProposal, ShelfRule, ShelfVocabulary, ShelfWeights } from '../../api';
import { colors, radius, spacing, type } from '../../theme';
import { Icon, IconName } from '../../components/Icon';
import { Button, Chip, Row, Stepper, Wrap } from '../../components/ui';
import { useViewport } from '../../hooks/useViewport';
import { AdminPage, Banner, FilterChip, FilterRow, PageHead, Panel, Pill, Tile, TileRow, ago, count } from '../kit';

const WIDE = 900;

type Section = 'shelf' | 'find' | 'taught';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'shelf', label: 'On a shelf' },
  { key: 'find', label: 'Find a place' },
  { key: 'taught', label: 'What you have taught' },
];

/** The six, as pictures. Adrenaline is a mountain because it is a thing you do. */
const SHELF_ICON: Record<MoodKey, IconName> = {
  fun: 'festival', food: 'restaurant', culture: 'museum',
  adrenaline: 'climbing', relaxing: 'walk', outdoors: 'park',
};

/** What a rule is about, said in words rather than in the column name. */
const SCOPE_WORD: Record<ShelfRule['scope'], string> = {
  place: 'this place',
  kind: 'every place of this type',
  category: 'every place the atlas calls this',
  experience: 'every place tagged this on the map',
};

/** A weight, as the household would read it. */
const meaning = (pc: number, floor: number) =>
  (pc >= floor * 100 ? 'shown here' : pc > 0 ? 'true, not shown' : 'not this');

/** The shelves a set of weights actually draws, worked out exactly as the API does. */
function drawn(weights: ShelfWeights, order: MoodKey[], floor: number, max: number): MoodKey[] {
  return order
    .filter((k) => (weights[k] ?? 0) >= floor)
    .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || order.indexOf(a) - order.indexOf(b))
    .slice(0, max)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

// ---------------------------------------------------------------------------

export function Shelves({ canManage }: { canManage: boolean }) {
  const { width } = useViewport();
  const wide = width >= WIDE;

  const [vocab, setVocab] = useState<ShelfVocabulary | null>(null);
  const [section, setSection] = useState<Section>('shelf');
  const [mood, setMood] = useState<MoodKey>('adrenaline');
  const [items, setItems] = useState<ShelfPlace[]>([]);
  const [nearly, setNearly] = useState<ShelfPlace[]>([]);
  const [pool, setPool] = useState(0);
  const [where, setWhere] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ShelfPlace[]>([]);
  const [teaching, setTeaching] = useState<ShelfPlace | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const order = useMemo(() => (vocab?.shelves ?? []).map((s) => s.key), [vocab]);
  const floor = vocab?.floor ?? 0.6;
  const max = vocab?.maxShelves ?? 2;

  const loadVocab = useCallback(async () => {
    try { setVocab(await api.shelfVocabulary()); }
    catch (err) { setNote(String((err as Error).message)); }
  }, []);

  const loadShelf = useCallback(async () => {
    try {
      const d = await api.shelfContents({ mood });
      setItems(d.items); setNearly(d.nearly); setPool(d.pool);
      setWhere(d.place.label ?? `${d.place.lat.toFixed(3)}, ${d.place.lng.toFixed(3)}`);
    } catch (err) { setItems([]); setNearly([]); setNote(String((err as Error).message)); }
  }, [mood]);

  useEffect(() => { void loadVocab(); }, [loadVocab]);
  useEffect(() => { void loadShelf(); }, [loadShelf]);

  useEffect(() => {
    if (section !== 'find') return;
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => {
      void api.shelfFindPlaces(q.trim()).then((d) => setFound(d.places)).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, section]);

  /** After anything is taught, the shelf is drawn again — that is the whole loop. */
  const refresh = useCallback(async () => {
    await Promise.all([loadVocab(), loadShelf()]);
    if (q.trim().length >= 2) await api.shelfFindPlaces(q.trim()).then((d) => setFound(d.places)).catch(() => {});
  }, [loadVocab, loadShelf, q]);

  const forget = async (rule: ShelfRule) => {
    setBusy(true);
    try {
      await api.shelfForget(rule.id);
      setNote(`Forgotten. ${rule.subject_label ?? rule.subject} falls back to where it started.`);
      await refresh();
    } catch (err) { setNote(String((err as Error).message)); }
    finally { setBusy(false); }
  };

  const shelfLabel = (key: MoodKey) => vocab?.shelves.find((s) => s.key === key)?.label ?? key;

  const rows = section === 'find' ? found : items;

  return (
    <AdminPage>
      <PageHead
        title="Shelves"
        sub="What the home screen calls each place, and how to tell it when that is wrong"
        right={canManage ? (
          <Button
            label="Name the types"
            icon="refresh"
            kind="secondary"
            disabled={busy}
            onPress={async () => {
              setBusy(true);
              try {
                const r = await api.shelfNameKinds(400);
                setNote(r.named
                  ? `Named ${r.named} types from Wikidata. ${count(r.remaining)} still read as a Q-number — press again.`
                  : 'Every type Roam has seen already has a name.');
                await refresh();
              } catch (err) { setNote(String((err as Error).message)); }
              finally { setBusy(false); }
            }}
          />
        ) : undefined}
      />

      <TileRow>
        <Tile label={`On ${shelfLabel(mood)}`} value={count(items.length)} sub={where ? `within reach of ${where}` : undefined}
              tone={items.length ? 'ok' : 'warn'} />
        <Tile label="Nearly on it" value={count(nearly.length)} sub="one rule away" tone="accent" />
        <Tile label="Places looked at" value={count(pool)} sub="the whole pool near here" />
        <Tile label="Rules taught" value={count(vocab?.rules.length ?? 0)}
              sub={`${count(vocab?.counts.kind ?? 0)} about a type, ${count(vocab?.counts.place ?? 0)} about one place`} tone="accent" />
      </TileRow>

      {note ? <Banner tone="accent">{note}</Banner> : null}

      <Banner>
        A place carries a number from 0 to 100 for each of the six shelves. At {Math.round(floor * 100)} and above it is
        worth a card; below that it is true but not shown. Only the {max === 2 ? 'two' : max} strongest ever draw, so
        nothing appears on four shelves at once.
      </Banner>

      <FilterRow>
        {SECTIONS.map((s) => (
          <FilterChip key={s.key} label={s.label} on={section === s.key} onPress={() => { setSection(s.key); setTeaching(null); }} />
        ))}
      </FilterRow>

      {section === 'shelf' ? (
        <FilterRow>
          {(vocab?.shelves ?? []).map((s) => (
            <FilterChip key={s.key} label={s.label} on={mood === s.key} onPress={() => { setMood(s.key); setTeaching(null); }} />
          ))}
        </FilterRow>
      ) : null}

      {section === 'find' ? (
        <Panel title="Find the place" sub="Type the name off the card you were looking at">
          <View style={styles.search}>
            <Icon name="search" size={15} color={colors.inkMuted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Wembley, Sandhurst, Brands Hatch…"
              placeholderTextColor={colors.inkFaint}
              style={styles.searchInput}
            />
          </View>
        </Panel>
      ) : null}

      {teaching && canManage ? (
        <TeachForm
          key={teaching.ref}
          place={teaching}
          vocab={vocab}
          order={order}
          floor={floor}
          max={max}
          wide={wide}
          onClose={() => setTeaching(null)}
          onSaved={async (said) => { setNote(said); setTeaching(null); await refresh(); }}
          onForget={forget}
        />
      ) : null}

      {section !== 'taught' ? (
        <Panel
          title={section === 'find' ? 'What Roam thinks of these' : `${shelfLabel(mood)}, as the home screen draws it`}
          sub={section === 'find'
            ? 'Where each one sits, and why'
            : 'The same list, composed the same way. Tap anything that does not belong.'}
          padded={false}
        >
          {rows.length === 0 ? (
            <View style={{ padding: spacing.md, gap: spacing.xs }}>
              <Text style={type.small}>
                {section === 'find'
                  ? (q.trim().length < 2 ? 'Type a name above.' : 'Nothing in the atlas by that name.')
                  : `Nothing is on ${shelfLabel(mood)} near ${where ?? 'home'}.`}
              </Text>
              {section === 'shelf' && nearly.length ? (
                <Text style={type.tiny}>
                  {nearly.length} place{nearly.length === 1 ? '' : 's'} nearly qualify — they are below. If none of them is
                  really a {shelfLabel(mood).toLowerCase()} day out, the shelf is empty because the atlas holds no such
                  place near here, not because it is sorted wrongly.
                </Text>
              ) : null}
            </View>
          ) : rows.map((p) => (
            <PlaceRow key={p.ref} place={p} wide={wide} order={order}
                      canManage={canManage} onTeach={() => setTeaching(p)} shelfLabel={shelfLabel} />
          ))}
        </Panel>
      ) : null}

      {section === 'shelf' && nearly.length ? (
        <Panel
          title={`Nearly ${shelfLabel(mood)}`}
          sub={`Below the line at ${Math.round(floor * 100)}, strongest first. This is the list that answers "why is that not on there".`}
          padded={false}
        >
          {nearly.map((p) => (
            <PlaceRow key={p.ref} place={p} wide={wide} order={order}
                      canManage={canManage} onTeach={() => setTeaching(p)} shelfLabel={shelfLabel} highlight={mood} />
          ))}
        </Panel>
      ) : null}

      {section === 'taught' ? (
        <Panel
          title="Every rule"
          sub="What has been taught, why, and by whom. Forgetting one drops the subject back to where it started."
          padded={false}
        >
          {(vocab?.rules ?? []).length === 0 ? (
            <View style={{ padding: spacing.md }}><Text style={type.small}>Nothing taught yet.</Text></View>
          ) : (vocab?.rules ?? []).map((r) => (
            <View key={r.id} style={[styles.ruleRow, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
              <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
                <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
                  <Text style={styles.rowName}>{r.subject_label ?? r.subject}</Text>
                  <Pill label={SCOPE_WORD[r.scope]} />
                  {r.seeded ? <Pill label="where Roam started" /> : <Pill label="you decided this" tone="accent" />}
                </Row>
                <Wrap style={{ gap: 4 }}>
                  {Object.entries(r.weights)
                    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                    .map(([k, v]) => (
                      <Pill key={k} icon={SHELF_ICON[k as MoodKey]} tone={(v ?? 0) >= floor ? 'ok' : 'plain'}
                            label={`${shelfLabel(k as MoodKey)} ${Math.round((v ?? 0) * 100)}`} />
                    ))}
                </Wrap>
                {r.reason ? <Text style={type.small}>{r.reason}</Text> : null}
                <Text style={type.tiny}>
                  {r.subject}{r.taught_by ? ` · ${r.taught_by}` : ''} · {ago(r.updated_at)}
                </Text>
              </View>
              {canManage ? (
                <Button label="Forget" icon="close" kind="secondary" disabled={busy} onPress={() => void forget(r)} />
              ) : null}
            </View>
          ))}
        </Panel>
      ) : null}
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------
// one place, with the working shown
// ---------------------------------------------------------------------------

function PlaceRow({ place, wide, order, canManage, onTeach, shelfLabel, highlight }: {
  place: ShelfPlace; wide: boolean; order: MoodKey[]; canManage: boolean;
  onTeach: () => void; shelfLabel: (k: MoodKey) => string; highlight?: MoodKey;
}) {
  const why = place.because[0];
  return (
    <Pressable onPress={canManage ? onTeach : undefined} style={[styles.placeRow, wide && { alignItems: 'center' }]}>
      {place.imageId ? (
        <Image source={{ uri: api.imageUrl(place.imageId, 96) }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}><Icon name="place" size={16} color={colors.inkFaint} /></View>
      )}

      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
          <Text style={styles.rowName} numberOfLines={1}>{place.name}</Text>
          {place.category ? <Pill label={place.category} /> : null}
          {place.rule ? <Pill label="taught" tone="accent" /> : null}
        </Row>
        <Text style={type.tiny} numberOfLines={1}>
          {[place.region, place.distanceKm != null ? `${place.distanceKm} km` : null].filter(Boolean).join(' · ')}
        </Text>
        <Text style={type.tiny} numberOfLines={2}>
          Because {why?.subject_label ?? 'nothing has been said about it'}
          {why?.scope === 'kind' ? ' (a type rule)' : why?.scope === 'place' ? ' (a rule about this one place)' : ''}
        </Text>
      </View>

      {/* On a phone the numbers take their own line rather than squeezing the
          name into three letters. */}
      <Wrap style={wide ? styles.weightsWide : styles.weights}>
        {order
          .filter((k) => (place.weights[k] ?? 0) > 0)
          .sort((a, b) => (place.weights[b] ?? 0) - (place.weights[a] ?? 0))
          .map((k) => (
            <Pill
              key={k}
              icon={SHELF_ICON[k]}
              label={`${shelfLabel(k)} ${Math.round((place.weights[k] ?? 0) * 100)}`}
              tone={place.shelves.includes(k) ? 'ok' : k === highlight ? 'warn' : 'plain'}
            />
          ))}
      </Wrap>

      {canManage ? <Icon name="more" size={16} color={colors.inkMuted} /> : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// the form: what is being taught, and what it will do
// ---------------------------------------------------------------------------

type Subject = { scope: ShelfRule['scope']; subject: string; label: string; note: string; rule: ShelfRule | null };

function TeachForm({ place, vocab, order, floor, max, wide, onClose, onSaved, onForget }: {
  place: ShelfPlace; vocab: ShelfVocabulary | null; order: MoodKey[]; floor: number; max: number; wide: boolean;
  onClose: () => void; onSaved: (said: string) => Promise<void> | void; onForget: (r: ShelfRule) => Promise<void>;
}) {
  /**
   * What can be taught about this card, broadest correction first.
   *
   * The types lead because they are almost always the right answer: the owner's
   * complaint was never about one ground, it was about grounds.
   */
  const subjects: Subject[] = useMemo(() => [
    ...place.kinds.map((k) => ({
      scope: 'kind' as const,
      subject: k.qid,
      label: k.label ?? k.qid,
      note: `Every place Wikidata calls this${k.label ? '' : ' — press "Name the types" to see what it is'}`,
      rule: k.rule,
    })),
    ...(place.category ? [{
      scope: 'category' as const,
      subject: place.category,
      label: `everything the atlas calls ${place.category}`,
      note: 'The broadest thing you can say. Eight words cover the whole atlas.',
      rule: vocab?.rules.find((r) => r.scope === 'category' && r.subject === place.category) ?? null,
    }] : []),
    {
      scope: 'place' as const,
      subject: place.ref,
      label: place.name,
      note: 'This one place only. Use it when the place is the odd one out, not the type.',
      rule: place.rule,
    },
  ], [place, vocab]);

  const [chosen, setChosen] = useState<Subject>(subjects[0]);
  // Weights are held as whole numbers here: a number you type, not a slider,
  // and 0–100 is what a person reasons in.
  const [pc, setPc] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /**
   * Start the form from whatever already applies.
   *
   * A rule about this subject if there is one, otherwise where the atlas
   * category starts, otherwise where this place sits today — never all zeros,
   * because a form that opens empty invites somebody to save a place onto no
   * shelf at all.
   */
  useEffect(() => {
    const from: ShelfWeights = chosen.rule?.weights
      ?? (chosen.scope === 'category' ? vocab?.defaults.category[chosen.subject] : undefined)
      ?? place.weights;
    setPc(Object.fromEntries(order.map((k) => [k, Math.round((from[k] ?? 0) * 100)])));
    setReason(chosen.rule?.reason ?? '');
    setErr(null);
  }, [chosen, order, place, vocab]);

  const weights: ShelfWeights = Object.fromEntries(
    order.filter((k) => (pc[k] ?? 0) > 0).map((k) => [k, (pc[k] ?? 0) / 100]),
  );
  const will = drawn(weights, order, floor, max);
  const label = (k: MoodKey) => vocab?.shelves.find((s) => s.key === k)?.label ?? k;

  const save = async () => {
    setBusy('save'); setErr(null);
    try {
      await api.shelfTeach({
        scope: chosen.scope,
        subject: chosen.subject,
        subjectLabel: chosen.label,
        weights,
        reason: reason.trim() || null,
      });
      await onSaved(
        will.length
          ? `Taught: ${chosen.label} now shows under ${will.map(label).join(' and ')}.`
          : `Taught: ${chosen.label} now shows on no shelf at all.`,
      );
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(null); }
  };

  const read = async () => {
    setBusy('read'); setErr(null);
    try {
      const { proposal } = await api.shelfRead({
        said,
        subject: chosen.subject,
        subjectLabel: chosen.label,
        scope: chosen.scope,
        current: weights,
      });
      applyProposal(proposal);
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(null); }
  };

  const applyProposal = (p: ShelfProposal) => {
    setPc(Object.fromEntries(order.map((k) => [k, Math.round((p.weights[k] ?? 0) * 100)])));
    setReason(p.reason);
    if (p.suggestedScope !== chosen.scope) {
      const better = subjects.find((s) => s.scope === p.suggestedScope);
      if (better) setErr(`Roam thinks this is really about ${SCOPE_WORD[p.suggestedScope]} — "${better.label}". The numbers below are filled in either way; switch above if you agree.`);
    }
  };

  return (
    <Panel
      title={`Teaching: ${place.name}`}
      sub="What is really being corrected, and what it will look like when it is"
      right={<Button label="Close" icon="close" kind="secondary" onPress={onClose} />}
    >
      <Text style={type.small}>What is this correction about?</Text>
      <Wrap style={{ gap: spacing.xs }}>
        {subjects.map((s) => (
          <Chip
            key={`${s.scope}:${s.subject}`}
            label={s.scope === 'kind' ? `Every ${s.label}` : s.scope === 'category' ? `Every ${place.category}` : 'Just this place'}
            selected={chosen.scope === s.scope && chosen.subject === s.subject}
            onPress={() => setChosen(s)}
          />
        ))}
      </Wrap>
      <Text style={type.tiny}>{chosen.note}</Text>

      {chosen.rule ? (
        <Row style={{ gap: spacing.sm, flexWrap: 'wrap' }}>
          <Text style={type.tiny}>
            Already taught{chosen.rule.taught_by ? ` by ${chosen.rule.taught_by}` : ''}: “{chosen.rule.reason ?? 'no reason recorded'}”
          </Text>
          <Button label="Forget it" icon="close" kind="secondary"
                  onPress={async () => { await onForget(chosen.rule!); }} />
        </Row>
      ) : null}

      <View style={styles.divider} />

      <Text style={type.small}>Say it in a sentence, and Roam will fill the numbers in.</Text>
      <TextInput
        value={said}
        onChangeText={setSaid}
        placeholder="A football ground is somewhere you sit and watch. That is a fun day out, not adrenaline — adrenaline is go-karting or a flying lesson."
        placeholderTextColor={colors.inkFaint}
        multiline
        style={styles.say}
      />
      <Row style={{ gap: spacing.sm, flexWrap: 'wrap' }}>
        <Button label={busy === 'read' ? 'Reading…' : 'Read that'} icon="inspire"
                disabled={!said.trim() || busy != null} onPress={() => void read()} />
        <Text style={type.tiny}>One Claude call. It fills the form below; nothing is saved until you press Teach.</Text>
      </Row>

      <View style={styles.divider} />

      <Text style={type.small}>How much of each is it?</Text>
      <View style={[styles.grid, wide && styles.gridWide]}>
        {order.map((k) => (
          <View key={k} style={[styles.weightCell, wide && { width: '48%' }]}>
            <Stepper
              label={label(k)}
              value={pc[k] ?? 0}
              min={0}
              max={100}
              onChange={(v) => setPc((prev) => ({ ...prev, [k]: v }))}
              format={(v) => meaning(v, floor)}
            />
          </View>
        ))}
      </View>

      <Text style={type.small}>Why? (kept on the rule, so it can be argued with later)</Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Watching sport is a day out; the adrenaline belongs to whoever is playing."
        placeholderTextColor={colors.inkFaint}
        style={styles.input}
      />

      {err ? <Banner tone="warn">{err}</Banner> : null}

      <Banner tone={will.length ? 'ok' : 'warn'}>
        {will.length
          ? `On the home screen this will appear under ${will.map(label).join(' and ')}.`
          : 'Nothing is above the line, so this will appear on no shelf at all — it will not be shown anywhere on the home screen.'}
      </Banner>

      <Row style={{ gap: spacing.sm, flexWrap: 'wrap' }}>
        <Button label={busy === 'save' ? 'Teaching…' : 'Teach it'} icon="check"
                disabled={busy != null || !Object.keys(weights).length} onPress={() => void save()} />
        <Button label="Cancel" kind="secondary" onPress={onClose} />
      </Row>
    </Panel>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, paddingVertical: 9, color: colors.ink, outlineStyle: 'none' as never },
  input: {
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 9, color: colors.ink, backgroundColor: colors.surface,
  },
  say: {
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 9, color: colors.ink, backgroundColor: colors.surface,
    minHeight: 72, textAlignVertical: 'top',
  },
  placeRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, flexWrap: 'wrap',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
  ruleRow: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
  rowName: { ...type.body, fontWeight: '700' },
  thumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  weights: { gap: 4, width: '100%' },
  weightsWide: { gap: 4, justifyContent: 'flex-end', maxWidth: 260 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: spacing.xs },
  grid: { gap: spacing.xs },
  gridWide: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md },
  weightCell: { width: '100%' },
});

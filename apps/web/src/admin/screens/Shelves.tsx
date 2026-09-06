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
import { asOneOf, asText, useQueryState } from '../../router';
import { MOODS } from '../../routes';

const WIDE = 900;

type Section = 'shelf' | 'find' | 'taught' | 'taxonomy';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'shelf', label: 'On a shelf' },
  { key: 'find', label: 'Find a place' },
  { key: 'taxonomy', label: 'Categories' },
  { key: 'taught', label: 'What you have taught' },
];

/** The six, as pictures. Adrenaline is a mountain because it is a thing you do. */
const SHELF_ICON: Record<MoodKey, IconName> = {
  fun: 'festival', food: 'restaurant', culture: 'museum',
  sport: 'bowling', activity: 'sport',
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
  // Which view, and which shelf is being taught, are in the address.
  const [section, setSection] = useQueryState<Section>('tab', 'shelf', asOneOf(['shelf', 'find', 'taught', 'taxonomy'] as const, 'shelf'));
  const [mood, setMood] = useQueryState<MoodKey>('mood', 'adrenaline', asOneOf(MOODS, 'adrenaline'));
  const [items, setItems] = useState<ShelfPlace[]>([]);
  const [nearly, setNearly] = useState<ShelfPlace[]>([]);
  const [pool, setPool] = useState(0);
  const [where, setWhere] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ShelfPlace[]>([]);
  // Which drawer is open is in the address like everything else, so a shelf
  // narrowed to one subcategory is a link somebody can be sent.
  const [drawer, setDrawer] = useQueryState<string>('drawer', '', asText);
  const [drawers, setDrawers] = useState<{ key: string | null; label: string; count: number }[]>([]);
  const [teaching, setTeaching] = useState<ShelfPlace | null>(null);
  /** Which row's quick picker is open. One at a time, like a menu. */
  const [moving, setMoving] = useState<string | null>(null);
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
      const d = await api.shelfContents({ mood, subcategory: drawer || undefined });
      setItems(d.items); setNearly(d.nearly); setPool(d.pool); setDrawers(d.drawers ?? []);
      setWhere(d.place.label ?? `${d.place.lat.toFixed(3)}, ${d.place.lng.toFixed(3)}`);
    } catch (err) { setItems([]); setNearly([]); setNote(String((err as Error).message)); }
  }, [mood, drawer]);

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

  /**
   * The fast one. One tap on a drawer files the place there and the shelf is
   * redrawn — no form, no reason to type, nothing to save afterwards.
   */
  const move = async (place: ShelfPlace, subcategory: string | null, category?: MoodKey) => {
    setMoving(null);
    setBusy(true);
    try {
      const r = await api.shelfMovePlace({ ref: place.ref, label: place.name, subcategory, category: category ?? null });
      const cat = vocab?.shelves.find((c) => c.key === r.category);
      const sub = vocab?.subcategories.find((sc) => sc.key === r.subcategory);
      setNote(`${place.name} → ${cat?.label ?? r.category}${sub ? ` · ${sub.label}` : ''}`);
      await refresh();
    } catch (err) { setNote(String((err as Error).message)); }
    finally { setBusy(false); }
  };

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
        Every place is filed under exactly one category and, where anybody has said so, one subcategory inside it — so
        nothing appears twice. The numbers below are how that is decided: the strongest claim wins, and naming a
        subcategory settles the category too, because a subcategory belongs to one category and only one.
      </Banner>

      <FilterRow>
        {SECTIONS.map((s) => (
          <FilterChip key={s.key} label={s.label} on={section === s.key} onPress={() => { setSection(s.key); setTeaching(null); }} />
        ))}
      </FilterRow>

      {section === 'shelf' ? (
        <>
          <FilterRow>
            {(vocab?.shelves ?? []).map((s) => (
              <FilterChip key={s.key} label={s.label} count={s.key === mood ? items.length : undefined}
                          on={mood === s.key}
                          onPress={() => { setMood(s.key); setDrawer(''); setTeaching(null); }} />
            ))}
          </FilterRow>
          {/* The drawers inside this shelf, with what is in each. "Not sorted
              yet" is the work queue and is shown even at zero, because zero is
              the number worth seeing. */}
          <FilterRow>
            <FilterChip label="All" on={!drawer} onPress={() => setDrawer('')} />
            {drawers.filter((d) => d.count > 0 || d.key === null).map((d) => (
              <FilterChip key={d.key ?? 'unsorted'} label={d.label} count={d.count}
                          on={drawer === (d.key ?? '')}
                          onPress={() => setDrawer(d.key ?? '')} />
            ))}
          </FilterRow>
        </>
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

      {section === 'shelf' || section === 'find' ? (
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
            <PlaceRow key={p.ref} place={p} wide={wide} order={order} vocab={vocab}
                      canManage={canManage} onTeach={() => setTeaching(p)} shelfLabel={shelfLabel}
                      open={moving === p.ref} onOpen={() => setMoving(moving === p.ref ? null : p.ref)}
                      onMove={(sub, cat) => move(p, sub, cat)} busy={busy} />
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
            <PlaceRow key={p.ref} place={p} wide={wide} order={order} vocab={vocab}
                      canManage={canManage} onTeach={() => setTeaching(p)} shelfLabel={shelfLabel} highlight={mood}
                      open={moving === p.ref} onOpen={() => setMoving(moving === p.ref ? null : p.ref)}
                      onMove={(sub, cat) => move(p, sub, cat)} busy={busy} />
          ))}
        </Panel>
      ) : null}

      {section === 'taxonomy' ? (
        <Taxonomy vocab={vocab} canManage={canManage} busy={busy}
                  onChanged={async (said) => { setNote(said); await refresh(); }}
                  onFailed={(said) => setNote(said)} />
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

/**
 * One place, with where it is filed and one tap to change it.
 *
 * The owner, 5 Sep 2026: "I'd like a way to be able to, on the fly, just select
 * something and change the category or subcategory very quickly from the
 * shelves page." So the row leads with the pair it is filed under, and tapping
 * that pair opens every drawer in the app. Picking one saves immediately —
 * there is no form and nothing to confirm, because the thing being asked for is
 * speed and the move is one row in a table that can be moved again.
 *
 * Opening the row itself still opens the full teaching form, which is where the
 * weights and the type-level rules live. The quick move is for this one place.
 */
function PlaceRow({ place, wide, order, vocab, canManage, onTeach, shelfLabel, highlight, open, onOpen, onMove, busy }: {
  place: ShelfPlace; wide: boolean; order: MoodKey[]; vocab: ShelfVocabulary | null; canManage: boolean;
  onTeach: () => void; shelfLabel: (k: MoodKey) => string; highlight?: MoodKey;
  open: boolean; onOpen: () => void; onMove: (subcategory: string | null, category?: MoodKey) => void; busy: boolean;
}) {
  const why = place.because[0];
  const shelf = place.shelf ?? place.shelves[0] ?? null;
  const drawer = vocab?.subcategories.find((sc) => sc.key === place.subcategory) ?? null;

  return (
    <View style={styles.placeWrap}>
      <View style={[styles.placeRow, wide && { alignItems: 'center' }]}>
        <Pressable onPress={canManage ? onTeach : undefined} style={styles.thumbTap}>
          {place.imageId ? (
            <Image source={{ uri: api.imageUrl(place.imageId, 96) }} style={styles.thumb} />
          ) : (
            <View style={[styles.thumb, styles.thumbEmpty]}><Icon name="place" size={16} color={colors.inkFaint} /></View>
          )}
        </Pressable>

        <Pressable onPress={canManage ? onTeach : undefined} style={{ flex: 1, gap: 3, minWidth: 0 }}>
          <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
            <Text style={styles.rowName} numberOfLines={1}>{place.name}</Text>
            {place.rule ? <Pill label="taught" tone="accent" /> : null}
            {place.confident === false ? <Pill label="not sure" tone="warn" /> : null}
          </Row>
          <Text style={type.tiny} numberOfLines={1}>
            {[place.region, place.distanceKm != null ? `${place.distanceKm} km` : null].filter(Boolean).join(' · ')}
          </Text>
          <Text style={type.tiny} numberOfLines={2}>
            Because {why?.subject_label ?? 'nothing has been said about it'}
            {why?.scope === 'kind' ? ' (a type rule)' : why?.scope === 'place' ? ' (a rule about this one place)' : ''}
          </Text>
        </Pressable>

        {/* Where it is filed, and the whole of the quick edit. On a phone this
            takes its own line rather than squeezing the name into three
            letters. */}
        <Wrap style={wide ? styles.weightsWide : styles.weights}>
          <Chip
            label={`${shelf ? shelfLabel(shelf) : 'nowhere'}${drawer ? ` · ${drawer.label}` : ' · not sorted'}`}
            icon={shelf ? SHELF_ICON[shelf] ?? 'place' : 'place'}
            selected={open}
            onPress={canManage ? onOpen : undefined}
          />
          {highlight && !place.shelves.includes(highlight) ? (
            <Pill label={`${shelfLabel(highlight)} ${Math.round((place.weights[highlight] ?? 0) * 100)}`} tone="warn" />
          ) : null}
        </Wrap>

        {canManage ? <Icon name={open ? 'collapse' : 'more'} size={16} color={colors.inkMuted} /> : null}
      </View>

      {open && canManage ? (
        <View style={styles.picker}>
          <Text style={type.tiny}>Move {place.name} to…</Text>
          {(vocab?.shelves ?? []).map((c) => {
            const subs = (vocab?.subcategories ?? []).filter((sc) => sc.category_key === c.key && sc.active);
            return (
              <View key={c.key} style={styles.pickerGroup}>
                <Chip
                  label={c.label}
                  icon={SHELF_ICON[c.key] ?? 'place'}
                  selected={shelf === c.key && !place.subcategory}
                  onPress={() => onMove(null, c.key)}
                />
                <Wrap style={{ gap: 4, flex: 1 }}>
                  {subs.map((sc) => (
                    <Chip key={sc.key} label={sc.label} selected={place.subcategory === sc.key}
                          onPress={() => onMove(sc.key)} />
                  ))}
                </Wrap>
              </View>
            );
          })}
          <Text style={type.tiny}>
            Picking a subcategory sets the category with it. This moves {place.name} only — to move everything of its
            type, open the row instead.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// the settings page: the two levels themselves
// ---------------------------------------------------------------------------

/**
 * Where the categories and the subcategories are read and written.
 *
 * The owner asked for "a settings page where I can see those categories and
 * subcategories" and somewhere to "add the subcategories manually". Renaming
 * never changes a key, so nothing already taught is orphaned by a change of
 * wording; moving a subcategory to another category moves every place in it,
 * which is the quickest reorganisation there is and is said so on the screen.
 */
function Taxonomy({ vocab, canManage, busy, onChanged, onFailed }: {
  vocab: ShelfVocabulary | null; canManage: boolean; busy: boolean;
  onChanged: (said: string) => Promise<void> | void; onFailed: (said: string) => void;
}) {
  const [adding, setAdding] = useState<MoodKey | null>(null);
  const [label, setLabel] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const run = async (what: () => Promise<unknown>, said: string) => {
    try { await what(); await onChanged(said); }
    catch (err) { onFailed(String((err as Error).message)); }
  };

  return (
    <>
      <Panel
        title="Categories and subcategories"
        sub="A subcategory belongs to exactly one category — that is what stops a place appearing twice. Renaming is safe; moving a subcategory moves every place in it."
        padded={false}
      >
        {(vocab?.shelves ?? []).map((c) => {
          const subs = (vocab?.subcategories ?? []).filter((sc) => sc.category_key === c.key);
          return (
            <View key={c.key} style={styles.catBlock}>
              <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
                <Icon name={SHELF_ICON[c.key] ?? 'place'} size={16} color={colors.icon} />
                <Text style={styles.rowName}>{c.label}</Text>
                <Pill label={`${subs.length} subcategor${subs.length === 1 ? 'y' : 'ies'}`} />
                {c.is_door ? <Pill label="a door into Places" tone="accent" /> : null}
                {!c.active ? <Pill label="switched off" tone="warn" /> : null}
                <View style={{ flex: 1 }} />
                {canManage ? (
                  <Chip
                    label={c.active ? 'On' : 'Off'}
                    icon={c.active ? 'check' : 'close'}
                    selected={c.active}
                    onPress={() => void run(
                      () => api.shelfSaveCategory({ key: c.key, active: !c.active }),
                      `${c.label} is ${c.active ? 'off the home screen' : 'back on the home screen'}.`,
                    )}
                  />
                ) : null}
              </Row>
              {c.blurb ? <Text style={type.tiny}>{c.blurb}</Text> : null}

              <Wrap style={{ gap: 4 }}>
                {subs.map((sc) => (
                  editing === sc.id ? (
                    <Row key={sc.id} style={{ gap: 4 }}>
                      <TextInput
                        value={editLabel}
                        onChangeText={setEditLabel}
                        style={[styles.input, { minWidth: 160 }]}
                        autoFocus
                        onSubmitEditing={() => {
                          setEditing(null);
                          void run(() => api.shelfSaveSubcategory({ id: sc.id, label: editLabel.trim() || sc.label }),
                            `Renamed to ${editLabel.trim() || sc.label}.`);
                        }}
                      />
                      <Button label="Save" icon="check" onPress={() => {
                        setEditing(null);
                        void run(() => api.shelfSaveSubcategory({ id: sc.id, label: editLabel.trim() || sc.label }),
                          `Renamed to ${editLabel.trim() || sc.label}.`);
                      }} />
                    </Row>
                  ) : (
                    <Chip
                      key={sc.id}
                      label={`${sc.label}${sc.rules ? ` · ${sc.rules}` : ''}`}
                      selected={false}
                      onPress={canManage ? () => { setEditing(sc.id); setEditLabel(sc.label); } : undefined}
                    />
                  )
                ))}
                {canManage && adding === c.key ? (
                  <Row style={{ gap: 4 }}>
                    <TextInput
                      value={label}
                      onChangeText={setLabel}
                      placeholder="Farm shops & pick your own"
                      placeholderTextColor={colors.inkFaint}
                      style={[styles.input, { minWidth: 180 }]}
                      autoFocus
                      onSubmitEditing={() => {
                        const l = label.trim();
                        setAdding(null); setLabel('');
                        if (l) void run(() => api.shelfSaveSubcategory({ categoryKey: c.key, label: l }), `Added ${l} under ${c.label}.`);
                      }}
                    />
                    <Button label="Add" icon="add" disabled={!label.trim()} onPress={() => {
                      const l = label.trim();
                      setAdding(null); setLabel('');
                      if (l) void run(() => api.shelfSaveSubcategory({ categoryKey: c.key, label: l }), `Added ${l} under ${c.label}.`);
                    }} />
                  </Row>
                ) : canManage ? (
                  <Chip label="Add one" icon="add" onPress={() => { setAdding(c.key); setLabel(''); }} />
                ) : null}
              </Wrap>

              {editing && subs.some((sc) => sc.id === editing) ? (
                <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
                  <Text style={type.tiny}>Move it to:</Text>
                  {(vocab?.shelves ?? []).filter((other) => other.key !== c.key).map((other) => (
                    <Chip key={other.key} label={other.label} onPress={() => {
                      const id = editing; setEditing(null);
                      void run(() => api.shelfSaveSubcategory({ id: id!, categoryKey: other.key }),
                        `Moved to ${other.label} — everything filed in it moved with it.`);
                    }} />
                  ))}
                  <Button label="Delete it" icon="close" kind="secondary" disabled={busy} onPress={() => {
                    const id = editing; setEditing(null);
                    void run(() => api.shelfDeleteSubcategory(id!),
                      'Gone. The places in it keep their category and stop being sorted; nothing left the home screen.');
                  }} />
                </Row>
              ) : null}
            </View>
          );
        })}
      </Panel>

      <Panel title="What this cannot do" sub="Said plainly, because both are easy to try">
        <Text style={type.small}>
          A subcategory cannot sit under two categories — the database refuses it, and that refusal is the whole reason
          a place can only appear once. If a drawer belongs in two places, it is really two drawers with different names.
        </Text>
        <Text style={type.small}>
          A category cannot be deleted while it still has subcategories in it, because that would drop every place they
          hold off the home screen without saying so. Switch it off instead — that is reversible, and nothing is lost.
        </Text>
      </Panel>
    </>
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
  // The drawer this rule files things in. Naming one settles the category too,
  // which is why the preview below reads it before the weights.
  const [sub, setSub] = useState<string | null>(null);
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
    setSub(chosen.rule?.subcategory ?? (chosen.scope === 'place' ? place.subcategory ?? null : null));
    setReason(chosen.rule?.reason ?? '');
    setErr(null);
  }, [chosen, order, place, vocab]);

  const weights: ShelfWeights = Object.fromEntries(
    order.filter((k) => (pc[k] ?? 0) > 0).map((k) => [k, (pc[k] ?? 0) / 100]),
  );
  // A drawer names its category, so the preview follows it rather than the
  // numbers whenever one is picked.
  const parent = sub ? vocab?.subcategories.find((sc) => sc.key === sub)?.category_key ?? null : null;
  const will = parent ? [parent] : drawn(weights, order, floor, max);
  const label = (k: MoodKey) => vocab?.shelves.find((s) => s.key === k)?.label ?? k;

  const save = async () => {
    setBusy('save'); setErr(null);
    try {
      await api.shelfTeach({
        scope: chosen.scope,
        subject: chosen.subject,
        subjectLabel: chosen.label,
        weights,
        subcategory: sub,
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

      <Text style={type.small}>Which subcategory?</Text>
      <Wrap style={{ gap: spacing.xs }}>
        <Chip label="None" selected={!sub} onPress={() => setSub(null)} />
        {(vocab?.subcategories ?? []).filter((sc) => sc.active).map((sc) => (
          <Chip
            key={sc.key}
            label={`${vocab?.shelves.find((c) => c.key === sc.category_key)?.label ?? sc.category_key} · ${sc.label}`}
            selected={sub === sc.key}
            onPress={() => setSub(sc.key)}
          />
        ))}
      </Wrap>
      <Text style={type.tiny}>
        Picking one settles the category as well — a subcategory belongs to exactly one category, which is what stops a
        place appearing twice. The numbers below only decide it when no subcategory is named.
      </Text>

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
                disabled={busy != null || (!Object.keys(weights).length && !sub)} onPress={() => void save()} />
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

  placeWrap: { borderTopWidth: 1, borderTopColor: colors.line },
  thumbTap: { borderRadius: radius.sm },
  // The quick move, opened under the row it belongs to rather than in a sheet:
  // it has to be obvious which place is being moved.
  picker: {
    gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md,
    backgroundColor: colors.surfaceMuted,
  },
  pickerGroup: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, flexWrap: 'wrap' },
  catBlock: {
    gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
});

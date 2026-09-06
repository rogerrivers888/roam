/**
 * Places — a county, a town or a postcode district, through one lens.
 *
 * Owner, 5 Sep 2026: "I don't like having to just see SL4 Windsor in a list.
 * That should be a proper structure where I can select a county, or I can
 * select a city, or I can select a postcode, and I can see all my stats and all
 * my data for that particular location. That's a first-class citizen."
 *
 * So the screen is a picker and a page, and the page does not change shape for
 * the three kinds. What differs is one line in the API — which column a place is
 * matched on — and nothing here knows about it.
 *
 * **The coverage strip is the click-through.** Each band is how much of one fact
 * we hold and a button that filters the list below to the ones we do not: "3 of
 * 20 have no picture" is a number and a work queue in the same control, which is
 * what the owner asked for after picking option B — "I'll click on the 100 that
 * are missing a picture, and I should then be able to see those."
 *
 * Both of those live in the address, so a queue can be sent to somebody:
 * `/admin/places?where=windsor&missing=picture`.
 *
 * Layout follows the working agreements: width from `useViewport`, one tree with
 * different styles rather than two returns, nothing over 390px.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, FactKey, Locality, LocalityPage, LocalityRow, PlaceTree } from '../../api';
import { colors, radius, spacing, type } from '../../theme';
import { Icon, IconName } from '../../components/Icon';
import { Button, Chip, Row, Wrap } from '../../components/ui';
import { useViewport } from '../../hooks/useViewport';
import { AdminPage, Banner, FilterChip, FilterRow, PageHead, Panel, Pill, Tile, TileRow, ago, count, plural } from '../kit';
import { asOneOf, asText, useQueryState } from '../../router';
import { PlaceInspector } from './PlaceInspector';

const WIDE = 1000;

/** The six facts, in the order the strip draws them, with what each one is. */
const FACTS: { key: FactKey; label: string; blank: string }[] = [
  { key: 'picture', label: 'Picture', blank: 'no card image — a household sees the category icon on mint' },
  { key: 'description', label: 'Description', blank: 'nothing to read in the drawer' },
  { key: 'hours', label: 'Hours', blank: 'we cannot say whether it is open' },
  { key: 'website', label: 'Website', blank: 'nowhere to send anybody' },
  { key: 'menu', label: 'Menu', blank: 'no dishes, so no taste table and no ordering' },
  { key: 'shelf', label: 'Shelf', blank: 'the home screen has nowhere to put it' },
];
const FACT_KEYS = FACTS.map((f) => f.key);

/** What a kind is called on screen, and its icon. */
const KIND: Record<Locality['kind'], { word: string; icon: IconName }> = {
  county: { word: 'county', icon: 'places' },
  town: { word: 'town', icon: 'household' },
  postcode: { word: 'postcode', icon: 'search' },
};

/**
 * A coverage band's shade.
 *
 * Tints of the one green rather than a red-to-green ramp — the style guide has
 * no colour-coding of rows and keeps red for the heart — and the number is
 * printed in every band, so the shade is a hint and never the information.
 */
const shadeOf = (pc: number | null) => {
  if (pc == null) return { bg: colors.surface, fg: colors.inkFaint };
  if (pc >= 90) return { bg: colors.accent, fg: colors.primaryFg };
  if (pc >= 70) return { bg: '#63B48F', fg: colors.primaryFg };
  if (pc >= 45) return { bg: '#9CD2B8', fg: colors.ink };
  if (pc >= 20) return { bg: '#C4E5D5', fg: colors.ink };
  if (pc > 0) return { bg: colors.accentSoft, fg: colors.ink };
  return { bg: colors.well, fg: colors.inkMuted };
};

export function Places({ canManage }: { canManage: boolean }) {
  const { width } = useViewport();
  const wide = width >= WIDE;

  // Which place is open, and which gap is being worked, are both the address.
  const [where, setWhere] = useQueryState<string | null>('where', null, asText);
  const [missing, setMissing] = useQueryState<FactKey | null>(
    'missing', null, asOneOf(FACT_KEYS, null as unknown as FactKey),
  );
  const [side, setSide] = useQueryState<'go' | 'eat' | null>('side', null, asOneOf(['go', 'eat'] as const, null as any));
  // Which row is open. An attraction only — a restaurant's record lives on the
  // sweep and has no atlas row to correct.
  const [openRow, setOpenRow] = useQueryState<string | null>('row', null, asText);

  const [tree, setTree] = useState<PlaceTree | null>(null);
  const [page, setPage] = useState<LocalityPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    try { setTree(await api.placeTree()); setError(null); }
    catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { loadTree(); }, [loadTree]);

  // A pass is a long job, so while one runs the screen is a progress display
  // and stops asking the moment it stops — a back office that polls for ever is
  // one that keeps a laptop awake all night.
  const running = tree?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(loadTree, 5000);
    return () => clearInterval(t);
  }, [running, loadTree]);

  // The first county with anything in it, so the screen is never empty on arrival.
  const fallback = useMemo(() => {
    const c = tree?.counties.find((x) => x.to_go_count > 0 || x.to_eat_count > 0);
    return c?.slug ?? tree?.counties[0]?.slug ?? null;
  }, [tree]);
  const open = where ?? fallback;

  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setBusy(true);
    api.locality(open, { missing: missing ?? undefined, kind: side ?? undefined, limit: 300 })
      .then((p) => { if (mine === seq.current) { setPage(p); setError(null); } })
      .catch((e: any) => { if (mine === seq.current) setError(e.message); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, [open, missing, side]);

  const go = (slug: string) => { setWhere(slug); setMissing(null); setOpenRow(null); };

  /**
   * Fill in the county you are looking at, not the country.
   *
   * The naming pass is one request a second and the atlas is tens of thousands
   * of places, so an unscoped batch of four hundred fills nothing you can see.
   * When a county is open it is named first; the whole estate is still there
   * behind the second button.
   */
  const countyOf = (p: LocalityPage | null) =>
    p?.place.kind === 'county' ? p.place.slug : p?.place.parent_slug ?? null;

  const runPass = async (which: 'postal' | 'naming', region?: string | null) => {
    setNote(null);
    try {
      await api.placePass(which, which === 'naming' ? { limit: 400, region } : { limit: 2000 });
      setNote(which === 'postal'
        ? 'Asking ONS where every place is. A hundred coordinates a request, so this is quick.'
        : `Asking OpenStreetMap what each place is called${region ? ` in ${page?.place.name ?? region}` : ''}. One a second, so the count moves slowly — leave it and come back.`);
      loadTree();
    } catch (e: any) { setNote(e.message); }
  };

  return (
    <AdminPage>
      <PageHead
        title="Places"
        sub="Every county, town and postcode district Roam holds anything in — and what it holds"
      />

      {error ? <Banner tone="crit">{error}</Banner> : null}
      {note ? <Banner tone="accent">{note}</Banner> : null}

      {tree ? (
        <TileRow>
          <Tile label="Counties" value={count(tree.counties.length)}
                sub={`${tree.counties.filter((c) => c.to_go_count > 0).length} with something in them`} />
          <Tile label="Towns" value={count(tree.counties.reduce((n, c) => n + c.towns.length, 0) + tree.orphanTowns.length)}
                sub="named by OpenStreetMap" tone="accent" />
          <Tile label="Postcode districts" value={count(tree.postcodes.length)} sub="from the ONS directory" />
          <Tile label="Not yet placed" value={count(tree.remaining)}
                sub={tree.remaining ? 'no town name — run the naming pass' : 'every place has a name'}
                tone={tree.remaining ? 'warn' : 'ok'} />
        </TileRow>
      ) : null}

      {/* One tree, two arrangements. On a phone the picker sits above the page
          rather than beside it, and neither is a different component. */}
      <View style={[styles.split, !wide && styles.splitPhone]}>
        <View style={[styles.pickerCol, !wide && styles.pickerColPhone]}>
          <Picker tree={tree} open={open} onOpen={go} wide={wide} />
        </View>

        <View style={styles.pageCol}>
          {page ? (
            <Place
              page={page} wide={wide} busy={busy}
              missing={missing} onMissing={setMissing}
              side={side} onSide={setSide}
              onOpen={go}
              openRow={openRow} onOpenRow={setOpenRow}
              onChanged={() => { setOpenRow(openRow); loadTree(); }}
            />
          ) : (
            <Panel title="Nowhere open">
              <Text style={type.small}>{busy ? 'Looking…' : 'Choose a county, a town or a postcode district.'}</Text>
            </Panel>
          )}
        </View>
      </View>

      {canManage ? (
        <Panel title="Put places into places"
               sub="Both sources are open and need no account: the ONS postcode directory says where a point is, OpenStreetMap says what it is called.">
          <Wrap>
            <Button label="Where is everything" icon="search" kind="secondary"
                    disabled={Boolean(running)} onPress={() => runPass('postal')} />
            {countyOf(page) ? (
              <Button label={`Name 400 in ${page?.place.kind === 'county' ? page.place.name : page?.place.parent_name}`} icon="download"
                      disabled={Boolean(running)} onPress={() => runPass('naming', countyOf(page))} />
            ) : null}
            <Button label={`Name 400 anywhere${tree ? ` of ${count(tree.remaining)}` : ''}`} icon="download" kind="secondary"
                    disabled={Boolean(running) || !tree?.remaining} onPress={() => runPass('naming')} />
            <Button label="Recount" icon="refresh" kind="secondary"
                    onPress={async () => { await api.placeRecount(); loadTree(); setNote('Counted again from the rows themselves.'); }} />
          </Wrap>
          {running ? (
            <Banner tone="accent">A pass has been running since {ago(running.since)}. The counts above move as it goes.</Banner>
          ) : tree?.lastPass ? (
            <Banner tone={tree.lastPass.ok ? 'ok' : 'crit'}>
              {tree.lastPass.ok
                ? `Last ${tree.lastPass.which} pass${tree.lastPass.region ? ` over ${tree.lastPass.region}` : ''}, ${ago(tree.lastPass.at)}: looked at ${count(tree.lastPass.looked ?? tree.lastPass.placed ?? 0)}, ${tree.lastPass.which === 'naming' ? `named ${count(tree.lastPass.named ?? 0)}` : `placed ${count(tree.lastPass.placed ?? 0)}`}.`
                : `The last ${tree.lastPass.which} pass fell over ${ago(tree.lastPass.at)}: ${tree.lastPass.error}`}
            </Banner>
          ) : null}
        </Panel>
      ) : null}
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------
// the picker
// ---------------------------------------------------------------------------

/**
 * Where.
 *
 * Two ladders, not one tree: the administrative one nests (a town sits in a
 * county) and the postal one does not, because SL4 spans five councils and
 * reaches into Surrey. Putting a postcode district under a county would be a
 * claim we know to be false, so they are two views of the same map and the
 * search box crosses between them.
 */
function Picker({ tree, open, onOpen, wide }: {
  tree: PlaceTree | null; open: string | null; onOpen: (slug: string) => void; wide: boolean;
}) {
  const [ladder, setLadder] = useQueryState<'admin' | 'postal'>(
    'ladder', 'admin', asOneOf(['admin', 'postal'] as const, 'admin'),
  );
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Locality[] | null>(null);
  const [nation, setNation] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await api.placeSearch(q.trim());
        if (mine === seq.current) setHits(r.places);
      } catch { /* the tree below is still usable */ }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  const counties = (tree?.counties ?? []).filter((c) => !nation || c.nation === nation);
  const nations = tree?.nations ?? [];

  return (
    <Panel title="Where" padded={false}>
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <View style={styles.search}>
          <Icon name="search" size={15} color={colors.inkMuted} />
          <TextInput
            value={q} onChangeText={setQ}
            placeholder="County, town or postcode"
            placeholderTextColor={colors.inkFaint}
            style={styles.searchInput}
            autoCapitalize="none"
          />
          {q ? (
            <Pressable onPress={() => setQ('')} accessibilityRole="button" accessibilityLabel="Clear">
              <Icon name="close" size={14} color={colors.inkMuted} />
            </Pressable>
          ) : null}
        </View>

        {hits ? null : (
          <FilterRow>
            <FilterChip label="Administrative" on={ladder === 'admin'} onPress={() => setLadder('admin')} />
            <FilterChip label="Postal" on={ladder === 'postal'} onPress={() => setLadder('postal')} />
          </FilterRow>
        )}

        {hits === null && ladder === 'admin' && nations.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }}>
            <FilterChip label="All" on={!nation} onPress={() => setNation(null)} />
            {nations.map((n) => <FilterChip key={n} label={n} on={nation === n} onPress={() => setNation(n)} />)}
          </ScrollView>
        ) : null}
      </View>

      <ScrollView style={{ maxHeight: wide ? 620 : 260 }} contentContainerStyle={{ paddingBottom: spacing.sm }}>
        {hits !== null ? (
          hits.length
            ? hits.map((h) => <Leaf key={h.slug} row={h} depth={0} on={h.slug === open} onPress={() => onOpen(h.slug)} showKind />)
            : <Text style={[type.small, { padding: spacing.md }]}>Nothing called that.</Text>
        ) : ladder === 'admin' ? (
          <>
            {counties.map((c) => (
              <React.Fragment key={c.slug}>
                <Leaf row={c} depth={0} on={c.slug === open} onPress={() => onOpen(c.slug)} />
                {c.towns.map((t) => (
                  <Leaf key={t.slug} row={t} depth={1} on={t.slug === open} onPress={() => onOpen(t.slug)} />
                ))}
              </React.Fragment>
            ))}
            {tree?.orphanTowns.length ? (
              <>
                <Text style={styles.group}>Named, but not in a county we hold</Text>
                {tree.orphanTowns.map((t) => (
                  <Leaf key={t.slug} row={t} depth={1} on={t.slug === open} onPress={() => onOpen(t.slug)} />
                ))}
              </>
            ) : null}
          </>
        ) : (
          (tree?.postcodes ?? []).map((p) => (
            <Leaf key={p.slug} row={p} depth={0} on={p.slug === open} onPress={() => onOpen(p.slug)} />
          ))
        )}
      </ScrollView>
    </Panel>
  );
}

function Leaf({ row, depth, on, onPress, showKind }: {
  row: Locality; depth: number; on: boolean; onPress: () => void; showKind?: boolean;
}) {
  const held = Number(row.to_go_count) + Number(row.to_eat_count);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ hovered }: any) => [
        styles.leaf, { paddingLeft: spacing.md + depth * 16 }, hovered && styles.leafHover, on && styles.leafOn,
      ]}
    >
      <Text style={[styles.leafName, depth > 0 && { fontWeight: '400' }, on && { fontWeight: '700' }]} numberOfLines={1}>
        {row.name}
      </Text>
      {showKind ? <Pill label={KIND[row.kind].word} /> : null}
      <Text style={type.tiny}>{held ? count(held) : '—'}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// one place
// ---------------------------------------------------------------------------

function Place({ page, wide, busy, missing, onMissing, side, onSide, onOpen, openRow, onOpenRow, onChanged }: {
  page: LocalityPage; wide: boolean; busy: boolean;
  missing: FactKey | null; onMissing: (f: FactKey | null) => void;
  side: 'go' | 'eat' | null; onSide: (s: 'go' | 'eat' | null) => void;
  onOpen: (slug: string) => void;
  openRow: string | null; onOpenRow: (id: string | null) => void;
  onChanged: () => void;
}) {
  const { place, coverage, contents, breakdown, siblings } = page;
  const gap = missing ? FACTS.find((f) => f.key === missing) : null;

  return (
    <View style={{ gap: spacing.md }}>
      {/* The breadcrumb is what says a postcode district is not inside a county:
          it names the council instead, which is true, rather than a parent,
          which would not be. */}
      <View style={styles.crumb}>
        <Icon name={KIND[place.kind].icon} size={14} color={colors.icon} />
        {place.nation ? <Text style={type.tiny}>{place.nation}</Text> : null}
        {place.parent_name ? (
          <>
            <Text style={type.tiny}>›</Text>
            <Pressable onPress={() => place.parent_slug && onOpen(place.parent_slug)} accessibilityRole="button">
              <Text style={[type.tiny, { color: colors.accent, textDecorationLine: 'underline' }]}>{place.parent_name}</Text>
            </Pressable>
          </>
        ) : null}
        <Text style={type.tiny}>›</Text>
        <Text style={[type.tiny, { color: colors.ink, fontWeight: '700' }]}>{place.name}</Text>
        <Pill label={KIND[place.kind].word} />
        {place.council && place.council !== place.name ? <Text style={type.tiny}>· {place.council}</Text> : null}
      </View>

      <TileRow>
        <Tile label="To go" value={count(coverage.toGo)}
              sub={place.kind === 'county' ? 'filed under this county' : 'here'} tone="accent" />
        <Tile label="To eat" value={count(coverage.toEat)}
              sub={coverage.toEat ? 'restaurants swept' : 'no sweep here yet'} tone={coverage.toEat ? 'accent' : 'plain'} />
        <Tile label="Pictures" value={count(place.image_count)} sub="held as bytes, ours to show" />
        {breakdown.length ? (
          <Tile
            label={`No ${breakdown[breakdown.length - 1].category}`}
            value={count(breakdown[breakdown.length - 1].n)}
            sub={`of ${coverage.toGo} — the emptiest shelf here`}
            tone={breakdown[breakdown.length - 1].n === 0 ? 'crit' : 'plain'}
          />
        ) : null}
      </TileRow>

      {/* The strip. Each band is a fact, its percentage, and a filter. */}
      <Panel title={`What we hold in ${place.name}`} sub="Tap a band to work the ones we do not">
        <View style={styles.strip}>
          {FACTS.map((f) => {
            const c = coverage.facts[f.key];
            const on = missing === f.key;
            const applies = c && c.of > 0;
            const shade = shadeOf(applies ? c.pc : null);
            return (
              <Pressable
                key={f.key}
                disabled={!applies || c.held === c.of}
                onPress={() => onMissing(on ? null : f.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${f.label}: ${applies ? `${c.pc}%` : 'not applicable here'}`}
                style={({ hovered }: any) => [
                  styles.band,
                  { backgroundColor: shade.bg },
                  hovered && applies && styles.bandHover,
                  on && styles.bandOn,
                ]}
              >
                <Text style={[styles.bandLabel, { color: shade.fg }]} numberOfLines={1}>{f.label}</Text>
                <Text style={[styles.bandPc, { color: shade.fg }]}>{applies ? `${c.pc}%` : 'n/a'}</Text>
                {applies && c.held < c.of ? (
                  <Text style={[styles.bandGap, { color: shade.fg }]}>{count(c.of - c.held)} without</Text>
                ) : (
                  <Text style={[styles.bandGap, { color: shade.fg }]}>{applies ? 'all of them' : '—'}</Text>
                )}
              </Pressable>
            );
          })}
        </View>
      </Panel>

      {openRow ? (
        <PlaceInspector id={openRow} onClose={() => onOpenRow(null)} onChanged={onChanged} />
      ) : null}

      <View style={[styles.lower, !wide && styles.lowerPhone]}>
        <View style={{ flex: wide ? 3 : undefined, minWidth: 0 }}>
          <Panel
            title={gap ? `${place.name} · without a ${gap.label.toLowerCase()}` : `Everything in ${place.name}`}
            sub={gap ? gap.blank : 'Attractions and restaurants together, best first'}
            padded={false}
          >
            <View style={{ padding: spacing.md, paddingBottom: 0, gap: spacing.sm }}>
              <FilterRow>
                <FilterChip label="Everything" on={!side} onPress={() => onSide(null)} count={coverage.toGo + coverage.toEat} />
                <FilterChip label="To go" on={side === 'go'} onPress={() => onSide(side === 'go' ? null : 'go')} count={coverage.toGo} />
                <FilterChip label="To eat" on={side === 'eat'} onPress={() => onSide(side === 'eat' ? null : 'eat')} count={coverage.toEat} />
                {gap ? (
                  <FilterChip label={`Without a ${gap.label.toLowerCase()} ✕`} on onPress={() => onMissing(null)} />
                ) : null}
              </FilterRow>
            </View>

            {!contents.length ? (
              <View style={{ padding: spacing.lg }}>
                <Text style={type.small}>
                  {busy ? 'Looking…' : gap ? `Nothing here is missing a ${gap.label.toLowerCase()}.` : 'Nothing here yet.'}
                </Text>
              </View>
            ) : contents.map((r) => (
              <LocalityRowView
                key={`${r.side}:${r.id}`} row={r} wide={wide}
                on={openRow === r.id}
                onPress={r.side === 'go' ? () => onOpenRow(openRow === r.id ? null : r.id) : undefined}
              />
            ))}
          </Panel>
        </View>

        <View style={{ flex: wide ? 2 : undefined, minWidth: 0, gap: spacing.md }}>
          <Panel title={`What ${place.name} is made of`}
                 sub="Roam's own eight words. A zero is the finding.">
            {breakdown.map((b) => (
              <Row key={b.category} style={{ justifyContent: 'space-between', paddingVertical: 3 }}>
                <Text style={[type.small, b.n === 0 && { color: colors.overrun }]}>
                  {b.category[0].toUpperCase() + b.category.slice(1)}
                </Text>
                <Text style={[type.small, { fontWeight: '700' }, b.n === 0 && { color: colors.overrun }]}>{b.n}</Text>
              </Row>
            ))}
          </Panel>

          {siblings.length ? (
            <Panel
              title={place.kind === 'county' ? 'Towns in it' : place.kind === 'postcode' ? 'Towns it covers' : 'Nearby'}
              sub={place.kind === 'postcode' ? 'A postcode district has no county — these are the towns its own places sit in' : undefined}
              padded={false}
            >
              {siblings.slice(0, 24).map((s) => (
                <Leaf key={s.slug} row={s} depth={0} on={false} onPress={() => onOpen(s.slug)} showKind />
              ))}
            </Panel>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** One row: an attraction or a restaurant, told the same way. */
function LocalityRowView({ row, wide, on, onPress }: {
  row: LocalityRow; wide: boolean; on?: boolean; onPress?: () => void;
}) {
  const held: [FactKey, boolean | null][] = [
    ['picture', row.side === 'eat' ? null : row.has_picture],
    ['description', row.has_description],
    ['hours', row.has_hours],
    ['website', row.has_website],
    ['menu', row.side === 'go' ? null : row.has_menu],
    ['shelf', row.side === 'go' ? row.has_shelf : null],
  ];
  // A restaurant has no atlas row behind it, so only an attraction opens.
  const Wrapper: any = onPress ? Pressable : View;
  return (
    <Wrapper
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={onPress ? { selected: Boolean(on) } : undefined}
      style={({ hovered }: any) => [styles.row, hovered && onPress && styles.rowHover, on && styles.rowOn]}
    >
      <View style={styles.thumb}>
        {row.hero_id ? (
          <Image source={{ uri: api.imageUrl(row.hero_id, 500) }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
        ) : (
          <Icon name={row.side === 'eat' ? 'restaurant' : 'camera'} size={14} color={colors.inkFaint} />
        )}
      </View>

      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={styles.rowName} numberOfLines={1}>{row.name}</Text>
        <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
          {row.type ? <Pill label={row.type} tone={row.side === 'eat' ? 'accent' : 'plain'} /> : null}
          {row.outcode ? <Text style={type.tiny}>{row.outcode}</Text> : null}
          {row.website ? <Text style={type.tiny} numberOfLines={1}>{row.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</Text> : null}
        </Row>
      </View>

      {/* What we hold, as six squares. The same six the strip above counts, so a
          filtered list visibly agrees with the number that produced it. */}
      <View style={styles.dots}>
        {held.map(([k, v]) => (
          <View
            key={k}
            accessibilityLabel={`${k}: ${v == null ? 'not applicable' : v ? 'held' : 'missing'}`}
            style={[styles.dot, v === true && styles.dotYes, v === false && styles.dotNo]}
          />
        ))}
      </View>

      <Text style={styles.score}>
        {row.score == null ? '—' : row.side === 'eat' ? row.score.toFixed(1) : row.score.toFixed(3)}
      </Text>
      {onPress ? <Icon name={on ? 'close' : 'forward'} size={14} color={colors.icon} /> : null}
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  split: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  splitPhone: { flexDirection: 'column' },
  pickerCol: { width: 250, flexGrow: 0, flexShrink: 0 },
  pickerColPhone: { width: '100%' },
  pageCol: { flex: 1, minWidth: 0 },

  search: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: spacing.sm, paddingVertical: 7, backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, ...type.small, color: colors.ink, outlineStyle: 'none' as any },

  group: {
    ...type.tiny, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: '700',
    paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: 2,
  },
  leaf: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    paddingRight: spacing.md, paddingVertical: 6,
  },
  leafHover: { backgroundColor: colors.well },
  leafOn: { backgroundColor: colors.well },
  leafName: { ...type.small, color: colors.ink, flex: 1, minWidth: 0, fontWeight: '600' },

  crumb: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },

  strip: { flexDirection: 'row', gap: 3, flexWrap: 'wrap' },
  band: {
    flexGrow: 1, flexBasis: 96, borderRadius: radius.sm, paddingVertical: 7, paddingHorizontal: 8,
    borderWidth: 1, borderColor: colors.line, gap: 1,
  },
  bandHover: { borderColor: colors.ink },
  bandOn: { borderColor: colors.ink, borderWidth: 2 },
  bandLabel: { ...type.tiny, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  bandPc: { ...type.body, fontWeight: '800' },
  bandGap: { ...type.tiny },

  lower: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  lowerPhone: { flexDirection: 'column' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
  thumb: {
    width: 40, height: 30, borderRadius: radius.sm, backgroundColor: colors.well,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flex: 0,
  },
  rowHover: { backgroundColor: colors.well },
  rowOn: { backgroundColor: colors.accentSoft },
  rowName: { ...type.body, fontWeight: '700' },

  dots: { flexDirection: 'row', gap: 3, flexGrow: 0, flexShrink: 0, width: 69 },
  dot: { width: 9, height: 9, borderRadius: 2.5, backgroundColor: colors.line },
  dotYes: { backgroundColor: colors.accent },
  dotNo: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.overrun },

  score: { ...type.small, fontWeight: '800', width: 52, textAlign: 'right', flexGrow: 0, flexShrink: 0 },
});

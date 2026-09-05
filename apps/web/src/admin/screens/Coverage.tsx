/**
 * Coverage — where the holes are.
 *
 * Owner, 5 Sep 2026, choosing between the three options: "B for just the high
 * level: what's missing, and A for being granular… Probably even in B, I'll
 * click on the 100 that are missing a picture, and I should then be able to see
 * those."
 *
 * So this screen is only the high level, and every cell in it is a doorway.
 * Rows are places — a county, its towns, and the postcode districts its own
 * places fall in, together, because that is how you actually compare them.
 * Columns are the six facts a household needs. A cell holds the percentage we
 * hold and, under it, how many we do not; tapping it opens Places filtered to
 * exactly those rows.
 *
 * The filter travels in the address — `/admin/places?where=berkshire&missing=picture`
 * — so a work queue is a URL somebody can be sent, which is the working
 * agreement for every page in Roam.
 *
 * **The shade is a hint, never the information.** Tints of the one green rather
 * than a red-to-amber-to-green ramp: the style guide has no colour-coding of
 * rows and keeps red for the heart. Every cell prints its own number, so the
 * table reads the same to somebody who cannot tell the shades apart.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, CoverageRow, FactKey, Locality, PlaceTree } from '../../api';
import { colors, radius, spacing, type } from '../../theme';
import { Icon } from '../../components/Icon';
import { Row } from '../../components/ui';
import { useViewport } from '../../hooks/useViewport';
import { useRouter } from '../../router';
import { AdminPage, Banner, FilterChip, FilterRow, PageHead, Panel, Pill, Tile, TileRow, count } from '../kit';
import { asText, useQueryState } from '../../router';

const WIDE = 900;

const FACTS: { key: FactKey; label: string; short: string }[] = [
  { key: 'picture', label: 'Picture', short: 'Pic' },
  { key: 'description', label: 'Description', short: 'Desc' },
  { key: 'hours', label: 'Hours', short: 'Hrs' },
  { key: 'website', label: 'Website', short: 'Web' },
  { key: 'menu', label: 'Menu', short: 'Menu' },
  { key: 'shelf', label: 'Shelf', short: 'Shelf' },
];

const KIND_WORD: Record<Locality['kind'], string> = { county: 'county', town: 'town', postcode: 'postcode' };

const shadeOf = (pc: number | null) => {
  if (pc == null) return { bg: 'transparent', fg: colors.inkFaint, edge: colors.line };
  if (pc >= 90) return { bg: colors.accent, fg: colors.primaryFg, edge: 'transparent' };
  if (pc >= 70) return { bg: '#63B48F', fg: colors.primaryFg, edge: 'transparent' };
  if (pc >= 45) return { bg: '#9CD2B8', fg: colors.ink, edge: 'transparent' };
  if (pc >= 20) return { bg: '#C4E5D5', fg: colors.ink, edge: 'transparent' };
  if (pc > 0) return { bg: colors.accentSoft, fg: colors.ink, edge: 'transparent' };
  return { bg: colors.well, fg: colors.inkMuted, edge: colors.line };
};

export function Coverage() {
  const { width } = useViewport();
  const wide = width >= WIDE;
  const { navigate } = useRouter();

  // Which part of the country the matrix is about. Empty is the whole estate,
  // one county per row; a county slug is that county and everything under and
  // across it.
  const [county, setCounty] = useQueryState<string | null>('county', null, asText);

  const [rows, setRows] = useState<CoverageRow[]>([]);
  const [tree, setTree] = useState<PlaceTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.placeTree().then(setTree).catch(() => null); }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // No county is the estate, one county per row; a county is that county,
      // its towns and the postcode districts its own places fall in.
      const out = await api.placeCoverage({ county });
      setRows(out.rows);
      setError(null);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }, [county]);
  useEffect(() => { load(); }, [load]);

  /** The one gesture this screen exists for: a cell becomes a work queue. */
  const work = (slug: string, fact: FactKey) =>
    navigate(`/admin/places?where=${encodeURIComponent(slug)}&missing=${fact}`);

  const totals = useMemo(() => {
    const gaps = rows.reduce((n, r) => n + FACTS.reduce((m, f) => {
      const c = r.facts[f.key];
      return m + (c && c.of ? c.of - c.held : 0);
    }, 0), 0);
    return {
      places: rows.reduce((n, r) => n + r.toGo + r.toEat, 0),
      gaps,
      worst: [...rows].sort((a, b) => (a.facts.picture?.pc ?? 101) - (b.facts.picture?.pc ?? 101))[0] ?? null,
    };
  }, [rows]);

  const counties = (tree?.counties ?? []).filter((c) => c.to_go_count > 0 || c.to_eat_count > 0);

  return (
    <AdminPage>
      <PageHead
        title="Coverage"
        sub="Where the holes are. Every cell is how much we hold — and a way into the ones we do not."
      />

      {error ? <Banner tone="crit">{error}</Banner> : null}

      <TileRow>
        <Tile label="Places measured" value={count(totals.places)}
              sub={`across ${rows.length} ${rows.length === 1 ? 'place' : 'places'}`} />
        <Tile label="Facts missing" value={count(totals.gaps)} sub="every gap on this screen, added up"
              tone={totals.gaps ? 'warn' : 'ok'} />
        <Tile label="Not yet placed" value={count(tree?.remaining ?? 0)}
              sub="no town name, so not on any row here"
              tone={tree?.remaining ? 'warn' : 'ok'} />
        {totals.worst ? (
          <Tile label="Thinnest for pictures" value={`${totals.worst.facts.picture?.pc ?? 0}%`}
                sub={totals.worst.name} tone="crit" onPress={() => work(totals.worst!.slug, 'picture')} />
        ) : null}
      </TileRow>

      <Panel title="Which part of the country" padded={false}>
        <View style={{ padding: spacing.md }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }}>
            <FilterChip label="Every county" on={!county} onPress={() => setCounty(null)} />
            {counties.map((c) => (
              <FilterChip key={c.slug} label={c.name} on={county === c.slug}
                          onPress={() => setCounty(county === c.slug ? null : c.slug)}
                          count={c.to_go_count + c.to_eat_count} />
            ))}
          </ScrollView>
        </View>
      </Panel>

      <Panel
        title={county ? `${counties.find((c) => c.slug === county)?.name ?? county}, and what is in it` : 'Every county that holds something'}
        sub="A county, its towns and the postcode districts its own places fall in — the two ladders on one screen"
        padded={false}
      >
        {!rows.length ? (
          <View style={{ padding: spacing.lg }}>
            <Text style={type.small}>{busy ? 'Counting…' : 'Nothing measured yet — run a harvest or a sweep.'}</Text>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={!wide}>
            <View style={{ minWidth: wide ? undefined : 620 }}>
              {/* The head. Short words on a phone, because a rotated label in a
                  390px frame is a puzzle rather than a heading. */}
              <View style={styles.head}>
                <Text style={[styles.rowHead, styles.headCell]}>Place</Text>
                {FACTS.map((f) => (
                  <Text key={f.key} style={[styles.cellHead, styles.headCell]} numberOfLines={1}>
                    {wide ? f.label : f.short}
                  </Text>
                ))}
              </View>

              {rows.map((r) => (
                <View key={r.slug} style={styles.matrixRow}>
                  <Pressable
                    onPress={() => navigate(`/admin/places?where=${encodeURIComponent(r.slug)}`)}
                    accessibilityRole="button"
                    style={({ hovered }: any) => [styles.rowHead, hovered && { backgroundColor: colors.well }]}
                  >
                    <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
                    <Row style={{ gap: 5, alignItems: 'center' }}>
                      <Text style={type.tiny}>{KIND_WORD[r.kind]}</Text>
                      <Text style={type.tiny}>· {count(r.toGo + r.toEat)}</Text>
                    </Row>
                  </Pressable>

                  {FACTS.map((f) => {
                    const c = r.facts[f.key];
                    const applies = c && c.of > 0;
                    const gap = applies ? c.of - c.held : 0;
                    const shade = shadeOf(applies ? c.pc : null);
                    return (
                      <Pressable
                        key={f.key}
                        disabled={!gap}
                        onPress={() => work(r.slug, f.key)}
                        accessibilityRole="button"
                        accessibilityLabel={
                          applies ? `${r.name}, ${f.label}: ${c.pc}% held, ${gap} without` : `${r.name}, ${f.label}: not applicable`
                        }
                        style={({ hovered }: any) => [
                          styles.cell,
                          { backgroundColor: shade.bg, borderColor: shade.edge },
                          hovered && gap ? styles.cellHover : null,
                        ]}
                      >
                        <Text style={[styles.cellPc, { color: shade.fg }]}>{applies ? `${c.pc}%` : 'n/a'}</Text>
                        <Text style={[styles.cellGap, { color: shade.fg }]} numberOfLines={1}>
                          {applies ? (gap ? `${count(gap)} without` : 'all') : '—'}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        )}

        <View style={styles.foot}>
          <Icon name="info" size={13} color={colors.inkMuted} />
          <Text style={type.tiny}>
            A fact that cannot apply to a place reads <Text style={{ fontWeight: '700' }}>n/a</Text> rather
            than 0% — a restaurant has no card picture in the atlas sense, and calling that nothing would
            make every food area look broken.
          </Text>
        </View>
      </Panel>
    </AdminPage>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', gap: 3, paddingHorizontal: spacing.md, paddingBottom: 5,
    borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  headCell: { paddingTop: spacing.sm },
  cellHead: {
    ...type.tiny, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '700',
    width: 84, textAlign: 'center',
  },
  matrixRow: {
    flexDirection: 'row', gap: 3, alignItems: 'stretch',
    paddingHorizontal: spacing.md, paddingVertical: 3,
  },
  rowHead: { width: 168, justifyContent: 'center', paddingRight: spacing.sm, gap: 1 },
  rowName: { ...type.small, fontWeight: '700', color: colors.ink },
  cell: {
    width: 84, borderRadius: radius.sm, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 6, gap: 0,
  },
  cellHover: { borderColor: colors.ink, borderWidth: 2 },
  cellPc: { ...type.small, fontWeight: '800' },
  cellGap: { ...type.tiny, fontSize: 9.5 },
  foot: {
    flexDirection: 'row', gap: spacing.xs, alignItems: 'flex-start',
    padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.line,
  },
});

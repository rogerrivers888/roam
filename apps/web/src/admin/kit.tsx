/**
 * The back office's own components — Parcelvision's reporting grammar, in
 * Roam's tokens.
 *
 * The owner asked for PV's suite mirrored: "revenue reporting, mirror that UI,
 * the stuff that we've come up with there, the side draws, the drill-downs,
 * everything" (4 Sep 2026). PV is Tailwind over the DOM and Roam is React
 * Native Web, so what is mirrored is the *grammar*, not the class names:
 *
 *  - **A stat tile is a label, a figure and a caption**, with tone as a left
 *    rule and never a coloured number. PV's own note on why: colouring the
 *    figure reads as "this number is red" rather than "this measure needs
 *    attention", and at tile size it out-shouts the whole row.
 *  - **A tile row auto-fits.** Never a fixed column count — these rows carry
 *    between two and seven tiles depending on the screen.
 *  - **A caption says what the figure counts.** Without it a tile is a bare
 *    integer whose basis lives in somebody's head.
 *  - **A gap is labelled, not drawn as a zero.** `Withheld` is the component for
 *    "you may not see this", which is a different fact from "there is nothing
 *    here" — and the API says which by returning `withheld` rather than 0.
 *
 * Nothing here reads the window: width comes from `useViewport()`, so every
 * screen works inside the shell's phone frame (CLAUDE.md).
 */

import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Icon, IconName } from '../components/Icon';
import { Row, Wrap } from '../components/ui';
import { useViewport } from '../hooks/useViewport';

// ---------------------------------------------------------------------------
// saying numbers
// ---------------------------------------------------------------------------

export const money = (usd: number | null | undefined) =>
  usd == null ? '—' : usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? '<$0.01' : '$0.00';

export const pounds = (pence: number | null | undefined) =>
  pence == null ? '—' : `£${(pence / 100).toLocaleString(undefined, { minimumFractionDigits: pence % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export const count = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());

/**
 * "1 view", "2 views" — said properly.
 *
 * Small, and worth it: a back office that says "1 views" reads as software
 * nobody finished, and it is on every row of every table here.
 */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "2h 14m", "6m", "48s" — time on site, in the units a person would say. */
export function duration(seconds: number | null | undefined): string {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60 ? `${mins % 60}m` : ''}`.trim();
}

/** "3 days ago", "today" — the same words the Accounts screen uses. */
export function ago(iso?: string | null): string {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  const months = Math.round(days / 30.4);
  return months < 24 ? `${months} month${months === 1 ? '' : 's'} ago` : `${Math.round(months / 12)} years ago`;
}

export const day = (iso?: string | null) =>
  (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString([], { month: 'short', year: '2-digit' });
};

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

export function PageHead({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <Row style={{ alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.sm }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.title}>{title}</Text>
        {sub ? <Text style={type.small}>{sub}</Text> : null}
      </View>
      {right}
    </Row>
  );
}

export type Tone = 'plain' | 'ok' | 'warn' | 'crit' | 'accent';

const RULE: Record<Tone, string> = {
  plain: colors.line,
  ok: colors.like,
  warn: colors.dislike,
  crit: colors.overrun,
  accent: colors.accent,
};

/**
 * One figure. The tone is the 4px rule down its left edge — never the number's
 * colour, which is PV's rule and the design guide's own device.
 */
export function Tile({ label, value, sub, tone = 'plain', onPress }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  onPress?: () => void;
}) {
  const body = (
    <View accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label} style={[styles.tile, { borderLeftColor: RULE[tone] }]}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      {sub ? <Text style={type.tiny}>{sub}</Text> : null}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} style={{ flexGrow: 1, flexBasis: 180 }}>{body}</Pressable> : body;
}

/** The auto-fitting row. Tiles grow to fill it, so two look right and seven do too. */
export function TileRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.tileRow}>{children}</View>;
}

/** A section of the page: a heading, an optional control on the right, a card body. */
export function Panel({ title, sub, right, children, padded = true }: {
  title?: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; padded?: boolean;
}) {
  return (
    <View style={styles.panel}>
      {title ? (
        <Row style={{ alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, paddingBottom: 0 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.panelTitle}>{title}</Text>
            {sub ? <Text style={type.tiny}>{sub}</Text> : null}
          </View>
          {right}
        </Row>
      ) : null}
      <View style={padded ? { padding: spacing.md, gap: spacing.sm } : undefined}>{children}</View>
    </View>
  );
}

/**
 * "You may not see this."
 *
 * The whole reason the API returns `withheld` instead of zeroes: an empty
 * revenue panel reads as "nobody is paying", which is a different and wrong
 * fact. PV's own revenue screen makes the same distinction on a 403.
 */
export function Withheld({ what, capability }: { what: string; capability: string }) {
  return (
    <View style={styles.withheld}>
      <Icon name="locked" size={15} color={colors.inkMuted} />
      <Text style={[type.small, { flex: 1 }]}>
        {what} is not yours to see. Ask an administrator for <Text style={styles.mono}>{capability}</Text>.
      </Text>
    </View>
  );
}

export function Banner({ tone = 'plain', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <View style={[styles.banner, { borderLeftColor: RULE[tone] }]}>
      <Text style={[type.small, { flex: 1 }]}>{children}</Text>
    </View>
  );
}

/** A small state word: a status, a plan, a role. Never a colour on its own. */
export function Pill({ label, tone = 'plain', icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const colour = RULE[tone];
  return (
    <View style={[styles.pill, { borderColor: colour }]}>
      {icon ? <Icon name={icon} size={12} color={colour} /> : null}
      <Text style={[type.tiny, { color: colors.ink }]}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

export type Column<T> = {
  key: string;
  head: string;
  /** Flex weight on a wide screen. */
  width?: number;
  align?: 'left' | 'right';
  /** What to draw. */
  cell: (row: T) => React.ReactNode;
  /** What to sort by, when the column can be sorted. */
  sort?: (row: T) => number | string;
  /** Kept off the phone layout, where there is room for three columns and no more. */
  wideOnly?: boolean;
};

/**
 * The sortable table.
 *
 * Sorting is done here rather than by asking the server again: this is an
 * estate of households, not a million rows, and a round trip per column would
 * be slower than the sort itself.
 *
 * On a phone the same rows become stacked cards — one tree, two layouts, so
 * flipping the shell's Web/Mobile toggle keeps whatever was open (CLAUDE.md).
 */
export function DataTable<T extends { id?: string }>({ rows, columns, onRow, empty, initialSort }: {
  rows: T[];
  columns: Column<T>[];
  onRow?: (row: T) => void;
  empty?: React.ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
}) {
  const { width } = useViewport();
  const wide = width >= 900;
  const [sort, setSort] = useState(initialSort ?? null);

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sort?.key);
    if (!column?.sort) return rows;
    const dir = sort?.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = column.sort!(a);
      const y = column.sort!(b);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }, [rows, columns, sort]);

  const shown = columns.filter((c) => wide || !c.wideOnly);

  if (!rows.length) return <View style={styles.empty}>{empty ?? <Text style={type.small}>Nothing here yet.</Text>}</View>;

  return (
    <View>
      {wide ? (
        <Row style={styles.head}>
          {shown.map((c) => (
            <Pressable
              key={c.key}
              disabled={!c.sort}
              onPress={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: c.key, dir: 'desc' }))}
              style={{ flex: c.width ?? 2, minWidth: 0, alignItems: c.align === 'right' ? 'flex-end' : 'flex-start' }}
            >
              <Row style={{ gap: 4 }}>
                <Text style={styles.headText}>{c.head}</Text>
                {sort?.key === c.key ? <Icon name={sort.dir === 'desc' ? 'expand' : 'collapse'} size={12} color={colors.inkMuted} /> : null}
              </Row>
            </Pressable>
          ))}
        </Row>
      ) : null}

      {sorted.map((row, i) => (
        <Pressable
          key={row.id ?? i}
          onPress={onRow ? () => onRow(row) : undefined}
          style={({ hovered }: any) => [styles.row, wide ? styles.rowWide : styles.rowNarrow, hovered && onRow ? styles.rowHover : null]}
          accessibilityRole={onRow ? 'button' : undefined}
        >
          {shown.map((c) => (
            // `minWidth: 0` is what lets a long description ellipsize instead of
            // running over the next column: a flex child's default minimum is its
            // content, so without it the text refuses to shrink.
            <View key={c.key} style={wide ? { flex: c.width ?? 2, minWidth: 0, alignItems: c.align === 'right' ? 'flex-end' : 'flex-start' } : undefined}>
              {!wide ? <Text style={styles.cellLabel}>{c.head}</Text> : null}
              {c.cell(row)}
            </View>
          ))}
        </Pressable>
      ))}
    </View>
  );
}

/** One row of filter chips above a table, PV's own arrangement: filters in one row. */
export function FilterRow({ children }: { children: React.ReactNode }) {
  return <Wrap style={{ marginBottom: spacing.sm }}>{children}</Wrap>;
}

export function FilterChip({ label, on, onPress, count: n }: { label: string; on?: boolean; onPress: () => void; count?: number }) {
  return (
    <Pressable onPress={onPress} style={[styles.filter, on && styles.filterOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[type.tiny, on && { color: colors.primaryFg }]}>{label}{n != null ? ` ${n}` : ''}</Text>
    </Pressable>
  );
}

/** The window every reporting screen is read through. Days, because that is what the API takes. */
export function RangePicker({ days, onDays }: { days: number; onDays: (d: number) => void }) {
  const options = [7, 30, 90, 365];
  return (
    <Row style={styles.range}>
      {options.map((d) => (
        <Pressable key={d} onPress={() => onDays(d)} style={[styles.rangeItem, days === d && styles.rangeItemOn]}>
          <Text style={[type.tiny, days === d && { color: colors.primaryFg, fontWeight: '700' }]}>
            {d === 365 ? '1y' : `${d}d`}
          </Text>
        </Pressable>
      ))}
    </Row>
  );
}

/** A scrollable page with the back office's own padding. */
export function AdminPage({ children }: { children: React.ReactNode }) {
  const { width } = useViewport();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[styles.page, width >= 1200 && { maxWidth: 1320, alignSelf: 'center', width: '100%' }]}>
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },

  tileRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1, flexBasis: 180, minWidth: 150,
    borderWidth: 1, borderLeftWidth: 4, borderColor: colors.line, borderRadius: radius.lg,
    backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 2,
  },
  tileLabel: { ...type.tiny, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '700', color: colors.inkMuted },
  tileValue: { ...type.h2, color: colors.ink, fontVariant: ['tabular-nums'] },

  panel: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, backgroundColor: colors.surface, overflow: 'hidden' },
  panelTitle: { ...type.small, fontWeight: '700', color: colors.ink },

  withheld: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', padding: spacing.md, backgroundColor: colors.well, borderRadius: radius.md },
  banner: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderLeftWidth: 4, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.surface },

  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },

  head: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line },
  headText: { ...type.tiny, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: '700', color: colors.inkMuted },
  row: { borderBottomWidth: 1, borderBottomColor: colors.line, minHeight: TARGET },
  rowWide: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  rowNarrow: { gap: 6, padding: spacing.md },
  rowHover: { backgroundColor: colors.well },
  cellLabel: { ...type.tiny, textTransform: 'uppercase', letterSpacing: 0.6, color: colors.inkMuted },
  empty: { padding: spacing.lg, alignItems: 'center' },

  filter: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: colors.surface },
  filterOn: { backgroundColor: colors.primary, borderColor: colors.primary },

  range: { gap: 2, backgroundColor: colors.well, borderRadius: radius.pill, padding: 2 },
  rangeItem: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill },
  rangeItemOn: { backgroundColor: colors.primary },

  mono: { fontFamily: Platform.select({ web: 'ui-monospace, SFMono-Regular, Menlo, monospace', default: 'monospace' }) },
});

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '../theme';
import { Row } from './ui';

/**
 * Spend per month as a column chart, and month-on-month / quarter-on-quarter
 * comparison (owner, 3 Sep 2026: "this is our key cost component of the
 * entire business"). One series, one hue: the selected month is the full
 * accent, the rest a lighter step of it; text stays in ink tokens. Columns
 * are thin with a rounded cap, a 2px surface gap, and a hover/tap tooltip.
 */

export type MonthValue = { month: string; costUsd: number; calls?: number; units?: number };
const money = (n: number) => (n <= 0 ? '$0.00' : n < 0.005 ? '<$0.01' : `$${n.toFixed(2)}`);
const monthLabel = (m: string, long = false) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString('en-GB', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
const quarterOf = (m: string) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`;
const pct = (now: number, before: number) => (before > 0 ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}%` : now > 0 ? 'new' : '—');

export function MonthBars({ points, selected, onSelect, height = 120, unitLabel = 'estimated spend' }: { points: MonthValue[]; selected: string; onSelect: (m: string) => void; height?: number; unitLabel?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(0.01, ...points.map((p) => p.costUsd));
  const focus = points.find((p) => p.month === (hover ?? selected)) ?? points[points.length - 1];
  return (
    <View style={{ gap: spacing.xs }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.tiny}>{unitLabel} by month</Text>
        {focus ? <Text style={[type.small, { color: colors.ink }]}>{monthLabel(focus.month, true)}: <Text style={{ fontWeight: '700' }}>{money(focus.costUsd)}</Text>{focus.calls != null ? ` · ${focus.calls} calls` : ''}{focus.units != null && focus.units !== focus.calls ? ` · ${focus.units} units` : ''}</Text> : null}
      </Row>
      <View style={[styles.plot, { height }]}>
        <View style={[styles.grid, { top: 0 }]} /><View style={[styles.grid, { top: '50%' }]} />
        {points.map((p) => {
          const on = p.month === selected;
          const h = Math.max(p.costUsd > 0 ? 3 : 1, Math.round(((height - 4) * p.costUsd) / max));
          return (
            <Pressable key={p.month} onPress={() => onSelect(p.month)} onHoverIn={() => setHover(p.month)} onHoverOut={() => setHover(null)} style={styles.slot} accessibilityRole="button" accessibilityLabel={`${monthLabel(p.month, true)}: ${money(p.costUsd)}`}>
              <View style={{ flex: 1 }} />
              <View style={[styles.bar, { height: h, backgroundColor: on ? colors.accent : p.costUsd > 0 ? colors.accentSoft : colors.line }, (hover === p.month) && { opacity: 0.85 }]} />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.axis}>
        {points.map((p, i) => <Text key={p.month} style={[type.tiny, styles.tick, p.month === selected && { color: colors.ink, fontWeight: '700' }]}>{i % (points.length > 8 ? 2 : 1) === 0 || p.month === selected ? monthLabel(p.month) : ''}</Text>)}
      </View>
    </View>
  );
}

/** The selected month against the one before, and its quarter against the one before. */
export function Comparison({ points, selected }: { points: MonthValue[]; selected: string }) {
  const rows = useMemo(() => {
    const idx = points.findIndex((p) => p.month === selected);
    const cur = points[idx]; const prev = points[idx - 1];
    const q = quarterOf(selected);
    const qPrevKey = (() => { const y = Number(q.slice(0, 4)); const n = Number(q.slice(6)); return n === 1 ? `${y - 1}-Q4` : `${y}-Q${n - 1}`; })();
    const sum = (key: string) => points.filter((p) => quarterOf(p.month) === key).reduce((a, p) => ({ costUsd: a.costUsd + p.costUsd, calls: a.calls + (p.calls ?? 0), n: a.n + 1 }), { costUsd: 0, calls: 0, n: 0 });
    const qc = sum(q); const qp = sum(qPrevKey);
    return [
      { label: 'Month on month', a: { name: monthLabel(selected, true), costUsd: cur?.costUsd ?? 0, calls: cur?.calls ?? 0 }, b: prev ? { name: monthLabel(prev.month, true), costUsd: prev.costUsd, calls: prev.calls ?? 0 } : null },
      { label: 'Quarter on quarter', a: { name: q.replace('-', ' '), costUsd: qc.costUsd, calls: qc.calls }, b: qp.n ? { name: qPrevKey.replace('-', ' '), costUsd: qp.costUsd, calls: qp.calls } : null },
    ];
  }, [points, selected]);
  return (
    <View style={{ gap: spacing.sm }}>
      {rows.map((r) => (
        <View key={r.label} style={styles.compare}>
          <Text style={type.tiny}>{r.label}</Text>
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Text style={type.tiny}>{r.a.name}</Text>
              <Text style={styles.big}>{money(r.a.costUsd)}</Text>
              <Text style={type.tiny}>{r.a.calls} calls</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={type.tiny}>{r.b?.name ?? 'No earlier period'}</Text>
              <Text style={[styles.big, { color: colors.inkMuted }]}>{r.b ? money(r.b.costUsd) : '—'}</Text>
              <Text style={type.tiny}>{r.b ? `${r.b.calls} calls` : ''}</Text>
            </View>
            <View style={{ width: 84, alignItems: 'flex-end' }}>
              <Text style={type.tiny}>change</Text>
              <Text style={[styles.big, { color: r.b && r.a.costUsd > r.b.costUsd ? colors.overrun : r.b && r.a.costUsd < r.b.costUsd ? colors.like : colors.inkMuted }]}>{r.b ? pct(r.a.costUsd, r.b.costUsd) : '—'}</Text>
              <Text style={type.tiny}>{r.b ? `${r.a.costUsd - r.b.costUsd >= 0 ? '+' : '−'}${money(Math.abs(r.a.costUsd - r.b.costUsd))}` : ''}</Text>
            </View>
          </Row>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  plot: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, borderBottomWidth: 1, borderBottomColor: colors.line, position: 'relative' },
  grid: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.surfaceMuted },
  slot: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center' },
  bar: { width: '70%', maxWidth: 24, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  axis: { flexDirection: 'row', gap: 2 },
  tick: { flex: 1, textAlign: 'center', fontSize: 10 },
  compare: { gap: 4, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  big: { fontSize: 20, fontWeight: '700', color: colors.ink, letterSpacing: -0.3 },
});

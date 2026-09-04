/**
 * The charts the reporting suite is drawn with.
 *
 * Built to the estate's visualization rules rather than to taste, because the
 * rules are the part that can be checked:
 *
 *  - **The form follows the data's job.** Change over time is a column or a
 *    line; ranking is a horizontal bar with the value at the tip; a cohort grid
 *    is ordinal, so it takes a one-hue ramp and the reader sees the order in the
 *    colour. A single headline figure is not a chart at all — it is a tile
 *    (kit.tsx), and half the "charts" a back office wants are that.
 *  - **One axis, always.** Two measures on different scales are two charts, not
 *    one with a second y-axis. Revenue is in pounds and provider cost is in
 *    dollars, so they are drawn separately and never on one pair of axes.
 *  - **Marks are thin and quiet.** Columns cap at 24px with a 4px rounded top
 *    and a square base, separated by a 2px gap in the surface colour rather than
 *    by a stroke. Lines are 2px; end markers are 8px with a 2px surface ring so
 *    they stay legible where they cross. Gridlines are hairline, solid and
 *    recessive.
 *  - **Labels are selective.** The endpoint and the extreme, never a number on
 *    every column: a value beside every mark is chaos and goes unread. The rest
 *    is carried by the axis and the hover tooltip.
 *  - **Text never wears the data colour.** Marks carry the series colour; every
 *    label, value and axis tick is an ink token.
 *
 * One series everywhere, so there is no categorical palette to validate and no
 * legend box to draw — the panel's own title says what is plotted. Colour comes
 * from Roam's accent through `useTheme`, so dark mode is the palette's own step
 * rather than an automatic flip, and red stays the heart's alone.
 */

import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';
import { colors, radius, spacing, type } from '../theme';

/** A point on any of the time charts. */
export type Point = { label: string; value: number; hint?: string };

const AXIS_H = 18;
/** Room above the tallest column for its own label, so the label never leaves the panel. */
const HEADROOM = 16;
const MAX_BAR = 24;

/** Clean round numbers for the top of an axis: 0 / 50 / 100 / 500 / 1,000. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

const shortNumber = (n: number) =>
  (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n)));

/**
 * The hover layer.
 *
 * An SVG chart on the web is interactive by default, so every mark carries one:
 * the hit target is the mark's whole column, not the drawn bar, because a 6px
 * bar is not something anybody can point at.
 */
function Tip({ text, x, width }: { text: string; x: number; width: number }) {
  // Kept inside the chart's own box: a tooltip that hangs off the right edge is
  // one the reader has to scroll to finish reading.
  const left = Math.max(0, Math.min(width - 150, x - 75));
  return (
    <View pointerEvents="none" style={[styles.tip, { left, width: 150 }]}>
      <Text style={styles.tipText}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// change over time
// ---------------------------------------------------------------------------

/**
 * Columns over time — the default for a count per day or per month.
 *
 * The extreme is labelled and the last column is labelled; nothing else is, and
 * the axis carries the rest.
 */
export function Columns({ points, height = 140, format = shortNumber, tone }: {
  points: Point[];
  height?: number;
  format?: (n: number) => string;
  tone?: string;
}) {
  const [w, setW] = useState(0);
  const [over, setOver] = useState<number | null>(null);
  const fill = tone ?? colors.accent;
  const plot = height - AXIS_H;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const slot = points.length ? w / points.length : 0;
  // Cap the bar and leave the rest of the slot as air, with a 2px surface gap
  // between neighbours — the gap does the separating, not a stroke.
  const bar = Math.max(2, Math.min(MAX_BAR, slot - 2));
  const peak = points.reduce((best, p, i) => (p.value > (points[best]?.value ?? -1) ? i : best), 0);

  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height }}>
      {w > 0 ? (
        <>
          <Svg width={w} height={height}>
            {/* Two hairlines, solid and recessive: the top of the scale and the baseline. */}
            <Line x1={0} y1={0.5} x2={w} y2={0.5} stroke={colors.line} strokeWidth={1} />
            <Line x1={0} y1={plot + 0.5} x2={w} y2={plot + 0.5} stroke={colors.line} strokeWidth={1} />
            {points.map((p, i) => {
              const h = max > 0 ? Math.max(p.value > 0 ? 2 : 0, (p.value / max) * (plot - HEADROOM)) : 0;
              const x = i * slot + (slot - bar) / 2;
              return (
                <G key={`${p.label}-${i}`}>
                  <Rect
                    x={x} y={plot - h} width={bar} height={h}
                    // 4px rounded data-end, square at the baseline: the radius is
                    // drawn on the top only by over-rounding and clipping at the base.
                    rx={Math.min(4, bar / 2)}
                    fill={fill}
                    opacity={over == null || over === i ? 1 : 0.45}
                  />
                  {h > 4 ? <Rect x={x} y={plot - Math.min(h, 4)} width={bar} height={Math.min(h, 4)} fill={fill} opacity={over == null || over === i ? 1 : 0.45} /> : null}
                </G>
              );
            })}
          </Svg>

          {/* The hit targets: a full-height column each, so a 3px bar is still pointable. */}
          <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <View style={{ flexDirection: 'row', height: plot }}>
              {points.map((p, i) => (
                <Pressable
                  key={`hit-${p.label}-${i}`}
                  style={{ width: slot }}
                  onHoverIn={() => setOver(i)}
                  onHoverOut={() => setOver((o) => (o === i ? null : o))}
                  onPress={() => setOver((o) => (o === i ? null : i))}
                  accessibilityLabel={`${p.label}: ${format(p.value)}`}
                />
              ))}
            </View>
          </View>

          {over != null && points[over] ? (
            <Tip text={`${points[over].label} · ${format(points[over].value)}${points[over].hint ? ` · ${points[over].hint}` : ''}`} x={over * slot + slot / 2} width={w} />
          ) : null}

          {/* Selective labels: the first and last tick, and the peak's value. */}
          <View style={[styles.axis, { width: w }]}>
            <Text style={styles.axisText}>{points[0]?.label ?? ''}</Text>
            <Text style={styles.axisText}>{points.length > 1 ? points[points.length - 1].label : ''}</Text>
          </View>
          {points[peak]?.value > 0 ? (
            // Above its own column rather than at the top of the box, and never
            // above the box: a label that leaves the panel is clipped, which is
            // worse than no label at all.
            <Text
              style={[styles.peak, {
                left: Math.max(0, Math.min(w - 60, peak * slot + slot / 2 - 30)),
                top: Math.max(0, plot - Math.max(2, (points[peak].value / max) * (plot - HEADROOM)) - 14),
              }]}
              numberOfLines={1}
            >
              {format(points[peak].value)}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/**
 * A line, for a measure that is continuous rather than counted in buckets —
 * time on site, a running total. 2px, with a 10% wash beneath it and one end
 * marker carrying the current value.
 */
export function TrendLine({ points, height = 140, format = shortNumber }: {
  points: Point[]; height?: number; format?: (n: number) => string;
}) {
  const [w, setW] = useState(0);
  const [over, setOver] = useState<number | null>(null);
  const plot = height - AXIS_H;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const y = (v: number) => plot - (max > 0 ? (v / max) * (plot - 8) : 0);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${i * step},${y(p.value)}`).join(' ');
  const area = points.length ? `${path} L${(points.length - 1) * step},${plot} L0,${plot} Z` : '';
  const last = points[points.length - 1];

  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height }}>
      {w > 0 && points.length ? (
        <>
          <Svg width={w} height={height}>
            <Line x1={0} y1={0.5} x2={w} y2={0.5} stroke={colors.line} strokeWidth={1} />
            <Line x1={0} y1={plot + 0.5} x2={w} y2={plot + 0.5} stroke={colors.line} strokeWidth={1} />
            <Path d={area} fill={colors.accent} opacity={0.1} />
            <Path d={path} stroke={colors.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {/* The end marker: 8px, with a 2px ring in the surface colour. */}
            <Circle cx={(points.length - 1) * step} cy={y(last.value)} r={4} fill={colors.accent} stroke={colors.surface} strokeWidth={2} />
            {over != null ? (
              <Circle cx={over * step} cy={y(points[over].value)} r={4} fill={colors.accent} stroke={colors.surface} strokeWidth={2} />
            ) : null}
          </Svg>
          <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <View style={{ flexDirection: 'row', height: plot }}>
              {points.map((p, i) => (
                <Pressable
                  key={`hit-${i}`} style={{ width: w / points.length }}
                  onHoverIn={() => setOver(i)} onHoverOut={() => setOver((o) => (o === i ? null : o))}
                  accessibilityLabel={`${p.label}: ${format(p.value)}`}
                />
              ))}
            </View>
          </View>
          {over != null ? <Tip text={`${points[over].label} · ${format(points[over].value)}`} x={over * step} width={w} /> : null}
          <View style={[styles.axis, { width: w }]}>
            <Text style={styles.axisText}>{points[0].label}</Text>
            <Text style={styles.axisText}>{last.label} · {format(last.value)}</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

/** A row-sized sparkline: no axis, no labels, no tooltip. It is a shape, not a chart. */
export function Sparkline({ values, width = 90, height = 22 }: { values: number[]; width?: number; height?: number }) {
  if (!values.length) return <View style={{ width, height }} />;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const path = values.map((v, i) => `${i ? 'L' : 'M'}${i * step},${height - (v / max) * (height - 3) - 1}`).join(' ');
  return (
    <Svg width={width} height={height}>
      <Path d={path} stroke={colors.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

/**
 * Horizontal bars, ranked, with the value at the tip — the right form for "which
 * screens do they spend their time on", where the labels are words and there are
 * more than a handful.
 */
export function RankedBars({ rows, format = shortNumber, max: given }: {
  rows: { label: string; value: number; hint?: string }[];
  format?: (n: number) => string;
  max?: number;
}) {
  const max = given ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <View style={{ gap: 6 }}>
      {rows.map((r) => (
        <View key={r.label} style={{ gap: 3 }}>
          <View style={styles.rankHead}>
            <Text style={[type.small, { flex: 1 }]} numberOfLines={1}>{r.label}</Text>
            <Text style={styles.rankValue}>{format(r.value)}</Text>
          </View>
          <View style={styles.rankTrack}>
            <View style={[styles.rankFill, { width: `${Math.max(1, (r.value / max) * 100)}%` }]} />
          </View>
          {r.hint ? <Text style={type.tiny}>{r.hint}</Text> : null}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

/**
 * The cohort grid: of the households that joined in a week, how many came back
 * in each week after.
 *
 * Ordinal, so it takes a one-hue ramp — the reader sees the magnitude in the
 * depth of the colour, and the number is written in the cell for the cases the
 * eye cannot rank. The hue is Roam's accent at stepped opacity over the surface,
 * so in dark mode the ramp anchors from the mint end rather than being flipped
 * automatically.
 */
export function CohortGrid({ cohorts, cells, weeks = 8 }: {
  cohorts: { cohort: string; size: number }[];
  cells: { cohort: string; week_no: number; households: number }[];
  weeks?: number;
}) {
  const byKey = new Map(cells.map((c) => [`${c.cohort}:${c.week_no}`, c.households]));
  if (!cohorts.length) {
    return <Text style={type.small}>No cohorts yet — retention needs a few weeks of households to have a shape.</Text>;
  }
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.cohortRow}>
        <Text style={[styles.cohortHead, { width: 92 }]}>Joined</Text>
        <Text style={[styles.cohortHead, { width: 44 }]}>Size</Text>
        {Array.from({ length: weeks }, (_, i) => (
          <Text key={i} style={[styles.cohortHead, styles.cell]}>W{i}</Text>
        ))}
      </View>
      {cohorts.map((c) => (
        <View key={c.cohort} style={styles.cohortRow}>
          <Text style={[type.tiny, { width: 92 }]}>{new Date(c.cohort).toLocaleDateString([], { day: 'numeric', month: 'short' })}</Text>
          <Text style={[type.tiny, { width: 44 }]}>{c.size}</Text>
          {Array.from({ length: weeks }, (_, i) => {
            const n = byKey.get(`${c.cohort}:${i}`) ?? 0;
            const share = c.size ? n / c.size : 0;
            return (
              <View
                key={i}
                style={[styles.cell, styles.cellBox, { backgroundColor: share > 0 ? colors.accent : 'transparent', opacity: share > 0 ? 0.15 + share * 0.85 : 1 }]}
                accessibilityLabel={`${c.cohort} week ${i}: ${n} of ${c.size}`}
              >
                <Text style={[type.tiny, { color: share > 0.55 ? colors.primaryFg : colors.ink }]}>
                  {n ? `${Math.round(share * 100)}%` : '·'}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  axis: { position: 'absolute', bottom: 0, flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { ...type.tiny, color: colors.inkMuted },
  peak: { position: 'absolute', ...type.tiny, color: colors.inkMuted, width: 60, textAlign: 'center' },

  tip: {
    position: 'absolute', top: 4, backgroundColor: colors.ink, borderRadius: radius.md,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  tipText: { ...type.tiny, color: colors.bg, textAlign: 'center' },

  rankHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  rankValue: { ...type.small, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  rankTrack: { height: 8, borderRadius: 4, backgroundColor: colors.well, overflow: 'hidden' },
  rankFill: { height: 8, borderRadius: 4, backgroundColor: colors.accent },

  cohortRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  cohortHead: { ...type.tiny, textTransform: 'uppercase', letterSpacing: 0.6, color: colors.inkMuted },
  cell: { width: 40, textAlign: 'center' },
  cellBox: {
    height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.line,
  },
});

/** Web-only nicety: hover works, touch falls back to a tap. Kept here so screens do not ask. */
export const hoverable = Platform.OS === 'web';

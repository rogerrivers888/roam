import React, { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { colors, type } from '../theme';

/**
 * A from–to slider (a budget for the day). Two handles on one track, with the
 * spread of what days like this tend to cost drawn behind it so the range means
 * something. Ink handles on a Leaf range in light mode; mint in dark.
 */
export function RangeSlider({ min, max, step = 10, low, high, onChange, format = (v) => `£${v}`, bars, plain }: {
  min: number; max: number; step?: number; low: number; high: number;
  onChange: (low: number, high: number) => void;
  format?: (v: number) => string;
  /** Relative heights 0–1 for the histogram behind the track. */
  bars?: number[];
  /**
   * The stay wizard's slider (Hotels 2 §18): a 4px track, an ink fill and two
   * 24px white handles, with the value read out above the control rather than
   * under each handle. Short, because it sits in a sheet with four more
   * questions under it.
   */
  plain?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const valueRef = useRef({ low, high });
  valueRef.current = { low, high };
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const toX = (v: number) => ((v - min) / (max - min)) * width;
  const fromX = (x: number) => clamp(min + (x / Math.max(1, widthRef.current)) * (max - min));
  const startRef = useRef({ low, high });
  const make = (which: 'low' | 'high') => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { startRef.current = { ...valueRef.current }; },
    onPanResponderMove: (_e, g) => {
      const base = startRef.current[which];
      const v = fromX(((base - min) / (max - min)) * widthRef.current + g.dx);
      if (which === 'low') onChange(Math.min(v, valueRef.current.high - step), valueRef.current.high);
      else onChange(valueRef.current.low, Math.max(v, valueRef.current.low + step));
    },
  });
  const lowPan = useRef(make('low')).current;
  const highPan = useRef(make('high')).current;
  const inRange = (i: number, n: number) => { const v = min + ((i + 0.5) / n) * (max - min); return v >= low && v <= high; };
  return (
    <View style={[styles.wrap, plain && styles.wrapPlain]} onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width; setWidth(e.nativeEvent.layout.width); }}>
      {bars?.length ? (
        <View style={styles.bars} pointerEvents="none">
          {bars.map((h, i) => <View key={i} style={[styles.bar, { height: 4 + h * 26, backgroundColor: inRange(i, bars.length) ? colors.accent : colors.line, opacity: inRange(i, bars.length) ? 0.5 : 1 }]} />)}
        </View>
      ) : null}
      <View style={[styles.track, plain && styles.trackPlain]} pointerEvents="none" />
      {width > 0 ? <View style={[styles.fill, plain && styles.fillPlain, { left: toX(low), width: Math.max(0, toX(high) - toX(low)) }]} pointerEvents="none" /> : null}
      {width > 0 ? (
        <>
          <View {...lowPan.panHandlers} style={[styles.knob, plain && styles.knobPlain, { left: toX(low) - (plain ? 12 : 14) }]} accessibilityRole="adjustable" accessibilityLabel={`From ${format(low)}`} />
          <View {...highPan.panHandlers} style={[styles.knob, plain && styles.knobPlain, { left: toX(high) - (plain ? 12 : 14) }]} accessibilityRole="adjustable" accessibilityLabel={`To ${format(high)}`} />
          {plain ? null : (
            <>
              <Text style={[styles.lbl, { left: toX(low) - 24 }]}>{format(low)}</Text>
              <Text style={[styles.lbl, { left: toX(high) - 24 }]}>{format(high)}</Text>
            </>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 74, position: 'relative', marginHorizontal: 8 },
  wrapPlain: { height: 28, marginHorizontal: 12 },
  trackPlain: { bottom: 12, height: 4, borderRadius: 2 },
  fillPlain: { bottom: 12, backgroundColor: colors.ink },
  knobPlain: { bottom: 2, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 2.5, borderColor: colors.ink },
  bars: { position: 'absolute', left: 0, right: 0, bottom: 30, height: 30, flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { flex: 1, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  track: { position: 'absolute', left: 0, right: 0, bottom: 27, height: 2, backgroundColor: colors.line },
  fill: { position: 'absolute', bottom: 26, height: 4, backgroundColor: colors.accent, borderRadius: 2 },
  knob: { position: 'absolute', bottom: 15, width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.bg },
  lbl: { position: 'absolute', bottom: -2, width: 48, textAlign: 'center', fontSize: 12, fontWeight: '600', color: colors.inkMuted },
});

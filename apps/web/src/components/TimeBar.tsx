import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '../theme';
import { Budget, OptionStop } from '../api';
import { minutes } from './ui';

/**
 * The trip as a bar: travel legs, stops, slack, intensity target, overrun.
 * "Does it fit?" should be answerable at a glance (research §5.2).
 */
export function TimeBar({
  budget,
  stops,
  compact,
  departAt,
  returnAt,
}: {
  budget: Budget;
  stops: (Pick<OptionStop, 'id' | 'name' | 'dwellMinutes'> & { waitMinutes?: number })[];
  compact?: boolean;
  departAt?: string;
  returnAt?: string;
}) {
  const scale = Math.max(budget.totalMinutes, budget.allocatedMinutes, 1);
  const segments: { key: string; minutes: number; kind: 'travel' | 'stop' | 'slack' | 'over'; label?: string }[] = [];

  budget.legs.forEach((leg, i) => {
    segments.push({ key: `leg-${i}`, minutes: leg.minutes, kind: 'travel' });
    const stop = stops[i];
    if (stop) segments.push({ key: `stop-${stop.id}`, minutes: stop.dwellMinutes + (stop.waitMinutes ?? 0), kind: 'stop', label: stop.name });
  });
  if (budget.remainingMinutes > 0) segments.push({ key: 'slack', minutes: budget.remainingMinutes, kind: 'slack' });

  const overflow = budget.allocatedMinutes > budget.totalMinutes ? budget.allocatedMinutes - budget.totalMinutes : 0;
  const targetPct = (budget.targetMinutes / scale) * 100;
  const windowPct = (budget.totalMinutes / scale) * 100;

  return (
    <View style={{ gap: 6 }}>
      {!compact && departAt && returnAt ? (
        <View style={styles.ends}>
          <Text style={type.small}>{new Date(departAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
          <Text style={type.small}>{new Date(returnAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
        </View>
      ) : null}
      <View style={[styles.bar, compact && { height: 10 }]}>
        {segments.map((s) => (
          <View
            key={s.key}
            style={{
              width: `${(s.minutes / scale) * 100}%`,
              backgroundColor: s.kind === 'travel' ? colors.travel : s.kind === 'stop' ? colors.dwell : colors.slack,
              height: '100%',
            }}
          />
        ))}
        {overflow ? (
          <View style={[styles.overflow, { left: `${windowPct}%`, width: `${(overflow / scale) * 100}%` }]} />
        ) : null}
        <View style={[styles.target, { left: `${targetPct}%` }]} />
      </View>
      {!compact ? (
        <View style={styles.legend}>
          <View style={styles.key}><View style={[styles.swatch, { backgroundColor: colors.travel }]} /><Text style={type.tiny}>travel {minutes(budget.travelMinutes)}</Text></View>
          <View style={styles.key}><View style={[styles.swatch, { backgroundColor: colors.dwell }]} /><Text style={[type.tiny, { color: colors.dwell }]}>stops {minutes(budget.dwellMinutes)}</Text></View>
          <Text style={type.tiny}>
            {budget.remainingMinutes >= 0 ? `free ${minutes(budget.remainingMinutes)}` : `over by ${minutes(-budget.remainingMinutes)}`}
          </Text>
          <View style={styles.key}><View style={styles.swatchLine} /><Text style={type.tiny}>target {Math.round(budget.targetFill * 100)}%</Text></View>
        </View>
      ) : null}
      {budget.overrun && budget.overrunStop ? (
        <Text style={[type.small, { color: colors.overrun }]}>
          Over the window — {budget.overrunStop.name} is the stop that tips it.
        </Text>
      ) : null}
      {budget.exceedsMaxTravel ? (
        <Text style={[type.small, { color: colors.dislike }]}>
          Travelling {minutes(budget.travelMinutes)} of your {minutes(budget.maxTravelMinutes ?? 0)} limit.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  ends: { flexDirection: 'row', justifyContent: 'space-between' },
  bar: {
    height: 18,
    borderRadius: 6,
    overflow: 'hidden',
    flexDirection: 'row',
    backgroundColor: colors.slack,
    position: 'relative',
  },
  target: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.ink, opacity: 0.6 },
  overflow: { position: 'absolute', top: 0, bottom: 0, backgroundColor: colors.overrun, opacity: 0.75 },
  legend: { flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap', alignItems: 'center' },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  swatchLine: { width: 2, height: 12, backgroundColor: colors.ink },
});

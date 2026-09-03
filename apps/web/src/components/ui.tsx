import React from 'react';
import { Pressable, StyleSheet, StyleProp, Text, View, ViewStyle, ActivityIndicator } from 'react-native';
import { colors, radius, spacing, type, TARGET } from '../theme';

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={type.h2}>{children}</Text>
      {hint ? <Text style={type.small}>{hint}</Text> : null}
    </View>
  );
}

type ChipTone = 'neutral' | 'allergen' | 'like' | 'dislike' | 'want' | 'accent';
const chipTones: Record<ChipTone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: colors.surfaceMuted, fg: colors.ink, border: colors.line },
  allergen: { bg: colors.allergenSoft, fg: colors.allergen, border: colors.allergen },
  like: { bg: colors.likeSoft, fg: colors.like, border: colors.likeSoft },
  dislike: { bg: colors.dislikeSoft, fg: colors.dislike, border: colors.dislikeSoft },
  want: { bg: colors.wantSoft, fg: colors.want, border: colors.wantSoft },
  accent: { bg: colors.accentSoft, fg: colors.accent, border: colors.accentSoft },
};

export function Chip({
  label,
  tone = 'neutral',
  onPress,
  onRemove,
  selected,
  icon,
}: {
  label: string;
  tone?: ChipTone;
  onPress?: () => void;
  onRemove?: () => void;
  selected?: boolean;
  icon?: string;
}) {
  const t = chipTones[tone];
  const body = (
    <View style={[styles.chip, { backgroundColor: t.bg, borderColor: selected ? colors.ink : t.border }]}>
      {icon ? <Text style={[styles.chipText, { color: t.fg }]}>{icon} </Text> : null}
      <Text style={[styles.chipText, { color: t.fg, flexShrink: 1 }]}>{label}</Text>
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={10} accessibilityLabel={`Remove ${label}`}>
          <Text style={[styles.chipText, { color: t.fg, marginLeft: 6 }]}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} style={{ maxWidth: '100%' }}>
      {body}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const bg = kind === 'primary' ? colors.accent : kind === 'danger' ? colors.overrunSoft : kind === 'secondary' ? colors.surfaceMuted : 'transparent';
  const fg = kind === 'primary' ? '#fff' : kind === 'danger' ? colors.overrun : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Stepper({
  label,
  value,
  onChange,
  min = 0,
  max = 9,
  step = 1,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
}) {
  return (
    <View style={styles.stepper}>
      <Text style={[type.small, { flex: 1 }]}>{label}</Text>
      <Pressable onPress={() => onChange(Math.max(min, value - step))} style={styles.stepBtn} accessibilityLabel={`Decrease ${label}`}>
        <Text style={styles.stepBtnText}>−</Text>
      </Pressable>
      <Text style={[type.h3, { minWidth: 56, textAlign: 'center' }]}>{format ? format(value) : value}</Text>
      <Pressable onPress={() => onChange(Math.min(max, value + step))} style={styles.stepBtn} accessibilityLabel={`Increase ${label}`}>
        <Text style={styles.stepBtnText}>+</Text>
      </Pressable>
    </View>
  );
}

export function StatusLine({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warn' | 'good' }) {
  const color = tone === 'warn' ? colors.overrun : tone === 'good' ? colors.like : colors.inkMuted;
  return <Text style={[type.small, { color }]}>{children}</Text>;
}

/**
 * How much of an allowance has gone. Colour is meaning (theme): calm until
 * 70%, amber to 90%, then the overrun red — the same scale a day's time bar uses.
 */
export function Meter({ used, limit, label }: { used: number; limit: number; label?: string }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const fill = ratio >= 0.9 ? colors.overrun : ratio >= 0.7 ? colors.dislike : colors.accent;
  return (
    <View style={{ gap: 4 }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: limit, now: Math.min(used, limit) }} accessibilityLabel={label}>
      <View style={styles.meterTrack}><View style={[styles.meterFill, { width: `${Math.round(ratio * 100)}%`, backgroundColor: fill }]} /></View>
      {label ? <Text style={type.tiny}>{label}</Text> : null}
    </View>
  );
}

export const Row = ({ children, style }: { children: React.ReactNode; style?: ViewStyle }) => (
  <View style={[styles.row, style]}>{children}</View>
);

export const Wrap = ({ children, style }: { children: React.ReactNode; style?: ViewStyle }) => (
  <View style={[styles.wrap, style]}>{children}</View>
);

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.line,
    gap: spacing.sm,
  },
  sectionTitle: { marginTop: spacing.lg, marginBottom: spacing.sm, gap: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    paddingHorizontal: 12,
    minHeight: 34,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  button: {
    minHeight: TARGET,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '700' },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: 3,
  },
  segment: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  segmentText: { fontSize: 13, color: colors.inkMuted, fontWeight: '600' },
  segmentTextActive: { color: colors.ink },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: TARGET },
  stepBtn: {
    width: TARGET, height: TARGET - 6, borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center',
  },
  stepBtnText: { fontSize: 20, color: colors.ink, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  meterTrack: { height: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, overflow: 'hidden' },
  meterFill: { height: 6, borderRadius: radius.pill },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});

export const minutes = (m: number) => {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
};

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

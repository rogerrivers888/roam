import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Take } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Avatar } from './Faces';
import { Icon } from './Icon';

export type TakeRow = { memberId: string; name: string; index: number; take: Take | null; comment: string; /** Out of 5, in halves. */ score?: number | null };

const OPTIONS: { value: Take; label: string }[] = [
  { value: 'loved', label: 'Loved it' },
  { value: 'fine', label: 'Fine' },
  { value: 'not_for_me', label: 'Not for me' },
];

/**
 * The chip to light up the instant a star is tapped.
 *
 * Display only. What is *stored* is decided by the API (routes/places.js),
 * which is sent the stars and works the take out itself — the rule has one
 * home, and this is a hint on the way to it.
 */
const takeFromScore = (score: number): Take => (score >= 4 ? 'loved' : score <= 2 ? 'not_for_me' : 'fine');

/**
 * Per person: a score out of 5 (tap a star; tap the same star again for a
 * half; once more to clear), the three words that transfer to the planner,
 * and a comment. Written in the first person so nobody reads it as a public score.
 */
export function TakePicker({ rows, onChange, subject = 'this place' }: { rows: TakeRow[]; onChange: (rows: TakeRow[]) => void; subject?: string }) {
  const update = (i: number, patch: Partial<TakeRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const tapStar = (i: number, r: TakeRow, n: number) => {
    const next = r.score === n ? n - 0.5 : r.score === n - 0.5 ? null : n;
    const score = next && next >= 0.5 ? next : null;
    update(i, { score, take: score != null && !r.take ? takeFromScore(score) : r.take });
  };
  return (
    <View style={{ gap: spacing.md }}>
      {rows.map((r, i) => (
        <View key={r.memberId} style={styles.row}>
          <View style={styles.who}>
            <Avatar name={r.name} index={r.index} size={32} />
            <Text style={type.h3}>{r.name}</Text>
            <View style={{ flex: 1 }} />
            <Text style={[type.h3, { minWidth: 34, textAlign: 'right' }]}>{r.score != null ? r.score.toFixed(1).replace('.0', '') : ''}</Text>
          </View>
          <View style={styles.stars} accessibilityRole="radiogroup" accessibilityLabel={`${r.name}'s score out of 5`}>
            {[1, 2, 3, 4, 5].map((n) => {
              const full = r.score != null && r.score >= n;
              const half = !full && r.score != null && r.score >= n - 0.5;
              return (
                <Pressable key={n} onPress={() => tapStar(i, r, n)} style={styles.star} accessibilityRole="radio" accessibilityState={{ checked: full }} accessibilityLabel={`${n} out of 5`}>
                  <Icon name={half ? 'halfStar' : 'favourite'} size={26} color={full || half ? colors.icon : colors.line} fill={full || half} />
                </Pressable>
              );
            })}
          </View>
          <View style={styles.options}>
            {OPTIONS.map((o) => {
              const on = r.take === o.value;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => update(i, { take: on ? null : o.value })}
                  style={[styles.opt, on && styles.optOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${r.name}: ${o.label}`}
                >
                  <Text style={[styles.optText, on && { color: colors.primaryFg }]}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            value={r.comment}
            onChangeText={(v) => update(i, { comment: v })}
            placeholder={`What made ${subject} that for ${r.name}?`}
            placeholderTextColor={colors.inkFaint}
            style={styles.comment}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stars: { flexDirection: 'row', gap: 2 },
  star: { width: TARGET, height: TARGET - 6, alignItems: 'center', justifyContent: 'center' },
  options: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  opt: { minHeight: 36, paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  optOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  optText: { fontSize: 13, fontWeight: '600', color: colors.ink },
  comment: { minHeight: 40, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: spacing.md, backgroundColor: colors.surface, color: colors.ink, fontSize: 14 },
});

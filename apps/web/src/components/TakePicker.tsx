import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Take } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Avatar } from './Faces';

export type TakeRow = { memberId: string; name: string; index: number; take: Take | null; comment: string };

const OPTIONS: { value: Take; label: string; tone: string }[] = [
  { value: 'loved', label: 'Loved it', tone: colors.like },
  { value: 'fine', label: 'Fine', tone: colors.inkMuted },
  { value: 'not_for_me', label: 'Not for me', tone: colors.dislike },
];

/**
 * Per person, three big targets plus the words that transfer (research §8.3).
 * Written in the first person so nobody reads it as a public score.
 */
export function TakePicker({ rows, onChange, subject = 'this place' }: { rows: TakeRow[]; onChange: (rows: TakeRow[]) => void; subject?: string }) {
  const update = (i: number, patch: Partial<TakeRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <View style={{ gap: spacing.md }}>
      {rows.map((r, i) => (
        <View key={r.memberId} style={styles.row}>
          <View style={styles.who}>
            <Avatar name={r.name} index={r.index} size={32} />
            <Text style={type.h3}>{r.name}</Text>
          </View>
          <View style={styles.options}>
            {OPTIONS.map((o) => {
              const on = r.take === o.value;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => update(i, { take: on ? null : o.value })}
                  style={[styles.opt, on && { backgroundColor: o.tone, borderColor: o.tone }]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${r.name}: ${o.label}`}
                >
                  <Text style={[styles.optText, on && { color: colors.bg }]}>{o.label}</Text>
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
  options: { flexDirection: 'row', gap: spacing.sm },
  opt: { flex: 1, minHeight: TARGET, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  optText: { fontSize: 13, fontWeight: '700', color: colors.ink },
  comment: { minHeight: 40, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 14, color: colors.ink },
});

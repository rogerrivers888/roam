import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { Chip } from './ui';
import { colors, radius, spacing, type } from '../theme';

/**
 * A dropdown that opens where it was tapped.
 *
 * The chips over a list — Type, Mood, A–Z — used to open a sheet pinned to the
 * bottom of the window, which put the answer half a screen away from the
 * question (owner, 5 Sep 2026: "it brings up a dropdown at the bottom of the
 * page. I don't like that at all. I think it should be right there in line
 * because it's very awkward"). So it is a panel directly under the row of
 * chips, in the flow of the page, the same shape Inspire's filter bar has.
 *
 * The options are chips, so a filter with three answers is three taps wide
 * rather than a list of three rows, and a filter with nothing to offer says so
 * in words instead of opening an empty box — the other half of the complaint.
 */
export function PickPanel({ open, title, options, value, empty, onPick, onClose }: {
  open: boolean;
  title: string;
  /** The first option clears the filter ("Any kind"); the rest carry counts. */
  options: { value: string; label: string; count?: number }[];
  value: string;
  /** What to say when the only option is "any" — there is nothing here to filter by. */
  empty?: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  // The first option is the one that clears the filter — "Any kind", "All",
  // "A–Z". It never carries a count, and it is not what makes the panel worth
  // opening: if it is the only one, there is nothing here to filter by.
  const rest = options.slice(1);
  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
          <Icon name="close" size={16} color={colors.inkMuted} />
        </Pressable>
      </View>
      {rest.length ? (
        <View style={styles.wrap}>
          {options.map((o, i) => (
            <Chip
              key={o.value || 'any'}
              label={i && o.count != null ? `${o.label} · ${o.count}` : o.label}
              selected={o.value === value}
              onPress={() => onPick(o.value)}
            />
          ))}
        </View>
      ) : (
        <Text style={type.small}>{empty ?? 'Nothing here to choose from yet.'}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  title: { ...type.small, color: colors.inkMuted, fontWeight: '600' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});

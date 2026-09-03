import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, Suggestion } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';

/**
 * Type a taste, get pills. Free text is always allowed — the suggestions are a
 * helping hand toward the shared vocabulary, so "spaghetti arribata" lands on
 * the same concept as "penne all'arrabbiata" (Epic 2 C6).
 */
export function SuggestInput({
  placeholder,
  kinds,
  onPick,
  onFree,
  autoFocus,
}: {
  placeholder: string;
  kinds?: string[];
  onPick: (s: Suggestion) => void | Promise<void>;
  onFree: (text: string) => void | Promise<void>;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<any>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!text.trim()) { setItems([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await api.suggest(text, kinds, 6);
        setItems(r.suggestions);
        setOpen(true);
      } catch { setItems([]); }
    }, 160);
    return () => clearTimeout(timer.current);
  }, [text, kinds?.join(',')]);

  const commitFree = async () => {
    const v = text.trim();
    if (!v) return;
    setText(''); setItems([]); setOpen(false);
    await onFree(v);
  };

  const pick = async (s: Suggestion) => {
    setText(''); setItems([]); setOpen(false);
    await onPick(s);
  };

  return (
    <View style={{ gap: 6 }}>
      <View style={styles.row}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={colors.inkFaint}
          style={styles.input}
          autoFocus={autoFocus}
          onFocus={() => items.length && setOpen(true)}
          onSubmitEditing={() => (items[0] && items[0].score >= 0.8 ? pick(items[0]) : commitFree())}
          returnKeyType="done"
          autoCapitalize="none"
        />
        <Pressable onPress={commitFree} style={styles.add} accessibilityRole="button" accessibilityLabel="Add as typed">
          <Text style={styles.addText}>Add</Text>
        </Pressable>
      </View>
      {open && items.length ? (
        <View style={styles.pills}>
          {items.map((s) => (
            <Pressable key={s.key} onPress={() => pick(s)} style={styles.pill} accessibilityRole="button">
              <Text style={styles.pillText}>{s.label}</Text>
              <Text style={styles.pillKind}>{s.kind}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {text.trim() && open && !items.length ? (
        <Text style={type.tiny}>No match in the vocabulary — "Add" keeps it exactly as typed.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    flex: 1, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  add: { minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  addText: { fontWeight: '700', color: colors.ink },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: {
    flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingHorizontal: 12, minHeight: 36,
    borderRadius: radius.pill, backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentSoft,
  },
  pillText: { fontSize: 13, fontWeight: '700', color: colors.accent, lineHeight: 34 },
  pillKind: { fontSize: 10, color: colors.accent, opacity: 0.7 },
});

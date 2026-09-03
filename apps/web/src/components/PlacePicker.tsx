import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, Place } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';

/**
 * Type a place, pick from real matches. Used for home, trip origins and
 * destinations, and "search near". Results are geocoded on the API side.
 */
export function PlacePicker({
  value,
  placeholder = 'Town, address or landmark',
  onPick,
  extra,
}: {
  value: Place | null;
  placeholder?: string;
  onPick: (p: Place | null) => void;
  /** Extra fixed choices shown first, e.g. Home. */
  extra?: Place[];
}) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [attribution, setAttribution] = useState('');
  const timer = useRef<any>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length < 3) { setItems([]); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.geocode(text, 5);
        setItems(r.results);
        setAttribution(r.attribution);
      } catch { setItems([]); } finally { setBusy(false); }
    }, 350);
    return () => clearTimeout(timer.current);
  }, [text]);

  if (value) {
    return (
      <View style={styles.chosen}>
        <View style={{ flex: 1 }}>
          <Text style={type.h3}>{value.label}</Text>
          {value.displayName ? <Text style={type.tiny} numberOfLines={1}>{value.displayName}</Text> : null}
        </View>
        <Pressable onPress={() => onPick(null)} style={styles.change} accessibilityRole="button"><Text style={type.small}>Change</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={{ gap: 6 }}>
      {extra?.length ? (
        <View style={styles.pills}>
          {extra.map((p) => (
            <Pressable key={p.label} onPress={() => onPick(p)} style={styles.pill}><Text style={styles.pillText}>{p.label}</Text></Pressable>
          ))}
        </View>
      ) : null}
      <TextInput value={text} onChangeText={setText} placeholder={placeholder} placeholderTextColor={colors.inkFaint} style={styles.input} autoCapitalize="words" />
      {busy ? <Text style={type.tiny}>Looking…</Text> : null}
      {items.map((p, i) => (
        <Pressable key={`${p.lat},${p.lng},${i}`} onPress={() => { onPick(p); setText(''); setItems([]); }} style={styles.result} accessibilityRole="button">
          <Text style={type.h3}>{p.label}</Text>
          <Text style={type.tiny} numberOfLines={1}>{p.displayName}</Text>
        </Pressable>
      ))}
      {items.length ? <Text style={type.tiny}>{attribution}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  result: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, gap: 2 },
  chosen: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  change: { minHeight: TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { paddingHorizontal: 12, minHeight: 36, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line },
  pillText: { fontSize: 13, fontWeight: '600', color: colors.ink },
});

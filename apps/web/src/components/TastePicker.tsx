import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Row, Wrap } from './ui';

type Item = { key: string; label: string; children: { key: string; label: string }[] };
type Group = { title: string; hint: string; items: Item[] };
type Browse = { food: Group[]; activities: Group[]; diets: { key: string; label: string }[] };

/**
 * Pick by tapping, not typing (owner feedback): broad things first — Italian,
 * Healthy food, Museums — each expandable into its common specifics so ten
 * favourites are ten taps. Keep it broad unless something is a real favourite.
 */
export function TastePicker({
  section,
  mode,
  already,
  onAdd,
  onClose,
}: {
  section: 'food' | 'activities';
  mode: 'like' | 'dislike';
  already: Set<string>;           // concept keys this person already has (any kind)
  onAdd: (picked: { key: string; label: string }[]) => Promise<void>;
  onClose: () => void;
}) {
  const [data, setData] = useState<Browse | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.browse().then(setData).catch(() => setData(null)); }, []);

  const toggle = (key: string, label: string) => setPicked((m) => { const n = new Map(m); n.has(key) ? n.delete(key) : n.set(key, label); return n; });
  const groups = data ? (section === 'food' ? data.food : data.activities) : [];

  return (
    <View style={styles.panel}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={type.h3}>{mode === 'like' ? 'Pick what they like' : "Pick what they'd rather not"}</Text>
          <Text style={type.tiny}>Tap the broad ones. Open ▸ to add specific favourites.</Text>
        </View>
        <Button label="Close" kind="ghost" onPress={onClose} />
      </Row>
      {!data ? <Text style={type.small}>Loading…</Text> : null}
      {groups.map((g) => (
        <View key={g.title} style={{ gap: 6 }}>
          <Text style={type.h3}>{g.title}</Text>
          {g.hint ? <Text style={type.tiny}>{g.hint}</Text> : null}
          <Wrap>
            {g.items.map((it) => {
              const have = already.has(it.key);
              const on = picked.has(it.key);
              const expanded = open.has(it.key);
              return (
                <View key={it.key} style={{ flexDirection: 'row', gap: 2 }}>
                  <Pressable
                    onPress={() => !have && toggle(it.key, it.label)}
                    style={[styles.pill, have && styles.pillHave, on && styles.pillOn, it.children.length ? styles.pillLeft : null]}
                    accessibilityRole="button" accessibilityState={{ selected: on || have }}
                  >
                    <Text style={[styles.pillText, (on || have) && { color: '#fff' }]}>{have ? '✓ ' : ''}{it.label}</Text>
                  </Pressable>
                  {it.children.length ? (
                    <Pressable onPress={() => setOpen((s) => { const n = new Set(s); n.has(it.key) ? n.delete(it.key) : n.add(it.key); return n; })} style={[styles.pill, styles.pillRight, expanded && styles.pillExpanded]} accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${it.label} dishes`}>
                      <Text style={styles.pillText}>{expanded ? '▾' : '▸'}</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </Wrap>
          {g.items.filter((it) => open.has(it.key)).map((it) => (
            <View key={`${it.key}-children`} style={styles.children}>
              <Text style={type.tiny}>{it.label} — favourites</Text>
              <Wrap>
                {it.children.map((c) => {
                  const have = already.has(c.key);
                  const on = picked.has(c.key);
                  return (
                    <Pressable key={c.key} onPress={() => !have && toggle(c.key, c.label)} style={[styles.pill, styles.pillSmall, have && styles.pillHave, on && styles.pillOn]} accessibilityRole="button" accessibilityState={{ selected: on || have }}>
                      <Text style={[styles.pillText, { fontSize: 12 }, (on || have) && { color: '#fff' }]}>{have ? '✓ ' : ''}{c.label}</Text>
                    </Pressable>
                  );
                })}
              </Wrap>
            </View>
          ))}
        </View>
      ))}
      <Row style={{ justifyContent: 'flex-end' }}>
        <Text style={type.small}>{picked.size ? `${picked.size} selected` : 'Nothing selected yet'}</Text>
        <Button label={`Add ${picked.size || ''}`.trim()} disabled={!picked.size} loading={busy} onPress={async () => {
          setBusy(true);
          try { await onAdd([...picked.entries()].map(([key, label]) => ({ key, label }))); setPicked(new Map()); } finally { setBusy(false); }
        }} />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line },
  pill: { minHeight: 36, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' },
  pillLeft: { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
  pillRight: { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingHorizontal: 8 },
  pillExpanded: { backgroundColor: colors.accentSoft },
  pillOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillHave: { backgroundColor: colors.inkFaint, borderColor: colors.inkFaint },
  pillSmall: { minHeight: 32 },
  pillText: { fontSize: 13, fontWeight: '600', color: colors.ink },
  children: { padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface, gap: 6 },
});

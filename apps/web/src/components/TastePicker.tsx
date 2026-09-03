import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Button, Row, Wrap } from './ui';
import { Icon } from './Icon';

type Leaf = { key: string; label: string };
type Item = Leaf & { children: Leaf[] };
type Group = { title: string; hint: string; items: Item[] };
type Browse = { food: Group[]; activities: Group[]; diets: Leaf[] };

/**
 * Pick by tapping, not typing (owner feedback): broad things first — Italian,
 * Healthy food, Museums — each expandable into its common specifics.
 *
 * A tap adds straight away; there is no basket and no Add button (owner, 3
 * Sep 2026: "just select and close"). Anything this person already has, on
 * either list, is left out entirely — a thing in Loves doing has no business
 * appearing in Would rather not.
 */
export function TastePicker({
  section,
  mode,
  already,
  onPick,
  onClose,
}: {
  section: 'food' | 'activities';
  mode: 'like' | 'dislike';
  already: Set<string>;           // concept keys this person already has (any kind)
  onPick: (item: Leaf) => Promise<void>;
  onClose: () => void;
}) {
  const [data, setData] = useState<Browse | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { api.browse().then(setData).catch(() => setData(null)); }, []);

  const pick = async (leaf: Leaf) => {
    if (busy) return;
    setBusy(leaf.key);
    try { await onPick(leaf); } finally { setBusy(null); }
  };
  const groups = data ? (section === 'food' ? data.food : data.activities) : [];
  const visible = groups
    .map((g) => ({ ...g, items: g.items.filter((it) => !already.has(it.key) || it.children.some((c) => !already.has(c.key))) }))
    .filter((g) => g.items.length);

  return (
    <View style={styles.panel}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={type.h3}>{mode === 'like' ? 'Tap what they like' : "Tap what they'd rather not"}</Text>
          <Text style={type.tiny}>Each tap adds it. Tap the arrow beside a broad one for its specifics.</Text>
        </View>
        <Button label="Close" kind="ghost" onPress={onClose} />
      </Row>
      {!data ? <Text style={type.small}>Loading…</Text> : null}
      {visible.map((g) => (
        <View key={g.title} style={{ gap: 6 }}>
          <Text style={type.h3}>{g.title}</Text>
          {g.hint ? <Text style={type.tiny}>{g.hint}</Text> : null}
          <Wrap>
            {g.items.map((it) => {
              const have = already.has(it.key);
              const expanded = open.has(it.key);
              const kids = it.children.filter((c) => !already.has(c.key));
              return (
                <View key={it.key} style={{ flexDirection: 'row', gap: 2 }}>
                  {have ? null : (
                    <Pressable
                      onPress={() => pick(it)}
                      disabled={busy === it.key}
                      style={[styles.pill, kids.length ? styles.pillLeft : null, busy === it.key && { opacity: 0.5 }]}
                      accessibilityRole="button"
                    >
                      <Text style={styles.pillText}>{it.label}</Text>
                    </Pressable>
                  )}
                  {kids.length ? (
                    <Pressable onPress={() => setOpen((s) => { const n = new Set(s); n.has(it.key) ? n.delete(it.key) : n.add(it.key); return n; })} style={[styles.pill, have ? null : styles.pillRight, expanded && styles.pillExpanded]} accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${it.label} dishes`}>
                      {have ? <Text style={styles.pillText}>{it.label}</Text> : null}<Icon name={expanded ? 'expand' : 'more'} size={14} color={colors.ink} />
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </Wrap>
          {g.items.filter((it) => open.has(it.key)).map((it) => {
            const kids = it.children.filter((c) => !already.has(c.key));
            if (!kids.length) return null;
            return (
              <View key={`${it.key}-children`} style={styles.children}>
                <Text style={type.tiny}>{it.label} — specifics</Text>
                <Wrap>
                  {kids.map((c) => (
                    <Pressable key={c.key} onPress={() => pick(c)} disabled={busy === c.key} style={[styles.pill, styles.pillSmall, busy === c.key && { opacity: 0.5 }]} accessibilityRole="button">
                      <Text style={[styles.pillText, { fontSize: 12 }]}>{c.label}</Text>
                    </Pressable>
                  ))}
                </Wrap>
              </View>
            );
          })}
        </View>
      ))}
      {data && !visible.length ? <Text style={type.small}>Everything here is already on one of their lists.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line },
  pill: { minHeight: 36, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' },
  pillLeft: { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
  pillRight: { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingHorizontal: 8 },
  pillExpanded: { backgroundColor: colors.accentSoft },
  pillSmall: { minHeight: 32 },
  pillText: { fontSize: 13, fontWeight: '600', color: colors.ink },
  children: { padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface, gap: 6 },
});

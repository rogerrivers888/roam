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
  near,
  countryCode,
  kind,
}: {
  value: Place | null;
  placeholder?: string;
  onPick: (p: Place | null) => void;
  /** Extra fixed choices shown first, e.g. Home. */
  extra?: Place[];
  /** Look here first — the city a trip is in — so "Hilton" for Rome is not London's Hiltons. */
  near?: Place | null;
  /** Never leave this country (ISO code, e.g. IT). */
  countryCode?: string | null;
  /** What is being looked for: 'lodging' also tries "<name> hotel". */
  kind?: 'lodging' | null;
}) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<(Place & { matchedBy?: string; approximate?: boolean })[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState('');
  const [attribution, setAttribution] = useState('');
  const timer = useRef<any>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length < 3) { setItems([]); setSearched(''); return; }
    // Wait for a pause in typing: each lookup is a real request to a shared, rate-limited service.
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.geocode(text, 5, { near, country: countryCode ?? near?.countryCode ?? null, kind });
        setItems(r.results as any);
        setAttribution(r.attribution);
        setSearched(text);
      } catch { setItems([]); setSearched(text); } finally { setBusy(false); }
    }, 600);
    return () => clearTimeout(timer.current);
  }, [text, near?.lat, near?.lng, countryCode, kind]);

  const biasName = near ? (near.locality ?? near.label) : null;

  const choose = (p: Place) => { onPick(p); setEditing(false); setText(''); setItems([]); };

  if (value && !editing) {
    return (
      <View style={styles.chosen}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.h3}>{value.formatted ?? value.label}</Text>
          {value.address ? (
            <Text style={type.small}>
              {[value.address.town, value.address.region, value.address.postcode, value.address.country].filter(Boolean).join(' · ')}
            </Text>
          ) : value.country ? <Text style={type.small}>{[value.locality, value.country].filter(Boolean).join(' · ')}</Text> : null}
          {value.approximate ? <Text style={type.tiny}>Pin placed by {value.matchedBy} — the map data has no exact entry for this address.</Text> : null}
        </View>
        <Pressable onPress={() => setEditing(true)} style={styles.change} accessibilityRole="button"><Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>Change</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={{ gap: 6 }}>
      {extra?.length ? (
        <View style={styles.pills}>
          {extra.map((p) => (
            <Pressable key={p.label} onPress={() => choose(p)} style={styles.pill}><Text style={styles.pillText}>{p.label}</Text></Pressable>
          ))}
        </View>
      ) : null}
      <TextInput value={text} onChangeText={setText} placeholder={placeholder} placeholderTextColor={colors.inkFaint} style={styles.input} autoCapitalize="words" onSubmitEditing={() => { if (items[0]) choose(items[0]); }} returnKeyType="search" autoFocus={editing} />
      {value && editing ? <Pressable onPress={() => { setEditing(false); setText(''); setItems([]); }} style={styles.change}><Text style={type.small}>Cancel — keep "{value.formatted ?? value.label}"</Text></Pressable> : null}
      {biasName ? <Text style={type.tiny}>Looking in {biasName}{near?.country ? `, ${near.country}` : ''} first{countryCode || near?.countryCode ? ' — results stay in the same country' : ''}.</Text> : null}
      {busy ? <Text style={type.tiny}>Looking…</Text> : null}
      {items.map((p, i) => (
        <Pressable key={`${p.lat},${p.lng},${i}`} onPress={() => choose(p)} style={styles.result} accessibilityRole="button">
          <View style={{ flex: 1 }}>
            <Text style={type.h3}>{p.formatted ?? p.label}</Text>
            <Text style={type.tiny} numberOfLines={2}>{p.approximate ? p.displayName : [p.address?.town, p.address?.postcode, p.country].filter(Boolean).join(' · ')}</Text>
          </View>
          <View style={styles.use}><Text style={styles.useText}>Use this</Text></View>
        </Pressable>
      ))}
      {!busy && searched && searched === text && items.length === 0 ? (
        <Text style={[type.small, { color: colors.dislike }]}>
          Nothing matched "{searched}"{biasName ? ` in or around ${biasName}` : ''}. Try the postcode on its own, or the street and town without the house name.
        </Text>
      ) : null}
      {items.length ? <Text style={type.tiny}>{attribution} · Tap a result to use it.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  result: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  use: { minHeight: 36, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: colors.accent, justifyContent: 'center' },
  useText: { color: colors.bg, fontWeight: '700', fontSize: 13 },
  chosen: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  change: { minHeight: TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { paddingHorizontal: 12, minHeight: 36, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line },
  pillText: { fontSize: 13, fontWeight: '600', color: colors.ink },
});

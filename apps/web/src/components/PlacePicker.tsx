import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, Place } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Icon } from './Icon';
import { useHere } from '../hooks/useHere';

/**
 * Type a place, pick from real matches. Used for home, trip origins and
 * destinations, and "search near". Results are geocoded on the API side.
 *
 * `kind="area"` is a different question and a different index: cities, towns
 * and regions only, matched on what has been typed so far, searched as the
 * words arrive rather than on a pause (owner, 4 Sep 2026 — "If I type BAT, it
 * should immediately start searching for cities or regions beginning BAT…
 * It should only look up cities beginning with Bath, not streets beginning
 * with Bath"). An address still needs the slower, exact lookup: it makes up to
 * four requests as it degrades from house name to postcode to town.
 */
export function PlacePicker({
  value,
  placeholder = 'Town, address or landmark',
  onPick,
  onText,
  extra,
  here,
  near,
  countryCode,
  kind,
  autoFocus,
}: {
  value: Place | null;
  placeholder?: string;
  onPick: (p: Place | null) => void;
  /** What is in the box, for a form that can also accept a name nothing matched. */
  onText?: (text: string) => void;
  /** Extra fixed choices shown first, e.g. Home. */
  extra?: Place[];
  /** Offer "Where I am" beside them: the device is asked only when it is tapped. */
  here?: boolean;
  /** Look here first — the city a trip is in — so "Hilton" for Rome is not London's Hiltons. */
  near?: Place | null;
  /** Never leave this country (ISO code, e.g. IT). */
  countryCode?: string | null;
  /** What is being looked for: 'lodging' also tries "<name> hotel"; 'area' is cities and regions only. */
  kind?: 'lodging' | 'area' | null;
  autoFocus?: boolean;
}) {
  const areas = kind === 'area';
  const me = useHere();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<(Place & { matchedBy?: string; approximate?: boolean })[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState('');
  const [attribution, setAttribution] = useState('');
  const timer = useRef<any>(null);
  // The last search wins even if an earlier one answers after it, and a question
  // already asked is answered from here rather than asked again — which is what
  // makes backspacing a letter instant.
  const seq = useRef(0);
  const seen = useRef(new Map<string, (Place & { matchedBy?: string })[]>()).current;

  const least = areas ? 2 : 3;
  const pause = areas ? 160 : 600;

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = text.trim();
    if (q.length < least) { setItems([]); setSearched(''); setBusy(false); return; }
    const key = `${q.toLowerCase()}|${countryCode ?? ''}|${near?.lat ?? ''}`;
    const held = seen.get(key);
    if (held) { setItems(held); setSearched(text); setBusy(false); return; }
    const mine = ++seq.current;
    setBusy(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await api.geocode(q, areas ? 6 : 5, { near, country: countryCode ?? near?.countryCode ?? null, kind });
        seen.set(key, r.results as any);
        if (mine !== seq.current) return;
        setItems(r.results as any);
        setAttribution(r.attribution);
        setSearched(text);
      } catch {
        if (mine !== seq.current) return;
        setItems([]); setSearched(text);
      } finally { if (mine === seq.current) setBusy(false); }
    }, pause);
    return () => clearTimeout(timer.current);
  }, [text, near?.lat, near?.lng, countryCode, kind]);

  const biasName = !areas && near ? (near.locality ?? near.label) : null;

  const type_ = (t: string) => { setText(t); onText?.(t); };
  const choose = (p: Place) => { onPick(p); setEditing(false); setText(''); onText?.(''); setItems([]); };

  if (value && !editing) {
    return (
      <View style={styles.chosen}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.h3}>{value.formatted ?? value.label}</Text>
          {value.where ? <Text style={type.small}>{value.where}</Text>
            : value.address ? (
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
      {extra?.length || (here && me.supported) ? (
        <View style={styles.pills}>
          {extra?.map((p) => (
            <Pressable key={p.label} onPress={() => choose(p)} style={styles.pill}><Text style={styles.pillText}>{p.label}</Text></Pressable>
          ))}
          {/* Nothing is asked of the device until this is pressed. */}
          {here && me.supported ? (
            <Pressable
              onPress={async () => { const p = await me.ask(); if (p) choose(p); }}
              disabled={me.busy}
              style={[styles.pill, styles.herePill]}
              accessibilityRole="button"
            >
              {me.busy ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="here" size={14} color={colors.accent} />}
              <Text style={[styles.pillText, { color: colors.accent }]}>{me.busy ? 'Finding you…' : 'Where I am'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {here && me.error ? <Text style={[type.tiny, { color: colors.dislike }]}>{me.error}</Text> : null}
      <View style={styles.box}>
        <Icon name={areas ? 'place' : 'search'} size={16} color={colors.inkFaint} />
        <TextInput value={text} onChangeText={type_} placeholder={placeholder} placeholderTextColor={colors.inkFaint} style={styles.boxInput} autoCapitalize="words" autoCorrect={false} onSubmitEditing={() => { if (items[0]) choose(items[0]); }} returnKeyType="search" autoFocus={autoFocus || editing} />
        {busy ? <ActivityIndicator size="small" color={colors.inkFaint} /> : null}
      </View>
      {value && editing ? <Pressable onPress={() => { setEditing(false); setText(''); onText?.(''); setItems([]); }} style={styles.change}><Text style={type.small}>Cancel — keep "{value.formatted ?? value.label}"</Text></Pressable> : null}
      {biasName ? <Text style={type.tiny}>Looking in {biasName}{near?.country ? `, ${near.country}` : ''} first{countryCode || near?.countryCode ? ' — results stay in the same country' : ''}.</Text> : null}
      {!areas && busy ? <Text style={type.tiny}>Looking…</Text> : null}
      {items.length ? (
        <View style={styles.list}>
          {items.map((p, i) => (
            <Pressable key={`${p.lat},${p.lng},${i}`} onPress={() => choose(p)} style={[styles.result, areas && styles.suggestion]} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Row2 name={p.formatted ?? p.label} word={areas ? p.kindWord ?? null : null} />
                <Text style={type.tiny} numberOfLines={2}>
                  {areas ? p.where : p.approximate ? p.displayName : [p.address?.town, p.address?.postcode, p.country].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {areas ? null : <View style={styles.use}><Text style={styles.useText}>Use this</Text></View>}
            </Pressable>
          ))}
        </View>
      ) : null}
      {!busy && searched && searched === text && items.length === 0 ? (
        <Text style={[type.small, { color: colors.dislike }]}>
          {areas
            ? `No city or region called "${searched}". Try fewer letters, or add the country — "Lisbon, Portugal".`
            : `Nothing matched "${searched}"${biasName ? ` in or around ${biasName}` : ''}. Try the postcode on its own, or the street and town without the house name.`}
        </Text>
      ) : null}
      {items.length ? <Text style={type.tiny}>{attribution}{areas ? '' : ' · Tap a result to use it.'}</Text> : null}
    </View>
  );
}

/** The name, with what kind of place it is beside it — "Bath  city". */
function Row2({ name, word }: { name: string; word: string | null }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
      <Text style={type.h3} numberOfLines={1}>{name}</Text>
      {word ? <Text style={type.tiny}>{word}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  boxInput: { flex: 1, minHeight: TARGET, fontSize: 15, color: colors.ink, outlineStyle: 'none' as any },
  list: { borderRadius: radius.md, overflow: 'hidden', gap: 2 },
  result: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  // A suggestion list reads as one thing, not as six cards.
  suggestion: { paddingVertical: 8, borderRadius: radius.sm },
  use: { minHeight: 36, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: colors.accent, justifyContent: 'center' },
  useText: { color: colors.bg, fontWeight: '700', fontSize: 13 },
  chosen: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  change: { minHeight: TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { paddingHorizontal: 12, minHeight: 36, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line },
  herePill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderColor: colors.accent },
  pillText: { fontSize: 13, fontWeight: '600', color: colors.ink },
});

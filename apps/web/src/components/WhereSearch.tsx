import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, Place } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Icon, IconName } from './Icon';
import { PlacePicker } from './PlacePicker';
import { useHere } from '../hooks/useHere';
import { useViewport } from '../hooks/useViewport';

/**
 * "Where should we go?" — the screen behind the search bar on Inspire.
 *
 * It is a whole screen rather than a sheet, and it is drawn *in the tab* rather
 * than portalled out of it: a Modal would have to be pinned to the shell's
 * phone frame by hand, and every screen that has needed one has had to
 * (CLAUDE.md). This one does not need one, so it does not have one.
 *
 * The typing is `PlacePicker` in area mode, which is the searching Roam already
 * knows how to do: Photon, matched on the letters typed so far, the household's
 * own country first, everywhere else folded behind a count. Nothing here is a
 * second implementation of that.
 *
 * Around it are the answers that need no typing at all, and they are all things
 * this household already owns — home, where the phone is standing, the towns
 * they have looked at before, and the cities their atlas already has places in.
 * A search screen that opens empty is a search screen that makes you work; this
 * one opens on the four or five places they actually go.
 */

const RECENT_KEY = 'roam.inspire.recent';
const RECENT_MAX = 6;

const store = (): Storage | null => (Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage : null);

/** Somewhere this household has looked before. Open-map names and points only. */
export function recentPlaces(): Place[] {
  try {
    const raw = store()?.getItem(RECENT_KEY);
    const held = raw ? JSON.parse(raw) : [];
    return Array.isArray(held) ? held.filter((p) => p && typeof p.label === 'string' && Number.isFinite(p.lat)) : [];
  } catch { return []; }
}

export function rememberPlace(place: Place): void {
  const s = store();
  if (!s) return;
  const slim: Place = {
    label: place.label, lat: place.lat, lng: place.lng,
    locality: place.locality ?? null, country: place.country ?? null, countryCode: place.countryCode ?? null,
    where: place.where, kindWord: place.kindWord ?? null,
  };
  const rest = recentPlaces().filter((p) => p.label !== slim.label);
  try { s.setItem(RECENT_KEY, JSON.stringify([slim, ...rest].slice(0, RECENT_MAX))); } catch { /* a full store just means no history */ }
}

export function forgetPlaces(): void {
  try { store()?.removeItem(RECENT_KEY); } catch { /* nothing to forget */ }
}

export function WhereSearch({ home, onPick, onClose, onPlanner }: {
  /** The household's home, offered as the first answer and as the way back to the default. */
  home: Place | null;
  onPick: (place: Place) => void;
  onClose: () => void;
  /** The other way to answer this question: say what you're after and let Roam think. */
  onPlanner?: () => void;
}) {
  const { width } = useViewport();
  const wide = width >= 900;
  const me = useHere();
  const [recent, setRecent] = useState<Place[]>(recentPlaces);
  // The cities the household's own atlas already has places in — theirs, free
  // to read, and usually where they are going next.
  const [cities, setCities] = useState<Place[]>([]);

  useEffect(() => {
    let dropped = false;
    api.atlas()
      .then((a) => {
        if (dropped) return;
        const towns = a.countries.flatMap((c) =>
          c.cities
            // A city with nothing in it is a row that teaches nothing.
            .filter((city) => city.lat != null && city.lng != null && city.places > 0)
            .map((city) => ({
              label: city.name, lat: city.lat as number, lng: city.lng as number,
              locality: city.name, country: c.name, countryCode: c.code,
              where: `${city.places} place${city.places === 1 ? '' : 's'} · ${c.name}`,
            })),
        );
        setCities(towns.slice(0, 8));
      })
      .catch(() => { /* the search works without them */ });
    return () => { dropped = true; };
  }, []);

  const choose = (place: Place) => {
    rememberPlace(place);
    setRecent(recentPlaces());
    onPick(place);
  };

  return (
    <View style={styles.fill}>
      <View style={styles.head}>
        <Pressable onPress={onClose} hitSlop={10} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <Icon name="back" size={20} color={colors.ink} />
        </Pressable>
        <Text style={[type.h2, { flex: 1 }]}>Where should we go?</Text>
      </View>
      <ScrollView style={styles.fill} contentContainerStyle={[styles.body, wide && styles.bodyWide]} keyboardShouldPersistTaps="handled">
        <PlacePicker
          value={null}
          kind="area"
          autoFocus
          placeholder="Town, city or region"
          onPick={(p) => { if (p) choose(p); }}
        />

        <View style={{ gap: 6 }}>
          {home ? (
            <Answer
              icon="home"
              title="Near home"
              detail={home.label}
              onPress={() => { onPick(home); }}
            />
          ) : null}
          {/* Nothing is asked of the device until this row is pressed. */}
          {me.supported ? (
            <Answer
              icon="here"
              title={me.busy ? 'Finding you…' : 'Where I am'}
              detail={me.busy ? 'Asking your device' : 'Look around wherever the phone is'}
              busy={me.busy}
              onPress={async () => { const p = await me.ask(); if (p) choose(p); }}
            />
          ) : null}
          {me.error ? <Text style={[type.small, { color: colors.dislike }]}>{me.error}</Text> : null}
        </View>

        {recent.length ? (
          <Group
            title="Where you've looked"
            action={{ label: 'Clear', onPress: () => { forgetPlaces(); setRecent([]); } }}
            places={recent}
            onPick={choose}
          />
        ) : null}

        {cities.length ? <Group title="In your atlas" places={cities} onPick={choose} /> : null}

        {onPlanner ? (
          <Pressable onPress={onPlanner} style={styles.planner} accessibilityRole="button">
            <Icon name="plan" size={18} color={colors.icon} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={type.h3}>Not somewhere — something</Text>
              <Text style={type.small}>Tell Roam what the day is for and it will find the place.</Text>
            </View>
            <Icon name="more" size={16} color={colors.inkMuted} />
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** One answer you can take without typing: home, here, a town you already know. */
function Answer({ icon, title, detail, onPress, busy }: {
  icon: IconName; title: string; detail?: string | null; onPress: () => void; busy?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={busy} style={styles.answer} accessibilityRole="button" accessibilityLabel={title}>
      {busy ? <ActivityIndicator size="small" color={colors.icon} /> : <Icon name={icon} size={16} color={colors.icon} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={type.h3} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={type.tiny} numberOfLines={1}>{detail}</Text> : null}
      </View>
      <Icon name="more" size={16} color={colors.inkMuted} />
    </Pressable>
  );
}

function Group({ title, places, onPick, action }: {
  title: string; places: Place[]; onPick: (p: Place) => void; action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.groupHead}>
        <Text style={[type.label, { marginBottom: 0 }]}>{title}</Text>
        {action ? (
          <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button">
            <Text style={type.tiny}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {places.map((p) => (
        <Answer key={`${title}:${p.label}`} icon="place" title={p.label} detail={p.where ?? null} onPress={() => onPick(p)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  back: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  body: { padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.lg, paddingBottom: spacing.xxl },
  bodyWide: { maxWidth: 640, width: '100%', alignSelf: 'center' },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  answer: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: TARGET + 6, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  planner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: TARGET + 12, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
});

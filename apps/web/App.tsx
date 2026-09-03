import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, API_URL, HouseholdResponse } from './src/api';
import { colors, spacing, TARGET, type } from './src/theme';
import { PlanScreen } from './src/screens/PlanScreen';
import { PlacesScreen } from './src/screens/PlacesScreen';
import { TripsScreen, TripPrefill } from './src/screens/TripsScreen';
import { HouseholdScreen } from './src/screens/HouseholdScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

type Tab = 'plan' | 'places' | 'trips' | 'household' | 'settings';
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'plan', label: 'Plan', icon: '✦' },
  { key: 'places', label: 'Places', icon: '◎' },
  { key: 'trips', label: 'Trips', icon: '⇢' },
  { key: 'household', label: 'Household', icon: '☺' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
];

// Mobile-first (V1 is the installed web app on a phone), but on a wide screen
// this is a real desktop app: navigation down the side, two-column content.
const DESKTOP = 900;

export default function App() {
  const { width } = useWindowDimensions();
  const desktop = width >= DESKTOP;
  const [tab, setTab] = useState<Tab>('plan');
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');
  const [household, setHousehold] = useState<HouseholdResponse | null>(null);
  const [tripPrefill, setTripPrefill] = useState<TripPrefill | null>(null);

  const refreshHousehold = useCallback(async () => {
    try { setHousehold(await api.household()); } catch { setHousehold(null); }
  }, []);

  useEffect(() => {
    api.health().then((h) => setHealth(h.ok ? 'ok' : 'down')).catch(() => setHealth('down'));
    refreshHousehold();
  }, [refreshHousehold]);

  const screen = (
    <>
      {tab === 'plan' ? <PlanScreen household={household} /> : null}
      {tab === 'places' ? <PlacesScreen household={household} refreshHousehold={refreshHousehold} onPlanTrip={(p) => { setTripPrefill(p); setTab('trips'); }} /> : null}
      {tab === 'trips' ? <TripsScreen household={household} refreshHousehold={refreshHousehold} prefill={tripPrefill} onPrefillConsumed={() => setTripPrefill(null)} /> : null}
      {tab === 'household' ? <HouseholdScreen data={household} refresh={refreshHousehold} /> : null}
      {tab === 'settings' ? <SettingsScreen data={household} refresh={refreshHousehold} /> : null}
    </>
  );

  const status = (
    <Text style={styles.status} testID="api-health">
      API {health === 'ok' ? 'connected' : health} · {API_URL.replace(/^https?:\/\//, '')}
    </Text>
  );

  if (desktop) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        <View style={styles.desktop}>
          <View style={styles.sidebar}>
            <Text style={styles.brand}>Roam</Text>
            <Text style={[type.tiny, { marginBottom: spacing.lg }]}>Remember every place you love</Text>
            {TABS.map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={[styles.navItem, tab === t.key && styles.navItemActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
                <Text style={[styles.navIcon, tab === t.key && { color: colors.accent }]}>{t.icon}</Text>
                <Text style={[styles.navLabel, tab === t.key && { color: colors.accent }]}>{t.label}</Text>
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            {household ? <Text style={type.tiny}>{household.household.name} · {household.members.length} people</Text> : null}
            {status}
          </View>
          <View style={styles.content}>
            {health === 'down' ? <View style={[styles.banner, styles.bannerDown]}><Text style={type.small}>Can't reach the API at {API_URL}. Is it running?</Text></View> : null}
            {screen}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      {health !== 'ok' ? (
        <View style={[styles.banner, health === 'down' && styles.bannerDown]}>
          <Text style={type.small}>{health === 'checking' ? `Reaching API at ${API_URL}…` : `Can't reach the API at ${API_URL}. Is it running?`}</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }}>{screen}</View>
      <View style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((t) => (
          <Pressable key={t.key} onPress={() => setTab(t.key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
            <Text style={[styles.tabIcon, tab === t.key && { color: colors.accent }]}>{t.icon}</Text>
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  desktop: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 220, padding: spacing.lg, borderRightWidth: 1, borderRightColor: colors.line, backgroundColor: colors.surface, gap: 4 },
  brand: { fontSize: 26, fontWeight: '800', color: colors.accent, letterSpacing: -0.5 },
  navItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: TARGET, paddingHorizontal: spacing.sm, borderRadius: 10 },
  navItemActive: { backgroundColor: colors.accentSoft },
  navIcon: { width: 22, fontSize: 16, color: colors.inkMuted, textAlign: 'center' },
  navLabel: { fontSize: 15, fontWeight: '600', color: colors.ink },
  content: { flex: 1 },
  banner: { padding: spacing.sm, backgroundColor: colors.accentSoft, alignItems: 'center' },
  bannerDown: { backgroundColor: colors.overrunSoft },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface, paddingBottom: 4 },
  tab: { flex: 1, minHeight: TARGET + 10, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabIcon: { fontSize: 16, color: colors.inkMuted },
  tabText: { fontSize: 11, fontWeight: '600', color: colors.inkMuted },
  tabTextActive: { color: colors.accent },
  status: { fontSize: 10, color: colors.inkFaint },
});

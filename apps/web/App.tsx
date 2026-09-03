import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, SafeAreaView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, API_URL, HouseholdResponse } from './src/api';
import { colors, radius, spacing, TARGET, type } from './src/theme';
import { PlanScreen } from './src/screens/PlanScreen';
import { PlacesScreen } from './src/screens/PlacesScreen';
import { TripsScreen, TripPrefill } from './src/screens/TripsScreen';
import { HouseholdScreen } from './src/screens/HouseholdScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { Brand, BRAND_GROUND } from './src/components/Brand';
import { useViewport, ViewportProvider } from './src/hooks/useViewport';
import { Icon, IconName } from './src/components/Icon';

type Tab = 'plan' | 'places' | 'trips' | 'household' | 'settings';
const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'plan', label: 'Plan', icon: 'plan' },
  { key: 'places', label: 'Places', icon: 'places' },
  { key: 'trips', label: 'Trips', icon: 'trips' },
  { key: 'household', label: 'Household', icon: 'household' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

// Mobile-first (V1 is the installed web app on a phone), but on a wide screen
// this is a real desktop app: navigation down the side, two-column content.
const DESKTOP = 900;

// On a wide screen the owner can flip between the two (3 Sep 2026): "Web" is the
// desktop layout at full width; "Mobile" draws the whole app inside a phone-sized
// frame so every screen shows how it will look on the phone. The choice sticks.
type ViewMode = 'web' | 'mobile';
const VIEW_KEY = 'roam.viewMode';
const PHONE = { width: 390, height: 844 };
const TOOLBAR = 44;
const BEZEL = 10;
const readViewMode = (): ViewMode =>
  Platform.OS === 'web' && typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_KEY) === 'mobile' ? 'mobile' : 'web';

export default function App() {
  const window = useWindowDimensions();
  const [mode, setMode] = useState<ViewMode>(readViewMode);
  const choose = (m: ViewMode) => {
    setMode(m);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.setItem(VIEW_KEY, m);
  };

  // A narrow window is a phone already: no toggle, no frame.
  if (window.width < DESKTOP) return <Shell />;

  const frameHeight = Math.min(PHONE.height, window.height - TOOLBAR - spacing.xl * 2 - BEZEL * 2);
  // Where the phone's screen lands in the real window: the stage centres it below the toolbar.
  const origin = { x: (window.width - PHONE.width) / 2, y: TOOLBAR + (window.height - TOOLBAR - frameHeight) / 2 };
  const mobile = mode === 'mobile';
  const viewport = mobile
    ? { width: PHONE.width, height: frameHeight, framed: true, origin }
    : { width: window.width, height: window.height - TOOLBAR, framed: false };
  return (
    <View style={styles.root}>
      <View style={styles.toolbar} testID="view-mode">
        <Text style={type.tiny}>Viewing as</Text>
        <View style={styles.modeSwitch} accessibilityRole="radiogroup">
          {(['web', 'mobile'] as ViewMode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => choose(m)}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode === m }}
              style={[styles.modeBtn, mode === m && styles.modeBtnActive]}
            >
              <View style={styles.modeInner}>
                <Icon name={m} size={14} color={mode === m ? colors.surface : colors.inkMuted} />
                <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>{m === 'web' ? 'Web' : 'Mobile'}</Text>
              </View>
            </Pressable>
          ))}
        </View>
        {mode === 'mobile' ? <Text style={type.tiny}>{PHONE.width} × {frameHeight}</Text> : null}
      </View>
      {/* Same tree shape in both modes so the Shell (and the screen you're on) survives the switch. */}
      <View style={mobile ? styles.stage : styles.fill}>
        <View style={mobile ? styles.bezel : styles.fill}>
          <View style={mobile ? [styles.screen, { width: PHONE.width, height: frameHeight }] : styles.fill}>
            <ViewportProvider value={viewport}>
              <Shell />
            </ViewportProvider>
          </View>
        </View>
      </View>
    </View>
  );
}

function Shell() {
  const { width } = useViewport();
  const desktop = width >= DESKTOP;
  const [tab, setTab] = useState<Tab>('plan');
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');
  const [household, setHousehold] = useState<HouseholdResponse | null>(null);
  const [tripPrefill, setTripPrefill] = useState<TripPrefill | null>(null);

  const refreshHousehold = useCallback(async () => {
    try {
      const h = await api.household();
      // "3 pm" means 3 pm where the family is: keep the household's timezone in step with the device.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && h.household.timezone && h.household.timezone !== tz) {
        try { await api.updateHousehold({ timezone: tz }); h.household.timezone = tz; } catch { /* keep server value */ }
      }
      setHousehold(h);
    } catch { setHousehold(null); }
  }, []);

  useEffect(() => {
    api.health().then((h) => setHealth(h.ok ? 'ok' : 'down')).catch(() => setHealth('down'));
    refreshHousehold();
  }, [refreshHousehold]);

  const screen = (
    <>
      {tab === 'plan' ? <PlanScreen household={household} onOpenTrip={(id) => { setTripPrefill({ openTripId: id }); setTab('trips'); }} /> : null}
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

  const banner = (
    <View style={[styles.banner, health === 'down' && styles.bannerDown]}>
      <Text style={type.small}>{health === 'checking' ? `Reaching API at ${API_URL}…` : `Can't reach the API at ${API_URL}. Is it running?`}</Text>
    </View>
  );

  // One tree for both layouts, with the screen in the same slot, so flipping
  // between desktop and phone (window resize or the Web/Mobile toggle) keeps
  // whatever is open on the screen — the trip you were looking at, a search.
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      <View style={desktop ? styles.desktop : styles.fill}>
        {desktop ? (
          <View style={styles.sidebar}>
            <Brand height={88} />
            <Text style={[type.tiny, { marginBottom: spacing.lg }]}>Remember every place you love</Text>
            {TABS.map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={[styles.navItem, tab === t.key && styles.navItemActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
                <View style={styles.navIcon}><Icon name={t.icon} size={18} color={tab === t.key ? colors.accent : colors.inkMuted} /></View>
                <Text style={[styles.navLabel, tab === t.key && { color: colors.accent }]}>{t.label}</Text>
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            {household ? <Text style={type.tiny}>{household.household.name} · {household.members.length} people</Text> : null}
            {status}
          </View>
        ) : (
          <View style={styles.header}><Brand height={44} /></View>
        )}
        {!desktop && health !== 'ok' ? banner : null}
        <View style={styles.content}>
          {desktop && health === 'down' ? banner : null}
          {screen}
        </View>
        {!desktop ? (
          <View style={styles.tabs} accessibilityRole="tablist">
            {TABS.map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
                <Icon name={t.icon} size={20} color={tab === t.key ? colors.accent : colors.inkMuted} />
                <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  toolbar: {
    height: TOOLBAR, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.md,
    paddingHorizontal: spacing.lg, backgroundColor: colors.surfaceMuted, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  modeSwitch: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, padding: 2 },
  modeBtn: { minHeight: 28, paddingHorizontal: spacing.md, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  modeBtnActive: { backgroundColor: colors.accent },
  modeInner: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  modeText: { fontSize: 12, fontWeight: '600', color: colors.inkMuted },
  modeTextActive: { color: colors.surface },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E9E6DE', padding: spacing.xl },
  bezel: {
    padding: BEZEL, borderRadius: 36, backgroundColor: '#1D1B16',
    boxShadow: '0 12px 30px rgba(0,0,0,0.25)',
  },
  // The screen is exactly the size the app is told it has; the bezel sits outside it.
  screen: { borderRadius: 36 - BEZEL, backgroundColor: colors.bg, overflow: 'hidden' },
  desktop: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 220, padding: spacing.lg, borderRightWidth: 1, borderRightColor: colors.line, backgroundColor: colors.surface, gap: 4 },
  header: { alignItems: 'center', backgroundColor: BRAND_GROUND, borderBottomWidth: 1, borderBottomColor: colors.line },
  navItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: TARGET, paddingHorizontal: spacing.sm, borderRadius: 10 },
  navItemActive: { backgroundColor: colors.accentSoft },
  navIcon: { width: 22, alignItems: 'center' },
  navLabel: { fontSize: 15, fontWeight: '600', color: colors.ink },
  content: { flex: 1 },
  banner: { padding: spacing.sm, backgroundColor: colors.accentSoft, alignItems: 'center' },
  bannerDown: { backgroundColor: colors.overrunSoft },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface, paddingBottom: 4 },
  tab: { flex: 1, minHeight: TARGET + 10, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabText: { fontSize: 11, fontWeight: '600', color: colors.inkMuted },
  tabTextActive: { color: colors.accent },
  status: { fontSize: 10, color: colors.inkFaint },
});

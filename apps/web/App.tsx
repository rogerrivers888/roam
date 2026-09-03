import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, API_URL, HouseholdResponse } from './src/api';
import { colors, spacing, TARGET, type } from './src/theme';
import { PlanScreen } from './src/screens/PlanScreen';
import { HouseholdScreen } from './src/screens/HouseholdScreen';
import { TripsScreen } from './src/screens/TripsScreen';

type Tab = 'plan' | 'household' | 'trips';

export default function App() {
  const [tab, setTab] = useState<Tab>('plan');
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');
  const [household, setHousehold] = useState<HouseholdResponse | null>(null);

  const refreshHousehold = useCallback(async () => {
    try {
      setHousehold(await api.household());
    } catch {
      setHousehold(null);
    }
  }, []);

  useEffect(() => {
    api.health()
      .then((h) => setHealth(h.ok ? 'ok' : 'down'))
      .catch(() => setHealth('down'));
    refreshHousehold();
  }, [refreshHousehold]);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      {health !== 'ok' ? (
        <View style={[styles.banner, health === 'down' && styles.bannerDown]}>
          <Text style={type.small} testID="api-status">
            {health === 'checking' ? `Reaching API at ${API_URL}…` : `Can't reach the API at ${API_URL}. Is it running?`}
          </Text>
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        {tab === 'plan' ? <PlanScreen household={household} /> : null}
        {tab === 'household' ? <HouseholdScreen data={household} refresh={refreshHousehold} /> : null}
        {tab === 'trips' ? <TripsScreen /> : null}
      </View>

      <View style={styles.tabs} accessibilityRole="tablist">
        {([['plan', 'Plan'], ['household', 'Household'], ['trips', 'Trips']] as [Tab, string][]).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            style={styles.tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
          >
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.foot} testID="api-health">
        API {health === 'ok' ? 'connected' : health} · {API_URL}
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  banner: { padding: spacing.sm, backgroundColor: colors.accentSoft, alignItems: 'center' },
  bannerDown: { backgroundColor: colors.overrunSoft },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface },
  tab: { flex: 1, minHeight: TARGET + 8, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontSize: 13, fontWeight: '600', color: colors.inkMuted },
  tabTextActive: { color: colors.accent },
  foot: { fontSize: 10, color: colors.inkFaint, textAlign: 'center', paddingBottom: 6, backgroundColor: colors.surface },
});

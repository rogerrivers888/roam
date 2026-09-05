import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, HouseholdResponse, Place } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Row, Segmented, SectionTitle, StatusLine, Stepper, minutes } from '../components/ui';
import { useRouter } from '../router';
import { paths, type Route, type SettingsSection } from '../routes';
import { PlacePicker } from '../components/PlacePicker';
import { ProvidersTable } from '../components/ProvidersTable';
import { useTheme } from '../hooks/useTheme';
import { getViewer, setViewer } from '../viewer';
import { isAdmin, setAdmin } from '../admin';
import { Icon } from '../components/Icon';
import { OfflineCard } from '../components/OfflineCard';
import { AccountCard } from '../components/AccountCard';

export const SPEAK_KEY = 'roam.speakReplies';
export const getSpeakPref = () => (Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage.getItem(SPEAK_KEY) !== 'off' : true);

// Settings is two different things: how Roam plans for this household
// (preferences, the customer's) and how the app is wired and what it spends
// (sources and usage, the owner's). They share a screen, not a page.
type Section = SettingsSection;
const SECTION_HINT: Record<Section, string> = {
  preferences: 'Home, pace, voice and your data: how Roam plans for this household.',
  providers: 'Every provider on one row: switch it on or off, what is free, what is paid, what it cost. Tap a row for the detail.',
};

/**
 * Which build answered (owner, 4 Sep 2026: "It seems like it hasn't deployed
 * yet"). The app's own build is the hash in the bundle's file name, which
 * changes with every deploy; the API says which commit it is running. Between
 * them, "is it live" stops being a guess, and a stale browser copy shows up as
 * an app build that does not match what the site is serving.
 */
function BuildCard() {
  const [api_, setApi] = useState<string | null>(null);
  const [web, setWeb] = useState<string | null>(null);
  useEffect(() => {
    api.health().then((h: any) => setApi(h.commit ?? 'unknown')).catch(() => setApi('unreachable'));
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const src = Array.from(document.querySelectorAll('script[src]')).map((el) => (el as HTMLScriptElement).src).find((u) => /_expo\/static\/js/.test(u));
    setWeb(src?.match(/index-([0-9a-f]{8})/)?.[1] ?? 'unknown');
  }, []);
  const reload = () => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    // Ask the waiting worker to take over, then come back for the newest files.
    navigator.serviceWorker?.getRegistration().then((r) => { r?.waiting?.postMessage('skip-waiting'); r?.update(); }).finally(() => window.location.reload());
  };
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.small}>App</Text>
        <Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>{web ?? '…'}</Text>
      </Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.small}>API</Text>
        <Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>{api_ ?? '…'}</Text>
      </Row>
      <Text style={[type.tiny, { marginTop: spacing.sm }]}>Quote these two if something looks older than it should be.</Text>
      <Button label="Get the newest version" kind="secondary" onPress={reload} style={{ marginTop: spacing.sm }} />
    </Card>
  );
}

export function SettingsScreen({ data, refresh, route }: {
  data: HouseholdResponse | null; refresh: () => Promise<void>;
  /** Settings' two halves are two pages: `/settings` and `/settings/providers`. */
  route: Extract<Route, { name: 'settings' }>;
}) {
  const { navigate } = useRouter();
  const section = route.section;
  const setSection = (next: Section) => navigate(paths.settings(next));
  if (!data) return <View style={styles.page}><Text style={type.small}>Loading…</Text></View>;
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={type.title}>Settings</Text>
      <Segmented value={section} onChange={setSection}
        options={[{ value: 'preferences', label: 'Preferences' }, { value: 'providers', label: 'Providers' }]} />
      <Text style={type.small}>{SECTION_HINT[section]}</Text>
      {section === 'preferences' ? <Preferences data={data} refresh={refresh} /> : null}
      {section === 'providers' ? <Providers /> : null}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Preferences: the household's own settings.
// ---------------------------------------------------------------------------

function Preferences({ data, refresh }: { data: HouseholdResponse; refresh: () => Promise<void> }) {
  const { household } = data;
  const [name, setName] = useState(household.name ?? '');
  const [speak, setSpeak] = useState(getSpeakPref());
  const { pref: themePref, setPref: setThemePref } = useTheme();
  const [viewer, setViewerState] = useState<string | null>(getViewer(data.members));
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [homeMsg, setHomeMsg] = useState<string | null>(null);
  useEffect(() => { setName(household.name ?? ''); }, [household.name]);

  const setHome = async (p: Place | null) => {
    if (!p) { setHomeMsg(null); return; }
    try { await api.updateHousehold({ home: p }); await refresh(); setHomeMsg(`Home saved: ${p.formatted ?? p.label}`); } catch (e: any) { setHomeMsg(e.message); }
  };

  return (
    <>
      <SectionTitle hint="Used whenever you say 'from home' or search near home. Places · Close to home holds everything within the radius.">Home</SectionTitle>
      <Card>
        <PlacePicker value={household.home} onPick={setHome} placeholder="House name or number, street, town, postcode" />
        {!household.home ? <StatusLine>Not set. Type your address, then tap <Text style={{ fontWeight: '700' }}>Use this</Text> on the match.</StatusLine> : null}
        {homeMsg ? <StatusLine tone="good">{homeMsg}</StatusLine> : null}
        {household.home ? (
          <Stepper label="Close to home reaches" value={household.homeRadiusMiles ?? 10} min={1} max={100} step={5}
            format={(v) => `${v} miles`}
            onChange={async (v) => { await api.updateHousehold({ homeRadiusMiles: v }); await refresh(); }} />
        ) : null}
      </Card>

      <SectionTitle>Household</SectionTitle>
      <Card>
        <Text style={type.small}>Name</Text>
        <Row>
          <TextInput value={name} onChangeText={setName} style={[styles.input, { flex: 1 }]} />
          <Button label="Save" kind="secondary" onPress={async () => { await api.updateHousehold({ name: name.trim() || household.name }); await refresh(); }} />
        </Row>
      </Card>

      <SectionTitle hint="Eating and doing have different rhythms. 'Special' is the exception you'd make for somewhere worth going further for.">Our pace</SectionTitle>
      <Card>
        {(['food', 'activity'] as const).map((k) => (
          <View key={k} style={{ gap: 4, marginBottom: spacing.md }}>
            <Text style={type.h3}>{k === 'food' ? 'Food & drink' : 'Things to do'}</Text>
            <Stepper label="Usually spend" value={household.pace[k].typicalMinutes} min={15} max={480} step={15} format={minutes}
              onChange={async (v) => { await api.updateHousehold({ pace: { [k]: { typicalMinutes: v } } }); await refresh(); }} />
            <Stepper label="Longest we'd allow" value={household.pace[k].maxMinutes} min={30} max={720} step={30} format={minutes}
              onChange={async (v) => { await api.updateHousehold({ pace: { [k]: { maxMinutes: v } } }); await refresh(); }} />
            <Stepper label="Usual max travel" value={household.pace[k].maxTravelMinutes} min={5} max={240} step={5} format={minutes}
              onChange={async (v) => { await api.updateHousehold({ pace: { [k]: { maxTravelMinutes: v } } }); await refresh(); }} />
            <Stepper label="…if it's special" value={household.pace[k].maxTravelIfSpecialMinutes} min={5} max={360} step={15} format={minutes}
              onChange={async (v) => { await api.updateHousehold({ pace: { [k]: { maxTravelIfSpecialMinutes: v } } }); await refresh(); }} />
          </View>
        ))}
        <Text style={type.small}>How full we like a day</Text>
        <Segmented value={household.defaultIntensity}
          options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'packed', label: 'Packed' }]}
          onChange={async (v) => { await api.updateHousehold({ defaultIntensity: v }); await refresh(); }} />
      </Card>

      <SectionTitle hint="Follow the device, or pick one. Kept on this device.">Appearance</SectionTitle>
      <Card>
        <Segmented value={themePref} options={[{ value: 'system', label: 'Device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} onChange={setThemePref} />
      </Card>

      <SectionTitle hint="A place's row in Places shows one score: this person's. Everyone's are in the drawer. Kept on this device.">Ratings shown as</SectionTitle>
      <Card>
        {/* "Anyone" is a real answer, and the Places redesign's Anyone ▾ chip sets
            the same thing: a row then shows what the household said between them
            rather than one person's mark. */}
        <Segmented
          value={viewer ?? ''}
          options={[{ value: '', label: 'Anyone' }, ...data.members.map((m) => ({ value: m.id, label: m.name.split(' ')[0] }))]}
          onChange={(id) => { setViewer(id || null); setViewerState(id || null); }}
        />
      </Card>

      <SectionTitle>Voice</SectionTitle>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={type.body}>Speak replies back when I use my voice</Text>
            <Text style={type.tiny}>Recordings are never kept. Voice is interpreted only against what's on screen.</Text>
          </View>
          <Switch value={speak} onValueChange={(v) => { setSpeak(v); if (Platform.OS === 'web') localStorage.setItem(SPEAK_KEY, v ? 'on' : 'off'); }} />
        </Row>
      </Card>

      <SectionTitle hint="Which build you are looking at, so 'is that change live yet?' has an answer.">This build</SectionTitle>
      <BuildCard />

      <SectionTitle hint="One passcode for the household, and which devices are using it. Anything written without signal waits here until it can be sent.">Account</SectionTitle>
      <AccountCard />

      <SectionTitle hint="What Roam keeps on this phone so it works with no signal, and what it has researched and owns outright.">On this device</SectionTitle>
      <OfflineCard />

      <SectionTitle hint="Everything the household has generated. Place content from licensed sources is never included, only identifiers and what you wrote.">Your data</SectionTitle>
      <Card>
        <Button label="Export everything (JSON)" kind="secondary" onPress={() => { void api.downloadExport(); }} />
        <Text style={[type.small, { marginTop: spacing.sm }]}>Delete everything Roam holds about this household: people, trips, visits, ratings, captured menus. Type the household name to confirm.</Text>
        <Row>
          <TextInput value={confirm} onChangeText={setConfirm} placeholder={household.name} placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
          <Button label="Delete household" kind="danger" disabled={confirm !== household.name} onPress={async () => {
            try { await api.deleteHousehold(confirm); setMsg('Deleted. Run the seed to start again.'); await refresh(); } catch (e: any) { setMsg(e.message); }
          }} />
        </Row>
        {msg ? <StatusLine>{msg}</StatusLine> : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Providers: one table for what is wired in, what it costs and what it has
// used (owner, 3 Sep 2026: "the whole lot bundled into one table").
// ---------------------------------------------------------------------------

function Providers() {
  const [admin, setAdminState] = useState(isAdmin());
  return (
    <>
      <ProvidersTable />
      <SectionTitle hint="For judging each provider's data before paying for it. On this device only; households never see it.">Admin</SectionTitle>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={type.body}>Show where every record came from</Text>
            <Text style={type.tiny}>Adds a Data section to each trip on the web layout (what each source returned for a day and where the plan lost it, one source at a time with its cost), a source filter on the plan's browse lists and shortlist searches, and a "via" line under each result.</Text>
          </View>
          <Switch value={admin} onValueChange={(v) => { setAdmin(v); setAdminState(v); }} />
        </Row>
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.sm, width: '100%', maxWidth: 760, alignSelf: 'center' },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
});

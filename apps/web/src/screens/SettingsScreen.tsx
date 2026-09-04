import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, HouseholdResponse, Place } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Row, Segmented, SectionTitle, StatusLine, Stepper, minutes } from '../components/ui';
import { PlacePicker } from '../components/PlacePicker';
import { ProvidersTable } from '../components/ProvidersTable';
import { useTheme } from '../hooks/useTheme';
import { getViewer, setViewer } from '../viewer';
import { isAdmin, setAdmin } from '../admin';
import { Icon } from '../components/Icon';

export const SPEAK_KEY = 'roam.speakReplies';
export const getSpeakPref = () => (Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage.getItem(SPEAK_KEY) !== 'off' : true);

// Settings is two different things: how Roam plans for this household
// (preferences, the customer's) and how the app is wired and what it spends
// (sources and usage, the owner's). They share a screen, not a page.
type Section = 'preferences' | 'providers';
const SECTION_HINT: Record<Section, string> = {
  preferences: 'Home, pace, voice and your data: how Roam plans for this household.',
  providers: 'Every provider on one row: switch it on or off, what is free, what is paid, what it cost. Tap a row for the detail.',
};

export function SettingsScreen({ data, refresh }: { data: HouseholdResponse | null; refresh: () => Promise<void> }) {
  const [section, setSection] = useState<Section>('preferences');
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
      <SectionTitle hint="Used whenever you say 'from home' or search near home.">Home</SectionTitle>
      <Card>
        <PlacePicker value={household.home} onPick={setHome} placeholder="House name or number, street, town, postcode" />
        {!household.home ? <StatusLine>Not set. Type your address, then tap <Text style={{ fontWeight: '700' }}>Use this</Text> on the match.</StatusLine> : null}
        {homeMsg ? <StatusLine tone="good">{homeMsg}</StatusLine> : null}
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
        <Segmented value={viewer ?? ''} options={data.members.map((m) => ({ value: m.id, label: m.name.split(' ')[0] }))} onChange={(id) => { setViewer(id); setViewerState(id); }} />
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

      <SectionTitle>Account</SectionTitle>
      <Card>
        <Text style={type.body}>Private beta: one household, no sign-in.</Text>
        <Text style={type.small}>Sign in with Apple arrives with the public beta. Apple shares a name and email only, never a photo, so photos are set per person in Household.</Text>
      </Card>

      <SectionTitle hint="Everything the household has generated. Place content from licensed sources is never included, only identifiers and what you wrote.">Your data</SectionTitle>
      <Card>
        <Button label="Export everything (JSON)" kind="secondary" onPress={() => Linking.openURL(api.exportUrl())} />
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

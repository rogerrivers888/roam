import React, { useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, HouseholdResponse, Place, SourcesStatus } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, SectionTitle, StatusLine, Stepper, minutes } from '../components/ui';
import { PlacePicker } from '../components/PlacePicker';

export const SPEAK_KEY = 'roam.speakReplies';
export const getSpeakPref = () => (Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage.getItem(SPEAK_KEY) !== 'off' : true);

export function SettingsScreen({ data, refresh }: { data: HouseholdResponse | null; refresh: () => Promise<void> }) {
  const [name, setName] = useState(data?.household.name ?? '');
  const [speak, setSpeak] = useState(getSpeakPref());
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [homeMsg, setHomeMsg] = useState<string | null>(null);
  const [spend, setSpend] = useState<{ month: { calls: number; costUsd: number; bound: number }; byProvider: { provider: string; calls: number; cost_usd: number }[] } | null>(null);

  useEffect(() => { setName(data?.household.name ?? ''); }, [data?.household.name]);
  useEffect(() => { fetch(`${api.exportUrl().replace('/export', '/spend')}`).then((r) => r.json()).then(setSpend).catch(() => null); }, [data]);
  const [sources, setSources] = useState<SourcesStatus | null>(null);
  useEffect(() => { api.sources().then(setSources).catch(() => null); }, []);

  if (!data) return <View style={styles.page}><Text style={type.small}>Loading…</Text></View>;
  const { household } = data;

  const setHome = async (p: Place | null) => {
    if (!p) { setHomeMsg(null); return; }
    try { await api.updateHousehold({ home: p }); await refresh(); setHomeMsg(`Home saved: ${p.formatted ?? p.label}`); } catch (e: any) { setHomeMsg(e.message); }
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={type.title}>Settings</Text>

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

      <SectionTitle>Account</SectionTitle>
      <Card>
        <Text style={type.body}>Private beta: one household, no sign-in.</Text>
        <Text style={type.small}>Sign in with Apple arrives with the public beta. Apple shares a name and email only — never a photo — so photos are set per person in Household.</Text>
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

      <SectionTitle hint="Cost per household per month — the planner and place lookups.">Usage this month</SectionTitle>
      <Card>
        {spend ? (
          <>
            <Text style={type.body}>{spend.month.calls} provider calls · ~${spend.month.costUsd.toFixed(2)} · bound {spend.month.bound} calls</Text>
            {spend.byProvider.map((p) => <Text key={p.provider} style={type.small}>{p.provider}: {p.calls} calls{p.cost_usd ? ` · $${p.cost_usd.toFixed(3)}` : ''}</Text>)}
          </>
        ) : <Text style={type.small}>—</Text>}
      </Card>

      <SectionTitle hint="Ratings, review counts, reviews, prices and family flags come from licensed sources. Until one is on, cards say so rather than guess.">Sources</SectionTitle>
      <Card>
        <Text style={type.small}>Places and geocoding: © OpenStreetMap contributors — open data with no reviews, ratings or prices.</Text>
        {sources ? sources.available.map((a) => (
          <Row key={a.key} style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={type.body}>{a.label}</Text>
              <Text style={type.tiny}>{a.key === 'google' ? 'Ratings, review counts, 5 reviews, prices, children flags, real travel times.' : a.key === 'tripadvisor' ? `Ratings and 3 reviews per place, added by looking up each venue by name. Off by default — pick it in the Sources row on a search form or in a trip's settings, since every location returned is billed (1,000 free for life, about 50 searches). Used so far: ${sources.usage?.tripadvisor?.searchesAllTime ?? 0} search${(sources.usage?.tripadvisor?.searchesAllTime ?? 0) === 1 ? '' : 'es'}.` : 'Timed events inside an outing.'} Switched on by the owner adding {a.env} through Doppler.</Text>
            </View>
            <Chip label={a.on ? 'On' : 'Off'} tone={a.on ? 'like' : 'neutral'} />
          </Row>
        )) : <Text style={type.tiny}>Checking which sources are live…</Text>}
        {sources ? <Text style={type.tiny}>Travel times: {sources.routing === 'google-routes' ? 'Google Routes' : 'estimated from distance'}.</Text> : null}
      </Card>

      <SectionTitle hint="Everything the household has generated. Place content from licensed sources is never included — only identifiers and what you wrote.">Your data</SectionTitle>
      <Card>
        <Button label="Export everything (JSON)" kind="secondary" onPress={() => Linking.openURL(api.exportUrl())} />
        <Text style={[type.small, { marginTop: spacing.sm }]}>Delete everything Roam holds about this household — people, trips, visits, ratings, captured menus. Type the household name to confirm.</Text>
        <Row>
          <TextInput value={confirm} onChangeText={setConfirm} placeholder={household.name} placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
          <Button label="Delete household" kind="danger" disabled={confirm !== household.name} onPress={async () => {
            try { await api.deleteHousehold(confirm); setMsg('Deleted. Run the seed to start again.'); await refresh(); } catch (e: any) { setMsg(e.message); }
          }} />
        </Row>
        {msg ? <StatusLine>{msg}</StatusLine> : null}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.sm, width: '100%', maxWidth: 760, alignSelf: 'center' },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
});

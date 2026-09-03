import React, { useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, HouseholdResponse, Place, SourcesStatus, SpendLine, SpendPeriod, SpendResponse } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Meter, Row, Segmented, SectionTitle, StatusLine, Stepper, Wrap, minutes } from '../components/ui';
import { PlacePicker } from '../components/PlacePicker';
import { DateRangePicker } from '../components/DateRangePicker';

export const SPEAK_KEY = 'roam.speakReplies';
export const getSpeakPref = () => (Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage.getItem(SPEAK_KEY) !== 'off' : true);

// Settings is two different things: how Roam plans for this household
// (preferences, the customer's) and how the app is wired and what it spends
// (sources and usage, the owner's). They share a screen, not a page.
type Section = 'preferences' | 'sources' | 'usage';
const SECTION_HINT: Record<Section, string> = {
  preferences: 'Home, pace, voice and your data: how Roam plans for this household.',
  sources: 'Which providers Roam may ask, what each gives, and what it costs.',
  usage: 'What searches and plans have used and cost, by provider, for any period.',
};

const PURPOSE_LABEL: Record<string, string> = {
  'scout.events': 'Local scout search (web)',
  'plan.interpret': 'Planner: understood what you said',
  'plan.refine': 'Planner: refined the plan',
  'plan.retrieve': 'Looked up places for a plan',
  'plan.matrix': 'Travel times for a plan',
  'plan.journey': 'Journey to the base',
  'places.search': 'Places search',
  'places.detail': 'Opened a place',
  'places.geocode': 'Address lookup',
  'trip.shortlist.search': 'Trip shortlist search',
  discover: 'Browse nearby',
  photo: 'Photo',
};

const SOURCE_BLURB: Record<string, string> = {
  google: 'Ratings, review counts, 5 reviews, prices, children flags, real travel times.',
  tripadvisor: 'Ratings and 3 reviews per place, added by looking up each venue by name. Off by default: pick it in the Sources row on a search form or in a trip\'s settings.',
  ticketmaster: 'Ticketed events inside an outing.',
  seatgeek: 'Ticketed events inside an outing.',
  predicthq: 'Events, including community ones, inside an outing.',
  datathistle: 'UK listings down to the village fair, inside an outing.',
  scout: 'Claude reads local what\'s-on pages for the place and day; each event links to its source page.',
};

// An API from before this screen answers /spend in another shape; show nothing rather than crash mid-deploy.
const usable = (r: SpendResponse | null | undefined): SpendResponse | null => (r && Array.isArray(r.lines) && Array.isArray(r.recent) && r.totals ? r : null);
const money = (n: number) => (n <= 0 ? '$0.00' : n < 0.005 ? '<$0.01' : `$${n.toFixed(2)}`);
const count = (n: number) => Math.round(n).toLocaleString('en-GB');
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function SettingsScreen({ data, refresh }: { data: HouseholdResponse | null; refresh: () => Promise<void> }) {
  const [section, setSection] = useState<Section>('preferences');
  if (!data) return <View style={styles.page}><Text style={type.small}>Loading…</Text></View>;
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={type.title}>Settings</Text>
      <Segmented value={section} onChange={setSection}
        options={[{ value: 'preferences', label: 'Preferences' }, { value: 'sources', label: 'Sources' }, { value: 'usage', label: 'Usage' }]} />
      <Text style={type.small}>{SECTION_HINT[section]}</Text>
      {section === 'preferences' ? <Preferences data={data} refresh={refresh} /> : null}
      {section === 'sources' ? <Sources /> : null}
      {section === 'usage' ? <Usage /> : null}
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
// Sources: what is wired in, what each gives, what it costs, how much of its
// free allowance has gone.
// ---------------------------------------------------------------------------

function Sources() {
  const [sources, setSources] = useState<SourcesStatus | null>(null);
  const [spend, setSpend] = useState<SpendResponse | null>(null);
  useEffect(() => { api.sources().then(setSources).catch(() => null); api.spend({ period: 'month' }).then((r) => setSpend(usable(r))).catch(() => null); }, []);
  if (!sources) return <Text style={type.small}>Checking which sources are live…</Text>;
  const defaults = sources.defaults ?? [];
  const label = (k: string) => sources.enabled.find((s) => s.key === k)?.label ?? k;
  const linesFor = (key: string) => spend?.lines.filter((l) => l.source === key) ?? [];

  return (
    <>
      <SectionTitle hint="A search runs the default set unless its Sources row says otherwise; a trip keeps its own set.">Default set</SectionTitle>
      <Card>
        <Wrap>{defaults.map((k) => <Chip key={k} label={label(k)} tone="like" />)}</Wrap>
        <Text style={type.tiny}>Places and addresses: © OpenStreetMap contributors, open data with no reviews, ratings or prices. Travel times: {sources.routing === 'google-routes' ? 'Google Routes' : 'estimated from distance'}.</Text>
      </Card>

      <SectionTitle hint="Ratings, review counts, reviews, prices and family flags come from licensed sources. Until one is on, cards say so rather than guess. Each is switched on by the owner adding its key through Doppler; keys never reach this app.">Providers</SectionTitle>
      {sources.available.map((a) => {
        const cost = sources.cost?.[a.key];
        const lines = linesFor(a.key);
        return (
          <Card key={a.key} style={{ gap: spacing.xs }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={[type.h3, { flex: 1 }]}>{a.label}</Text>
              {a.optIn && a.on ? <Chip label="Opt-in" tone="want" /> : null}
              <Chip label={a.on ? 'On' : 'Off'} tone={a.on ? 'like' : 'neutral'} />
            </Row>
            <Text style={type.small}>{SOURCE_BLURB[a.key] ?? ''}</Text>
            {cost ? <Text style={type.tiny}>{cost.perSearchUsd > 0 ? `About $${cost.perSearchUsd.toFixed(2)} a search. ` : 'Free to search. '}{cost.note}</Text> : null}
            {lines.map((l) => (l.allowance || l.cap ? <AllowanceLine key={l.key} line={l} showLabel={lines.length > 1} /> : null))}
            <Text style={type.tiny}>Key: {a.env}{lines[0]?.console ? '' : '.'}{lines[0]?.console ? <Text> · </Text> : null}{lines[0]?.console ? <ConsoleLink console={lines[0].console} /> : null}</Text>
          </Card>
        );
      })}
    </>
  );
}

/** "37 of 5,000 requests this month · resets 1 Oct", with the bar. */
function AllowanceLine({ line, showLabel }: { line: SpendLine; showLabel?: boolean }) {
  const a = line.allowance ?? line.cap;
  if (!a) return null;
  const isCap = !line.allowance;
  const window = a.kind === 'monthly' ? 'this month' : a.kind === 'daily' ? 'today' : 'ever';
  const resets = a.kind === 'lifetime' ? 'never renews' : a.resetsAt ? `resets ${shortDate(a.resetsAt)}` : '';
  const unit = isCap ? plural(a.limit, line.unit, line.unitPlural) : plural(a.limit, line.unit, line.unitPlural);
  return (
    <Meter used={a.used} limit={a.limit}
      label={`${showLabel ? `${line.label}: ` : ''}${count(a.used)} of ${count(a.limit)} ${isCap ? (a.label ?? unit) : `free ${unit}`} ${window}${resets ? ` · ${resets}` : ''}${a.estimated ? ' · estimated' : ''}`} />
  );
}

function ConsoleLink({ console: c }: { console: { label: string; url: string } }) {
  return (
    <Text style={[type.tiny, { color: colors.accent, textDecorationLine: 'underline' }]} onPress={() => Linking.openURL(c.url)} accessibilityRole="link">
      {c.label} ↗
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Usage: what a period used and cost, by provider.
// ---------------------------------------------------------------------------

function Usage() {
  const [period, setPeriod] = useState<SpendPeriod>('month');
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [spend, setSpend] = useState<SpendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [showQuiet, setShowQuiet] = useState(false);

  useEffect(() => {
    if (period === 'custom' && !from) return;
    setError(null);
    api.spend({ period, from: period === 'custom' ? from ?? undefined : undefined, to: period === 'custom' ? to ?? from ?? undefined : undefined })
      .then((r) => setSpend(usable(r))).catch((e) => setError(e.message));
  }, [period, from, to]);

  const cap = spend?.lines.find((l) => l.key === 'claude')?.cap ?? null;
  const active = spend?.lines.filter((l) => l.calls > 0 || l.costUsd > 0) ?? [];
  const quiet = spend?.lines.filter((l) => !(l.calls > 0 || l.costUsd > 0)) ?? [];
  const paid = active.filter((l) => l.paidUsd > 0);

  return (
    <>
      <SectionTitle>Period</SectionTitle>
      <Segmented value={period} onChange={setPeriod}
        options={[{ value: 'month', label: 'This month' }, { value: 'last-month', label: 'Last month' }, { value: 'all', label: 'All time' }, { value: 'custom', label: 'Dates' }]} />
      {period === 'custom' ? <DateRangePicker start={from} end={to} onApply={(s, e) => { setFrom(s); setTo(e); }} /> : null}
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}

      {spend ? (
        <>
          <Card>
            <Wrap>
              <Stat label={`Estimated spend · ${spend.period.label.toLowerCase()}`} value={money(spend.totals.costUsd)} />
              <Stat label="Provider calls" value={count(spend.totals.calls)} />
              {cap ? <Stat label="Household cap · this month" value={`${count(cap.used)} of ${count(cap.limit)}`} /> : null}
            </Wrap>
            <Text style={type.tiny}>
              {paid.length ? `Paid: ${paid.map((l) => `${l.label} ${money(l.paidUsd)}`).join(' · ')}. ` : 'Nothing beyond the free allowances. '}
              Roam's own counts at list prices, not an invoice; each provider's console holds the real bill.
            </Text>
          </Card>

          <SectionTitle hint="Calls are what Roam asked for; units are what the provider bills for. Lines with a bar have a free allowance or a Roam cap.">By provider</SectionTitle>
          {active.length === 0 ? <Card><Text style={type.small}>Nothing in this period.</Text></Card> : null}
          {active.map((l) => <LineCard key={l.key} line={l} />)}
          {quiet.length ? (
            <>
              <Button label={showQuiet ? 'Hide unused providers' : `${quiet.length} more with nothing in this period`} kind="ghost" onPress={() => setShowQuiet((v) => !v)} />
              {showQuiet ? quiet.map((l) => <LineCard key={l.key} line={l} />) : null}
            </>
          ) : null}

          <SectionTitle>Activity</SectionTitle>
          <Card>
            {spend.recent.length ? (
              <>
                <Button label={showActivity ? 'Hide activity' : `Show the ${spend.recent.length} most recent calls`} kind="ghost" onPress={() => setShowActivity((v) => !v)} />
                {showActivity ? spend.recent.map((c) => (
                  <View key={c.id} style={styles.activityRow}>
                    <Text style={[type.tiny, { width: 92 }]}>{new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
                    <Text style={[type.tiny, { flex: 1, color: colors.ink }]}>{PURPOSE_LABEL[c.purpose ?? ''] ?? c.purpose ?? c.provider}<Text style={type.tiny}> · {c.units ? Object.entries(c.units).map(([k, n]) => `${k} ${n}`).join(', ') : c.provider.replace(/\+/g, ' + ')}</Text></Text>
                    <Text style={[type.tiny, { width: 48, textAlign: 'right' }]}>{c.cost_usd ? money(c.cost_usd) : 'free'}</Text>
                  </View>
                )) : null}
              </>
            ) : <Text style={type.small}>No calls in this period.</Text>}
          </Card>
        </>
      ) : !error ? <Text style={type.small}>Adding it up…</Text> : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 140, gap: 2 }}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={type.tiny}>{label}</Text>
    </View>
  );
}

function LineCard({ line }: { line: SpendLine }) {
  const a = line.allowance ?? line.cap;
  const paidNote = line.key === 'claude' || line.key === 'scout'
    ? (line.costUsd > 0 ? `${money(line.costUsd)} by tokens` : 'nothing')
    : line.paidUsd > 0 ? `about ${money(line.paidUsd)} beyond the free allowance`
      : line.allowance ? 'nothing, inside the free allowance' : 'nothing, free';
  return (
    <Card style={{ gap: spacing.xs }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[type.h3, { flex: 1 }]}>{line.label}</Text>
        {!line.on ? <Chip label="Off" /> : null}
        <Text style={[type.h3, { color: line.paidUsd > 0 ? colors.ink : colors.inkMuted }]}>{line.paidUsd > 0 ? money(line.paidUsd) : 'free'}</Text>
      </Row>
      <Text style={type.small}>
        {count(line.calls)} {plural(line.calls, 'call', 'calls')}
        {line.unit !== 'call' && line.unit !== 'run' ? ` · ${count(line.units)} ${plural(line.units, line.unit, line.unitPlural)}${line.estimated ? ' (estimated)' : ''}` : ''}
        {' · paid '}{paidNote}
      </Text>
      {a ? <AllowanceLine line={line} /> : null}
      <Text style={type.tiny}>{line.what}{line.allowance?.basis ? ` Free allowance: ${line.allowance.basis}.` : ''}{line.cap?.env ? ` Cap set by ${line.cap.env}.` : ''}{line.hardStop ? ` ${line.hardStop}` : ''}</Text>
      {line.console ? <ConsoleLink console={line.console} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.sm, width: '100%', maxWidth: 760, alignSelf: 'center' },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  statValue: { fontSize: 22, fontWeight: '700', color: colors.ink, letterSpacing: -0.3 },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 4, borderTopWidth: 1, borderTopColor: colors.line },
});

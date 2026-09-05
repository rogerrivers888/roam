import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { api, KeyReport, SourcesStatus, SpendLine, SpendResponse, SpendSeries } from '../api';
import { Comparison, MonthBars } from './SpendChart';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, FoldLine, Meter, Row, Segmented, StatusLine, Wrap } from './ui';
import { useViewport } from '../hooks/useViewport';

/**
 * Settings › Providers (owner, 3 Sep 2026): one table, not two tabs. A row per
 * provider with its switch, free and paid requests, cost for the period, reset
 * date and console link; a period switch above; tap a row for the drawer with
 * the granular view (every period, the allowance meter, what it gives, its
 * activity). On a phone the same rows stack and the drawer is a sheet.
 */

type Period = 'month' | 'last-month' | 'all';
type Filter = 'all' | 'on' | 'off' | 'paid';
const PERIOD_LABEL: Record<Period, string> = { month: 'This month', 'last-month': 'Last month', all: 'All time' };
const money = (n: number) => (n <= 0 ? '$0.00' : n < 0.005 ? '<$0.01' : `$${n.toFixed(2)}`);
const count = (n: number) => Math.round(n).toLocaleString('en-GB');
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const PURPOSE_LABEL: Record<string, string> = {
  'scout.events': 'Local scout search', 'plan.interpret': 'Planner: understood you', 'plan.refine': 'Planner: refined', 'plan.retrieve': 'Looked up places for a plan',
  'plan.matrix': 'Travel times for a plan', 'plan.journey': 'Journey to the base', 'places.search': 'Places search', 'places.detail': 'Opened a place', 'places.geocode': 'Address lookup',
  'trip.shortlist.search': 'Trip shortlist search', discover: 'Browse nearby', photo: 'Photo', 'ui.preview': 'Preview',
};

/** Free and paid units for a line in a period, from its allowance window. */
function split(line: SpendLine, period: Period) {
  const p = line.periods?.[period] ?? { calls: line.calls, units: line.units, costUsd: line.costUsd, estimated: line.estimated };
  const a = line.allowance;
  // Paid units: those past the allowance in its own window; for a lifetime allowance that is all-time use past the limit.
  const over = a ? Math.max(0, a.used - a.limit) : 0;
  const paidUnits = a ? Math.min(p.units, over) : 0;
  const freeUnits = Math.max(0, p.units - paidUnits);
  const paidUsd = line.key === 'claude' || line.key === 'scout' ? p.costUsd : paidUnits * (a?.beyondUsd ?? 0);
  return { ...p, freeUnits, paidUnits, paidUsd };
}

export function ProvidersTable() {
  const { width } = useViewport();
  const wide = width >= 900;
  const [period, setPeriod] = useState<Period>('month');
  const [filter, setFilter] = useState<Filter>('all');
  const [sources, setSources] = useState<SourcesStatus | null>(null);
  const [spend, setSpend] = useState<SpendResponse | null>(null);
  const [series, setSeries] = useState<SpendSeries | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = async () => {
    try {
      const [s, sp, se] = await Promise.all([api.sources(), api.spend({ period: 'month' }), api.spendSeries(12).catch(() => null)]);
      setSources(s); setSpend(sp && Array.isArray(sp.lines) ? sp : null); setSeries(se); setError(null);
      if (se && !month) setMonth(se.months[se.months.length - 1]);
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    if (!spend) return [];
    return spend.lines.map((l) => {
      const src = sources?.available.find((a) => a.key === l.source);
      const hasKey = l.key === 'claude' || l.source === 'osm' || l.source === 'fixtures' || Boolean(src?.hasKey);
      const off = Boolean(src?.off);
      const switchable = l.key !== 'claude' && l.key === l.source;
      return { line: l, s: split(l, period), hasKey, off, switchable, on: l.on };
    }).filter((r) => filter === 'all' || (filter === 'on' ? r.on : filter === 'off' ? !r.on : r.s.paidUsd > 0));
  }, [spend, sources, period, filter]);

  const toggle = async (key: string, on: boolean) => {
    setBusyKey(key);
    try { await api.setSourceOn(key, on); await load(); } catch (e: any) { setError(e.message); } finally { setBusyKey(null); }
  };

  const total = spend?.totalsByPeriod?.[period] ?? spend?.totals;
  const paidTotal = rows.reduce((n, r) => n + r.s.paidUsd, 0);
  const open = spend?.lines.find((l) => l.key === openKey) ?? null;

  return (
    <View style={{ gap: spacing.sm }}>
      <Row style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <View style={{ minWidth: 280, flex: 1 }}><Segmented value={period} options={(['month', 'last-month', 'all'] as Period[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] }))} onChange={setPeriod} /></View>
        <Wrap>
          {(['all', 'on', 'off', 'paid'] as Filter[]).map((f) => <Chip key={f} label={f === 'all' ? 'All' : f === 'on' ? 'On' : f === 'off' ? 'Off' : 'Costing money'} selected={filter === f} tone={filter === f ? 'accent' : 'neutral'} onPress={() => setFilter(f)} />)}
        </Wrap>
      </Row>
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      {!spend ? <Text style={type.small}>Adding it up…</Text> : null}
      {spend && total ? (
        <Text style={type.small}>
          {PERIOD_LABEL[period]}: {count(total.calls)} provider {plural(total.calls, 'call', 'calls')} · estimated {money(total.costUsd)}{paidTotal > 0 ? ` · paid ${money(paidTotal)}` : ' · nothing beyond the free allowances'}. Roam's own counts at list prices; each provider's console holds the real bill.
        </Text>
      ) : null}

      {series && month ? (
        <Card>
          <MonthBars points={series.total.map((t) => ({ month: t.month, costUsd: t.costUsd, calls: t.calls }))} selected={month} onSelect={setMonth} unitLabel="All providers, estimated spend" />
          <Comparison points={series.total.map((t) => ({ month: t.month, costUsd: t.costUsd, calls: t.calls }))} selected={month} />
        </Card>
      ) : null}

      {spend ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {wide ? (
            <View style={styles.tr}>
              <Text style={[styles.th, { flex: 2, textAlign: 'left' }]}>Provider</Text>
              <Text style={[styles.th, { flex: 0.7 }]}>On</Text>
              <Text style={[styles.th, { flex: 1.8 }]}>Free</Text>
              <Text style={[styles.th, { flex: 1 }]}>Paid units</Text>
              <Text style={[styles.th, { flex: 0.8 }]}>Calls</Text>
              <Text style={[styles.th, { flex: 1 }]}>Cost</Text>
              <Text style={[styles.th, { flex: 1 }]}>Per search</Text>
              <Text style={[styles.th, { flex: 1 }]}>Resets</Text>
              <Text style={[styles.th, { flex: 0.8 }]}>Console</Text>
            </View>
          ) : null}
          {rows.map((r) => <ProviderRow key={r.line.key} r={r} wide={wide} busy={busyKey === r.line.key} onOpen={() => setOpenKey(r.line.key)} onToggle={(on) => toggle(r.line.source, on)} />)}
          {!rows.length ? <Text style={[type.small, { padding: spacing.md }]}>Nothing matches that filter.</Text> : null}
        </Card>
      ) : null}
      <Text style={type.tiny}>Free counts against each provider's own window (a month, a day, or the account's lifetime) whatever period is shown. A source without a key cannot be switched on here; the owner adds keys through Doppler. Places and addresses: © OpenStreetMap contributors. Travel times: {sources?.routing === 'google-routes' ? 'Google Routes' : 'estimated from distance'}.</Text>

      <KeyWiring />

      {open ? <ProviderDrawer line={open} period={period} spend={spend!} series={series} initialMonth={month} source={sources?.available.find((a) => a.key === open.source) ?? null} onClose={() => setOpenKey(null)} onToggle={(on) => toggle(open.source, on)} busy={busyKey === open.key} /> : null}
    </View>
  );
}

/**
 * Why a key that is in Doppler is not in the API.
 *
 * "The key is in Doppler" and "the API can read the key" are two different
 * facts and the gap between them has cost hours more than once. This is that
 * gap, on screen: which Railway service answered, which Doppler config was
 * pulled into it, and for each key whether it is set — and if it is set but
 * still not working, which of the three ways it can be wrong applies.
 *
 * Folded shut, because it is only interesting when something is missing.
 */
function KeyWiring() {
  const [report, setReport] = useState<KeyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setReport(await api.keys()); setError(null); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const missing = report?.expected.filter((k) => !k.set) ?? [];
  const wrong = report?.expected.filter((k) => k.set && (k.quoted || k.padded || k.unresolvedReference)) ?? [];
  const summary = !report ? (loading ? 'Reading…' : error ?? '—')
    : wrong.length ? `${wrong.length} set but malformed`
      : missing.length ? `${missing.length} not set` : 'All present';

  return (
    <FoldLine label="Keys the API can actually see" value={summary} icon="settings">
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      {report ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.tiny}>
            Answered by Railway service <Text style={{ color: colors.ink }}>{report.service.railwayService ?? '?'}</Text> in{' '}
            <Text style={{ color: colors.ink }}>{report.service.railwayEnvironment ?? '?'}</Text>, build {report.service.commit ?? '?'}, running since{' '}
            {new Date(report.service.startedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.
          </Text>

          {report.doppler.project ? (
            <Text style={type.tiny}>Doppler config: {report.doppler.project} / {report.doppler.config ?? '?'}.</Text>
          ) : null}

          {/* The lesson from 5 Sep 2026, written where it will be read again.
              Doppler said "In Sync" and was telling the truth: its sync was
              pointed at roam / Shared / production, so the secret landed in
              Railway's project-level shared pool — and a Railway shared
              variable is not on a service until that service is told to take
              it. Every key set up earlier worked; the new one did not. */}
          {missing.length ? (
            <StatusLine tone="warn">
              {missing.map((k) => k.name).join(', ')} {missing.length === 1 ? 'is' : 'are'} not on this service. If Doppler says “In Sync”, check what its
              sync is pointed at: a destination of “Shared” puts the secret in Railway's project-level shared variables, and a service does not get one
              of those until it is told to take it. A sync aimed straight at the {report.service.railwayService ?? 'api'} service lands every future key on its own.
            </StatusLine>
          ) : null}

          <View style={styles.table}>
            {report.expected.map((k) => (
              <View key={k.name} style={styles.tr2}>
                <Text style={[styles.td, { flex: 2, textAlign: 'left', color: colors.ink }]} numberOfLines={1}>{k.name}</Text>
                <Text style={[styles.td, { flex: 1, color: k.set ? colors.like : colors.inkMuted }]}>{k.set ? 'set' : 'not set'}</Text>
                <Text style={[styles.td, { flex: 2 }]} numberOfLines={1}>
                  {!k.set ? '—'
                    : k.unresolvedReference ? 'unresolved ${{ }} reference'
                      : k.quoted ? 'wrapped in quotes'
                        : k.padded ? 'has stray whitespace'
                          : `${k.length} chars${k.kind ? ` · ${k.kind}` : ''}`}
                </Text>
              </View>
            ))}
          </View>

          {report.otherSecretNames.length ? (
            <Text style={type.tiny}>Other credential-looking names here, in case one is a misspelling of the above: {report.otherSecretNames.join(', ')}.</Text>
          ) : null}
          <Row>
            <Button label={loading ? 'Checking…' : 'Check again'} kind="secondary" icon="refresh" onPress={load} loading={loading} />
          </Row>
          <Text style={type.tiny}>{report.note}</Text>
        </View>
      ) : null}
    </FoldLine>
  );
}

type RowModel = { line: SpendLine; s: ReturnType<typeof split>; hasKey: boolean; off: boolean; switchable: boolean; on: boolean };

function allowanceText(line: SpendLine) {
  const a = line.allowance ?? line.cap;
  if (!a) return { text: '—', ratio: 0 };
  const unit = plural(a.limit, line.unit, line.unitPlural);
  return { text: `${count(a.used)} / ${count(a.limit)} ${unit}${line.allowance ? '' : ' · cap'}`, ratio: a.limit ? a.used / a.limit : 0 };
}
function resetText(line: SpendLine) {
  const a = line.allowance ?? line.cap;
  if (!a) return '—';
  return a.kind === 'lifetime' ? 'never' : a.resetsAt ? shortDate(a.resetsAt) : '—';
}

function ProviderRow({ r, wide, busy, onOpen, onToggle }: { r: RowModel; wide: boolean; busy: boolean; onOpen: () => void; onToggle: (on: boolean) => void }) {
  const { line, s } = r;
  const al = allowanceText(line);
  const sw = !r.switchable ? null : (
    <Switch value={r.on} disabled={busy || !r.hasKey} onValueChange={onToggle} accessibilityLabel={`${line.label} ${r.on ? 'on' : 'off'}`} />
  );
  if (wide) {
    return (
      <Pressable onPress={onOpen} style={({ hovered }: any) => [styles.tr, hovered && { backgroundColor: colors.surfaceMuted }]} accessibilityRole="button" accessibilityLabel={`Open ${line.label}`}>
        <View style={{ flex: 2 }}>
          <Text style={type.h3}>{line.label}</Text>
          <Text style={type.tiny} numberOfLines={1}>{!r.hasKey && line.key !== 'claude' ? 'No key yet' : r.off ? 'Switched off' : line.allowance?.basis ?? line.what}</Text>
        </View>
        <View style={{ flex: 0.7, alignItems: 'flex-end' }}>{sw ?? <Text style={type.tiny}>{line.key === 'claude' ? (line.on ? 'on' : 'off') : `with ${line.source}`}</Text>}</View>
        <View style={{ flex: 1.8, alignItems: 'flex-end', gap: 3 }}>
          <Text style={[styles.td, { color: al.ratio >= 0.9 ? colors.overrun : al.ratio >= 0.7 ? colors.dislike : colors.ink }]}>{al.text}</Text>
          {line.allowance || line.cap ? <View style={{ width: 90 }}><Meter used={(line.allowance ?? line.cap)!.used} limit={(line.allowance ?? line.cap)!.limit} /></View> : null}
        </View>
        <Text style={[styles.td, { flex: 1 }]}>{line.allowance ? count(s.paidUnits) : '—'}</Text>
        <Text style={[styles.td, { flex: 0.8 }]}>{count(s.calls)}</Text>
        <Text style={[styles.td, { flex: 1, fontWeight: '700', color: s.paidUsd > 0 ? colors.ink : colors.inkMuted }]}>{s.paidUsd > 0 ? money(s.paidUsd) : 'free'}</Text>
        <Text style={[styles.td, { flex: 1 }]}>{line.perSearchUsd ? `$${line.perSearchUsd.toFixed(2)}` : line.key === 'claude' ? 'by tokens' : 'free'}</Text>
        <Text style={[styles.td, { flex: 1 }]}>{resetText(line)}</Text>
        <View style={{ flex: 0.8, alignItems: 'flex-end' }}>{line.console ? <Text style={[type.tiny, { color: colors.accent, textDecorationLine: 'underline' }]} onPress={() => Linking.openURL(line.console!.url)}>Open ↗</Text> : <Text style={type.tiny}>—</Text>}</View>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onOpen} style={styles.stack} accessibilityRole="button" accessibilityLabel={`Open ${line.label}`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[type.h3, { flex: 1 }]}>{line.label}</Text>
        <Text style={[type.h3, { color: s.paidUsd > 0 ? colors.ink : colors.inkMuted }]}>{s.paidUsd > 0 ? money(s.paidUsd) : 'free'}</Text>
        {sw}
      </Row>
      <Text style={type.small}>{count(s.calls)} {plural(s.calls, 'call', 'calls')}{line.allowance ? ` · free ${al.text} · paid ${count(s.paidUnits)}` : line.cap ? ` · ${al.text}` : ''}{resetText(line) !== '—' ? ` · resets ${resetText(line)}` : ''}</Text>
      {line.allowance || line.cap ? <Meter used={(line.allowance ?? line.cap)!.used} limit={(line.allowance ?? line.cap)!.limit} /> : null}
    </Pressable>
  );
}

function ProviderDrawer({ line, period, spend, series, initialMonth, source, onClose, onToggle, busy }: { line: SpendLine; period: Period; spend: SpendResponse; series: SpendSeries | null; initialMonth: string | null; source: SourcesStatus['available'][number] | null; onClose: () => void; onToggle: (on: boolean) => void; busy: boolean }) {
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900;
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const } : null;
  const [tab, setTab] = useState<'spend' | 'activity'>('spend');
  const [month, setMonth] = useState<string>(initialMonth ?? series?.months[series.months.length - 1] ?? '');
  const a = line.allowance ?? line.cap;
  const activity = spend.recent.filter((c) => c.lines?.includes(line.key)).slice(0, 60);
  const hasKey = line.key === 'claude' || line.source === 'osm' || line.source === 'fixtures' || Boolean(source?.hasKey);
  const isAi = line.key === 'claude' || line.key === 'scout';
  // What the chart shows: money for Claude lines; for metered providers the paid part, with units in the tooltip.
  const points = (series?.lines[line.key] ?? []).map((p) => ({ month: p.month, costUsd: isAi ? p.costUsd : p.paidUsd, calls: p.calls, units: p.units }));
  return (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.panel, wide ? styles.panelSide : styles.panelSheet, frameBox]}>
          <ScrollView contentContainerStyle={{ gap: spacing.md, padding: spacing.lg }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.h2}>{line.label}</Text>
                <Text style={type.small}>{line.what}</Text>
              </View>
              <Pressable onPress={onClose} style={styles.close} accessibilityLabel="Close"><Text style={{ fontSize: 20 }}>✕</Text></Pressable>
            </Row>
            {line.key === line.source && line.key !== 'claude' ? (
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={type.body}>{line.on ? 'Switched on' : hasKey ? 'Switched off' : 'No key yet'}</Text>
                <Switch value={line.on} disabled={busy || !hasKey} onValueChange={onToggle} />
              </Row>
            ) : null}
            <Segmented value={tab} options={[{ value: 'spend', label: 'Spend' }, { value: 'activity', label: `Activity (${activity.length})` }]} onChange={setTab} />

            {tab === 'spend' ? (
              <>
                {points.length && month ? (
                  <Card>
                    <MonthBars points={points} selected={month} onSelect={setMonth} unitLabel={isAi ? 'Estimated spend' : 'Paid beyond the free allowance'} />
                    <Comparison points={points} selected={month} />
                    {!isAi ? <Text style={type.tiny}>Tap a month to compare it. Units by month: {points.slice(-6).map((p) => `${new Date(`${p.month}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short' })} ${count(p.units ?? 0)}`).join(' · ')}.</Text> : <Text style={type.tiny}>Tap a month to compare it.</Text>}
                  </Card>
                ) : null}
                {a ? (
                  <Card>
                    <Text style={type.h3}>{line.allowance ? 'Free allowance' : 'Roam cap'}</Text>
                    <Meter used={a.used} limit={a.limit} label={`${count(a.used)} of ${count(a.limit)} ${plural(a.limit, line.unit, line.unitPlural)} ${a.kind === 'monthly' ? 'this month' : a.kind === 'daily' ? 'today' : 'ever'} · ${a.kind === 'lifetime' ? 'never renews' : a.resetsAt ? `resets ${shortDate(a.resetsAt)}` : ''}${a.estimated ? ' · estimated' : ''}`} />
                    <Text style={type.tiny}>{line.allowance?.basis ? `${line.allowance.basis}.` : ''}{line.allowance?.beyondUsd ? ` Beyond it about $${line.allowance.beyondUsd.toFixed(3)} per ${line.unit}.` : ''}{line.cap?.env ? ` Set by ${line.cap.env}.` : ''}{line.hardStop ? ` ${line.hardStop}` : ''}</Text>
                  </Card>
                ) : null}
                <Card>
                  <Text style={type.h3}>By period</Text>
                  <View style={styles.table}>
                    <View style={styles.tr2}><Text style={[styles.th, { flex: 1.4, textAlign: 'left' }]}>Period</Text><Text style={styles.th}>Calls</Text><Text style={styles.th}>{line.unitPlural}</Text><Text style={styles.th}>Cost</Text></View>
                    {(['month', 'last-month', 'all'] as Period[]).map((p) => { const s = split(line, p); return (
                      <View key={p} style={[styles.tr2, p === period && { backgroundColor: colors.accentSoft }]}>
                        <Text style={[styles.td, { flex: 1.4, textAlign: 'left', color: colors.ink }]}>{PERIOD_LABEL[p]}</Text>
                        <Text style={styles.td}>{count(s.calls)}</Text>
                        <Text style={styles.td}>{line.unit === 'call' || line.unit === 'run' ? '—' : `${count(s.units)}${s.estimated ? '*' : ''}`}</Text>
                        <Text style={[styles.td, { fontWeight: '700', color: colors.ink }]}>{s.paidUsd > 0 ? money(s.paidUsd) : 'free'}</Text>
                      </View>
                    ); })}
                  </View>
                  <Text style={type.tiny}>* estimated from search counts for calls made before units were recorded.{line.perSearchUsd ? ` About $${line.perSearchUsd.toFixed(2)} per search.` : ''}</Text>
                </Card>
                {source ? <Text style={type.tiny}>Key: {source.env}, added by the owner through Doppler.{source.optIn ? ' Opt-in: runs only when a search names it.' : ''}</Text> : null}
                {line.console ? <Button label={`${line.console.label} ↗`} kind="secondary" onPress={() => Linking.openURL(line.console!.url)} /> : null}
              </>
            ) : (
              <Card>
                {activity.length ? activity.map((c) => (
                  <View key={c.id} style={styles.activityRow}>
                    <Text style={[type.tiny, { width: 92 }]}>{new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
                    <Text style={[type.tiny, { flex: 1, color: colors.ink }]}>{PURPOSE_LABEL[c.purpose ?? ''] ?? c.purpose ?? c.provider}{c.units?.[line.key] != null ? <Text style={type.tiny}> · {c.units[line.key]} {plural(c.units[line.key], line.unit, line.unitPlural)}</Text> : null}</Text>
                    <Text style={[type.tiny, { width: 48, textAlign: 'right' }]}>{c.cost_usd && isAi ? money(c.cost_usd) : 'free'}</Text>
                  </View>
                )) : <Text style={type.small}>No calls yet.</Text>}
              </Card>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tr: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10, paddingHorizontal: spacing.md, borderTopWidth: 1, borderTopColor: colors.line, minHeight: TARGET },
  tr2: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: colors.line },
  th: { flex: 1, fontSize: 11, fontWeight: '700', color: colors.inkMuted, textAlign: 'right' },
  td: { fontSize: 13, color: colors.inkMuted, textAlign: 'right', flex: 1 },
  table: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' },
  stack: { gap: 4, padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.line },
  backdropWrap: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(29,27,22,0.35)' },
  panel: { backgroundColor: colors.bg },
  panelSide: { width: 460, maxWidth: '100%', height: '100%', borderLeftWidth: 1, borderLeftColor: colors.line },
  panelSheet: { width: '100%', height: '100%' },
  close: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  activityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 4, borderTopWidth: 1, borderTopColor: colors.line },
});

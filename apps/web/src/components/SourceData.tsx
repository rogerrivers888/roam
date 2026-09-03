import React, { useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, SourcesStatus, SourceTrace, SourceTraceVenue, TripDetail } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap, clock } from './ui';
import { isAdmin } from '../admin';

/**
 * Admin-only source views (owner, 3 Sep 2026): "what data has come from
 * Tripadvisor and what's come from Google, so I can assess the quality".
 *
 * - `useSourceFilter` turns any list carrying `source` / `contributingSources`
 *   into chips (one per source, with counts) and the filtered list.
 * - `SourceDataPanel` is the Data section inside a trip: run the plan's own
 *   retrieval for a day, see what every source returned and where the plan
 *   lost it, filter by source and stage, and open the raw record.
 */

type Sourced = { source?: string | null; contributingSources?: string[] };
const sourcesOf = (v: Sourced) => (v.contributingSources?.length ? v.contributingSources : [v.source ?? 'unknown']);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function useSourceFilter<T extends Sourced>(list: T[]) {
  const admin = isAdmin();
  const [only, setOnly] = useState<string | null>(null);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const v of list) for (const s of sourcesOf(v)) c.set(s, (c.get(s) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);
  const filtered = useMemo(() => (admin && only ? list.filter((v) => sourcesOf(v).includes(only)) : list), [list, only, admin]);
  const chips = admin && counts.length ? (
    <Wrap>
      <Text style={[type.tiny, { alignSelf: 'center' }]}>Source</Text>
      {counts.map(([s, n]) => <Chip key={s} label={`${s} (${n})`} selected={only === s} tone={only === s ? 'accent' : 'neutral'} onPress={() => setOnly((cur) => (cur === s ? null : s))} />)}
    </Wrap>
  ) : null;
  return { filtered, chips, only, admin };
}

/** "via osm + google · rating google" under a row, admin only. */
export function SourceLine({ item }: { item: Sourced & { ratingSource?: string | null } }) {
  if (!isAdmin()) return null;
  return <Text style={[type.tiny, { color: colors.want }]}>via {sourcesOf(item).join(' + ')}{item.ratingSource ? ` · rating ${item.ratingSource}` : ''}</Text>;
}

const STAGE_LABEL: Record<string, string> = { shown: 'Shown', window: "Outside the day's window", allergen: 'Excluded by allergen', reach: 'Beyond reach', catchment: 'Too far' };
const STAGE_TONE: Record<string, 'like' | 'dislike' | 'allergen' | 'neutral'> = { shown: 'like', window: 'dislike', allergen: 'allergen', reach: 'neutral', catchment: 'neutral' };

export function SourceDataPanel({ d }: { d: TripDetail }) {
  const { trip, days } = d;
  const [dayId, setDayId] = useState<string | null>(days[0]?.id ?? null);
  // One source at a time (owner): "view just the Tripadvisor data or just the Google data". null = the plan's own set.
  const [only, setOnly] = useState<string | null>(null);
  const [status, setStatus] = useState<SourcesStatus | null>(null);
  useEffect(() => { api.sources().then(setStatus).catch(() => null); }, []);
  const scout = only === 'scout';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<SourceTrace | null>(null);
  const [stage, setStage] = useState<'all' | 'shown' | 'dropped'>('all');
  const [kind, setKind] = useState<'all' | 'events' | 'places'>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [shown, setShown] = useState(40);

  const run = async () => {
    setBusy(true); setError(null);
    try { setTrace(await api.tripSources(trip.id, { dayId: dayId ?? undefined, sources: only ?? undefined, scout: scout ? '1' : undefined })); setShown(40); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { setTrace(null); }, [dayId, only]);
  const priceOf = (k: string) => status?.cost?.[k]?.perSearchUsd ?? 0;
  const onlyLabel = only ? (status?.enabled.find((s) => s.key === only)?.label ?? only) : null;
  const fetchPrice = only ? priceOf(only) : (status?.defaults ?? []).reduce((n, k) => n + priceOf(k), 0);

  const byKind = useMemo(() => (trace?.venues ?? []).filter((v) => kind === 'all' || (kind === 'events') === (v.category === 'event')), [trace, kind]);
  const byStage = useMemo(() => byKind.filter((v) => stage === 'all' || (stage === 'shown') === (v.stage === 'shown')), [byKind, stage]);
  const sf = useSourceFilter(byStage);
  const list = sf.filtered;
  const sources = trace ? [...new Set([...trace.sourcesQueried, ...Object.keys(trace.stages[0]?.bySource ?? {})])] : [];

  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <Text style={type.h3}>Source data for a day</Text>
        <Text style={type.small}>Runs the plan's own search around {trip.base?.label ?? trip.origin.label} for the day, with no Claude call, and shows what every source returned and where the plan lost it. Searches are free except Tripadvisor (only if this trip names it) and the scout.</Text>
        {days.length > 1 ? <Wrap>{days.map((dd, i) => <Chip key={dd.id} label={`Day ${i + 1} · ${dd.date.slice(5)}`} selected={dd.id === dayId} onPress={() => setDayId(dd.id)} />)}</Wrap> : null}
        <Wrap>
          <Text style={[type.tiny, { alignSelf: 'center' }]}>Fetch from</Text>
          <Chip label="The plan's own set" selected={only === null} tone={only === null ? 'accent' : 'neutral'} onPress={() => setOnly(null)} />
          {(status?.enabled ?? []).map((s) => <Chip key={s.key} label={`${s.label} only${priceOf(s.key) ? ` · $${priceOf(s.key).toFixed(2)}` : ''}`} selected={only === s.key} tone={only === s.key ? 'accent' : 'neutral'} onPress={() => setOnly(s.key)} />)}
        </Wrap>
        <Text style={type.tiny}>{fetchPrice > 0 ? `About $${fetchPrice.toFixed(2)} per fetch${only ? ` (${status?.cost?.[only]?.note ?? ''})` : ' with this set'}.` : 'This fetch is free.'}{only === 'tripadvisor' ? ' Alone, Tripadvisor returns one page around the base; with others it looks their venues up by name.' : ''}</Text>
        <Row style={{ flexWrap: 'wrap' }}>
          <Button label={`${trace ? 'Refresh' : 'Fetch'}${onlyLabel ? ` ${onlyLabel} only` : ''}`} onPress={run} loading={busy} />
        </Row>
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      </Card>

      {trace ? (
        <>
          <Card>
            <Text style={type.h3}>Where each source's records went</Text>
            <Text style={type.tiny}>
              {trace.trip.date} · {trace.radiusKm} km around {trace.trip.base.label} · window {clock(trace.trip.window.from)}–{clock(trace.trip.window.to)} · reach {trace.maxTravelMinutes} min {trace.trip.mode} · asked: {trace.sourcesQueried.join(', ') || 'none'}
            </Text>
            {trace.degraded.length ? trace.degraded.map((g) => <StatusLine key={g.source} tone="warn">{g.source} failed: {g.error}</StatusLine>) : null}
            {trace.spend ? (
              <Text style={[type.small, { color: colors.ink }]}>
                This fetch cost {trace.spend.actualUsd > 0 ? `$${trace.spend.actualUsd.toFixed(2)} (Claude)` : 'nothing'}
                {trace.spend.byProvider.length ? ` · ${trace.spend.byProvider.map((p) => `${p.key} ${p.units} ${p.units === 1 ? 'unit' : 'units'}${p.usd ? ` (~$${p.usd.toFixed(2)} list price, free inside the allowance)` : ''}`).join(', ')}` : ' · no provider requests'}
              </Text>
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={[styles.table, { minWidth: 160 + 64 * (sources.length + 1) }]}>
              <View style={styles.tr}>
                <Text style={[styles.th, { flex: 2 }]}>Stage</Text>
                {sources.map((s) => <Text key={s} style={styles.th}>{s}</Text>)}
                <Text style={styles.th}>all</Text>
              </View>
              {trace.stages.map((st) => (
                <View key={st.key} style={styles.tr}>
                  <Text style={[styles.td, { flex: 2, color: colors.ink }]}>{st.label}</Text>
                  {sources.map((s) => <Text key={s} style={styles.td}>{st.bySource[s] ?? 0}</Text>)}
                  <Text style={[styles.td, { fontWeight: '700', color: colors.ink }]}>{st.total}</Text>
                </View>
              ))}
            </View>
            </ScrollView>
            <Text style={type.tiny}>"After merging" counts a merged record once per source that contributed to it, so a place Google and Tripadvisor both returned counts for both.</Text>
          </Card>

          <Card>
            <Segmented value={kind} options={[{ value: 'all', label: `All (${trace.venues.length})` }, { value: 'events', label: `What's on (${trace.venues.filter((v) => v.category === 'event').length})` }, { value: 'places', label: `Places (${trace.venues.filter((v) => v.category !== 'event').length})` }]} onChange={(v) => { setKind(v); setShown(40); }} />
            <Segmented value={stage} options={[{ value: 'all', label: 'Every record' }, { value: 'shown', label: 'Shown to browse' }, { value: 'dropped', label: 'Dropped' }]} onChange={(v) => { setStage(v); setShown(40); }} />
            {sf.chips}
            <Text style={type.small}>{list.length} record{list.length === 1 ? '' : 's'}</Text>
            {list.slice(0, shown).map((v) => <TraceRow key={v.key} v={v} open={openKey === v.key} onToggle={() => setOpenKey((k) => (k === v.key ? null : v.key))} />)}
            {list.length > shown ? <Button label={`Show ${Math.min(40, list.length - shown)} more of ${list.length}`} kind="ghost" onPress={() => setShown((n) => n + 40)} /> : null}
          </Card>
        </>
      ) : null}
    </View>
  );
}

function TraceRow({ v, open, onToggle }: { v: SourceTraceVenue; open: boolean; onToggle: () => void }) {
  const isEvent = v.category === 'event';
  return (
    <View style={styles.row}>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.h3}>{v.name}{v.chain ? <Text style={[type.tiny, { color: colors.dislike }]}>  chain</Text> : null}</Text>
          <Text style={type.small}>
            {isEvent && v.startsAt ? `${clock(v.startsAt)}${v.endsAt ? `–${clock(v.endsAt)}` : ''}${v.venueName ? ` · ${v.venueName}` : ''} · ` : ''}
            {[v.category, ...v.experiences, ...v.cuisines].filter(Boolean).join(' · ')}
          </Text>
          <Text style={type.small}>
            {v.rating != null ? `★ ${v.rating.toFixed(1)}${v.ratingCount ? ` (${v.ratingCount.toLocaleString()})` : ''} from ${v.ratingSource}` : 'no rating'} · {v.distanceKm} km{v.travelMinutes != null ? `, ${v.travelMinutes} min${v.travelEstimated ? ' est.' : ''}` : ''}{v.score != null ? ` · score ${Math.round(v.score)}` : ''}{v.photoCount ? ` · ${v.photoCount} photo` : ''}
          </Text>
          <Text style={[type.tiny, { color: colors.want }]}>via {v.contributingSources.join(' + ')}{v.conflicts.length ? ` · ${v.conflicts.length} disagreement${v.conflicts.length === 1 ? '' : 's'}` : ''}</Text>
          {v.justification ? <Text style={type.tiny}>{v.justification}</Text> : null}
          {v.reason ? <Text style={[type.tiny, { color: v.stage === 'shown' ? colors.inkMuted : colors.overrun }]}>{v.reason}</Text> : null}
        </View>
        <View style={{ gap: 4, alignItems: 'flex-end' }}>
          <Chip label={STAGE_LABEL[v.stage]} tone={STAGE_TONE[v.stage]} />
          <Chip label={open ? 'Hide raw' : 'Raw'} onPress={onToggle} />
          {v.externalUrl ? <Chip label="Open ↗" onPress={() => Linking.openURL(v.externalUrl!)} /> : null}
        </View>
      </Row>
      {open ? (
        <View style={styles.raw}>
          {v.conflicts.length ? <Text style={type.tiny}>Disagreements: {v.conflicts.map((c) => `${c.field}: ${c.heldSource ?? '?'} says ${JSON.stringify(c.held)}, ${c.offeredSource ?? '?'} says ${JSON.stringify(c.offered)}`).join('; ')}</Text> : null}
          <Text selectable style={styles.mono}>{JSON.stringify(v.raw, null, 2)}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  table: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' },
  tr: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 6, paddingHorizontal: 8, gap: 4 },
  th: { flex: 1, minWidth: 56, fontSize: 11, fontWeight: '700', color: colors.inkMuted, textAlign: 'right' },
  td: { flex: 1, minWidth: 56, fontSize: 12, color: colors.inkMuted, textAlign: 'right' },
  row: { paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line, gap: 4 },
  raw: { backgroundColor: colors.surfaceMuted, borderRadius: radius.sm, padding: spacing.sm, gap: 4 },
  mono: { fontFamily: 'Menlo, monospace', fontSize: 11, color: colors.ink },
});

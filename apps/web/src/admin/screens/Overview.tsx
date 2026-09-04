/**
 * The back office's first screen: how big the estate is, how busy it is, what it
 * earns and what it costs.
 *
 * The order is deliberate and is Parcelvision's: the figures first, then the
 * shape over time, then the detail. Somebody opening this at nine in the morning
 * wants three seconds of "is anything wrong", not a chart to interpret.
 *
 * Money is one capability away. Without `view_financials` the tiles that would
 * carry it say so (`Withheld`) rather than vanishing — an absent revenue tile
 * reads as "there is no revenue", which is a different and wrong fact.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { AdminOverview, api, ApiError } from '../../api';
import { colors, spacing, type } from '../../theme';
import { Row, Wrap } from '../../components/ui';
import { Icon, IconName } from '../../components/Icon';
import {
  AdminPage, Banner, FilterChip, PageHead, Panel, RangePicker, Tile, TileRow, Withheld,
  ago, count, duration, money, monthLabel, plural, pounds,
} from '../kit';
import { Columns, RankedBars } from '../charts';

/** What each daily measure is called, and how it reads. One at a time: never two y-axes. */
const MEASURES = [
  { key: 'households', label: 'Households here', format: (n: number) => String(n) },
  { key: 'seconds', label: 'Time in Roam', format: duration },
  { key: 'places', label: 'Places saved', format: (n: number) => String(n) },
  { key: 'trips', label: 'Trips planned', format: (n: number) => String(n) },
] as const;

const KIND_ICON: Record<string, IconName> = {
  place: 'places', visit: 'booked', trip: 'trips', order: 'money', menu: 'list',
};

export function Overview({ onOpenPerson }: { onOpenPerson?: (id: string) => void }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [measure, setMeasure] = useState<typeof MEASURES[number]['key']>('households');

  const load = useCallback(async () => {
    try { setData(await api.adminOverview(days)); setError(null); } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
    }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const m = MEASURES.find((x) => x.key === measure)!;
  const points = (data?.daily ?? []).map((d) => ({
    label: new Date(d.day).toLocaleDateString([], { day: 'numeric', month: 'short' }),
    value: Number((d as any)[measure] ?? 0),
  }));

  return (
    <AdminPage>
      <PageHead
        title="Overview"
        sub="The estate at a glance — who is here, what they are doing, and what it costs to serve them."
        right={<RangePicker days={days} onDays={setDays} />}
      />

      {error ? <Banner tone="crit">{error}</Banner> : null}

      {data ? (
        <>
          <TileRow>
            <Tile label="Households" value={count(data.totals.households)} sub={`${data.totals.accounts} with an account`} />
            <Tile
              label="Active today"
              value={count(data.active.dau)}
              sub={`${data.active.wau} this week · ${data.active.mau} this month`}
              tone={data.active.dau > 0 ? 'ok' : 'plain'}
            />
            <Tile
              label="Stickiness"
              value={`${data.active.stickiness}%`}
              sub="of the month's households were here today"
            />
            <Tile label="Time in Roam" value={duration(data.active.seconds_30d)} sub="last 30 days, everybody" />
            <Tile label="Places saved" value={count(data.totals.places)} sub={`${data.totals.trips} trips · ${data.totals.visits} visits`} />
            <Tile
              label="Joined this month"
              value={count(data.totals.joined_this_month)}
              sub={`${data.totals.invited} invited, not in yet`}
              tone={data.totals.invited > 0 ? 'warn' : 'plain'}
            />
            {/* Roam has no App Store listing — it is an installable web app — so
                this is the honest version of that figure rather than a borrowed one. */}
            <Tile
              label="Installed"
              value={count(data.installs?.households_standalone ?? 0)}
              sub={`${plural(data.installs?.added_ever ?? 0, 'add')} to a home screen`}
            />
          </TileRow>

          {data.money ? (
            <TileRow>
              <Tile label="Contracted MRR" value={pounds(data.money.mrrPence)} sub="what today's plans are priced at" tone="accent" />
              <Tile label="Contracted ARR" value={pounds(data.money.mrrPence * 12)} sub="MRR × 12, nothing collected" />
              <Tile label="Provider cost" value={money(data.money.costMonthUsd)} sub="this month, measured from provider_calls" tone={data.money.costMonthUsd > 0 ? 'warn' : 'plain'} />
              <Tile label="Cost, all time" value={money(data.totals.cost_ever_usd)} sub={`${count(data.totals.calls_month)} calls this month`} />
            </TileRow>
          ) : (
            <Withheld what="Revenue and provider cost" capability="view_financials" />
          )}

          <Panel
            title={m.label}
            sub={`By day, last ${days} days. One measure at a time — two scales on one chart is a chart that lies.`}
            right={
              <Wrap>
                {MEASURES.map((x) => (
                  <FilterChip key={x.key} label={x.label} on={x.key === measure} onPress={() => setMeasure(x.key)} />
                ))}
              </Wrap>
            }
          >
            <Columns points={points} format={m.format} />
          </Panel>

          <Row style={{ gap: spacing.md, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <View style={{ flexGrow: 1, flexBasis: 320 }}>
              <Panel title="Where the time goes" sub={`Screens by time spent, last ${days} days.`}>
                {data.screens.length ? (
                  <RankedBars
                    rows={data.screens.slice(0, 8).map((s) => ({ label: s.screen, value: s.seconds, hint: plural(s.views, 'view') }))}
                    format={duration}
                  />
                ) : (
                  <Text style={type.small}>
                    Nothing recorded yet. Screens and time appear once somebody uses the app on this build — it is the app that reports them.
                  </Text>
                )}
              </Panel>
            </View>

            <View style={{ flexGrow: 1, flexBasis: 320 }}>
              <Panel title="Lately" sub="The last thing each household did.">
                <View style={{ gap: spacing.sm }}>
                  {data.feed.length ? data.feed.map((f, i) => (
                    <Row key={`${f.at}-${i}`} style={{ gap: spacing.sm, alignItems: 'flex-start' }}>
                      <Icon name={KIND_ICON[f.kind] ?? 'info'} size={14} color={colors.inkMuted} />
                      <View style={{ flex: 1 }}>
                        <Text style={type.small} numberOfLines={1}>{f.title}</Text>
                        <Text style={type.tiny}>{f.household_name} · {ago(f.at)}{f.detail ? ` · ${f.detail}` : ''}</Text>
                      </View>
                    </Row>
                  )) : <Text style={type.small}>Nothing has happened yet.</Text>}
                </View>
              </Panel>
            </View>
          </Row>

          {data.money ? (
            <Panel
              title="Contracted revenue"
              sub="What the plans people were on were priced at, month by month. Nothing here has been collected — Roam holds no payment provider."
            >
              <Columns
                points={data.money.revenue.map((r) => ({ label: monthLabel(r.month), value: r.revenue_pence, hint: plural(r.households, 'household') }))}
                format={pounds}
              />
            </Panel>
          ) : null}
        </>
      ) : !error ? <Text style={type.small}>Reading the estate…</Text> : null}
    </AdminPage>
  );
}

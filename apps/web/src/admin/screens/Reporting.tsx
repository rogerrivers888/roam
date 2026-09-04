/**
 * Reporting — engagement, revenue and usage, on three tabs.
 *
 * Parcelvision's own arrangement (`ReportTabs`), and for its reason: these are
 * three different questions asked by three different people, and putting them on
 * one page means everybody scrolls past two thirds of it.
 *
 *  - **Engagement** — are people coming back, and to what. The cohort grid is
 *    the one figure that says whether Roam is worth *having* rather than worth
 *    trying.
 *  - **Revenue** — what the plans people are on are priced at. Contracted, never
 *    collected: Roam holds no payment provider, and the screen says so at the
 *    top rather than letting a reader assume the number is cash.
 *  - **Usage** — what serving them costs, by provider and by household, which is
 *    the number a price has to clear.
 *
 * Revenue is behind `view_financials`; the tab is drawn either way and says so,
 * because a missing tab is a question somebody asks twice.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api, ApiError, Engagement, RevenueReport, UsageReport } from '../../api';
import { colors, spacing, type } from '../../theme';
import { Row, Wrap } from '../../components/ui';
import {
  AdminPage, Banner, Column, DataTable, FilterChip, PageHead, Panel, Pill, RangePicker,
  Tile, TileRow, Withheld, ago, count, duration, money, monthLabel, plural, pounds,
} from '../kit';
import { CohortGrid, Columns, RankedBars } from '../charts';

type Tab = 'engagement' | 'revenue' | 'usage';

export function Reporting({ canSeeMoney }: { canSeeMoney: boolean }) {
  const [tab, setTab] = useState<Tab>('engagement');
  const [days, setDays] = useState(30);

  return (
    <AdminPage>
      <PageHead
        title="Reporting"
        sub="How Roam is used, what it earns, and what it costs to serve."
        right={<RangePicker days={days} onDays={setDays} />}
      />
      <Wrap>
        <FilterChip label="Engagement" on={tab === 'engagement'} onPress={() => setTab('engagement')} />
        <FilterChip label="Revenue" on={tab === 'revenue'} onPress={() => setTab('revenue')} />
        <FilterChip label="Usage & cost" on={tab === 'usage'} onPress={() => setTab('usage')} />
      </Wrap>

      {tab === 'engagement' ? <EngagementTab days={days} /> : null}
      {tab === 'revenue' ? (canSeeMoney ? <RevenueTab /> : <Withheld what="Revenue" capability="view_financials" />) : null}
      {tab === 'usage' ? <UsageTab days={days} canSeeMoney={canSeeMoney} /> : null}
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------

function EngagementTab({ days }: { days: number }) {
  const [data, setData] = useState<Engagement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [measure, setMeasure] = useState<'households' | 'seconds' | 'views'>('households');

  const load = useCallback(async () => {
    try { setData(await api.adminEngagement(days)); setError(null); } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
    }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <Banner tone="crit">{error}</Banner>;
  if (!data) return <Text style={type.small}>Reading engagement…</Text>;

  const format = measure === 'seconds' ? duration : (n: number) => String(n);

  return (
    <View style={{ gap: spacing.md }}>
      <TileRow>
        <Tile label="Active today" value={count(data.active.dau)} tone={data.active.dau ? 'ok' : 'plain'} sub="households with any activity" />
        <Tile label="Active this week" value={count(data.active.wau)} />
        <Tile label="Active this month" value={count(data.active.mau)} />
        <Tile label="Stickiness" value={`${data.active.stickiness}%`} sub="daily ÷ monthly — how habitual Roam is" tone={data.active.stickiness >= 20 ? 'ok' : 'plain'} />
        <Tile label="Time in Roam" value={duration(data.active.seconds_30d)} sub="everybody, last 30 days" />
      </TileRow>

      <Panel
        title="By day"
        sub="One measure at a time. Two scales on one pair of axes is the commonest way a chart misleads."
        right={
          <Wrap>
            <FilterChip label="Households" on={measure === 'households'} onPress={() => setMeasure('households')} />
            <FilterChip label="Time" on={measure === 'seconds'} onPress={() => setMeasure('seconds')} />
            <FilterChip label="Screens" on={measure === 'views'} onPress={() => setMeasure('views')} />
          </Wrap>
        }
      >
        <Columns
          points={data.daily.map((d) => ({ label: new Date(d.day).toLocaleDateString([], { day: 'numeric', month: 'short' }), value: Number((d as any)[measure] ?? 0) }))}
          format={format}
        />
      </Panel>

      <Panel
        title="Retention"
        sub="Of the households that joined in a week, how many came back in the weeks after. The one figure that says whether Roam is worth having rather than worth trying."
      >
        <CohortGrid cohorts={data.retention.cohorts} cells={data.retention.cells} />
      </Panel>

      <Row style={{ gap: spacing.md, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <View style={{ flexGrow: 1, flexBasis: 320 }}>
          <Panel title="Where the time goes" sub="Screens, across every household.">
            {data.screens.length
              ? <RankedBars rows={data.screens.slice(0, 10).map((s) => ({ label: s.screen, value: s.seconds, hint: `${plural(s.views, 'view')} · ${plural(s.households ?? 0, 'household')}` }))} format={duration} />
              : <Text style={type.small}>No screen time recorded yet.</Text>}
          </Panel>
        </View>
        <View style={{ flexGrow: 1, flexBasis: 320 }}>
          <Panel title="Who is using it" sub="Ranked by time in the app.">
            {data.leaders.length
              ? <RankedBars rows={data.leaders.slice(0, 10).map((l) => ({ label: l.name || l.email || 'somebody', value: l.seconds, hint: `${plural(l.daysActive, 'day')} · last in ${ago(l.lastActive)}` }))} format={duration} />
              : <Text style={type.small}>Nobody has been in yet.</Text>}
          </Panel>
        </View>
      </Row>
    </View>
  );
}

// ---------------------------------------------------------------------------

function RevenueTab() {
  const [data, setData] = useState<RevenueReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { setData(await api.adminRevenue()); setError(null); } catch (e: any) {
        setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
      }
    })();
  }, []);

  if (error) return <Banner tone="crit">{error}</Banner>;
  if (!data) return <Text style={type.small}>Reading revenue…</Text>;

  return (
    <View style={{ gap: spacing.md }}>
      {/* Said before any figure, because everything below is read wrongly without it. */}
      <Banner tone="warn">
        <Text style={{ fontWeight: '700' }}>Contracted, not collected. </Text>
        Roam holds no payment provider — no card, no Stripe, no payout. Every figure here is what the plans people are
        on are priced at. Cash received, failed payments and refunds are not knowable from this database and are not
        shown as zero.
      </Banner>

      <TileRow>
        <Tile label="MRR" value={pounds(data.mrrPence)} tone="accent" sub={`${plural(data.paying, 'paying household')}`} />
        <Tile label="ARR" value={pounds(data.arrPence)} sub="MRR × 12" />
        <Tile label="ARPU" value={pounds(data.arpuPence)} sub="per paying household" />
        <Tile label="On a free plan" value={count(data.free)} sub="trials and friends" />
        <Tile label="Provider cost" value={money(data.totals.cost_month_usd)} tone="warn" sub="this month, measured" />
      </TileRow>

      <Panel title="Contracted revenue by month" sub="Priced by what each household was on during that month, so changing a price today does not rewrite last quarter.">
        <Columns points={data.revenue.map((r) => ({ label: monthLabel(r.month), value: r.revenue_pence, hint: plural(r.households, 'household') }))} format={pounds} />
      </Panel>

      <Panel title="Provider cost by month" sub="Its own chart, not a second line on the one above: pounds and dollars do not share an axis.">
        <Columns points={data.cost.map((c) => ({ label: monthLabel(c.month), value: c.cost_usd, hint: plural(c.calls, 'call') }))} format={(n) => money(n)} />
      </Panel>

      <Panel padded={false} title="By plan">
        <DataTable
          rows={data.byPlan.map((p) => ({ ...p, id: p.key }))}
          columns={[
            { key: 'plan', head: 'Plan', width: 3, cell: (p: any) => <Text style={type.small}>{p.label}</Text>, sort: (p: any) => p.label },
            { key: 'price', head: 'Price', width: 2, cell: (p: any) => <Text style={type.small}>{p.price_pence == null ? 'free' : `${pounds(p.price_pence)}/mo`}</Text>, sort: (p: any) => p.price_pence ?? 0 },
            { key: 'households', head: 'Households', width: 2, align: 'right', cell: (p: any) => <Text style={type.small}>{count(p.households)}</Text>, sort: (p: any) => p.households },
            { key: 'mrr', head: 'MRR', width: 2, align: 'right', cell: (p: any) => <Text style={type.small}>{pounds(p.mrr_pence)}</Text>, sort: (p: any) => p.mrr_pence },
          ] as Column<any>[]}
        />
      </Panel>
    </View>
  );
}

// ---------------------------------------------------------------------------

function UsageTab({ days, canSeeMoney }: { days: number; canSeeMoney: boolean }) {
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.adminUsage(days)); setError(null); } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
    }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <Banner tone="crit">{error}</Banner>;
  if (!data) return <Text style={type.small}>Reading usage…</Text>;

  const overCeiling = data.households.filter((h) => h.bound && h.used >= h.bound * 0.8);

  return (
    <View style={{ gap: spacing.md }}>
      <Banner>
        Every household draws on the same provider allowances — a Google or Tripadvisor free tier is per provider
        account, not per household. That is why each account carries its own monthly ceiling, and why this screen is
        about pressure on one shared pot rather than a bill per customer.
      </Banner>

      {overCeiling.length ? (
        <Banner tone="warn">
          {overCeiling.length} household{overCeiling.length === 1 ? ' is' : 's are'} past four fifths of their monthly ceiling.
          Roam will stop searching for them at it.
        </Banner>
      ) : null}

      {!canSeeMoney ? <Withheld what="What each provider costs" capability="view_financials" /> : null}

      <Panel title="By provider" sub={`Calls and cost, last ${days} days.`}>
        <RankedBars
          rows={data.byProvider.slice(0, 12).map((p) => ({
            label: p.provider,
            value: p.calls,
            hint: canSeeMoney ? `${money(p.cost_usd)} · ${plural(p.households, 'household')}` : plural(p.households, 'household'),
          }))}
          format={count}
        />
      </Panel>

      <Panel padded={false} title="By household" sub="Against their own ceiling.">
        <DataTable
          rows={data.households.map((h) => ({ ...h, id: h.accountId }))}
          initialSort={{ key: 'calls', dir: 'desc' }}
          columns={[
            { key: 'who', head: 'Household', width: 3, cell: (h: any) => <Text style={type.small}>{h.name || h.email}</Text>, sort: (h: any) => h.name || h.email },
            { key: 'calls', head: 'Calls', width: 2, align: 'right', cell: (h: any) => <Text style={type.small}>{count(h.calls)}</Text>, sort: (h: any) => h.calls },
            {
              key: 'ceiling', head: 'Ceiling', width: 3, align: 'right',
              cell: (h: any) => (
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <Text style={type.small}>{h.bound ? `${count(h.used)} / ${count(h.bound)}` : count(h.used)}</Text>
                  {h.bound ? <Text style={[type.tiny, h.used >= h.bound * 0.8 && { color: colors.overrun }]}>{Math.round((h.used / h.bound) * 100)}% used</Text> : null}
                </View>
              ),
              sort: (h: any) => (h.bound ? h.used / h.bound : 0),
            },
            ...(canSeeMoney ? [{
              key: 'cost', head: 'Cost', width: 2, align: 'right' as const,
              cell: (h: any) => <Text style={type.small}>{money(h.costUsd)}</Text>,
              sort: (h: any) => h.costUsd ?? 0,
            }] : []),
          ] as Column<any>[]}
        />
      </Panel>
    </View>
  );
}

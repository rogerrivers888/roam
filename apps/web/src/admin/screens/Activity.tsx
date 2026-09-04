/**
 * Activity — everything that has happened, across every household.
 *
 * The estate's own feed, read from the tables the work lives in: a place saved
 * is a row in `household_places`, a trip is a trip. Nothing here comes from a
 * tracking log, which is why it cannot quietly stop reporting a feature that
 * somebody forgot to instrument.
 *
 * Behind `view_activity`. Support holds it, because "what were they doing when
 * it went wrong" is the first question of every support conversation; an
 * analyst holds it too, and neither of them can see what it costs.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api, ApiError, DailyRow, FeedRow, ScreenRow } from '../../api';
import { colors, spacing, type } from '../../theme';
import { Row } from '../../components/ui';
import { Icon, IconName } from '../../components/Icon';
import { AdminPage, Banner, FilterChip, FilterRow, PageHead, Panel, RangePicker, Tile, TileRow, ago, count, duration, plural } from '../kit';
import { Columns, RankedBars } from '../charts';

const KIND_ICON: Record<string, IconName> = {
  place: 'places', visit: 'booked', trip: 'trips', order: 'money', menu: 'list',
};
const KINDS = ['place', 'visit', 'trip', 'menu', 'order'];

export function Activity() {
  const [days, setDays] = useState(30);
  const [kind, setKind] = useState<string | null>(null);
  const [data, setData] = useState<{ feed: FeedRow[]; screens: ScreenRow[]; daily: DailyRow[]; active: any } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.adminActivity(days)); setError(null); } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
    }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const feed = (data?.feed ?? []).filter((f) => !kind || f.kind === kind);

  return (
    <AdminPage>
      <PageHead
        title="Activity"
        sub="What every household has been doing, newest first."
        right={<RangePicker days={days} onDays={setDays} />}
      />
      {error ? <Banner tone="crit">{error}</Banner> : null}

      {data ? (
        <>
          <TileRow>
            <Tile label="Active today" value={count(data.active.dau)} tone={data.active.dau ? 'ok' : 'plain'} />
            <Tile label="This week" value={count(data.active.wau)} />
            <Tile label="This month" value={count(data.active.mau)} />
            <Tile label="Time in Roam" value={duration(data.active.seconds_30d)} sub="last 30 days" />
          </TileRow>

          <Panel title="Households here, by day">
            <Columns
              points={data.daily.map((d) => ({ label: new Date(d.day).toLocaleDateString([], { day: 'numeric', month: 'short' }), value: d.households }))}
              height={110}
            />
          </Panel>

          {data.screens.length ? (
            <Panel title="Where the time goes">
              <RankedBars rows={data.screens.slice(0, 8).map((s) => ({ label: s.screen, value: s.seconds, hint: plural(s.views, 'view') }))} format={duration} />
            </Panel>
          ) : null}

          <FilterRow>
            <FilterChip label="Everything" on={!kind} onPress={() => setKind(null)} count={data.feed.length} />
            {KINDS.map((k) => (
              <FilterChip
                key={k} label={k} on={kind === k} onPress={() => setKind(kind === k ? null : k)}
                count={data.feed.filter((f) => f.kind === k).length}
              />
            ))}
          </FilterRow>

          <Panel title="The feed" sub="Read from each household's own rows.">
            <View style={{ gap: spacing.sm }}>
              {feed.length ? feed.map((f, i) => (
                <Row key={`${f.at}-${i}`} style={{ gap: spacing.sm, alignItems: 'flex-start' }}>
                  <Icon name={KIND_ICON[f.kind] ?? 'info'} size={15} color={colors.inkMuted} />
                  <View style={{ flex: 1 }}>
                    <Text style={type.small} numberOfLines={1}>{f.title}</Text>
                    <Text style={type.tiny}>
                      {f.household_name}{f.detail ? ` · ${f.detail}` : ''} · {ago(f.at)}
                    </Text>
                  </View>
                </Row>
              )) : <Text style={type.small}>Nothing of that kind yet.</Text>}
            </View>
          </Panel>
        </>
      ) : !error ? <Text style={type.small}>Reading the estate…</Text> : null}
    </AdminPage>
  );
}

/**
 * People — every household, what they are on, and what they have been doing.
 *
 * The table is Parcelvision's Users screen in Roam's tokens: filters in one row
 * above it, sortable columns, a status pill, and a **drawer for the record**
 * rather than a second page. The drawer is the drill-down the owner asked to
 * mirror — everything about one household in one place, opened from the row and
 * closed back to the same scroll position.
 *
 * Two capabilities are visible in the layout rather than hidden behind an error:
 * without `view_financials` the cost column is not drawn at all and the screen
 * says why; without `view_activity` the drawer's behaviour panel says the same.
 * A blank column would read as "this household costs nothing".
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { AdminPeople, AdminPerson, api, ApiError, PersonRecord } from '../../api';
import { colors, spacing, type } from '../../theme';
import { Row, Wrap, Button } from '../../components/ui';
import { Icon, IconName } from '../../components/Icon';
import { SideSheet } from '../../components/SideSheet';
import {
  AdminPage, Banner, Column, DataTable, FilterChip, FilterRow, PageHead, Panel, Pill,
  RangePicker, Tile, TileRow, Withheld, ago, count, day, duration, money, plural, pounds,
} from '../kit';
import { Columns, RankedBars, Sparkline } from '../charts';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'plain'> = {
  active: 'ok', invited: 'warn', suspended: 'crit',
};

const KIND_ICON: Record<string, IconName> = {
  place: 'places', visit: 'booked', rating: 'favourite', trip: 'trips', shortlist: 'shortlist',
  plan: 'plan', menu: 'list', order: 'money', group: 'household', sign_in: 'locked',
};

export function People({ canManageRoles }: { canManageRoles: boolean }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AdminPeople | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.adminPeople(days)); setError(null); } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
    }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const seesMoney = Boolean(data && !data.withheld.includes('view_financials'));
  const rows = useMemo(
    () => (data?.people ?? []).filter((p) => !status || p.status === status),
    [data, status],
  );

  const columns: Column<AdminPerson>[] = [
    {
      key: 'person', head: 'Household', width: 3, sort: (p) => p.name || p.email,
      cell: (p) => (
        <View style={{ gap: 2 }}>
          <Text style={[type.small, { fontWeight: '700', color: colors.ink }]} numberOfLines={1}>{p.name || p.email}</Text>
          <Text style={type.tiny} numberOfLines={1}>{p.householdName ?? p.email}</Text>
        </View>
      ),
    },
    {
      key: 'status', head: 'Status', width: 2, sort: (p) => p.status,
      cell: (p) => (
        <Wrap>
          <Pill label={p.status} tone={STATUS_TONE[p.status] ?? 'plain'} />
          {p.role?.label && p.role.key !== 'member' ? <Pill label={p.role.label} tone="accent" icon="accounts" /> : null}
        </Wrap>
      ),
    },
    { key: 'plan', head: 'Plan', width: 2, sort: (p) => p.plan, cell: (p) => <Text style={type.small}>{p.plan}</Text> },
    {
      key: 'joined', head: 'Here since', width: 2, wideOnly: true, sort: (p) => p.createdAt,
      cell: (p) => <Text style={type.small}>{ago(p.createdAt)}</Text>,
    },
    {
      key: 'lastIn', head: 'Last in', width: 2, sort: (p) => p.lastSeenAt ?? '',
      cell: (p) => (
        <View style={{ gap: 2 }}>
          <Text style={type.small}>{ago(p.lastSeenAt)}</Text>
          <Text style={type.tiny}>{plural(p.signInCount, 'sign-in')}</Text>
        </View>
      ),
    },
    {
      key: 'activity', head: 'Activity', width: 3, sort: (p) => p.activity.seconds,
      cell: (p) => (
        <View style={{ gap: 2 }}>
          <Text style={type.small}>{duration(p.activity.seconds)}</Text>
          <Text style={type.tiny}>{plural(p.activity.daysActive, 'day')} · {plural(p.activity.views, 'screen')}</Text>
        </View>
      ),
    },
    ...(seesMoney ? [{
      key: 'cost', head: 'Cost', width: 2, align: 'right' as const, wideOnly: true,
      sort: (p: AdminPerson) => p.usage?.costUsd ?? 0,
      cell: (p: AdminPerson) => (
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <Text style={type.small}>{money(p.usage?.costUsd)}</Text>
          <Text style={type.tiny}>{count(p.usage?.calls ?? 0)}{p.usage?.bound ? ` / ${count(p.usage.bound)}` : ''}</Text>
        </View>
      ),
    }] : []),
  ];

  return (
    <AdminPage>
      <PageHead
        title="Households"
        sub="Every household with Roam, what they do in it, and what they cost. Tap one to open its record."
        right={<RangePicker days={days} onDays={setDays} />}
      />

      {error ? <Banner tone="crit">{error}</Banner> : null}

      {data ? (
        <>
          <TileRow>
            <Tile label="Households" value={count(data.people.length)} sub={`${data.people.filter((p) => p.status === 'active').length} active`} />
            <Tile label="Invited, not in" value={count(data.people.filter((p) => p.status === 'invited').length)} tone={data.people.some((p) => p.status === 'invited') ? 'warn' : 'plain'} sub="a link was sent" />
            <Tile label="Suspended" value={count(data.people.filter((p) => p.status === 'suspended').length)} tone={data.people.some((p) => p.status === 'suspended') ? 'crit' : 'plain'} sub="signed out, data kept" />
            <Tile label="Signed in now" value={count(data.people.filter((p) => p.liveDevices > 0).length)} sub="on at least one device" />
          </TileRow>

          <FilterRow>
            <FilterChip label="Everybody" on={!status} onPress={() => setStatus(null)} count={data.people.length} />
            {['active', 'invited', 'suspended'].map((s) => (
              <FilterChip
                key={s} label={s} on={status === s} onPress={() => setStatus(status === s ? null : s)}
                count={data.people.filter((p) => p.status === s).length}
              />
            ))}
          </FilterRow>

          {!seesMoney ? <Withheld what="What each household costs to serve" capability="view_financials" /> : null}

          <Panel padded={false}>
            <DataTable
              rows={rows}
              columns={columns}
              initialSort={{ key: 'lastIn', dir: 'desc' }}
              onRow={(p) => setOpen(p.id)}
              empty={<Text style={type.small}>Nobody matches that filter.</Text>}
            />
          </Panel>
        </>
      ) : !error ? <Text style={type.small}>Reading the estate…</Text> : null}

      {open ? (
        <PersonDrawer
          id={open}
          days={days}
          roles={data?.roles ?? []}
          canManageRoles={canManageRoles}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      ) : null}
    </AdminPage>
  );
}

/**
 * One household's record.
 *
 * Everything in one panel-stack rather than tabs: an administrator opening this
 * is answering a question ("why has nobody been in for a fortnight", "what did
 * they actually do"), and tabs hide the half of the answer they did not guess.
 */
function PersonDrawer({ id, days, roles, canManageRoles, onClose, onChanged }: {
  id: string;
  days: number;
  roles: AdminPeople['roles'];
  canManageRoles: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [record, setRecord] = useState<PersonRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRecord(await api.adminPerson(id, days)); setError(null); } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
    }
  }, [id, days]);
  useEffect(() => { void load(); }, [load]);

  const setRole = async (roleId: string | null) => {
    setBusy(true);
    try { await api.adminSetRole(id, roleId); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const a = record?.account;
  const b = record?.behaviour;

  return (
    <SideSheet
      size="lg"
      title={a?.name || a?.email || 'Household'}
      subtitle={record?.household?.name ?? undefined}
      onClose={onClose}
    >
      {error ? <Banner tone="crit">{error}</Banner> : null}
      {!record ? <Text style={type.small}>Reading their record…</Text> : (
        <View style={{ gap: spacing.md }}>
          <TileRow>
            <Tile label="Status" value={a!.status} tone={STATUS_TONE[a!.status] ?? 'plain'} sub={`on ${a!.plan}`} />
            <Tile label="Here since" value={ago(a!.createdAt)} sub={day(a!.createdAt)} />
            <Tile label="Last in" value={ago(a!.lastSeenAt)} sub={`${a!.signInCount} sign-ins`} />
            <Tile label="Devices" value={count(record.devices.length)} sub="signed in now" />
          </TileRow>

          {b ? (
            <>
              <TileRow>
                <Tile label="Time in Roam" value={duration(Number(b.summary.seconds_window ?? 0))} sub={`last ${days} days`} tone="accent" />
                <Tile label="Days active" value={count(Number(b.summary.days_active ?? 0))} sub={`of the last ${days}`} />
                <Tile label="Places" value={count(Number(b.summary.places ?? 0))} sub={`${b.summary.places_window ?? 0} added lately`} />
                <Tile label="Trips" value={count(Number(b.summary.trips ?? 0))} sub={`${b.summary.visits ?? 0} visits · ${b.summary.ratings ?? 0} ratings`} />
              </TileRow>

              <Panel title="Time in Roam" sub={`By day, last ${days} days.`}>
                <Columns
                  points={b.daily.map((d) => ({ label: new Date(d.day).toLocaleDateString([], { day: 'numeric', month: 'short' }), value: d.seconds }))}
                  format={duration}
                  height={110}
                />
              </Panel>

              {b.screens.length ? (
                <Panel title="Where their time goes">
                  <RankedBars rows={b.screens.slice(0, 6).map((s) => ({ label: s.screen, value: s.seconds, hint: plural(s.views, 'view') }))} format={duration} />
                </Panel>
              ) : null}

              <Panel title="What they have done" sub="Read from the household's own rows, not from a tracking log.">
                <View style={{ gap: spacing.sm }}>
                  {b.feed.length ? b.feed.slice(0, 25).map((f, i) => (
                    <Row key={`${f.at}-${i}`} style={{ gap: spacing.sm, alignItems: 'flex-start' }}>
                      <Icon name={KIND_ICON[f.kind] ?? 'info'} size={14} color={colors.inkMuted} />
                      <View style={{ flex: 1 }}>
                        <Text style={type.small} numberOfLines={1}>{f.title}</Text>
                        <Text style={type.tiny}>{f.kind}{f.detail ? ` · ${f.detail}` : ''} · {ago(f.at)}</Text>
                      </View>
                    </Row>
                  )) : <Text style={type.small}>They have not done anything in Roam yet.</Text>}
                </View>
              </Panel>
            </>
          ) : (
            <Withheld what="What this household has been doing" capability="view_activity" />
          )}

          <Panel title="The household" sub="Who Roam is planning for.">
            {record.members.length ? (
              <View style={{ gap: 4 }}>
                {record.members.map((m) => (
                  <Row key={m.id} style={{ gap: spacing.sm }}>
                    <Text style={[type.small, { flex: 1 }]}>{m.name}{m.relationship ? ` · ${m.relationship}` : ''}</Text>
                    {m.allergens ? <Pill label={`${m.allergens} allergen${m.allergens === 1 ? '' : 's'}`} tone="crit" icon="allergen" /> : null}
                    {m.dislikes ? <Pill label={`${m.dislikes} dislikes`} /> : null}
                  </Row>
                ))}
              </View>
            ) : <Text style={type.small}>Nobody has been added to this household yet.</Text>}
          </Panel>

          <Panel title="What they may do" sub="A role decides which applications they can open and what they can do inside.">
            <Wrap>
              {roles.filter((r) => !r.isOwner).map((r) => (
                <FilterChip
                  key={r.id}
                  label={r.label}
                  on={a!.role?.id === r.id}
                  onPress={canManageRoles && !busy ? () => setRole(a!.role?.id === r.id ? null : r.id) : () => {}}
                />
              ))}
            </Wrap>
            {!canManageRoles ? <Text style={type.tiny}>You may see roles but not grant them — that needs “Manage roles”.</Text> : null}
            {a!.role ? <Text style={type.tiny}>Doors: {a!.role.doors.join(', ')}</Text> : <Text style={type.tiny}>No role: the household app, and nothing else.</Text>}
          </Panel>

          <Panel title="Devices" sub="Signed in for ninety days at a time.">
            {record.devices.length ? record.devices.map((d) => (
              <Row key={d.id} style={{ gap: spacing.sm }}>
                <Text style={[type.small, { flex: 1 }]}>{d.label ?? 'A device'}</Text>
                <Text style={type.tiny}>last seen {ago(d.lastSeen)}</Text>
              </Row>
            )) : <Text style={type.small}>No device is signed in.</Text>}
          </Panel>

          {record.audit.length ? (
            <Panel title="What has been done to them" sub="Every administrative act, and who did it.">
              {record.audit.map((r) => (
                <Row key={r.id} style={{ gap: spacing.sm, alignItems: 'flex-start' }}>
                  <Icon name="info" size={13} color={colors.inkMuted} />
                  <Text style={[type.tiny, { flex: 1 }]}>
                    {r.action} · {r.actor_label ?? 'somebody'} · {ago(r.at)}
                  </Text>
                </Row>
              ))}
            </Panel>
          ) : null}
        </View>
      )}
    </SideSheet>
  );
}

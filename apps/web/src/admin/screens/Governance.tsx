/**
 * Roles, plans and the audit trail — the three screens that decide what the
 * back office *is*, as opposed to what it reports.
 *
 * **Roles** is the capability matrix: which doors a role opens and which ticks
 * it carries, grouped by area. Parcelvision's own arrangement, and its warning
 * is written on the screen: a capability that nearly fits gets borrowed, and
 * then whoever may invite a friend may also delete a household.
 *
 * **Plans** is where a price comes from. Nothing here moves money — Roam holds
 * no payment provider — so a price is what a household is *on*, and it is what
 * makes the revenue report arithmetic rather than invention.
 *
 * **Audit** is who did what to whom. A back office where the only record of an
 * action is its result is one where nobody can answer that question.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError, AuditRow, Capability, Role, SubscriptionPlan } from '../../api';
import { colors, radius, spacing, TARGET, type } from '../../theme';
import { Button, Row, Wrap } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { SideSheet } from '../../components/SideSheet';
import {
  AdminPage, Banner, Column, DataTable, FilterChip, PageHead, Panel, Pill,
  ago, count, day, pounds,
} from '../kit';

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

export function Roles({ canManage }: { canManage: boolean }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [doors, setDoors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Role | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.adminRoles();
      setRoles(r.roles); setCapabilities(r.capabilities); setDoors(r.doors); setError(null);
    } catch (e: any) { setError(e instanceof ApiError ? e.message : 'Could not reach Roam.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const areas = [...new Set(capabilities.map((c) => c.area))];

  return (
    <AdminPage>
      <PageHead
        title="Roles"
        sub="A door says which application somebody may open; a capability says what they may do inside."
        right={canManage ? <Button label={adding ? 'Cancel' : 'New role'} icon={adding ? 'close' : 'add'} onPress={() => setAdding((v) => !v)} /> : undefined}
      />
      {error ? <Banner tone="crit">{error}</Banner> : null}

      <Banner>
        Reading and changing are always a separate tick. It is tempting to grant the one that nearly fits — and then
        whoever may invite a friend may also delete a household.
      </Banner>

      {adding ? <NewRole doors={doors} capabilities={capabilities} onDone={() => { setAdding(false); void load(); }} /> : null}

      <Panel padded={false}>
        <DataTable
          rows={roles}
          onRow={(r) => setOpen(r)}
          columns={[
            {
              key: 'role', head: 'Role', width: 3, sort: (r) => r.label,
              cell: (r) => (
                <View style={{ gap: 2 }}>
                  <Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>{r.label}</Text>
                  {r.description ? <Text style={type.tiny} numberOfLines={1}>{r.description}</Text> : null}
                </View>
              ),
            },
            {
              key: 'doors', head: 'Opens', width: 2,
              cell: (r) => <Wrap>{r.doors.map((d) => <Pill key={d} label={d} tone={d === 'admin' ? 'accent' : 'plain'} />)}</Wrap>,
            },
            {
              key: 'caps', head: 'Capabilities', width: 2, align: 'right', sort: (r) => (r.is_owner ? 99 : r.capabilities.length),
              cell: (r) => <Text style={type.small}>{r.is_owner ? 'everything' : count(r.capabilities.length)}</Text>,
            },
            { key: 'people', head: 'People', width: 1, align: 'right', sort: (r) => r.people ?? 0, cell: (r) => <Text style={type.small}>{count(r.people ?? 0)}</Text> },
          ] as Column<Role>[]}
        />
      </Panel>

      {open ? (
        <RoleDrawer
          role={open}
          capabilities={capabilities}
          areas={areas}
          doors={doors}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); void load(); }}
        />
      ) : null}
    </AdminPage>
  );
}

function NewRole({ doors, capabilities, onDone }: { doors: string[]; capabilities: Capability[]; onDone: () => void }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    try {
      await api.adminCreateRole({
        key: label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        label: label.trim(),
        doors: ['client'],
        capabilities: [],
      });
      onDone();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Panel title="A new role" sub="Name it here, then open it to grant what it may do.">
      {error ? <Banner tone="crit">{error}</Banner> : null}
      <Row style={{ gap: spacing.sm }}>
        <TextInput value={label} onChangeText={setLabel} placeholder="Support, Finance, Analyst…" placeholderTextColor={colors.inkMuted} style={styles.input} />
        <Button label="Create" icon="add" onPress={create} disabled={!label.trim() || busy} />
      </Row>
    </Panel>
  );
}

/** One role: its doors, and a tick box per capability, grouped by area. */
function RoleDrawer({ role, capabilities, areas, doors, canManage, onClose, onSaved }: {
  role: Role; capabilities: Capability[]; areas: string[]; doors: string[];
  canManage: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [held, setHeld] = useState<string[]>(role.capabilities ?? []);
  const [opens, setOpens] = useState<string[]>(role.doors ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const save = async () => {
    setBusy(true);
    try { await api.adminUpdateRole(role.id, { capabilities: held, doors: opens }); onSaved(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await api.adminDeleteRole(role.id); onSaved(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <SideSheet
      title={role.label}
      subtitle={role.description ?? undefined}
      onClose={onClose}
      footer={canManage && !role.is_owner ? (
        <Row style={{ gap: spacing.sm }}>
          <Button label="Save" icon="check" onPress={save} disabled={busy} />
          {!role.is_system ? <Button label="Delete role" kind="secondary" onPress={remove} disabled={busy} /> : null}
        </Row>
      ) : undefined}
    >
      {error ? <Banner tone="crit">{error}</Banner> : null}

      {role.is_owner ? (
        <Banner tone="accent">
          The owner's role holds every capability there is, including ones added later, and cannot be narrowed — an
          estate with nobody who can administer it is one nobody can rescue.
        </Banner>
      ) : null}
      {role.is_system && !role.is_owner ? (
        <Banner>This is a role Roam ships with. Its capabilities can be changed; it cannot be deleted.</Banner>
      ) : null}

      <Panel title="Applications it opens">
        <Wrap>
          {doors.map((d) => (
            <FilterChip
              key={d}
              label={d === 'admin' ? 'Back office' : 'The household app'}
              on={opens.includes(d)}
              onPress={canManage && !role.is_owner ? () => setOpens((o) => toggle(o, d)) : () => {}}
            />
          ))}
        </Wrap>
        <Text style={type.tiny}>
          Without the back office, its API answers 404 rather than “not allowed” — somebody who may not enter never
          learns there is anything to enter.
        </Text>
      </Panel>

      {areas.map((area) => (
        <Panel key={area} title={area}>
          {capabilities.filter((c) => c.area === area).map((c) => {
            const on = role.is_owner || held.includes(c.key);
            return (
              <Row key={c.key} style={{ gap: spacing.sm, alignItems: 'flex-start', paddingVertical: 4 }}>
                <Text
                  onPress={canManage && !role.is_owner ? () => setHeld((h) => toggle(h, c.key)) : undefined}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={[styles.tick, on && styles.tickOn]}
                >
                  {on ? <Icon name="check" size={12} color={colors.primaryFg} /> : null}
                </Text>
                <View style={{ flex: 1 }}>
                  <Row style={{ gap: 6 }}>
                    <Text style={[type.small, { fontWeight: '600', color: colors.ink }]}>{c.label}</Text>
                    {c.manages ? <Pill label="changes things" tone="warn" /> : null}
                  </Row>
                  <Text style={type.tiny}>{c.note}</Text>
                </View>
              </Row>
            );
          })}
        </Panel>
      ))}
    </SideSheet>
  );
}

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------

export function Plans({ canManage }: { canManage: boolean }) {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try { setPlans((await api.adminPlans()).plans); setError(null); } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const savePrice = async (key: string) => {
    const raw = (edited[key] ?? '').trim();
    const pounds = Number(raw.replace(/[^0-9.]/g, ''));
    try {
      await api.adminUpdatePlan(key, { pricePence: raw === '' ? null : Math.round(pounds * 100) });
      setEdited((e) => { const { [key]: _, ...rest } = e; return rest; });
      await load();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <AdminPage>
      <PageHead title="Plans" sub="What a household can be on, and what it is priced at." />
      {error ? <Banner tone="crit">{error}</Banner> : null}

      <Banner tone="warn">
        <Text style={{ fontWeight: '700' }}>A price here is not a charge. </Text>
        Roam holds no payment provider, so setting one changes what the revenue report says is contracted — it does not
        take anybody's money, and nothing in Roam will.
      </Banner>

      <Panel padded={false}>
        <DataTable
          rows={plans.map((p) => ({ ...p, id: p.key }))}
          columns={[
            {
              key: 'plan', head: 'Plan', width: 3,
              cell: (p: any) => (
                <View style={{ gap: 2 }}>
                  <Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>{p.label}</Text>
                  {p.note ? <Text style={type.tiny}>{p.note}</Text> : null}
                </View>
              ),
            },
            { key: 'people', head: 'Households', width: 2, align: 'right', cell: (p: any) => <Text style={type.small}>{count(p.people ?? 0)}</Text>, sort: (p: any) => p.people ?? 0 },
            { key: 'ceiling', head: 'Call ceiling', width: 2, align: 'right', cell: (p: any) => <Text style={type.small}>{p.call_bound ? count(p.call_bound) : 'estate default'}</Text> },
            {
              key: 'price', head: 'Price a month', width: 3, align: 'right',
              cell: (p: any) => (canManage ? (
                <Row style={{ gap: 6, justifyContent: 'flex-end' }}>
                  <Text style={type.tiny}>£</Text>
                  <TextInput
                    value={edited[p.key] ?? (p.price_pence == null ? '' : String(p.price_pence / 100))}
                    onChangeText={(t) => setEdited((e) => ({ ...e, [p.key]: t }))}
                    onBlur={() => (edited[p.key] != null ? savePrice(p.key) : undefined)}
                    placeholder="free"
                    placeholderTextColor={colors.inkMuted}
                    keyboardType="decimal-pad"
                    style={styles.price}
                    accessibilityLabel={`Price for ${p.label}`}
                  />
                </Row>
              ) : <Text style={type.small}>{p.price_pence == null ? 'free' : `${pounds(p.price_pence)}/mo`}</Text>),
            },
          ] as Column<any>[]}
        />
      </Panel>
      <Text style={type.tiny}>An empty box is a free plan, which is a different statement from a plan priced at zero.</Text>
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { setRows((await api.adminAudit()).audit); setError(null); } catch (e: any) {
        setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
      }
    })();
  }, []);

  return (
    <AdminPage>
      <PageHead title="Audit" sub="Every administrative act: who did it, to whom, and when." />
      {error ? <Banner tone="crit">{error}</Banner> : null}
      <Panel padded={false}>
        <DataTable
          rows={rows.map((r) => ({ ...r, id: String(r.id) }))}
          columns={[
            { key: 'when', head: 'When', width: 2, sort: (r: any) => r.at, cell: (r: any) => <Text style={type.small}>{ago(r.at)}</Text> },
            { key: 'action', head: 'Action', width: 2, cell: (r: any) => <Text style={type.small}>{r.action}</Text>, sort: (r: any) => r.action },
            { key: 'subject', head: 'To whom', width: 3, cell: (r: any) => <Text style={type.small}>{r.subject_label ?? r.subject_id ?? '—'}</Text> },
            { key: 'actor', head: 'By', width: 3, wideOnly: true, cell: (r: any) => <Text style={type.small}>{r.actor_label ?? 'somebody'}</Text> },
            {
              key: 'what', head: 'What changed', width: 4, wideOnly: true,
              cell: (r: any) => (
                <Text style={type.tiny} numberOfLines={2}>
                  {r.before || r.after ? `${r.before ? JSON.stringify(r.before) : ''} ${r.after ? `→ ${JSON.stringify(r.after)}` : ''}`.trim() : '—'}
                </Text>
              ),
            },
          ] as Column<any>[]}
          empty={<Text style={type.small}>Nothing has been done yet.</Text>}
        />
      </Panel>
    </AdminPage>
  );
}

const styles = StyleSheet.create({
  input: {
    flex: 1, minHeight: TARGET, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: spacing.md, color: colors.ink, backgroundColor: colors.surface,
  },
  price: {
    width: 84, minHeight: 34, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: spacing.sm, textAlign: 'right', color: colors.ink, backgroundColor: colors.surface,
  },
  tick: {
    width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: colors.line,
    alignItems: 'center', justifyContent: 'center', marginTop: 2, backgroundColor: colors.surface,
  },
  tickOn: { backgroundColor: colors.primary, borderColor: colors.primary },
});

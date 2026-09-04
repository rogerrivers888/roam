/**
 * Accounts — the admin module.
 *
 * The owner, 4 Sep 2026: "we need to build out an admin module anyway where we
 * can see all our customers, how long they've been there, what subscriptions,
 * and all of that stuff. On that screen, I should be able to add people, invite
 * them, and trigger the email with the magic link" — and "I would like to be
 * able to see their usage and monitor it: when they last logged in, how many
 * times they've logged in, how much their usage is".
 *
 * So the screen answers five questions per person without being opened: who
 * they are, what they are on, how long they have been here, when they were last
 * in, and what their searching has cost. Everything else — the sign-in history,
 * the note, the ceiling, removing them — is behind the row.
 *
 * Two layouts from one tree (CLAUDE.md): on a phone each account is a card and
 * the figures stack; from 1000px the same rows become columns with headings.
 * Flipping the Web/Mobile toggle must not lose which row is open, so the branch
 * is on style and not on what is returned.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, Account, AccountsResponse, ApiError, Invitation } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, SectionTitle, StatusLine, Wrap, Meter, FoldLine } from '../components/ui';
import { Icon } from '../components/Icon';
import { useViewport } from '../hooks/useViewport';

const WIDE = 1000;

// --- saying it in words -----------------------------------------------------

const money = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? '<$0.01' : '$0.00');

/** "3 days", "2 months" — how long they have been here, and how long since they were in. */
function since(iso?: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  return `${Math.round(months / 12)} years`;
}

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** The one line under a name that says where they are up to. */
function standing(a: Account): { text: string; tone: 'neutral' | 'warn' | 'good' } {
  if (a.status === 'suspended') return { text: 'Suspended — signed out and cannot sign back in', tone: 'warn' };
  if (a.status === 'invited') {
    const invited = since(a.lastInvite?.at ?? a.invitedAt);
    return { text: invited ? `Invited ${invited === 'today' ? 'today' : `${invited} ago`}, not signed in yet` : 'Invited, not signed in yet', tone: 'warn' };
  }
  const last = since(a.lastSeenAt);
  return { text: last ? `Last in ${last === 'today' || last === 'yesterday' ? last : `${last} ago`} · ${a.signInCount} sign-in${a.signInCount === 1 ? '' : 's'}` : `${a.signInCount} sign-ins`, tone: 'neutral' };
}

/** Copy to the clipboard, and say whether it went. Web only; elsewhere the link is selectable text. */
async function copy(text: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* a refused clipboard is not an error worth a screen */ }
  return false;
}

// ---------------------------------------------------------------------------

export function AccountsScreen() {
  const { width } = useViewport();
  const wide = width >= WIDE;
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The link from the invitation just sent, kept on screen until it is dealt
  // with: with no mail sender configured this is the only copy that exists.
  const [invitation, setInvitation] = useState<(Invitation & { email: string }) | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.accounts()); setError(null); } catch (e: any) { setError(e instanceof ApiError ? e.message : 'Could not reach Roam.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      await load();
      return r;
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Could not reach Roam.');
      return null;
    } finally { setBusy(false); }
  };

  const invite = async (a: Account) => {
    const r = await act(() => api.inviteAccount(a.id));
    if (r) setInvitation({ ...r.invitation, email: a.email });
  };

  const customers = useMemo(() => data?.accounts.filter((a) => a.role !== 'owner') ?? [], [data]);
  const owner = data?.accounts.find((a) => a.role === 'owner') ?? null;

  return (
    <ScrollView style={styles.page} contentContainerStyle={[styles.content, wide && styles.contentWide]}>
      <Row style={styles.head}>
        <Icon name="accounts" size={22} color={colors.ink} />
        <Text style={[type.title, { flex: 1 }]}>Accounts</Text>
        <Button label="Refresh" icon="refresh" kind="secondary" onPress={() => void load()} disabled={busy} />
      </Row>

      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}

      {/* What everybody together is costing this month — the number that
          matters when the free allowances are one pot. */}
      {data ? (
        <Card>
          <Row style={{ gap: spacing.lg, flexWrap: 'wrap' }}>
            <Figure label="Households" value={String(data.accounts.length)} />
            <Figure label="Signed in now" value={String(data.accounts.filter((a) => a.liveDevices > 0).length)} />
            <Figure label="Calls this month" value={data.totals.callsMonth.toLocaleString()} />
            <Figure label="Cost this month" value={money(data.totals.costMonth)} />
            <Figure label="Cost ever" value={money(data.totals.costEver)} />
          </Row>
        </Card>
      ) : null}

      {/* Whether an invitation can actually be sent. The answer to "why did
          that not send" belongs on the screen that tried to send it. */}
      {data && !data.mail.configured ? (
        <Card>
          <Row style={{ gap: spacing.sm, alignItems: 'flex-start' }}>
            <Icon name="mail" size={16} color={colors.overrun} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>No mail sender configured</Text>
              <Text style={type.tiny}>
                Roam will still make the link — it appears here for you to copy and send yourself. To have Roam e-mail it,
                add <Text style={styles.mono}>RESEND_API_KEY</Text> and <Text style={styles.mono}>ROAM_MAIL_FROM</Text> in Doppler
                (and <Text style={styles.mono}>ROAM_WEB_URL</Text> so links point at the app). Keys are yours to add, not mine.
              </Text>
            </View>
          </Row>
        </Card>
      ) : null}

      {invitation ? <InvitationCard invitation={invitation} onDone={() => setInvitation(null)} /> : null}

      {/* Inviting is what this screen is for, so it is the first thing on it —
          open by default until there is somebody in the list to look at. */}
      <Row style={styles.head}>
        <SectionTitle hint={customers.length ? `${customers.length} ${customers.length === 1 ? 'person' : 'people'}` : undefined}>Who has Roam</SectionTitle>
        {customers.length ? <Button label={adding ? 'Cancel' : 'Invite someone'} icon={adding ? 'close' : 'add'} onPress={() => setAdding((v) => !v)} /> : null}
      </Row>

      {(adding || !customers.length) && data ? (
        <AddAccount
          plans={data.plans}
          defaultBound={data.defaults.guestMonthlyCallBound}
          canSend={data.mail.configured}
          busy={busy}
          onAdd={async (body) => {
            const r = await act(() => api.addAccount(body));
            if (r) {
              setAdding(false);
              if (r.invitation) setInvitation({ ...r.invitation, email: r.account.email });
            }
          }}
        />
      ) : null}

      {wide && customers.length ? (
        <Row style={styles.headings}>
          <Text style={[type.tiny, { flex: 3 }]}>Person</Text>
          <Text style={[type.tiny, { flex: 2 }]}>Plan</Text>
          <Text style={[type.tiny, { flex: 2 }]}>Here since</Text>
          <Text style={[type.tiny, { flex: 3 }]}>Last in</Text>
          <Text style={[type.tiny, { flex: 3 }]}>This month</Text>
          <View style={{ width: 90 }} />
        </Row>
      ) : null}

      {owner ? (
        <AccountRow
          account={owner} wide={wide} busy={busy}
          open={open === owner.id} onOpen={() => setOpen(open === owner.id ? null : owner.id)}
          plans={data?.plans ?? []} defaultBound={data?.defaults.monthlyCallBound ?? 0}
          onInvite={() => invite(owner)}
          onPatch={(body) => act(() => api.updateAccount(owner.id, body))}
          onSignOut={() => act(() => api.signOutAccount(owner.id))}
          onRemove={null}
        />
      ) : null}

      {customers.map((a) => (
        <AccountRow
          key={a.id}
          account={a} wide={wide} busy={busy}
          open={open === a.id} onOpen={() => setOpen(open === a.id ? null : a.id)}
          plans={data?.plans ?? []} defaultBound={data?.defaults.guestMonthlyCallBound ?? 0}
          onInvite={() => invite(a)}
          onPatch={(body) => act(() => api.updateAccount(a.id, body))}
          onSignOut={() => act(() => api.signOutAccount(a.id))}
          onRemove={(withHousehold) => act(() => api.removeAccount(a.id, { withHousehold }))}
        />
      ))}

      {/* Optional, and last: the owner signs in with the passcode and does not
          need an account row at all. It only buys him two things, and the line
          says which, because "claim" on its own means nothing. */}
      {data && !data.ownerClaimed ? <IncludeMine onClaim={(email, name) => act(() => api.claimOwnerAccount({ email, name }))} busy={busy} /> : null}
    </ScrollView>
  );
}

// --- pieces -----------------------------------------------------------------

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={type.tiny}>{label}</Text>
      <Text style={[type.h2, { color: colors.ink }]}>{value}</Text>
    </View>
  );
}

/**
 * One person.
 *
 * Closed, it answers the five questions the owner asked for. Open, it holds
 * everything that changes them — and the two removals, which are different acts
 * and are worded as such.
 */
function AccountRow({ account: a, wide, open, onOpen, busy, plans, defaultBound, onInvite, onPatch, onSignOut, onRemove }: {
  account: Account;
  wide: boolean;
  open: boolean;
  onOpen: () => void;
  busy: boolean;
  plans: { key: string; label: string; note: string }[];
  defaultBound: number;
  onInvite: () => void;
  onPatch: (body: any) => Promise<any>;
  onSignOut: () => Promise<any>;
  /** Null for the owner: his own account is not removable from here. */
  onRemove: ((withHousehold: boolean) => Promise<any>) | null;
}) {
  const state = standing(a);
  const [confirming, setConfirming] = useState<null | 'account' | 'everything'>(null);
  const [bound, setBound] = useState(String(a.usage.bound));
  const [note, setNote] = useState(a.note ?? '');
  useEffect(() => { setBound(String(a.usage.bound)); }, [a.usage.bound]);

  return (
    <Card>
      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={a.name || a.email}>
        <View style={wide ? styles.rowWide : styles.rowNarrow}>
          <View style={wide ? { flex: 3 } : undefined}>
            <Row style={{ gap: 6 }}>
              <Icon name={a.role === 'owner' ? 'accounts' : 'person'} size={15} color={colors.inkMuted} />
              <Text style={[type.body, { fontWeight: '700' }]} numberOfLines={1}>{a.name || a.email}</Text>
              {a.liveDevices > 0 ? <Icon name="check" size={13} color={colors.like} /> : null}
            </Row>
            {a.name ? <Text style={type.tiny} numberOfLines={1}>{a.email}</Text> : null}
          </View>

          <View style={wide ? { flex: 2 } : undefined}>
            <Wrap>
              <Chip label={plans.find((p) => p.key === a.plan)?.label ?? a.plan} />
              {a.trialEndsOn ? <Chip label={`until ${day(a.trialEndsOn)}`} /> : null}
            </Wrap>
          </View>

          <View style={wide ? { flex: 2 } : undefined}>
            <Text style={type.small}>{since(a.createdAt) ?? '—'}</Text>
            {!wide ? <Text style={type.tiny}>here since {day(a.createdAt)}</Text> : null}
          </View>

          <View style={wide ? { flex: 3 } : undefined}>
            <StatusLine tone={state.tone}>{state.text}</StatusLine>
          </View>

          <View style={wide ? { flex: 3 } : { width: '100%' }}>
            <Meter
              used={a.usage.callsMonth}
              limit={a.usage.bound}
              label={`${a.usage.callsMonth.toLocaleString()} of ${a.usage.bound.toLocaleString()} calls · ${money(a.usage.costMonth)}`}
            />
          </View>

          <View style={wide ? { width: 90, alignItems: 'flex-end' } : undefined}>
            <Icon name={open ? 'collapse' : 'more'} size={16} color={colors.inkMuted} />
          </View>
        </View>
      </Pressable>

      {open ? (
        <View style={styles.details}>
          <Wrap>
            <Button label={a.signInCount > 0 ? 'Send a new link' : 'Invite again'} icon="send" onPress={onInvite} disabled={busy || a.status === 'suspended'} />
            {a.liveDevices > 0 ? <Button label={`Sign out ${a.liveDevices} device${a.liveDevices === 1 ? '' : 's'}`} icon="locked" kind="secondary" onPress={() => void onSignOut()} disabled={busy} /> : null}
            {a.role !== 'owner' ? (
              a.status === 'suspended'
                ? <Button label="Let them back in" icon="check" kind="secondary" onPress={() => void onPatch({ status: 'active' })} disabled={busy} />
                : <Button label="Suspend" icon="full" kind="secondary" onPress={() => void onPatch({ status: 'suspended' })} disabled={busy} />
            ) : null}
          </Wrap>

          <FoldLine label="Plan" value={plans.find((p) => p.key === a.plan)?.label ?? a.plan} icon="money">
            <Wrap>
              {plans.filter((p) => p.key !== 'owner' || a.role === 'owner').map((p) => (
                <Chip key={p.key} label={p.label} selected={p.key === a.plan} onPress={() => void onPatch({ plan: p.key })} />
              ))}
            </Wrap>
            <Text style={type.tiny}>{plans.find((p) => p.key === a.plan)?.note}</Text>
          </FoldLine>

          {/* Their share of the month. The provider allowances are one pot, so
              this is the number that stops one household emptying it. */}
          <FoldLine
            label="Monthly call ceiling"
            value={`${a.usage.bound.toLocaleString()}${a.usage.boundIsOwn ? '' : ' (default)'}`}
            icon="info"
          >
            <Row style={{ gap: spacing.sm }}>
              <TextInput
                value={bound}
                onChangeText={setBound}
                onBlur={() => {
                  const n = Number(bound.replace(/[^0-9]/g, ''));
                  if (Number.isFinite(n) && n > 0 && n !== a.usage.bound) void onPatch({ monthlyCallBound: n });
                }}
                keyboardType="number-pad"
                selectTextOnFocus
                accessibilityLabel="Monthly call ceiling"
                style={styles.numberBox}
              />
              <Text style={[type.tiny, { flex: 1 }]}>
                provider calls a month before Roam stops searching for them. The default for somebody new is {defaultBound.toLocaleString()}.
              </Text>
            </Row>
          </FoldLine>

          <FoldLine label="Note" value={a.note ? a.note : 'none'} icon="edit">
            <TextInput
              value={note}
              onChangeText={setNote}
              onBlur={() => { if (note !== (a.note ?? '')) void onPatch({ note }); }}
              placeholder="Only you see this"
              placeholderTextColor={colors.inkMuted}
              multiline
              style={styles.noteBox}
            />
          </FoldLine>

          <View style={{ gap: 2 }}>
            <Text style={type.tiny}>Household: {a.householdName ?? '—'} · {a.members} {a.members === 1 ? 'person' : 'people'} · {a.trips} {a.trips === 1 ? 'trip' : 'trips'}</Text>
            <Text style={type.tiny}>Joined {day(a.createdAt)}{a.activatedAt ? ` · first signed in ${day(a.activatedAt)}` : ''}</Text>
            <Text style={type.tiny}>All time: {a.usage.callsEver.toLocaleString()} calls · {money(a.usage.costEver)}</Text>
            {a.lastInvite ? (
              <Text style={type.tiny}>
                Last invitation {day(a.lastInvite.at)} — {a.lastInvite.usedAt ? `opened ${day(a.lastInvite.usedAt)}` : a.lastInvite.delivery === 'email' ? 'sent, not opened yet' : 'made but not sent by Roam'}
              </Text>
            ) : null}
          </View>

          {onRemove ? (
            confirming ? (
              <View style={{ gap: spacing.sm }}>
                <StatusLine tone="warn">
                  {confirming === 'everything'
                    ? `Remove ${a.email} and delete their household — every place, trip and rating they have saved. This cannot be undone.`
                    : `${a.email} will not be able to sign in. Their household's data stays here.`}
                </StatusLine>
                <Wrap>
                  <Button label="Yes, do it" icon="check" onPress={() => { void onRemove(confirming === 'everything'); setConfirming(null); }} disabled={busy} />
                  <Button label="Keep them" kind="secondary" onPress={() => setConfirming(null)} />
                </Wrap>
              </View>
            ) : (
              <Wrap>
                <Button label="Remove access" kind="secondary" onPress={() => setConfirming('account')} disabled={busy} />
                <Button label="Remove and delete their data" kind="secondary" onPress={() => setConfirming('everything')} disabled={busy} />
              </Wrap>
            )
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/**
 * The link, once.
 *
 * Shown whether or not it was e-mailed, because "did it actually go" is a
 * question the owner should be able to answer without leaving the page — and
 * with no sender configured this is the only copy of it that will ever exist.
 */
function InvitationCard({ invitation, onDone }: { invitation: Invitation & { email: string }; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const sent = invitation.delivery === 'email';
  return (
    <Card>
      <Row style={{ gap: spacing.sm, alignItems: 'flex-start' }}>
        <Icon name={sent ? 'check' : 'copy'} size={16} color={sent ? colors.like : colors.ink} />
        <View style={{ flex: 1, gap: spacing.sm }}>
          <Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>
            {sent ? `Invitation sent to ${invitation.email}` : `Link for ${invitation.email} — send it to them yourself`}
          </Text>
          {invitation.message && !sent ? <Text style={type.tiny}>{invitation.message}</Text> : null}
          <Text style={styles.link} selectable numberOfLines={2}>{invitation.url}</Text>
          <Wrap>
            <Button
              label={copied ? 'Copied' : 'Copy link'}
              icon={copied ? 'check' : 'copy'}
              onPress={async () => { setCopied(await copy(invitation.url)); }}
            />
            <Button label="Done" kind="secondary" onPress={onDone} />
          </Wrap>
          <Text style={type.tiny}>It works once, and expires {day(invitation.expiresAt)}.</Text>
        </View>
      </Row>
    </Card>
  );
}

/**
 * Your own household in the list — optional, and the last thing on the screen.
 *
 * You sign in with the passcode, which means Roam has no e-mail for you and
 * your household is not one of the rows above. Nothing is broken by leaving it
 * that way, so this is one folded line rather than a card demanding an action:
 * the first version of this screen led with it, and the owner's reaction was
 * "I don't want to claim a name. I want to send an invite" (4 Sep 2026).
 */
function IncludeMine({ onClaim, busy }: { onClaim: (email: string, name: string) => Promise<any>; busy: boolean }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  return (
    <FoldLine label="Optional" value="Show my own household in this list too" icon="person">
      <Card>
        <Text style={type.tiny}>
          You sign in with the passcode, so Roam has no e-mail for you and your own household is not one of the rows above.
          Adding one changes nothing about how you sign in — the passcode goes on working — but it means your household's usage
          is counted alongside everybody else's, and you can get in by e-mail on a device that has never had the passcode.
        </Text>
        <Row style={{ gap: spacing.sm, flexWrap: 'wrap' }}>
          <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={colors.inkMuted} style={[styles.input, { flex: 1, minWidth: 120 }]} />
          <TextInput
            value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor={colors.inkMuted}
            autoCapitalize="none" keyboardType="email-address" inputMode="email"
            style={[styles.input, { flex: 2, minWidth: 180 }]}
          />
          <Button label="Add mine" icon="check" onPress={() => void onClaim(email.trim(), name.trim())} disabled={busy || !email.includes('@')} />
        </Row>
      </Card>
    </FoldLine>
  );
}

/** Adding somebody: the least that has to be typed, and the rest has a default. */
function AddAccount({ plans, defaultBound, canSend, busy, onAdd }: {
  plans: { key: string; label: string; note: string }[];
  defaultBound: number;
  canSend: boolean;
  busy: boolean;
  onAdd: (body: { email: string; name?: string; plan?: string; monthlyCallBound?: number; invite?: boolean }) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('trial');
  const [bound, setBound] = useState(String(defaultBound));
  const ready = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = (invite: boolean) => {
    const n = Number(bound.replace(/[^0-9]/g, ''));
    return onAdd({
      email: email.trim(),
      name: name.trim() || undefined,
      plan,
      monthlyCallBound: Number.isFinite(n) && n > 0 ? n : undefined,
      invite,
    });
  };

  return (
    <Card>
      <SectionTitle hint="they get a Roam of their own — their places, their people, nothing of yours">Invite someone</SectionTitle>
      <Row style={{ gap: spacing.sm, flexWrap: 'wrap' }}>
        <TextInput value={name} onChangeText={setName} placeholder="Their name" placeholderTextColor={colors.inkMuted} style={[styles.input, { flex: 1, minWidth: 130 }]} />
        <TextInput
          value={email} onChangeText={setEmail} placeholder="them@example.com" placeholderTextColor={colors.inkMuted}
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address" inputMode="email"
          style={[styles.input, { flex: 2, minWidth: 190 }]}
        />
      </Row>

      <Wrap>
        {plans.filter((p) => p.key !== 'owner').map((p) => (
          <Chip key={p.key} label={p.label} selected={p.key === plan} onPress={() => setPlan(p.key)} />
        ))}
      </Wrap>
      <Text style={type.tiny}>{plans.find((p) => p.key === plan)?.note}</Text>

      <Row style={{ gap: spacing.sm }}>
        <Text style={[type.small, { flex: 1 }]}>Monthly call ceiling</Text>
        <TextInput value={bound} onChangeText={setBound} keyboardType="number-pad" selectTextOnFocus accessibilityLabel="Monthly call ceiling" style={styles.numberBox} />
      </Row>
      <Text style={type.tiny}>
        How many provider calls a month Roam will spend on them. Everybody draws on the same free allowances, so this is what stops one household emptying the pot.
      </Text>

      <Wrap>
        <Button label={canSend ? 'Send the invitation' : 'Make their link'} icon="send" onPress={() => void submit(true)} disabled={!ready || busy} />
        <Button label="Add them, invite later" kind="secondary" onPress={() => void submit(false)} disabled={!ready || busy} />
      </Wrap>
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl * 2 },
  contentWide: { maxWidth: 1180, width: '100%', alignSelf: 'center' },
  head: { gap: spacing.sm, alignItems: 'center' },
  headings: { gap: spacing.sm, paddingHorizontal: spacing.md },
  rowWide: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowNarrow: { gap: 6 },
  details: { gap: spacing.md, marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.line },
  input: {
    minHeight: TARGET, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: spacing.md, color: colors.ink, backgroundColor: colors.surface,
  },
  numberBox: {
    width: 92, minHeight: TARGET, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: spacing.sm, textAlign: 'right', color: colors.ink, backgroundColor: colors.surface,
  },
  noteBox: {
    minHeight: TARGET * 1.6, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    padding: spacing.sm, color: colors.ink, backgroundColor: colors.surface,
  },
  link: {
    ...type.tiny, color: colors.ink, backgroundColor: colors.well,
    borderRadius: radius.sm, padding: spacing.sm,
    fontFamily: Platform.select({ web: 'ui-monospace, SFMono-Regular, Menlo, monospace', default: 'monospace' }),
  },
  mono: { fontFamily: Platform.select({ web: 'ui-monospace, SFMono-Regular, Menlo, monospace', default: 'monospace' }) },
});

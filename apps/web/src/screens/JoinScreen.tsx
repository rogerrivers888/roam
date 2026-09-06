import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, GroupBooking, GuestAccount, HouseholdMemberInput, JoinView } from '../api';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap } from '../components/ui';
import { Icon, IconName } from '../components/Icon';
import { Wordmark } from '../components/Wordmark';
import { InviteLanding, itemIcon, pageFromJoin } from '../components/InvitePage';
import { FreeMonth } from '../components/FreeMonth';
import { useViewport } from '../hooks/useViewport';
import { setSessionToken } from '../session';

/**
 * What an invite link opens (Group Trips, Epic 3).
 *
 * The person holding it has never heard of Roam and is not signed in to
 * anything: they see what is being asked of them first, and are asked who they
 * are at the first thing they tap. Possession of the link is not proof of
 * identity, so their name is whatever they type — and the screen says so.
 *
 * They see their own list and nothing about anybody else: no roster, no other
 * person's payment or booking state, no contact details. That is enforced by
 * the API (routes/groups.js) and by the offline policy, which lets this page
 * be saved to their device and lets the organiser's view nowhere near it.
 */

const KEY = 'roam.join';
const money = (p?: number | null) => (p == null ? '' : `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`);
const day = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) : '');
const shortDay = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
const ICON: Record<string, IconName> = { stay: 'hotel', activity: 'ticket', fee: 'money' };

const remembered = (token: string): string | null =>
  (Platform.OS === 'web' && typeof localStorage !== 'undefined' ? localStorage.getItem(`${KEY}.${token}`) : null);
const remember = (token: string, participantToken: string) => {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.setItem(`${KEY}.${token}`, participantToken);
};

type Stage = 'landing' | 'account' | 'household' | 'book' | 'list' | 'trial';

const firstName = (n?: string | null) => (n ?? '').trim().split(/\s+/)[0] ?? '';

/**
 * The whole of a guest's side of a group trip, in the order it happens: the
 * page the organiser wrote, an account of their own, who is coming with them,
 * what they are booking, and then their list.
 *
 * The stage is held here rather than in a route because the link is the route:
 * whoever holds it is in the middle of one errand, and refreshing the page in
 * the middle of it should put them back where they were, which is what the
 * remembered participant token does.
 */
export function JoinScreen({ token }: { token: string }) {
  const { width } = useViewport();
  const [me, setMe] = useState<string | null>(() => remembered(token));
  const [v, setV] = useState<JoinView | null>(null);
  const [account, setAccount] = useState<GuestAccount | null>(null);
  const [booking, setBooking] = useState<GroupBooking | null>(null);
  const [stage, setStage] = useState<Stage>('landing');
  const [moved, setMoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.joinView(token, me);
      setV(r); setError(null);
      // Somebody coming back to a link they have already used lands on their
      // own list, not on the sales page they have already read.
      if (r.you && !moved) setStage('list');
    } catch (e: any) { setError(e.message); }
  }, [token, me, moved]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<JoinView>) => {
    setBusy(true);
    try { setV(await fn()); setError(null); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const go = (to: Stage) => { setMoved(true); setStage(to); };

  if (error && !v) {
    return (
      <View style={styles.page}>
        <Wordmark height={34} />
        <Card><Text style={type.h2}>This link is closed</Text><Text style={type.small}>{error}</Text></Card>
      </View>
    );
  }
  if (!v) return <View style={styles.page}><Wordmark height={34} /><Text style={type.small}>Opening…</Text></View>;

  const wide = width >= 900;
  const inner = (
    stage === 'landing' ? (
      <InviteLanding
        data={pageFromJoin(v)}
        narrow={!wide}
        onNext={() => go(v.you ? 'book' : 'account')}
      />
    ) : stage === 'account' ? (
      <AccountStep
        v={v} busy={busy}
        onBack={() => go('landing')}
        onDone={async (body) => {
          setBusy(true);
          try {
            const r = await api.joinAccount(token, body);
            remember(token, r.participantToken);
            setSessionToken(r.sessionToken);
            setMe(r.participantToken); setAccount(r.account); setV(r); setError(null); go('household');
          } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}
      />
    ) : stage === 'household' ? (
      <HouseholdStep
        v={v} account={account} busy={busy}
        onBack={() => go('account')}
        onDone={async (members) => {
          await act(() => api.joinHousehold(token, { participantToken: me!, members }));
          go('book');
        }}
      />
    ) : stage === 'book' ? (
      <BookStep
        v={v} busy={busy}
        onBack={() => go(v.you?.joinedAt ? 'landing' : 'household')}
        onConfirm={async (picks) => {
          setBusy(true);
          try {
            const r = await api.joinBook(token, { participantToken: me!, picks });
            setBooking(r.booking); setV(r); setError(null); go(account ? 'trial' : 'list');
          } catch (e: any) { setError(e.message); } finally { setBusy(false); }
        }}
      />
    ) : stage === 'trial' ? (
      <FreeMonth
        trialEndsOn={account?.trialEndsOn ?? null}
        tripName={v.group.name ?? v.trip.title ?? 'your trip'}
        payments={(booking?.lines ?? []).filter((l) => l.when === 'now').map((l) => ({ label: l.label, pence: l.pence, on: new Date().toISOString() }))}
        onDone={() => go('list')}
        doneLabel="See my list"
      />
    ) : (
      <TheirList v={v} token={token} me={me} busy={busy} account={account} onAct={act} onBook={() => go('book')} onTrial={() => go('trial')} />
    )
  );

  return (
    <ScrollView contentContainerStyle={[styles.page, wide && { maxWidth: 720, alignSelf: 'center' }]}>
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      {inner}
    </ScrollView>
  );
}

/**
 * Create your account (Epic 4).
 *
 * Two scenarios, one screen and one conditional row: the organiser added names
 * and the guest picks theirs, or the link was shared openly and nobody knows
 * who is holding it. The second is the one that needs the explaining, because
 * the name they type is what the organiser will tick them off by.
 */
function AccountStep({ v, busy, onBack, onDone }: {
  v: JoinView; busy: boolean; onBack: () => void; onDone: (body: { name: string; contact: string; matchId?: string | null }) => void;
}) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [matchId, setMatchId] = useState<string | null>(null);
  const [known, setKnown] = useState(false);
  const them = v.group.organiser ?? 'The organiser';
  const named = v.expecting.length > 0;

  // Somebody who already uses Roam and is signed in on this device is not being
  // asked who they are — they are being asked to confirm it (Epic 4, AC6). The
  // API recognises the same contact and signs them into the account they have.
  useEffect(() => {
    let live = true;
    api.sessionState().then((st) => {
      const acc: any = st.account;
      if (!live || !acc) return;
      setKnown(true);
      setName((n) => n || acc.name || '');
      setContact((c) => c || acc.email || acc.mobile || '');
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={onBack} accessibilityRole="button">
          <Row><Icon name="back" size={18} /><Text style={type.h3}>{v.group.name ?? v.trip.title ?? 'Back'}</Text></Row>
        </Pressable>
        <Wordmark height={26} />
      </Row>

      <View style={{ gap: 4 }}>
        <Text style={type.title}>{known ? "You're in Roam already" : named ? 'First, which one are you?' : 'First, who are you?'}</Text>
        <Text style={type.small}>
          {known
            ? `Your Roam account joins this trip — ${them} sees your name and how to reach you, and nothing else. Your own trips and household stay yours.`
            : named
            ? `${them} added a few names when he set this up. Tap yours, or type it if it isn't there. This also makes you a Roam account.`
            : `${them} shared this link openly, so we don't know you yet. They'll see your name and how to reach you — nothing else. This also makes you a Roam account.`}
        </Text>
      </View>

      {named ? (
        <View>
          <Text style={type.label}>{them.toUpperCase()} IS EXPECTING</Text>
          <Wrap>
            {v.expecting.map((p) => (
              <Chip key={p.id} label={p.name} selected={matchId === p.id} onPress={() => { setMatchId(p.id); setName(p.name); }} />
            ))}
          </Wrap>
        </View>
      ) : null}

      <View>
        <Text style={type.label}>YOUR NAME</Text>
        <TextInput
          value={name} onChangeText={(t) => { setName(t); setMatchId(null); }}
          placeholder={`The name ${them} knows you by`} placeholderTextColor={colors.inkFaint}
          style={[styles.input, type.h3 as any]}
        />
      </View>
      {!named ? (
        <View style={styles.hint}>
          <Text style={[type.small, { color: colors.headerSub }]}>
            Use the name people call you — {them} ticks you off by it.
          </Text>
        </View>
      ) : null}

      <View>
        <Text style={type.label}>MOBILE OR EMAIL</Text>
        <TextInput
          value={contact} onChangeText={setContact} autoCapitalize="none"
          placeholder={`So ${them} can remind you — and it's how you sign in`} placeholderTextColor={colors.inkFaint}
          style={styles.input}
        />
        {/* Roam has no message channel until one is configured, so this says
            which of the two things is about to happen rather than promising a
            text nobody can send. */}
        <Text style={type.small}>
          {v.group.canSendCode
            ? "We'll send a 6-digit code. No password."
            : 'No password. Roam cannot send a code yet, so this device is signed in now and your contact is kept for reminders.'}
        </Text>
      </View>

      {known ? null : (
      <View style={styles.trialCard}>
        <Row style={{ alignItems: 'flex-start' }}>
          <View style={styles.trialIcon}><Icon name="gift" size={16} color={colors.headerSub} /></View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={type.h3}>Roam is yours free for 30 days</Text>
            <Text style={[type.small, { color: colors.headerSub }]}>
              The whole app — planning, places, your own trips. <Text style={{ fontWeight: '700', color: colors.headerSub }}>No card, nothing to cancel.</Text> The only thing you'll ever pay here is your share of the trip.
            </Text>
          </View>
        </Row>
      </View>
      )}

      <View style={{ gap: 6 }}>
        <Button
          label={known ? `Join as ${firstName(name) || 'me'}` : v.group.canSendCode ? 'Send my code' : 'Create my account'}
          icon="forward" loading={busy}
          onPress={() => { if (name.trim() && contact.trim()) onDone({ name: name.trim(), contact: contact.trim(), matchId }); }}
        />
        {known ? null : (
          <Text style={[type.small, { textAlign: 'center' }]}>
            Already use Roam? <Text style={{ color: colors.accent, fontWeight: '700' }}>Sign in</Text> with the same mobile or email above.
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * Who's coming with you (Epic 4).
 *
 * The people they name become their own household in Roam — not the
 * organiser's — and how many of them are coming is what every per-person price
 * divides by. A child's age is asked because a trip that is priced or booked by
 * age needs it, and it stays as long as the household does.
 */
function HouseholdStep({ v, account, busy, onBack, onDone }: {
  v: JoinView; account: GuestAccount | null; busy: boolean; onBack: () => void;
  onDone: (members: HouseholdMemberInput[]) => void;
}) {
  const you = v.you?.name ?? account?.name ?? 'you';
  const [alone, setAlone] = useState(true);
  const [rows, setRows] = useState<HouseholdMemberInput[]>([{ name: you, you: true, coming: true }]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [child, setChild] = useState(false);
  const [age, setAge] = useState('');

  // Somebody who already had a Roam account arrives with a household; it is
  // theirs, so it is offered ticked rather than asked for again.
  useEffect(() => {
    if (!account?.returning) return;
    let live = true;
    api.household().then((h) => {
      if (!live || !h.members.length) return;
      setRows(h.members.map((m, n) => ({ name: m.name, child: m.isMinor, age: m.age, you: n === 0, coming: true })));
      setAlone(false);
    }).catch(() => {});
    return () => { live = false; };
  }, [account?.returning]);

  const coming = rows.filter((r) => r.coming !== false);
  const heads = alone ? 1 : Math.max(1, coming.length);
  const tripName = v.trip.place ?? v.trip.title ?? 'the trip';

  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={onBack} accessibilityRole="button"><Row><Icon name="back" size={18} /><Text style={type.h3}>Back</Text></Row></Pressable>
        <Wordmark height={26} />
      </Row>

      <View style={{ gap: 4 }}>
        <Text style={type.title}>Who's coming with you, {firstName(you)}?</Text>
        <Text style={type.small}>
          Anything priced per person counts everyone here, and one bill comes to you. They're your household in Roam from now on.
        </Text>
      </View>

      <Row style={{ alignItems: 'stretch' }}>
        <Pressable onPress={() => setAlone(true)} accessibilityRole="button" style={[styles.pick, alone && styles.pickOn]}>
          <View style={[styles.pickIcon, alone && styles.pickIconOn]}><Icon name="person" size={16} color={alone ? colors.primaryFg : colors.accent} /></View>
          <Text style={type.h3}>Just me</Text>
          <Text style={type.small}>One seat, one bed.</Text>
        </Pressable>
        <Pressable onPress={() => setAlone(false)} accessibilityRole="button" style={[styles.pick, !alone && styles.pickOn]}>
          <View style={[styles.pickIcon, !alone && styles.pickIconOn]}><Icon name="home" size={16} color={!alone ? colors.primaryFg : colors.accent} /></View>
          <Text style={type.h3}>My household</Text>
          <Text style={type.small}>Add the people you live with.</Text>
        </Pressable>
      </Row>

      {!alone ? (
        <View>
          {rows.map((r, n) => (
            <Row key={n} style={styles.memberRow}>
              <View style={styles.avatar}><Text style={styles.avatarText}>{(r.name[0] ?? '?').toUpperCase()}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={type.h3}>{r.name}</Text>
                <Text style={type.small}>{r.you ? 'You · adult' : r.child ? `Child${r.age ? ` · ${r.age}` : ''}` : 'Adult'}</Text>
              </View>
              {!r.you ? (
                <Pressable onPress={() => setRows(rows.filter((_, j) => j !== n))} accessibilityRole="button" style={{ padding: 6 }}>
                  <Icon name="close" size={16} color={colors.inkMuted} />
                </Pressable>
              ) : null}
            </Row>
          ))}

          {adding ? (
            <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
              <TextInput value={name} onChangeText={setName} placeholder="Their name" placeholderTextColor={colors.inkFaint} style={styles.input} autoFocus />
              <Row>
                <View style={{ flex: 1 }}>
                  <Segmented
                    value={child ? 'child' : 'adult'}
                    options={[{ value: 'adult', label: 'Adult' }, { value: 'child', label: 'Child' }]}
                    onChange={(k) => setChild(k === 'child')}
                  />
                </View>
                {child ? (
                  <View style={styles.ageBox}>
                    <TextInput
                      value={age} onChangeText={(t) => setAge(t.replace(/[^0-9]/g, '').slice(0, 2))}
                      placeholder="Age" placeholderTextColor={colors.inkFaint} keyboardType="number-pad" style={styles.ageInput}
                    />
                  </View>
                ) : null}
              </Row>
              <Row>
                <Button
                  label="Add them" kind="secondary"
                  onPress={() => {
                    if (!name.trim()) return;
                    setRows([...rows, { name: name.trim(), child, age: child && age ? Number(age) : null, coming: true }]);
                    setName(''); setChild(false); setAge(''); setAdding(false);
                  }}
                />
                <Button label="Cancel" kind="ghost" onPress={() => setAdding(false)} />
              </Row>
            </View>
          ) : (
            <Pressable onPress={() => setAdding(true)} accessibilityRole="button" style={{ paddingVertical: spacing.sm }}>
              <Row><View style={styles.addDot}><Icon name="add" size={14} color={colors.accent} /></View><Text style={[type.h3, { color: colors.accent }]}>Add someone</Text></Row>
            </Pressable>
          )}
        </View>
      ) : null}

      <Row style={styles.comingBar}>
        <Text style={[type.small, { color: colors.headerSub, flex: 1 }]}>Coming to {tripName}</Text>
        <Text style={[type.h3, { color: colors.headerSub }]}>{heads} of you</Text>
        <Icon name="check" size={16} color={colors.headerSub} />
      </Row>

      <View style={{ gap: 6 }}>
        <Button
          label="Next · Book your itinerary" icon="forward" loading={busy}
          onPress={() => onDone(alone ? [{ name: you, you: true, coming: true }] : rows.map((r) => ({ ...r, coming: r.coming !== false })))}
        />
        <Text style={[type.small, { textAlign: 'center' }]}>You can untick anyone per trip later.</Text>
      </View>
    </View>
  );
}

type Pick = 'in' | 'out' | 'booked' | 'declared' | null;
type BookItem = JoinView['items'][number];

/** Everything mandatory starts in; everything optional starts unanswered. */
const seed = (v: JoinView): Record<string, Pick> => {
  const out: Record<string, Pick> = {};
  for (const i of v.items) {
    if (i.state === 'cancelled') continue;
    out[i.id] = (i.mine?.status as Pick) ?? (i.required && i.bookWhere !== 'yourself' ? 'in' : null);
  }
  return out;
};

const host = (url?: string | null) => {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

/**
 * Book your itinerary (Epic 5).
 *
 * Every row's control is the guest's actual next action — In, Book ↗, Add · £n,
 * Yes | No — so how a thing is paid for never has to be explained separately.
 * The footer answers how much, when and to whom in three lines, and the figures
 * are re-worked by the API on Confirm: a price is the group's fact, not the
 * browser's.
 */
function BookStep({ v, busy, onBack, onConfirm }: {
  v: JoinView; busy: boolean; onBack: () => void; onConfirm: (picks: Record<string, Pick>) => void;
}) {
  const [picks, setPicks] = useState<Record<string, Pick>>(() => seed(v));
  const them = v.group.organiser ?? 'the organiser';
  const roam = v.group.paymentMode === 'roam';
  const items = v.items.filter((i) => i.state !== 'cancelled');

  // By day, in the order the trip happens; anything without a date last.
  const days: { key: string; label: string; items: BookItem[] }[] = [];
  for (const i of [...items].sort((a, b) => (a.startsOn ?? '9999').localeCompare(b.startsOn ?? '9999') || (a.startsAt ?? '').localeCompare(b.startsAt ?? ''))) {
    const key = i.startsOn ?? 'whenever';
    const label = i.startsOn ? day(i.startsOn).toUpperCase() : 'WHENEVER YOU LIKE';
    const at = days.find((d) => d.key === key) ?? (days.push({ key, label, items: [] }), days[days.length - 1]);
    at.items.push(i);
  }

  const chosen = (i: BookItem) => picks[i.id] === 'in' || picks[i.id] === 'booked' || picks[i.id] === 'declared';
  const fixedYours = (i: BookItem) => i.money?.yoursPence ?? i.amountPence ?? 0;

  // The same three sums the API will work out, so the footer and the receipt agree.
  let payNow = 0; let toThem = 0;
  const later: BookItem[] = [];
  for (const i of items) {
    if (!chosen(i) || !i.pricing) continue;
    if (i.pricing === 'variable' && i.state !== 'closed') { later.push(i); continue; }
    if (i.bookWhere === 'there') continue;
    if (roam) payNow += fixedYours(i); else toThem += fixedYours(i);
  }
  const laterLow = later.reduce((n, i) => n + (i.money?.likelyYoursPence ?? 0), 0);
  const laterHigh = later.reduce((n, i) => n + (i.money?.ceilingYoursPence ?? 0), 0);
  // The earliest of them: the first date any of this money is owed is the one
  // the guest has to know, and a later one is not a promise they can rely on.
  const settles = later.map((i) => i.money?.closesOn).filter(Boolean).sort()[0] ?? v.group.wantedBy;

  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={onBack} accessibilityRole="button"><Row><Icon name="back" size={18} /><Text style={type.h3}>Back</Text></Row></Pressable>
        <Wordmark height={26} />
      </Row>

      <View style={{ gap: 4 }}>
        <Text style={type.title}>Book your itinerary</Text>
        <Text style={type.small}>Everyone's things are already in. Pick your optional ones — some need booking ahead.</Text>
      </View>

      {days.map((d) => (
        <View key={d.key}>
          <Text style={type.label}>{d.label}</Text>
          {d.items.map((i) => (
            <BookRow
              key={i.id}
              item={i} pick={picks[i.id] ?? null} organiser={them} roam={roam} heads={v.you?.heads ?? 1}
              onPick={(p) => setPicks({ ...picks, [i.id]: p })}
            />
          ))}
        </View>
      ))}

      <View style={styles.footer}>
        {payNow ? <Money2 label={`Pay now · ${roam ? 'via Roam' : 'card'}`} value={money(payNow)} /> : null}
        {later.length ? <Money2 label={`On ${shortDay(settles)} · ${later.map((i) => i.label).join(', ')}`} value={laterLow === laterHigh ? money(laterHigh) : `${money(laterLow)}–${money(laterHigh)}`} /> : null}
        {toThem ? <Money2 label={`To ${them}`} value={money(toThem)} /> : null}
        {!payNow && !later.length && !toThem ? <Text style={type.small}>Nothing to pay on this trip.</Text> : null}
      </View>

      <View style={{ gap: 6 }}>
        <Button
          label={payNow ? `Confirm and pay ${money(payNow)}` : 'Confirm my picks'}
          icon="forward" loading={busy}
          onPress={() => onConfirm(picks)}
        />
        <Row style={{ justifyContent: 'center' }}>
          <Icon name="locked" size={13} color={colors.inkMuted} />
          <Text style={type.small}>
            Only {them} sees your list{settles ? ` · change your picks any time before ${day(settles)}` : ''}.
          </Text>
        </Row>
      </View>
    </View>
  );
}

function Money2({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Text style={[type.small, { flex: 1, textAlign: 'right' }]}>{label}</Text>
      <Text style={[type.h3, { minWidth: 80, textAlign: 'right' }]}>{value}</Text>
    </Row>
  );
}

/** One thing to decide, with the control that names what deciding it means. */
function BookRow({ item: i, pick, organiser, roam, heads, onPick }: {
  item: BookItem; pick: Pick; organiser: string; roam: boolean; heads: number; onPick: (p: Pick) => void;
}) {
  const m = i.money;
  const perYou = i.perHead && heads > 1;
  const price = i.pricing === 'variable'
    ? m?.ceilingYoursPence ? `≤ ${money(m.ceilingYoursPence)}` : 'by numbers'
    : i.amountPence ? (perYou ? `${money(i.amountPence)} ×${heads} = ${money(i.amountPence * heads)}` : money(i.amountPence)) : i.bookWhere === 'there' ? 'pay there' : 'free';
  const meta = [i.startsAt, i.endsAt ? `back ${i.endsAt}` : null, i.detail, price].filter(Boolean).join(' · ');

  // What happens to the money, in the guest's words, or the organiser's own line.
  const paymentLine = i.guestNote
    ?? (i.bookWhere === 'yourself' ? `Book yourself${host(i.externalUrl) ? ` at ${host(i.externalUrl)}` : ''}, then tell us`
      : i.pricing === 'variable' ? `${roam ? 'Via Roam' : `Pay ${organiser}`} · settles ${shortDay(m?.closesOn)}, nothing taken until then`
      : i.pricing === 'fixed' ? (roam ? 'Pre-book · pay now via Roam' : `Pay ${organiser} directly · ticked off when it arrives`)
      : i.bookWhere === 'there' ? 'Pay there on the day'
      : i.required ? 'Part of the trip' : `${organiser} just needs to know`);

  const chosen = pick === 'in' || pick === 'booked' || pick === 'declared';
  const control = i.required ? (
    i.bookWhere === 'yourself' ? (
      pick === 'declared' || pick === 'booked'
        ? <Pill label="Booked" icon="check" on onPress={() => onPick(null)} />
        : (
          <View style={{ gap: 6, alignItems: 'flex-end' }}>
            <Pill
              label="Book" icon="external"
              onPress={() => { if (i.externalUrl && Platform.OS === 'web' && typeof window !== 'undefined') window.open(i.externalUrl, '_blank'); }}
            />
            <Pressable onPress={() => onPick('declared')} accessibilityRole="button">
              <Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>I've booked it</Text>
            </Pressable>
          </View>
        )
    ) : <Pill label="In" icon="check" on />
  ) : i.pricing === 'fixed' && i.amountPence && i.bookWhere !== 'there' ? (
    <Pill
      label={chosen ? money(perYou ? i.amountPence * heads : i.amountPence) : `Add · ${money(i.amountPence)}`}
      icon={chosen ? 'check' : undefined} on={chosen}
      onPress={() => onPick(chosen ? 'out' : 'in')}
    />
  ) : (
    <Row style={{ gap: 0 }}>
      <Pressable onPress={() => onPick('in')} accessibilityRole="button" style={[styles.yn, styles.ynLeft, pick === 'in' && styles.ynOn]}>
        <Text style={[styles.ynText, pick === 'in' && styles.ynTextOn]}>Yes</Text>
      </Pressable>
      <Pressable onPress={() => onPick('out')} accessibilityRole="button" style={[styles.yn, styles.ynRight, pick === 'out' && styles.ynOn]}>
        <Text style={[styles.ynText, pick === 'out' && styles.ynTextOn]}>No</Text>
      </Pressable>
    </Row>
  );

  return (
    <Row style={styles.bookRow}>
      <View style={styles.tile}><Icon name={itemIcon(i.label, i.kind)} size={16} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.h3}>{i.label}</Text>
        {meta ? <Text style={type.small}>{meta}</Text> : null}
        <Text style={[type.small, { color: colors.accent }]}>{paymentLine}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>{control}</View>
    </Row>
  );
}

function Pill({ label, icon, on, onPress }: { label: string; icon?: IconName; on?: boolean; onPress?: () => void }) {
  const body = (
    <View style={[styles.pill, on && styles.pillOn]}>
      {icon ? <Icon name={icon} size={14} color={on ? colors.primaryFg : colors.ink} /> : null}
      <Text style={[styles.pillText, on && { color: colors.primaryFg }]}>{label}</Text>
    </View>
  );
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button">{body}</Pressable> : body;
}

/**
 * Their own list, afterwards: what they have said and what is left. The same
 * rows the link has always opened, now behind the booking rather than in front
 * of it.
 */
function TheirList({ v, token, me, busy, account, onAct, onBook, onTrial }: {
  v: JoinView; token: string; me: string | null; busy: boolean; account: GuestAccount | null;
  onAct: (fn: () => Promise<JoinView>) => Promise<void>; onBook: () => void; onTrial: () => void;
}) {
  const you = v.you;
  const required = v.items.filter((i) => i.required);
  const outstanding = you ? required.filter((i) => !i.mine || !['booked', 'declared', 'paid'].includes(i.mine.status)).length : required.length;

  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Wordmark height={30} />
        {v.group.organiser ? <Text style={type.label}>INVITED BY {v.group.organiser.toUpperCase()}</Text> : null}
      </Row>
      <View style={{ gap: 2 }}>
        <Text style={type.title}>{v.group.name ?? v.trip.title ?? 'A trip'}</Text>
        <Text style={type.small}>
          {v.trip.startDate ? `${shortDay(v.trip.startDate)} – ${shortDay(v.trip.endDate)}` : ''}
          {v.trip.place ? ` · ${v.trip.place}` : ''}
          {v.group.joined ? ` · ${v.group.joined} going${v.group.heads > v.group.joined ? ` (${v.group.heads} people)` : ''}` : ''}
        </Text>
      </View>

      <Card style={{ backgroundColor: colors.surfaceMuted }}>
        <Row style={{ alignItems: 'flex-start' }}>
          <Icon name="list" size={16} />
          <Text style={[type.small, { flex: 1 }]}>
            {outstanding
              ? `${outstanding} thing${outstanding === 1 ? '' : 's'} still to do${v.group.wantedBy ? `, by ${day(v.group.wantedBy)}` : ''}.`
              : 'That is everything. Nothing else is needed from you.'}
          </Text>
        </Row>
      </Card>

      {v.items.map((i) => (
        <ItemCard
          key={i.id}
          item={i}
          organiser={v.group.organiser}
          joined={Boolean(you)}
          trip={v.trip}
          onAsk={onBook}
          onSet={(body) => onAct(() => api.setJoinItem(token, i.id, { participantToken: me!, ...body }))}
        />
      ))}

      <Row>
        <Button label="Change my picks" kind="secondary" icon="edit" onPress={onBook} />
        {account ? <Button label="Your Roam" kind="ghost" icon="gift" onPress={onTrial} /> : null}
      </Row>

      {v.group.cancelled ? (
        <Card style={{ borderColor: colors.overrun }}>
          <Row><Icon name="allergen" size={16} color={colors.overrun} /><Text style={type.h2}>This trip is off</Text></Row>
          <Text style={type.small}>{v.group.cancelledNote} Nothing has been taken from you and there is nothing to pay.</Text>
          <Text style={type.small}>Anything you booked yourself — a room, a ticket — is yours to cancel with them, on their terms.</Text>
        </Card>
      ) : null}
      {you ? (
        <Text style={type.small}>
          You are in this trip as {you.name}{you.heads > 1 ? ` and ${you.heads - 1} other${you.heads > 2 ? 's' : ''}${you.brings ? ` (${you.brings})` : ''}` : ''}.
          {' '}Only {v.group.organiser ?? 'the organiser'} sees this list. Nobody else in the group does, and you cannot see theirs.
        </Text>
      ) : null}
    </View>
  );
}

function ItemCard({ item, organiser, joined, trip, onAsk, onSet }: {
  item: JoinView['items'][number]; organiser: string | null; joined: boolean; trip: JoinView['trip'];
  onAsk: () => void; onSet: (body: any) => void;
}) {
  const [declaring, setDeclaring] = useState(false);
  const [where, setWhere] = useState('');
  const [ref, setRef] = useState('');
  // The nights, for a room: the trip's own dates to begin with, so booking the
  // wrong weekend takes effort rather than happening by accident.
  const [from, setFrom] = useState(trip.startDate ?? '');
  const [to, setTo] = useState(trip.endDate ?? '');
  const s = item.mine;
  const tap = (fn: () => void) => () => (joined ? fn() : onAsk());

  return (
    <Card>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ paddingTop: 2 }}><Icon name={ICON[item.kind] ?? 'place'} size={16} color={s ? colors.like : colors.icon} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.h3}>{item.label}{item.kind === 'fee' && item.amountPence ? ` · ${money(item.amountPence)}` : ''}</Text>
          {item.detail ? <Text style={type.small}>{item.detail}</Text> : null}
          {!item.required ? (
            <Text style={type.small}>
              {item.money ? 'OPTIONAL — only if you want it' : `OPTIONAL — ${organiser ?? 'they'} just need${organiser ? 's' : ''} to know if you are coming`}
            </Text>
          ) : null}
          {item.kind === 'fee' && item.refundRule === 'until' && item.refundUntil ? (
            <Text style={type.small}>Refundable until {day(item.refundUntil)}. Pay {organiser ?? 'the organiser'} directly — Roam does not take the money.</Text>
          ) : null}
          {s ? (
            <Text style={[type.small, { color: colors.like, fontWeight: '700' }]}>
              {s.status === 'declared' ? `You said you booked this${s.whereBooked ? ` with ${s.whereBooked}` : ''}${s.bookingRef ? ` · ${s.bookingRef}` : ''}`
                : s.status === 'booked' ? 'Booked'
                : s.status === 'paid' ? `Paid · ${shortDay(s.on)}`
                : s.status === 'in' ? "You're coming" : 'You said no thanks'}
            </Text>
          ) : null}
        </View>
      </Row>

      {item.money ? <Money item={item} organiser={organiser} joined={joined} onAsk={onAsk} onSet={onSet} /> : null}

      {item.kind === 'fee' ? null : item.required ? (
        declaring ? (
          <View style={{ gap: spacing.sm }}>
            <Text style={type.small}>WHERE DID YOU BOOK?</Text>
            <TextInput value={where} onChangeText={setWhere} placeholder="Booking.com, or the hotel itself" placeholderTextColor={colors.inkFaint} style={styles.input} />
            <Text style={type.small}>REFERENCE, IF YOU HAVE ONE</Text>
            <TextInput value={ref} onChangeText={setRef} placeholder="Only so they can ask about it" placeholderTextColor={colors.inkFaint} style={styles.input} />
            {item.kind === 'stay' ? (
              <View style={{ gap: spacing.sm }}>
                <Text style={type.small}>WHICH NIGHTS?</Text>
                <Row>
                  <TextInput value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
                  <TextInput value={to} onChangeText={setTo} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
                </Row>
              </View>
            ) : null}
            <Text style={type.small}>Because you booked it away from Roam, nobody can confirm it. It shows on their list as your word for it.</Text>
            <Row>
              <Button label="That's booked" onPress={() => { onSet({ status: 'declared', whereBooked: where.trim() || null, bookingRef: ref.trim() || null, startsOn: item.kind === 'stay' ? from || null : null, endsOn: item.kind === 'stay' ? to || null : null }); setDeclaring(false); }} />
              <Button label="Cancel" kind="ghost" onPress={() => setDeclaring(false)} />
            </Row>
          </View>
        ) : (
          <Wrap>
            {s
              ? <Chip label="Undo" icon="close" onPress={tap(() => onSet({ status: 'clear' }))} />
              : <Chip label="I've booked it" icon="check" onPress={tap(() => setDeclaring(true))} />}
          </Wrap>
        )
      ) : item.money ? null : (
        <Wrap>
          <Chip label="I'm in" icon="check" selected={s?.status === 'in'} onPress={tap(() => onSet({ status: s?.status === 'in' ? 'clear' : 'in' }))} />
          <Chip label="Not for me" icon="close" selected={s?.status === 'out'} onPress={tap(() => onSet({ status: s?.status === 'out' ? 'clear' : 'out' }))} />
        </Wrap>
      )}
    </Card>
  );
}


/**
 * What a cost looks like to the person who will pay it.
 *
 * While it can still move there is nothing to pay and the only honest thing to
 * show is the ceiling — the most it could ever be — with the likely figure
 * beside it and how many are on it so far. Once it closes, the bill shows its
 * own arithmetic and quotes the promise back at itself.
 */
function Money({ item, organiser, joined, onAsk, onSet }: {
  item: JoinView['items'][number]; organiser: string | null; joined: boolean;
  onAsk: () => void; onSet: (body: any) => void;
}) {
  const m = item.money!;
  const mine = item.mine;
  const them = organiser ?? 'The organiser';
  const tap = (fn: () => void) => () => (joined ? fn() : onAsk());
  const short = Boolean(m.minimum && m.heads < m.minimum);

  if (item.state === 'cancelled') {
    return (
      <View style={{ gap: 4 }}>
        <Text style={[type.small, { fontWeight: '700' }]}>This is off — {item.cancelledNote ?? 'not enough people wanted it'}.</Text>
        <Text style={type.small}>Nothing has been taken from you and there is nothing to pay.</Text>
      </View>
    );
  }

  if (item.state === 'closed') {
    return (
      <View style={{ gap: 4 }}>
        <Text style={type.h3}>{money(m.yoursPence)}</Text>
        <Text style={type.small}>
          {money(item.totalPence)} ÷ {item.settledHeads} {item.perHead ? 'seats' : 'parties'} = {money(item.settledPence)} each
          {m.shares > 1 ? ` × ${m.shares} = ${money(m.yoursPence)}` : ''}.
        </Text>
        {m.ceilingPence ? <Text style={type.small}>You were told no more than {money(m.ceilingYoursPence)}. It came out at {money(m.yoursPence)}.</Text> : null}
        <Text style={type.small}>{them} needs it by {day(m.dueOn)}. It is not refundable now — the booking is made on the strength of it.</Text>
        <Text style={type.small}>{mine?.status === 'paid' ? `${them} has ticked this off.` : `Pay ${them} however you normally do; they tick it off here.`}</Text>
      </View>
    );
  }

  if (item.pricing === 'fixed') {
    return (
      <View style={{ gap: 4 }}>
        <Text style={type.h3}>{money(m.yoursPence ?? item.amountPence)}</Text>
        <Text style={type.small}>{mine?.status === 'paid' ? `${them} has ticked this off.` : `${them} ticks this off when it reaches them.`}</Text>
      </View>
    );
  }

  // Varying, and still open: a ceiling, a likely figure, and nothing to pay.
  return (
    <View style={{ gap: 4 }}>
      <Text style={type.small}>IT WILL NOT COST YOU MORE THAN</Text>
      <Text style={type.title}>{money(m.ceilingYoursPence)}</Text>
      <Text style={type.small}>
        {item.perHead && m.shares > 1 ? `for your ${m.shares} · ` : ''}probably about {money(m.likelyYoursPence)} — {money(item.totalPence)} split between whoever wants it.
      </Text>
      <Text style={type.small}>{m.heads} on it so far{m.perSharePence ? `, which is ${money(m.perSharePence)} each today` : ''}.</Text>
      {m.minimum ? (
        <Text style={type.small}>
          It needs {m.minimum}{short ? ` — ${m.minimum - m.heads} more` : ''} by {day(m.closesOn)}. If fewer want it, it does not happen and you pay nothing.
        </Text>
      ) : null}
      <Text style={type.small}>Settled on {day(m.closesOn)}, and nothing to pay until then.</Text>
      {item.required ? null : (
        <Wrap>
          <Chip label="I'm in" icon="check" selected={mine?.status === 'in'} onPress={tap(() => onSet({ status: mine?.status === 'in' ? 'clear' : 'in' }))} />
          <Chip label="Not for me" icon="close" selected={mine?.status === 'out'} onPress={tap(() => onSet({ status: mine?.status === 'out' ? 'clear' : 'out' }))} />
        </Wrap>
      )}
    </View>
  );
}

/** Joining is a name, one contact, and how many are with them. Nothing else. */
function JoinForm({ v, busy, onJoin, onCancel }: { v: JoinView; busy: boolean; onJoin: (body: any) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [heads, setHeads] = useState(1);
  const [brings, setBrings] = useState('');
  const [matchId, setMatchId] = useState<string | null>(null);
  return (
    <Card>
      <Text style={type.h2}>Who shall I say you are?</Text>
      <Text style={type.small}>{v.group.organiser ?? 'The organiser'} sees your name and how to reach you, and nothing else about you.</Text>
      {v.expecting.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.label}>They are expecting</Text>
          <Wrap>
            {v.expecting.map((p) => (
              <Chip key={p.id} label={p.name} selected={matchId === p.id} onPress={() => { setMatchId(p.id); setName(p.name); }} />
            ))}
          </Wrap>
        </View>
      ) : null}
      <Text style={type.label}>Your name</Text>
      <TextInput value={name} onChangeText={(t) => { setName(t); setMatchId(null); }} placeholder="The name they know you by" placeholderTextColor={colors.inkFaint} style={styles.input} autoFocus />
      <Text style={type.label}>Mobile or email</Text>
      <TextInput value={contact} onChangeText={setContact} placeholder="So they can remind you — nothing else uses it" placeholderTextColor={colors.inkFaint} style={styles.input} autoCapitalize="none" />
      <Text style={type.label}>Who is coming?</Text>
      <Wrap>
        <Chip label="Just me" selected={heads === 1} onPress={() => { setHeads(1); setBrings(''); }} />
        <Chip label="My whole household" selected={heads > 1} onPress={() => setHeads(Math.max(2, heads))} />
      </Wrap>
      {heads > 1 ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.label}>How many of you, including you?</Text>
          <Row>
            <Chip label="2" selected={heads === 2} onPress={() => setHeads(2)} />
            <Chip label="3" selected={heads === 3} onPress={() => setHeads(3)} />
            <Chip label="4" selected={heads === 4} onPress={() => setHeads(4)} />
            <Chip label="5" selected={heads === 5} onPress={() => setHeads(5)} />
            <Chip label="6" selected={heads === 6} onPress={() => setHeads(6)} />
          </Row>
          <TextInput value={brings} onChangeText={setBrings} placeholder="Who else is coming — names, and ages for children" placeholderTextColor={colors.inkFaint} style={styles.input} />
          <Text style={type.small}>Everything priced per person counts all {heads} of you, and one bill comes to you.</Text>
        </View>
      ) : null}
      <Button
        label={busy ? 'Telling them…' : "That's me — I'm coming"}
        onPress={() => { if (!name.trim() || busy) return; onJoin({ name: name.trim(), contact: contact.trim() || undefined, heads, brings: brings.trim() || undefined, matchId }); }}
      />
      <Button label="Cancel" kind="ghost" onPress={onCancel} />
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, width: '100%' },
  hint: { backgroundColor: colors.surfaceMuted, borderRadius: radius.md, padding: spacing.md },
  trialCard: { backgroundColor: colors.surfaceMuted, borderRadius: radius.md, padding: spacing.md },
  trialIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  pick: { flex: 1, gap: 4, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  pickOn: { borderColor: colors.ink, borderWidth: 2 },
  pickIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  pickIconOn: { backgroundColor: colors.primary },
  memberRow: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700', color: colors.ink },
  addDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  comingBar: { backgroundColor: colors.surfaceMuted, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  ageBox: { width: 72, minHeight: TARGET, paddingHorizontal: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' },
  ageInput: { fontFamily: fonts.body, fontSize: 15, color: colors.ink, textAlign: 'center', outlineStyle: 'none' as any },
  bookRow: { alignItems: 'flex-start', paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.line },
  tile: { width: 34, height: 34, borderRadius: radius.sm, backgroundColor: colors.well, alignItems: 'center', justifyContent: 'center' },
  footer: { gap: 4, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.md },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink, backgroundColor: colors.surface },
  pillOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700', color: colors.ink },
  yn: { minHeight: 36, paddingHorizontal: spacing.md, justifyContent: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  ynLeft: { borderTopLeftRadius: radius.pill, borderBottomLeftRadius: radius.pill },
  ynRight: { borderTopRightRadius: radius.pill, borderBottomRightRadius: radius.pill, marginLeft: -1 },
  ynOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  ynText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700', color: colors.ink },
  ynTextOn: { color: colors.primaryFg },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink, fontFamily: fonts.body,
    // The focus ring is the leaf, not the browser's blue (style guide).
    outlineColor: colors.accent as any, outlineWidth: 2 as any, outlineOffset: 1 as any,
  },
});

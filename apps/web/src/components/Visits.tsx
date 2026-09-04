import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, HouseholdResponse, Take, Venue, Visit, VisitTake } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, StatusLine, Wrap } from './ui';
import { CategoryIcon, Icon } from './Icon';
import { VenuePhoto } from './VenuePhoto';
import { FaceRow } from './Faces';
import { TakePicker, TakeRow, takeFromScore } from './TakePicker';

// The pieces of "we went here" that Places and Trips share: a search-result
// row, one visit in a history, and the form that records a visit.

const today = () => new Date().toISOString().slice(0, 10);
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function VenueRow({ venue, onPress, action, stack }: { venue: Venue; onPress?: () => void; action?: React.ReactNode; /** Put the buttons under the text: a narrow screen has no room beside it. */ stack?: boolean }) {
  const h = venue.household;
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined}>
      <Card style={{ gap: 4 }}>
        <Row>
          {venue.photos?.length ? <VenuePhoto photos={venue.photos} size={56} credit={false} /> : <View style={{ width: 56, height: 56, borderRadius: radius.md, backgroundColor: colors.well, alignItems: 'center', justifyContent: 'center' }}><CategoryIcon category={venue.category} size={22} /></View>}
          <View style={{ flex: 1 }}>
            <Text style={type.h3}>{venue.name}</Text>
            <Text style={type.small}>
              {[venue.category, ...venue.experiences, ...venue.cuisines].filter(Boolean).join(' · ')}
              {venue.rating != null ? ` · rated ${venue.rating.toFixed(1)}${venue.ratingCount ? ` (${venue.ratingCount.toLocaleString()})` : ''}` : ''}
              {venue.distanceKm != null ? ` · ${venue.distanceKm} km` : ''}
            </Text>
            <Text style={type.tiny}>via {(venue.contributingSources?.length ? venue.contributingSources : [venue.source]).join(' + ')}</Text>
          </View>
          {stack ? null : action}
        </Row>
        <Wrap>
          {h?.visits ? <Chip label={`Been ${h.visits}×${h.lastOn ? ` · last ${h.lastOn}` : ''}`} tone="accent" /> : null}
          {h?.loved ? <Chip label={`${h.loved}`} tone="like" icon="keep" iconFill /> : null}
          {h?.notForMe ? <Chip label={`${h.notForMe}`} tone="dislike" icon="close" /> : null}
          {h?.ledger === 'saved' && !h?.visits ? <Chip label="Saved" /> : null}
          {h?.ledger === 'special' ? <Chip label="Special" tone="accent" icon="keep" iconFill /> : null}
          {(venue.dietaryOptions ?? []).map((d) => <Chip key={d} label={d} />)}
          {venue.goodForChildren ? <Chip label="Good for children" /> : null}
        </Wrap>
        {stack ? action : null}
      </Card>
    </Pressable>
  );
}

const fmtScore = (s: number) => s.toFixed(1).replace('.0', '');

/** One visit in a place's history: the date, who came, each person's score and words. */
export function VisitSummary({ visit, onPress }: { visit: Visit; onPress?: () => void }) {
  const takes: any[] = visit.takes?.filter((t) => t.subject === 'visit') ?? visit.visitTakes ?? [];
  const names = (visit.attendees as any[]).map((a) => (typeof a === 'string' ? a : a.name));
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined}>
      <View style={styles.visitRow}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={type.h3}>{visit.visitedOn}</Text>
          <Text style={type.tiny}>{names.join(', ')}</Text>
        </Row>
        {takes.map((t, i) => (
          <View key={i} style={styles.takeLine}>
            <Text style={[type.small, { color: colors.ink, fontWeight: '600', minWidth: 64 }]}>{t.member}</Text>
            {t.score != null ? <View style={styles.scoreInline}><Icon name="favourite" size={13} fill /><Text style={[type.small, { color: colors.ink, fontWeight: '700' }]}>{fmtScore(Number(t.score))}</Text></View> : null}
            <Text style={[type.small, { flex: 1 }]} numberOfLines={2}>{t.take === 'loved' ? 'loved it' : t.take === 'fine' ? 'fine' : 'not for me'}{t.comment ? ` — ${t.comment}` : ''}</Text>
          </View>
        ))}
        {visit.note ? <Text style={type.small}>“{visit.note}”</Text> : null}
      </View>
    </Pressable>
  );
}

export type VisitCreateBody = { visitedOn: string; note: string; attendeeIds: string[]; takes: VisitTake[]; venue: Partial<Venue> };

/** The number behind a word, so a one-tap answer still gives the row a score. */
const SCORE_FOR: Record<Take, number> = { loved: 5, fine: 3, not_for_me: 1 };
const WORD_FOR: Record<Take, string> = { loved: 'Loved it', fine: 'It was fine', not_for_me: 'Not for us' };

/**
 * "Did everyone love it?" — one tap (owner, 4 Sep 2026: "I should just have
 * 'Everyone loved it' as my first option, so it's just 1 click… it's almost
 * like I'm being forced to review it, which is also very awkward"). The date is
 * today and everybody came, because that is nearly always true; anything else
 * is behind "More detail". Each choice saves as it is tapped, so there is
 * nothing to lose by closing the drawer.
 */
export function BeenCapture({ venue, household, onCreate, onSaved, onMore }: {
  venue: Pick<Venue, 'name'>;
  household: HouseholdResponse;
  onCreate: (body: VisitCreateBody) => Promise<void>;
  onSaved: () => Promise<void>;
  /** Where the long form lives, when there is one. */
  onMore?: () => void;
}) {
  const members = household.members;
  const [mode, setMode] = useState<'ask' | 'some'>('ask');
  const [takes, setTakes] = useState<Record<string, Take>>(() => Object.fromEntries(members.map((m) => [m.id, 'loved' as Take])));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (what: Record<string, Take>, tag: string) => {
    setBusy(tag); setError(null);
    try {
      await onCreate({
        visitedOn: today(), note: '', attendeeIds: members.map((m) => m.id),
        takes: members.map((m) => ({ memberId: m.id, subject: 'visit', take: what[m.id], comment: null, score: SCORE_FOR[what[m.id]] })),
        venue: {},
      });
      await onSaved();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const everyone = (take: Take) => save(Object.fromEntries(members.map((m) => [m.id, take])), take);

  if (mode === 'some') {
    return (
      <View style={styles.capture}>
        <Text style={type.h3}>Who loved it?</Text>
        {members.map((m) => (
          <View key={m.id} style={styles.whoLine}>
            <Text style={[type.body, { flex: 1, minWidth: 0 }]} numberOfLines={1}>{m.name.split(' ')[0]}</Text>
            <View style={styles.whoPicks}>
              {(['loved', 'fine', 'not_for_me'] as Take[]).map((t) => {
                const on = takes[m.id] === t;
                return (
                  <Pressable key={t} onPress={() => setTakes((s) => ({ ...s, [m.id]: t }))} style={[styles.whoPick, on && styles.whoPickOn]}
                    accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`${m.name}: ${WORD_FOR[t]}`}>
                    <Icon name={t === 'loved' ? 'keep' : t === 'fine' ? 'minus' : 'close'} size={15} color={on ? colors.primaryFg : colors.ink} fill={t === 'loved' && on} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
        <Row>
          <Button label="Save" onPress={() => save(takes, 'some')} loading={busy === 'some'} />
          <Button label="Back" kind="ghost" onPress={() => setMode('ask')} />
        </Row>
        <Text style={type.tiny}>♥ loved it · – it was fine · ✕ not for us</Text>
      </View>
    );
  }

  return (
    <View style={styles.capture}>
      <Text style={type.h3}>Did everyone love it?</Text>
      <Button label="Everyone loved it" icon="keep" iconFill onPress={() => everyone('loved')} loading={busy === 'loved'} />
      <Row style={{ flexWrap: 'wrap' }}>
        <Button label="Only some of us" kind="secondary" onPress={() => setMode('some')} />
        <Button label="Not for us" kind="secondary" onPress={() => everyone('not_for_me')} loading={busy === 'not_for_me'} />
      </Row>
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      {onMore ? <Pressable onPress={onMore} accessibilityRole="button"><Text style={styles.moreLink}>More detail — another date, who came, a note, exact scores</Text></Pressable> : null}
    </View>
  );
}

/** Rows for the form from a visit being edited: each person's score, take and words. */
export function rowsForVisit(visit: Visit, members: { id: string; name: string }[]): TakeRow[] {
  return members.map((m, i) => {
    const t = visit.takes?.find((x) => x.memberId === m.id && x.subject === 'visit');
    return { memberId: m.id, name: m.name, index: i, take: t?.take ?? null, comment: t?.comment ?? '', score: t?.score ?? null };
  });
}

export function VisitForm({ venue, household, onDone, onCancel, initial, createVia }: {
  venue: Pick<Venue, 'venueRef' | 'name' | 'category' | 'lat' | 'lng' | 'experiences' | 'cuisines'>;
  household: HouseholdResponse; onDone: () => Promise<void>; onCancel: () => void;
  initial?: { visitId: string; date: string; note: string; rows: TakeRow[]; attending: string[] };
  /** Create the visit some other way (e.g. against a trip stop) instead of a free-standing visit. */
  createVia?: (body: VisitCreateBody) => Promise<void>;
}) {
  const members = household.members;
  const [date, setDate] = useState(initial?.date ?? today());
  const [note, setNote] = useState(initial?.note ?? '');
  const [attending, setAttending] = useState<Set<string>>(new Set(initial?.attending ?? members.map((m) => m.id)));
  const [rows, setRows] = useState<TakeRow[]>(initial?.rows ?? members.map((m, i) => ({ memberId: m.id, name: m.name, index: i, take: null, comment: '', score: null })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId] = useState(uuid());

  const visible = rows.filter((r) => attending.has(r.memberId));
  // A score alone is enough: the take it implies is sent so the planner keeps learning.
  const toTakes = (): VisitTake[] => visible.filter((r) => r.take || r.score != null)
    .map((r) => ({ memberId: r.memberId, subject: 'visit', take: r.take ?? takeFromScore(r.score as number), comment: r.comment || null, score: r.score ?? null }));

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (initial) {
        await api.updateVisit(initial.visitId, { note, visitedOn: date });
        await api.setTakes(initial.visitId, toTakes(), { experiences: venue.experiences, cuisines: venue.cuisines, category: venue.category });
      } else if (createVia) {
        await createVia({ visitedOn: date, note, attendeeIds: [...attending], takes: toTakes(), venue: { experiences: venue.experiences, cuisines: venue.cuisines, category: venue.category } });
      } else {
        await api.createVisit({
          venueRef: venue.venueRef, venueLabel: venue.name, category: venue.category, lat: venue.lat, lng: venue.lng,
          visitedOn: date, note, attendeeIds: [...attending], clientId,
          venue: { experiences: venue.experiences, cuisines: venue.cuisines, category: venue.category }, takes: toTakes(),
        });
      }
      await onDone();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <View style={styles.form}>
      <Text style={type.h3}>{initial ? 'Edit this visit' : `We went to ${venue.name}`}</Text>
      <Row>
        <Text style={[type.small, { width: 70 }]}>When</Text>
        <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
      </Row>
      <Text style={type.small}>Who came</Text>
      <FaceRow members={members} attending={attending} onToggle={(id) => setAttending((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
      <Text style={type.small}>What everyone thought — a score out of 5, and a word</Text>
      <TakePicker rows={visible} onChange={(v) => setRows(rows.map((r) => v.find((x) => x.memberId === r.memberId) ?? r))} />
      <TextInput value={note} onChangeText={setNote} placeholder="A note for future us (optional)" placeholderTextColor={colors.inkFaint} style={styles.input} />
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <Row>
        <Button label={initial ? 'Save changes' : 'Save visit'} onPress={submit} loading={busy} />
        <Button label="Cancel" kind="ghost" onPress={onCancel} />
      </Row>
      <Text style={type.tiny}>Ratings are attributed to the kind of place as well as the place, so they help everywhere similar.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  form: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.panel },
  visitRow: { gap: 6, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.panel },
  takeLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  capture: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.panel },
  whoLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: TARGET - 6 },
  whoPicks: { flexDirection: 'row', gap: 6 },
  whoPick: { width: 40, height: 34, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  whoPickOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  moreLink: { fontSize: 13, fontWeight: '600', color: colors.ink, textDecorationLine: 'underline' },
  scoreInline: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});

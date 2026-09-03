import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { api, HouseholdResponse, Place, Take, Venue, Visit, VisitTake } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap } from '../components/ui';
import { FaceRow } from '../components/Faces';
import { PlacePicker } from '../components/PlacePicker';
import { TakePicker, TakeRow } from '../components/TakePicker';

const CATEGORY_ICON: Record<string, string> = { restaurant: '🍽', cafe: '☕', pub: '🍺', bar: '🍸', attraction: '🏛', event: '🎟' };
const today = () => new Date().toISOString().slice(0, 10);
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function PlacesScreen({ household, refreshHousehold }: { household: HouseholdResponse | null; refreshHousehold: () => Promise<void> }) {
  const [tab, setTab] = useState<'find' | 'been'>('find');
  const { width } = useWindowDimensions();
  const wide = width >= 1000;
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={type.title}>Places</Text>
          <Text style={type.small}>Find what's near, remember where you've been, and say what everyone thought.</Text>
        </View>
      </View>
      <Segmented value={tab} options={[{ value: 'find', label: 'Find places' }, { value: 'been', label: "Where we've been" }]} onChange={setTab} />
      {tab === 'find' ? <FindPanel household={household} wide={wide} refreshHousehold={refreshHousehold} /> : <BeenPanel household={household} wide={wide} refreshHousehold={refreshHousehold} />}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

function FindPanel({ household, wide, refreshHousehold }: { household: HouseholdResponse | null; wide: boolean; refreshHousehold: () => Promise<void> }) {
  const home = household?.household.home ?? null;
  const [near, setNear] = useState<Place | null>(home);
  const [cat, setCat] = useState<'things' | 'food' | ''>('things');
  const [q, setQ] = useState('');
  const [radius, setRadius] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.searchPlaces>> | null>(null);
  const [open, setOpen] = useState<Venue | null>(null);

  useEffect(() => { if (!near && home) setNear(home); }, [home]);

  const search = useCallback(async () => {
    if (!near) { setError('Pick where to look — or set your home address in Settings.'); return; }
    setBusy(true); setError(null);
    try {
      setRes(await api.searchPlaces({ near: `${near.lat},${near.lng}`, categories: cat || undefined, q: q.trim() || undefined, radiusKm: radius }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, [near, cat, q, radius]);

  return (
    <View style={[styles.split, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
      <View style={[{ gap: spacing.md }, wide && { width: 380 }]}>
        <Card>
          <Text style={type.h3}>Near</Text>
          <PlacePicker value={near} onPick={setNear} extra={home ? [home] : []} placeholder="A town, an address, a landmark" />
          {!home ? <StatusLine>No home address yet — set one in Settings and it'll be the default.</StatusLine> : null}
          <Text style={type.h3}>What kind of place</Text>
          <Segmented value={cat} options={[{ value: 'things', label: 'Things to do' }, { value: 'food', label: 'Food & drink' }, { value: '', label: 'Everything' }]} onChange={setCat} />
          <TextInput value={q} onChangeText={setQ} placeholder="Name contains… (optional)" placeholderTextColor={colors.inkFaint} style={styles.input} onSubmitEditing={search} returnKeyType="search" />
          <Wrap>{[1, 2, 5, 10].map((r) => <Chip key={r} label={`${r} km`} selected={radius === r} onPress={() => setRadius(r)} />)}</Wrap>
          <Button label="Search" onPress={search} loading={busy} />
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
        </Card>
      </View>

      <View style={[{ flex: 1, gap: spacing.md }, wide && { minWidth: 0 }]}>
        {open ? <PlaceDetail venue={open} household={household} onClose={() => setOpen(null)} onChanged={async () => { await refreshHousehold(); await search(); }} /> : null}
        {res ? (
          <>
            <Text style={type.small}>
              {res.results.length} places within {res.radiusKm} km of {res.near.label}
              {res.degradedSources.length ? ` · ${res.degradedSources.map((d) => d.source).join(', ')} unavailable` : ''}
            </Text>
            {res.results.map((v) => <VenueRow key={v.venueRef} venue={v} onPress={() => setOpen(v)} />)}
            <Text style={type.tiny}>{res.attribution.join(' · ')}</Text>
          </>
        ) : !open ? (
          <Card><Text style={type.small}>Search to see museums, parks, playgrounds, cafés and restaurants near wherever you are. Places you've been show how many times and what you thought.</Text></Card>
        ) : null}
      </View>
    </View>
  );
}

export function VenueRow({ venue, onPress, action }: { venue: Venue; onPress?: () => void; action?: React.ReactNode }) {
  const h = venue.household;
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined}>
      <Card style={{ gap: 4 }}>
        <Row>
          <Text style={{ fontSize: 20 }}>{CATEGORY_ICON[venue.category] ?? '📍'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={type.h3}>{venue.name}</Text>
            <Text style={type.small}>
              {[venue.category, ...venue.experiences, ...venue.cuisines].filter(Boolean).join(' · ')}
              {venue.distanceKm != null ? ` · ${venue.distanceKm} km` : ''}
            </Text>
          </View>
          {action}
        </Row>
        <Wrap>
          {h?.visits ? <Chip label={`Been ${h.visits}×${h.lastOn ? ` · last ${h.lastOn}` : ''}`} tone="accent" /> : null}
          {h?.loved ? <Chip label={`♥ ${h.loved}`} tone="like" /> : null}
          {h?.notForMe ? <Chip label={`✕ ${h.notForMe}`} tone="dislike" /> : null}
          {h?.ledger === 'saved' && !h?.visits ? <Chip label="Saved" /> : null}
          {(venue.dietaryOptions ?? []).map((d) => <Chip key={d} label={d} />)}
          {venue.goodForChildren ? <Chip label="Good for children" /> : null}
        </Wrap>
      </Card>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Detail + visit form
// ---------------------------------------------------------------------------

function PlaceDetail({ venue, household, onClose, onChanged }: { venue: Venue; household: HouseholdResponse | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<{ visits: Visit[]; household: Venue['household'] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const d = await api.place(venue.venueRef); setDetail({ visits: d.visits, household: d.household }); } catch { setDetail({ visits: [], household: null }); }
  }, [venue.venueRef]);
  useEffect(() => { load(); }, [load]);

  return (
    <Card style={{ borderColor: colors.accent }}>
      <Row>
        <Text style={{ fontSize: 24 }}>{CATEGORY_ICON[venue.category] ?? '📍'}</Text>
        <View style={{ flex: 1 }}>
          <Text style={type.h2}>{venue.name}</Text>
          <Text style={type.small}>{[venue.category, ...venue.experiences, ...venue.cuisines].join(' · ')}{venue.address ? ` · ${venue.address}` : ''}</Text>
        </View>
        <Button label="Close" kind="ghost" onPress={onClose} />
      </Row>
      {venue.openingHours ? <Text style={type.small}>Hours: {venue.openingHours}</Text> : null}
      {venue.website ? <Pressable onPress={() => Linking.openURL(venue.website!)}><Text style={[type.small, { color: colors.accent }]}>{venue.website}</Text></Pressable> : null}
      {venue.dishes?.length ? (
        <View style={{ gap: 4 }}>
          <Text style={type.h3}>Known for</Text>
          {venue.dishes.map((d) => <Text key={d.name} style={type.small}>• {d.name}{d.comment ? ` — "${d.comment}"` : ''}</Text>)}
        </View>
      ) : null}
      <Text style={type.tiny}>{venue.attribution ?? ''} · No reviews or allergen data from this source yet; what you record here is yours.</Text>

      <Row>
        <Button label="We've been here" onPress={() => setAdding(true)} />
        <Button label={saved ? 'Saved ✓' : 'Save for later'} kind="secondary" onPress={async () => { await api.savePlace(venue.venueRef); setSaved('yes'); }} />
      </Row>

      {adding && household ? (
        <VisitForm venue={venue} household={household} onDone={async () => { setAdding(false); await load(); await onChanged(); }} onCancel={() => setAdding(false)} />
      ) : null}

      {detail?.visits.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.h3}>Our history here</Text>
          {detail.visits.map((v) => <VisitSummary key={v.id} visit={v} />)}
        </View>
      ) : detail ? <Text style={type.small}>We haven't recorded a visit here yet.</Text> : null}
    </Card>
  );
}

export function VisitSummary({ visit, onPress }: { visit: Visit; onPress?: () => void }) {
  const takes = visit.takes?.filter((t) => t.subject === 'visit') ?? visit.visitTakes ?? [];
  const names = (visit.attendees as any[]).map((a) => (typeof a === 'string' ? a : a.name));
  return (
    <Pressable onPress={onPress} disabled={!onPress}>
      <View style={styles.visitRow}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={type.h3}>{visit.visitedOn}</Text>
          <Text style={type.tiny}>{names.join(', ')}</Text>
        </Row>
        <Wrap>
          {takes.map((t: any, i: number) => (
            <Chip key={i} label={`${t.member}: ${t.take === 'loved' ? 'loved it' : t.take === 'fine' ? 'fine' : 'not for me'}${t.comment ? ` — ${t.comment}` : ''}`} tone={t.take === 'loved' ? 'like' : t.take === 'not_for_me' ? 'dislike' : 'neutral'} />
          ))}
        </Wrap>
        {visit.note ? <Text style={type.small}>“{visit.note}”</Text> : null}
      </View>
    </Pressable>
  );
}

export type VisitCreateBody = { visitedOn: string; note: string; attendeeIds: string[]; takes: VisitTake[]; venue: Partial<Venue> };

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
  const [rows, setRows] = useState<TakeRow[]>(initial?.rows ?? members.map((m, i) => ({ memberId: m.id, name: m.name, index: i, take: null, comment: '' })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId] = useState(uuid());

  const visible = rows.filter((r) => attending.has(r.memberId));
  const toTakes = (): VisitTake[] => visible.filter((r) => r.take).map((r) => ({ memberId: r.memberId, subject: 'visit', take: r.take as Take, comment: r.comment || null }));

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
      <Text style={type.small}>What everyone thought</Text>
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

// ---------------------------------------------------------------------------
// Been
// ---------------------------------------------------------------------------

function BeenPanel({ household, wide, refreshHousehold }: { household: HouseholdResponse | null; wide: boolean; refreshHousehold: () => Promise<void> }) {
  const [country, setCountry] = useState<string>('');
  const [q, setQ] = useState('');
  const [take, setTake] = useState<'' | Take>('');
  const [data, setData] = useState<Awaited<ReturnType<typeof api.visits>> | null>(null);
  const [open, setOpen] = useState<Visit | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setData(await api.visits({ country: country || undefined, q: q || undefined, take: take || undefined }));
  }, [country, q, take]);
  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const g = new Map<string, Visit[]>();
    for (const v of data?.visits ?? []) { const k = v.locality ? `${v.locality}, ${v.country ?? ''}` : (v.country ?? 'Somewhere'); if (!g.has(k)) g.set(k, []); g.get(k)!.push(v); }
    return [...g.entries()];
  }, [data]);

  return (
    <View style={[styles.split, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
      <View style={[{ gap: spacing.md }, wide && { width: 320 }]}>
        <Card>
          <Text style={type.h3}>Filter</Text>
          <Wrap>
            <Chip label="Everywhere" selected={!country} onPress={() => setCountry('')} />
            {(data?.countries ?? []).map((c) => <Chip key={c.code} label={`${c.name} (${c.visits})`} selected={country === c.code} onPress={() => setCountry(c.code)} />)}
          </Wrap>
          <TextInput value={q} onChangeText={setQ} placeholder="Search places, towns, notes" placeholderTextColor={colors.inkFaint} style={styles.input} />
          <Segmented value={take} options={[{ value: '', label: 'All' }, { value: 'loved', label: 'Loved' }, { value: 'not_for_me', label: 'Not for us' }]} onChange={setTake} />
        </Card>
      </View>
      <View style={{ flex: 1, gap: spacing.md }}>
        {open ? (
          <Card style={{ borderColor: colors.accent }}>
            <Row>
              <View style={{ flex: 1 }}>
                <Text style={type.h2}>{open.venueLabel}</Text>
                <Text style={type.small}>{[open.locality, open.country].filter(Boolean).join(', ')} · {open.visitedOn}</Text>
              </View>
              <Button label="Close" kind="ghost" onPress={() => { setOpen(null); setEditing(false); }} />
            </Row>
            {editing && household ? (
              <VisitForm
                venue={{ venueRef: open.venueRef, name: open.venueLabel, category: open.category ?? 'attraction', lat: open.lat ?? 0, lng: open.lng ?? 0, experiences: [], cuisines: [] }}
                household={household}
                initial={{
                  visitId: open.id, date: open.visitedOn, note: open.note ?? '',
                  attending: (open.attendees as any[]).map((a) => (typeof a === 'string' ? household.members.find((m) => m.name === a)?.id ?? '' : a.id)).filter(Boolean),
                  rows: household.members.map((m, i) => { const t = open.takes?.find((x) => x.memberId === m.id && x.subject === 'visit'); return { memberId: m.id, name: m.name, index: i, take: t?.take ?? null, comment: t?.comment ?? '' }; }),
                }}
                onDone={async () => { setEditing(false); const v = await api.visit(open.id); setOpen(v.visit); await load(); await refreshHousehold(); }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                <VisitSummary visit={open} />
                <Row>
                  <Button label="Edit what we thought" kind="secondary" onPress={() => setEditing(true)} />
                  <Button label="Delete visit" kind="danger" onPress={async () => { await api.deleteVisit(open.id); setOpen(null); await load(); await refreshHousehold(); }} />
                </Row>
              </>
            )}
          </Card>
        ) : null}
        {grouped.length === 0 ? <Card><Text style={type.small}>No visits yet. Find a place and tap "We've been here" — or mark a stop on a trip as visited.</Text></Card> : null}
        {grouped.map(([place, list]) => (
          <View key={place} style={{ gap: spacing.sm }}>
            <Text style={type.h2}>{place}</Text>
            {list.map((v) => (
              <Pressable key={v.id} onPress={async () => { const d = await api.visit(v.id); setOpen(d.visit); setEditing(false); }}>
                <Card style={{ gap: 4 }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={type.h3}>{CATEGORY_ICON[v.category ?? ''] ?? '📍'} {v.venueLabel}</Text>
                    <Text style={type.tiny}>{v.visitedOn}</Text>
                  </Row>
                  <Wrap>
                    {(v.visitTakes ?? []).map((t, i) => <Chip key={i} label={`${t.member}: ${t.take === 'loved' ? '♥' : t.take === 'fine' ? '–' : '✕'}`} tone={t.take === 'loved' ? 'like' : t.take === 'not_for_me' ? 'dislike' : 'neutral'} />)}
                    {(v.attendees as string[]).length ? <Chip label={(v.attendees as string[]).join(', ')} /> : null}
                  </Wrap>
                </Card>
              </Pressable>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 1100, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  split: { gap: spacing.md },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  form: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  visitRow: { gap: 6, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
});

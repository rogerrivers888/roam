import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { api, HouseholdResponse, Place, TripDetail, TripStop, TripSummary, Venue } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap, clock, minutes } from '../components/ui';
import { TimeBar } from '../components/TimeBar';
import { FaceRow } from '../components/Faces';
import { PlacePicker } from '../components/PlacePicker';
import { VenueRow, VisitForm, VisitSummary } from './PlacesScreen';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function TripsScreen({ household, refreshHousehold }: { household: HouseholdResponse | null; refreshHousehold: () => Promise<void> }) {
  const { width } = useWindowDimensions();
  const wide = width >= 1000;
  const [country, setCountry] = useState('');
  const [when, setWhen] = useState<'' | 'upcoming' | 'past'>('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof api.trips>> | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.trips({ country: country || undefined, when: when || undefined, q: q || undefined })); } catch (e: any) { setError(e.message); }
  }, [country, when, q]);
  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const g = new Map<string, TripSummary[]>();
    for (const t of data?.trips ?? []) { const k = t.country ?? 'Somewhere'; if (!g.has(k)) g.set(k, []); g.get(k)!.push(t); }
    return [...g.entries()];
  }, [data]);

  if (openId) return <TripDetailView id={openId} household={household} onBack={async () => { setOpenId(null); await load(); }} refreshHousehold={refreshHousehold} />;

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={type.title}>Trips</Text>
          <Text style={type.small}>Days out and holidays, by country — with the places you went and what you thought of them.</Text>
        </View>
        <Button label={creating ? 'Close' : '+ New trip'} kind={creating ? 'ghost' : 'primary'} onPress={() => setCreating((c) => !c)} />
      </View>

      {creating && household ? <NewTripForm household={household} onCreated={async (t) => { setCreating(false); await load(); setOpenId(t.trip.id); }} /> : null}

      <View style={[styles.split, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
        <View style={[{ gap: spacing.md }, wide && { width: 300 }]}>
          <Card>
            <Text style={type.h3}>Where</Text>
            <Wrap>
              <Chip label="Everywhere" selected={!country} onPress={() => setCountry('')} />
              {(data?.countries ?? []).map((c) => <Chip key={c.code} label={`${c.name} (${c.trips})`} selected={country === c.code} onPress={() => setCountry(c.code)} />)}
            </Wrap>
            <Text style={type.h3}>When</Text>
            <Segmented value={when} options={[{ value: '', label: 'All' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} onChange={setWhen} />
            <TextInput value={q} onChangeText={setQ} placeholder="Search trips and places" placeholderTextColor={colors.inkFaint} style={styles.input} />
          </Card>
        </View>
        <View style={{ flex: 1, gap: spacing.md }}>
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
          {grouped.length === 0 && data ? <Card><Text style={type.small}>No trips here yet. Plan one by talking to Roam, or create one above.</Text></Card> : null}
          {grouped.map(([countryName, trips]) => (
            <View key={countryName} style={{ gap: spacing.sm }}>
              <Text style={type.h2}>{countryName}</Text>
              {trips.map((t) => (
                <Pressable key={t.id} onPress={() => setOpenId(t.id)} accessibilityRole="button">
                  <Card style={{ gap: 4 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={[type.h3, { flex: 1 }]}>{t.title ?? `${t.origin.label}${t.destination ? ` → ${t.destination.label}` : ''}`}</Text>
                      <Text style={type.tiny}>{t.isPast ? 'past' : 'upcoming'}</Text>
                    </Row>
                    <Text style={type.small}>{fmtDate(t.departAt)} · {clock(t.departAt)}–{clock(t.returnAt)}{t.locality ? ` · ${t.locality}` : ''}</Text>
                    <Wrap>
                      <Chip label={`${t.stopCount} stop${t.stopCount === 1 ? '' : 's'}`} />
                      {t.visitCount ? <Chip label={`${t.visitCount} visited`} tone="accent" /> : null}
                      {t.ratingCount ? <Chip label={`${t.ratingCount} takes`} tone="like" /> : null}
                      {t.attendees.length ? <Chip label={t.attendees.join(', ')} /> : null}
                    </Wrap>
                  </Card>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// New trip
// ---------------------------------------------------------------------------

function NewTripForm({ household, onCreated }: { household: HouseholdResponse; onCreated: (t: TripDetail) => Promise<void> }) {
  const home = household.household.home;
  const [title, setTitle] = useState('');
  const [from, setFrom] = useState<Place | null>(home);
  const [to, setTo] = useState<Place | null>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('16:00');
  const [mode, setMode] = useState<'walking' | 'cycling' | 'driving' | 'transit'>('driving');
  const [intensity, setIntensity] = useState(household.household.defaultIntensity);
  const [attending, setAttending] = useState<Set<string>>(new Set(household.members.map((m) => m.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!from) { setError('Where does it start?'); return; }
    setBusy(true); setError(null);
    try {
      const t = await api.createTrip({
        title: title.trim() || undefined, origin: from, destination: to ?? undefined,
        departAt: new Date(`${date}T${start}:00`).toISOString(), returnAt: new Date(`${date}T${end}:00`).toISOString(),
        travelMode: mode, intensity, attendingMemberIds: [...attending],
      });
      await onCreated(t);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card style={{ borderColor: colors.accent }}>
      <Text style={type.h2}>New trip</Text>
      <TextInput value={title} onChangeText={setTitle} placeholder="Title (optional) — e.g. Lisbon, Easter week" placeholderTextColor={colors.inkFaint} style={styles.input} />
      <Text style={type.h3}>From</Text>
      <PlacePicker value={from} onPick={setFrom} extra={home ? [home] : []} />
      <Text style={type.h3}>To (optional — leave empty for a day out and back)</Text>
      <PlacePicker value={to} onPick={setTo} />
      <Row>
        <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
        <TextInput value={start} onChangeText={setStart} placeholder="10:00" placeholderTextColor={colors.inkFaint} style={[styles.input, { width: 90 }]} />
        <Text style={type.small}>to</Text>
        <TextInput value={end} onChangeText={setEnd} placeholder="16:00" placeholderTextColor={colors.inkFaint} style={[styles.input, { width: 90 }]} />
      </Row>
      <Segmented value={mode} options={[{ value: 'walking', label: 'Walk' }, { value: 'cycling', label: 'Cycle' }, { value: 'driving', label: 'Drive' }, { value: 'transit', label: 'Transit' }]} onChange={setMode} />
      <Segmented value={intensity} options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'packed', label: 'Packed' }]} onChange={setIntensity} />
      <Text style={type.small}>Who's coming</Text>
      <FaceRow members={household.members} attending={attending} onToggle={(id) => setAttending((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <Button label="Create trip" onPress={submit} loading={busy} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function TripDetailView({ id, household, onBack, refreshHousehold }: { id: string; household: HouseholdResponse | null; onBack: () => Promise<void>; refreshHousehold: () => Promise<void> }) {
  const [d, setD] = useState<TripDetail | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api.trip(id)); } catch (e: any) { setError(e.message); } }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <ScrollView contentContainerStyle={styles.page}><Button label="← Trips" kind="ghost" onPress={onBack} style={{ alignSelf: 'flex-start' }} />{error ? <StatusLine tone="warn">{error}</StatusLine> : <Text style={type.small}>Loading…</Text>}</ScrollView>;

  const { trip, stops, budget, attendees } = d;
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Button label="← Trips" kind="ghost" onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <View>
        <Text style={type.title}>{trip.title ?? `${trip.origin.label}${trip.destination ? ` → ${trip.destination.label}` : ''}`}</Text>
        <Text style={type.small}>
          {fmtDate(trip.departAt)} · {clock(trip.departAt)}–{clock(trip.returnAt)} · {trip.travelMode} · {trip.intensity}
          {trip.locality ? ` · ${trip.locality}, ${trip.country}` : trip.country ? ` · ${trip.country}` : ''}
        </Text>
        <Text style={type.small}>{trip.origin.label}{trip.destination ? ` → ${trip.destination.label}` : ' and back'} · with {attendees.map((a) => a.name).join(', ')}</Text>
      </View>

      <Card>
        <TimeBar budget={budget} stops={stops.map((s) => ({ id: s.id, name: s.name, dwellMinutes: s.dwellMinutes }))} departAt={trip.departAt} returnAt={trip.returnAt} />
      </Card>

      {stops.length === 0 ? <Card><Text style={type.small}>No stops yet. Add places below, or plan this day by talking to Roam.</Text></Card> : null}
      {stops.map((s, i) => (
        <StopCard key={s.id} stop={s} leg={budget.legs[i]} trip={trip} household={household} onChanged={async () => { await load(); await refreshHousehold(); }} />
      ))}
      {budget.legs.length > stops.length && stops.length ? <Text style={type.small}>Then {budget.legs[budget.legs.length - 1].minutes} min to {budget.legs[budget.legs.length - 1].to}.</Text> : null}

      <Row>
        <Button label={adding ? 'Done adding' : '+ Add a stop'} kind={adding ? 'ghost' : 'secondary'} onPress={() => setAdding((a) => !a)} />
        <Button label="Delete trip" kind="danger" onPress={async () => { await api.deleteTrip(trip.id); await onBack(); }} />
      </Row>
      {adding ? <AddStopPanel trip={trip} onAdd={async (v) => { await api.addStop(trip.id, { venueRef: v.venueRef, name: v.name, lat: v.lat, lng: v.lng }); await load(); }} /> : null}
    </ScrollView>
  );
}

function StopCard({ stop, leg, trip, household, onChanged }: { stop: TripStop; leg?: { from: string; to: string; minutes: number }; trip: TripDetail['trip']; household: HouseholdResponse | null; onChanged: () => Promise<void> }) {
  const [rating, setRating] = useState(false);
  const visit = stop.visit;
  return (
    <Card>
      <Row>
        <Text style={styles.pos}>{stop.position}</Text>
        <View style={{ flex: 1 }}>
          <Text style={type.h3}>{stop.name}</Text>
          <Text style={type.small}>{leg ? `+${leg.minutes} min from ${leg.from} · ` : ''}stay {minutes(stop.dwellMinutes)}</Text>
        </View>
        {!visit ? <Button label="We went" kind="secondary" onPress={() => setRating(true)} /> : <Chip label={`Visited ${visit.visitedOn}`} tone="accent" />}
        <Button label="Remove" kind="ghost" onPress={async () => { await api.removeStop(trip.id, stop.id); await onChanged(); }} />
      </Row>
      {visit ? (
        <>
          <VisitSummary visit={visit} />
          {!rating ? <Button label="Edit what we thought" kind="ghost" onPress={() => setRating(true)} style={{ alignSelf: 'flex-start' }} /> : null}
        </>
      ) : null}
      {rating && household ? (
        <VisitForm
          venue={{ venueRef: stop.venueRef, name: stop.name, category: visit?.category ?? 'attraction', lat: stop.lat ?? 0, lng: stop.lng ?? 0, experiences: [], cuisines: [] }}
          household={household}
          initial={visit ? {
            visitId: visit.id, date: visit.visitedOn, note: visit.note ?? '',
            attending: (visit.attendees as any[]).map((a) => (typeof a === 'string' ? household.members.find((m) => m.name === a)?.id ?? '' : a.id)).filter(Boolean),
            rows: household.members.map((m, i) => { const t = visit.takes?.find((x) => x.memberId === m.id && x.subject === 'visit'); return { memberId: m.id, name: m.name, index: i, take: t?.take ?? null, comment: t?.comment ?? '' }; }),
          } : undefined}
          onDone={async () => { setRating(false); await onChanged(); }}
          onCancel={() => setRating(false)}
          createVia={!visit ? async (body) => {
            const r = await api.visitStop(trip.id, stop.id, { visitedOn: body.visitedOn, note: body.note, venue: body.venue });
            if (body.takes.length) await api.setTakes(r.visit.id, body.takes, body.venue);
          } : undefined}
        />
      ) : null}
    </Card>
  );
}

function AddStopPanel({ trip, onAdd }: { trip: TripDetail['trip']; onAdd: (v: Venue) => Promise<void> }) {
  const anchor = trip.destination ?? trip.origin;
  const [cat, setCat] = useState<'things' | 'food' | ''>('things');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Venue[]>([]);
  const search = async () => {
    setBusy(true);
    try { setRes((await api.searchPlaces({ near: `${anchor.lat},${anchor.lng}`, categories: cat || undefined, q: q || undefined, radiusKm: 3 })).results); } finally { setBusy(false); }
  };
  return (
    <Card>
      <Text style={type.h3}>Places near {anchor.label}</Text>
      <Segmented value={cat} options={[{ value: 'things', label: 'Things to do' }, { value: 'food', label: 'Food & drink' }, { value: '', label: 'Everything' }]} onChange={setCat} />
      <Row>
        <TextInput value={q} onChangeText={setQ} placeholder="Name contains… (optional)" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} onSubmitEditing={search} />
        <Button label="Search" onPress={search} loading={busy} />
      </Row>
      {res.slice(0, 30).map((v) => <VenueRow key={v.venueRef} venue={v} action={<Button label="Add" kind="secondary" onPress={() => onAdd(v)} />} />)}
    </Card>
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
  pos: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.dwell, color: '#fff', textAlign: 'center', lineHeight: 26, fontSize: 13, fontWeight: '700', overflow: 'hidden' },
});

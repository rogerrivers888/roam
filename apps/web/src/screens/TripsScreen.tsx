import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { api, BrowseItem, HouseholdResponse, Place, PlanAction, PlanResponse, ShortlistItem, TripDay, TripDetail, TripSummary, Venue, DayStop } from '../api';
import { colors, memberColors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap, clock, minutes } from '../components/ui';
import { SourcePicker, TripSpendLine } from '../components/SourcePicker';
import { TimeBar } from '../components/TimeBar';
import { FaceRow } from '../components/Faces';
import { PlacePicker } from '../components/PlacePicker';
import { DateRangePicker, monthSpanLabel } from '../components/DateRangePicker';
import { PricePointControl, ChainsControl } from '../components/PlanControls';
import { BrowsePool } from '../components/BrowsePool';
import { MapView, MapPin } from '../components/MapView';
import { VenueRow, VisitForm, VisitSummary } from './PlacesScreen';
import { speak as speakRaw, useSpeech } from '../hooks/useSpeech';
import { getSpeakPref } from './SettingsScreen';

const speak = (t: string) => { if (getSpeakPref()) speakRaw(t); };
const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtRange = (a?: string | null, b?: string | null) => (a && b ? (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`) : '');
const SLOT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' } as const;
const CATEGORY_ICON: Record<string, string> = { restaurant: '🍽', cafe: '☕', pub: '🍺', bar: '🍸', attraction: '🏛', event: '🎟' };

export type TripPrefill = { placeText?: string; place?: Place; countryCode?: string };

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function TripsScreen({ household, refreshHousehold, prefill, onPrefillConsumed }: {
  household: HouseholdResponse | null; refreshHousehold: () => Promise<void>; prefill?: TripPrefill | null; onPrefillConsumed?: () => void;
}) {
  const { width } = useWindowDimensions();
  const wide = width >= 1000;
  const [country, setCountry] = useState('');
  const [kind, setKind] = useState<'' | 'trip' | 'outing'>('');
  const [when, setWhen] = useState<'' | 'upcoming' | 'past'>('');
  const [data, setData] = useState<Awaited<ReturnType<typeof api.trips>> | null>(null);
  const [creating, setCreating] = useState(!!prefill);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (prefill) setCreating(true); }, [prefill]);

  const load = useCallback(async () => {
    try { setData(await api.trips({ country: country || undefined, kind: kind || undefined, when: when || undefined })); } catch (e: any) { setError(e.message); }
  }, [country, kind, when]);
  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const g = new Map<string, TripSummary[]>();
    for (const t of data?.trips ?? []) { const k = t.country ?? 'Somewhere'; if (!g.has(k)) g.set(k, []); g.get(k)!.push(t); }
    return [...g.entries()];
  }, [data]);

  if (openId) return <TripPage id={openId} household={household} onBack={async () => { setOpenId(null); await load(); }} refreshHousehold={refreshHousehold} wide={wide} />;

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={type.title}>Trips</Text>
          <Text style={type.small}>A day out or a week away. Every trip starts from the places you already know there.</Text>
        </View>
        <Button label={creating ? 'Close' : '+ New trip'} kind={creating ? 'ghost' : 'primary'} onPress={() => { setCreating((c) => !c); onPrefillConsumed?.(); }} />
      </View>

      {creating && household ? (
        <NewTripForm household={household} prefill={prefill ?? null} onCreated={async (t) => { setCreating(false); onPrefillConsumed?.(); await load(); setOpenId(t.trip.id); }} />
      ) : null}

      <View style={[styles.split, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
        <View style={[{ gap: spacing.md }, wide && { width: 300 }]}>
          <Card>
            <Text style={type.h3}>Where</Text>
            <Wrap>
              <Chip label="Everywhere" selected={!country} onPress={() => setCountry('')} />
              {(data?.countries ?? []).map((c) => <Chip key={c.code} label={`${c.name} (${c.trips})`} selected={country === c.code} onPress={() => setCountry(c.code)} />)}
            </Wrap>
            <Text style={type.h3}>What</Text>
            <Segmented value={kind} options={[{ value: '', label: 'All' }, { value: 'trip', label: 'Trips away' }, { value: 'outing', label: 'Days out' }]} onChange={setKind} />
            <Text style={type.h3}>When</Text>
            <Segmented value={when} options={[{ value: '', label: 'All' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} onChange={setWhen} />
          </Card>
        </View>
        <View style={{ flex: 1, gap: spacing.md }}>
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
          {grouped.length === 0 && data ? <Card><Text style={type.small}>No trips here yet. Create one above, or open a city in Places and tap "Plan a trip here".</Text></Card> : null}
          {grouped.map(([countryName, trips]) => (
            <View key={countryName} style={{ gap: spacing.sm }}>
              <Text style={type.h2}>{countryName}</Text>
              {trips.map((t) => (
                <Pressable key={t.id} onPress={() => setOpenId(t.id)} accessibilityRole="button">
                  <Card style={{ gap: 4 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={[type.h3, { flex: 1 }]}>{t.title ?? t.place?.label ?? t.origin.label}</Text>
                      <Text style={type.tiny}>{t.kind === 'trip' ? 'trip' : 'day out'} · {t.isPast ? 'past' : 'upcoming'}</Text>
                    </Row>
                    <Text style={type.small}>
                      {t.kind === 'trip' ? fmtRange(t.startDate, t.endDate) : `${fmtDate(t.departAt)} · ${clock(t.departAt)}–${clock(t.returnAt)}`}
                      {t.locality ? ` · ${t.locality}` : ''}{t.base?.label && t.kind === 'trip' ? ` · staying ${t.base.label}` : ''}
                    </Text>
                    <Wrap>
                      {t.kind === 'trip' ? <Chip label={`${t.dayCount} day${t.dayCount === 1 ? '' : 's'}`} /> : null}
                      <Chip label={`${t.stopCount} planned`} />
                      {t.shortlistCount ? <Chip label={`${t.shortlistCount} shortlisted`} tone="want" /> : null}
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

function NewTripForm({ household, prefill, onCreated }: { household: HouseholdResponse; prefill: TripPrefill | null; onCreated: (t: TripDetail) => Promise<void> }) {
  const home = household.household.home;
  const [kind, setKind] = useState<'trip' | 'outing'>('trip');
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<Place | null>(prefill?.place ?? null);
  const [placeText, setPlaceText] = useState(prefill?.placeText ?? '');
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
  const [base, setBase] = useState<Place | null>(null);
  const [baseKind, setBaseKind] = useState<'hotel' | 'rental' | 'friends' | 'home' | 'other'>('hotel');
  const [hasCar, setHasCar] = useState(true);
  const [dayStart, setDayStart] = useState('09:30');
  const [dayEnd, setDayEnd] = useState('21:00');
  const [intensity, setIntensity] = useState(household.household.defaultIntensity);
  const [attending, setAttending] = useState<Set<string>>(new Set(household.members.map((m) => m.id)));
  const [seed, setSeed] = useState(true);
  // outing
  const [from, setFrom] = useState<Place | null>(home);
  const [to, setTo] = useState<Place | null>(null);
  const [oStart, setOStart] = useState('10:00');
  const [oEnd, setOEnd] = useState('16:00');
  const [mode, setMode] = useState<'walking' | 'cycling' | 'driving' | 'transit'>('driving');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Where first, then the name: the name starts with the city, so two Rome
  // trips read as "Rome · half-term" and "Rome · Oct 2026", never "Roma Oct 26" alone.
  const shortName = (p: Place | null) => (!p ? '' : home && p.lat === home.lat && p.lng === home.lng ? 'Home' : (p.locality ?? p.label.split(',')[0].trim()));
  const city = kind === 'trip' ? (place ? shortName(place) : placeText.trim()) : shortName(to) || shortName(from);
  const defaultTitle = kind === 'trip'
    ? (city ? `${city} · ${monthSpanLabel(start, end)}` : '')
    : (to ? `${shortName(from) || 'Home'} → ${shortName(to)}` : from ? `Around ${shortName(from)}` : '');
  const savedTitle = (() => {
    const t = title.trim();
    if (!t) return defaultTitle || undefined;
    if (!city || t.toLowerCase().includes(city.toLowerCase())) return t;
    return `${city} · ${t}`;
  })();

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (kind === 'trip') {
        if (!place && !placeText.trim()) { setError('Where is the trip? Pick a city or region.'); setBusy(false); return; }
        const t = await api.createMultiDayTrip({
          title: savedTitle, place: place ?? undefined, placeText: place ? undefined : placeText.trim(), startDate: start, endDate: end,
          base: base ?? undefined, baseKind: base ? baseKind : 'other', hasCar, dayStart, dayEnd, intensity, attendingMemberIds: [...attending], seedFromAtlas: seed,
        });
        await onCreated(t);
      } else {
        if (!from) { setError('Where does it start?'); setBusy(false); return; }
        const t = await api.createTrip({
          title: savedTitle, origin: from, destination: to ?? undefined,
          departAt: new Date(`${start}T${oStart}:00`).toISOString(), returnAt: new Date(`${start}T${oEnd}:00`).toISOString(),
          travelMode: mode, intensity, attendingMemberIds: [...attending],
        });
        await onCreated(t);
      }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const nameField = (
    <>
      <Text style={type.h3}>Name</Text>
      <Row>
        {city ? <View style={styles.prefix}><Text style={type.h3}>{city} ·</Text></View> : null}
        <TextInput value={title} onChangeText={setTitle} placeholder={city ? (kind === 'trip' ? `${monthSpanLabel(start, end)} (or your own — half-term, Gina's birthday…)` : 'Saturday at the coast…') : 'Pick where first'} placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
      </Row>
      {savedTitle ? <Text style={type.tiny}>Saved as “{savedTitle}”.</Text> : null}
    </>
  );

  return (
    <Card style={{ borderColor: colors.accent }}>
      <Segmented value={kind} options={[{ value: 'trip', label: 'Trip away (dates)' }, { value: 'outing', label: 'Day out (hours)' }]} onChange={setKind} />

      {kind === 'trip' ? (
        <>
          <Text style={type.h3}>Where</Text>
          {place ? <PlacePicker value={place} onPick={setPlace} countryCode={prefill?.countryCode} /> : (
            <>
              <TextInput value={placeText} onChangeText={setPlaceText} placeholder="City or region — Lisbon, the Lake District, New York" placeholderTextColor={colors.inkFaint} style={styles.input} />
              <Text style={type.tiny}>Or pick precisely:</Text>
              <PlacePicker value={null} onPick={(p) => { setPlace(p); setPlaceText(''); }} placeholder="Search a city or region" countryCode={prefill?.countryCode} />
            </>
          )}
          <Text style={type.h3}>Dates</Text>
          <DateRangePicker start={start} end={end} onApply={(s, e) => { setStart(s); setEnd(e); }} />
          {nameField}
          <Text style={type.h3}>Staying at</Text>
          <PlacePicker value={base} onPick={setBase} near={place} countryCode={place?.countryCode} kind="lodging" placeholder={city ? `Hotel, rental or address in ${city} (optional)` : 'Hotel, rental or address (optional — city centre if empty)'} />
          {base ? <Wrap>{(['hotel', 'rental', 'friends', 'other'] as const).map((k) => <Chip key={k} label={k} selected={baseKind === k} onPress={() => setBaseKind(k)} />)}</Wrap> : null}
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={type.body}>We'll have a car</Text>
            <Switch value={hasCar} onValueChange={setHasCar} />
          </Row>
          <Row>
            <Text style={[type.small, { flex: 1 }]}>Days usually run from</Text>
            <TextInput value={dayStart} onChangeText={setDayStart} style={[styles.input, { width: 80 }]} />
            <Text style={type.small}>to</Text>
            <TextInput value={dayEnd} onChangeText={setDayEnd} style={[styles.input, { width: 80 }]} />
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={type.body}>Start from our atlas</Text>
              <Text style={type.tiny}>Places we've been to or saved in this city go straight onto the shortlist.</Text>
            </View>
            <Switch value={seed} onValueChange={setSeed} />
          </Row>
        </>
      ) : (
        <>
          <Text style={type.h3}>From</Text>
          <PlacePicker value={from} onPick={setFrom} extra={home ? [home] : []} />
          <Text style={type.h3}>To (optional)</Text>
          <PlacePicker value={to} onPick={setTo} near={from} />
          <Text style={type.h3}>When</Text>
          <DateRangePicker start={start} end={start} single onApply={(s) => setStart(s)} />
          <Row>
            <Text style={[type.small, { flex: 1 }]}>Out from</Text>
            <TextInput value={oStart} onChangeText={setOStart} style={[styles.input, { width: 80 }]} />
            <Text style={type.small}>to</Text>
            <TextInput value={oEnd} onChangeText={setOEnd} style={[styles.input, { width: 80 }]} />
          </Row>
          <Segmented value={mode} options={[{ value: 'walking', label: 'Walk' }, { value: 'cycling', label: 'Cycle' }, { value: 'driving', label: 'Drive' }, { value: 'transit', label: 'Transit' }]} onChange={setMode} />
          {nameField}
        </>
      )}

      <Text style={type.small}>Usual pace for this trip</Text>
      <Segmented value={intensity} options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'packed', label: 'Packed' }]} onChange={setIntensity} />
      <Text style={type.small}>Who's coming</Text>
      <FaceRow members={household.members} attending={attending} onToggle={(id) => setAttending((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <Button label={kind === 'trip' ? 'Create trip' : 'Create day out'} onPress={submit} loading={busy} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trip page
// ---------------------------------------------------------------------------

type Section = 'overview' | 'days' | 'shortlist' | 'stay' | 'map';

function TripPage({ id, household, onBack, refreshHousehold, wide }: { id: string; household: HouseholdResponse | null; onBack: () => Promise<void>; refreshHousehold: () => Promise<void>; wide: boolean }) {
  const [d, setD] = useState<TripDetail | null>(null);
  const [section, setSection] = useState<Section>('days');
  const [dayId, setDayId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { const t = await api.trip(id); setD(t); setDayId((cur) => cur ?? t.days[0]?.id ?? null); } catch (e: any) { setError(e.message); } }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <ScrollView contentContainerStyle={styles.page}><Button label="← Trips" kind="ghost" onPress={onBack} style={{ alignSelf: 'flex-start' }} />{error ? <StatusLine tone="warn">{error}</StatusLine> : <Text style={type.small}>Loading…</Text>}</ScrollView>;
  const { trip, days, shortlist, attendees } = d;
  const isTrip = trip.kind === 'trip';
  const day = days.find((x) => x.id === dayId) ?? days[0];

  const pins: MapPin[] = [];
  if (trip.base) pins.push({ id: 'base', lat: trip.base.lat, lng: trip.base.lng, label: `Staying: ${trip.base.label}`, tone: 'base' });
  days.forEach((dd, i) => dd.slots.forEach((s) => s.stops.forEach((st) => { if (st.lat != null && st.lng != null) pins.push({ id: st.id, lat: st.lat, lng: st.lng, label: `${fmtDate(dd.date)} · ${st.name}`, tone: 'day', dayIndex: i }); })));
  shortlist.filter((s) => !s.scheduled && s.lat != null).forEach((s) => pins.push({ id: s.id, lat: s.lat!, lng: s.lng!, label: `Shortlist: ${s.name}`, tone: 'shortlist' }));

  const header = (
    <View style={{ gap: 4 }}>
      <Button label="← Trips" kind="ghost" onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <Text style={type.title}>{trip.title ?? trip.place?.label ?? trip.origin.label}</Text>
      <Text style={type.small}>
        {isTrip ? fmtRange(trip.startDate, trip.endDate) : `${fmtDate(trip.departAt)} · ${clock(trip.departAt)}–${clock(trip.returnAt)}`}
        {trip.locality ? ` · ${trip.locality}${trip.country ? `, ${trip.country}` : ''}` : ''}
        {isTrip ? ` · ${trip.hasCar ? 'with a car' : 'no car'}` : ` · ${trip.travelMode}`}
      </Text>
      <Text style={type.small}>{trip.base ? `Staying at ${trip.base.label}` : ''}{attendees.length ? ` · with ${attendees.map((a) => a.name).join(', ')}` : ''}</Text>
    </View>
  );

  const sections: { value: Section; label: string }[] = [
    { value: 'overview', label: 'Overview' }, { value: 'days', label: isTrip ? `Days (${days.length})` : 'The day' },
    { value: 'shortlist', label: `Shortlist (${shortlist.length})` }, { value: 'stay', label: 'Stay' }, { value: 'map', label: 'Map' },
  ];

  const body = (
    <>
      {section === 'overview' ? <Overview d={d} onGo={(s, did) => { setSection(s); if (did) setDayId(did); }} pins={pins} /> : null}
      {section === 'days' ? (
        <View style={{ gap: spacing.md }}>
          {isTrip ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
              {days.map((dd, i) => {
                const n = dd.slots.reduce((a, s) => a + s.stops.length, 0);
                const on = dd.id === day?.id;
                return (
                  <Pressable key={dd.id} onPress={() => setDayId(dd.id)} style={[styles.dayChip, on && { borderColor: memberColors[i % memberColors.length], backgroundColor: colors.surface }]}>
                    <Text style={[type.tiny, { color: memberColors[i % memberColors.length], fontWeight: '700' }]}>DAY {i + 1}</Text>
                    <Text style={type.h3}>{fmtDate(dd.date)}</Text>
                    <Text style={type.tiny}>{n ? `${n} stop${n === 1 ? '' : 's'} · ${dd.intensity}` : 'nothing yet'}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}
          {day && household ? <DayPlanner trip={d} day={day} household={household} onChanged={async () => { await load(); await refreshHousehold(); }} /> : null}
        </View>
      ) : null}
      {section === 'shortlist' ? <ShortlistPanel d={d} onChanged={load} /> : null}
      {section === 'stay' ? <StayPanel d={d} onChanged={load} onFindNear={() => setSection('shortlist')} /> : null}
      {section === 'map' ? <Card><MapView pins={pins} height={wide ? 560 : 380} /><Text style={type.tiny}>Black: where you're staying · colours: each day's stops · purple: shortlist not yet placed</Text></Card> : null}
    </>
  );

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {header}
      <Segmented value={section} options={sections} onChange={setSection} />
      {wide && section !== 'map' ? (
        <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
          <View style={{ flex: 1, minWidth: 0 }}>{body}</View>
          <View style={{ width: 380 }}>
            <Card style={{ padding: spacing.sm }}>
              <MapView pins={section === 'days' && day ? pins.filter((p) => p.tone !== 'day' || (day.slots.some((s) => s.stops.some((st) => st.id === p.id)))) : pins} height={460} />
              <Text style={type.tiny}>{section === 'days' ? 'This day' : 'Whole trip'} · black = base · purple = shortlist</Text>
            </Card>
          </View>
        </View>
      ) : body}
    </ScrollView>
  );
}

function Overview({ d, onGo, pins }: { d: TripDetail; onGo: (s: Section, dayId?: string) => void; pins: MapPin[] }) {
  const { trip, days, shortlist } = d;
  const planned = days.reduce((a, dd) => a + dd.slots.reduce((b, s) => b + s.stops.length, 0), 0);
  const food = shortlist.filter((s) => s.kind === 'food').length;
  const act = shortlist.filter((s) => s.kind === 'activity').length;
  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.statRow}>
        <Pressable onPress={() => onGo('days')} style={styles.stat}><Text style={type.h2}>{days.length}</Text><Text style={type.tiny}>day{days.length === 1 ? '' : 's'}</Text></Pressable>
        <Pressable onPress={() => onGo('days')} style={styles.stat}><Text style={type.h2}>{planned}</Text><Text style={type.tiny}>planned stops</Text></Pressable>
        <Pressable onPress={() => onGo('shortlist')} style={styles.stat}><Text style={type.h2}>{food}</Text><Text style={type.tiny}>restaurants shortlisted</Text></Pressable>
        <Pressable onPress={() => onGo('shortlist')} style={styles.stat}><Text style={type.h2}>{act}</Text><Text style={type.tiny}>things to do shortlisted</Text></Pressable>
      </View>
      {days.map((dd, i) => {
        const n = dd.slots.reduce((a, s) => a + s.stops.length, 0);
        return (
          <Pressable key={dd.id} onPress={() => onGo('days', dd.id)}>
            <Card style={{ gap: 4, borderLeftWidth: 4, borderLeftColor: memberColors[i % memberColors.length] }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={type.h3}>Day {i + 1} · {fmtDate(dd.date)}</Text>
                <Text style={type.tiny}>{dd.intensity} · {dd.travelMode}</Text>
              </Row>
              <Text style={type.small}>{n ? dd.slots.flatMap((s) => s.stops.map((st) => st.name)).join(' → ') : 'Nothing planned yet — tap to plan.'}</Text>
            </Card>
          </Pressable>
        );
      })}
      <Card><MapView pins={pins} height={260} /></Card>
      {trip.notes ? <Card><Text style={type.small}>{trip.notes}</Text></Card> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Day planner
// ---------------------------------------------------------------------------

function DayPlanner({ trip, day, household, onChanged }: { trip: TripDetail; day: TripDay; household: HouseholdResponse; onChanged: () => Promise<void> }) {
  const [planning, setPlanning] = useState(false);
  const [resumed, setResumed] = useState<PlanResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // A day already being planned comes back exactly as it was left: options,
  // kept places, chain and price choices — leaving the tab loses nothing.
  useEffect(() => {
    let live = true;
    setResumed(undefined); setPlanning(false);
    api.planLatestForDay(trip.trip.id, day.id).then((p) => { if (!live) return; if (p.sessionId) { setResumed(p); setPlanning(true); } else setResumed(null); }).catch(() => { if (live) setResumed(null); });
    return () => { live = false; };
  }, [trip.trip.id, day.id]);
  const unscheduled = trip.shortlist.filter((s) => !s.scheduled);
  const allStops = day.slots.flatMap((s) => s.stops);
  const call = async (fn: () => Promise<any>) => { setError(null); try { await fn(); await onChanged(); } catch (e: any) { setError(e.message); } };

  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={type.h2}>{fmtDate(day.date)}</Text>
          <Text style={type.small}>{clock(day.startTime)} – {clock(day.endTime)}</Text>
        </Row>
        <Row>
          <View style={{ flex: 1 }}>
            <Text style={type.tiny}>Pace today</Text>
            <Segmented value={day.intensity} options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'packed', label: 'Packed' }]} onChange={(v) => call(() => api.updateDay(trip.trip.id, day.id, { intensity: v }))} />
          </View>
        </Row>
        <Text style={type.tiny}>Getting around today</Text>
        <Segmented value={day.travelMode} options={[{ value: 'walking', label: 'Walk' }, { value: 'transit', label: 'Transit' }, { value: 'driving', label: 'Drive' }, { value: 'cycling', label: 'Cycle' }]} onChange={(v) => call(() => api.updateDay(trip.trip.id, day.id, { travelMode: v }))} />
        <TimeBar budget={day.budget} stops={allStops.map((s) => ({ id: s.id, name: s.name, dwellMinutes: s.dwellMinutes }))} departAt={day.startTime} returnAt={day.endTime} />
        <Row>
          <Button label={planning ? 'Hide planner' : resumed ? 'Back to the options' : allStops.length ? 'Re-plan this day with Roam' : 'Plan this day with Roam'} onPress={() => setPlanning((p) => !p)} />
          {planning && resumed ? <Button label="Start again" kind="ghost" onPress={() => { setResumed(null); setPlanning(true); }} /> : null}
        </Row>
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      </Card>

      {planning && resumed !== undefined ? <DayPlanPanel key={resumed ? resumed.sessionId : 'fresh'} trip={trip} day={day} initial={resumed ?? null} onCommitted={async () => { setPlanning(false); await onChanged(); }} onShortlisted={onChanged} /> : null}

      {day.slots.map((slot) => (
        <Card key={slot.slot} style={{ gap: spacing.sm }}>
          <Text style={type.h3}>{SLOT_LABEL[slot.slot]}</Text>
          {slot.stops.length === 0 ? <Text style={type.tiny}>Nothing here yet.</Text> : null}
          {slot.stops.map((stop, i) => (
            <StopRow key={stop.id} stop={stop} leg={day.budget.legs[allStops.findIndex((s) => s.id === stop.id)]} trip={trip} day={day} household={household} onChanged={onChanged} />
          ))}
        </Card>
      ))}

      <Card style={{ backgroundColor: colors.surfaceMuted }}>
        <Text style={type.h3}>Unscheduled ({unscheduled.length})</Text>
        <Text style={type.tiny}>From the shortlist. Drop one into a part of the day.</Text>
        {unscheduled.length === 0 ? <Text style={type.small}>Everything on the shortlist is placed. Add more in Shortlist.</Text> : null}
        {unscheduled.map((s) => (
          <View key={s.id} style={styles.unscheduled}>
            <View style={{ flex: 1 }}>
              <Text style={type.h3}>{s.mustDo ? '★ ' : ''}{CATEGORY_ICON[s.category ?? ''] ?? ''} {s.name}</Text>
              <Text style={type.tiny}>{s.kind}{s.note ? ` · ${s.note}` : ''}</Text>
            </View>
            <Wrap>
              {(['morning', 'afternoon', 'evening'] as const).map((sl) => <Chip key={sl} label={SLOT_LABEL[sl]} onPress={() => call(() => api.addDayStop(trip.trip.id, day.id, { shortlistId: s.id, slot: sl }))} />)}
            </Wrap>
          </View>
        ))}
      </Card>
    </View>
  );
}

function StopRow({ stop, leg, trip, day, household, onChanged }: { stop: DayStop; leg?: { from: string; to: string; minutes: number }; trip: TripDetail; day: TripDay; household: HouseholdResponse; onChanged: () => Promise<void> }) {
  const [rating, setRating] = useState(false);
  const [moving, setMoving] = useState(false);
  const visit = stop.visit;
  const call = async (fn: () => Promise<any>) => { await fn(); await onChanged(); };
  return (
    <View style={styles.stop}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.h3}>{stop.startTime ? `${stop.startTime} · ` : ''}{stop.name}</Text>
        <Text style={type.small}>{leg ? `+${leg.minutes} min from ${leg.from} · ` : ''}stay {minutes(stop.dwellMinutes)}</Text>
        {visit ? <VisitSummary visit={visit} /> : null}
        {moving ? (
          <Wrap>
            {(['morning', 'afternoon', 'evening'] as const).map((sl) => <Chip key={sl} label={`→ ${SLOT_LABEL[sl]}`} onPress={() => { setMoving(false); call(() => api.updateStop(trip.trip.id, stop.id, { slot: sl })); }} />)}
            {trip.days.filter((dd) => dd.id !== day.id).map((dd) => <Chip key={dd.id} label={`→ ${fmtDate(dd.date)}`} onPress={() => { setMoving(false); call(() => api.updateStop(trip.trip.id, stop.id, { dayId: dd.id })); }} />)}
            <Chip label="− 30 min" onPress={() => call(() => api.updateStop(trip.trip.id, stop.id, { dwellMinutes: Math.max(15, stop.dwellMinutes - 30) }))} />
            <Chip label="+ 30 min" onPress={() => call(() => api.updateStop(trip.trip.id, stop.id, { dwellMinutes: stop.dwellMinutes + 30 }))} />
          </Wrap>
        ) : null}
        {rating ? (
          <VisitForm
            venue={{ venueRef: stop.venueRef, name: stop.name, category: visit?.category ?? 'attraction', lat: stop.lat ?? 0, lng: stop.lng ?? 0, experiences: [], cuisines: [] }}
            household={household}
            initial={visit ? { visitId: visit.id, date: visit.visitedOn, note: visit.note ?? '', attending: (visit.attendees as any[]).map((a) => (typeof a === 'string' ? household.members.find((m) => m.name === a)?.id ?? '' : a.id)).filter(Boolean), rows: household.members.map((m, i) => { const t = visit.takes?.find((x) => x.memberId === m.id && x.subject === 'visit'); return { memberId: m.id, name: m.name, index: i, take: t?.take ?? null, comment: t?.comment ?? '' }; }) } : undefined}
            createVia={!visit ? async (body) => { const r = await api.visitStop(trip.trip.id, stop.id, { visitedOn: body.visitedOn, note: body.note, venue: body.venue }); if (body.takes.length) await api.setTakes(r.visit.id, body.takes, body.venue); } : undefined}
            onDone={async () => { setRating(false); await onChanged(); }} onCancel={() => setRating(false)}
          />
        ) : null}
      </View>
      <View style={{ gap: 4 }}>
        {!visit ? <Button label="We went" kind="secondary" onPress={() => setRating(true)} /> : <Button label="Edit takes" kind="ghost" onPress={() => setRating(true)} />}
        <Button label={moving ? 'Done' : 'Move / time'} kind="ghost" onPress={() => setMoving((m) => !m)} />
        <Button label="Remove" kind="ghost" onPress={() => call(() => api.removeStop(trip.trip.id, stop.id))} />
      </View>
    </View>
  );
}

/**
 * The day planner (owner, 3 Sep 2026): lead with everything found near the
 * base in three lists — things to do, places to eat, what's on — with filter
 * and sort; add a place straight onto the day, or shortlist it for the trip.
 * No algorithm-named plans on top; "Let Roam fill the day" is one button.
 * Voice and typing refine the same session ("somewhere upmarket", "no chains").
 */
function DayPlanPanel({ trip, day, initial, onCommitted, onShortlisted }: { trip: TripDetail; day: TripDay; initial: PlanResponse | null; onCommitted: () => Promise<void>; onShortlisted: () => Promise<void> }) {
  const [plan, setPlan] = useState<PlanResponse | null>(initial);
  const [busy, setBusy] = useState<false | 'thinking' | 'updating'>(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [adding, setAdding] = useState<BrowseItem | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy('thinking'); setError(null);
    try { const p = await api.planDay(trip.trip.id, day.id); setPlan(p); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, [trip.trip.id, day.id]);
  useEffect(() => { if (!initial) start(); }, [start, initial]);
  const baseLabel = trip.trip.base?.label ?? trip.trip.origin.label;
  const onDay = new Set(day.slots.flatMap((sl) => sl.stops.map((st) => st.venueRef)));
  const shortlisted = new Set(trip.shortlist.map((sh) => sh.venueRef));

  const say = async (text: string, viaVoice = false) => {
    if (!plan || !text.trim()) return;
    setBusy('thinking'); setInput('');
    try { const p = await api.planRefine(plan.sessionId, text, null); setPlan(p); setReply(p.reply); if (viaVoice && p.reply) speak(p.reply); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const speech = useSpeech({ onFinal: (t) => say(t, true) });
  const act = async (a: PlanAction) => { if (!plan) return; setBusy('updating'); try { setPlan(await api.planAct(plan.sessionId, a)); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const addToDay = async (b: BrowseItem, slot: 'morning' | 'afternoon' | 'evening') => {
    setBusy('updating'); setAdding(null);
    try {
      await api.addDayStop(trip.trip.id, day.id, { venueRef: b.venueRef, name: b.name, lat: b.lat, lng: b.lng, category: b.category, dwellMinutes: b.dwellMinutes, slot, startTime: b.startsAt ? clock24(b.startsAt) : undefined });
      setJustAdded(b.name); await onCommitted();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const fillDay = async () => {
    if (!plan?.options.length) return;
    setBusy('updating');
    try { await api.planCommit(plan.sessionId, plan.options.find((o) => o.id === 'pinned')?.id ?? plan.options[0].id); await onCommitted(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Card style={{ borderColor: colors.accent, gap: spacing.md }}>
      <Text style={type.h3}>Everything Roam found near {baseLabel}</Text>
      <Text style={type.tiny}>Filter or sort, open a place for its reviews, hours and photos, then add it to {fmtDate(day.date)} or shortlist it for any day of the trip.{plan?.resumed ? ' Picked up where you left off.' : ''}</Text>
      {busy === 'thinking' ? <StatusLine>Looking around {baseLabel}…</StatusLine> : null}
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      {justAdded ? <StatusLine tone="good">{justAdded} is on the day — see the slots above.</StatusLine> : null}
      {reply ? <View style={styles.bubble}><Text style={type.body}>{reply}</Text></View> : null}

      {adding ? (
        <View style={[styles.bubble, { gap: spacing.sm }]}>
          <Text style={type.body}>Add {adding.name} to which part of the day?</Text>
          <Wrap>
            {(['morning', 'afternoon', 'evening'] as const).map((sl) => <Chip key={sl} label={SLOT_LABEL[sl]} tone="accent" onPress={() => addToDay(adding, sl)} />)}
            <Chip label="Cancel" onPress={() => setAdding(null)} />
          </Wrap>
        </View>
      ) : null}

      <Row>
        <TextInput value={speech.listening && speech.interim ? speech.interim : input} onChangeText={setInput} placeholder={speech.listening ? 'Listening…' : 'e.g. somewhere upmarket for dinner, no chains, more for Phoenix'} placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }, speech.listening && { borderColor: colors.accent }]} onSubmitEditing={() => say(input)} editable={!speech.listening} />
        {speech.supported ? <Pressable onPress={speech.toggle} style={[styles.mic, speech.listening && styles.micOn]} accessibilityLabel={speech.listening ? 'Stop' : 'Speak'}><Text style={{ fontSize: 18 }}>{speech.listening ? '■' : '🎙'}</Text></Pressable> : null}
        <Button label="Send" onPress={() => say(input)} disabled={!input.trim() || !!busy} />
      </Row>

      {plan ? (
        <>
          <PricePointControl value={plan.constraints?.pricePoint ?? 'any'} onChange={(v) => act({ type: 'set', pricePoint: v })} />
          <ChainsControl includeChains={plan.constraints?.includeChains ?? false} hidden={plan.pool?.hiddenChains ?? 0} onChange={(v) => act({ type: 'set', includeChains: v })} />
          <BrowsePool
            items={plan.browse ?? []}
            eventsSource={plan.eventsSource}
            baseLabel={baseLabel}
            pinned={onDay}
            busy={!!busy}
            addLabel="+ Add to the day"
            addedLabel="✓ On the day"
            onAdd={(b) => setAdding(b)}
            onDislike={(b) => act({ type: 'dislike', stopId: b.id })}
            shortlistedRefs={shortlisted}
            onShortlist={async (b) => { await api.addToShortlist(trip.trip.id, { venueRef: b.venueRef, venueLabel: b.name, category: b.category, lat: b.lat, lng: b.lng, venue: { name: b.name, category: b.category, cuisines: b.cuisines, experiences: b.experiences, rating: b.rating, priceLevel: b.priceLevel, lat: b.lat, lng: b.lng, photos: b.photos } as any }); await onShortlisted(); }}
          />
          <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Text style={[type.tiny, { flex: 1, minWidth: 200 }]}>Short of time? Roam can fill the day from the best matches around your must-dos and what's already on it.</Text>
            <Button label="Let Roam fill the day" kind="secondary" onPress={fillDay} disabled={!!busy || !plan.options.length} />
          </Row>
          {plan.selection?.excluded?.length ? <Text style={type.tiny}>Set aside: {plan.selection.excluded.length} place{plan.selection.excluded.length === 1 ? '' : 's'}.</Text> : null}
        </>
      ) : null}
    </Card>
  );
}

const clock24 = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---------------------------------------------------------------------------
// Shortlist
// ---------------------------------------------------------------------------

function ShortlistPanel({ d, onChanged }: { d: TripDetail; onChanged: () => Promise<void> }) {
  const { trip, shortlist, days } = d;
  const [tab, setTab] = useState<'food' | 'activity' | 'other'>('activity');
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const [radius, setRadius] = useState(2);
  const [near, setNear] = useState<Place | null>(null);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<string[] | null>(trip.sources ?? null);
  const [res, setRes] = useState<(Venue & { onShortlist: boolean })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [atlas, setAtlas] = useState<{ venueRef: string; name: string; kind: string | null; category: string | null; lat: number | null; lng: number | null; venue: any; status: string }[]>([]);

  useEffect(() => {
    if (!trip.countryCode) return;
    api.atlasPlaces({ country: trip.countryCode, city: trip.locality ?? undefined }).then((r) => setAtlas(r.places)).catch(() => null);
  }, [trip.countryCode, trip.locality]);

  const items = shortlist.filter((s) => s.kind === tab);
  const search = async () => {
    setBusy(true); setError(null);
    try { setRes((await api.shortlistSearch(trip.id, { categories: tab === 'food' ? 'food' : tab === 'activity' ? 'things' : undefined, q: q || undefined, radiusKm: radius, near: near ? `${near.lat},${near.lng}` : undefined, sources: sources ? sources.join(',') : (trip.sources ? 'default' : undefined) })).results); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const add = async (v: Venue, mustDo = false) => { await api.addToShortlist(trip.id, { venueRef: v.venueRef, venueLabel: v.name, category: v.category, lat: v.lat, lng: v.lng, venue: v, mustDo }); await onChanged(); setRes((r) => r?.map((x) => (x.venueRef === v.venueRef ? { ...x, onShortlist: true } : x)) ?? null); };
  const fromAtlas = atlas.filter((p) => !shortlist.some((s) => s.venueRef === p.venueRef) && (p.kind ?? 'other') === tab);

  return (
    <View style={{ gap: spacing.md }}>
      <Segmented value={tab} options={[{ value: 'activity', label: `Things to do (${shortlist.filter((s) => s.kind === 'activity').length})` }, { value: 'food', label: `Restaurants (${shortlist.filter((s) => s.kind === 'food').length})` }, { value: 'other', label: `Other (${shortlist.filter((s) => s.kind === 'other').length})` }]} onChange={setTab} />
      <Row>
        <Button label={searching ? 'Close search' : `+ Find ${tab === 'food' ? 'restaurants' : tab === 'activity' ? 'things to do' : 'places'} near ${near?.label ?? trip.base?.label ?? 'the centre'}`} kind={searching ? 'ghost' : 'primary'} onPress={() => setSearching((s) => !s)} />
      </Row>
      {searching ? (
        <Card>
          <Text style={type.tiny}>Near</Text>
          <PlacePicker value={near} onPick={setNear} extra={trip.base ? [{ label: trip.base.label, lat: trip.base.lat, lng: trip.base.lng }] : []} placeholder="A neighbourhood, landmark or address (default: where you're staying)" near={trip.base ? { label: trip.locality ?? trip.base.label, lat: trip.base.lat, lng: trip.base.lng, locality: trip.locality, country: trip.country, countryCode: trip.countryCode } : null} countryCode={trip.countryCode} />
          <Row>
            <TextInput value={q} onChangeText={setQ} placeholder="Name contains… (optional)" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} onSubmitEditing={search} />
            <Button label="Search" onPress={search} loading={busy} />
          </Row>
          <Wrap>{[1, 2, 5, 10].map((r) => <Chip key={r} label={`${r} km`} selected={radius === r} onPress={() => setRadius(r)} />)}</Wrap>
          <SourcePicker value={sources} onChange={setSources} title="Sources for this search" />
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
          {res ? <Text style={type.small}>{res.length} places</Text> : null}
          {res?.slice(0, 40).map((v) => <VenueRow key={v.venueRef} venue={v} action={v.onShortlist ? <Chip label="On list" tone="accent" /> : <Row><Button label="Add" kind="secondary" onPress={() => add(v)} /><Button label="★" kind="ghost" onPress={() => add(v, true)} /></Row>} />)}
        </Card>
      ) : null}

      {fromAtlas.length ? (
        <Card style={{ backgroundColor: colors.accentSoft }}>
          <Text style={type.h3}>From our atlas · {trip.locality ?? trip.country}</Text>
          <Text style={type.tiny}>Places you've been to or saved here before, not yet on this trip's list.</Text>
          {fromAtlas.map((p) => (
            <Row key={p.venueRef} style={{ justifyContent: 'space-between' }}>
              <Text style={[type.body, { flex: 1 }]}>{p.status === 'been' ? '✓ ' : p.status === 'special' ? '★ ' : ''}{p.name}</Text>
              <Button label="Add" kind="secondary" onPress={async () => { await api.addToShortlist(trip.id, { venueRef: p.venueRef, venueLabel: p.name, kind: p.kind ?? undefined, category: p.category, lat: p.lat, lng: p.lng, venue: p.venue ?? undefined }); await onChanged(); }} />
            </Row>
          ))}
        </Card>
      ) : null}

      {items.length === 0 ? <Card><Text style={type.small}>Nothing shortlisted here yet. Search above, or add from the atlas.</Text></Card> : null}
      {items.map((s) => <ShortlistRow key={s.id} item={s} trip={d} days={days} onChanged={onChanged} />)}
    </View>
  );
}

function ShortlistRow({ item, trip, days, onChanged }: { item: ShortlistItem; trip: TripDetail; days: TripDay[]; onChanged: () => Promise<void> }) {
  const [placing, setPlacing] = useState<string | null>(null);
  const [note, setNote] = useState(item.note ?? '');
  const [editingNote, setEditingNote] = useState(false);
  return (
    <Card style={{ gap: 6 }}>
      <Row>
        <Pressable onPress={async () => { await api.updateShortlist(trip.trip.id, item.id, { mustDo: !item.mustDo }); await onChanged(); }} style={styles.star} accessibilityLabel={item.mustDo ? 'Must do' : 'Mark must do'}>
          <Text style={{ fontSize: 20, color: item.mustDo ? '#B0771E' : colors.inkFaint }}>{item.mustDo ? '★' : '☆'}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={type.h3}>{CATEGORY_ICON[item.category ?? ''] ?? ''} {item.name}</Text>
          <Text style={type.tiny}>{[item.category, ...((item.venue?.experiences as string[]) ?? []), ...((item.venue?.cuisines as string[]) ?? [])].filter(Boolean).join(' · ')}{item.scheduled ? ' · on the plan' : ''}</Text>
        </View>
        <Button label="Remove" kind="ghost" onPress={async () => { await api.removeFromShortlist(trip.trip.id, item.id); await onChanged(); }} />
      </Row>
      {editingNote ? (
        <Row><TextInput value={note} onChangeText={setNote} placeholder="A note — why this place" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} /><Button label="Save" kind="secondary" onPress={async () => { await api.updateShortlist(trip.trip.id, item.id, { note }); setEditingNote(false); await onChanged(); }} /></Row>
      ) : <Pressable onPress={() => setEditingNote(true)}><Text style={type.small}>{item.note ? `“${item.note}”` : 'Add a note…'}</Text></Pressable>}
      {!item.scheduled ? (
        <Wrap>
          {!placing ? days.map((dd, i) => <Chip key={dd.id} label={`Day ${i + 1}`} onPress={() => setPlacing(dd.id)} />) : (
            <>
              {(['morning', 'afternoon', 'evening'] as const).map((sl) => <Chip key={sl} label={SLOT_LABEL[sl]} tone="accent" onPress={async () => { await api.addDayStop(trip.trip.id, placing, { shortlistId: item.id, slot: sl }); setPlacing(null); await onChanged(); }} />)}
              <Chip label="cancel" onPress={() => setPlacing(null)} />
            </>
          )}
        </Wrap>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Stay
// ---------------------------------------------------------------------------

function StayPanel({ d, onChanged, onFindNear }: { d: TripDetail; onChanged: () => Promise<void>; onFindNear: () => void }) {
  const { trip } = d;
  const [checkIn, setCheckIn] = useState(trip.base?.checkIn ?? '');
  const [checkOut, setCheckOut] = useState(trip.base?.checkOut ?? '');
  const [hasCar, setHasCar] = useState(!!trip.hasCar);
  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <Text style={type.h3}>Where we're staying</Text>
        <PlacePicker value={trip.base ? { label: trip.base.label, lat: trip.base.lat, lng: trip.base.lng, formatted: trip.base.label } : null} onPick={async (p) => { if (p) { await api.updateTripV2(trip.id, { base: p, baseKind: 'hotel' }); await onChanged(); } }} placeholder={trip.locality ? `Hotel, rental or address in ${trip.locality}` : 'Hotel, rental or address'} kind="lodging" near={trip.base ? { label: trip.locality ?? trip.base.label, lat: trip.base.lat, lng: trip.base.lng, locality: trip.locality, country: trip.country, countryCode: trip.countryCode } : null} countryCode={trip.countryCode} />
        {trip.base ? (
          <Row>
            <TextInput value={checkIn} onChangeText={setCheckIn} placeholder="Check-in 15:00" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
            <TextInput value={checkOut} onChangeText={setCheckOut} placeholder="Check-out 11:00" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
            <Button label="Save" kind="secondary" onPress={async () => { await api.updateTripV2(trip.id, { checkIn, checkOut }); await onChanged(); }} />
          </Row>
        ) : null}
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={type.body}>We'll have a car</Text>
          <Switch value={hasCar} onValueChange={async (v) => { setHasCar(v); await api.updateTripV2(trip.id, { hasCar: v, travelMode: v ? 'driving' : 'transit' }); await onChanged(); }} />
        </Row>
        <SourcePicker value={trip.sources ?? null} onChange={async (v) => { await api.updateTripV2(trip.id, { sources: v }); await onChanged(); }} title="Sources for this trip's searches and plans" />
        <TripSpendLine tripId={trip.id} refreshKey={trip} />
        <Button label="Find restaurants and things near here" kind="secondary" onPress={onFindNear} />
      </Card>
      {trip.base ? <Card><MapView pins={[{ id: 'base', lat: trip.base.lat, lng: trip.base.lng, label: trip.base.label, tone: 'base' }]} height={260} /></Card> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 1180, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  split: { gap: spacing.md },
  input: { minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink },
  prefix: { minHeight: TARGET, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  statRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  stat: { flex: 1, minWidth: 120, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, alignItems: 'center' },
  dayChip: { padding: spacing.md, borderRadius: radius.md, borderWidth: 2, borderColor: colors.line, backgroundColor: colors.surfaceMuted, minWidth: 140 },
  stop: { flexDirection: 'row', gap: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  unscheduled: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  bubble: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  mic: { width: TARGET, height: TARGET, borderRadius: TARGET / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.line },
  micOn: { backgroundColor: colors.overrunSoft, borderColor: colors.overrun },
  option: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 2, borderColor: colors.line, backgroundColor: colors.surface },
  optStop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.line },
  react: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  reactText: { fontSize: 16, fontWeight: '700', color: colors.ink },
  star: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
});

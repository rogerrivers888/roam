import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { GroupPanel } from '../components/GroupPanel';
import { api, BrowseItem, HouseholdResponse, Place, PlanAction, PlanResponse, ShortlistItem, Stay, StayPricing, TripDay, TripDetail, TripPlace, TripSummary, Venue, DayStop } from '../api';
import { colors, fonts, memberColors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, FoldLine, Row, Segmented, StatusLine, Stepper, Wrap, clock, minutes } from '../components/ui';
import { SourcePicker, TripSpendLine } from '../components/SourcePicker';
import { TimeBar } from '../components/TimeBar';
import { Avatar, WhoLine } from '../components/Faces';
import { PlacePicker } from '../components/PlacePicker';
import { DateRangePicker, monthSpanLabel } from '../components/DateRangePicker';
import { TimeRangePicker, timeLabel } from '../components/TimePicker';
import { PricePointControl, ChainsControl } from '../components/PlanControls';
import { MapView, MapPin } from '../components/MapView';
import { VenueRow, VisitForm, VisitSummary } from './PlacesScreen';
import { VenueThumb } from '../components/VenueThumb';
import { PickSheet } from '../components/PickSheet';
import { TripCard } from '../components/TripCard';
import { speak as speakRaw, useSpeech } from '../hooks/useSpeech';
import { Listening } from '../components/Listening';
import { CategoryIcon, Icon, IconName, Rating, Stars } from '../components/Icon';
import { ShortlistJourney, TripJourneyDay } from '../components/Journey';
import { BrowseNear, FindCat, FindState, emptyFind } from '../components/BrowseNear';
import { getSpeakPref } from './SettingsScreen';
import { SourceDataPanel } from '../components/SourceData';
import { isAdmin } from '../admin';
import { recallScreen, rememberScreen } from '../screenState';
import { asOneOf, asText, useQueryState, useRouter } from '../router';
import { paths, TRIP_TABS, type Route, type TripSection } from '../routes';
import { accuracyWords, useHere } from '../hooks/useHere';

const speak = (t: string) => { if (getSpeakPref()) speakRaw(t); };
const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtRange = (a?: string | null, b?: string | null) => (a && b ? (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`) : '');
const SLOT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' } as const;

/**
 * What a new trip is being made *from*, when somebody arrived here by tapping
 * "Create trip" or "Plan a trip here" somewhere else.
 *
 * This is the one thing that is deliberately not in the address. `/trips/new`
 * is the form; a half-filled form is not a page, and the place and country do
 * travel in the query because those are the question rather than the answer.
 */
export type TripSeed = {
  placeText?: string; place?: Place; countryCode?: string;
  /** Which of the three shapes the form should open on. */
  kind?: 'trip' | 'outing' | 'now';
  /**
   * The place the trip is *for* — the one somebody tapped "Create trip" on.
   * It goes on the new trip's shortlist as a must-do the moment the trip
   * exists, so the day is built around it rather than merely near it.
   */
  seed?: { venueRef: string; name: string; category?: string | null; lat?: number | null; lng?: number | null; note?: string };
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** Inside a trip: which of Find / Shortlist / The day you were on, per trip. */
type TripPageMemory = { section: Section };

export function TripsScreen({ route, household, refreshHousehold, seed, onSeedUsed }: {
  /** Which layer the address asks for: the list, the new-trip form, or one trip on one of its tabs. */
  route: Extract<Route, { name: 'trips' }>;
  household: HouseholdResponse | null; refreshHousehold: () => Promise<void>;
  seed?: TripSeed | null; onSeedUsed?: () => void;
}) {
  const { width } = useViewport();
  const wide = width >= 1000;
  const { navigate, back, setQuery } = useRouter();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.trips>> | null>(null);
  const creating = route.creating;
  const openId = route.tripId;
  /**
   * How the list is set (handover, 5 Sep 2026, screen 2a): "Day trips /
   * Holidays segmented. Filters: area (All areas · UK · Abroad), when (defaults
   * Upcoming), who." All of it is query, because it is how the page is set and
   * not which page it is (CLAUDE.md).
   *
   * Where is drawn under Past only (owner, 5 Sep 2026) — see `byArea` below.
   */
  const [span, setSpan] = useQueryState<'day' | 'holiday'>('span', 'day', asOneOf(['day', 'holiday'] as const, 'day'));
  // Read here, written by `setWhen` below, which moves Where with it.
  const [when] = useQueryState<'upcoming' | 'past'>('when', 'upcoming', asOneOf(['upcoming', 'past'] as const, 'upcoming'));
  const [area, setArea] = useQueryState<string | null>('area', null, asText);
  const [who, setWho] = useQueryState<string | null>('who', null, asText);
  const [sheet, setSheet] = useState<'area' | 'when' | 'who' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * When and Where move together, in one address rather than two navigations
   * racing each other: coming back to Upcoming takes the country with it,
   * because the chip that set it is not drawn there and a filter nobody can
   * see is a filter nobody can undo.
   */
  const setWhen = (next: 'upcoming' | 'past') =>
    setQuery({ when: next === 'upcoming' ? null : next, ...(next === 'upcoming' ? { area: null } : {}) });

  // Which trip the address has open, for the loader — as a ref, so opening one
  // does not count as a reason to go and fetch the list again.
  const openNow = useRef(openId);
  openNow.current = openId;
  const load = useCallback(async () => {
    try {
      const next = await api.trips();
      setData(next);
      // A trip deleted since you last looked should not reopen as an error page.
      if (openNow.current && !next.trips.some((t) => t.id === openNow.current)) navigate(paths.trips(), { replace: true });
    } catch (e: any) { setError(e.message); }
  }, [navigate]);
  useEffect(() => { load(); }, [load]);

  if (openId) {
    return (
      <TripPage
        key={openId}
        id={openId}
        section={route.section}
        dayId={route.dayId}
        household={household}
        onBack={async () => { back(paths.trips()); await load(); }}
        refreshHousehold={refreshHousehold}
        wide={wide}
      />
    );
  }

  const all = data?.trips ?? [];
  const homeCode = data?.countries?.[0]?.code ?? null;
  const startOf = (t: TripSummary) => new Date(t.startDate ? `${t.startDate}T12:00:00` : t.departAt);

  /** A night away is a holiday; everything else is a day out, whatever it calls itself. */
  const inSpan = (t: TripSummary) => (span === 'holiday' ? t.nights > 0 : t.nights === 0);
  const inArea = (t: TripSummary) => {
    if (!area) return true;
    if (area === 'uk') return t.countryCode === homeCode;
    if (area === 'abroad') return !!t.countryCode && t.countryCode !== homeCode;
    return t.countryCode === area;
  };
  const inWho = (t: TripSummary) => !who || t.attendees.some((a) => a.id === who);
  /**
   * Where is a question about the past only (owner, 5 Sep 2026: "the country
   * (UK or abroad) only needs to appear when you're looking in the past.
   * Otherwise, you can just show all the upcoming trips").
   *
   * He is right about what the chip is for. Everything ahead of you is a short
   * list you want to see whole — narrowing it by continent is filing, not
   * finding — whereas "my trips to Italy" is a question about years of them.
   * So the chip is drawn under Past and nowhere else, and it does not filter
   * when it is not on screen: a filter you cannot see is one you cannot undo.
   */
  const byArea = when === 'past';
  const shown = all.filter((t) => inSpan(t) && (!byArea || inArea(t)) && inWho(t) && (byArea ? t.isPast : !t.isPast));
  const pastCount = all.filter((t) => inSpan(t) && inWho(t) && t.isPast).length;

  /**
   * Upcoming is grouped by month and past by year (handover 2a/2b): what is
   * coming needs "which weekend"; what is gone needs "which year we did that".
   */
  const groups = (() => {
    const now = new Date();
    const key = (t: TripSummary) => {
      const d = startOf(t);
      if (when === 'past') return String(d.getFullYear());
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
        ? 'This month'
        : d.toLocaleDateString([], { month: 'long', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
    };
    const asc = (a: TripSummary, b: TripSummary) => +startOf(a) - +startOf(b);
    const sorted = [...shown].sort(when === 'past' ? (a, b) => asc(b, a) : asc);
    const out: { label: string; trips: TripSummary[] }[] = [];
    for (const t of sorted) {
      const k = key(t);
      const g = out.find((x) => x.label === k) ?? (out.push({ label: k, trips: [] }), out[out.length - 1]);
      g.trips.push(t);
    }
    return out;
  })();

  const countries = data?.countries ?? [];
  // Counted over the past, because that is the only place the chip is drawn.
  const behind = all.filter((t) => inSpan(t) && t.isPast);
  const areaOptions = [
    { value: '', label: 'All areas', count: behind.length },
    ...(homeCode ? [{ value: 'uk', label: countries.find((c) => c.code === homeCode)?.name ?? 'Home', count: behind.filter((t) => t.countryCode === homeCode).length }] : []),
    { value: 'abroad', label: 'Abroad', count: behind.filter((t) => !!t.countryCode && t.countryCode !== homeCode).length },
    ...countries.filter((c) => c.code !== homeCode && behind.some((t) => t.countryCode === c.code))
      .map((c) => ({ value: c.code, label: c.name, count: behind.filter((t) => t.countryCode === c.code).length })),
  ];
  const whenOptions = [
    { value: 'upcoming', label: 'Upcoming', count: all.filter((t) => inSpan(t) && !t.isPast).length },
    { value: 'past', label: 'Past', count: all.filter((t) => inSpan(t) && t.isPast).length },
  ];
  const whoOptions = [{ value: '', label: 'Anyone' }, ...(household?.members ?? []).map((m) => ({ value: m.id, label: m.name }))];
  const areaLabel = areaOptions.find((o) => o.value === (area ?? ''))?.label ?? 'All areas';
  const whoLabel = whoOptions.find((o) => o.value === (who ?? ''))?.label ?? 'Anyone';

  return (
    <ScrollView contentContainerStyle={[styles.page, wide && { maxWidth: 860, alignSelf: 'center', width: '100%' }]} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={type.title}>{creating ? 'New trip' : 'Trips'}</Text>
          {creating ? <Text style={type.small}>Where, when, and who — everything else can wait until it exists.</Text> : null}
        </View>
        <Pressable
          onPress={() => { onSeedUsed?.(); navigate(creating ? paths.trips() : paths.newTrip()); }}
          style={[styles.roundBtn, !creating && styles.roundBtnInk]}
          accessibilityRole="button"
          accessibilityLabel={creating ? 'Close' : 'New trip'}
        >
          <Icon name={creating ? 'close' : 'add'} size={20} color={creating ? colors.ink : colors.primaryFg} strokeWidth={2.2} />
        </Pressable>
      </View>

      {/* A new trip is its own page: the trips you already have are not part of
          making one (owner, 4 Sep 2026). */}
      {creating && household ? (
        <>
          <NewTripForm
            household={household}
            startFrom={seed ?? null}
            onCreated={async (t) => {
              // A trip made from a place opens with that place already on it.
              // Failing to seed is not a reason to lose the trip they just
              // made, so it is tried and the trip opens either way.
              const must = seed?.seed;
              if (must) {
                try {
                  await api.addToShortlist(t.trip.id, {
                    venueRef: must.venueRef, venueLabel: must.name, category: must.category ?? null,
                    lat: must.lat ?? null, lng: must.lng ?? null, mustDo: true,
                    note: must.note ?? 'The reason for the trip',
                  });
                } catch { /* the trip is made; the shortlist can be added to by hand */ }
              }
              onSeedUsed?.(); await load(); navigate(paths.trip(t.trip.id), { replace: true });
            }}
          />
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
        </>
      ) : (
        <>
          <Segmented
            value={span}
            options={[{ value: 'day' as const, label: 'Day trips' }, { value: 'holiday' as const, label: 'Holidays' }]}
            onChange={setSpan}
          />
          <View style={styles.filters}>
            <FilterChip label={when === 'past' ? 'Past' : 'Upcoming'} on={when === 'past'} onPress={() => setSheet('when')} />
            {byArea ? <FilterChip label={areaLabel} on={!!area} onPress={() => setSheet('area')} /> : null}
            <FilterChip label={whoLabel} on={!!who} onPress={() => setSheet('who')} />
          </View>

          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
          {!data ? <Text style={type.small}>Loading…</Text> : null}
          {data && !all.length ? <Card><Text style={type.small}>No trips yet. Tap + above, or open an area in Places and tap "Plan a trip here".</Text></Card> : null}
          {data && all.length && !shown.length ? (
            <Card><Text style={type.small}>Nothing {when === 'past' ? 'behind you' : 'coming up'} that matches. Change a filter, or look at {span === 'day' ? 'Holidays' : 'Day trips'}.</Text></Card>
          ) : null}

          {groups.map((g) => (
            <View key={g.label} style={{ gap: spacing.sm }}>
              <Text style={type.label}>{g.label}</Text>
              {g.trips.map((t) => <TripCard key={t.id} trip={t} members={household?.members ?? []} onPress={() => navigate(paths.trip(t.id))} />)}
            </View>
          ))}

          {/* Past is a filter, not a fold: the link sets the When chip. */}
          {when === 'upcoming' && pastCount ? (
            <Pressable onPress={() => setWhen('past')} accessibilityRole="button" style={{ paddingVertical: spacing.sm }}>
              <Row style={{ gap: 4 }}>
                <Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>Past trips · {pastCount}</Text>
                <Icon name="forward" size={14} color={colors.accent} />
              </Row>
            </Pressable>
          ) : null}
          {when === 'past' ? (
            <Pressable onPress={() => setWhen('upcoming')} accessibilityRole="button" style={{ paddingVertical: spacing.sm }}>
              <Row style={{ gap: 4 }}>
                <Icon name="back" size={14} color={colors.accent} />
                <Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>What's coming up</Text>
              </Row>
            </Pressable>
          ) : null}

          <PickSheet visible={sheet === 'area'} title="Where" options={areaOptions} value={area ?? ''} onPick={(v) => { setArea(v || null); setSheet(null); }} onClose={() => setSheet(null)} />
          <PickSheet visible={sheet === 'when'} title="When" options={whenOptions} value={when} onPick={(v) => { setWhen(v as any); setSheet(null); }} onClose={() => setSheet(null)} />
          <PickSheet visible={sheet === 'who'} title="Who's coming" options={whoOptions} value={who ?? ''} onPick={(v) => { setWho(v || null); setSheet(null); }} onClose={() => setSheet(null)} />
        </>
      )}
    </ScrollView>
  );
}


/** A dropdown, as a chip that opens a sheet. Same control as Places. */
function FilterChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.fchip, on && styles.fchipOn]} accessibilityRole="button">
      <Text style={[styles.fchipText, on && { color: colors.primaryFg }]} numberOfLines={1}>{label}</Text>
      <Icon name="expand" size={13} color={on ? colors.primaryFg : colors.ink} />
    </Pressable>
  );
}


// ---------------------------------------------------------------------------
// New trip
// ---------------------------------------------------------------------------

/** Trip away, day out from home, or out already. */
type TripKind = 'trip' | 'outing' | 'now';

/** The clock, down to the last five minutes: a window that starts "now" starts now. */
const roundedNow = () => {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** Four hours later, on the half hour, and never past the end of the day. */
const hoursAfter = (hhmm: string, hours: number) => {
  const [h, m] = hhmm.split(':').map(Number);
  const mins = Math.min(23 * 60 + 30, Math.ceil((h * 60 + m + hours * 60) / 30) * 30);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

const KIND_HINT: Record<TripKind, string> = {
  trip: 'Somewhere else, with dates and somewhere to stay.',
  outing: 'A day out from home, planned by the hour.',
  now: "You're out already — this starts where you're standing, from now.",
};

/**
 * Where you are, asked of the device only when the button is pressed (owner,
 * 4 Sep 2026). Typing it is always there underneath: a browser set to keep
 * location private, a phone that cannot see the sky, or simply a household that
 * would rather say it must all end up in the same place.
 */
function StartHere({ value, onPick }: { value: Place | null; onPick: (p: Place | null) => void }) {
  const me = useHere();
  const fromDevice = Boolean(value && me.place && value.lat === me.place.lat && value.lng === me.place.lng);
  return (
    <View style={{ gap: spacing.sm }}>
      {!value ? (
        <>
          {me.supported ? <Button label={me.busy ? 'Finding you…' : 'Use my location'} icon="here" onPress={async () => { const p = await me.ask(); if (p) onPick(p); }} loading={me.busy} /> : null}
          <Text style={type.tiny}>{me.supported ? "Your device says where you are and the map gives it a name. It isn't stored — it's used to search around you." : 'This browser cannot tell us where you are. Type it instead.'}</Text>
          {me.error ? <StatusLine tone="warn">{me.error}</StatusLine> : null}
        </>
      ) : null}
      <PlacePicker value={value} onPick={onPick} placeholder={me.supported ? 'Or type where you are' : 'Where you are'} />
      {fromDevice ? <Text style={type.tiny}>From your device{me.accuracyM != null ? `, ${accuracyWords(me.accuracyM)}` : ''} · © OpenStreetMap contributors</Text> : null}
    </View>
  );
}

function NewTripForm({ household, startFrom, onCreated }: { household: HouseholdResponse; startFrom: TripSeed | null; onCreated: (t: TripDetail) => Promise<void> }) {
  // What the address says about the trip being made — the question, not the
  // half-typed answer — so `/trips/new?place=Bath&kind=outing` opens the right
  // form even for somebody who was sent the link.
  const { query } = useRouter();
  const prefill: TripSeed | null = useMemo(() => {
    const kind = query.get('kind');
    const asked: TripSeed = {
      ...(startFrom ?? {}),
      kind: kind === 'trip' || kind === 'outing' || kind === 'now' ? kind : startFrom?.kind,
      placeText: startFrom?.placeText ?? query.get('place') ?? undefined,
      countryCode: startFrom?.countryCode ?? query.get('country') ?? undefined,
    };
    return Object.values(asked).some((v) => v != null) ? asked : null;
  }, [startFrom, query.get('kind'), query.get('place'), query.get('country')]);
  const home = household.household.home;
  // Three ways a trip begins (owner, 4 Sep 2026): somewhere else with dates, a
  // day out from home, or — the one that was missing — standing in the street
  // already ("in the real world, I'm out in London and I suddenly want to find
  // somewhere to go"). "Right now" is a day out whose starting point is the
  // device's own fix and whose window starts on the clock.
  const [kind, setKind] = useState<TripKind>(prefill?.kind ?? 'trip');
  const [title, setTitle] = useState('');
  // The name is filled in from where you are going and keeps up with it until
  // you type over it (owner, 4 Sep 2026: "It should just chuck in the location
  // that I'm going to, and then I can just edit that name as I see fit").
  const [named, setNamed] = useState(false);
  const [place, setPlace] = useState<Place | null>(prefill?.place ?? null);
  const [placeText, setPlaceText] = useState(prefill?.placeText ?? '');
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
  const [base, setBase] = useState<Place | null>(null);
  const [baseKind, setBaseKind] = useState<'hotel' | 'rental' | 'friends' | 'home' | 'other'>('hotel');
  // Booked already, or wanting Roam to look. Looking is the default, because a
  // trip being made is usually a trip not yet booked.
  const [stayMode, setStayMode] = useState<'known' | 'find'>('find');
  const [hasCar, setHasCar] = useState(true);
  const [dayStart, setDayStart] = useState('09:30');
  const [dayEnd, setDayEnd] = useState('21:00');
  const [intensity, setIntensity] = useState(household.household.defaultIntensity);
  const [attending, setAttending] = useState<Set<string>>(new Set(household.members.map((m) => m.id)));
  const [seed, setSeed] = useState(true);
  // outing
  const [from, setFrom] = useState<Place | null>(home);
  // A day out arriving from somewhere else already knows where it is going —
  // it is the place they tapped "Create trip" on — so the destination is
  // filled and only the times are left to answer.
  const [to, setTo] = useState<Place | null>(prefill?.kind === 'outing' ? prefill?.place ?? null : null);
  const [oStart, setOStart] = useState('10:00');
  const [oEnd, setOEnd] = useState('16:00');
  // Right now: where the device says they are, and the hours left in the day.
  const [herePlace, setHerePlace] = useState<Place | null>(null);
  const [nStart, setNStart] = useState(() => roundedNow());
  const [nEnd, setNEnd] = useState(() => hoursAfter(roundedNow(), 4));
  // A day out is a drive unless it is said not to be (owner, 4 Sep 2026:
  // "the means of transport should be defaulted to drive… walking and cycling,
  // it's just too much noise"). The other three are behind the line.
  const [mode, setMode] = useState<'walking' | 'cycling' | 'driving' | 'transit'>('driving');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shortName = (p: Place | null) => (!p ? '' : home && p.lat === home.lat && p.lng === home.lng ? 'Home' : (p.locality ?? p.label.split(',')[0].trim()));
  // Where a day out starts: home (or wherever they said) for a planned one, the
  // device's fix for one that has already started.
  const startPoint = kind === 'now' ? herePlace : from;
  // Half-typed letters are not a destination: the name fills in once somewhere
  // has been picked, not while the box still says "bat".
  const city = kind === 'trip' ? shortName(place) : shortName(to) || shortName(startPoint);
  const defaultTitle = kind === 'trip'
    ? (city ? `${city} · ${monthSpanLabel(start, end)}` : '')
    : kind === 'now'
      ? (herePlace ? `Around ${shortName(herePlace)}, ${fmtDate(start)}` : '')
      : (to ? `${shortName(from) || 'Home'} → ${shortName(to)}` : from ? `Around ${shortName(from)}` : '');
  // Where changes, so does the name — until it has been typed in.
  useEffect(() => { if (!named) setTitle(defaultTitle); }, [defaultTitle, named]);
  const savedTitle = title.trim() || defaultTitle || undefined;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (kind === 'trip') {
        if (!place && !placeText.trim()) { setError('Where is the trip? Pick a city or region.'); setBusy(false); return; }
        const t = await api.createMultiDayTrip({
          title: savedTitle ?? (placeText.trim() ? `${placeText.trim()} · ${monthSpanLabel(start, end)}` : undefined),
          place: place ?? undefined, placeText: place ? undefined : placeText.trim(), startDate: start, endDate: end,
          base: base ?? undefined, baseKind: base ? baseKind : 'other', hasCar, dayStart, dayEnd, intensity, attendingMemberIds: [...attending], seedFromAtlas: seed,
        });
        await onCreated(t);
      } else if (kind === 'now') {
        if (!herePlace) { setError('Tap "Use my location", or type where you are.'); setBusy(false); return; }
        // Now is now: the window opens at this minute rather than at the top of
        // the five it was rounded to, so nothing is already in the past.
        const now = new Date();
        const depart = new Date(`${now.toISOString().slice(0, 10)}T${nStart}:00`);
        if (depart < now) depart.setTime(now.getTime());
        const back = new Date(`${now.toISOString().slice(0, 10)}T${nEnd}:00`);
        // Late enough in the evening and "back by" has already gone: give them
        // the couple of hours they actually have rather than an error.
        if (back <= depart) back.setTime(depart.getTime() + 2 * 3600_000);
        const t = await api.createTrip({
          title: savedTitle, origin: herePlace,
          departAt: depart.toISOString(), returnAt: back.toISOString(),
          travelMode: mode, intensity, attendingMemberIds: [...attending],
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
    <View style={{ gap: 4 }}>
      <Text style={type.h3}>Name</Text>
      <TextInput
        value={title}
        onChangeText={(t) => { setNamed(true); setTitle(t); }}
        placeholder={city ? defaultTitle : 'Pick where first'}
        placeholderTextColor={colors.inkFaint}
        style={styles.input}
      />
    </View>
  );

  const toggleWho = (id: string) => setAttending((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const whoLine = <WhoLine members={household.members} attending={attending} onToggle={toggleWho} />;
  const paceLine = (
    <FoldLine label="Pace" value={{ relaxed: 'Relaxed', balanced: 'Balanced', packed: 'Packed' }[intensity]}>
      <Segmented value={intensity} options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'packed', label: 'Packed' }]} onChange={setIntensity} />
    </FoldLine>
  );

  return (
    <Card style={{ borderColor: colors.accent }}>
      <Segmented
        value={kind}
        options={[{ value: 'trip', label: 'Trip away' }, { value: 'outing', label: 'Day out' }, { value: 'now', label: 'Right now' }]}
        onChange={(k) => {
          // The clock has moved on since the form was opened: a window that
          // says "now" has to mean now, not when the page loaded.
          if (k === 'now') { const t = roundedNow(); setNStart(t); setNEnd(hoursAfter(t, 4)); }
          setKind(k);
        }}
      />
      <Text style={type.tiny}>{KIND_HINT[kind]}</Text>

      {kind === 'trip' ? (
        <>
          {/* One box, searched as the letters arrive. It asks for a city or a
              region, so the box does not say so twice (owner, 4 Sep 2026). */}
          <Text style={type.h3}>Where</Text>
          <PlacePicker value={place} onPick={(p) => { setPlace(p); if (p) setPlaceText(''); }} onText={setPlaceText} kind="area" countryCode={prefill?.countryCode} placeholder="Lisbon · Bath · the Lake District" />
          <Text style={type.h3}>Dates</Text>
          <DateRangePicker start={start} end={end} onApply={(s, e) => { setStart(s); setEnd(e); }} />
          {nameField}
          {/* Two things it can be, and the second is the one worth building for
              (owner, 4 Sep 2026: "there are only 2 options: I'm staying
              somewhere, or I need to find somewhere to stay… you should also
              have 'Find me a location'"). */}
          <Text style={type.h3}>Where you'll stay</Text>
          <Segmented
            value={stayMode}
            options={[{ value: 'known', label: "We've got somewhere" }, { value: 'find', label: 'Find us somewhere' }]}
            onChange={(v) => { setStayMode(v as 'known' | 'find'); if (v === 'find') setBase(null); }}
          />
          {stayMode === 'known' ? (
            <>
              <PlacePicker value={base} onPick={setBase} near={place} countryCode={place?.countryCode} kind="lodging" placeholder={city ? `Hotel, rental or address in ${city}` : 'Hotel, rental or address'} />
              {base ? <Wrap>{(['hotel', 'rental', 'friends', 'other'] as const).map((k) => <Chip key={k} label={k} selected={baseKind === k} onPress={() => setBaseKind(k)} />)}</Wrap> : null}
            </>
          ) : (
            <Text style={type.tiny}>
              We'll look as soon as the trip exists — and again once you've shortlisted a few things, so we can rank beds by how much of your week is on foot from the front door.
            </Text>
          )}
          {whoLine}
          {paceLine}
          <FoldLine label="Days run" value={`${timeLabel(dayStart)} – ${timeLabel(dayEnd)}${hasCar ? ' · with a car' : ' · no car'}${seed ? '' : ' · not from our atlas'}`}>
            <View style={{ gap: spacing.sm }}>
              <TimeRangePicker start={dayStart} end={dayEnd} onChange={(a, b) => { setDayStart(a); setDayEnd(b); }} labels={['Days start', 'Days end']} />
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={type.body}>We'll have a car</Text>
                <Switch value={hasCar} onValueChange={setHasCar} />
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Text style={type.body}>Start from our atlas</Text>
                  <Text style={type.tiny}>Places we've been to or saved in this city go straight onto the shortlist.</Text>
                </View>
                <Switch value={seed} onValueChange={setSeed} />
              </Row>
            </View>
          </FoldLine>
        </>
      ) : kind === 'now' ? (
        <>
          <Text style={type.h3}>Where you are</Text>
          <StartHere value={herePlace} onPick={setHerePlace} />
          <Text style={type.h3}>How long you've got</Text>
          <TimeRangePicker start={nStart} end={nEnd} onChange={(a, b) => { setNStart(a); setNEnd(b); }} labels={['From', 'Back by']} />
          {nameField}
          <FoldLine label="Getting about" value={MODE_WORD[mode]} icon={mode === 'cycling' ? 'walking' : mode}>
            <Wrap>{(['driving', 'transit', 'walking', 'cycling'] as const).map((m) => <Chip key={m} label={MODE_WORD[m]} selected={mode === m} onPress={() => setMode(m)} />)}</Wrap>
          </FoldLine>
          {whoLine}
          {paceLine}
          <Text style={type.tiny}>Next: Find looks around you, and what you keep goes on today's shortlist.</Text>
        </>
      ) : (
        <>
          <Text style={type.h3}>Where to</Text>
          <PlacePicker value={to} onPick={setTo} near={from} kind="area" placeholder="Bath · Brighton · the Cotswolds" />
          <Text style={type.h3}>When</Text>
          <DateRangePicker start={start} end={start} single onApply={(s) => setStart(s)} />
          <TimeRangePicker start={oStart} end={oEnd} onChange={(a, b) => { setOStart(a); setOEnd(b); }} labels={['Out from', 'Back by']} />
          {nameField}
          {/* Starting from home and driving unless it is said otherwise. */}
          <FoldLine label="Getting there" value={`${MODE_WORD[mode]} from ${shortName(from) || 'home'}`} icon={mode === 'cycling' ? 'walking' : mode}>
            <View style={{ gap: spacing.sm }}>
              <Wrap>{(['driving', 'transit', 'walking', 'cycling'] as const).map((m) => <Chip key={m} label={MODE_WORD[m]} selected={mode === m} onPress={() => setMode(m)} />)}</Wrap>
              <Text style={type.tiny}>Starting from</Text>
              <PlacePicker value={from} onPick={setFrom} extra={home ? [home] : []} here />
            </View>
          </FoldLine>
          {whoLine}
          {paceLine}
        </>
      )}

      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <Button label={kind === 'trip' ? 'Create trip' : kind === 'now' ? 'Find something now' : 'Create day out'} onPress={submit} loading={busy} />
    </Card>
  );
}

/** How a day out gets there, in the word somebody would say. */
const MODE_WORD = { driving: 'Driving', transit: 'By train or bus', walking: 'Walking', cycling: 'Cycling' } as const;

// ---------------------------------------------------------------------------
// Trip page
// ---------------------------------------------------------------------------

/** The trip's own tabs. They are path segments — `/trips/<id>/shortlist` — so routes.ts owns the list. */
type Section = TripSection;

/** Two taps to delete a trip: its days, stops and shortlist go with it; visits and ratings stay (they lose the link). */
function DeleteTrip({ id, onDeleted }: { id: string; onDeleted: () => Promise<void> }) {
  const [arm, setArm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!arm) return <Chip label="Delete" onPress={() => setArm(true)} />;
  return (
    <Row>
      <Chip label={busy ? 'Deleting…' : 'Delete this trip'} tone="allergen" onPress={async () => { if (busy) return; setBusy(true); try { await api.deleteTrip(id); await onDeleted(); } finally { setBusy(false); } }} />
      <Chip label="Keep" onPress={() => setArm(false)} />
    </Row>
  );
}

/**
 * One trip (handover 4a/4b): **Itinerary | Places · n | Map** across the top,
 * and everything that is working rather than looking — Find, the shortlist, the
 * day planner, Stay, Group — behind the ⋯ menu, which is where the handover
 * puts them ("Shortlist / Group move to the ⋯ menu"). Nothing was taken away:
 * every one of those tabs still has its own address and still opens.
 */
function TripPage({ id, section: asked, dayId: askedDay, household, onBack, refreshHousehold, wide }: {
  id: string;
  /** Which of the trip's tabs the address names — `/trips/<id>/places` — or null for "wherever this trip is up to". */
  section: Section | null;
  /** And which day, when the address names one — `/trips/<id>/day/<dayId>`. */
  dayId: string | null;
  household: HouseholdResponse | null; onBack: () => Promise<void>; refreshHousehold: () => Promise<void>; wide: boolean;
}) {
  const { query, navigate } = useRouter();
  const [d, setD] = useState<TripDetail | null>(null);
  // Which part of the trip you were on, per trip: the section a fortnight in
  // Lisbon is on has nothing to do with Saturday's day out. It is remembered so
  // that opening the trip from the list lands where you left it; the address
  // always wins, so a link to one tab opens that tab.
  const sectionKey = `trip.${id}.section`;
  const section: Section = asked ?? 'itinerary';
  const dayId = askedDay ?? d?.days[0]?.id ?? null;
  const setSection = (next: Section) => navigate(paths.trip(id, next, next === 'day' ? dayId : null));
  const setDayId = (next: string) => navigate(paths.trip(id, 'day', next));
  useEffect(() => { if (asked) rememberScreen<TripPageMemory>(sectionKey, { section: asked }); }, [sectionKey, asked]);
  const [menu, setMenu] = useState(false);
  /**
   * How Find was set when somebody was sent here — "things to do within 5 km,
   * free" — which is part of the address too, so the link opens the same list.
   */
  const findRadiusKm = Number(query.get('km')) || undefined;
  const findPrices = query.get('prices')?.split(',').filter(Boolean);
  const findCat = (['things', 'food', 'events'] as const).find((c) => c === query.get('cat'));
  // What Find fetched lives with the trip page, so tabbing away and back shows the same list without another fetch.
  const [find, setFind] = useState<FindState>(() => ({ ...emptyFind(), radiusKm: findRadiusKm ?? emptyFind().radiusKm }));
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);
  const load = useCallback(async () => {
    try {
      const t = await api.trip(id); setD(t);
      // Where you were when you left, then the trip's own front page — and
      // either way the answer goes into the address, so the trip you are
      // looking at can be sent to somebody.
      if (first.current) {
        first.current = false;
        if (!asked) {
          const remembered = recallScreen<TripPageMemory>(sectionKey)?.data.section ?? null;
          const start = remembered ?? 'itinerary';
          navigate(paths.trip(id, start, start === 'day' ? t.days[0]?.id ?? null : null), { replace: true });
        }
      }
    } catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // Every place this trip touched, for the Places tab and for the Map. Fetched
  // once the trip is open, because both tabs draw the same list.
  const [tripPlaces, setTripPlaces] = useState<{ places: TripPlace[]; counts: { all: number; do: number; eat: number; stay: number } } | null>(null);
  const loadPlaces = useCallback(async () => {
    try { setTripPlaces(await api.tripPlaces(id)); } catch { /* the itinerary still draws */ }
  }, [id]);
  useEffect(() => { loadPlaces(); }, [loadPlaces, d?.shortlist.length, d?.days.length]);

  if (!d) return <ScrollView contentContainerStyle={styles.page}><Button label="Trips" icon="back" kind="ghost" onPress={onBack} style={{ alignSelf: 'flex-start' }} />{error ? <StatusLine tone="warn">{error}</StatusLine> : <Text style={type.small}>Loading…</Text>}</ScrollView>;
  const { trip, days, shortlist, attendees } = d;
  const isTrip = trip.kind === 'trip';
  const isPast = new Date(trip.endDate ?? trip.returnAt) < new Date(new Date().toDateString());
  // The middle of the city is where a trip searches from before anywhere is
  // booked; it is not somewhere they are staying (routes/trips.js marks it).
  const booked = trip.base && trip.base.kind !== 'centre' && trip.base.kind !== 'home' ? trip.base : null;
  const day = days.find((x) => x.id === dayId) ?? days[0];
  const stopsOn = (dd: TripDay) => dd.slots.reduce((a, s) => a + s.stops.length, 0);

  // Where and when, big; then one short sentence (owner, 4 Sep 2026: "'Bath,
  // 4th of September to 6th of September' in big, bold, and then just 1
  // sentence… it could just say '4 people' or 'the whole family'").
  const where = trip.locality ?? trip.place?.label ?? trip.title ?? trip.origin.label;
  const everyone = household ? attendees.length >= household.members.length : false;
  const who = !attendees.length ? null
    : everyone ? 'The whole family'
    : attendees.length > 3 ? `${attendees.length} of you`
    : attendees.map((a) => a.name.split(' ')[0]).join(', ');
  const dates = isTrip ? fmtRange(trip.startDate, trip.endDate) : fmtDate(trip.departAt);
  const nights = isTrip && trip.startDate && trip.endDate
    ? Math.max(0, Math.round((+new Date(`${trip.endDate}T12:00:00`) - +new Date(`${trip.startDate}T12:00:00`)) / 86400000))
    : 0;

  const header = (
    <View style={{ gap: 6 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={onBack} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel="Trips"><Icon name="back" size={19} color={colors.ink} /></Pressable>
        <Row style={{ gap: spacing.sm }}>
          <Pressable onPress={() => setSection('map')} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel="Map"><Icon name="map" size={18} color={colors.ink} /></Pressable>
          <Pressable onPress={() => setMenu((m) => !m)} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel="More" accessibilityState={{ expanded: menu }}>
            <Icon name={menu ? 'close' : 'menu'} size={18} color={colors.ink} />
          </Pressable>
        </Row>
      </Row>
      <Text style={type.title} numberOfLines={2}>{where}</Text>
      <Text style={type.small} numberOfLines={2}>
        {[dates, nights ? `${nights + 1} days` : null, who,
          isTrip && booked ? `staying at ${booked.label.split(',')[0]}` : null,
          isTrip && !booked && !isPast ? 'nowhere to stay yet' : null].filter(Boolean).join(' · ')}
      </Text>
    </View>
  );

  /**
   * The working surfaces. They are not gone — they are one tap away, which is
   * what the handover asks for on a past trip and is no worse on an upcoming
   * one, because the trip's own three tabs are what somebody opens a trip for.
   */
  const menuItems: { value: Section; label: string; icon: IconName; hint?: string }[] = [
    { value: 'find', label: 'Find things to do', icon: 'search', hint: 'Search around this trip' },
    { value: 'shortlist', label: `Shortlist · ${shortlist.length}`, icon: 'shortlist', hint: 'What is still to call and book' },
    { value: 'day', label: isTrip ? `Plan a day · ${days.length}` : 'Plan the day', icon: 'calendar', hint: 'Order the day and see if it fits' },
    ...(isTrip ? [{ value: 'stay' as Section, label: 'Stay', icon: 'hotel' as IconName, hint: booked ? booked.label.split(',')[0] : 'Nowhere booked yet' }] : []),
    // Group is a tab of its own now, not a menu item (owner, 5 Sep 2026).
    // What every source returned for a day, and where the plan lost it (owner,
    // 4 Sep 2026: "I'd like to be able to see the data for each one of these
    // APIs, to see how rich it is"). Admin only: it re-runs the retrieval.
    ...(isAdmin() ? [{ value: 'data' as Section, label: 'Data', icon: 'owned' as IconName }] : []),
  ];

  const tabs: { value: Section; label: string }[] = [
    { value: 'itinerary', label: 'Itinerary' },
    { value: 'places', label: `Places${tripPlaces ? ` · ${tripPlaces.counts.all}` : ''}` },
    { value: 'map', label: 'Map' },
    // Who else is coming, and what is still wanted from them (owner, 4 Sep
    // 2026; back on the top row 5 Sep 2026). Four fit across 390px; the count
    // beside Places is what gives way if a fifth ever has to.
    { value: 'group', label: 'Group' },
  ];

  const dayChips = isTrip ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
      {days.map((dd, i) => {
        const n = stopsOn(dd);
        const on = dd.id === day?.id;
        return (
          <Pressable key={dd.id} onPress={() => setDayId(dd.id)} style={[styles.dayChip, on && { borderColor: memberColors[i % memberColors.length], backgroundColor: colors.surface }]}>
            <Text style={[type.tiny, { color: memberColors[i % memberColors.length], fontWeight: '700' }]}>DAY {i + 1}</Text>
            <Text style={type.h3}>{fmtDate(dd.date)}</Text>
            <Text style={type.tiny}>{n ? `${n} stop${n === 1 ? '' : 's'} saved` : 'nothing saved yet'}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  ) : null;

  const body = (
    <>
      {section === 'itinerary' ? (
        <Itinerary d={d} isPast={isPast} onPlan={() => setSection('find')} onDay={(dd) => setDayId(dd)} />
      ) : null}
      {section === 'places' ? (
        <TripPlaces data={tripPlaces} isPast={isPast} onOpen={(p) => { if (p.lat != null && p.lng != null) setSection('map'); }} />
      ) : null}
      {section === 'map' ? <TripMap d={d} places={tripPlaces?.places ?? []} wide={wide} /> : null}
      {/* Find is for finding (owner, 5 Sep 2026). The planner used to hang off
          the bottom of this tab and open a second, older copy of this very
          list — two browse lists in two formats, one inside the other. It
          lives on the day now, which is the thing being planned. */}
      {section === 'find' ? (
        <BrowseNear d={d} household={household} onChanged={load} find={find} setFind={setFind} initialPrices={findPrices} initialCat={findCat} />
      ) : null}
      {section === 'shortlist' && day ? (
        <View style={{ gap: spacing.md }}>
          {dayChips}
          {/* The moment the offer is worth making: they have decided what they
              are doing and have nowhere to stay, so "near the centre" can become
              "near these" (owner, 4 Sep 2026). Not shown before there is a
              shortlist, because before that it is just an advert. */}
          {isTrip && !booked && shortlist.filter((sl) => sl.lat != null).length >= 2 ? (
            <Card style={{ borderColor: colors.accent }}>
              <Row style={{ gap: spacing.sm }}>
                <Icon name="hotel" size={18} color={colors.accent} />
                <Text style={[type.h3, { flex: 1 }]}>Somewhere to stay near these?</Text>
              </Row>
              <Text style={type.small}>
                You've got {shortlist.filter((sl) => sl.lat != null).length} things down for {trip.locality ?? 'this trip'} and nowhere to stay yet.
                We can rank the beds by how much of that is {trip.hasCar ? 'a short drive' : 'a walk'} from the front door.
              </Text>
              <Button label="Find somewhere near our plans" icon="hotel" onPress={() => setSection('stay')} />
            </Card>
          ) : null}
          <ShortlistJourney d={d} day={day} household={household} wide={wide} onChanged={load} onFind={() => setSection('find')} onSaved={async () => { await load(); await refreshHousehold(); setSection('itinerary'); }} />
        </View>
      ) : null}
      {section === 'day' && day ? (
        <View style={{ gap: spacing.md }}>
          {dayChips}
          <TripJourneyDay d={d} day={day} wide={wide} onChanged={load} onChangePlan={() => setSection('shortlist')} />
          {household ? <DayPlanner trip={d} day={day} household={household} onChanged={async () => { await load(); await refreshHousehold(); }} /> : null}
        </View>
      ) : null}
      {section === 'stay' && isTrip ? <StayPanel d={d} household={household} onChanged={load} onFindNear={() => setSection('find')} openSearch={!booked} /> : null}
      {section === 'group' ? <GroupPanel d={d} onChanged={load} /> : null}
      {section === 'data' ? <SourceDataPanel d={d} /> : null}
    </>
  );

  return (
    <ScrollView contentContainerStyle={[styles.page, wide && { maxWidth: 860, alignSelf: 'center', width: '100%' }]} keyboardShouldPersistTaps="handled">
      {header}
      <Segmented value={section} options={tabs} onChange={setSection} />
      {menu ? (
        <View style={styles.menu}>
          {menuItems.map((m) => (
            <Pressable key={m.value} onPress={() => { setMenu(false); setSection(m.value); }} style={styles.menuRow} accessibilityRole="button">
              <Icon name={m.icon} size={17} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={type.h3} numberOfLines={1}>{m.label}</Text>
                {m.hint ? <Text style={type.tiny} numberOfLines={1}>{m.hint}</Text> : null}
              </View>
              <Icon name="more" size={16} color={colors.inkMuted} />
            </Pressable>
          ))}
          <View style={styles.menuRow}><DeleteTrip id={id} onDeleted={onBack} /></View>
        </View>
      ) : null}
      {/* A tab reached from the menu says which one it is, because the segmented
          control above it is showing none of the three. */}
      {!TRIP_TABS.includes(section) ? (
        <Row style={{ gap: 6 }}>
          <Icon name={menuItems.find((m) => m.value === section)?.icon ?? 'list'} size={15} />
          <Text style={[type.h3, { flex: 1 }]}>{menuItems.find((m) => m.value === section)?.label ?? section}</Text>
          <Chip label="Back to the trip" icon="back" onPress={() => setSection('itinerary')} />
        </Row>
      ) : null}
      {body}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// The itinerary
// ---------------------------------------------------------------------------

/** One line on the spine: a time, an icon, what it is, and the detail under it. */
type Beat = { time: string | null; icon: IconName; title: string; detail: string | null; dayId: string | null };

/**
 * The trip as a timed spine, day by day (handover 4a: "TripIt-style timed
 * spine"). It is built from what the trip already holds — the days, the stops
 * saved into them, and the base with its check-in — so it costs nothing to draw
 * and says nothing that is not already true.
 */
function Itinerary({ d, isPast, onPlan, onDay }: { d: TripDetail; isPast: boolean; onPlan: () => void; onDay: (dayId: string) => void }) {
  const { trip, days } = d;
  const isTrip = trip.kind === 'trip';
  const base = trip.base && trip.base.kind !== 'centre' && trip.base.kind !== 'home' ? trip.base : null;
  const checkIn = base?.checkIn ?? (isTrip ? trip.startDate : null);
  const checkOut = base?.checkOut ?? (isTrip ? trip.endDate : null);

  const spine = days.map((day, i) => {
    const stopBeats: Beat[] = [];
    for (const slot of day.slots) {
      for (const stop of slot.stops) {
        stopBeats.push({
          time: stop.startTime,
          icon: 'place',
          title: stop.name,
          detail: [SLOT_LABEL[slot.slot], stop.dwellMinutes ? minutes(stop.dwellMinutes) : null,
            stop.bookingStatus === 'booked' ? 'booked' : null,
            stop.visit ? 'been' : null].filter(Boolean).join(' · ') || null,
          dayId: day.id,
        });
      }
    }
    const times = stopBeats.map((b) => b.time).filter(Boolean) as string[];
    const firstAt = times.length ? times.reduce((a, b) => (a < b ? a : b)) : null;
    const lastAt = times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
    /**
     * A day's window and the times on its stops can disagree — the window was
     * changed after the day was saved — and the stops are what actually
     * happened. So the window's time is only shown where it is still true:
     * leaving home before the first stop, coming back after the last. Where it
     * is not, the beat keeps its place and loses its clock, rather than telling
     * somebody they left home at 10:00 to arrive somewhere at 07:41.
     */
    const dayStart = isTrip ? trip.dayStart ?? null : clock24(trip.departAt);
    const dayEnd = isTrip ? trip.dayEnd ?? null : clock24(trip.returnAt);

    const beats: Beat[] = [];
    // Leaving home is the first thing that happens, and it is a fact of the
    // trip rather than a stop somebody saved.
    if (i === 0) {
      beats.push({
        time: dayStart && (!firstAt || dayStart < firstAt) ? dayStart : null,
        icon: trip.travelMode === 'transit' ? 'transit' : trip.travelMode === 'walking' ? 'walking' : 'driving',
        title: 'Leave home',
        detail: [trip.origin.label?.split(',')[0], trip.destination?.label?.split(',')[0]].filter(Boolean).join(' → ') || null,
        dayId: day.id,
      });
    }
    if (base && checkIn && String(checkIn).slice(0, 10) === day.date) {
      beats.push({ time: null, icon: 'hotel', title: base.label.split(',')[0], detail: `Check in${checkOut ? ` · until ${fmtDate(String(checkOut))}` : ''}`, dayId: day.id });
    }
    beats.push(...stopBeats);
    if (base && checkOut && String(checkOut).slice(0, 10) === day.date && beats.length) {
      beats.push({ time: null, icon: 'hotel', title: `Check out · ${base.label.split(',')[0]}`, detail: null, dayId: day.id });
    }
    if (i === days.length - 1) {
      beats.push({ time: dayEnd && (!lastAt || dayEnd > lastAt) ? dayEnd : null, icon: 'home', title: 'Home', detail: null, dayId: day.id });
    }
    return { day, beats };
  });

  const anything = spine.some((s) => s.beats.some((b) => b.icon === 'place'));

  return (
    <View style={{ gap: spacing.md }}>
      {!anything ? (
        <Card>
          <Text style={type.h3}>Nothing on the days yet</Text>
          <Text style={type.small}>{isPast ? 'This trip has no stops saved against its days. Anything you did is still under Places.' : 'Find things to do, shortlist them, and the day you save comes back here as the itinerary.'}</Text>
          {!isPast ? <Button label="Find things to do" icon="search" onPress={onPlan} style={{ alignSelf: 'flex-start' }} /> : null}
        </Card>
      ) : null}
      {spine.map(({ day, beats }) => (
        <View key={day.id} style={{ gap: 2 }}>
          <Pressable onPress={() => onDay(day.id)} style={styles.dayHead} accessibilityRole="button">
            <Text style={[type.label, { marginBottom: 0, marginTop: 0, color: colors.ink }]}>
              {new Date(`${day.date}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
            </Text>
            <View style={styles.rule} />
          </Pressable>
          {beats.map((b, i) => (
            <View key={`${day.id}-${i}`} style={styles.beat}>
              <Text style={styles.beatTime}>{b.time ?? ''}</Text>
              <View style={{ alignItems: 'center' }}>
                <View style={styles.beatDot}><Icon name={b.icon} size={16} color={colors.accent} /></View>
                {i < beats.length - 1 ? <View style={styles.beatLine} /> : null}
              </View>
              <View style={{ flex: 1, minWidth: 0, paddingBottom: spacing.md, paddingTop: 6, gap: 2 }}>
                <Text style={[type.h3, { fontWeight: '700' }]} numberOfLines={2}>{b.title}</Text>
                {b.detail ? <Text style={type.small} numberOfLines={2}>{b.detail}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Every place a trip touched
// ---------------------------------------------------------------------------

const GROUP_LABEL: Record<TripPlace['group'], string> = { stay: 'Hotels', do: 'Activities', eat: 'Food & drink' };
const GROUP_ORDER: TripPlace['group'][] = ['stay', 'do', 'eat'];

/**
 * Handover 4b: "Every place this trip touched, grouped Hotels / Activities /
 * Food & drink with count chips to filter. Each carries the day it happened and
 * your rating; unrated ones show the red Rate nudge."
 */
function TripPlaces({ data, isPast, onOpen }: { data: { places: TripPlace[]; counts: { all: number; do: number; eat: number; stay: number } } | null; isPast: boolean; onOpen: (p: TripPlace) => void }) {
  const [only, setOnly] = useState<TripPlace['group'] | null>(null);
  if (!data) return <Text style={type.small}>Loading…</Text>;
  if (!data.places.length) return <Card><Text style={type.small}>This trip has not touched any places yet. Shortlist something, or say you have been somewhere.</Text></Card>;
  const groups = GROUP_ORDER.map((g) => ({ g, list: data.places.filter((p) => p.group === g) })).filter((x) => x.list.length && (!only || only === x.g));
  return (
    <View style={{ gap: spacing.md }}>
      <Wrap>
        <Chip label={`All · ${data.counts.all}`} selected={!only} onPress={() => setOnly(null)} />
        {GROUP_ORDER.filter((g) => data.counts[g]).map((g) => (
          <Chip key={g} label={`${GROUP_LABEL[g]} · ${data.counts[g]}`} selected={only === g} onPress={() => setOnly(only === g ? null : g)} />
        ))}
      </Wrap>
      {groups.map(({ g, list }) => (
        <View key={g} style={{ gap: spacing.sm }}>
          <Text style={type.label}>{GROUP_LABEL[g]}</Text>
          <View style={styles.list}>
            {list.map((p, i) => <TripPlaceRow key={p.venueRef} place={p} first={i === 0} isPast={isPast} onPress={() => onOpen(p)} />)}
          </View>
        </View>
      ))}
    </View>
  );
}

function TripPlaceRow({ place: p, first, isPast, onPress }: { place: TripPlace; first?: boolean; isPast: boolean; onPress: () => void }) {
  const meta = [
    p.day,
    p.dwellMinutes ? minutes(p.dwellMinutes) : null,
    p.bookingStatus === 'booked' ? 'booked' : null,
    // Somewhere kept but never put on a day still says what it is doing here,
    // rather than leaving the row with nothing under its name.
    !p.day && !p.scheduled && p.shortlisted ? 'On the shortlist' : null,
    p.visited && !p.day ? 'Been' : null,
  ].filter(Boolean).join(' · ');
  const said = p.scores.length ? p.scores.map((s) => `${s.member.split(' ')[0]} ${s.score}`).join(' · ') : null;
  return (
    <Pressable onPress={onPress} style={[styles.prow, !first && styles.rowLine]} accessibilityRole="button">
      <VenueThumb name={p.name} image={p.image} category={p.category} width={56} height={56} rounded={radius.md} credit={false} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={type.h3} numberOfLines={1}>{p.name ?? 'A place'}</Text>
        {meta ? <Text style={type.small} numberOfLines={1}>{meta}</Text> : null}
        {said ? <Text style={styles.green} numberOfLines={1}>{said}</Text> : null}
      </View>
      {p.score != null ? <Stars value={p.score} size={13} />
        // The one red thing on this screen, and only where it is owed: they went
        // and nobody has said what they thought (handover 4b).
        : p.visited && isPast ? <Text style={styles.rate}>Rate</Text>
          : <Icon name="more" size={16} color={colors.inkMuted} />}
    </Pressable>
  );
}

/** Everywhere this trip touched, on one map. */
function TripMap({ d, places, wide }: { d: TripDetail; places: TripPlace[]; wide: boolean }) {
  const { height } = useViewport();
  const [sel, setSel] = useState<string | null>(null);
  const base = d.trip.base;
  const pins: MapPin[] = [
    ...(base && base.lat != null ? [{ id: 'base', lat: base.lat, lng: base.lng, label: base.label, number: '', tone: 'base' as const, onPress: () => setSel('base') }] : []),
    ...places.filter((p) => p.lat != null && p.lng != null && p.venueRef !== 'base').map((p) => ({
      id: p.venueRef, lat: p.lat as number, lng: p.lng as number, label: p.name ?? '', number: '',
      tone: (p.visited ? 'base' : 'hollow') as 'base' | 'hollow', onPress: () => setSel(p.venueRef),
    })),
  ];
  const chosen = places.find((p) => p.venueRef === sel) ?? null;
  if (!pins.length) return <Card><Text style={type.small}>Nothing on this trip has a position yet, so there is no map to draw.</Text></Card>;
  return (
    <View style={styles.mapWrap}>
      <MapView pins={pins} height={wide ? 620 : Math.max(360, height - 380)} focusId={sel} />
      {chosen ? (
        <View style={styles.pinCard}>
          <TripPlaceRow place={chosen} first isPast={false} onPress={() => setSel(null)} />
        </View>
      ) : <Text style={[type.tiny, styles.mapHint]}>{pins.length} pins · filled been · hollow planned</Text>}
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
          <Button label={planning ? 'Hide the planner' : allStops.length ? 'Re-plan this day' : 'Plan it for me'} icon="plan" onPress={() => setPlanning((p) => !p)} />
          {planning && resumed ? <Button label="Start again" kind="ghost" onPress={() => { setResumed(null); setPlanning(true); }} /> : null}
        </Row>
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      </Card>

      {planning && resumed !== undefined ? <DayPlanPanel key={resumed ? resumed.sessionId : 'fresh'} trip={trip} day={day} initial={resumed ?? null} onCommitted={async () => { setPlanning(false); await onChanged(); }} /> : null}

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
              <Row>{s.mustDo ? <Icon name="favourite" size={14} color={colors.icon} fill /> : null}<CategoryIcon category={s.category} size={16} color={colors.ink} /><Text style={[type.h3, { flexShrink: 1 }]}>{s.name}</Text></Row>
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
            {(['morning', 'afternoon', 'evening'] as const).map((sl) => <Chip key={sl} label={SLOT_LABEL[sl]} icon="forward" onPress={() => { setMoving(false); call(() => api.updateStop(trip.trip.id, stop.id, { slot: sl })); }} />)}
            {trip.days.filter((dd) => dd.id !== day.id).map((dd) => <Chip key={dd.id} label={fmtDate(dd.date)} icon="forward" onPress={() => { setMoving(false); call(() => api.updateStop(trip.trip.id, stop.id, { dayId: dd.id })); }} />)}
            <Chip label="30 min" icon="minus" onPress={() => call(() => api.updateStop(trip.trip.id, stop.id, { dwellMinutes: Math.max(15, stop.dwellMinutes - 30) }))} />
            <Chip label="30 min" icon="add" onPress={() => call(() => api.updateStop(trip.trip.id, stop.id, { dwellMinutes: stop.dwellMinutes + 30 }))} />
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
function DayPlanPanel({ trip, day, initial, onCommitted }: { trip: TripDetail; day: TripDay; initial: PlanResponse | null; onCommitted: () => Promise<void> }) {
  const [plan, setPlan] = useState<PlanResponse | null>(initial);
  const [busy, setBusy] = useState<false | 'thinking' | 'updating'>(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [reply, setReply] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy('thinking'); setError(null);
    try { const p = await api.planDay(trip.trip.id, day.id); setPlan(p); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, [trip.trip.id, day.id]);
  useEffect(() => { if (!initial) start(); }, [start, initial]);
  const baseLabel = trip.trip.base?.label ?? trip.trip.origin.label;

  const say = async (text: string, viaVoice = false) => {
    if (!plan || !text.trim()) return;
    setBusy('thinking'); setInput('');
    try { const p = await api.planRefine(plan.sessionId, text, null); setPlan(p); setReply(p.reply); if (viaVoice && p.reply) speak(p.reply); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const speech = useSpeech({ onFinal: (t) => say(t, true) });
  const act = async (a: PlanAction) => { if (!plan) return; setBusy('updating'); try { setPlan(await api.planAct(plan.sessionId, a)); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const fillDay = async () => {
    if (!plan?.options.length) return;
    setBusy('updating');
    try { await api.planCommit(plan.sessionId, plan.options.find((o) => o.id === 'pinned')?.id ?? plan.options[0].id); await onCommitted(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  // While speaking, this card is the transcript and nothing else (owner, 3 Sep 2026).
  if (speech.listening) {
    return (
      <Card style={{ borderColor: colors.accent, gap: spacing.md }}>
        <Listening transcript={speech.transcript} hint={`Say what you're after near ${baseLabel} — the kind of place, who it's for, what to avoid.`} onDone={speech.stop} onCancel={speech.cancel} />
      </Card>
    );
  }

  return (
    <Card style={{ borderColor: colors.accent, gap: spacing.md }}>
      <Text style={type.h3}>Filling {fmtDate(day.date)}</Text>
      <Text style={type.tiny}>Say what you're after and Roam works from the same pool Find searches, around whatever is already on the day. To browse that pool yourself, use Find.{plan?.resumed ? ' Picked up where you left off.' : ''}</Text>
      {busy === 'thinking' ? <StatusLine>Looking around {baseLabel}…</StatusLine> : null}
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      {reply ? <View style={styles.bubble}><Text style={type.body}>{reply}</Text></View> : null}

      <Row>
        <TextInput value={input} onChangeText={setInput} placeholder="e.g. somewhere upmarket for dinner, no chains, more for Phoenix" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} onSubmitEditing={() => say(input)} />
        {speech.supported ? <Pressable onPress={speech.toggle} style={[styles.mic, speech.listening && styles.micOn]} accessibilityLabel={speech.listening ? 'Stop' : 'Speak'}><Icon name={speech.listening ? 'stop' : 'mic'} size={18} color={colors.ink} /></Pressable> : null}
        <Button label="Send" onPress={() => say(input)} disabled={!input.trim() || !!busy} />
      </Row>

      {/* The browse list that used to sit here is gone (owner, 5 Sep 2026: "it
          opens up another duplicated menu underneath that's in a completely
          different format… extremely confusing"). It was BrowsePool — a second
          implementation of Find's own list, nested inside Find. Find is the
          list; this is the one button that fills the day from it. Price and
          chains stay, because they change what the fill picks. */}
      {plan ? (
        <>
          <PricePointControl value={plan.constraints?.pricePoint ?? 'any'} onChange={(v) => act({ type: 'set', pricePoint: v })} />
          <ChainsControl includeChains={plan.constraints?.includeChains ?? false} hidden={plan.pool?.hiddenChains ?? 0} onChange={(v) => act({ type: 'set', includeChains: v })} />
          <Text style={type.tiny}>
            {plan.browse?.length ? `${plan.browse.length} places found around ${baseLabel}` : `Looking around ${baseLabel}`}
            {plan.selection?.excluded?.length ? ` · ${plan.selection.excluded.length} set aside` : ''}
          </Text>
          <Button label="Fill the day from these" icon="plan" onPress={fillDay} disabled={!!busy || !plan.options.length} />
        </>
      ) : null}
    </Card>
  );
}

const clock24 = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---------------------------------------------------------------------------
// Stay
// ---------------------------------------------------------------------------

/** A price in the household's own money, in as few characters as it can be said in. */
const SYMBOL: Record<string, string> = { GBP: '\u00a3', USD: '$', EUR: '\u20ac' };
const price = (n: number, currency: string) => {
  const sym = SYMBOL[currency] ?? `${currency} `;
  return `${sym}${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
};

/** "2 adults and 2 children (8, 11)" — who the room was priced for, in words. */
function partyWords(p: StayPricing) {
  const a = `${p.adults} ${p.adults === 1 ? 'adult' : 'adults'}`;
  if (!p.childAges.length) return a;
  return `${a} and ${p.childAges.length} ${p.childAges.length === 1 ? 'child' : 'children'} (${p.childAges.join(', ')})`;
}

/**
 * Where we're staying — the two things it can be, and never a blank box.
 *
 * A trip away has exactly two states (owner, 4 Sep 2026): "I'm staying
 * somewhere" and "I need to find somewhere to stay". The second is the one
 * Roam is actually good at, because it is the only thing that knows the
 * shortlist: a bed is ranked by how much of the week is on foot from its front
 * door, not by how near it is to a station.
 *
 * With a price source connected (LiteAPI) the row carries both halves at once:
 * how much of the week is on foot from that front door, and what the room costs
 * on these nights for these people. Neither is an answer on its own — a hotel
 * on the doorstep at six hundred a night is not somewhere to stay either.
 *
 * The price is rented and short-lived. It is fetched for this screen, shown
 * with what it is for, and never written down: /api/trips/:id/stays is not in
 * offline/policy.ts and must not be added to it.
 *
 * Booking is not here. LiteAPI can take one, and that spends money and settles
 * it — the owner's to switch on with a payment route and a cap (CLAUDE.md).
 */
function StayPanel({ d, household, onChanged, onFindNear, openSearch }: {
  d: TripDetail; household: HouseholdResponse | null; onChanged: () => Promise<void>; onFindNear: () => void; openSearch?: boolean;
}) {
  const { trip, shortlist } = d;
  // A stand-in centre is not a booking (routes/trips.js writes base_kind 'centre').
  const booked = trip.base && trip.base.kind !== 'centre' ? trip.base : null;
  const [checkIn, setCheckIn] = useState(trip.base?.checkIn ?? '');
  const [checkOut, setCheckOut] = useState(trip.base?.checkOut ?? '');
  const [hasCar, setHasCar] = useState(!!trip.hasCar);
  // Booked already, or still looking. A trip that arrives with nowhere to stay
  // opens on looking, because that is the thing left to do.
  const [mode, setMode] = useState<'known' | 'find'>(booked ? 'known' : 'find');
  const [milesIdx, setMilesIdx] = useState(1);
  const [stays, setStays] = useState<Stay[] | null>(null);
  const [near, setNear] = useState<{ label: string } | null>(null);
  const [pricing, setPricing] = useState<StayPricing | null>(null);
  const [credits, setCredits] = useState<string[]>([]);
  // How many rooms to price. One holding everybody is the cheapest honest
  // default; who shares with whom is not ours to invent, so it is on screen.
  const [rooms, setRooms] = useState(1);
  const [looking, setLooking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // How far out to look, said the way a person says it. Without a car the
  // honest unit is a walk; with one, a mile is nothing.
  const RINGS = hasCar
    ? [{ km: 1, label: 'In the centre' }, { km: 3, label: 'Within 2 miles' }, { km: 8, label: 'Within 5 miles' }, { km: 15, label: 'Within 10 miles' }]
    : [{ km: 0.8, label: '10 min walk' }, { km: 1.6, label: '20 min walk' }, { km: 3, label: '2 miles' }, { km: 6, label: '4 miles' }];
  const ring = RINGS[Math.min(milesIdx, RINGS.length - 1)];

  const look = useCallback(async (km: number, howManyRooms = rooms) => {
    setLooking(true); setErr(null);
    try {
      const r = await api.tripStays(trip.id, { radiusKm: km, mode: hasCar ? 'driving' : 'walking', rooms: howManyRooms });
      setStays(r.results); setNear(r.near); setPricing(r.pricing);
      setCredits(r.attributions ?? [r.attribution]);
    } catch (e: any) { setErr(e.message); setStays([]); } finally { setLooking(false); }
  }, [trip.id, hasCar, rooms]);

  // Arriving with nothing booked starts looking straight away, the way Find does.
  useEffect(() => { if (mode === 'find' && !stays && !looking && !err) look(ring.km); }, [mode]);

  const planned = shortlist.filter((sl) => sl.lat != null).length;
  // Picking a bed is the household claiming a place, so it goes through the
  // route that researches it in the open map rather than storing whatever the
  // row said (api/routes/trips.js POST /:id/stay).
  const choose = async (stay: Stay) => {
    setSaving(stay.venueRef);
    try {
      await api.setTripStay(trip.id, { venueRef: stay.venueRef, label: stay.name, lat: stay.lat, lng: stay.lng });
      await onChanged();
      setMode('known');
    } catch (e: any) { setErr(e.message); } finally { setSaving(null); }
  };

  return (
    <View style={{ gap: spacing.md }}>
      <Card>
        <Segmented
          value={mode}
          options={[{ value: 'known', label: "We've got somewhere" }, { value: 'find', label: 'Find us somewhere' }]}
          onChange={(v) => setMode(v as 'known' | 'find')}
        />

        {mode === 'known' ? (
          <>
            <PlacePicker
              value={booked ? { label: booked.label, lat: booked.lat, lng: booked.lng, formatted: booked.label } : null}
              onPick={async (p) => { if (p) { await api.updateTripV2(trip.id, { base: p, baseKind: 'hotel' }); await onChanged(); } }}
              placeholder={trip.locality ? `Hotel, rental or address in ${trip.locality}` : 'Hotel, rental or address'}
              kind="lodging"
              near={trip.base ? { label: trip.locality ?? trip.base.label, lat: trip.base.lat, lng: trip.base.lng, locality: trip.locality, country: trip.country, countryCode: trip.countryCode } : null}
              countryCode={trip.countryCode}
            />
            {booked ? (
              <Row>
                <TextInput value={checkIn} onChangeText={setCheckIn} placeholder="Check-in 15:00" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
                <TextInput value={checkOut} onChangeText={setCheckOut} placeholder="Check-out 11:00" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} />
                <Button label="Save" kind="secondary" onPress={async () => { await api.updateTripV2(trip.id, { checkIn, checkOut }); await onChanged(); }} />
              </Row>
            ) : null}
          </>
        ) : (
          <>
            {/* How far out, and whether there is a car — the two things that decide
                whether "near" means the next street or the next village. */}
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={type.body}>We'll have a car</Text>
              <Switch value={hasCar} onValueChange={async (v) => { setHasCar(v); setStays(null); await api.updateTripV2(trip.id, { hasCar: v, travelMode: v ? 'driving' : 'transit' }); await onChanged(); }} />
            </Row>
            <Text style={type.tiny}>{planned ? `Ranked by how much of your shortlist is ${hasCar ? 'a short drive' : 'a walk'} from the front door.` : `Nothing shortlisted yet, so these are ranked from the middle of ${trip.locality ?? 'town'}. Shortlist a few things and look again — that is when this gets good.`}</Text>
            <Wrap>
              {RINGS.map((r, i) => <Chip key={r.label} label={r.label} selected={i === milesIdx} onPress={() => { setMilesIdx(i); setStays(null); look(r.km); }} />)}
            </Wrap>

            {/* What the prices are for. Never a number without the party and
                the nights beside it, and never an assumed age left unsaid. */}
            {pricing?.on && pricing.nights > 0 ? (
              <View style={{ gap: 4 }}>
                <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm }}>
                  <Text style={[type.small, { flex: 1, minWidth: 180 }]}>
                    {pricing.nights} {pricing.nights === 1 ? 'night' : 'nights'} · {partyWords(pricing)}
                  </Text>
                  <Stepper label="Rooms" value={rooms} min={1} max={9} onChange={(v) => { setRooms(v); setStays(null); look(ring.km, v); }} />
                </Row>
                {pricing.assumedAges.length ? (
                  <Text style={type.tiny}>
                    We asked for {pricing.assumedAges.join(' and ')} at 10 because we do not have {pricing.assumedAges.length === 1 ? 'their' : 'their'} birthday.
                    Add it in Household and the price will be the right one.
                  </Text>
                ) : null}
                {pricing.sandbox ? (
                  <StatusLine tone="warn">These are sandbox prices from a test key — invented hotels at invented prices. Swap LITEAPI_KEY for the live one in Doppler to see real rooms.</StatusLine>
                ) : null}
                {pricing.degraded.length ? (
                  <StatusLine tone="warn">Prices did not come back this time ({pricing.degraded[0].source}). The beds below are the open map's; try again in a moment.</StatusLine>
                ) : null}
              </View>
            ) : pricing?.on && pricing.reason === 'no_dates' ? (
              <Text style={type.tiny}>Set the dates for this trip and we will price every one of these for the nights you are away.</Text>
            ) : null}

            <Button label={looking ? 'Looking…' : stays ? 'Look again' : `Find somewhere in ${trip.locality ?? 'town'}`} icon="search" onPress={() => look(ring.km)} loading={looking} />
            {err ? <StatusLine tone="warn">{err}</StatusLine> : null}
            {looking && !stays ? <Text style={type.small}>{pricing?.on === false ? 'Reading the open map for beds' : 'Reading the open map, and asking what the rooms cost'} around {trip.locality ?? 'town'}…</Text> : null}
            {stays && !stays.length && !looking ? <Text style={type.small}>Nothing on the map within {ring.label.toLowerCase()}. Try a wider ring.</Text> : null}
            {stays?.length ? (
              <View style={{ gap: spacing.sm }}>
                <Text style={type.tiny}>
                  {stays.length} places to stay{pricing?.withPrice ? ` · ${pricing.withPrice} with a room free` : ''} · {near?.label ? `measured from ${near.label}` : ''}
                </Text>
                {stays.slice(0, 12).map((s) => (
                  <Pressable key={s.venueRef} onPress={() => choose(s)} style={styles.stayRow} accessibilityRole="button">
                    {/* You choose a hotel with your eyes first. The picture is
                        the provider's, drawn from their URL and never stored —
                        VenueThumb already knows the difference and carries the
                        credit; with no picture it falls back to the bed icon on
                        the one mint ground rather than inventing something. */}
                    <Row style={{ gap: spacing.md, alignItems: 'flex-start' }}>
                      <VenueThumb name={s.name} photos={s.photos} category="hotel" width={92} height={70} credit={false} rounded={radius.sm} />
                      <View style={{ flex: 1, gap: 3 }}>
                        <Row style={{ gap: spacing.sm }}>
                          <Text style={[type.h3, { flex: 1 }]} numberOfLines={2}>{s.name}</Text>
                          {s.stars ? <Rating value={s.stars} /> : null}
                        </Row>
                        <Text style={type.tiny} numberOfLines={1}>{[s.stayKind, s.address].filter(Boolean).join(' · ')}</Text>
                        {/* The sentence that is the whole point of doing this here. */}
                        {s.plansTotal ? (
                          <Text style={[type.small, { color: s.plansNear === s.plansTotal ? colors.like : colors.ink }]}>
                            {s.plansNear === s.plansTotal
                              ? `Everything on your shortlist within ${hasCar ? 'a short drive' : 'a walk'} — typically ${s.typicalMinutes} min`
                              : `${s.plansNear} of your ${s.plansTotal} plans within ${hasCar ? 'a short drive' : 'a walk'} · typically ${s.typicalMinutes} min${s.farthest ? `, ${s.farthest.minutes} min to ${s.farthest.label.split(',')[0]}` : ''}`}
                          </Text>
                        ) : (
                          <Text style={type.small}>{s.distanceKm} km from the middle of {trip.locality ?? 'town'}</Text>
                        )}
                        {/* The other half of the answer: what it costs, on what terms. */}
                        {s.offer ? (
                          <Text style={type.small}>
                            <Text style={styles.stayPrice}>{price(s.offer.total, s.offer.currency)}</Text>
                            <Text style={type.small}>
                              {' '}for {pricing?.nights ?? 0} {pricing?.nights === 1 ? 'night' : 'nights'}
                              {s.offer.perNight ? ` · ${price(s.offer.perNight, s.offer.currency)} a night` : ''}
                              {s.offer.board ? ` · ${s.offer.board}` : ''}
                              {s.offer.refundable === true ? ' · free cancellation' : s.offer.refundable === false ? ' · non-refundable' : ''}
                            </Text>
                          </Text>
                        ) : pricing?.priced ? (
                          <Text style={type.tiny}>No room free on these nights.</Text>
                        ) : null}
                        <View style={styles.stayPick}><Text style={styles.stayPickText}>{saving === s.venueRef ? 'Saving…' : "We'll stay here"}</Text></View>
                      </View>
                    </Row>
                  </Pressable>
                ))}
                <Text style={type.tiny}>
                  {credits.length ? credits.join(' · ') : '© OpenStreetMap contributors'}.
                  {' '}Prices are for the party above and were live when this list was drawn; the hotel takes the booking, not Roam.
                </Text>
              </View>
            ) : null}
          </>
        )}

        <SourcePicker value={trip.sources ?? null} onChange={async (v) => { await api.updateTripV2(trip.id, { sources: v }); await onChanged(); }} title="Sources for this trip's searches and plans" />
        <TripSpendLine tripId={trip.id} refreshKey={trip} />
        <Button label="Find restaurants and things near here" kind="secondary" onPress={onFindNear} />
      </Card>
      {booked ? <Card><MapView pins={[{ id: 'base', lat: booked.lat, lng: booked.lng, label: booked.label, tone: 'base' }]} height={260} /></Card> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 1180, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  // The header's round controls: an ink + for a new trip, an outlined circle for the rest.
  roundBtn: { width: 40, height: 40, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  roundBtnInk: { backgroundColor: colors.primary, borderColor: colors.primary },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  fchip: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 32, paddingLeft: 10, paddingRight: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, maxWidth: 170 },
  fchipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  fchipText: { fontSize: 12, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  // A trip on the list: the picture, the name, the dates, the people.
  tripCard: { flexDirection: 'row', gap: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, backgroundColor: colors.surface },
  // The working surfaces, one tap behind the ⋯.
  menu: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.surface, overflow: 'hidden' },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: TARGET, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  // The itinerary's timed spine.
  dayHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm },
  rule: { flex: 1, height: 1, backgroundColor: colors.line },
  beat: { flexDirection: 'row', gap: spacing.md, alignItems: 'stretch' },
  beatTime: { width: 46, textAlign: 'right', paddingTop: 12, fontFamily: fonts.body, fontSize: 12, fontWeight: '600', color: colors.ink },
  beatDot: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  beatLine: { flex: 1, width: 2, minHeight: 14, backgroundColor: colors.line },
  // Rows shared with Places: one anatomy across the app (handover §6).
  list: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  prow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 10, paddingHorizontal: spacing.md, minHeight: TARGET },
  rowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  green: { fontFamily: fonts.body, fontSize: 12, fontWeight: '600', color: colors.accent },
  // What the room costs: the second-loudest thing on a stay row, after its name.
  stayPrice: { fontFamily: fonts.body, fontSize: 15, fontWeight: '700', color: colors.ink },
  // The one red thing on a past trip: somewhere they went and nobody has said what they thought.
  rate: { fontFamily: fonts.body, fontSize: 12, fontWeight: '700', color: colors.red },
  mapWrap: { position: 'relative' },
  pinCard: { position: 'absolute', left: spacing.sm, right: spacing.sm, bottom: spacing.sm, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  mapHint: { position: 'absolute', left: spacing.sm, bottom: spacing.sm, backgroundColor: colors.surface, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.md, overflow: 'hidden' },
  split: { gap: spacing.md },
  input: { minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink },
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
  fold: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  stayRow: { gap: 3, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  stayPick: { alignSelf: 'flex-start', marginTop: 4, minHeight: 34, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.accent, justifyContent: 'center' },
  stayPickText: { color: colors.bg, fontWeight: '700', fontSize: 12 },
});

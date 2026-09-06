/**
 * The trip, map first (design handoff, 6 Sep 2026, `design_handoff_trip_map_first`).
 *
 * The trip stops being a page with a map on it and becomes a map with a sheet
 * over it. Two modes, and the pills are the switch between them:
 *
 *   **Trip home** — the map shows *your* day: home, the destination, the route,
 *   and anything added or shortlisted. The sheet is the day as a timeline.
 *   **Browse** — a pill is lit, the map re-pins to that search along the route,
 *   and the sheet becomes a filterable list. A route button in the sheet header
 *   goes back.
 *
 * Everything is measured as **time off the route**, never distance from home:
 * once you are in the car, "eight minutes out of your way" is the only number
 * that decides anything, and "twelve miles from home" decides nothing.
 *
 * Two reconciliations with what was already here, neither of which loses
 * anything the owner has asked for:
 *
 *   · The handoff draws no tab row, but Group was put on the top row of a trip
 *     on 5 Sep at the owner's request. So the tabs moved *into* the sheet —
 *     Day · Places · Group — which keeps the map as the screen and keeps Group
 *     one tap away. Each keeps the address it had.
 *   · The working surfaces (Find, the shortlist, the day planner, Stay, Data)
 *     stay on their own full pages behind the ⋯ menu, because they are desks
 *     rather than views of a day.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, BrowseItem, HouseholdResponse, Stay, StayPlacement, TripAlongPlace, TripDay, TripDetail, TripPlace } from '../api';
import { useViewport } from '../hooks/useViewport';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip as UiChip, Row, Segmented, StatusLine, Wrap } from '../components/ui';
import { RangeSlider } from '../components/RangeSlider';
import { Icon, IconName, Stars } from '../components/Icon';
import { VenueThumb } from '../components/VenueThumb';
import { Avatar } from '../components/Faces';
import { BottomSheet, Detent, detentHeights } from '../components/BottomSheet';
import { MapGL, MapMarker, MapRoute } from '../components/MapGL';
import { GroupPanel } from '../components/GroupPanel';
import { VenueDrawer } from '../components/VenueDrawer';
import { asOneOf, asText, useQueryState, useRouter } from '../router';
import { paths, type TripSection } from '../routes';
import { weeksOf } from './tripWeeks';

/**
 * What this trip is called on screen.
 *
 * The destination first, because it is the thing they chose. Reverse-geocoding
 * a point gives the borough it stands in, and a trip built from Thorpe Park was
 * calling itself "Runnymede" — which is true, and is not what anybody picked
 * (owner, 6 Sep 2026: "when I create a trip from Thorpe Park, it says
 * 'Runnymede all day'. It's supposed to say 'Thorpe Park'").
 *
 * A trip away has no destination — you are staying somewhere and going out from
 * it — so there the town is the right answer and comes next.
 */
function tripName(trip: TripDetail['trip']): string {
  const dest = trip.destination?.label?.split(',')[0]?.trim();
  if (dest) return dest.replace(/\s*\(centre\)\s*$/, '');
  return trip.locality ?? trip.place?.label?.split(',')[0] ?? trip.title ?? trip.origin.label.split(',')[0];
}

const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const clock = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mins = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim());
const money = (level?: number | null) => (level == null ? null : '£'.repeat(Math.max(1, Math.min(4, level))));

/** Which pill is lit. Null is Trip home. */
type Pill = 'activities' | 'food' | 'stay' | 'shortlist';
/**
 * Stay sits between Food and Shortlist, and only on a trip with nights in it —
 * a day out has nowhere to sleep by definition. With four across a 390px phone
 * the food label shortens to "Food", which is what the handoff draws (§15).
 */
const pillsFor = (withStay: boolean): { key: Pill; label: string; icon: IconName }[] => [
  { key: 'activities', label: 'Activities', icon: 'inspire' },
  { key: 'food', label: withStay ? 'Food' : 'Food & drink', icon: 'restaurant' },
  ...(withStay ? [{ key: 'stay' as Pill, label: 'Stay', icon: 'hotel' as IconName }] : []),
  { key: 'shortlist', label: 'Shortlist', icon: 'shortlist' },
];

/** The height of the tab bar the shell draws under this screen. */
const TABBAR = 70;

export function TripMapScreen({ d, section, household, onBack, onChanged, onMenu, onSection }: {
  d: TripDetail;
  /** Which view the sheet is showing: the day, the trip's places, or the group. */
  section: TripSection;
  household: HouseholdResponse | null;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onMenu: () => void;
  onSection: (s: TripSection) => void;
}) {
  const { width, height } = useViewport();
  const wide = width >= 900;
  const { setQuery } = useRouter();
  const { trip, days, shortlist, attendees } = d;

  const [pill, setPill] = useQueryState<Pill | null>('pill', null, asOneOf(['activities', 'food', 'stay', 'shortlist'] as const, null));
  // How you want to stay, and how far you will go. All of it in the address, so
  // "the beds by a station under a ten-minute walk" is a page somebody can send.
  const [placement, setPlacement] = useQueryState<StayPlacement>('where', 'plans', asOneOf(['plans', 'town', 'station'] as const, 'plans'));
  const [stayMode, setStayMode] = useQueryState<'driving' | 'walking'>('go', 'driving', asOneOf(['driving', 'walking'] as const, 'driving'));
  const [criteria, setCriteria] = useState(false);
  /** Which of the wizard's two questions is open (§16/17 then §18). */
  const [criteriaStep, setCriteriaStep] = useState<1 | 2>(1);
  /**
   * What was asked for. In the address, so a set of criteria somebody has
   * worked through is a page they can be sent — and so that coming back to the
   * sheet shows what they chose rather than the defaults again.
   */
  const [crit, setCrit] = useQueryState<string | null>('stay', null, asText);
  const criteriaState: StayCriteriaState = useMemo(() => {
    const d: StayCriteriaState = { maxAvgMin: 20, townMin: 15, maxTrainMin: 25, maxWalkMin: 10, budget: [80, 180], types: [], must: [], nice: [] };
    if (!crit) return d;
    try { return { ...d, ...JSON.parse(decodeURIComponent(crit)) }; } catch { return d; }
  }, [crit]);
  const setCriteriaState = (next: Partial<StayCriteriaState>) =>
    setCrit(encodeURIComponent(JSON.stringify({ ...criteriaState, ...next })));
  /** Who's coming, over whatever is on screen (handoff §12). */
  const [who, setWho] = useState(false);
  /** Which day of a holiday is being looked at — the day strip (handoff §13/14). */
  const [dayId, setDayId] = useQueryState<string | null>('day', null, asText);
  /**
   * A place on the map you have tapped and want to look around, instead of the
   * whole route. Its point and its name, both in the address, so "food around
   * Thorpe Park" is a page somebody can be sent.
   */
  const [around, setAround] = useQueryState<string | null>('around', null, asText);
  const [aroundName, setAroundName] = useQueryState<string | null>('aroundName', null, asText);
  const anchor = around ? { at: around, label: aroundName ?? 'here' } : null;
  const setAnchor = (a: { lat: number; lng: number; label: string } | null) => {
    setQuery({ around: a ? `${a.lat.toFixed(5)},${a.lng.toFixed(5)}` : null, aroundName: a?.label ?? null });
  };
  const [detour, setDetour] = useQueryState<string | null>('detour', null, asText);
  /** What was typed into "search along the route", and which category was picked. */
  const [q, setQ] = useQueryState<string | null>('q', null, asText);
  const [kindOf, setKindOf] = useQueryState<string | null>('type', null, asText);
  const [searching, setSearching] = useState(false);
  const maxDetourMin = Number(detour) || 15;

  const [detent, setDetent] = useState<Detent>('half');
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<TripAlongPlace | null>(null);
  /**
   * What the drawer is showing. One piece of state whatever was tapped — a row,
   * a pin on the map, a stay — because they are all the same question ("what is
   * this place?") and the drawer is the same drawer Places uses.
   */
  const [drawer, setDrawer] = useState<BrowseItem | null>(null);
  const openPlace = (p: TripAlongPlace) => setDrawer(alongToItem(p));
  const [error, setError] = useState<string | null>(null);

  // Every place this trip has touched, for the Places view and for the pins.
  const [places, setPlaces] = useState<{ places: TripPlace[]; counts: { all: number; do: number; eat: number; stay: number } } | null>(null);
  useEffect(() => { api.tripPlaces(trip.id).then(setPlaces).catch(() => null); }, [trip.id, shortlist.length, days.length]);

  // Browse: what is along the way. One fetch per (pill, scope, detour).
  const [along, setAlong] = useState<{ loading: boolean; places: TripAlongPlace[]; counts: { route: number }; error: string | null; degraded: { source: string; error: string }[]; hasRoute: boolean; beyond: number }>(
    { loading: false, places: [], counts: { route: 0 }, error: null, degraded: [], hasRoute: false, beyond: 0 },
  );
  const alongKey = pill && pill !== 'shortlist' && pill !== 'stay' ? `${pill}|${around ?? ''}|${maxDetourMin}|${q ?? ''}|${kindOf ?? ''}` : null;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!alongKey || alongKey === lastKey.current) return;
    lastKey.current = alongKey;
    setAlong((a) => ({ ...a, loading: true, error: null }));
    api.tripAlong(trip.id, { kind: pill === 'food' ? 'food' : 'things', maxDetourMin, around: around ?? undefined, aroundName: aroundName ?? undefined, q: [q, kindOf].filter(Boolean).join(' ') || undefined })
      .then((r) => setAlong({ loading: false, places: r.places, counts: r.counts, error: null, degraded: r.degradedSources ?? [], hasRoute: r.hasRoute, beyond: r.beyond ?? 0 }))
      .catch((e) => setAlong({ loading: false, places: [], counts: { route: 0 }, error: e.message, degraded: [], hasRoute: false, beyond: 0 }));
  }, [alongKey, trip.id, pill, around, aroundName, maxDetourMin, q, kindOf]);

  // Somewhere to sleep, ranked the way the criteria asked. Only fetched when
  // the Stay pill is lit — it is an Overpass call and sometimes a price call.
  const [stays, setStays] = useState<{ loading: boolean; results: Stay[]; spread: { minutes: number; between: [string, string]; places: string[] } | null; error: string | null }>(
    { loading: false, results: [], spread: null, error: null },
  );
  // Counted while the wizard is open as well as while the list is: the button
  // says how many match, and it cannot say it without asking.
  const stayKey = pill === 'stay' || criteria ? `${placement}|${stayMode}|${crit ?? ''}` : null;
  const lastStay = useRef<string | null>(null);
  useEffect(() => {
    if (!stayKey || stayKey === lastStay.current) return;
    lastStay.current = stayKey;
    setStays((v) => ({ ...v, loading: true, error: null }));
    api.tripStays(trip.id, {
      placement, mode: stayMode,
      maxAvgMin: criteriaState.maxAvgMin, townMin: criteriaState.townMin,
      maxTrainMin: criteriaState.maxTrainMin, maxWalkMin: criteriaState.maxWalkMin,
      budgetMax: criteriaState.budget[1], budgetMin: criteriaState.budget[0],
      types: criteriaState.types.join(',') || undefined,
      must: criteriaState.must.join(',') || undefined,
      nice: criteriaState.nice.join(',') || undefined,
    })
      .then((r) => setStays({ loading: false, results: r.results, spread: r.spread, error: null }))
      .catch((e) => setStays({ loading: false, results: [], spread: null, error: e.message }));
  }, [stayKey, trip.id, placement, stayMode, criteriaState]);

  const isTrip = trip.kind === 'trip';
  /**
   * Somewhere they are actually staying, as opposed to the middle of the town
   * standing in for one.
   *
   * The kind is the intended marker and older trips do not all carry it — this
   * one had a base labelled "Bath (centre)" with a kind of `hotel`, so the app
   * believed a hotel was booked and never offered to find one. The API writes
   * that suffix itself and refuses to claim a place that has it
   * (routes/trips.js `claimBase`), so the label is as good a signal as the kind
   * and there is no reason to trust only the one that was missing.
   */
  const base = trip.base && trip.base.kind !== 'centre' && !/\(centre\)\s*$/.test(trip.base.label ?? '')
    ? trip.base
    : null;
  const start = base && isTrip ? base : trip.origin;
  const dest = trip.destination ?? (trip.base?.lat != null ? trip.base : null);
  const day = (dayId ? days.find((x) => x.id === dayId) : null) ?? days[0] ?? null;
  const nights = isTrip && trip.startDate && trip.endDate
    ? Math.max(0, Math.round((+new Date(`${trip.endDate}T12:00:00`) - +new Date(`${trip.startDate}T12:00:00`)) / 86400000))
    : 0;
  /** Somewhere to sleep is only a question on a trip with a night in it. */
  const wantsStay = nights > 0;
  /** And it is an open question until a real bed is set as the base. */
  const stayChosen = !!base;
  /**
   * What has actually been planned. It is the argument for "near my plans" —
   * the wizard names the places it will rank against, because "best placed for
   * the 4 places you've planned" is only worth reading if it says which four.
   */
  const plannedDays = useMemo(() => days.filter((dd) => dd.slots.some((sl) => sl.stops.length)).length, [days]);
  const plannedNames = useMemo(() => {
    const seen = new Set<string>();
    for (const dd of days) for (const sl of dd.slots) for (const st of sl.stops) if (st.name) seen.add(st.name);
    return [...seen];
  }, [days]);
  const plannedCount = days.length > 1 ? plannedDays : plannedNames.length;

  // ---- the map ------------------------------------------------------------

  const markers: MapMarker[] = useMemo(() => {
    const out: MapMarker[] = [];
    if (start?.lat != null) {
      out.push({
        id: 'start', lat: start.lat as number, lng: start.lng as number, kind: isTrip && base ? 'base' : 'home',
        icon: isTrip && base ? 'bed' : 'home',
        label: isTrip && base ? `${base.label.split(',')[0]} · base` : `Home · ${trip.origin.label.split(',')[0]}`,
      });
    }
    if (dest?.lat != null && dest !== start) {
      out.push({
        id: 'dest', lat: dest.lat as number, lng: dest.lng as number, kind: 'dest', icon: 'flag', label: tripName(trip),
        selected: around === `${(dest.lat as number).toFixed(5)},${(dest.lng as number).toFixed(5)}`,
        // Tap where you are going, then pick a pill, and the search happens
        // there instead of all along the way.
        onPress: () => setAnchor({ lat: dest.lat as number, lng: dest.lng as number, label: tripName(trip) }),
      });
    }
    // Screen 15: a trip that wants a bed and has not got one shows where the
    // gap is, dashed, rather than leaving the map to imply everything is set.
    if (wantsStay && !stayChosen && !pill && trip.base?.lat != null) {
      out.push({
        id: 'stay-gap', lat: trip.base.lat as number, lng: trip.base.lng as number,
        kind: 'saved', icon: 'bed', label: 'Stay · not chosen',
        onPress: () => { setCriteriaStep(1); setCriteria(true); },
      });
    }
    if (pill === 'stay') {
      for (const st of stays.results.slice(0, 20)) {
        if (st.lat == null) continue;
        out.push({
          id: st.venueRef, lat: st.lat, lng: st.lng,
          kind: st.rank === 1 ? 'dest' : 'added',
          icon: 'bed',
          badge: st.rank ? String(st.rank) : null,
          label: selected === st.venueRef ? st.name : null,
          selected: selected === st.venueRef,
          onPress: () => { setSelected(st.venueRef); setDrawer(stayToItem(st)); },
        });
      }
    } else if (pill && pill !== 'shortlist') {
      for (const p of along.places.slice(0, 40)) {
        if (p.lat == null) continue;
        out.push({
          id: p.venueRef, lat: p.lat, lng: p.lng,
          kind: p.onDay ? 'added' : p.onShortlist ? 'saved' : 'browse',
          icon: pill === 'food' ? 'utensils' : 'sparkles',
          // Labelling forty pins is unreadable; the two nearest the route carry
          // their detour, as the handoff draws.
          label: selected === p.venueRef ? `${p.name} · ${p.detourMinutes} min` : null,
          selected: selected === p.venueRef,
          // A pin is the same thing as its row: tapping it opens the place
          // (owner, 6 Sep 2026 — it used to do nothing but highlight itself).
          // Opening a place must not move the sheet. Somebody looking at the
          // full map who taps a pin wants to come back to the full map when
          // they shut the drawer, not to half a screen of list (owner, 6 Sep
          // 2026).
          onPress: () => { setSelected(p.venueRef); openPlace(p); },
        });
      }
    } else {
      // Trip home, and the Shortlist pill: what is already on this trip.
      for (const p of places?.places ?? []) {
        if (p.lat == null || p.venueRef.startsWith('base:')) continue;
        if (pill === 'shortlist' && !p.shortlisted) continue;
        out.push({
          id: p.venueRef, lat: p.lat as number, lng: p.lng as number,
          kind: p.scheduled ? 'added' : 'saved',
          icon: p.group === 'eat' ? 'utensils' : p.group === 'stay' ? 'bed' : 'sparkles',
          // Only what is chosen, or what is actually on the day, says its name.
          // Forty labels over each other is a map you cannot read.
          label: selected === p.venueRef ? (p.name ?? null) : null,
          selected: selected === p.venueRef,
          onPress: () => { setSelected(p.venueRef); setDrawer(tripPlaceToItem(p)); setAnchor({ lat: p.lat as number, lng: p.lng as number, label: p.name ?? 'here' }); },
        });
      }
    }
    return out;
  }, [start?.lat, dest?.lat, pill, along.places, places, selected, isTrip, base?.label, wantsStay, stayChosen, stays.results]);

  const routes: MapRoute[] = useMemo(() => {
    if (start?.lat == null || dest?.lat == null || dest === start) return [];
    return [{ id: 'there', points: [{ lat: start.lat, lng: start.lng }, { lat: dest.lat, lng: dest.lng }] }];
  }, [start?.lat, start?.lng, dest?.lat, dest?.lng]);

  /**
   * What the chip on the map says. Browsing, it is what came back; on the trip
   * itself it is the drive there and what the stops have added to it.
   */
  const driveChip = (() => {
    if (pill === 'stay') return stays.results.length ? `${stays.results.length} to stay` : null;
    if (pill === 'shortlist') return `${(places?.places ?? []).filter((x) => x.shortlisted).length} saved`;
    if (pill) return along.loading ? null : `${along.places.length} ${along.hasRoute ? 'on the route' : 'nearby'}`;
    if (!dest || !start || dest === start) return null;
    const there = Math.max(1, Math.round(estimateMinutes(start, dest)));
    const added = (places?.places ?? []).filter((x) => x.scheduled && x.venueRef !== 'base').length;
    return added ? `${mins(there)} + ${added} stop${added === 1 ? '' : 's'}` : mins(there);
  })();

  const heights = detentHeights(height, wide ? 0 : TABBAR);
  const mapPadding = wide
    ? { top: 40, bottom: 40, left: 40, right: 460 }
    : { top: 96, bottom: heights[detent] + TABBAR + 56, left: 28, right: 28 };

  // ---- adding -------------------------------------------------------------

  const addToDay = useCallback(async (p: TripAlongPlace, leg: 'out' | 'back' | null, startTime: string | null) => {
    if (!day) return;
    try {
      await api.addStopToDay(trip.id, day.id, {
        venueRef: p.venueRef, name: p.name, lat: p.lat, lng: p.lng, category: p.category,
        startTime, slot: leg === 'back' ? 'evening' : undefined,
      });
      setAdding(null); setPill(null); await onChanged();
    } catch (e: any) { setError(e.message); }
  }, [day, trip.id, onChanged, setPill]);

  const shortlistIt = useCallback(async (p: TripAlongPlace) => {
    try {
      await api.addToShortlist(trip.id, { venueRef: p.venueRef, venueLabel: p.name, category: p.category, lat: p.lat, lng: p.lng });
      setAlong((a) => ({ ...a, places: a.places.map((x) => (x.venueRef === p.venueRef ? { ...x, onShortlist: !x.onShortlist } : x)) }));
      await onChanged();
    } catch (e: any) { setError(e.message); }
  }, [trip.id, onChanged]);

  // ---- the sheet ----------------------------------------------------------

  const party = attendees.length;
  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={() => (pill ? setPill(null) : onBack())}
        style={styles.round}
        accessibilityRole="button"
        accessibilityLabel={pill ? 'Back to the trip' : 'Trips'}
      >
        <Icon name="back" size={18} color={colors.ink} />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>{tripName(trip)}</Text>
          {party ? (
            <Pressable onPress={() => setWho(true)} style={styles.party} accessibilityRole="button" accessibilityLabel="Who's coming">
              <Icon name="household" size={13} color={colors.ink} />
              <Text style={styles.partyText}>+{party}</Text>
            </Pressable>
          ) : null}
        </View>
        {/* The dates of the whole trip, not one day of it: the day strip below
            says which day, and saying it twice made the header disagree with
            the picker (owner, 6 Sep 2026). */}
        <Text style={type.small} numberOfLines={1}>
          {(() => {
            const range = isTrip && trip.startDate && trip.endDate && trip.startDate !== trip.endDate;
            return [
              range ? `${fmtDate(trip.startDate!)} – ${fmtDate(trip.endDate!)}` : fmtDate(trip.startDate ?? trip.departAt),
              base ? base.label.split(',')[0] : isTrip ? null : 'from home',
              // Screen 15/19: a trip with nights and no bed says so on the line
              // people read first, and while the stay list is up it says what
              // they are doing rather than repeating the dates.
              pill === 'stay' ? 'choosing a stay' : wantsStay && !stayChosen ? 'no stay yet' : null,
              // The drive each way is on the chip on the map; on a trip away the
              // dates have the room instead, and the line was truncating.
              !range && !pill && dest && start ? `${mins(Math.max(1, Math.round(estimateMinutes(start, dest))))} each way` : null,
            ].filter(Boolean).join(' · ');
          })()}
        </Text>
      </View>
      {pill ? (
        <Pressable onPress={() => setPill(null)} style={styles.round} accessibilityRole="button" accessibilityLabel="Back to the trip">
          <Icon name="trips" size={18} color={colors.ink} />
        </Pressable>
      ) : (
        <Pressable onPress={onMenu} style={styles.round} accessibilityRole="button" accessibilityLabel="More">
          <Icon name="menu" size={18} color={colors.ink} />
        </Pressable>
      )}
    </View>
  );

  const body = pill === 'stay' ? (
    <StayList
      stays={stays}
      placement={placement}
      onPlacement={setPlacement}
      mode={stayMode}
      onMode={setStayMode}
      onCriteria={(step) => { setCriteriaStep(step); setCriteria(true); }}
      nights={nights}
      budget={criteriaState.budget}
      planned={plannedCount}
      selected={selected}
      onSelect={setSelected}
      onOpen={(st) => setDrawer(stayToItem(st))}
      onChoose={async (st) => {
        try {
          await api.setTripStay(trip.id, { venueRef: st.venueRef, label: st.name, lat: st.lat, lng: st.lng });
          setPill(null); await onChanged();
        } catch (e: any) { setError(e.message); }
      }}
    />
  ) : pill ? (
    <BrowseList
      pill={pill}
      along={along}
      shortlisted={(places?.places ?? []).filter((p) => p.shortlisted)}
      onUnshortlist={async (p) => {
        const item = shortlist.find((x) => x.venueRef === p.venueRef);
        if (!item) return;
        try { await api.removeFromShortlist(trip.id, item.id); await onChanged(); }
        catch (e: any) { setError(e.message); }
      }}
      anchorLabel={anchor?.label ?? null}
      onClearAnchor={() => setAnchor(null)}
      maxDetourMin={maxDetourMin}
      onDetour={(n) => setDetour(String(n))}
      selected={selected}
      onSelect={(ref) => setSelected(ref)}
      onOpen={openPlace}
      kindOf={kindOf}
      onKind={setKindOf}
      onAdd={setAdding}
      onShortlist={shortlistIt}
    />
  ) : (
    <SheetTabs section={section} counts={places?.counts.all ?? 0} onSection={onSection}>
      {section === 'places' ? <TripPlacesList data={places} onSelect={(ref) => { setSelected(ref); setDetent('half'); }} />
        : section === 'group' ? <View style={{ padding: spacing.lg }}><GroupPanel d={d} onChanged={onChanged} /></View>
          : (
            <>
              {/* The day strip, on a holiday only — a day out has one day and a
                  row of one chip is furniture (§13/14), and past a week it
                  gains the tabs above it (§21). */}
              {days.length > 1 ? (
                <Days days={days} chosen={day?.id ?? null} onPick={(id) => setDayId(id)} />
              ) : null}
              {/* The signpost (§15): a trip with nights and nowhere to sleep
                  says so, once, above the day — one ink banner, and the whole
                  of it opens the wizard. */}
              {wantsStay && !stayChosen ? (
                <StaySignpost
                  planned={plannedCount}
                  days={days.length}
                  weekNote={days.length > 8 ? 'week 1 so far' : null}
                  onFind={() => { setCriteriaStep(1); setCriteria(true); }}
                />
              ) : null}
              <TheDay d={d} day={day} onAdd={() => { setPill('food'); setDetent('half'); }} />
            </>
          )}
    </SheetTabs>
  );

  const pills = (
    <View style={[styles.pills, wide && { left: 24, right: undefined }]}>
      {pillsFor(wantsStay).map((p) => {
        const on = pill === p.key;
        // Shortlist is exclusive with the other two, and dims them (handoff §7).
        const dim = pill === 'shortlist' && p.key !== 'shortlist';
        return (
          <Pressable
            key={p.key}
            onPress={() => { setPill(on ? null : p.key); setSelected(null); setDetent('half'); }}
            style={[styles.pill, on && styles.pillOn, dim && { opacity: 0.45 }]}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
          >
            <Icon name={p.icon} size={15} color={on ? colors.primaryFg : colors.ink} />
            <Text style={[styles.pillText, on && { color: colors.primaryFg }]}>{p.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceMuted }}>
      <MapGL
        markers={markers}
        routes={routes}
        padding={mapPadding}
        fitKey={`${pill ?? 'home'}:${markers.length}`}
        focusId={selected}
        // A tap on the map clears the chosen pin and nothing else. It used to
        // shrink the sheet too, which read well and was in fact the bug that
        // stopped the sheet opening at all: a drag that ends over the map makes
        // MapLibre fire a click, so every upward drag was undone the moment it
        // finished. The sheet is moved by the sheet.
        onMapPress={() => setSelected(null)}
      />

      {/* The drive chip (handoff §01): how long the day's driving is, and what
          the stops added to it. Top right, clear of the status bar. */}
      {!wide && driveChip ? (
        <View style={styles.chipWrap} pointerEvents="none">
          <View style={styles.driveChip}>
            <Icon name={trip.travelMode === 'transit' ? 'transit' : 'driving'} size={13} color={colors.ink} />
            <Text style={styles.driveChipText}>{driveChip}</Text>
          </View>
        </View>
      ) : null}

      {/* The nudge and the search pill, both only when the map has the screen. */}
      {!wide && detent === 'peek' ? (
        <View style={styles.searchWrap} pointerEvents="box-none">
          <Pressable onPress={() => setSearching(true)} style={styles.search} accessibilityRole="button">
            <Icon name="search" size={16} color={colors.inkMuted} />
            <Text style={[type.small, { flex: 1 }]}>{q || (along.hasRoute ? 'Search along the route' : 'Search nearby')}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* At full the sheet has the screen and there is no map left to pin, so
          the pills go with it (owner, 6 Sep 2026: "When I'm in full bottom
          drawer mode… I should not see the activities, food, and drink pills").
          The sheet's own header carries the way back. */}
      {!wide && detent !== 'full' ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: heights[detent] + TABBAR + 10 }} pointerEvents="box-none">
          {!pill && detent === 'peek' ? <Text style={styles.nudge}>Pick one — we'll search along the route</Text> : null}
          {pills}
        </View>
      ) : null}

      {error ? <View style={styles.errorWrap}><StatusLine tone="warn">{error}</StatusLine></View> : null}

      {wide ? (
        // A wide window is the same thing side by side: the map keeps the room
        // it needs and the sheet becomes a panel that never has to be dragged.
        <View style={styles.panel}>
          {pills}
          <View style={styles.panelCard}>
            {header}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing.xl }}>{body}</ScrollView>
          </View>
        </View>
      ) : (
        <BottomSheet detent={detent} onDetent={setDetent} header={header} screenHeight={height} insetBottom={TABBAR}>
          {body}
        </BottomSheet>
      )}

      <VenueDrawer
        item={drawer}
        baseLabel={trip.locality ?? trip.origin.label.split(',')[0]}
        onClose={() => setDrawer(null)}
        addLabel="Add to the day"
        addIcon="add"
        added={drawer ? along.places.find((x) => x.venueRef === drawer.venueRef)?.onDay : false}
        shortlisted={drawer ? along.places.find((x) => x.venueRef === drawer.venueRef)?.onShortlist : false}
        // Only a candidate can be added to a day; a stay is chosen, and
        // something already on the trip is already on it.
        onAdd={along.places.some((x) => x.venueRef === drawer?.venueRef)
          ? (item) => { const p = along.places.find((x) => x.venueRef === item.venueRef); setDrawer(null); if (p) setAdding(p); }
          : undefined}
        onShortlist={along.places.some((x) => x.venueRef === drawer?.venueRef)
          ? async (item) => { const p = along.places.find((x) => x.venueRef === item.venueRef); if (p) await shortlistIt(p); }
          : undefined}
      />

      {searching ? (
        <SearchAlong
          hasRoute={along.hasRoute}
          value={q ?? ''}
          onClose={() => setSearching(false)}
          onSearch={(text, category, forFood) => {
            setSearching(false);
            setQ(text || null);
            setKindOf(category);
            setPill(forFood ? 'food' : 'activities');
            setDetent('half');
          }}
        />
      ) : null}

      {who ? (
        <WhosComing
          household={household}
          attending={attendees.map((a) => a.id)}
          onClose={() => setWho(false)}
          onSave={async (ids) => { try { await api.setTripAttendees(trip.id, ids); setWho(false); await onChanged(); } catch (e: any) { setError(e.message); } }}
        />
      ) : null}

      {criteria ? (
        <StayCriteria
          step={criteriaStep} onStep={setCriteriaStep}
          placement={placement} onPlacement={setPlacement}
          mode={stayMode} onMode={setStayMode}
          nights={nights} startDate={trip.startDate} endDate={trip.endDate}
          count={stays.results.length} loading={stays.loading}
          town={trip.locality ?? tripName(trip)}
          planned={plannedCount}
          plannedNames={plannedNames}
          line={null}
          criteria={criteriaState}
          onCriteria={setCriteriaState}
          onClose={() => setCriteria(false)}
          onShow={() => { setCriteria(false); setPill('stay'); setDetent('half'); }}
        />
      ) : null}

      {adding ? (
        <AddSheet
          place={adding}
          trip={d}
          party={party}
          onCancel={() => setAdding(null)}
          onSave={addToDay}
        />
      ) : null}
    </View>
  );
}

/** The straight-line minutes the header shows before anything is routed. */
function estimateMinutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h)) * 1.25;
  return km > 15 ? (km / 55) * 60 + 5 : (km / 28) * 60 + 5;
}

// ---------------------------------------------------------------------------
// Trip home: the day
// ---------------------------------------------------------------------------

/** Day · Places · Group, inside the sheet — so the map stays the screen. */
function SheetTabs({ section, counts, onSection, children }: {
  section: TripSection; counts: number; onSection: (s: TripSection) => void; children: React.ReactNode;
}) {
  const tabs: { value: TripSection; label: string }[] = [
    { value: 'itinerary', label: 'The day' },
    { value: 'places', label: `Places${counts ? ` · ${counts}` : ''}` },
    { value: 'group', label: 'Group' },
  ];
  const on = tabs.some((t) => t.value === section) ? section : 'itinerary';
  return (
    <>
      <View style={styles.tabs}>
        {tabs.map((t) => (
          <Pressable
            key={t.value}
            onPress={() => onSection(t.value)}
            style={[styles.tab, on === t.value && styles.tabOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: on === t.value }}
          >
            <Text numberOfLines={1} style={[styles.tabText, on === t.value && { color: colors.primaryFg }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {children}
    </>
  );
}

function TheDay({ d, day, onAdd }: { d: TripDetail; day: TripDay | null; onAdd: () => void }) {
  const { trip, days } = d;
  const isTrip = trip.kind === 'trip';
  const stops = (day?.slots ?? []).flatMap((s) => s.stops);
  const dayIndex = day ? days.findIndex((x) => x.id === day.id) : -1;
  const dest = trip.destination ?? trip.base;
  const back = trip.returnAt ? clock(trip.returnAt) : trip.dayEnd ?? null;

  return (
    <View style={{ paddingHorizontal: 16 }}>
      {/* The booking card is gone (owner, 6 Sep 2026). It repeated the title
          word for word, its chevron went nowhere, and it was the thing pushing
          "Add something along the way" below the fold — which is the one
          control the welcome screen exists for. */}
      <Text style={styles.kicker}>
        {days.length > 1 && day
          ? `${new Date(`${day.date}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric' })} · day ${dayIndex + 1} of ${days.length}${stops.length ? ` · ${stops.length} stop${stops.length === 1 ? '' : 's'}` : ''}`
          : stops.length ? `The day · ${stops.length} stop${stops.length === 1 ? '' : 's'}` : 'The day'}
      </Text>

      <Beat time={isTrip ? trip.dayStart ?? null : clock(trip.departAt)} icon="driving" title="Leave home"
        detail={[trip.origin.label.split(',')[0], dest ? tripName(trip) : null].filter(Boolean).join(' → ')} />
      {stops.map((s) => (
        <Beat key={s.id} time={s.startTime} icon="place" title={s.name} detail={s.dwellMinutes ? mins(s.dwellMinutes) : null} />
      ))}
      {!stops.length && dest ? <Beat time={null} icon="pinned" title={tripName(trip)} detail={isTrip ? null : 'All day'} /> : null}
      <Beat time={back} icon="home" title="Head home" detail={null} last />

      <Pressable onPress={onAdd} style={styles.cta} accessibilityRole="button">
        <Icon name="add" size={17} color={colors.ink} />
        <Text style={styles.ctaText}>Add something along the way</Text>
      </Pressable>
    </View>
  );
}

function Beat({ time, icon, title, detail, last }: { time: string | null; icon: IconName; title: string; detail: string | null; last?: boolean }) {
  return (
    <View style={styles.beat}>
      <Text style={styles.beatTime}>{time ?? ''}</Text>
      <View style={{ alignItems: 'center' }}>
        <View style={styles.beatDot}><Icon name={icon} size={15} color={colors.accent} /></View>
        {!last ? <View style={styles.beatLine} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 6, paddingBottom: last ? 0 : 10, gap: 1 }}>
        <Text style={styles.beatTitle} numberOfLines={2}>{title}</Text>
        {detail ? <Text style={type.small} numberOfLines={1}>{detail}</Text> : null}
      </View>
    </View>
  );
}

function TripPlacesList({ data, onSelect }: { data: { places: TripPlace[] } | null; onSelect: (ref: string) => void }) {
  if (!data) return <Text style={[type.small, { padding: spacing.lg }]}>Loading…</Text>;
  if (!data.places.length) return <View style={{ padding: spacing.lg }}><Card><Text style={type.small}>Nothing on this trip yet. Pick a pill above and search along the route.</Text></Card></View>;
  return (
    <View style={{ paddingHorizontal: 16 }}>
      {data.places.map((p) => (
        <Pressable key={p.venueRef} onPress={() => onSelect(p.venueRef)} style={styles.row} accessibilityRole="button">
          <VenueThumb name={p.name} image={p.image} category={p.category} width={56} height={56} rounded={6} credit={false} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={styles.rowName} numberOfLines={1}>{p.name ?? 'A place'}</Text>
            <Text style={type.small} numberOfLines={1}>
              {[p.day, p.scheduled ? 'on the day' : p.shortlisted ? 'shortlisted' : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Icon name={p.scheduled ? 'booked' : 'shortlisted'} size={17} color={p.scheduled ? colors.accent : colors.inkMuted} />
        </Pressable>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

const DETOURS = [5, 10, 15, 30];

function BrowseList({ pill, along, shortlisted, onUnshortlist, anchorLabel, onClearAnchor, maxDetourMin, onDetour, selected, onSelect, onOpen, onAdd, onShortlist, kindOf, onKind }: {
  pill: Pill;
  along: { loading: boolean; places: TripAlongPlace[]; counts: { route: number }; error: string | null; degraded: { source: string; error: string }[]; hasRoute: boolean; beyond: number };
  shortlisted: TripPlace[];
  onUnshortlist: (p: TripPlace) => Promise<void>;
  /** The name of the place being looked around, when one has been tapped. */
  anchorLabel: string | null;
  onClearAnchor: () => void;
  maxDetourMin: number;
  onDetour: (n: number) => void;
  selected: string | null;
  onSelect: (ref: string) => void;
  /** Tapping the row opens the place over the map, the way Places does. */
  onOpen: (p: TripAlongPlace) => void;
  onAdd: (p: TripAlongPlace) => void;
  onShortlist: (p: TripAlongPlace) => Promise<void>;
  kindOf: string | null;
  onKind: (k: string | null) => void;
}) {
  const [openDetour, setOpenDetour] = useState(false);
  const [openKind, setOpenKind] = useState(false);

  if (pill === 'shortlist') {
    return (
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={[type.small, { paddingVertical: spacing.sm }]}>
          {shortlisted.length ? `${shortlisted.length} saved · ring ahead, then Add the one you want` : 'Nothing saved for this trip yet.'}
        </Text>
        {shortlisted.map((p) => (
          <View key={p.venueRef} style={styles.row}>
            <VenueThumb name={p.name} image={p.image} category={p.category} width={56} height={56} rounded={6} credit={false} />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text style={styles.rowName} numberOfLines={1}>{p.name ?? 'A place'}</Text>
              <Text style={type.small} numberOfLines={1}>{p.day ?? 'no time yet'}</Text>
              <View style={styles.rowActions}>
                {/* The handoff puts a phone button here, and it is the right
                    idea — ringing ahead is what a shortlist is for. It is not
                    drawn yet because nothing on a trip place carries a number:
                    the owned record has no phone column and a provider's is
                    rented, fetched at display. The drawer opens on the row and
                    has the number in it. */}
                {/* Here the bookmark takes it off the list (handoff §07). */}
                <Pressable onPress={() => onUnshortlist(p)} hitSlop={8} style={styles.bookmark} accessibilityRole="button" accessibilityLabel={`Take ${p.name ?? 'this'} off the shortlist`}>
                  <Icon name="shortlisted" size={17} color={colors.ink} fill />
                </Pressable>
              </View>
            </View>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View>
      {/* The scope chips. Before one is chosen both are offered plainly; once
          one is, the other folds away and the chosen one becomes a dropdown. */}
      {/* One control for how far, and a second only when you have tapped
          somewhere to look around. "Near the end" is gone: it asked somebody to
          hold a picture of the route in their head, and the chip did not even
          show the minutes they had chosen. */}
      <View style={styles.chips}>
        <Chip
          label={anchorLabel ? `Within ${maxDetourMin} min` : `${along.hasRoute ? 'Along the route' : 'Within'} · ${maxDetourMin} min`}
          on
          chevron
          onPress={() => setOpenDetour((v) => !v)}
        />
        {anchorLabel ? <Chip label={`Around ${anchorLabel}`} on onClear={onClearAnchor} /> : null}
        <Chip label={kindOf ? cap(kindOf) : 'Type'} on={!!kindOf} chevron onPress={() => setOpenKind((v) => !v)} />
      </View>

      {openKind ? (
        <View style={styles.dropdown}>
          <Text style={styles.kicker}>{pill === 'food' ? 'Food & drink' : 'Things to do'}{along.hasRoute ? ' · along the route' : ' · nearby'}</Text>
          <Pressable onPress={() => { onKind(null); setOpenKind(false); }} style={styles.optRow} accessibilityRole="radio" accessibilityState={{ checked: !kindOf }}>
            <Text style={[type.body, { flex: 1 }]}>Everything</Text>
            {!kindOf ? <Icon name="check" size={16} color={colors.accent} /> : null}
          </Pressable>
          {(pill === 'food' ? FOOD_KINDS : THING_KINDS).map((k) => (
            <Pressable key={k} onPress={() => { onKind(k); setOpenKind(false); }} style={styles.optRow} accessibilityRole="radio" accessibilityState={{ checked: kindOf === k }}>
              <Text style={[type.body, { flex: 1 }]}>{cap(k)}</Text>
              {kindOf === k ? <Icon name="check" size={16} color={colors.accent} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {openDetour ? (
        <View style={styles.dropdown}>
          <Text style={styles.kicker}>{anchorLabel ? `How far from ${anchorLabel}` : along.hasRoute ? 'How far off the route' : 'How far away'}</Text>
          {DETOURS.map((n) => (
            <Pressable key={n} onPress={() => { onDetour(n); setOpenDetour(false); }} style={styles.optRow} accessibilityRole="radio" accessibilityState={{ checked: n === maxDetourMin }}>
              <Text style={[type.body, { flex: 1 }]}>Up to {n} minutes</Text>
              {n === maxDetourMin ? <Icon name="check" size={16} color={colors.accent} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {along.loading ? <Text style={[type.small, { padding: spacing.lg }]}>Looking along the route…</Text> : null}
      {!along.loading && along.degraded.length && along.places.length ? (
        <Text style={[type.tiny, { paddingHorizontal: 16, paddingTop: 8 }]}>
          {along.degraded.map((x) => x.source).join(' and ')} did not answer, so some of these have no reviews.
        </Text>
      ) : null}
      {along.error ? <View style={{ padding: spacing.lg }}><StatusLine tone="warn">{along.error}</StatusLine></View> : null}
      {!along.loading && !along.error && !along.places.length ? (
        <View style={{ padding: spacing.lg }}>
          <Card>
            {/* A blank list has a reason, and the reason is usually a source
                that did not answer. Saying which one, in plain words, is the
                difference between "there is nothing here" and "we could not
                look" (owner, 5 Sep 2026). */}
            <Text style={type.small}>
              {along.degraded.length
                ? `Nothing along this route yet — ${along.degraded.map((x) => x.source).join(' and ')} did not answer.`
                : 'Nothing found along this route yet. Widen the detour, or try Anywhere.'}
            </Text>
          </Card>
        </View>
      ) : null}

      <View style={{ paddingHorizontal: 16 }}>
        {along.places.map((p) => (
          <Pressable key={p.venueRef} onPress={() => onOpen(p)} style={[styles.row, selected === p.venueRef && styles.rowOn]} accessibilityRole="button">
            <VenueThumb name={p.name} photos={p.photos} category={p.category} experiences={p.experiences} width={56} height={56} rounded={6} credit={false} />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text style={styles.rowName} numberOfLines={1}>{p.name}</Text>
              {/* Type · price · the stars, on one line and never wrapping the
                  rating on its own (handoff § Row layout). */}
              <View style={styles.rowMeta}>
                <Text style={type.small} numberOfLines={1}>
                  {[p.category ? cap(p.category) : null, money(p.priceLevel)].filter(Boolean).join(' · ')}
                </Text>
                {p.rating != null ? (
                  <Stars value={p.rating} size={12}>
                    <Text style={styles.ratingText}>{p.rating.toFixed(1)}{p.ratingCount ? ` (${p.ratingCount >= 1000 ? `${(p.ratingCount / 1000).toFixed(1)}k` : p.ratingCount})` : ''}</Text>
                  </Stars>
                ) : <Text style={type.tiny}>no reviews yet</Text>}
              </View>
              {/* The number the whole design turns on — and it says it is a
                  reckoning, not a routed answer (owner, 6 Sep 2026). */}
              {/* "Off route" only where there is a route to be off. A trip away
                  has a base and nowhere else to be, so the same number is named
                  for what it is: how far out of your way. */}
              <Text style={styles.detour} numberOfLines={1}>
                {p.detourMinutes != null
                  ? `about ${p.detourMinutes} min ${anchorLabel ? `from ${anchorLabel}` : along.hasRoute ? 'off route' : 'away'}`
                  : anchorLabel ? `near ${anchorLabel}` : along.hasRoute ? 'off the route' : 'nearby'}
                <Text style={{ color: colors.inkMuted, fontWeight: '400' }}>{` (${p.detourMiles} mi)`}</Text>
              </Text>
              {/* Bookmark and Add sit beside each other, at the bottom right of
                  the row, as the handoff draws them — they were stacked. */}
              <View style={styles.rowActions}>
                <Pressable onPress={() => onShortlist(p)} hitSlop={8} style={styles.bookmark} accessibilityRole="button" accessibilityLabel={p.onShortlist ? 'Remove from the shortlist' : 'Save to the shortlist'}>
                  <Icon name={p.onShortlist ? 'shortlisted' : 'shortlist'} size={17} color={colors.ink} fill={p.onShortlist} />
                </Pressable>
                <Pressable onPress={() => onAdd(p)} style={styles.add} accessibilityRole="button">
                  <Icon name={p.onDay ? 'check' : 'add'} size={13} color={colors.ink} />
                  <Text style={styles.addText}>{p.onDay ? 'Added' : 'Add'}</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        ))}

        {/* What the corridor left out, and the one tap that brings it back. A
            tight corridor is right and a silently short list is not: 17 places
            a little further off should be an offer, not a disappearance. */}
        {!along.loading && along.beyond && maxDetourMin < 30 ? (
          <Pressable
            onPress={() => onDetour(DETOURS[Math.min(DETOURS.length - 1, DETOURS.indexOf(maxDetourMin) + 1)] ?? 30)}
            style={{ paddingVertical: spacing.md }}
            accessibilityRole="button"
          >
            <Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>
              {`${along.beyond} more a little further off the route — look up to ${DETOURS[Math.min(DETOURS.length - 1, DETOURS.indexOf(maxDetourMin) + 1)] ?? 30} min out →`}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]/g, ' ');

/** Something already on the trip, in the drawer's shape. */
function tripPlaceToItem(p: TripPlace): BrowseItem {
  return {
    id: p.venueRef, venueRef: p.venueRef, name: p.name ?? 'A place', category: p.category ?? 'attraction',
    lat: p.lat ?? 0, lng: p.lng ?? 0, dwellMinutes: p.dwellMinutes ?? 0, reasons: [], justification: null,
    startsAt: null, endsAt: null, pinned: false, source: p.venueRef.split(':')[0],
    cuisines: [], experiences: [], address: null, website: null, openingHours: null,
  };
}

/** A bed, in the drawer's shape. */
function stayToItem(s: Stay): BrowseItem {
  return {
    id: s.venueRef, venueRef: s.venueRef, name: s.name, category: 'hotel',
    lat: s.lat, lng: s.lng, dwellMinutes: 0, reasons: [], justification: null,
    startsAt: null, endsAt: null, pinned: false, source: s.venueRef.split(':')[0],
    cuisines: [], experiences: [], address: typeof s.address === 'string' ? s.address : null,
    website: s.website ?? null, openingHours: s.openingHours ?? null,
  };
}

/** A candidate, in the shape the drawer every other screen uses already reads. */
function alongToItem(p: TripAlongPlace): BrowseItem {
  return {
    id: p.venueRef, venueRef: p.venueRef, name: p.name, category: p.category ?? 'attraction',
    lat: p.lat, lng: p.lng, dwellMinutes: 0, reasons: [], justification: null,
    startsAt: null, endsAt: null, pinned: false, source: p.source,
    cuisines: p.cuisines ?? [], experiences: p.experiences ?? [],
    address: p.address, website: p.website, openingHours: p.openingHours,
  };
}

function Chip({ label, on, chevron, onPress, onClear }: { label: string; on?: boolean; chevron?: boolean; onPress?: () => void; onClear?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[styles.chipText, on && { color: colors.primaryFg }]} numberOfLines={1}>{label}</Text>
      {chevron ? <Icon name="expand" size={13} color={on ? colors.primaryFg : colors.ink} /> : null}
      {onClear ? (
        <Pressable onPress={onClear} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Search the whole route instead of around ${label}`}>
          <Icon name="close" size={13} color={on ? colors.primaryFg : colors.ink} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/** The kinds a browse list can be narrowed to (handoff §06). Words, not tags. */
const FOOD_KINDS = ['pub', 'cafe', 'restaurant', 'bakery', 'bar', 'ice cream'];
const THING_KINDS = ['walk', 'park', 'castle', 'museum', 'beach', 'viewpoint', 'playground', 'farm', 'gallery'];

/**
 * Search along the route (handoff §08): the sheet at the top, a field, and six
 * ways in for somebody who does not know what to type. Tapping a category lands
 * in Browse with it set; typing searches the corridor.
 */
function SearchAlong({ hasRoute, value, onClose, onSearch }: {
  hasRoute: boolean; value: string; onClose: () => void;
  onSearch: (text: string, category: string | null, food: boolean) => void;
}) {
  const [text, setText] = useState(value);
  const { width, height, framed, origin } = useViewport();
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height } : null;
  const rows: { label: string; hint: string; icon: IconName; category: string | null; food: boolean }[] = [
    { label: 'Outdoors', hint: 'Walks · parks · viewpoints', icon: 'park', category: 'walk', food: false },
    { label: 'Food & drink', hint: 'Pubs · cafés · restaurants', icon: 'restaurant', category: null, food: true },
    { label: 'Attractions', hint: 'Castles · museums · viewpoints', icon: 'castle', category: 'castle', food: false },
    { label: 'For kids', hint: 'Playgrounds · farms · soft play', icon: 'playground', category: 'playground', food: false },
    { label: 'Shopping', hint: 'Outlets · farm shops', icon: 'shopping', category: 'shopping', food: false },
    { label: 'Fuel & services', hint: 'Petrol · EV charging · loos', icon: 'driving', category: 'fuel', food: false },
  ];
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[{ flex: 1 }, frameBox]}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.searchSheet}>
          <Row style={{ gap: 10 }}>
            <View style={styles.searchField}>
              <Icon name="search" size={16} color={colors.inkMuted} />
              <TextInput
                value={text}
                onChangeText={setText}
                onSubmitEditing={() => onSearch(text.trim(), null, false)}
                autoFocus
                returnKeyType="search"
                placeholder={hasRoute ? 'Search along the route' : 'Search nearby'}
                placeholderTextColor={colors.inkFaint}
                style={styles.searchInput}
                accessibilityLabel="Search"
              />
              {text ? (
                <Pressable onPress={() => setText('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear">
                  <Icon name="close" size={15} color={colors.inkMuted} />
                </Pressable>
              ) : null}
            </View>
            <Pressable onPress={onClose} accessibilityRole="button"><Text style={[type.small, { fontWeight: '600' }]}>Cancel</Text></Pressable>
          </Row>
          <Text style={styles.kicker}>{hasRoute ? "Along the day's route" : 'Around this trip'}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">
            {rows.map((r) => (
              <Pressable key={r.label} onPress={() => onSearch('', r.category, r.food)} style={styles.searchRow} accessibilityRole="button">
                <View style={styles.searchTile}><Icon name={r.icon} size={18} /></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowName}>{r.label}</Text>
                  <Text style={type.tiny}>{r.hint}</Text>
                </View>
                <Icon name="more" size={16} color={colors.inkMuted} />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The day strip on a holiday (handoff §13/14). Selecting a day re-scopes the
 * timeline; a green dot marks the days that have something on them, so the
 * empty ones are visible without opening each.
 */
/**
 * The day strip, and the week tabs above it once a holiday runs past a week
 * (Hotels 2 §21). The owner asked what a fortnight would do: sixteen 44px chips
 * scroll off the edge and nothing tells you where you are in the trip, so over
 * eight days the strip is cut into weeks, a segmented control picks the week,
 * and the chips shrink to 38px so a week fits without scrolling. The green dot
 * under a day means something is planned on it, and it survives the split.
 */
function Days({ days, chosen, onPick }: { days: TripDay[]; chosen: string | null; onPick: (id: string) => void }) {
  const weeks = useMemo(() => weeksOf(days), [days]);
  const chosenWeek = Math.max(0, weeks.findIndex((w) => w.days.some((d) => d.id === chosen)));
  const [week, setWeek] = useState(chosenWeek);
  useEffect(() => { setWeek(chosenWeek); }, [chosenWeek]);
  const shown = weeks.length > 1 ? (weeks[week] ?? weeks[0]).days : days;
  return (
    <>
      {weeks.length > 1 ? (
        <ScrollView horizontal={weeks.length > 3} showsHorizontalScrollIndicator={false}>
          <View style={[styles.weeks, weeks.length > 3 && { minWidth: 340 }]}>
            {weeks.map((w, i) => {
              const on = i === week;
              return (
                <Pressable
                  key={w.label}
                  onPress={() => { setWeek(i); const first = w.days[0]; if (first) onPick(first.id); }}
                  style={[styles.week, on && styles.weekOn, w.days.length < 4 && { flex: 0.8 }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.weekName, on && { color: colors.primaryFg }]} numberOfLines={1}>{w.label}</Text>
                  <Text style={[styles.weekWhen, on && { color: '#C9C5C2' }]} numberOfLines={1}>{w.when}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : null}
      <DayStrip days={shown} chosen={chosen} onPick={onPick} narrow={weeks.length > 1} />
    </>
  );
}

function DayStrip({ days, chosen, onPick, narrow }: { days: TripDay[]; chosen: string | null; onPick: (id: string) => void; narrow?: boolean }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
      {days.map((dd) => {
        const on = dd.id === chosen;
        const planned = dd.slots.some((sl) => sl.stops.length);
        const d = new Date(`${dd.date}T12:00:00`);
        return (
          <Pressable key={dd.id} onPress={() => onPick(dd.id)} style={[styles.dayChip, narrow && { width: 38 }, on && styles.dayChipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            <Text style={[styles.dayChipDow, on && { color: colors.primaryFg }]}>{d.toLocaleDateString([], { weekday: 'short' })}</Text>
            <Text style={[styles.dayChipNum, narrow && { fontSize: 14 }, on && { color: colors.primaryFg }]}>{d.getDate()}</Text>
            {planned ? <View style={[styles.dayDot, on && { backgroundColor: colors.primaryFg }]} /> : <View style={styles.dayDotGap} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * Who's coming (handoff §12), from the +3 pill on any screen. It is not a
 * settings page: tickets, table sizes and the car all follow this, which is why
 * the note says so and why it is one tap from everywhere.
 */
function WhosComing({ household, attending, onClose, onSave }: {
  household: HouseholdResponse | null; attending: string[];
  onClose: () => void; onSave: (ids: string[]) => Promise<void>;
}) {
  const [ids, setIds] = useState<string[]>(attending);
  const [busy, setBusy] = useState(false);
  const { width, height, framed, origin } = useViewport();
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height } : null;
  const members = household?.members ?? [];
  const adults = members.filter((m) => ids.includes(m.id) && !m.isMinor).length;
  const children = members.filter((m) => ids.includes(m.id) && m.isMinor).length;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[{ flex: 1, justifyContent: 'flex-end' }, frameBox]}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.addSheet, { maxHeight: '82%' }]}>
          <View style={styles.grabSmall} />
          <View style={styles.addHead}>
            <Text style={styles.addTitle}>Who's coming?</Text>
            <Pressable onPress={async () => { if (busy) return; setBusy(true); try { await onSave(ids); } finally { setBusy(false); } }} accessibilityRole="button">
              <Text style={[type.small, { fontWeight: '700', color: colors.accent }]}>{busy ? 'Saving…' : 'Done'}</Text>
            </Pressable>
          </View>
          <Text style={type.small}>Tickets, table sizes and the car all follow this.</Text>
          <ScrollView contentContainerStyle={{ gap: 4 }}>
            {members.map((m, i) => {
              const on = ids.includes(m.id);
              return (
                <Pressable
                  key={m.id}
                  onPress={() => setIds((v) => (on ? v.filter((x) => x !== m.id) : [...v, m.id]))}
                  style={[styles.whoRow, !on && { opacity: 0.6 }]}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on }}
                >
                  <Avatar name={m.name} index={i} size={44} url={m.avatarUrl} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.rowName} numberOfLines={1}>{m.name}</Text>
                    <Text style={type.tiny}>{m.isMinor ? 'Child' : 'Adult'}</Text>
                  </View>
                  <View style={[styles.check, on && styles.checkOn]}>{on ? <Icon name="check" size={14} color={colors.primaryFg} strokeWidth={3} /> : null}</View>
                </Pressable>
              );
            })}
          </ScrollView>
          <Text style={type.tiny}>
            {ids.length} going · {adults} adult{adults === 1 ? '' : 's'}{children ? `, ${children} child${children === 1 ? '' : 'ren'}` : ''}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Stay
// ---------------------------------------------------------------------------

/**
 * The signpost (Hotels 2, screen 15). A trip made with "find us somewhere" has
 * nowhere to sleep, and the day is not the place to discover that.
 *
 * One ink banner, exactly as drawn, and the whole of it is the tap: the two
 * stacked buttons that stood here were an earlier reading, and the handoff
 * replaces them with a single row that says how much of the trip is planned —
 * because that is what makes the answer better. "Near my plans" improves as the
 * plans fill in, so the count is the argument for tapping it.
 */
function StaySignpost({ planned, days, weekNote, onFind }: {
  planned: number; days: number; weekNote?: string | null; onFind: () => void;
}) {
  return (
    <Pressable onPress={onFind} style={styles.signpost} accessibilityRole="button" accessibilityLabel="Find your stay">
      <View style={styles.signIcon}><Icon name="hotel" size={19} color={colors.ink} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={styles.signTitle}>Find your stay</Text>
        <Text style={styles.signSub} numberOfLines={1}>
          {planned
            ? `${planned} of ${days} day${days === 1 ? '' : 's'} planned · ${weekNote ?? "we'll place you near them"}`
            : `Nothing planned yet · we'll place you near the middle`}
        </Text>
      </View>
      <Icon name="more" size={18} color={colors.primaryFg} />
    </Pressable>
  );
}

const PLACEMENTS: { key: StayPlacement; icon: IconName; title: string; blurb: string }[] = [
  { key: 'plans', icon: 'place', title: 'Near my plans', blurb: 'Best placed for the {n} places you’ve planned' },
  { key: 'town', icon: 'home', title: 'Near {town}', blurb: 'Your trip’s area · change the town' },
  { key: 'station', icon: 'transit', title: 'Near a station', blurb: 'Further out, cheaper, train a short walk' },
];

/** Everything the wizard asks for, and all of it in the address. */
export type StayCriteriaState = {
  maxAvgMin: number; townMin: number; maxTrainMin: number; maxWalkMin: number;
  budget: [number, number]; types: string[]; must: string[]; nice: string[];
};

/** The three answers screen 16 offers for "how far", whichever tile is lit. */
const MINUTE_CHIPS = [15, 20, 30];
/** The kinds of place the open map and the price source actually distinguish. */
const STAY_TYPES = ['Hotel', 'House or flat', 'B&B', 'Farm stay', 'Villa with pool'];
/** Filters. A stay without the tag does not appear. */
const MUST_HAVES = ['Pool', 'Kitchen', 'Parking', 'Family room', 'Breakfast', 'Air con', 'Pet-friendly'];
/** Reorders, doesn't filter — the words under the kicker say so on screen. */
const NICE_TO_HAVES = ['Sea view', 'Garden', 'Quiet', 'Walkable to dinner'];

/** The three-segment progress bar at the top of every wizard step. */
function Progress({ step, of }: { step: number; of: number }) {
  return (
    <Row style={{ gap: 6 }}>
      {Array.from({ length: of }, (_, i) => (
        <View key={i} style={[styles.progSeg, i < step && styles.progSegOn]} />
      ))}
      <Text style={[type.tiny, { marginLeft: 6 }]} numberOfLines={1}>Step {step} of {of}</Text>
    </Row>
  );
}

/**
 * A number you can nudge or type (screen 17: a 52px box with a circle either
 * side). The circles are the handoff's; the number in the middle is a field,
 * because the owner asked on 4 Sep that a number always be typeable rather than
 * only steppable. Both, so neither instruction is broken.
 */
function MinuteBox({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = () => {
    const n = Number(text.replace(/[^0-9]/g, ''));
    if (!Number.isFinite(n) || !text.trim()) { setText(String(value)); return; }
    const next = clamp(Math.round(n));
    setText(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
      <Text style={styles.kickerFlat} numberOfLines={1}>{label}</Text>
      <View style={styles.minuteBox}>
        <Pressable onPress={() => onChange(clamp(value - step))} style={styles.minuteNudge} accessibilityRole="button" accessibilityLabel={`Less ${label}`}>
          <Icon name="minus" size={15} color={colors.ink} />
        </Pressable>
        <Row style={{ gap: 3, alignItems: 'baseline' }}>
          <TextInput
            value={text}
            onChangeText={setText}
            onBlur={commit}
            onSubmitEditing={commit}
            keyboardType="number-pad"
            style={styles.minuteValue}
            accessibilityLabel={label}
          />
          <Text style={styles.minuteUnit}>min</Text>
        </Row>
        <Pressable onPress={() => onChange(clamp(value + step))} style={styles.minuteNudge} accessibilityRole="button" accessibilityLabel={`More ${label}`}>
          <Icon name="add" size={15} color={colors.ink} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Finding somewhere to stay (Hotels 2, screens 16–18), mirrored.
 *
 * Three steps, and the third is the results list behind this sheet — so this
 * component is two: **where it should be**, with the time you will travel
 * attached to the answer it belongs to, and then **budget and must-haves**.
 * The order matters: what counts as a reasonable price depends on whether you
 * said "in the middle of my plans" or "anywhere with a station".
 *
 * The button carries the live count, which is the whole safety net on the
 * must-haves: tick Pool and the number tells you what it costs you before you
 * tap it.
 */
function StayCriteria({
  step, onStep, placement, onPlacement, mode, onMode, nights, startDate, endDate, count, loading,
  town, planned, plannedNames, line, criteria, onCriteria, onClose, onShow,
}: {
  step: 1 | 2; onStep: (s: 1 | 2) => void;
  placement: StayPlacement; onPlacement: (p: StayPlacement) => void;
  mode: 'driving' | 'walking'; onMode: (m: 'driving' | 'walking') => void;
  nights: number; startDate?: string | null; endDate?: string | null; count: number; loading: boolean;
  town: string; planned: number; plannedNames: string[]; line: string | null;
  criteria: StayCriteriaState; onCriteria: (next: Partial<StayCriteriaState>) => void;
  onClose: () => void; onShow: () => void;
}) {
  const { width, height, framed, origin } = useViewport();
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height } : null;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const names = plannedNames.length
    ? plannedNames.slice(0, 3).join(', ') + (plannedNames.length > 3 ? ` and ${plannedNames.length - 3} more` : '')
    : 'the days you plan';

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[{ flex: 1, justifyContent: 'flex-end' }, frameBox]}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Cancel" />
        <View style={[styles.addSheet, { maxHeight: '90%' }]}>
          <View style={styles.grabSmall} />
          <View style={styles.addHead}>
            <Row style={{ gap: 10, flex: 1, minWidth: 0 }}>
              {step === 2 ? (
                <Pressable onPress={() => onStep(1)} style={styles.backRound} accessibilityRole="button" accessibilityLabel="Back">
                  <Icon name="back" size={16} color={colors.ink} />
                </Pressable>
              ) : null}
              <Text style={styles.addTitle} numberOfLines={1}>{step === 1 ? 'Where should it be?' : 'Budget & must-haves'}</Text>
            </Row>
            <Pressable onPress={onClose} accessibilityRole="button">
              <Text style={[type.small, { fontWeight: '600' }]}>Cancel</Text>
            </Pressable>
          </View>
          <Progress step={step} of={3} />

          <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
            {step === 1 ? (
              <>
                {/* Getting around sets the units everywhere else. */}
                <Row style={{ justifyContent: 'space-between', gap: 12 }}>
                  <Text style={type.small}>Getting around</Text>
                  <View style={{ width: 220 }}>
                    <Segmented
                      value={mode}
                      options={[
                        { value: 'driving' as const, label: 'Car', icon: 'driving' as IconName },
                        { value: 'walking' as const, label: 'Train & metro', icon: 'transit' as IconName },
                      ]}
                      onChange={onMode}
                    />
                  </View>
                </Row>

                {/* Three tiles on one row, the answer lit in ink. */}
                <Row style={{ gap: 8, alignItems: 'stretch' }}>
                  {PLACEMENTS.map((o) => {
                    const on = placement === o.key;
                    return (
                      <Pressable
                        key={o.key}
                        onPress={() => onPlacement(o.key)}
                        style={[styles.tile, on && styles.tileOn]}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                      >
                        <Icon name={o.icon} size={17} color={on ? colors.primaryFg : colors.ink} />
                        <Text style={[styles.tileTitle, on && { color: colors.primaryFg }]} numberOfLines={2}>
                          {o.title.replace('{town}', town)}
                        </Text>
                        <Text style={[styles.tileSub, on && { color: '#C9C5C2' }]}>
                          {o.blurb.replace('{n}', String(planned))}
                        </Text>
                      </Pressable>
                    );
                  })}
                </Row>

                {/* The tinted panel: the selected tile's own control, and a
                    sentence saying what the ranking will actually do. */}
                <View style={styles.tint}>
                  {placement === 'plans' ? (
                    <>
                      <Text style={styles.tintLine}>
                        Roam ranks stays by the <Text style={{ fontWeight: '700' }}>average drive</Text> to {names}. Add more days and the fit improves.
                      </Text>
                      <Row style={{ justifyContent: 'space-between', gap: 8 }}>
                        <Text style={type.small}>Max average drive</Text>
                        <Row style={{ gap: 6 }}>
                          {MINUTE_CHIPS.map((n) => (
                            <Chip key={n} label={`${n} min`} on={criteria.maxAvgMin === n} onPress={() => onCriteria({ maxAvgMin: n })} />
                          ))}
                        </Row>
                      </Row>
                    </>
                  ) : placement === 'town' ? (
                    <>
                      <Text style={styles.tintLine}>
                        Everything within a short hop of <Text style={{ fontWeight: '700' }}>{town}</Text>, with the rest of the trip a drive away.
                      </Text>
                      <Row style={{ justifyContent: 'space-between', gap: 8 }}>
                        <Text style={type.small}>Max {mode === 'driving' ? 'drive' : 'walk'} from {town}</Text>
                        <Row style={{ gap: 6 }}>
                          {MINUTE_CHIPS.map((n) => (
                            <Chip key={n} label={`${n} min`} on={criteria.townMin === n} onPress={() => onCriteria({ townMin: n })} />
                          ))}
                        </Row>
                      </Row>
                    </>
                  ) : (
                    <>
                      <Text style={styles.tintLine}>
                        Happy to be out of town if the train’s close. {line
                          ? <>Your plans sit on the <Text style={{ fontWeight: '700' }}>{line}</Text>, so this works well here.</>
                          : 'Ranked on the walk to the platform first, then the journey from it.'}
                      </Text>
                      <Row style={{ gap: 10, alignItems: 'flex-start' }}>
                        <MinuteBox label="Max train / metro" value={criteria.maxTrainMin} min={5} max={120} step={5} onChange={(n) => onCriteria({ maxTrainMin: n })} />
                        <MinuteBox label="Max walk to station" value={criteria.maxWalkMin} min={3} max={40} step={1} onChange={(n) => onCriteria({ maxWalkMin: n })} />
                      </Row>
                    </>
                  )}
                </View>
              </>
            ) : (
              <>
                <View style={{ gap: 8 }}>
                  <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Text style={type.small}>Budget per night</Text>
                    <Text style={styles.budgetValue}>
                      £{criteria.budget[0]} – {criteria.budget[1] >= 300 ? '£300+' : `£${criteria.budget[1]}`}
                    </Text>
                  </Row>
                  <RangeSlider
                    min={40}
                    max={300}
                    step={10}
                    low={criteria.budget[0]}
                    high={criteria.budget[1]}
                    onChange={(low, high) => onCriteria({ budget: [low, high] })}
                    format={(v) => (v >= 300 ? '£300+' : `£${v}`)}
                    plain
                  />
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={type.tiny}>£40</Text>
                    <Text style={type.tiny} numberOfLines={1}>
                      {nights
                        ? `${nights} night${nights === 1 ? '' : 's'}${startDate && endDate ? ` · ${fmtDate(startDate)} – ${fmtDate(endDate)}` : ''}`
                        : 'no nights on this trip yet'}
                    </Text>
                    <Text style={type.tiny}>£300+</Text>
                  </Row>
                </View>

                <View style={{ gap: 8 }}>
                  <Text style={styles.kickerFlat}>Type of place</Text>
                  <Wrap>
                    <UiChip label="Any" selected={!criteria.types.length} onPress={() => onCriteria({ types: [] })} />
                    {STAY_TYPES.map((t) => (
                      <UiChip key={t} label={t} selected={criteria.types.includes(t)} onPress={() => onCriteria({ types: toggle(criteria.types, t) })} />
                    ))}
                  </Wrap>
                </View>

                <View style={{ gap: 8 }}>
                  <Text style={styles.kickerFlat}>Must have</Text>
                  <Wrap>
                    {MUST_HAVES.map((t) => (
                      <UiChip key={t} label={t} selected={criteria.must.includes(t)} onPress={() => onCriteria({ must: toggle(criteria.must, t) })} />
                    ))}
                  </Wrap>
                </View>

                <View style={{ gap: 8 }}>
                  <Text style={styles.kickerFlat}>
                    Nice to have <Text style={styles.kickerSoft}>· reorders, doesn’t filter</Text>
                  </Text>
                  <Wrap>
                    {NICE_TO_HAVES.map((t) => (
                      <UiChip key={t} label={t} selected={criteria.nice.includes(t)} onPress={() => onCriteria({ nice: toggle(criteria.nice, t) })} />
                    ))}
                  </Wrap>
                </View>
              </>
            )}
          </ScrollView>

          {step === 1
            ? <Button label="Next · budget & must-haves" onPress={() => onStep(2)} />
            : <Button label={loading ? 'Counting stays…' : count ? `Show ${count} stay${count === 1 ? '' : 's'}` : 'Nothing matches — loosen something'} onPress={onShow} disabled={!count} />}
        </View>
      </View>
    </Modal>
  );
}

/** The results (handoff §18/19): ranked, with the fit line the ranking was made from. */
function StayList({ stays, placement, onPlacement, mode, onMode, onCriteria, nights, budget, planned, selected, onSelect, onOpen, onChoose }: {
  stays: { loading: boolean; results: Stay[]; spread: { minutes: number; between: [string, string]; places: string[] } | null; error: string | null };
  placement: StayPlacement; onPlacement: (p: StayPlacement) => void;
  mode: 'driving' | 'walking'; onMode: (m: 'driving' | 'walking') => void;
  /** Each chip re-opens the wizard at the step it came from (§19). */
  onCriteria: (step: 1 | 2) => void; nights: number; budget: [number, number]; planned: number;
  selected: string | null; onSelect: (ref: string) => void;
  /** Tapping a stay opens it, the same as tapping its pin. */
  onOpen: (s: Stay) => void;
  onChoose: (s: Stay) => Promise<void>;
}) {
  const label = placement === 'station' ? 'Near a station' : placement === 'town' ? 'Near the centre' : 'Near my plans';
  // The budget chip says the band, not the numbers: £££ reads at a glance and
  // "£80 – £180" does not, at 12.5px next to two other chips.
  const band = '£'.repeat(Math.max(1, Math.min(4, Math.ceil(Math.min(300, budget[1]) / 75))));
  return (
    <View>
      <View style={styles.chips}>
        <Chip label={label} on chevron onPress={() => onCriteria(1)} />
        <Chip label={mode === 'driving' ? 'Car' : 'Train & metro'} chevron onPress={() => onCriteria(1)} />
        <Chip label={band} chevron onPress={() => onCriteria(2)} />
      </View>

      {/* Screen 19: when the days are an hour apart, no one of them is worth
          being near, and the app should say so rather than ranking against a
          middle that does not exist. */}
      {stays.spread ? (
        <View style={styles.spread}>
          <Text style={[type.small, { color: colors.ink }]}>
            <Text style={{ fontWeight: '700' }}>Your plans are spread out</Text>
            {` — ${stays.spread.between.join(' and ')} are about ${stays.spread.minutes} minutes apart. A stay near a station may beat being near any single day.`}
          </Text>
          {placement !== 'station' ? (
            <Pressable onPress={() => onPlacement('station')} accessibilityRole="button">
              <Text style={styles.spreadLink}>Rank by station instead →</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {stays.loading ? <Text style={[type.small, { padding: spacing.lg }]}>Looking for somewhere to stay…</Text> : null}
      {stays.error ? <View style={{ padding: spacing.lg }}><StatusLine tone="warn">{stays.error}</StatusLine></View> : null}
      {!stays.loading && !stays.error && !stays.results.length ? (
        <View style={{ padding: spacing.lg }}><Card><Text style={type.small}>No beds found around here yet. The open map may be busy — try again in a moment.</Text></Card></View>
      ) : null}

      {stays.results.length ? (
        <Text style={[type.small, { paddingHorizontal: 16, paddingTop: 8 }]}>
          {placement === 'station' ? 'Ranked by the walk to the platform, then the journey from it.'
            : placement === 'town' ? 'Ranked by how close they are to the centre.'
              : `Ranked by average drive to your ${planned || ''}${planned ? ' ' : ''}planned place${planned === 1 ? '' : 's'}.`}
        </Text>
      ) : null}

      <View style={{ paddingHorizontal: 16 }}>
        {stays.results.map((st) => (
          <Pressable key={st.venueRef} onPress={() => onOpen(st)} style={[styles.row, selected === st.venueRef && styles.rowOn]} accessibilityRole="button">
            <View>
              <VenueThumb name={st.name} photos={st.photos} category="hotel" width={64} height={64} rounded={6} credit={false} />
              {st.rank ? <View style={[styles.rank, st.rank === 1 && { backgroundColor: colors.red }]}><Text style={styles.rankText}>{st.rank}</Text></View> : null}
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text style={styles.rowName} numberOfLines={1}>{st.name}</Text>
              <View style={styles.rowMeta}>
                <Text style={type.small} numberOfLines={1}>{[st.stayKind ? cap(st.stayKind) : 'Hotel', money(st.priceLevel)].filter(Boolean).join(' · ')}</Text>
                {st.rating != null ? (
                  <Stars value={st.rating} size={12}><Text style={styles.ratingText}>{st.rating.toFixed(1)}</Text></Stars>
                ) : null}
              </View>
              {st.fit ? <Text style={styles.detourGreen} numberOfLines={2}>{st.fit}</Text> : null}
              <View style={styles.rowActions}>
                {st.offer?.perNight != null ? (
                  <Text style={[type.small, { flex: 1, color: colors.ink, fontWeight: '600' }]} numberOfLines={1}>
                    {`£${Math.round(st.offer.perNight)} / night${nights ? ` · ${nights} night${nights === 1 ? '' : 's'}` : ''}`}
                  </Text>
                ) : <Text style={[type.tiny, { flex: 1 }]} numberOfLines={1}>no price for these nights</Text>}
                <Pressable onPress={() => onChoose(st)} style={styles.add} accessibilityRole="button">
                  <Icon name="check" size={13} color={colors.ink} />
                  <Text style={styles.addText}>Choose</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

/**
 * The Add sheet (handoff screens 09/10). Three legs, and the arrive-at time
 * follows from the one chosen: on the way is leave-time plus the drive; on the
 * way back is the end of the day plus the drive; no time yet saves it to the
 * day without a slot.
 */
function AddSheet({ place, trip, party, onCancel, onSave }: {
  place: TripAlongPlace; trip: TripDetail; party: number; onCancel: () => void;
  onSave: (p: TripAlongPlace, leg: 'out' | 'back' | null, startTime: string | null) => Promise<void>;
}) {
  const [leg, setLeg] = useState<'out' | 'back' | null>(null);
  const [busy, setBusy] = useState(false);
  /** Typed over the computed time. Null means "whatever the leg works out". */
  const [typed, setTyped] = useState<string | null>(null);
  const { width, height, framed, origin } = useViewport();
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height } : null;

  const addMinutes = (hhmm: string, add: number) => {
    const [h, m] = hhmm.split(':').map(Number);
    const t = h * 60 + m + add;
    return `${String(Math.floor((t % 1440) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const detour = place.detourMinutes ?? 0;
  const out = trip.trip.dayStart ?? (trip.trip.departAt ? clock(trip.trip.departAt) : '09:00');
  const home = trip.trip.dayEnd ?? (trip.trip.returnAt ? clock(trip.trip.returnAt) : '17:30');
  const computed = leg === 'out' ? addMinutes(out, detour) : leg === 'back' ? addMinutes(home, detour) : null;
  const arriveAt = typed ?? computed;

  /**
   * The line under the legs, and only when the hours actually matter (handoff
   * §10). A pub that opens at noon is a fact about which leg is possible, not
   * a detail for the drawer — and saying it on every place would train people
   * to stop reading it.
   */
  const opensAt = (() => {
    const hours = place.openingHours ?? '';
    const m = /(\d{1,2})[:.](\d{2})/.exec(String(hours));
    if (!m) return null;
    const opens = `${m[1].padStart(2, '0')}:${m[2]}`;
    const outAt = addMinutes(out, detour);
    return opens > outAt ? `Opens ${opens} — not open on the way there` : null;
  })();

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <View style={[{ flex: 1, justifyContent: 'flex-end' }, frameBox]}>
        <Pressable style={styles.scrim} onPress={onCancel} accessibilityLabel="Cancel" />
        <View style={styles.addSheet}>
          <View style={styles.grabSmall} />
          <View style={styles.addHead}>
            <Text style={styles.addTitle} numberOfLines={2}>Add {place.name}</Text>
            <Pressable onPress={onCancel} accessibilityRole="button"><Text style={[type.small, { fontWeight: '600' }]}>Cancel</Text></Pressable>
          </View>
          <Text style={type.small} numberOfLines={2}>
            {[place.category ? cap(place.category) : null, money(place.priceLevel), place.rating != null ? `★ ${place.rating}` : null,
              place.detourMinutes != null ? `about ${place.detourMinutes} min off the route (${place.detourMiles} mi)` : null].filter(Boolean).join(' · ')}
          </Text>

          <View style={styles.legs}>
            {([['out', 'On the way', 0.95], ['back', 'On the way back', 1.35], [null, 'No time yet', 1]] as const).map(([k, label, flex]) => (
              <Pressable key={String(k)} onPress={() => { setLeg(k as any); setTyped(null); }} style={[styles.leg, { flex }, leg === k && styles.legOn]} accessibilityRole="button" accessibilityState={{ selected: leg === k }}>
                <Text style={[styles.legText, leg === k && { color: colors.primaryFg }]} numberOfLines={1}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {opensAt ? <Text style={[type.tiny, { color: colors.inkMuted }]}>{opensAt}</Text> : null}

          {/* Always editable: typing wins over the arithmetic, and Roam moves
              the drive to match rather than arguing (handoff § Interactions). */}
          <View style={[styles.arrive, arriveAt && { borderColor: colors.ink }]}>
            <Icon name="hours" size={17} color={arriveAt ? colors.ink : colors.inkMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.kicker}>Arrive at</Text>
              <TextInput
                value={arriveAt ?? ''}
                onChangeText={(t) => setTyped(t.replace(/[^0-9:]/g, '').slice(0, 5))}
                placeholder="Tap to set a time"
                placeholderTextColor={colors.inkMuted}
                keyboardType="numbers-and-punctuation"
                accessibilityLabel="Arrive at"
                style={styles.arriveInput}
              />
            </View>
            <Icon name="edit" size={15} color={colors.inkMuted} />
          </View>

          <Row style={{ gap: 10 }}>
            <Text style={type.small}>Table for</Text>
            <View style={styles.tableChip}><Text style={styles.tableChipText}>{party} · the household</Text></View>
          </Row>

          <Text style={type.tiny}>
            The {place.detourMinutes} minutes above is worked out from the distance. The day is re-timed properly the moment this is on it.
          </Text>

          <Button
            label={busy ? 'Adding…' : arriveAt ? `Add at ${arriveAt}` : 'Save to the day'}
            icon="add"
            onPress={async () => { if (busy) return; setBusy(true); try { await onSave(place, leg, /^\d{1,2}:\d{2}$/.test(arriveAt ?? '') ? arriveAt : null); } finally { setBusy(false); } }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontFamily: fonts.heading, fontSize: 22, fontWeight: '800', letterSpacing: -0.44, color: colors.ink, flexShrink: 1 },
  party: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, height: 28, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  partyText: { fontFamily: fonts.body, fontSize: 12, fontWeight: '700', color: colors.ink },
  round: { width: 40, height: 40, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },

  tabs: { flexDirection: 'row', backgroundColor: colors.surfaceMuted, borderRadius: radius.md, padding: 3, marginHorizontal: 16, marginTop: 10, marginBottom: 6 },
  tab: { flex: 1, minWidth: 0, minHeight: 34, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  tabOn: { backgroundColor: colors.primary },
  tabText: { fontFamily: fonts.body, fontSize: 12.5, fontWeight: '600', color: colors.inkMuted },

  // The three pills over the map.
  pills: { flexDirection: 'row', gap: 8, paddingHorizontal: 20 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 38, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
    shadowColor: '#201E1D', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 3,
  },
  pillOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '600', color: colors.ink },
  nudge: {
    alignSelf: 'flex-start', marginLeft: 20, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: radius.pill, backgroundColor: colors.primary, color: colors.primaryFg, overflow: 'hidden',
    fontFamily: fonts.body, fontSize: 11.5, fontWeight: '700',
  },

  // The app draws under the clock now, so anything floating at the top of the
  // map puts the inset back on for itself.
  searchWrap: { position: 'absolute', left: 0, right: 0, top: ('calc(16px + env(safe-area-inset-top))' as any), paddingHorizontal: 20 },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: 16, borderRadius: radius.pill,
    backgroundColor: colors.surface,
    shadowColor: '#201E1D', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.14, shadowRadius: 12, elevation: 4,
  },
  errorWrap: { position: 'absolute', left: 20, right: 20, top: 70 },

  // Wide: the map keeps the left, the sheet becomes a panel on the right.
  panel: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 430, padding: 16, gap: 12 },
  panelCard: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line,
    paddingTop: 12, overflow: 'hidden',
  },

  booking: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 14, marginTop: 12 },
  bookingName: { fontFamily: fonts.heading, fontSize: 15, fontWeight: '700', color: colors.ink },
  kicker: { fontFamily: fonts.heading, fontSize: 11, fontWeight: '700', letterSpacing: 0.66, textTransform: 'uppercase', color: colors.inkMuted, marginTop: 16, marginBottom: 6 },

  beat: { flexDirection: 'row', gap: 12 },
  beatTime: { width: 44, textAlign: 'right', paddingTop: 9, fontFamily: fonts.body, fontSize: 12, fontWeight: '600', color: colors.ink },
  beatDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  beatLine: { flex: 1, width: 2, minHeight: 8, backgroundColor: colors.line },
  beatTitle: { fontFamily: fonts.heading, fontSize: 14.5, fontWeight: '700', color: colors.ink, lineHeight: 18 },

  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, marginTop: 18, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 10 },
  ctaText: { fontFamily: fonts.heading, fontSize: 14, fontWeight: '700', color: colors.ink },

  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, flexWrap: 'wrap' },
  chipQuiet: { borderColor: colors.ink },
  inlineDrop: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 12, paddingBottom: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, maxWidth: 220 },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: fonts.body, fontSize: 12.5, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  dropdown: { marginHorizontal: 16, marginTop: 8, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 12, paddingBottom: 6 },
  optRow: { flexDirection: 'row', alignItems: 'center', minHeight: TARGET },

  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  ratingText: { fontFamily: fonts.body, fontSize: 12.5, fontWeight: '600', color: colors.ink },
  rowActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 2 },
  phone: { width: 34, height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipWrap: { position: 'absolute', right: 16, top: ('calc(16px + env(safe-area-inset-top))' as any) },
  driveChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, height: 28, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
    shadowColor: '#201E1D', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 3,
  },
  driveChipText: { fontFamily: fonts.body, fontSize: 11, fontWeight: '600', color: colors.ink },
  bookmark: { width: 34, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  rowOn: { backgroundColor: colors.accentSoft },
  rowName: { fontFamily: fonts.heading, fontSize: 15, fontWeight: '700', color: colors.ink },
  detour: { fontFamily: fonts.body, fontSize: 12, fontWeight: '600', color: colors.ink },
  add: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 11, height: 30, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.ink },
  addText: { fontFamily: fonts.body, fontSize: 12, fontWeight: '700', color: colors.ink },

  searchSheet: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.surface, paddingTop: ('calc(20px + env(safe-area-inset-top))' as any), paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
  searchField: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted },
  searchInput: { flex: 1, fontFamily: fonts.body, fontSize: 15, color: colors.ink, outlineStyle: 'none' as any },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  searchTile: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  // Clear of both edges. It was flush against the left, and a fortnight's worth
  // scrolls rather than shrinking — a day chip you cannot read is not a chip.
  strip: { gap: 8, paddingVertical: 12, paddingLeft: 16, paddingRight: 16 },
  dayChip: { width: 44, paddingVertical: 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, alignItems: 'center', gap: 1 },
  dayChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayChipDow: { fontFamily: fonts.body, fontSize: 10, fontWeight: '600', color: colors.inkMuted },
  dayChipNum: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '800', color: colors.ink },
  dayDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
  dayDotGap: { height: 5 },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  // The banner (Hotels 2 §15): ink, one row, the whole of it a tap.
  signpost: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 14, padding: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: colors.primary },
  signIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  signTitle: { fontFamily: fonts.heading, fontSize: 15, fontWeight: '800', letterSpacing: -0.3, color: colors.primaryFg },
  signSub: { fontFamily: fonts.body, fontSize: 12, color: '#C9C5C2' },
  // The wizard (§16–18).
  progSeg: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.line },
  progSegOn: { backgroundColor: colors.ink },
  backRound: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  tile: { flex: 1, minWidth: 0, gap: 6, padding: 12, paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.surface },
  tileOn: { borderColor: colors.ink, backgroundColor: colors.primary },
  tileTitle: { fontFamily: fonts.heading, fontSize: 14, fontWeight: '700', color: colors.ink, lineHeight: 17 },
  tileSub: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 15.5, color: colors.inkMuted },
  tint: { gap: 10, padding: 14, borderRadius: 12, backgroundColor: colors.surfaceMuted },
  tintLine: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: colors.ink },
  minuteBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 52, borderWidth: 1.5, borderColor: colors.ink, borderRadius: 10, paddingHorizontal: 6, backgroundColor: colors.surface },
  minuteNudge: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  minuteValue: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: colors.ink, minWidth: 28, textAlign: 'center', padding: 0 },
  minuteUnit: { fontFamily: fonts.body, fontSize: 12, fontWeight: '600', color: colors.inkMuted },
  budgetValue: { fontFamily: fonts.heading, fontSize: 16, fontWeight: '800', letterSpacing: -0.3, color: colors.ink },
  kickerFlat: { fontFamily: fonts.heading, fontSize: 11, fontWeight: '700', letterSpacing: 0.66, textTransform: 'uppercase', color: colors.inkMuted },
  kickerSoft: { fontFamily: fonts.body, fontSize: 11, fontWeight: '500', letterSpacing: 0, textTransform: 'none', color: colors.inkMuted },
  // The week tabs above the day strip, once a holiday runs past a week (§21).
  weeks: { flexDirection: 'row', padding: 3, gap: 0, marginHorizontal: 16, marginTop: 12, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted },
  week: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: radius.sm },
  weekOn: { backgroundColor: colors.primary },
  weekName: { fontFamily: fonts.body, fontSize: 12.5, fontWeight: '700', color: colors.ink },
  weekWhen: { fontFamily: fonts.body, fontSize: 10.5, color: colors.inkMuted },
  spread: { marginHorizontal: 16, marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: colors.surfaceMuted, gap: 6 },
  spreadLink: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700', color: colors.accent },
  detourGreen: { fontFamily: fonts.body, fontSize: 12, fontWeight: '600', color: colors.accent },
  rank: { position: 'absolute', left: -4, top: -4, minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  rankText: { fontFamily: fonts.body, fontSize: 11, fontWeight: '700', color: colors.primaryFg },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(32,30,29,0.45)' },
  addSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 28, gap: 14 },
  grabSmall: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line, alignSelf: 'center' },
  addHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  addTitle: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: colors.ink, flex: 1 },
  legs: { flexDirection: 'row', gap: 8 },
  leg: { alignItems: 'center', justifyContent: 'center', paddingVertical: 11, paddingHorizontal: 6, borderRadius: 10, borderWidth: 1.5, borderColor: colors.line },
  legOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  legText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700', color: colors.ink },
  arrive: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, height: 56, borderRadius: 10, borderWidth: 1.5, borderColor: colors.line },
  arriveInput: { fontFamily: fonts.heading, fontSize: 15, fontWeight: '800', letterSpacing: -0.3, color: colors.ink, padding: 0, outlineStyle: 'none' as any },
  tableChip: { paddingHorizontal: 12, height: 32, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  tableChipText: { fontFamily: fonts.body, fontSize: 12.5, fontWeight: '600', color: colors.primaryFg },
});

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
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, HouseholdResponse, TripAlongPlace, TripDetail, TripPlace } from '../api';
import { useViewport } from '../hooks/useViewport';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, StatusLine } from '../components/ui';
import { Icon, IconName } from '../components/Icon';
import { VenueThumb } from '../components/VenueThumb';
import { BottomSheet, Detent, detentHeights } from '../components/BottomSheet';
import { MapGL, MapMarker, MapRoute } from '../components/MapGL';
import { GroupPanel } from '../components/GroupPanel';
import { asOneOf, asText, useQueryState, useRouter } from '../router';
import { paths, type TripSection } from '../routes';

const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const clock = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mins = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim());
const money = (level?: number | null) => (level == null ? null : '£'.repeat(Math.max(1, Math.min(4, level))));

/** Which of the three pills is lit. Null is Trip home. */
type Pill = 'activities' | 'food' | 'shortlist';
const PILLS: { key: Pill; label: string; icon: IconName }[] = [
  { key: 'activities', label: 'Activities', icon: 'inspire' },
  { key: 'food', label: 'Food & drink', icon: 'restaurant' },
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

  const [pill, setPill] = useQueryState<Pill | null>('pill', null, asOneOf(['activities', 'food', 'shortlist'] as const, null));
  const [scope, setScope] = useQueryState<'route' | 'there' | null>('scope', null, asOneOf(['route', 'there'] as const, null));
  const [detour, setDetour] = useQueryState<string | null>('detour', null, asText);
  const maxDetourMin = Number(detour) || 15;

  const [detent, setDetent] = useState<Detent>('half');
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<TripAlongPlace | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every place this trip has touched, for the Places view and for the pins.
  const [places, setPlaces] = useState<{ places: TripPlace[]; counts: { all: number; do: number; eat: number; stay: number } } | null>(null);
  useEffect(() => { api.tripPlaces(trip.id).then(setPlaces).catch(() => null); }, [trip.id, shortlist.length, days.length]);

  // Browse: what is along the way. One fetch per (pill, scope, detour).
  const [along, setAlong] = useState<{ loading: boolean; places: TripAlongPlace[]; counts: { route: number; there: number }; error: string | null; degraded: { source: string; error: string }[] }>(
    { loading: false, places: [], counts: { route: 0, there: 0 }, error: null, degraded: [] },
  );
  const alongKey = pill && pill !== 'shortlist' ? `${pill}|${scope ?? 'route'}|${maxDetourMin}` : null;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!alongKey || alongKey === lastKey.current) return;
    lastKey.current = alongKey;
    setAlong((a) => ({ ...a, loading: true, error: null }));
    api.tripAlong(trip.id, { kind: pill === 'food' ? 'food' : 'things', scope: scope ?? 'route', maxDetourMin })
      .then((r) => setAlong({ loading: false, places: r.places, counts: r.counts, error: null, degraded: r.degradedSources ?? [] }))
      .catch((e) => setAlong({ loading: false, places: [], counts: { route: 0, there: 0 }, error: e.message, degraded: [] }));
  }, [alongKey, trip.id, pill, scope, maxDetourMin]);

  const isTrip = trip.kind === 'trip';
  const base = trip.base && trip.base.kind !== 'centre' ? trip.base : null;
  const start = base && isTrip ? base : trip.origin;
  const dest = trip.destination ?? (trip.base?.lat != null ? trip.base : null);
  const day = days[0] ?? null;

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
      out.push({ id: 'dest', lat: dest.lat as number, lng: dest.lng as number, kind: 'dest', icon: 'flag', label: trip.locality ?? dest.label.split(',')[0] });
    }
    if (pill && pill !== 'shortlist') {
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
          onPress: () => { setSelected(p.venueRef); setDetent('half'); },
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
          onPress: () => { setSelected(p.venueRef); setDetent('half'); },
        });
      }
    }
    return out;
  }, [start?.lat, dest?.lat, pill, along.places, places, selected, isTrip, base?.label]);

  const routes: MapRoute[] = useMemo(() => {
    if (start?.lat == null || dest?.lat == null || dest === start) return [];
    return [{ id: 'there', points: [{ lat: start.lat, lng: start.lng }, { lat: dest.lat, lng: dest.lng }] }];
  }, [start?.lat, start?.lng, dest?.lat, dest?.lng]);

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

  const who = attendees.length;
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
          <Text style={styles.title} numberOfLines={1}>{trip.locality ?? trip.place?.label ?? trip.title ?? trip.origin.label}</Text>
          {who ? (
            <View style={styles.party}>
              <Icon name="household" size={13} color={colors.ink} />
              <Text style={styles.partyText}>+{who}</Text>
            </View>
          ) : null}
        </View>
        <Text style={type.small} numberOfLines={1}>
          {[isTrip ? `${fmtDate(trip.startDate ?? trip.departAt)}` : fmtDate(trip.departAt),
            base ? base.label.split(',')[0] : 'from home',
            !pill && dest && start ? `${mins(Math.max(1, Math.round(estimateMinutes(start, dest))))} each way` : null,
          ].filter(Boolean).join(' · ')}
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

  const body = pill ? (
    <BrowseList
      pill={pill}
      along={along}
      shortlisted={(places?.places ?? []).filter((p) => p.shortlisted)}
      scope={scope}
      onScope={setScope}
      maxDetourMin={maxDetourMin}
      onDetour={(n) => setDetour(String(n))}
      selected={selected}
      onSelect={(ref) => setSelected(ref)}
      onAdd={setAdding}
      onShortlist={shortlistIt}
    />
  ) : (
    <SheetTabs section={section} counts={places?.counts.all ?? 0} onSection={onSection}>
      {section === 'places' ? <TripPlacesList data={places} onSelect={(ref) => { setSelected(ref); setDetent('half'); }} />
        : section === 'group' ? <View style={{ padding: spacing.lg }}><GroupPanel d={d} onChanged={onChanged} /></View>
          : <TheDay d={d} onAdd={() => { setPill('food'); setDetent('half'); }} />}
    </SheetTabs>
  );

  const pills = (
    <View style={[styles.pills, wide && { left: 24, right: undefined }]}>
      {PILLS.map((p) => {
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

      {/* The nudge and the search pill, both only when the map has the screen. */}
      {!wide && detent === 'peek' ? (
        <View style={styles.searchWrap} pointerEvents="box-none">
          <Pressable onPress={() => { setPill('food'); setDetent('half'); }} style={styles.search} accessibilityRole="button">
            <Icon name="search" size={16} color={colors.inkMuted} />
            <Text style={[type.small, { flex: 1 }]}>Search along the route</Text>
          </Pressable>
        </View>
      ) : null}

      {!wide ? (
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

      {adding ? (
        <AddSheet
          place={adding}
          trip={d}
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

function TheDay({ d, onAdd }: { d: TripDetail; onAdd: () => void }) {
  const { trip, days } = d;
  const isTrip = trip.kind === 'trip';
  const day = days[0];
  const stops = (day?.slots ?? []).flatMap((s) => s.stops);
  const dest = trip.destination ?? trip.base;
  const back = trip.returnAt ? clock(trip.returnAt) : trip.dayEnd ?? null;

  return (
    <View style={{ paddingHorizontal: 16 }}>
      {/* The one thing that still needs doing, if anything does. */}
      {dest ? (
        <View style={styles.booking}>
          <VenueThumb name={dest.label} category="attraction" width={56} height={56} rounded={8} credit={false} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={styles.bookingName} numberOfLines={1}>{trip.locality ?? dest.label.split(',')[0]}{isTrip ? '' : ' · all day'}</Text>
            <Text style={type.small} numberOfLines={1}>{d.attendees.length} {d.attendees.length === 1 ? 'person' : 'people'}</Text>
            <Text style={[type.tiny, { color: colors.red, fontWeight: '700' }]}>Not booked yet</Text>
          </View>
          <Icon name="more" size={16} color={colors.inkMuted} />
        </View>
      ) : null}

      <Text style={styles.kicker}>{stops.length ? `The day · ${stops.length} stop${stops.length === 1 ? '' : 's'}` : 'The day'}</Text>

      <Beat time={isTrip ? trip.dayStart ?? null : clock(trip.departAt)} icon="driving" title="Leave home"
        detail={[trip.origin.label.split(',')[0], dest ? (trip.locality ?? dest.label.split(',')[0]) : null].filter(Boolean).join(' → ')} />
      {stops.map((s) => (
        <Beat key={s.id} time={s.startTime} icon="place" title={s.name} detail={s.dwellMinutes ? mins(s.dwellMinutes) : null} />
      ))}
      {!stops.length && dest ? <Beat time={null} icon="pinned" title={trip.locality ?? dest.label.split(',')[0]} detail={isTrip ? null : 'All day'} /> : null}
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

function BrowseList({ pill, along, shortlisted, scope, onScope, maxDetourMin, onDetour, selected, onSelect, onAdd, onShortlist }: {
  pill: Pill;
  along: { loading: boolean; places: TripAlongPlace[]; counts: { route: number; there: number }; error: string | null; degraded: { source: string; error: string }[] };
  shortlisted: TripPlace[];
  scope: 'route' | 'there' | null;
  onScope: (s: 'route' | 'there' | null) => void;
  maxDetourMin: number;
  onDetour: (n: number) => void;
  selected: string | null;
  onSelect: (ref: string) => void;
  onAdd: (p: TripAlongPlace) => void;
  onShortlist: (p: TripAlongPlace) => Promise<void>;
}) {
  const [openDetour, setOpenDetour] = useState(false);

  if (pill === 'shortlist') {
    return (
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={[type.small, { paddingVertical: spacing.sm }]}>
          {shortlisted.length ? `${shortlisted.length} saved · ring ahead, then Add the one you want` : 'Nothing saved for this trip yet.'}
        </Text>
        {shortlisted.map((p) => (
          <View key={p.venueRef} style={styles.row}>
            <VenueThumb name={p.name} image={p.image} category={p.category} width={56} height={56} rounded={6} credit={false} />
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <Text style={styles.rowName} numberOfLines={1}>{p.name ?? 'A place'}</Text>
              <Text style={type.small} numberOfLines={1}>{p.day ?? 'no time yet'}</Text>
            </View>
            <Icon name="shortlisted" size={18} color={colors.ink} fill />
          </View>
        ))}
      </View>
    );
  }

  return (
    <View>
      {/* The scope chips. Before one is chosen both are offered plainly; once
          one is, the other folds away and the chosen one becomes a dropdown. */}
      <View style={styles.chips}>
        {scope == null ? (
          <>
            <Chip label={`En route · ${along.counts.route}`} onPress={() => onScope('route')} />
            <Chip label={`Near the end · ${along.counts.there}`} onPress={() => onScope('there')} />
          </>
        ) : (
          <>
            <Chip
              label={scope === 'there' ? 'Near the end' : `En route · <${maxDetourMin} min`}
              on
              chevron
              onPress={() => setOpenDetour((v) => !v)}
            />
            <Chip label="Anywhere" onPress={() => { onScope(null); setOpenDetour(false); }} />
          </>
        )}
      </View>

      {openDetour ? (
        <View style={styles.dropdown}>
          <Text style={styles.kicker}>How far off the route</Text>
          {DETOURS.map((n) => (
            <Pressable key={n} onPress={() => { onDetour(n); setOpenDetour(false); }} style={styles.optRow} accessibilityRole="radio" accessibilityState={{ checked: n === maxDetourMin }}>
              <Text style={[type.body, { flex: 1 }]}>Up to {n} minutes</Text>
              {n === maxDetourMin ? <Icon name="check" size={16} color={colors.accent} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {along.loading ? <Text style={[type.small, { padding: spacing.lg }]}>Looking along the route…</Text> : null}
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
          <Pressable key={p.venueRef} onPress={() => onSelect(p.venueRef)} style={[styles.row, selected === p.venueRef && styles.rowOn]} accessibilityRole="button">
            <VenueThumb name={p.name} photos={p.photos} category={p.category} experiences={p.experiences} width={56} height={56} rounded={6} credit={false} />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text style={styles.rowName} numberOfLines={1}>{p.name}</Text>
              <Text style={type.small} numberOfLines={1}>
                {[p.category ? cap(p.category) : null, money(p.priceLevel)].filter(Boolean).join(' · ')}
                {p.rating != null ? <Text style={{ color: colors.ink, fontWeight: '600' }}>{`  ★ ${p.rating}${p.ratingCount ? ` (${p.ratingCount})` : ''}`}</Text> : null}
              </Text>
              {/* The number the whole design turns on — and it says it is a
                  reckoning, not a routed answer (owner, 6 Sep 2026). */}
              <Text style={styles.detour} numberOfLines={1}>
                {p.detourMinutes != null ? `about ${p.detourMinutes} min off route` : 'off the route'}
                <Text style={{ color: colors.inkMuted, fontWeight: '400' }}>{` (${p.detourMiles} mi)`}</Text>
              </Text>
            </View>
            <View style={{ gap: 6, alignItems: 'flex-end' }}>
              <Pressable onPress={() => onShortlist(p)} hitSlop={8} accessibilityRole="button" accessibilityLabel={p.onShortlist ? 'Remove from the shortlist' : 'Save to the shortlist'}>
                <Icon name={p.onShortlist ? 'shortlisted' : 'shortlist'} size={18} color={colors.ink} fill={p.onShortlist} />
              </Pressable>
              <Pressable onPress={() => onAdd(p)} style={styles.add} accessibilityRole="button">
                <Icon name={p.onDay ? 'check' : 'add'} size={13} color={colors.ink} />
                <Text style={styles.addText}>{p.onDay ? 'Added' : 'Add'}</Text>
              </Pressable>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]/g, ' ');

function Chip({ label, on, chevron, onPress }: { label: string; on?: boolean; chevron?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[styles.chipText, on && { color: colors.primaryFg }]} numberOfLines={1}>{label}</Text>
      {chevron ? <Icon name="expand" size={13} color={on ? colors.primaryFg : colors.ink} /> : null}
    </Pressable>
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
function AddSheet({ place, trip, onCancel, onSave }: {
  place: TripAlongPlace; trip: TripDetail; onCancel: () => void;
  onSave: (p: TripAlongPlace, leg: 'out' | 'back' | null, startTime: string | null) => Promise<void>;
}) {
  const [leg, setLeg] = useState<'out' | 'back' | null>(null);
  const [busy, setBusy] = useState(false);
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
  const arriveAt = leg === 'out' ? addMinutes(out, detour) : leg === 'back' ? addMinutes(home, detour) : null;

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
              <Pressable key={String(k)} onPress={() => setLeg(k as any)} style={[styles.leg, { flex }, leg === k && styles.legOn]} accessibilityRole="button" accessibilityState={{ selected: leg === k }}>
                <Text style={[styles.legText, leg === k && { color: colors.primaryFg }]} numberOfLines={1}>{label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={[styles.arrive, arriveAt && { borderColor: colors.ink }]}>
            <Icon name="hours" size={17} color={arriveAt ? colors.ink : colors.inkMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.kicker}>Arrive at</Text>
              <Text style={[styles.arriveTime, !arriveAt && { color: colors.inkMuted, fontWeight: '600' }]}>{arriveAt ?? 'No time set'}</Text>
            </View>
          </View>

          {/* The real number, once there is a real decision behind it. */}
          <Text style={type.tiny}>
            The {place.detourMinutes} minutes above is worked out from the distance. The day is re-timed properly the moment this is on it.
          </Text>

          <Button
            label={busy ? 'Adding…' : arriveAt ? `Add at ${arriveAt}` : 'Save to the day'}
            icon="add"
            onPress={async () => { if (busy) return; setBusy(true); try { await onSave(place, leg, arriveAt); } finally { setBusy(false); } }}
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

  searchWrap: { position: 'absolute', left: 0, right: 0, top: 16, paddingHorizontal: 20 },
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
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, maxWidth: 220 },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: fonts.body, fontSize: 12.5, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  dropdown: { marginHorizontal: 16, marginTop: 8, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 12, paddingBottom: 6 },
  optRow: { flexDirection: 'row', alignItems: 'center', minHeight: TARGET },

  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
  rowOn: { backgroundColor: colors.accentSoft },
  rowName: { fontFamily: fonts.heading, fontSize: 15, fontWeight: '700', color: colors.ink },
  detour: { fontFamily: fonts.body, fontSize: 12, fontWeight: '600', color: colors.ink },
  add: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 11, height: 30, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.ink },
  addText: { fontFamily: fonts.body, fontSize: 12, fontWeight: '700', color: colors.ink },

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
  arriveTime: { fontFamily: fonts.heading, fontSize: 15, fontWeight: '800', letterSpacing: -0.3, color: colors.ink },
});

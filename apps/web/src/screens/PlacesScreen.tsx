import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { recallScreen, rememberScreen } from '../screenState';
import { CategoryIcon, Icon } from '../components/Icon';
import { api, AtlasCity, AtlasCountry, AtlasHome, AtlasPlace, BrowseItem, HouseholdResponse, Place, Venue, Visit } from '../api';
import { MapView, MapPin } from '../components/MapView';
import { VenueDrawer } from '../components/VenueDrawer';
import type { TripPrefill } from './TripsScreen';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap } from '../components/ui';
import { PlacePicker } from '../components/PlacePicker';
import { SourcePicker } from '../components/SourcePicker';
import { BeenCapture, VenueRow, VisitForm, VisitSummary, rowsForVisit } from '../components/Visits';
import { getViewer, onViewerChange } from '../viewer';
import { isAdmin } from '../admin';

// Trips still imports these from here.
export { VenueRow, VisitForm, VisitSummary } from '../components/Visits';
export type { VisitCreateBody } from '../components/Visits';

/**
 * Places (owner, 3 Sep 2026, /mockups/places-styled.html): the atlas is rows —
 * countries that fold open to cities, the cities first when there is only one
 * country — and inside a city everything the household has put there, with
 * Everything / Things to do / Food & drink on top, Status and Type as
 * dropdowns, list or map, and no trips (trips live in Trips). A row shows one
 * number, your own score out of 5, and where the place is at a glance: the
 * postcode district and the nearest station with its line. Special is a red
 * heart on the row's icon (style guide: red is the heart). Everything else
 * about a place is in the drawer.
 */

type Kind = 'all' | 'do' | 'eat';
type Status = 'any' | 'been' | 'try' | 'special';
type Sort = 'name' | 'mine' | 'recent';

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1).replace(/-/g, ' ');
const fmtScore = (s: number) => s.toFixed(1).replace('.0', '');

// Transport for London's own colours for its lines: the line's identity, not a UI code.
const LINE_COLOURS: Record<string, string> = {
  Bakerloo: '#B36305', Central: '#E32017', Circle: '#FFD300', District: '#00782A', 'Hammersmith & City': '#F3A9BB', Jubilee: '#A0A5A9',
  Metropolitan: '#9B0056', Northern: '#000000', Piccadilly: '#003688', Victoria: '#0098D4', 'Waterloo & City': '#95CDBA', 'Elizabeth line': '#6950A1',
  DLR: '#00A4A7', 'London Overground': '#EE7C0E', Liberty: '#5D6061', Lioness: '#FAA61A', Mildmay: '#0077AD', Suffragette: '#5BBD72', Weaver: '#823A62', Windrush: '#ED1B00', Tram: '#84B817',
};

/** The kinds of food or thing a place is known for, ignoring anything blank. */
const cuisinesOf = (p: AtlasPlace) => (((p.venue ?? {}) as Partial<Venue>).cuisines ?? []).filter(Boolean);
const experiencesOf = (p: AtlasPlace) => (((p.venue ?? {}) as Partial<Venue>).experiences ?? []).filter(Boolean);

// In Food & drink a restaurant is the assumption, so only the exceptions are
// named (owner, 4 Sep 2026: "if it's a bar, we put a bar pill in").
const CATEGORY_PILL: Record<string, string> = { bar: 'Bar', pub: 'Pub', cafe: 'Café' };

/** Which segment a place belongs to. A pub that serves food is under both. */
function kindsOf(p: AtlasPlace): Kind[] {
  const v = (p.venue ?? {}) as Partial<Venue>;
  const c = p.category ?? '';
  if (c === 'restaurant' || c === 'cafe') return ['eat'];
  if ((c === 'pub' || c === 'bar') && (v.cuisines?.length ?? 0) > 0) return ['do', 'eat'];
  if (!c && p.kind === 'food') return ['eat'];
  return ['do'];
}

/** The kind of thing it is, in the words the Type dropdown uses, for the segment being looked at. */
function typeOf(p: AtlasPlace, kind: Kind): string {
  const v = (p.venue ?? {}) as Partial<Venue>;
  const c = p.category ?? '';
  const k = kind === 'all' ? kindsOf(p)[0] : kind;
  if (k === 'eat') {
    const cuisines = cuisinesOf(p);
    if (cuisines.length) return cap(cuisines[0]);
    if (c === 'pub' || c === 'bar') return 'Pub food';
    return c === 'cafe' ? 'Cafés' : 'Restaurants';
  }
  if (c === 'pub' || c === 'bar') return 'Pubs & bars';
  if (c === 'event') return 'Events';
  const experiences = experiencesOf(p);
  if (experiences.length) return cap(experiences[0]);
  return c === 'attraction' ? 'Attractions' : 'Other';
}

/**
 * What the row itself says a place is. Under Food & drink the restaurant goes
 * without saying, so the words are the kind of food — Italian, Steakhouse — and
 * a bar, pub or café is marked by its pill instead (owner, 4 Sep 2026).
 */
function rowType(p: AtlasPlace, kind: Kind): string {
  const c = p.category ?? '';
  const cuisines = cuisinesOf(p);
  if (kind === 'eat') return cuisines.length ? cap(cuisines[0]) : '';
  if (kind === 'do' || kindsOf(p)[0] === 'do') return typeOf(p, 'do');
  if (cuisines.length) return cap(cuisines[0]);
  return CATEGORY_PILL[c] ?? 'Restaurant';
}

const statusOf = (p: AtlasPlace): Exclude<Status, 'any'> => (p.visits > 0 ? 'been' : 'try');
const matchesStatus = (p: AtlasPlace, s: Status) => s === 'any' || (s === 'special' ? p.special : statusOf(p) === s);
const myScore = (p: AtlasPlace, viewer: string | null) => (viewer ? p.scores.find((s) => s.memberId === viewer)?.score ?? null : null);

function atlasToVenue(p: AtlasPlace): Venue {
  const [source, ...rest] = p.venueRef.split(':');
  const v = (p.venue ?? {}) as Partial<Venue>;
  return {
    venueRef: p.venueRef, source, sourcePlaceId: rest.join(':'), name: p.name, category: p.category ?? v.category ?? 'attraction',
    cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], allergens: [], dietaryOptions: v.dietaryOptions,
    priceLevel: null, rating: null, goodForChildren: null, lat: p.lat ?? 0, lng: p.lng ?? 0, dishes: [],
    website: v.website ?? null, openingHours: v.openingHours ?? null, address: (v.address as any)?.line1 ?? null, attribution: '© OpenStreetMap contributors',
    household: { visits: p.visits, lastOn: p.lastOn ?? undefined, loved: p.loved, notForMe: p.notForMe, ledger: p.ledger ?? undefined },
  };
}

function venueToBrowseItem(v: Venue): BrowseItem {
  const [source] = v.venueRef.split(':');
  return {
    id: v.venueRef, venueRef: v.venueRef, name: v.name, category: v.category, lat: v.lat, lng: v.lng,
    dwellMinutes: 0, reasons: [], justification: null, startsAt: null, endsAt: null, pinned: false, source,
    cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], address: typeof v.address === 'string' ? v.address : null,
    website: v.website ?? null, openingHours: v.openingHours ?? null,
  };
}

function atlasToBrowseItem(p: AtlasPlace): BrowseItem {
  const v = (p.venue ?? {}) as Partial<Venue>;
  const [source] = p.venueRef.split(':');
  return {
    id: p.venueRef, venueRef: p.venueRef, name: p.name, category: p.category ?? v.category ?? 'attraction', lat: p.lat ?? 0, lng: p.lng ?? 0,
    dwellMinutes: 0, reasons: [], justification: null, startsAt: null, endsAt: null, pinned: false, source,
    cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], address: (v.address as any)?.line1 ?? (typeof v.address === 'string' ? v.address : null), website: v.website ?? null, openingHours: v.openingHours ?? null,
  };
}

/** Where the Places tab was: the city being looked at, and which countries were open. */
type PlacesMemory = { sel: { home: true } | { country: string; city: string } | null; openCodes: string[] };

/** And inside a city: how the list was filtered and sorted, and whether it was a map. */
type CityMemory = { kind: Kind; status: Status; typeF: string | null; sort: Sort; view: 'list' | 'map' };

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function PlacesScreen({ household, refreshHousehold, onPlanTrip }: { household: HouseholdResponse | null; refreshHousehold: () => Promise<void>; onPlanTrip?: (p: TripPrefill) => void }) {
  const { width, height } = useViewport();
  const wide = width >= 1000;
  const [data, setData] = useState<{ countries: AtlasCountry[]; unplaced: number; home: AtlasHome | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where this tab was left (owner, 4 Sep 2026: "same for any of the other
  // tabs"). Only the choice of city and which countries were open — the places
  // themselves are fetched again from the atlas, which is our own data and is
  // on the device anyway.
  const heldPlaces = useRef(recallScreen<PlacesMemory>('places')).current;
  const [openCodes, setOpenCodes] = useState<Set<string>>(new Set(heldPlaces?.data.openCodes ?? []));
  // Either a city in the atlas, or the standing "close to home" view.
  const [sel, setSel] = useState<{ home: true } | { country: string; city: string } | null>(heldPlaces?.data.sel ?? null);
  const atHome = !!sel && 'home' in sel;
  const [addingCity, setAddingCity] = useState(false);
  const [places, setPlaces] = useState<AtlasPlace[]>([]);
  const [wherePending, setWherePending] = useState(0);
  const [open, setOpen] = useState<AtlasPlace | null>(null);
  // A place found by searching, before it is anything of ours: the drawer shows
  // its details so you can be sure it is the right one.
  const [newVenue, setNewVenue] = useState<Venue | null>(null);
  const refills = useRef(0);

  const members = household?.members ?? [];
  const [viewer, setViewer] = useState<string | null>(null);
  useEffect(() => { setViewer(getViewer(members)); return onViewerChange(setViewer); }, [members.map((m) => m.id).join(',')]);

  // Remember it as it changes, so coming back lands on the same city.
  useEffect(() => {
    rememberScreen<PlacesMemory>('places', { sel, openCodes: [...openCodes] });
  }, [sel, openCodes]);

  const loadAtlas = useCallback(async () => { try { setData(await api.atlas()); } catch (e: any) { setError(e.message); } }, []);
  useEffect(() => { loadAtlas(); }, [loadAtlas]);

  const single = data && data.countries.length === 1 ? data.countries[0] : null;
  const country = sel && !atHome ? data?.countries.find((c) => c.code === (sel as any).country) ?? null : null;
  const city = sel && !atHome && country ? country.cities.find((c) => c.name === (sel as any).city) ?? null : null;
  const home = atHome ? data?.home ?? null : null;

  const loadPlaces = useCallback(async () => {
    if (!sel) { setPlaces([]); setWherePending(0); return; }
    try {
      const r = 'home' in sel ? await api.atlasPlaces({ nearHome: true }) : await api.atlasPlaces({ country: sel.country, city: sel.city });
      setPlaces(r.places); setWherePending(r.wherePending ?? 0);
    } catch (e: any) { setError(e.message); }
  }, [sel && 'home' in sel ? 'home' : (sel as any)?.country, sel && 'home' in sel ? '' : (sel as any)?.city]);
  useEffect(() => { refills.current = 0; loadPlaces(); }, [loadPlaces]);
  // Postcode and station are looked up in the background after the first read; ask again a few times while any row is waiting.
  useEffect(() => {
    if (!wherePending || refills.current >= 6) return;
    const t = setTimeout(() => { refills.current += 1; loadPlaces(); }, 5000);
    return () => clearTimeout(t);
  }, [wherePending, places]);
  // Keep the open drawer on the same place after a change (a visit saved, a status set).
  useEffect(() => { if (open) { const fresh = places.find((p) => p.venueRef === open.venueRef); if (fresh && fresh !== open) setOpen(fresh); } }, [places]);

  const refreshAll = async () => { await loadAtlas(); await loadPlaces(); await refreshHousehold(); };
  const pick = (c: AtlasCountry, ci: AtlasCity) => { setSel({ country: c.code, city: ci.name }); setOpen(null); setOpenCodes((s) => new Set(s).add(c.code)); };
  const pickHome = () => { setSel({ home: true }); setOpen(null); };

  const showAtlas = wide || !sel;
  const showCity = !!sel && (wide || true);

  return (
    <ScrollView contentContainerStyle={[styles.page, wide && styles.pageWide]} keyboardShouldPersistTaps="handled">
      {showAtlas ? (
        <View style={[styles.atlasCol, wide && styles.atlasColWide]}>
          <View style={styles.field}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={type.title}>Places</Text>
              <Button label={addingCity ? 'Close' : 'Add'} icon={addingCity ? 'close' : 'add'} kind="secondary" onPress={() => setAddingCity((a) => !a)} />
            </Row>
            <Text style={[type.small, { color: colors.headerSub }]}>Where you've been and what you liked.</Text>
            {addingCity ? (
              <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                <PlacePicker kind="area" autoFocus value={null} onPick={async (p) => { if (!p) return; try { const r = await api.createAtlasCity({ place: p }); await loadAtlas(); setAddingCity(false); setSel({ country: r.city.countryCode, city: r.city.name }); setOpenCodes((s) => new Set(s).add(r.city.countryCode)); setError(null); } catch (e: any) { setError(e.message); } }} placeholder="Lisbon · Bath · the Lake District" />
              </View>
            ) : null}
            {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
          </View>
          <View style={styles.body}>
            {!data ? <Text style={type.small}>Loading your atlas…</Text> : null}
            {data && data.countries.length === 0 ? <Card><Text style={type.body}>Your atlas is empty so far.</Text><Text style={type.small}>Add a city above, then the places you know there. Visits and trip shortlists land here by themselves.</Text></Card> : null}
            {data?.home ? (
              <View style={styles.list}>
                <Pressable onPress={pickHome} style={[styles.row, atHome && styles.rowOn]} accessibilityRole="button" accessibilityState={{ selected: atHome }}>
                  <View style={{ width: 22, alignItems: 'center' }}><Icon name="home" size={17} /></View>
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <Text style={type.h3} numberOfLines={1}>Close to home</Text>
                    {data.home.places ? (
                      <View style={styles.counts}>
                        <Text style={type.tiny}>{data.home.places} place{data.home.places === 1 ? '' : 's'}</Text>
                        <Count label={`${data.home.been} been`} />
                        <Count label={`${data.home.places - data.home.been} to try`} />
                        {data.home.special ? <Count label={String(data.home.special)} heart /> : null}
                      </View>
                    ) : <Text style={type.tiny}>Nothing within {data.home.radiusMiles} miles yet</Text>}
                  </View>
                  <Icon name="more" size={18} color={colors.inkMuted} />
                </Pressable>
              </View>
            ) : null}
            {data && data.countries.length > 0 ? (
              <View style={styles.list}>
                {single ? single.cities.map((ci, i) => <CityRow key={ci.name} city={ci} first={i === 0} selected={!!sel && !atHome && (sel as any).city === ci.name} onPress={() => pick(single, ci)} />) : data.countries.map((c, i) => {
                  const isOpen = openCodes.has(c.code);
                  const total = c.cities.reduce((a, x) => a + x.places, 0);
                  return (
                    <View key={c.code}>
                      <Pressable onPress={() => setOpenCodes((s) => { const n = new Set(s); n.has(c.code) ? n.delete(c.code) : n.add(c.code); return n; })} style={[styles.row, i > 0 && styles.rowLine]} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}>
                        <View style={{ width: 22, alignItems: 'center' }}><Icon name={isOpen ? 'expand' : 'more'} size={18} color={colors.inkMuted} /></View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={type.h3} numberOfLines={1}>{c.name}</Text>
                          <Text style={type.tiny} numberOfLines={1}>{c.cities.length} {c.cities.length === 1 ? 'city' : 'cities'} · {total ? `${total} place${total === 1 ? '' : 's'}` : 'no places yet'}</Text>
                        </View>
                      </Pressable>
                      {isOpen ? c.cities.map((ci) => <CityRow key={ci.name} city={ci} sub selected={!!sel && !atHome && (sel as any).country === c.code && (sel as any).city === ci.name} onPress={() => pick(c, ci)} />) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}
            {single ? <Text style={type.tiny}>One country in your atlas, so its cities are the list.</Text> : null}
            {data?.unplaced ? <Text style={type.tiny}>{data.unplaced} place{data.unplaced === 1 ? '' : 's'} still being placed on the map.</Text> : null}
          </View>
        </View>
      ) : null}

      {showCity && ((country && city) || home) ? (
        <CityPanel
          key={home ? 'home' : `${country!.code}/${city!.name}`}
          country={country} city={city} home={home} places={places} household={household} viewer={viewer} wide={wide} viewportHeight={height}
          onBack={() => { setSel(null); setOpen(null); }} onOpen={setOpen} onOpenVenue={setNewVenue} openRef={open?.venueRef ?? null}
          onPlanTrip={() => onPlanTrip?.(home ? { placeText: home.label ?? 'home' } : { placeText: `${city!.name}, ${country!.name}`, countryCode: country!.code })}
          onChanged={refreshAll}
        />
      ) : wide ? (
        <View style={[styles.body, { flex: 1, paddingTop: spacing.xl }]}><Text style={type.small}>Pick a city to see everything you've put there.</Text></View>
      ) : null}

      <VenueDrawer
        item={newVenue ? venueToBrowseItem(newVenue) : open ? atlasToBrowseItem(open) : null}
        baseLabel={city?.name ?? (home ? 'home' : null)}
        onClose={() => { setOpen(null); setNewVenue(null); }}
        onVenue={async (v) => { if (open?.unnamed && v.name) { try { await api.nameAtlasPlace(open.venueRef, v.name); await loadPlaces(); } catch { /* the drawer still shows the fetched name */ } } }}
        ours={newVenue
          ? <NewPlacePanel venue={newVenue} household={household} ctx={country && city ? { country: country.name, countryCode: country.code, locality: city.name } : {}} onChanged={refreshAll} />
          : open ? <OursPanel place={open} household={household} ctx={country && city ? { country: country.name, countryCode: country.code, locality: city.name } : {}} viewer={viewer} onChanged={refreshAll} onRemoved={() => setOpen(null)} /> : null}
        gettingThere={open ? <GettingThere place={open} /> : null}
      />
    </ScrollView>
  );
}

function CityRow({ city, sub, first, selected, onPress }: { city: AtlasCity; sub?: boolean; first?: boolean; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.row, !first && styles.rowLine, sub && styles.rowSub, selected && styles.rowOn]} accessibilityRole="button" accessibilityState={{ selected }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={type.h3} numberOfLines={1}>{city.name}</Text>
        {city.places ? (
          <View style={styles.counts}>
            <Text style={type.tiny}>{city.places} place{city.places === 1 ? '' : 's'}</Text>
            <Count label={`${city.been} been`} />
            <Count label={`${city.places - city.been} to try`} />
            {city.special ? <Count label={String(city.special)} heart /> : null}
          </View>
        ) : <Text style={type.tiny}>No places yet{city.trips ? ` · ${city.trips} trip${city.trips === 1 ? '' : 's'}` : ''}</Text>}
      </View>
      <Icon name="more" size={18} color={colors.inkMuted} />
    </Pressable>
  );
}

const Count = ({ label, heart }: { label: string; heart?: boolean }) => (
  <View style={styles.count}>
    {heart ? <Icon name="keep" size={10} color={colors.red} fill /> : null}
    <Text style={styles.countText}>{label}</Text>
  </View>
);

// ---------------------------------------------------------------------------
// Inside a city
// ---------------------------------------------------------------------------

function CityPanel({ country, city, home, places, household, viewer, wide, viewportHeight, onBack, onOpen, onOpenVenue, openRef, onPlanTrip, onChanged }: {
  country: AtlasCountry | null; city: AtlasCity | null; home: AtlasHome | null; places: AtlasPlace[]; household: HouseholdResponse | null; viewer: string | null; wide: boolean; viewportHeight: number;
  onBack: () => void; onOpen: (p: AtlasPlace) => void; onOpenVenue: (v: Venue) => void; openRef: string | null; onPlanTrip: () => void; onChanged: () => Promise<void>;
}) {
  // The filters are per city: coming back to London should not bring Lisbon's
  // "food only, been" with it.
  const memoryKey = `places.city.${home ? 'home' : `${country?.code ?? '?'}.${city?.name ?? '?'}`}`;
  const heldCity = useRef(recallScreen<CityMemory>(memoryKey)).current;
  const [kind, setKind] = useState<Kind>(heldCity?.data.kind ?? 'all');
  const [status, setStatus] = useState<Status>(heldCity?.data.status ?? 'any');
  const [typeF, setTypeF] = useState<string | null>(heldCity?.data.typeF ?? null);
  const [sort, setSort] = useState<Sort>(heldCity?.data.sort ?? 'name');
  const [view, setView] = useState<'list' | 'map'>(heldCity?.data.view ?? 'list');
  useEffect(() => {
    rememberScreen<CityMemory>(memoryKey, { kind, status, typeF, sort, view });
  }, [memoryKey, kind, status, typeF, sort, view]);
  const [sheet, setSheet] = useState<'status' | 'type' | 'sort' | null>(null);
  const [adding, setAdding] = useState(false);
  const [selPin, setSelPin] = useState<string | null>(null);

  // A city, or everything within a few miles of the front door.
  const title = home ? 'Close to home' : city!.name;
  // The address itself is long and already in Settings; the household knows where home is.
  const where = home ? `Within ${home.radiusMiles} miles of home` : country!.name;
  const backLabel = home ? 'Places' : country!.name;
  const centre = home ? { lat: home.lat, lng: home.lng } : city!.lat != null && city!.lng != null ? { lat: city!.lat, lng: city!.lng } : null;
  const searchRadiusKm = home ? Math.round(home.radiusMiles * 1.60934) : 5;
  const ctx = home ? {} : { country: country!.name, countryCode: country!.code, locality: city!.name };

  const inKind = (p: AtlasPlace) => kind === 'all' || kindsOf(p).includes(kind);
  const counts = useMemo(() => ({ all: places.length, do: places.filter((p) => kindsOf(p).includes('do')).length, eat: places.filter((p) => kindsOf(p).includes('eat')).length }), [places]);
  const inKindAndType = places.filter((p) => inKind(p) && (!typeF || typeOf(p, kind) === typeF));
  const statusOptions = [
    { value: 'any', label: 'Any status', count: inKindAndType.length },
    { value: 'been', label: 'Been', count: inKindAndType.filter((p) => statusOf(p) === 'been').length },
    { value: 'try', label: 'To try', count: inKindAndType.filter((p) => statusOf(p) === 'try').length },
    { value: 'special', label: 'Special', count: inKindAndType.filter((p) => p.special).length },
  ];
  const typeCounts = new Map<string, number>();
  places.filter((p) => inKind(p) && matchesStatus(p, status)).forEach((p) => { const t = typeOf(p, kind); typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1); });
  const typeOptions = [{ value: '', label: kind === 'eat' ? 'Any cuisine' : kind === 'do' ? 'Any kind' : 'Any type', count: [...typeCounts.values()].reduce((a, b) => a + b, 0) }, ...[...typeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => ({ value: t, label: t, count: n }))];
  const sortOptions = [{ value: 'name', label: 'A–Z' }, { value: 'mine', label: 'My rating' }, { value: 'recent', label: 'Most recent' }];

  const rows = useMemo(() => {
    const list = places.filter((p) => inKind(p) && matchesStatus(p, status) && (!typeF || typeOf(p, kind) === typeF));
    const by: Record<Sort, (a: AtlasPlace, b: AtlasPlace) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      mine: (a, b) => (myScore(b, viewer) ?? -1) - (myScore(a, viewer) ?? -1) || a.name.localeCompare(b.name),
      recent: (a, b) => (b.lastOn ?? '').localeCompare(a.lastOn ?? '') || a.name.localeCompare(b.name),
    };
    return [...list].sort(by[sort]);
  }, [places, kind, status, typeF, sort, viewer]);

  const pins: MapPin[] = rows.filter((p) => p.lat != null && p.lng != null).map((p) => ({
    id: p.venueRef, lat: p.lat as number, lng: p.lng as number, label: p.name, number: '', heart: p.special,
    tone: statusOf(p) === 'been' ? 'base' : 'hollow', onPress: () => setSelPin(p.venueRef),
  }));
  const selected = selPin ? rows.find((p) => p.venueRef === selPin) ?? null : null;
  const mapHeight = wide ? 640 : Math.max(360, viewportHeight - 330);
  const showMap = view === 'map';
  const showList = view === 'list' || wide;

  return (
    <View style={[styles.cityCol, wide && styles.cityColWide]}>
      <View style={[styles.field, wide && styles.fieldWide]}>
        <Row style={{ justifyContent: 'space-between' }}>
          {!wide ? <Button label={backLabel} icon="back" kind="ghost" onPress={onBack} /> : <View />}
          <Button label="Plan a trip here" icon="plan" onPress={onPlanTrip} />
        </Row>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={type.title}>{title}</Text>
            <Text style={[type.small, { color: colors.headerSub }]} numberOfLines={2}>{where} · {places.length} place{places.length === 1 ? '' : 's'}{'\n'}{places.filter((p) => p.visits > 0).length} been · {places.filter((p) => !p.visits).length} to try{places.filter((p) => p.special).length ? ` · ${places.filter((p) => p.special).length} special` : ''}</Text>
          </View>
          <Button label={adding ? 'Close' : 'Add a place'} icon={adding ? 'close' : 'add'} kind="secondary" onPress={() => setAdding((a) => !a)} />
        </Row>
      </View>
      <View style={styles.body}>
        <Segmented
          value={kind}
          options={adding
            ? [{ value: 'all', label: 'Everything' }, { value: 'do', label: 'Things to do' }, { value: 'eat', label: 'Food & drink' }]
            : [{ value: 'all', label: `Everything ${counts.all}` }, { value: 'do', label: `Things to do ${counts.do}` }, { value: 'eat', label: `Food & drink ${counts.eat}` }]}
          onChange={(k) => { setKind(k); setTypeF(null); setSelPin(null); }}
        />
        {adding ? (
          <AddPlace household={household} kind={kind} centre={centre} radiusKm={searchRadiusKm} ctx={ctx} wide={wide} onAdded={onChanged} onOpen={onOpenVenue} />
        ) : (
        <>
        <View style={styles.filters}>
          <FilterChip label={statusOptions.find((o) => o.value === status)?.label ?? 'Any status'} on={status !== 'any'} onPress={() => setSheet('status')} />
          <FilterChip label={typeF ?? typeOptions[0].label} on={!!typeF} onPress={() => setSheet('type')} />
          <FilterChip label={sortOptions.find((o) => o.value === sort)?.label ?? 'A–Z'} on={sort !== 'name'} onPress={() => setSheet('sort')} />
          <View style={{ flex: 1 }} />
          <View style={styles.viewToggle}>
            <Pressable onPress={() => setView('list')} style={[styles.viewBtn, view === 'list' && styles.viewBtnOn]} accessibilityRole="button" accessibilityLabel="List" accessibilityState={{ selected: view === 'list' }}><Icon name="list" size={15} color={view === 'list' ? colors.primaryFg : colors.ink} /></Pressable>
            <Pressable onPress={() => setView('map')} style={[styles.viewBtn, view === 'map' && styles.viewBtnOn]} accessibilityRole="button" accessibilityLabel="Map" accessibilityState={{ selected: view === 'map' }}><Icon name="map" size={15} color={view === 'map' ? colors.primaryFg : colors.ink} /></Pressable>
          </View>
        </View>

        <View style={[styles.split, wide && showMap && styles.splitWide]}>
          {showList ? (
            <View style={[{ gap: spacing.sm }, wide && showMap && { width: 440 }]}>
              {rows.length ? (
                <View style={styles.list}>
                  {rows.map((p, i) => <PlaceRow key={p.venueRef} place={p} kind={kind} viewer={viewer} first={i === 0} selected={openRef === p.venueRef} onPress={() => onOpen(p)} />)}
                </View>
              ) : (
                <Card><Text style={type.small}>{places.length ? 'Nothing matches — clear a filter.' : 'Nothing here yet. Add a place you know, or a trip\'s shortlist will fill it.'}</Text></Card>
              )}
              <Text style={type.tiny}>{rows.length} of {places.length} · tap a row for the drawer.</Text>
            </View>
          ) : null}
          {showMap ? (
            <View style={[styles.mapWrap, wide && { flex: 1 }]}>
              <MapView pins={pins} height={mapHeight} focusId={selPin} />
              {selected ? (
                <View style={styles.pinCard}>
                  <PlaceRow place={selected} kind={kind} viewer={viewer} first selected={false} onPress={() => onOpen(selected)} />
                </View>
              ) : <Text style={[type.tiny, styles.mapHint]}>{pins.length} pins · filled been · hollow to try · tap one</Text>}
            </View>
          ) : null}
        </View>
        </>
        )}
      </View>

      <PickSheet visible={sheet === 'status'} title="Status" options={statusOptions} value={status} onPick={(v) => { setStatus(v as Status); setSheet(null); setSelPin(null); }} onClose={() => setSheet(null)} />
      <PickSheet visible={sheet === 'type'} title={kind === 'eat' ? 'Cuisine' : 'Kind of thing'} options={typeOptions} value={typeF ?? ''} onPick={(v) => { setTypeF(v || null); setSheet(null); setSelPin(null); }} onClose={() => setSheet(null)} />
      <PickSheet visible={sheet === 'sort'} title="Sort by" options={sortOptions} value={sort} onPick={(v) => { setSort(v as Sort); setSheet(null); }} onClose={() => setSheet(null)} />
    </View>
  );
}

function FilterChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.fchip, on && styles.fchipOn]} accessibilityRole="button">
      <Text style={[styles.fchipText, on && { color: colors.primaryFg }]} numberOfLines={1}>{label}</Text>
      <Icon name="expand" size={13} color={on ? colors.primaryFg : colors.ink} />
    </Pressable>
  );
}

/**
 * How you get to it, in the drawer (owner, 4 Sep 2026: "we could actually show
 * what line it's on or more information on getting there on the side drawer").
 * The row says only the station's name; the lines, the walk and the postcode
 * live here.
 */
function GettingThere({ place }: { place: AtlasPlace }) {
  const lines = (place.stationLines ?? []).filter(Boolean);
  if (!place.station && !place.postcode) return null;
  const walk = place.stationDistanceM != null ? Math.max(1, Math.round(place.stationDistanceM / 80)) : null;
  const what = place.stationKind === 'tube' ? 'Nearest Underground station'
    : place.stationKind === 'elizabeth-line' ? 'Nearest Elizabeth line station'
    : place.stationKind === 'dlr' ? 'Nearest DLR station'
    : place.stationKind === 'overground' ? 'Nearest Overground station'
    : place.stationKind === 'tram' ? 'Nearest tram stop'
    : place.stationKind === 'metro' ? 'Nearest metro station'
    : 'Nearest station';
  return (
    <View style={styles.getting}>
      <Text style={type.h3}>Getting there</Text>
      {place.station ? (
        <>
          <Text style={type.tiny}>{what}</Text>
          <Text style={type.body}>
            {place.station}
            {walk ? <Text style={type.small}>{`  ${walk} min walk`}</Text> : null}
          </Text>
          {lines.length ? (
            <Wrap>
              {lines.map((l) => (
                <View key={l} style={styles.line}>
                  <View style={[styles.dot, { backgroundColor: LINE_COLOURS[l] ?? colors.inkMuted }]} />
                  <Text style={styles.lineText}>{l}</Text>
                </View>
              ))}
            </Wrap>
          ) : null}
        </>
      ) : null}
      {place.postcode ? <Text style={type.small}>Postcode {place.postcode}</Text> : null}
    </View>
  );
}

/** One place, one line: what it is, where it is, and my score. */
function PlaceRow({ place, kind, viewer, first, selected, onPress }: { place: AtlasPlace; kind: Kind; viewer: string | null; first?: boolean; selected: boolean; onPress: () => void }) {
  const mine = myScore(place, viewer);
  const been = statusOf(place) === 'been';
  // Where it is, in as few words as possible: the station, not the district and
  // the lines (owner, 4 Sep 2026: "that's too much detail… just show the tube
  // station"). The lines and the walk are in the drawer.
  const pill = kind === 'eat' ? CATEGORY_PILL[place.category ?? ''] : null;
  const what = rowType(place, kind);
  const where = [what, place.station].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={onPress} style={[styles.prow, !first && styles.rowLine, selected && styles.rowOn]} accessibilityRole="button">
      <View style={styles.well}>
        <CategoryIcon category={place.category} size={16} />
        {place.special ? <View style={styles.heart}><Icon name="keep" size={9} color={colors.red} fill /></View> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[type.h3, place.unnamed && { fontStyle: 'italic', color: colors.inkMuted }]} numberOfLines={1}>{place.unnamed ? 'Unnamed place — open for its name' : place.name}</Text>
        <View style={styles.meta}>
          {pill ? <View style={styles.pill}><Text style={styles.pillText}>{pill}</Text></View> : null}
          {where ? <Text style={[type.tiny, { flexShrink: 1 }]} numberOfLines={1}>{where}</Text> : null}
        </View>
      </View>
      {mine != null ? (
        <View style={styles.score}><Icon name="favourite" size={14} fill /><Text style={styles.scoreText}>{fmtScore(mine)}</Text></View>
      ) : <View style={styles.tryChip}><Text style={styles.tryText}>{been ? 'Been' : 'To try'}</Text></View>}
    </Pressable>
  );
}

/** A dropdown as a sheet pinned to the frame: the options with counts, the current one in ink. */
function PickSheet({ visible, title, options, value, onPick, onClose }: { visible: boolean; title: string; options: { value: string; label: string; count?: number }[]; value: string; onPick: (v: string) => void; onClose: () => void }) {
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900 && !framed;
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const } : null;
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.sheetWrap, wide && styles.sheetWrapWide, frameBox]}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, wide && styles.sheetWide]}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={type.h2}>{title}</Text>
            <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close"><Icon name="close" size={18} color={colors.ink} /></Pressable>
          </Row>
          <ScrollView style={{ maxHeight: 420 }}>
            {options.map((o) => {
              const on = o.value === value;
              return (
                <Pressable key={o.value} onPress={() => onPick(o.value)} style={[styles.opt, on && styles.optOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                  <Text style={[type.body, { flex: 1 }, on && { color: colors.primaryFg, fontWeight: '600' }]}>{o.label}</Text>
                  {o.count != null ? <Text style={[type.small, on && { color: colors.primaryFg }]}>{o.count}</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Our side of a place, at the top of the drawer
// ---------------------------------------------------------------------------

/**
 * A place just found by searching, before it is anything of ours: save it to
 * try, or say we have been — with the source's own details, menu and order in
 * the tabs beside it, so the first thing you can check is that it is the right
 * one (owner, 4 Sep 2026).
 */
function NewPlacePanel({ venue, household, ctx: where, onChanged }: {
  venue: Venue; household: HouseholdResponse | null; ctx: { country?: string; countryCode?: string; locality?: string }; onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ctx = { label: venue.name, category: venue.category, lat: venue.lat ?? undefined, lng: venue.lng ?? undefined, venue, ...where };

  return (
    <View style={styles.ours}>
      <Row style={{ flexWrap: 'wrap' }}>
        <Text style={type.h3}>Ours</Text>
        <Chip label="Not in your places yet" />
      </Row>
      <Wrap>
        <Button label={adding ? 'Close' : "We've been here"} icon={adding ? 'close' : undefined} kind={adding ? 'ghost' : 'primary'} onPress={() => setAdding((a) => !a)} />
        <Button label="Save to try" kind="secondary" onPress={async () => { await api.savePlace(venue.venueRef, 'saved', ctx); setMsg(`Saved ${venue.name} to try.`); await onChanged(); }} />
      </Wrap>
      {msg ? <StatusLine tone="good">{msg}</StatusLine> : null}
      {adding && household ? (
        <BeenCapture venue={venue} household={household}
          onCreate={async (body) => { await api.createVisit({ venueRef: venue.venueRef, venueLabel: venue.name, category: venue.category, lat: venue.lat, lng: venue.lng, visitedOn: body.visitedOn, note: body.note, attendeeIds: body.attendeeIds, takes: body.takes, venue: { experiences: venue.experiences, cuisines: venue.cuisines, category: venue.category }, ...where }); }}
          onSaved={async () => { setAdding(false); setMsg(`Added ${venue.name} — thank you.`); await onChanged(); }} />
      ) : null}
      <Text style={type.tiny}>Rate the dishes on the Order tab when you have the menu.</Text>
    </View>
  );
}

function OursPanel({ place, household, ctx: where, viewer, onChanged, onRemoved }: { place: AtlasPlace; household: HouseholdResponse | null; ctx: { country?: string; countryCode?: string; locality?: string }; viewer: string | null; onChanged: () => Promise<void>; onRemoved: () => void }) {
  const [detail, setDetail] = useState<{ visits: Visit[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Visit | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const ctx = { label: place.name, category: place.category, lat: place.lat ?? undefined, lng: place.lng ?? undefined, ...where };
  const venue = atlasToVenue(place);
  const mine = myScore(place, viewer);

  const load = useCallback(async () => {
    try { const d = await api.place(place.venueRef); setDetail({ visits: d.visits }); } catch { setDetail({ visits: [] }); }
  }, [place.venueRef]);
  useEffect(() => { load(); }, [load]);

  return (
    <View style={styles.ours}>
      <Row style={{ flexWrap: 'wrap' }}>
        <Text style={type.h3}>Ours</Text>
        {place.visits ? <Chip label={`Been ${place.visits}×${place.lastOn ? ` · last ${place.lastOn}` : ''}`} /> : <Chip label="To try" />}
        {place.special ? <Chip label="Special" icon="keep" iconFill /> : null}

      </Row>
      {/* What each of us thought is the meal's record now, not a form on the
          place (owner, 4 Sep 2026): the stars are given on the order, and
          "our history here" shows what was ordered and what was loved. */}
      <Wrap>
        {/* Dishes are rated on the order; this is the whole evening in one tap,
            for the times nobody photographed a menu (owner, 4 Sep 2026). */}
        <Button label={adding ? 'Close' : "We've been here"} icon={adding ? 'close' : undefined} kind={adding ? 'ghost' : 'primary'} onPress={() => { setEditing(null); setDetailed(false); setAdding((a) => !a); }} />
        {!place.visits && place.ledger !== 'saved' && !place.special ? <Button label="Save to try" kind="secondary" onPress={async () => { await api.savePlace(place.venueRef, 'saved', ctx); setMsg('Saved to try.'); await onChanged(); }} /> : null}
        {place.visits > 0 && !place.special ? <Button label="Mark as special" icon="keep" kind="secondary" onPress={async () => { await api.savePlace(place.venueRef, 'special', ctx); setMsg('Marked special — the planner will go further for it.'); await onChanged(); }} /> : null}
      </Wrap>
      {/* Special is ours alone — no source has an opinion about it — and it is
          what you say after you have been (owner, 4 Sep 2026). */}
      {!place.visits && !place.special ? <Text style={type.tiny}>Special comes after you've been. Record the visit and it appears here.</Text> : null}
      {msg ? <StatusLine tone="good">{msg}</StatusLine> : null}
      {adding && household ? (
        detailed ? (
          <VisitForm venue={venue} household={household} onDone={async () => { setAdding(false); setDetailed(false); await load(); await onChanged(); }} onCancel={() => setDetailed(false)}
            createVia={async (body) => { await api.createVisit({ venueRef: place.venueRef, venueLabel: place.name, category: venue.category, lat: venue.lat, lng: venue.lng, visitedOn: body.visitedOn, note: body.note, attendeeIds: body.attendeeIds, takes: body.takes, venue: body.venue, ...where }); }} />
        ) : (
          <BeenCapture venue={venue} household={household} onMore={() => setDetailed(true)}
            onCreate={async (body) => { await api.createVisit({ venueRef: place.venueRef, venueLabel: place.name, category: venue.category, lat: venue.lat, lng: venue.lng, visitedOn: body.visitedOn, note: body.note, attendeeIds: body.attendeeIds, takes: body.takes, venue: { experiences: venue.experiences, cuisines: venue.cuisines, category: venue.category }, ...where }); }}
            onSaved={async () => { setAdding(false); setMsg('Saved — thank you.'); await load(); await onChanged(); }} />
        )
      ) : null}
      {editing && household ? (
        <VisitForm venue={venue} household={household} onDone={async () => { setEditing(null); await load(); await onChanged(); }} onCancel={() => setEditing(null)}
          initial={{ visitId: editing.id, date: editing.visitedOn, note: editing.note ?? '', rows: rowsForVisit(editing, household.members), attending: (editing.attendees as any[]).map((a) => (typeof a === 'string' ? household.members.find((m) => m.name === a)?.id ?? '' : a.id)).filter(Boolean) }} />
      ) : null}
      {place.note ? <Text style={type.small}>Our note: “{place.note}”</Text> : null}
      {/* Curating means being able to take something out again (owner, 4 Sep 2026). */}
      {place.visits ? null : (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button
            label={confirmRemove ? 'Tap again to remove' : 'Remove from Places'}
            icon={confirmRemove ? 'allergen' : 'close'}
            kind={confirmRemove ? 'danger' : 'ghost'}
            onPress={async () => {
              if (!confirmRemove) { setConfirmRemove(true); return; }
              try { await api.deleteAtlasPlace(place.venueRef); onRemoved(); await onChanged(); }
              catch (e: any) { setMsg(e.message); setConfirmRemove(false); }
            }}
          />
          {confirmRemove ? <Button label="Keep it" kind="ghost" onPress={() => setConfirmRemove(false)} /> : null}
        </Row>
      )}
      {detail?.visits.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.h3}>Our history here</Text>
          {/* A record, not a form: what everyone thought is given on the order
              after the meal, and this shows it (owner, 4 Sep 2026). */}
          {detail.visits.map((v) => <VisitSummary key={v.id} visit={v} />)}
        </View>
      ) : detail ? <Text style={type.small}>No visit recorded here yet.</Text> : <Text style={type.tiny}>Loading our history…</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Add a place you already know, by name, near somewhere in the city
// ---------------------------------------------------------------------------

/**
 * Add a place: a search box, and that is all (owner, 4 Sep 2026 — "I'm already
 * in London. I don't need to see any of that stuff… I have my search box.
 * That's it"). The bar above chooses what kind of place; the city, or the
 * radius from home, is where it looks. Which sources answered is an admin's
 * question, so it hides behind a chip on a wide screen only.
 */
function AddPlace({ household, kind, centre, radiusKm, ctx, wide, onAdded, onOpen }: {
  household: HouseholdResponse | null; kind: Kind; centre: { lat: number; lng: number } | null; radiusKm: number;
  ctx: { country?: string; countryCode?: string; locality?: string }; wide: boolean; onAdded: () => Promise<void>;
  /** Open the place in the drawer, where its details, menu and order live. */
  onOpen: (v: Venue) => void;
}) {
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<{ placeId: string; name: string; where: string | null; kind: string | null }[]>([]);
  const [sources, setSources] = useState<string[] | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Venue[] | null>(null);
  const [rating, setRating] = useState<Venue | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const admin = wide && isAdmin();
  // One session of typing is one billable session at the provider.
  const session = useRef(uuid());
  const typing = useRef<any>(null);
  // Choosing a prediction puts its name in the box; that must not ask for predictions again.
  const justChose = useRef(false);

  // Predictions arrive as the household types, biased by where it is looking.
  useEffect(() => {
    const text = q.trim();
    if (typing.current) clearTimeout(typing.current);
    if (justChose.current) { justChose.current = false; return; }
    if (text.length < 2) { setSuggestions([]); return; }
    typing.current = setTimeout(async () => {
      try {
        const r = await api.suggestPlaces({ q: text, near: centre ? `${centre.lat},${centre.lng}` : undefined, radiusKm: Math.max(radiusKm, 15), session: session.current });
        setSuggestions(r.suggestions.slice(0, 6));
      } catch { /* the Search button still works */ }
    }, 250);
    return () => { if (typing.current) clearTimeout(typing.current); };
  }, [q, centre?.lat, centre?.lng]);

  /**
   * A chosen prediction opens in the drawer — the first thing to know is that
   * this is the right Sebastian's, and the details, menu and order are there
   * (owner, 4 Sep 2026).
   */
  const choose = async (placeId: string, name: string) => {
    justChose.current = true;
    setSuggestions([]); setQ(name); setBusy(true); setMsg(null);
    session.current = uuid();
    try {
      const d = await api.place(`google:${placeId}`);
      if (d.venue) onOpen({ ...d.venue, household: d.household } as Venue);
      else setMsg("Couldn't open that one.");
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  /** Everything of this kind nearby, when you would rather browse than name something. */
  const search = async () => {
    if (!centre) { setMsg('Nowhere to look from yet — set your home address in Settings.'); return; }
    setSuggestions([]); setBusy(true); setMsg(null);
    try {
      const r = await api.searchPlaces({
        near: `${centre.lat},${centre.lng}`, categories: kind === 'do' ? 'things' : kind === 'eat' ? 'food' : undefined,
        q: q.trim() || undefined, radiusKm, sources: sources?.join(',') || undefined,
      });
      setRes(r.results);
      if (!r.results.length) setMsg('Nothing found nearby. Try the name of the place.');
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  const save = async (v: Venue, status: 'saved' | 'special' = 'saved') => {
    await api.savePlace(v.venueRef, status, { label: v.name, venue: v, category: v.category, lat: v.lat, lng: v.lng, ...ctx });
    setMsg(`Saved ${v.name} to try.`);
    await onAdded();
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={styles.searchRow}>
        <TextInput
          value={q} onChangeText={setQ} autoFocus placeholder="Search for a place" placeholderTextColor={colors.inkFaint}
          style={[styles.input, { flex: 1 }]} onSubmitEditing={search} returnKeyType="search" accessibilityLabel="Search for a place"
        />
        <Button label="Search" icon="search" onPress={search} loading={busy} />
      </View>
      {suggestions.length ? (
        <View style={styles.list}>
          {suggestions.map((sg, i) => (
            <Pressable key={sg.placeId} onPress={() => choose(sg.placeId, sg.name)} style={[styles.row, i > 0 && styles.rowLine]} accessibilityRole="button">
              <View style={{ width: 22, alignItems: 'center' }}><Icon name="address" size={16} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={type.h3} numberOfLines={1}>{sg.name}</Text>
                {sg.kind || sg.where ? <Text style={type.tiny} numberOfLines={1}>{[sg.kind, sg.where].filter(Boolean).join(' · ')}</Text> : null}
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
      {admin ? (
        <View style={styles.filters}>
          <FilterChip label={sources?.length ? `Sources · ${sources.length}` : 'Sources'} on={!!sources?.length} onPress={() => setShowSources((v) => !v)} />
        </View>
      ) : null}
      {admin && showSources ? <Card><SourcePicker value={sources} onChange={setSources} /></Card> : null}
      {msg ? <StatusLine tone={msg.startsWith('Added') || msg.startsWith('Saved') ? 'good' : 'warn'}>{msg}</StatusLine> : null}
      {rating && household ? (
        <VisitForm venue={rating} household={household} onDone={async () => { setRating(null); setMsg(`Added ${rating.name} as somewhere you've been.`); await onAdded(); }} onCancel={() => setRating(null)}
          createVia={async (body) => { await api.createVisit({ venueRef: rating.venueRef, venueLabel: rating.name, category: rating.category, lat: rating.lat, lng: rating.lng, visitedOn: body.visitedOn, note: body.note, attendeeIds: body.attendeeIds, takes: body.takes, venue: body.venue, ...ctx }); }} />
      ) : null}
      {res?.slice(0, 40).map((v) => (
        <VenueRow key={v.venueRef} venue={v} stack={!wide} onPress={() => onOpen(v)} action={
          <Row>
            <Button label="Been" kind="secondary" onPress={() => setRating(v)} />
            <Button label="To try" kind="ghost" onPress={() => save(v)} />
          </Row>
        } />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { width: '100%', paddingBottom: spacing.xl },
  pageWide: { flexDirection: 'row', alignItems: 'flex-start', maxWidth: 1400, alignSelf: 'center' },
  atlasCol: { width: '100%' },
  atlasColWide: { width: 340, borderRightWidth: 1, borderRightColor: colors.line, minHeight: 600 },
  cityCol: { width: '100%' },
  cityColWide: { flex: 1, minWidth: 0 },
  // The one mint field (style guide): no shadow, just its colour.
  field: { backgroundColor: colors.headerBg, padding: spacing.lg, gap: spacing.sm },
  fieldWide: { backgroundColor: 'transparent', paddingBottom: 0 },
  body: { padding: spacing.lg, gap: spacing.md },
  list: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10, paddingHorizontal: spacing.md, minHeight: TARGET },
  rowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  rowSub: { paddingLeft: 40, backgroundColor: colors.panel },
  rowOn: { backgroundColor: colors.accentSoft },
  counts: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, height: 20, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  countText: { fontSize: 11, fontWeight: '600', color: colors.inkMuted },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  fchip: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 32, paddingLeft: 10, paddingRight: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, maxWidth: 150 },
  fchipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  fchipText: { fontSize: 12, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  viewToggle: { flexDirection: 'row', height: 32, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 2, gap: 2 },
  viewBtn: { width: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  viewBtnOn: { backgroundColor: colors.primary },
  split: { gap: spacing.md },
  splitWide: { flexDirection: 'row', alignItems: 'flex-start' },
  prow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 9, paddingHorizontal: spacing.md, minHeight: TARGET },
  well: { width: 28, height: 28, borderRadius: radius.md, backgroundColor: colors.well, alignItems: 'center', justifyContent: 'center' },
  heart: { position: 'absolute', right: -5, top: -5, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 3, minWidth: 0 },
  // A ring the type colour, so the Northern line's black reads on the dark ground and the Circle line's yellow on the light one.
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.inkMuted },
  score: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 4 },
  scoreText: { fontSize: 13, fontWeight: '700', color: colors.ink },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pill: { height: 18, paddingHorizontal: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  pillText: { fontSize: 11, fontWeight: '700', color: colors.inkMuted },
  getting: { gap: 4, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  line: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 24, paddingHorizontal: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
  lineText: { fontSize: 12, fontWeight: '600', color: colors.ink },
  tryChip: { height: 24, paddingHorizontal: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  tryText: { fontSize: 11, fontWeight: '600', color: colors.inkMuted },
  mapWrap: { position: 'relative' },
  pinCard: { position: 'absolute', left: spacing.sm, right: spacing.sm, bottom: spacing.sm, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  mapHint: { position: 'absolute', left: spacing.sm, bottom: spacing.sm, backgroundColor: colors.surface, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.md, overflow: 'hidden' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheetWrapWide: { justifyContent: 'center', alignItems: 'center' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(29,27,22,0.35)' },
  sheet: { backgroundColor: colors.panel, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, maxHeight: '80%' },
  sheetWide: { width: 360, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  close: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  opt: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md },
  optOn: { backgroundColor: colors.primary },
  ours: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  scores: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, alignItems: 'center' },
  scoreLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
});

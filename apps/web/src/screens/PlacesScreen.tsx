import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { CategoryIcon, Icon } from '../components/Icon';
import { api, AtlasCity, AtlasCountry, AtlasPlace, BrowseItem, HouseholdResponse, Place, Venue, Visit } from '../api';
import { MapView, MapPin } from '../components/MapView';
import { VenueDrawer } from '../components/VenueDrawer';
import type { TripPrefill } from './TripsScreen';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap } from '../components/ui';
import { PlacePicker } from '../components/PlacePicker';
import { SourcePicker } from '../components/SourcePicker';
import { VenueRow, VisitForm, VisitSummary, rowsForVisit } from '../components/Visits';
import { getViewer, onViewerChange } from '../viewer';

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

function atlasToBrowseItem(p: AtlasPlace): BrowseItem {
  const v = (p.venue ?? {}) as Partial<Venue>;
  const [source] = p.venueRef.split(':');
  return {
    id: p.venueRef, venueRef: p.venueRef, name: p.name, category: p.category ?? v.category ?? 'attraction', lat: p.lat ?? 0, lng: p.lng ?? 0,
    dwellMinutes: 0, reasons: [], justification: null, startsAt: null, endsAt: null, pinned: false, source,
    cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], address: (v.address as any)?.line1 ?? (typeof v.address === 'string' ? v.address : null), website: v.website ?? null, openingHours: v.openingHours ?? null,
  };
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function PlacesScreen({ household, refreshHousehold, onPlanTrip }: { household: HouseholdResponse | null; refreshHousehold: () => Promise<void>; onPlanTrip?: (p: TripPrefill) => void }) {
  const { width, height } = useViewport();
  const wide = width >= 1000;
  const [data, setData] = useState<{ countries: AtlasCountry[]; unplaced: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCodes, setOpenCodes] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<{ country: string; city: string } | null>(null);
  const [addingCity, setAddingCity] = useState(false);
  const [places, setPlaces] = useState<AtlasPlace[]>([]);
  const [wherePending, setWherePending] = useState(0);
  const [open, setOpen] = useState<AtlasPlace | null>(null);
  const refills = useRef(0);

  const members = household?.members ?? [];
  const [viewer, setViewer] = useState<string | null>(null);
  useEffect(() => { setViewer(getViewer(members)); return onViewerChange(setViewer); }, [members.map((m) => m.id).join(',')]);

  const loadAtlas = useCallback(async () => { try { setData(await api.atlas()); } catch (e: any) { setError(e.message); } }, []);
  useEffect(() => { loadAtlas(); }, [loadAtlas]);

  const single = data && data.countries.length === 1 ? data.countries[0] : null;
  const country = sel ? data?.countries.find((c) => c.code === sel.country) ?? null : null;
  const city = sel && country ? country.cities.find((c) => c.name === sel.city) ?? null : null;

  const loadPlaces = useCallback(async () => {
    if (!sel) { setPlaces([]); setWherePending(0); return; }
    try {
      const r = await api.atlasPlaces({ country: sel.country, city: sel.city });
      setPlaces(r.places); setWherePending(r.wherePending ?? 0);
    } catch (e: any) { setError(e.message); }
  }, [sel?.country, sel?.city]);
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
                <PlacePicker value={null} onPick={async (p) => { if (!p) return; try { const r = await api.createAtlasCity({ place: p }); await loadAtlas(); setAddingCity(false); setSel({ country: r.city.countryCode, city: r.city.name }); setOpenCodes((s) => new Set(s).add(r.city.countryCode)); setError(null); } catch (e: any) { setError(e.message); } }} placeholder="A city or a region — Lisbon · Bath · Lake District" />
                <Text style={[type.tiny, { color: colors.headerSub }]}>A country is not a destination: type the city or region you'd say you were going to.</Text>
              </View>
            ) : null}
            {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
          </View>
          <View style={styles.body}>
            {!data ? <Text style={type.small}>Loading your atlas…</Text> : null}
            {data && data.countries.length === 0 ? <Card><Text style={type.body}>Your atlas is empty so far.</Text><Text style={type.small}>Add a city above, then the places you know there. Visits and trip shortlists land here by themselves.</Text></Card> : null}
            {data && data.countries.length > 0 ? (
              <View style={styles.list}>
                {single ? single.cities.map((ci, i) => <CityRow key={ci.name} city={ci} first={i === 0} selected={sel?.city === ci.name} onPress={() => pick(single, ci)} />) : data.countries.map((c, i) => {
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
                      {isOpen ? c.cities.map((ci) => <CityRow key={ci.name} city={ci} sub selected={sel?.country === c.code && sel?.city === ci.name} onPress={() => pick(c, ci)} />) : null}
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

      {showCity && country && city ? (
        <CityPanel
          key={`${country.code}/${city.name}`}
          country={country} city={city} places={places} household={household} viewer={viewer} wide={wide} viewportHeight={height}
          onBack={() => { setSel(null); setOpen(null); }} onOpen={setOpen} openRef={open?.venueRef ?? null}
          onPlanTrip={() => onPlanTrip?.({ placeText: `${city.name}, ${country.name}`, countryCode: country.code })}
          onChanged={refreshAll}
        />
      ) : wide ? (
        <View style={[styles.body, { flex: 1, paddingTop: spacing.xl }]}><Text style={type.small}>Pick a city to see everything you've put there.</Text></View>
      ) : null}

      <VenueDrawer
        item={open ? atlasToBrowseItem(open) : null}
        baseLabel={city?.name ?? null}
        onClose={() => setOpen(null)}
        onVenue={async (v) => { if (open?.unnamed && v.name) { try { await api.nameAtlasPlace(open.venueRef, v.name); await loadPlaces(); } catch { /* the drawer still shows the fetched name */ } } }}
        ours={open && country && city ? <OursPanel place={open} household={household} country={country} cityName={city.name} viewer={viewer} onChanged={refreshAll} /> : null}
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

function CityPanel({ country, city, places, household, viewer, wide, viewportHeight, onBack, onOpen, openRef, onPlanTrip, onChanged }: {
  country: AtlasCountry; city: AtlasCity; places: AtlasPlace[]; household: HouseholdResponse | null; viewer: string | null; wide: boolean; viewportHeight: number;
  onBack: () => void; onOpen: (p: AtlasPlace) => void; openRef: string | null; onPlanTrip: () => void; onChanged: () => Promise<void>;
}) {
  const [kind, setKind] = useState<Kind>('all');
  const [status, setStatus] = useState<Status>('any');
  const [typeF, setTypeF] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('name');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [sheet, setSheet] = useState<'status' | 'type' | 'sort' | null>(null);
  const [adding, setAdding] = useState(false);
  const [selPin, setSelPin] = useState<string | null>(null);

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
          {!wide ? <Button label={country.name} icon="back" kind="ghost" onPress={onBack} /> : <View />}
          <Button label="Plan a trip here" icon="plan" onPress={onPlanTrip} />
        </Row>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={type.title}>{city.name}</Text>
            <Text style={[type.small, { color: colors.headerSub }]} numberOfLines={2}>{country.name} · {places.length} place{places.length === 1 ? '' : 's'}{'\n'}{places.filter((p) => p.visits > 0).length} been · {places.filter((p) => !p.visits).length} to try{places.filter((p) => p.special).length ? ` · ${places.filter((p) => p.special).length} special` : ''}</Text>
          </View>
          <Button label={adding ? 'Close' : 'Add a place'} icon={adding ? 'close' : 'add'} kind="secondary" onPress={() => setAdding((a) => !a)} />
        </Row>
      </View>
      <View style={styles.body}>
        {adding ? <AddPlaceHere household={household} country={country} city={city} cityName={city.name} onAdded={async () => { await onChanged(); }} /> : null}
        <Segmented value={kind} options={[{ value: 'all', label: `Everything ${counts.all}` }, { value: 'do', label: `Things to do ${counts.do}` }, { value: 'eat', label: `Food & drink ${counts.eat}` }]} onChange={(k) => { setKind(k); setTypeF(null); setSelPin(null); }} />
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

function OursPanel({ place, household, country, cityName, viewer, onChanged }: { place: AtlasPlace; household: HouseholdResponse | null; country: AtlasCountry; cityName: string; viewer: string | null; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<{ visits: Visit[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Visit | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ctx = { label: place.name, category: place.category, lat: place.lat ?? undefined, lng: place.lng ?? undefined, country: country.name, countryCode: country.code, locality: cityName };
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
        {place.onTrips.map((t) => <Chip key={t} label={`On: ${t}`} />)}
      </Row>
      {place.scores.length ? (
        <View style={styles.scores}>
          {place.scores.map((s) => (
            <View key={s.memberId} style={styles.scoreLine}>
              <Icon name="favourite" size={14} fill />
              <Text style={[type.small, { color: colors.ink, fontWeight: '700' }]}>{fmtScore(s.score)}</Text>
              <Text style={type.small}>{s.member.split(' ')[0]}{s.memberId === viewer ? ' (you)' : ''}</Text>
            </View>
          ))}
          {mine == null ? <Text style={type.tiny}>You haven't scored it yet.</Text> : null}
        </View>
      ) : null}
      <Wrap>
        <Button label="We've been here" onPress={() => { setEditing(null); setAdding((a) => !a); }} kind={adding ? 'ghost' : 'primary'} />
        {!place.visits && place.ledger !== 'saved' && !place.special ? <Button label="Save to try" kind="secondary" onPress={async () => { await api.savePlace(place.venueRef, 'saved', ctx); setMsg('Saved to try.'); await onChanged(); }} /> : null}
        {place.visits > 0 && !place.special ? <Button label="Mark as special" icon="keep" kind="secondary" onPress={async () => { await api.savePlace(place.venueRef, 'special', ctx); setMsg('Marked special — the planner will go further for it.'); await onChanged(); }} /> : null}
      </Wrap>
      {/* Special is ours alone — no source has an opinion about it — and it is
          what you say after you have been (owner, 4 Sep 2026). */}
      {!place.visits && !place.special ? <Text style={type.tiny}>Special comes after you've been. Record the visit and it appears here.</Text> : null}
      {msg ? <StatusLine tone="good">{msg}</StatusLine> : null}
      {adding && household ? (
        <VisitForm venue={venue} household={household} onDone={async () => { setAdding(false); await load(); await onChanged(); }} onCancel={() => setAdding(false)}
          createVia={async (body) => { await api.createVisit({ venueRef: place.venueRef, venueLabel: place.name, category: venue.category, lat: venue.lat, lng: venue.lng, visitedOn: body.visitedOn, note: body.note, attendeeIds: body.attendeeIds, takes: body.takes, venue: body.venue, country: country.name, countryCode: country.code, locality: cityName }); }} />
      ) : null}
      {editing && household ? (
        <VisitForm venue={venue} household={household} onDone={async () => { setEditing(null); await load(); await onChanged(); }} onCancel={() => setEditing(null)}
          initial={{ visitId: editing.id, date: editing.visitedOn, note: editing.note ?? '', rows: rowsForVisit(editing, household.members), attending: (editing.attendees as any[]).map((a) => (typeof a === 'string' ? household.members.find((m) => m.name === a)?.id ?? '' : a.id)).filter(Boolean) }} />
      ) : null}
      {place.note ? <Text style={type.small}>Our note: “{place.note}”</Text> : null}
      <GettingThere place={place} />
      {detail?.visits.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.h3}>Our history here</Text>
          <Text style={type.tiny}>Tap a visit to change what everyone thought.</Text>
          {detail.visits.map((v) => <VisitSummary key={v.id} visit={v} onPress={() => { setAdding(false); setEditing(v); }} />)}
        </View>
      ) : detail ? <Text style={type.small}>No visit recorded here yet.</Text> : <Text style={type.tiny}>Loading our history…</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Add a place you already know, by name, near somewhere in the city
// ---------------------------------------------------------------------------

function AddPlaceHere({ household, country, city, cityName, onAdded }: { household: HouseholdResponse | null; country: AtlasCountry; city: AtlasCity | null; cityName: string; onAdded: () => Promise<void> }) {
  const [near, setNear] = useState<Place | null>(city?.lat != null ? { label: cityName, lat: city.lat!, lng: city.lng! } : null);
  const [cat, setCat] = useState<'things' | 'food' | ''>('things');
  const [q, setQ] = useState('');
  const [radiusKm, setRadiusKm] = useState(3);
  const [sources, setSources] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Venue[] | null>(null);
  const [rating, setRating] = useState<Venue | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ctx = { country: country.name, countryCode: country.code, locality: cityName };
  const search = async () => {
    if (!near) { setMsg('Pick where in the city to look.'); return; }
    setBusy(true); setMsg(null);
    try { setRes((await api.searchPlaces({ near: `${near.lat},${near.lng}`, categories: cat || undefined, q: q || undefined, radiusKm, sources: sources?.join(',') })).results); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <Text style={type.h3}>Add a place in {cityName}</Text>
      <Text style={type.tiny}>A place you already know. Finding somewhere new is a trip's job — Trips › Find.</Text>
      <PlacePicker value={near} onPick={setNear} placeholder={`Near — a neighbourhood, landmark or address in ${cityName}`} />
      <Segmented value={cat} options={[{ value: 'things', label: 'Things to do' }, { value: 'food', label: 'Food & drink' }, { value: '', label: 'Everything' }]} onChange={setCat} />
      <Row>
        <TextInput value={q} onChangeText={setQ} placeholder="Name contains… (optional)" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} onSubmitEditing={search} />
        <Button label="Search" onPress={search} loading={busy} />
      </Row>
      <Wrap>{[1, 3, 5, 10].map((r) => <Chip key={r} label={`${r} km`} selected={radiusKm === r} onPress={() => setRadiusKm(r)} />)}</Wrap>
      <SourcePicker value={sources} onChange={setSources} />
      {msg ? <StatusLine tone={msg.startsWith('Added') || msg.startsWith('Saved') ? 'good' : 'warn'}>{msg}</StatusLine> : null}
      {rating && household ? (
        <VisitForm venue={rating} household={household} onDone={async () => { setRating(null); setMsg(`Added ${rating.name} as somewhere you've been.`); await onAdded(); }} onCancel={() => setRating(null)}
          createVia={async (body) => { await api.createVisit({ venueRef: rating.venueRef, venueLabel: rating.name, category: rating.category, lat: rating.lat, lng: rating.lng, visitedOn: body.visitedOn, note: body.note, attendeeIds: body.attendeeIds, takes: body.takes, venue: body.venue, ...ctx }); }} />
      ) : null}
      {res?.slice(0, 40).map((v) => (
        <VenueRow key={v.venueRef} venue={v} action={
          <Row>
            <Button label="Been" kind="secondary" onPress={() => setRating(v)} />
            <Button label="To try" kind="ghost" onPress={async () => { await api.savePlace(v.venueRef, 'saved', { label: v.name, venue: v, category: v.category, lat: v.lat, lng: v.lng, ...ctx }); setMsg(`Saved ${v.name} to try.`); await onAdded(); }} />
          </Row>
        } />
      ))}
    </Card>
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
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.line },
  score: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 4 },
  scoreText: { fontSize: 13, fontWeight: '700', color: colors.ink },
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

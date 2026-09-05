import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { CategoryIcon, Icon } from '../components/Icon';
import { api, AtlasCity, AtlasCountry, AtlasHome, AtlasPlace, BrowseItem, HouseholdResponse, Place, TripBrief, TripSummary, Venue, Visit } from '../api';
import { MapView, MapPin } from '../components/MapView';
import { VenueDrawer } from '../components/VenueDrawer';
import { VenueThumb } from '../components/VenueThumb';
import type { TripSeed } from './TripsScreen';
import { TripCard } from '../components/TripCard';
import { asList, asOneOf, asText, useQueryState, useRouter, useStickyQuery } from '../router';
import { MOODS, paths, type Route } from '../routes';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';

/** The picture square at the head of a place row, and at the head of an area row (handover §6: 56–64px). */
const WELL = 56;
const AREA_WELL = 60;
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap } from '../components/ui';
import { PlacePicker } from '../components/PlacePicker';
import { PickSheet } from '../components/PickSheet';
import { SourcePicker } from '../components/SourcePicker';
import { BeenCapture, VenueRow, VisitForm, VisitSummary, rowsForVisit } from '../components/Visits';
import { getViewer, onViewerChange, setViewer as rememberViewer } from '../viewer';
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

/**
 * An area's three lists (handover, 5 Sep 2026): something to do, somewhere to
 * eat, somewhere to stay. There is no "Everything" tab any more — the owner's
 * redesign draws three segments and the Hotels one only where there is one.
 */
type Kind = 'do' | 'eat' | 'stay';
/** Been there, kept for later, or kept and loved. The "All ▾" dropdown. */
type Status = 'any' | 'been' | 'saved' | 'special';
type Sort = 'name' | 'mine' | 'recent';

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1).replace(/-/g, ' ');
const fmtScore = (s: number) => s.toFixed(1).replace('.0', '');
/** "Feb 2024" — as precise as a row has room to be. */
const fmtMonth = (iso?: string | null) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', year: 'numeric' }) : null);

// Transport for London's own colours for its lines: the line's identity, not a UI code.
const LINE_COLOURS: Record<string, string> = {
  Bakerloo: '#B36305', Central: '#E32017', Circle: '#FFD300', District: '#00782A', 'Hammersmith & City': '#F3A9BB', Jubilee: '#A0A5A9',
  Metropolitan: '#9B0056', Northern: '#000000', Piccadilly: '#003688', Victoria: '#0098D4', 'Waterloo & City': '#95CDBA', 'Elizabeth line': '#6950A1',
  DLR: '#00A4A7', 'London Overground': '#EE7C0E', Liberty: '#5D6061', Lioness: '#FAA61A', Mildmay: '#0077AD', Suffragette: '#5BBD72', Weaver: '#823A62', Windrush: '#ED1B00', Tram: '#84B817',
};

const EATING = ['restaurant', 'cafe', 'pub', 'bar'];
const SLEEPING = ['hotel', 'lodging'];

/** Which segment a place will show up under, from its category alone. */
const kindOfCategory = (c?: string | null): Kind => (SLEEPING.includes(String(c)) ? 'stay' : EATING.includes(String(c)) ? 'eat' : 'do');

const cuisinesOf = (p: AtlasPlace) => (((p.venue ?? {}) as Partial<Venue>).cuisines ?? []).filter(Boolean);
const experiencesOf = (p: AtlasPlace) => (((p.venue ?? {}) as Partial<Venue>).experiences ?? []).filter(Boolean);

// In Food & drink a restaurant is the assumption, so only the exceptions are
// named (owner, 4 Sep 2026: "if it's a bar, we put a bar pill in").
const CATEGORY_PILL: Record<string, string> = { bar: 'Bar', pub: 'Pub', cafe: 'Café' };

/**
 * Which of the three lists a place belongs to. A pub is somewhere you drink,
 * so it is Food & drink; a pub with a kitchen is also a thing to do on a
 * Sunday, so it is both.
 */
function kindsOf(p: AtlasPlace): Kind[] {
  const c = p.category ?? '';
  if (SLEEPING.includes(c) || (p.kind as string) === 'stay') return ['stay'];
  if (c === 'restaurant' || c === 'cafe') return ['eat'];
  if (c === 'pub' || c === 'bar') return experiencesOf(p).length ? ['eat', 'do'] : ['eat'];
  if (!c && p.kind === 'food') return ['eat'];
  return ['do'];
}

/** The kind of thing it is, in the words the Type dropdown uses, for the segment being looked at. */
function typeOf(p: AtlasPlace, kind: Kind): string {
  const c = p.category ?? '';
  const k = kind ?? kindsOf(p)[0];
  if (k === 'stay') {
    const experiences = experiencesOf(p);
    if (experiences.length) return cap(experiences[0]);
    return c === 'lodging' ? 'Places to stay' : 'Hotels';
  }
  if (k === 'eat') {
    const cuisines = cuisinesOf(p);
    if (cuisines.length) return cap(cuisines[0]);
    if (c === 'pub' || c === 'bar') return 'Pubs & bars';
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
  if (kind === 'stay') return typeOf(p, 'stay');
  if (kind === 'eat') return cuisines.length ? cap(cuisines[0]) : '';
  if (kind === 'do' || kindsOf(p)[0] === 'do') return typeOf(p, 'do');
  if (cuisines.length) return cap(cuisines[0]);
  return CATEGORY_PILL[c] ?? 'Restaurant';
}

const statusOf = (p: AtlasPlace): Exclude<Status, 'any'> => (p.visits > 0 ? 'been' : p.special ? 'special' : 'saved');
const matchesStatus = (p: AtlasPlace, s: Status) =>
  s === 'any' || (s === 'special' ? p.special : s === 'been' ? p.visits > 0 : p.visits === 0);
/**
 * The mark on a row: one person's if somebody is chosen, and the household's
 * between them when nobody is ("Anyone ▾"). An average of one is that one.
 */
const myScore = (p: AtlasPlace, viewer: string | null) => {
  if (viewer) return p.scores.find((s) => s.memberId === viewer)?.score ?? null;
  if (!p.scores.length) return null;
  return Math.round((p.scores.reduce((n, s) => n + s.score, 0) / p.scores.length) * 10) / 10;
};

/**
 * The green line under a row: what the household did here, and on which trip.
 *
 * Green is the status line everywhere in the redesign (handover §6); red is
 * kept for the heart and for a thing that still needs doing.
 */
function statusLine(p: AtlasPlace, kind: Kind, viewer: string | null): string {
  const trip = p.onTrips?.[0] ?? null;
  // A trip's name is often a whole sentence ("Kew Gardens with the Treetop
  // Walkway, then Richmond riverside"); a row has room for the first thing in it.
  const name = trip?.title ? trip.title.split(/\s+[·,]\s+|,\s+then\s+/)[0].trim() : null;
  const when = fmtMonth(p.lastOn) ?? trip?.on ?? null;
  const mine = myScore(p, viewer);
  if (p.visits > 0) {
    const verb = kind === 'stay' ? 'Stayed' : 'Been';
    const where = name ? `${name}${when ? `, ${when}` : ''}` : when;
    return [verb, where, mine != null ? `you ${fmtScore(mine)}` : null].filter(Boolean).join(' · ');
  }
  if (p.special) return name ? `Special · kept for ${name}` : 'Special · one of ours';
  return name ? `Saved · for ${name}` : 'Saved';
}

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

/** Inside a city: how the list is filtered and sorted, and whether it is a map. All of it is in the address. */
const CITY_KEYS = ['kind', 'status', 'type', 'mood', 'trip', 'sort', 'view'];

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function PlacesScreen({ route, household, refreshHousehold, onPlanTrip }: {
  /**
   * Which layer the address asks for: the atlas (`/places`), everything close
   * to home (`/places/home`), one country (`/places/IT`) or one area inside it
   * (`/places/GB/London`). Inspire's Food chip lands on `/places/home?kind=eat`
   * — the question already asked (owner, 5 Sep 2026: "if I clicked on food, it
   * would take me to the places tab and search for food").
   */
  route: Extract<Route, { name: 'places' }>;
  household: HouseholdResponse | null; refreshHousehold: () => Promise<void>; onPlanTrip?: (p: TripSeed) => void;
}) {
  const { width, height } = useViewport();
  const wide = width >= 1000;
  const { query, navigate, setQuery } = useRouter();
  const [data, setData] = useState<{ countries: AtlasCountry[]; unplaced: number; home: AtlasHome | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which layer the path asks for.
  const sel = route.scope;
  const atHome = !!sel && 'home' in sel;
  const country = sel && !atHome ? (sel as { country: string; city: string | null }) : null;
  const inArea = atHome || !!country?.city;
  const [addingCity, setAddingCity] = useState(false);
  const [places, setPlaces] = useState<AtlasPlace[]>([]);
  const [wherePending, setWherePending] = useState(0);
  // Which place's drawer is open, over whichever layer is showing.
  const openRef = query.get('place');
  const open = openRef ? places.find((p) => p.venueRef === openRef) ?? null : null;
  const setOpen = (p: AtlasPlace | null) => setQuery({ place: p?.venueRef ?? null }, { replace: false });
  // A place found by searching, before it is anything of ours: the drawer shows
  // its details so you can be sure it is the right one. It has no address of its
  // own — it is not one of the household's places yet.
  const [newVenue, setNewVenue] = useState<Venue | null>(null);
  // A place the household has just added: close the search, show the segment it
  // is in, and mark the row (owner, 4 Sep 2026: "when I exit out of that screen,
  // I want to come back to my places… and see the place that I've just added").
  const [landed, setLanded] = useState<{ venueRef: string; kind: Kind } | null>(null);

  const refills = useRef(0);

  const members = household?.members ?? [];
  const [viewer, setViewer] = useState<string | null>(null);
  useEffect(() => { setViewer(getViewer(members)); return onViewerChange(setViewer); }, [members.map((m) => m.id).join(',')]);

  const loadAtlas = useCallback(async () => { try { setData(await api.atlas()); } catch (e: any) { setError(e.message); } }, []);
  useEffect(() => { loadAtlas(); }, [loadAtlas]);

  const countryRow = country ? data?.countries.find((c) => c.code === country.country) ?? null : null;
  const city = countryRow && country?.city ? countryRow.cities.find((c) => c.name === country.city) ?? null : null;
  const home = atHome ? data?.home ?? null : null;

  const loadPlaces = useCallback(async () => {
    if (!inArea || !sel) { setPlaces([]); setWherePending(0); return; }
    try {
      const r = 'home' in sel ? await api.atlasPlaces({ nearHome: true }) : await api.atlasPlaces({ country: sel.country, city: sel.city! });
      setPlaces(r.places); setWherePending(r.wherePending ?? 0);
    } catch (e: any) { setError(e.message); }
  }, [inArea, atHome ? 'home' : country?.country, atHome ? '' : country?.city]);
  useEffect(() => { refills.current = 0; loadPlaces(); }, [loadPlaces]);
  // Postcode and station are looked up in the background after the first read; ask again a few times while any row is waiting.
  useEffect(() => {
    if (!wherePending || refills.current >= 6) return;
    const t = setTimeout(() => { refills.current += 1; loadPlaces(); }, 5000);
    return () => clearTimeout(t);
  }, [wherePending, places]);

  const refreshAll = async () => { await loadAtlas(); await loadPlaces(); await refreshHousehold(); };

  return (
    <ScrollView contentContainerStyle={[styles.page, wide && styles.pageWide]} keyboardShouldPersistTaps="handled">
      {/* One tree, whichever layer the address asks for, so the Web / Mobile
          toggle does not throw the screen's state away (CLAUDE.md). */}
      {!sel ? (
        <AtlasRoot
          data={data} error={error} household={household} members={members} viewer={viewer} wide={wide}
          adding={addingCity} onAdding={setAddingCity}
          onAdd={async (place) => {
            try { const r = await api.createAtlasCity({ place }); await loadAtlas(); setAddingCity(false); navigate(paths.placesCity(r.city.countryCode, r.city.name)); setError(null); }
            catch (e: any) { setError(e.message); }
          }}
        />
      ) : null}

      {country && !country.city ? (
        <CountryPanel
          key={country.country}
          code={country.country} row={countryRow} wide={wide}
          onBack={() => navigate(paths.places())}
          onArea={(name) => navigate(paths.placesCity(country.country, name))}
        />
      ) : null}

      {inArea && (city || home) ? (
        <CityPanel
          key={home ? 'home' : `${countryRow?.code}/${city!.name}`}
          country={countryRow} city={city} home={home} places={places} household={household} viewer={viewer} wide={wide} viewportHeight={height}
          onBack={() => navigate(home ? paths.places() : paths.placesCountry(countryRow!.code))}
          onOpen={setOpen} onOpenVenue={setNewVenue} openRef={open?.venueRef ?? null}
          landed={landed} onLandedShown={() => setLanded(null)}
          onPlanTrip={() => onPlanTrip?.(home ? { placeText: home.label ?? 'home' } : { placeText: `${city!.name}, ${countryRow!.name}`, countryCode: countryRow!.code })}
          onChanged={refreshAll}
        />
      ) : null}

      {sel && !inArea && !countryRow && data ? (
        <View style={styles.body}><StatusLine tone="warn">Nothing in your atlas for {country?.country} yet.</StatusLine></View>
      ) : null}

      <VenueDrawer
        item={newVenue ? venueToBrowseItem(newVenue) : open ? atlasToBrowseItem(open) : null}
        baseLabel={city?.name ?? (home ? 'home' : null)}
        onClose={() => { setOpen(null); setNewVenue(null); }}
        onVenue={async (v) => { if (open?.unnamed && v.name) { try { await api.nameAtlasPlace(open.venueRef, v.name); await loadPlaces(); } catch { /* the drawer still shows the fetched name */ } } }}
        capture={(() => {
          const v = newVenue ?? (open ? atlasToVenue(open) : null);
          if (!v) return null;
          const w = countryRow && city ? { country: countryRow.name, countryCode: countryRow.code, locality: city.name } : {};
          const known = newVenue ? !!newVenue.household?.visits || !!newVenue.household?.ledger : !!open;
          return <CapturePanel venue={v} household={household} ctx={w} been={!!(newVenue ? newVenue.household?.visits : open?.visits)} saved={known} onChanged={refreshAll}
            onLanded={(venueRef, kind) => setLanded({ venueRef, kind })} />;
        })()}
        ours={newVenue
          ? <NewPlacePanel venue={newVenue} household={household} ctx={countryRow && city ? { country: countryRow.name, countryCode: countryRow.code, locality: city.name } : {}} onChanged={refreshAll} />
          : open ? <OursPanel place={open} household={household} ctx={countryRow && city ? { country: countryRow.name, countryCode: countryRow.code, locality: city.name } : {}} viewer={viewer} onChanged={refreshAll} onRemoved={() => setOpen(null)} /> : null}
        gettingThere={open ? <GettingThere place={open} /> : null}
      />
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// The atlas: near home, the country you live in, and abroad
// ---------------------------------------------------------------------------

/**
 * The root of Places (handover, 5 Sep 2026, screen 3a): "All areas · Anyone
 * only — Saved/Been lives at city level. Below: Near home · UK · Abroad
 * (countries, flag tiles). Each row carries areas · places · trips and a
 * last/next trip line."
 *
 * So the country is the unit here, not the city, and the counting is what a row
 * says rather than a filter to set: a household with places in five countries
 * wants to see five rows, not thirty cities.
 */
function AtlasRoot({ data, error, household, members, viewer, wide, adding, onAdding, onAdd }: {
  data: { countries: AtlasCountry[]; unplaced: number; home: AtlasHome | null } | null;
  error: string | null; household: HouseholdResponse | null; members: { id: string; name: string }[]; viewer: string | null; wide: boolean;
  adding: boolean; onAdding: (v: boolean) => void; onAdd: (place: Place) => Promise<void>;
}) {
  const { navigate } = useRouter();
  // How the list is set — which part of the world, and whose verdicts the rows
  // show — is query, never path (CLAUDE.md).
  const [area, setArea] = useQueryState<'all' | 'home' | 'uk' | 'abroad'>('area', 'all', asOneOf(['all', 'home', 'uk', 'abroad'] as const, 'all'));
  const [sheet, setSheet] = useState<'area' | 'who' | null>(null);

  const homeCode = data?.home?.countryCode ?? null;
  const countries = data?.countries ?? [];
  const homeCountry = homeCode ? countries.find((c) => c.code === homeCode) ?? null : null;
  const abroad = countries.filter((c) => c.code !== homeCode);

  const showHome = area === 'all' || area === 'home';
  const showHomeCountry = area === 'all' || area === 'uk';
  const showAbroad = area === 'all' || area === 'abroad';

  const areaOptions = [
    { value: 'all', label: 'All areas', count: countries.length },
    { value: 'home', label: 'Near home', count: data?.home?.places ?? 0 },
    ...(homeCountry ? [{ value: 'uk', label: homeCountry.name, count: homeCountry.places }] : []),
    { value: 'abroad', label: 'Abroad', count: abroad.reduce((n, c) => n + c.places, 0) },
  ];
  const whoOptions = [{ value: '', label: 'Anyone' }, ...members.map((m) => ({ value: m.id, label: m.name }))];
  const whoLabel = members.find((m) => m.id === viewer)?.name ?? 'Anyone';

  return (
    <View style={{ width: '100%' }}>
      <View style={[styles.field, wide && styles.fieldWideCentred]}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={type.title}>Places</Text>
          <Pressable onPress={() => onAdding(!adding)} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel={adding ? 'Close' : 'Add an area'}>
            <Icon name={adding ? 'close' : 'add'} size={19} color={colors.ink} />
          </Pressable>
        </Row>
        <Text style={[type.small, { color: colors.headerSub }]}>Where you've been and what you liked.</Text>
        {adding ? (
          <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            <PlacePicker kind="area" autoFocus value={null} onPick={(p) => { if (p) onAdd(p); }} placeholder="Lisbon · Bath · the Lake District" />
          </View>
        ) : null}
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      </View>

      <View style={[styles.body, wide && styles.bodyCentred]}>
        <View style={styles.filters}>
          <FilterChip label={areaOptions.find((o) => o.value === area)?.label ?? 'All areas'} on={area !== 'all'} onPress={() => setSheet('area')} />
          <FilterChip label={whoLabel} on={!!viewer} onPress={() => setSheet('who')} />
        </View>

        {!data ? <Text style={type.small}>Loading your atlas…</Text> : null}
        {data && !countries.length && !data.home?.places ? (
          <Card><Text style={type.body}>Your atlas is empty so far.</Text><Text style={type.small}>Add an area above, then the places you know there. Visits and trip shortlists land here by themselves.</Text></Card>
        ) : null}

        {showHome && data?.home ? (
          <>
            <Text style={type.label}>Near home</Text>
            <View style={styles.list}>
              <AreaRow
                title="Close to home"
                meta={data.home.places ? `Within ${data.home.radiusMiles} miles · ${data.home.places} place${data.home.places === 1 ? '' : 's'}${data.home.special ? ` · ${data.home.special} saved` : ''}` : `Nothing within ${data.home.radiusMiles} miles yet`}
                status={data.home.been ? `${data.home.been} been · ${data.home.places - data.home.been} to try` : null}
                image={data.home.image} category="place" first
                onPress={() => navigate(paths.placesHome())}
              />
            </View>
          </>
        ) : null}

        {showHomeCountry && homeCountry ? (
          <>
            <Text style={type.label}>{homeCountry.name}</Text>
            <View style={styles.list}>
              <CountryRow country={homeCountry} first onPress={() => navigate(paths.placesCountry(homeCountry.code))} />
            </View>
          </>
        ) : null}

        {showAbroad && abroad.length ? (
          <>
            <Text style={type.label}>Abroad · {abroad.length} {abroad.length === 1 ? 'country' : 'countries'}</Text>
            <View style={styles.list}>
              {abroad.map((c, i) => <CountryRow key={c.code} country={c} first={i === 0} onPress={() => navigate(paths.placesCountry(c.code))} />)}
            </View>
          </>
        ) : null}

        {data?.unplaced ? <Text style={type.tiny}>{data.unplaced} place{data.unplaced === 1 ? '' : 's'} still being placed on the map.</Text> : null}
      </View>

      <PickSheet visible={sheet === 'area'} title="Which part of the world" options={areaOptions} value={area} onPick={(v) => { setArea(v as any); setSheet(null); }} onClose={() => setSheet(null)} />
      <PickSheet visible={sheet === 'who'} title="Whose verdicts" options={whoOptions} value={viewer ?? ''} onPick={(v) => { rememberViewer(v || null); setSheet(null); }} onClose={() => setSheet(null)} />
    </View>
  );
}

/**
 * A country, as a row: the flag tile the redesign draws, the areas and places
 * and trips in it, and the trip that says when the household was last there.
 *
 * The tile is the two-letter code rather than a flag image: the handover calls
 * the flags "2-letter code placeholders pending real flags", and a code we know
 * is right beats a flag sprite we would have to go and license.
 */
/**
 * "Puglia · Aug 2025", and never "Bath · Sep 2026 · Sept 2026": a trip's own
 * name often has the month in it already, and saying it twice reads as a bug.
 */
function tripWhen(t: TripBrief): string {
  const name = (t.label ?? '').split(/\s+[·,]\s+|,\s+then\s+/)[0].trim() || 'A trip';
  if (!t.on) return name;
  const [mon, year] = t.on.split(' ');
  const said = name.toLowerCase();
  return said.includes(mon.slice(0, 3).toLowerCase()) && said.includes(year) ? name : `${name} · ${t.on}`;
}

function CountryRow({ country: c, first, onPress }: { country: AtlasCountry; first?: boolean; onPress: () => void }) {
  const bits = [
    c.areas ? `${c.areas} area${c.areas === 1 ? '' : 's'}` : null,
    c.places ? `${c.places} place${c.places === 1 ? '' : 's'}` : null,
    c.trips ? `${c.trips} trip${c.trips === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const line = c.nextTrip ? `Next: ${tripWhen(c.nextTrip)}`
    : c.lastTrip ? `Last: ${tripWhen(c.lastTrip)}`
      : 'Nothing planned yet';
  return (
    <Pressable onPress={onPress} style={[styles.arow, !first && styles.rowLine]} accessibilityRole="button">
      <View style={styles.flag}><Text style={styles.flagText}>{c.code}</Text></View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={type.h3} numberOfLines={1}>{c.name}</Text>
        <Text style={type.small} numberOfLines={1}>{bits.join(' · ') || 'Nothing saved yet'}</Text>
        <Text style={styles.green} numberOfLines={1}>{line}</Text>
      </View>
      <Icon name="more" size={18} color={colors.inkMuted} />
    </Pressable>
  );
}

/** An area, or the standing "close to home" view: picture, name, counts, green line. */
function AreaRow({ title, meta, status, image, category, first, selected, onPress }: {
  title: string; meta: string; status?: string | null; image?: AtlasCity['image']; category?: string | null;
  first?: boolean; selected?: boolean; onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.arow, !first && styles.rowLine, selected && styles.rowOn]} accessibilityRole="button">
      <VenueThumb name={title} image={image ?? null} category={category ?? 'place'} width={AREA_WELL} height={AREA_WELL} rounded={radius.md} credit={false} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={type.h3} numberOfLines={1}>{title}</Text>
        <Text style={type.small} numberOfLines={1}>{meta}</Text>
        {status ? <Text style={styles.green} numberOfLines={1}>{status}</Text> : null}
      </View>
      <Icon name="more" size={18} color={colors.inkMuted} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// One country: its areas, and the trips that went there
// ---------------------------------------------------------------------------

/**
 * Handover 3b: "Areas · 4 | Trips · 3 segmented — one list at a time. Areas
 * drill into a city; Trips opens the trip itself, back returns here."
 */
function CountryPanel({ code, row, wide, onBack, onArea }: {
  code: string; row: AtlasCountry | null; wide: boolean; onBack: () => void; onArea: (name: string) => void;
}) {
  const { navigate } = useRouter();
  const [list, setList] = useQueryState<'areas' | 'trips'>('list', 'areas', asOneOf(['areas', 'trips'] as const, 'areas'));
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.trips({ country: code }).then((r) => { if (alive) setTrips(r.trips); }).catch((e) => setError(e.message));
    return () => { alive = false; };
  }, [code]);

  const cities = row?.cities ?? [];
  return (
    <View style={{ width: '100%' }}>
      <View style={[styles.field, wide && styles.fieldWideCentred]}>
        <Row style={{ gap: spacing.sm }}>
          <Pressable onPress={onBack} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel="Places"><Icon name="back" size={19} color={colors.ink} /></Pressable>
          <Text style={[type.title, { flex: 1 }]} numberOfLines={1}>{row?.name ?? code}</Text>
          <View style={styles.flag}><Text style={styles.flagText}>{code}</Text></View>
        </Row>
      </View>
      <View style={[styles.body, wide && styles.bodyCentred]}>
        <Segmented
          value={list}
          options={[{ value: 'areas' as const, label: `Areas · ${cities.length}` }, { value: 'trips' as const, label: `Trips · ${trips?.length ?? row?.trips ?? 0}` }]}
          onChange={setList}
        />
        {error ? <StatusLine tone="warn">{error}</StatusLine> : null}

        {list === 'areas' ? (
          cities.length ? (
            <View style={styles.list}>
              {cities.map((ci, i) => (
                <AreaRow
                  key={ci.name} first={i === 0} image={ci.image} category="place"
                  title={ci.name}
                  meta={[ci.places ? `${ci.places} place${ci.places === 1 ? '' : 's'}` : null,
                    ci.places && ci.places - ci.been ? `${ci.places - ci.been} saved` : null,
                    ci.trips ? `${ci.trips} trip${ci.trips === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || 'Nothing saved yet'}
                  status={ci.nextTrip ? `Next: ${tripWhen(ci.nextTrip)}` : ci.lastTrip ? `Last: ${tripWhen(ci.lastTrip)}` : 'Not yet visited'}
                  onPress={() => onArea(ci.name)}
                />
              ))}
            </View>
          ) : <Card><Text style={type.small}>No areas here yet. Open a trip to {row?.name ?? code}, or add one from Places.</Text></Card>
        ) : null}

        {list === 'trips' ? (
          trips == null ? <Text style={type.small}>Loading…</Text>
            : trips.length ? <View style={{ gap: spacing.sm }}>{trips.map((t) => <TripCard key={t.id} trip={t} onPress={() => navigate(paths.trip(t.id))} />)}</View>
              : <Card><Text style={type.small}>No trips to {row?.name ?? code} yet.</Text></Card>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Inside a city
// ---------------------------------------------------------------------------

/**
 * One area (handover 3c/3d): "Activities | Food & drink | Hotels segmented
 * (Hotels only in holiday areas). Chips are dropdowns: All ▾ (All / Saved /
 * Been), Type ▾ (Historic, Museum, Outdoors…), Mood ▾ (Fun, Culture…), plus a
 * specific trip. Green tick = been, red heart = saved."
 */
function CityPanel({ country, city, home, places, household, viewer, wide, viewportHeight, onBack, onOpen, onOpenVenue, openRef, onPlanTrip, onChanged, landed, onLandedShown }: {
  country: AtlasCountry | null; city: AtlasCity | null; home: AtlasHome | null; places: AtlasPlace[]; household: HouseholdResponse | null; viewer: string | null; wide: boolean; viewportHeight: number;
  onBack: () => void; onOpen: (p: AtlasPlace) => void; onOpenVenue: (v: Venue) => void; openRef: string | null; onPlanTrip: () => void; onChanged: () => Promise<void>;
  landed: { venueRef: string; kind: Kind } | null; onLandedShown: () => void;
}) {
  /**
   * How this area's list is set — and all of it is in the address, so
   * `/places/GB/London?kind=eat&status=been&sort=recent` is a page somebody can
   * be sent (owner, 5 Sep 2026).
   *
   * What is *remembered* is per area, because coming back to London should not
   * bring Lisbon's "food only, been" with it — and the address always wins, so
   * arriving with the question already asked (Inspire's Food chip lands on
   * `?kind=eat`) beats what was left here last time.
   */
  const memoryKey = `places.city.${home ? 'home' : `${country?.code ?? '?'}.${city?.name ?? '?'}`}`;
  useStickyQuery(memoryKey, CITY_KEYS);
  const [kind, setKind] = useQueryState<Kind>('kind', 'do', asOneOf(['do', 'eat', 'stay'] as const, 'do'));
  const [status, setStatus] = useQueryState<Status>('status', 'any', asOneOf(['any', 'been', 'saved', 'special'] as const, 'any'));
  const [typeF, setTypeF] = useQueryState<string | null>('type', null, asText);
  const [moodF, setMoodF] = useQueryState<string | null>('mood', null, asText);
  const [tripF, setTripF] = useQueryState<string | null>('trip', null, asText);
  const [sort, setSort] = useQueryState<Sort>('sort', 'name', asOneOf(['name', 'mine', 'recent'] as const, 'name'));
  const [view, setView] = useQueryState<'list' | 'map'>('view', 'list', asOneOf(['list', 'map'] as const, 'list'));
  const [sheet, setSheet] = useState<'status' | 'type' | 'mood' | 'trip' | 'sort' | null>(null);
  const [adding, setAdding] = useState(false);
  const [selPin, setSelPin] = useState<string | null>(null);

  // An area, or everything within a few miles of the front door.
  const title = home ? 'Close to home' : city!.name;
  const centre = home ? { lat: home.lat, lng: home.lng } : city!.lat != null && city!.lng != null ? { lat: city!.lat, lng: city!.lng } : null;
  const searchRadiusKm = home ? Math.round(home.radiusMiles * 1.60934) : 5;
  const ctx = home ? {} : { country: country!.name, countryCode: country!.code, locality: city!.name };

  // Something just added: the search closes, the segment follows the place, and
  // the row is marked so the eye finds it.
  useEffect(() => {
    if (!landed) return;
    setAdding(false); setKind(landed.kind); setStatus('any'); setTypeF(null); setMoodF(null); setTripF(null); setView('list');
  }, [landed?.venueRef]);

  const counts = useMemo(() => ({
    do: places.filter((p) => kindsOf(p).includes('do')).length,
    eat: places.filter((p) => kindsOf(p).includes('eat')).length,
    stay: places.filter((p) => kindsOf(p).includes('stay')).length,
  }), [places]);

  /**
   * Whether this area gets a Hotels tab. The API decides it from the fact —
   * somewhere to stay is kept here, or the household has slept a night here —
   * and the tab appears anyway the moment there is one to show, so a hotel
   * saved into a day-trip area is never invisible.
   */
  const hasStay = counts.stay > 0 || !!city?.holiday;
  const segments = [
    { value: 'do' as const, label: `Activities${counts.do ? ` · ${counts.do}` : ''}` },
    { value: 'eat' as const, label: `Food & drink${counts.eat ? ` · ${counts.eat}` : ''}` },
    ...(hasStay ? [{ value: 'stay' as const, label: `Hotels${counts.stay ? ` · ${counts.stay}` : ''}` }] : []),
  ];
  // An address asking for a tab this area does not draw shows the first one.
  const shown: Kind = segments.some((sg) => sg.value === kind) ? kind : 'do';

  const inKind = (p: AtlasPlace) => kindsOf(p).includes(shown);
  /** Everything on this tab, before any of the dropdowns have been touched. */
  const inList = places.filter(inKind);
  const inKindAndType = places.filter((p) => inKind(p) && (!typeF || typeOf(p, shown) === typeF));
  const statusOptions = [
    { value: 'any', label: 'All', count: inKindAndType.length },
    { value: 'saved', label: 'Saved', count: inKindAndType.filter((p) => p.visits === 0).length },
    { value: 'been', label: 'Been', count: inKindAndType.filter((p) => p.visits > 0).length },
    { value: 'special', label: 'Special', count: inKindAndType.filter((p) => p.special).length },
  ];
  const matchesMood = (p: AtlasPlace) => !moodF || (p.moods ?? []).includes(moodF as any);
  const matchesTrip = (p: AtlasPlace) => !tripF || (p.onTrips ?? []).some((t) => t.id === tripF);

  const typeCounts = new Map<string, number>();
  places.filter((p) => inKind(p) && matchesStatus(p, status) && matchesMood(p) && matchesTrip(p)).forEach((p) => { const t = typeOf(p, shown); typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1); });
  const typeOptions = [{ value: '', label: shown === 'eat' ? 'Any cuisine' : shown === 'stay' ? 'Any kind of stay' : 'Any kind', count: [...typeCounts.values()].reduce((a, b) => a + b, 0) }, ...[...typeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => ({ value: t, label: t, count: n }))];

  // Mood is the same closed set of six the home screen's shelves are (the API
  // works it out per place); only the ones that are actually here are offered.
  const moodCounts = new Map<string, number>();
  places.filter((p) => inKind(p) && matchesStatus(p, status)).forEach((p) => (p.moods ?? []).forEach((m) => moodCounts.set(m, (moodCounts.get(m) ?? 0) + 1)));
  const moodOptions = [{ value: '', label: 'Any mood', count: places.filter(inKind).length }, ...MOODS.filter((m) => moodCounts.has(m)).map((m) => ({ value: m, label: cap(m), count: moodCounts.get(m)! }))];

  // The trips this area's places were on: the redesign's fourth chip, "Rome ·
  // Feb 2024" — one trip's worth of an area at a time.
  const tripOptions = useMemo(() => {
    const seen = new Map<string, { value: string; label: string; count: number }>();
    for (const p of places) for (const t of p.onTrips ?? []) {
      const row = seen.get(t.id) ?? { value: t.id, label: [t.title, t.on].filter(Boolean).join(' · ') || 'A trip', count: 0 };
      row.count += 1; seen.set(t.id, row);
    }
    return [{ value: '', label: 'Any trip', count: places.length }, ...[...seen.values()].sort((a, b) => b.count - a.count)];
  }, [places]);

  const rows = useMemo(() => {
    const list = places.filter((p) => inKind(p) && matchesStatus(p, status) && matchesMood(p) && matchesTrip(p) && (!typeF || typeOf(p, shown) === typeF));
    const by: Record<Sort, (a: AtlasPlace, b: AtlasPlace) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      mine: (a, b) => (myScore(b, viewer) ?? -1) - (myScore(a, viewer) ?? -1) || a.name.localeCompare(b.name),
      recent: (a, b) => (b.lastOn ?? '').localeCompare(a.lastOn ?? '') || a.name.localeCompare(b.name),
    };
    return [...list].sort(by[sort]);
  }, [places, shown, status, typeF, moodF, tripF, sort, viewer]);

  const pins: MapPin[] = rows.filter((p) => p.lat != null && p.lng != null).map((p) => ({
    id: p.venueRef, lat: p.lat as number, lng: p.lng as number, label: p.name, number: '', heart: p.special,
    tone: p.visits > 0 ? 'base' : 'hollow', onPress: () => setSelPin(p.venueRef),
  }));
  const selected = selPin ? rows.find((p) => p.venueRef === selPin) ?? null : null;
  const mapHeight = wide ? 640 : Math.max(360, viewportHeight - 330);
  const showMap = view === 'map';
  const showList = view === 'list' || wide;

  // "Italy · 4 activities · 2 food & drink" — what is here, in one line.
  const subtitle = [
    home ? `Within ${home.radiusMiles} miles of home` : country!.name,
    counts.do ? `${counts.do} activit${counts.do === 1 ? 'y' : 'ies'}` : null,
    counts.eat ? `${counts.eat} food & drink` : null,
    counts.stay ? `${counts.stay} hotel${counts.stay === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <View style={{ width: '100%' }}>
      <View style={[styles.field, wide && styles.fieldWideCentred]}>
        <Row style={{ gap: spacing.sm }}>
          <Pressable onPress={onBack} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel="Back"><Icon name="back" size={19} color={colors.ink} /></Pressable>
          <Text style={[type.title, { flex: 1 }]} numberOfLines={1}>{title}</Text>
          <Pressable onPress={() => setAdding((a) => !a)} style={styles.roundBtn} accessibilityRole="button" accessibilityLabel={adding ? 'Close' : 'Add a place'}>
            <Icon name={adding ? 'close' : 'add'} size={19} color={colors.ink} />
          </Pressable>
        </Row>
        <Row style={{ justifyContent: 'space-between', gap: spacing.sm }}>
          <Text style={[type.small, { color: colors.headerSub, flex: 1 }]} numberOfLines={2}>{subtitle}</Text>
          {/* Nobody plans a trip to their own doorstep (owner, 4 Sep 2026). It
              is a chip rather than a slab: the redesign leads with what is here,
              not with what could be booked. */}
          {home ? null : <Chip label="Plan a trip" icon="plan" onPress={onPlanTrip} />}
        </Row>
      </View>
      <View style={[styles.body, wide && styles.bodyCentred]}>
        <Segmented value={shown} options={segments} onChange={(k) => { setKind(k); setTypeF(null); setSelPin(null); onLandedShown(); }} />
        {adding ? (
          <AddPlace household={household} kind={shown} centre={centre} radiusKm={searchRadiusKm} ctx={ctx} wide={wide} onAdded={onChanged} onOpen={onOpenVenue} />
        ) : (
        <>
        <View style={styles.filters}>
          <FilterChip label={statusOptions.find((o) => o.value === status)?.label ?? 'All'} on={status !== 'any'} onPress={() => setSheet('status')} />
          <FilterChip label={typeF ?? 'Type'} on={!!typeF} onPress={() => setSheet('type')} />
          <FilterChip label={moodF ? cap(moodF) : 'Mood'} on={!!moodF} onPress={() => setSheet('mood')} />
          {tripOptions.length > 1 ? <FilterChip label={tripF ? tripOptions.find((o) => o.value === tripF)?.label ?? 'Trip' : 'Trip'} on={!!tripF} onPress={() => setSheet('trip')} /> : null}
          <FilterChip label={sort === 'name' ? 'A–Z' : sort === 'mine' ? 'My rating' : 'Most recent'} on={sort !== 'name'} onPress={() => setSheet('sort')} />
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
                  {rows.map((p, i) => <PlaceRow key={p.venueRef} place={p} kind={shown} viewer={viewer} first={i === 0} selected={openRef === p.venueRef || landed?.venueRef === p.venueRef} onPress={() => { onLandedShown(); onOpen(p); }} />)}
                </View>
              ) : (
                <Card>
                  {/* Three different empties, because they need three different
                      answers: nothing anywhere, nothing on this tab, and a
                      filter that has hidden everything. */}
                  <Text style={type.small}>
                    {!places.length ? "Nothing here yet. Add a place you know, or a trip's shortlist will fill it."
                      : !inList.length ? `No ${shown === 'stay' ? 'places to stay' : shown === 'eat' ? 'food & drink' : 'things to do'} saved in ${title} yet.${shown === 'stay' ? ' A hotel you book on a trip here lands in this list.' : ''}`
                        : 'Nothing matches — clear a filter.'}
                  </Text>
                </Card>
              )}
              {landed && rows.some((p) => p.venueRef === landed.venueRef) ? (
                <StatusLine tone="good">{rows.find((p) => p.venueRef === landed.venueRef)?.name} is in your places.</StatusLine>
              ) : null}
              <Text style={type.tiny}>{rows.length} of {inList.length} · tap a row for the drawer.</Text>
            </View>
          ) : null}
          {showMap ? (
            <View style={[styles.mapWrap, wide && { flex: 1 }]}>
              <MapView pins={pins} height={mapHeight} focusId={selPin} />
              {selected ? (
                <View style={styles.pinCard}>
                  <PlaceRow place={selected} kind={shown} viewer={viewer} first selected={false} onPress={() => onOpen(selected)} />
                </View>
              ) : <Text style={[type.tiny, styles.mapHint]}>{pins.length} pins · filled been · hollow saved · tap one</Text>}
            </View>
          ) : null}
        </View>
        </>
        )}
      </View>

      <PickSheet visible={sheet === 'status'} title="Been here?" options={statusOptions} value={status} onPick={(v) => { setStatus(v as Status); setSheet(null); setSelPin(null); }} onClose={() => setSheet(null)} />
      <PickSheet visible={sheet === 'type'} title={shown === 'eat' ? 'Cuisine' : shown === 'stay' ? 'Kind of stay' : 'Kind of thing'} options={typeOptions} value={typeF ?? ''} onPick={(v) => { setTypeF(v || null); setSheet(null); setSelPin(null); }} onClose={() => setSheet(null)} />
      <PickSheet visible={sheet === 'mood'} title="What's the day for?" options={moodOptions} value={moodF ?? ''} onPick={(v) => { setMoodF(v || null); setSheet(null); setSelPin(null); }} onClose={() => setSheet(null)} />
      <PickSheet visible={sheet === 'trip'} title="On which trip" options={tripOptions} value={tripF ?? ''} onPick={(v) => { setTripF(v || null); setSheet(null); setSelPin(null); }} onClose={() => setSheet(null)} />
      <PickSheet visible={sheet === 'sort'} title="Sort by" options={[{ value: 'name', label: 'A–Z' }, { value: 'mine', label: 'My rating' }, { value: 'recent', label: 'Most recent' }]} value={sort} onPick={(v) => { setSort(v as Sort); setSheet(null); }} onClose={() => setSheet(null)} />
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

/**
 * One place, one row, and the same anatomy everywhere in the redesign
 * (handover §6): a 56–64px picture, the name, a meta line, a green status line,
 * and a trailing tick or heart.
 *
 * Green tick = been. Red heart = saved. That is the whole trailing column —
 * red stays the heart (style guide) and the mark out of five rides on the green
 * line, where it reads as part of "what we thought" rather than as a badge.
 */
function PlaceRow({ place, kind, viewer, first, selected, onPress }: { place: AtlasPlace; kind: Kind; viewer: string | null; first?: boolean; selected: boolean; onPress: () => void }) {
  const been = place.visits > 0;
  // Where it is, in as few words as possible: the station, not the district and
  // the lines (owner, 4 Sep 2026: "that's too much detail… just show the tube
  // station"). The lines and the walk are in the drawer.
  const pill = kind === 'eat' ? CATEGORY_PILL[place.category ?? ''] : null;
  const what = rowType(place, kind);
  const where = [what, place.station].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={onPress} style={[styles.prow, !first && styles.rowLine, selected && styles.rowOn]} accessibilityRole="button">
      {/* The well was the category icon and nothing else, which is what made a
          list of places read as a text listing (owner, 5 Sep 2026). It is now
          whatever the ladder found for this place — their mark, a photograph of
          the building, the shopfront — then, only where we own nothing, the
          provider's photograph fetched at display and never stored (owner,
          5 Sep 2026: "at least that we can have restaurant pictures, which is
          really useful in some instances"), and the same icon on the same mint
          ground when there is neither. A list with three pictures in it still
          reads as one list.

          No credit line under a 56px well: it would not fit and would not be
          read. The licence is met where the picture is actually looked at —
          VenueDrawer draws the same photograph large, with its attribution
          under it. */}
      <View style={styles.well}>
        <VenueThumb
          name={place.name}
          image={place.image}
          photos={place.photos}
          category={place.category}
          experiences={(place.venue as Partial<Venue> | null)?.experiences ?? []}
          width={WELL}
          height={WELL}
          rounded={radius.md}
          credit={false}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={[type.h3, place.unnamed && { fontStyle: 'italic', color: colors.inkMuted }]} numberOfLines={1}>{place.unnamed ? 'Unnamed place — open for its name' : place.name}</Text>
        <View style={styles.meta}>
          {pill ? <View style={styles.pill}><Text style={styles.pillText}>{pill}</Text></View> : null}
          {where ? <Text style={[type.small, { flexShrink: 1 }]} numberOfLines={1}>{where}</Text> : null}
        </View>
        <Text style={styles.green} numberOfLines={1}>{statusLine(place, kind, viewer)}</Text>
      </View>
      {been ? (
        <View style={styles.tick} accessibilityLabel="Been here"><Icon name="check" size={13} color={colors.headerSub} strokeWidth={3} /></View>
      ) : (
        <View style={{ paddingHorizontal: 2 }} accessibilityLabel={place.special ? 'Special' : 'Saved'}>
          <Icon name="keep" size={17} color={colors.red} fill={place.special} />
        </View>
      )}
    </Pressable>
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
/**
 * The one question, at the top of the drawer: did everyone love it. It saves on
 * the tap and then says so; the household's fuller record — history, special,
 * removing it — is under Ours (owner, 4 Sep 2026).
 */
function CapturePanel({ venue, household, ctx: where, been, saved, onChanged, onLanded }: {
  venue: Venue; household: HouseholdResponse | null; ctx: { country?: string; countryCode?: string; locality?: string }; been: boolean; saved: boolean; onChanged: () => Promise<void>;
  /** It is in the list now: close up and show it there. */
  onLanded: (venueRef: string, kind: Kind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ctx = { label: venue.name, category: venue.category, lat: venue.lat ?? undefined, lng: venue.lng ?? undefined, venue, ...where };
  if (!household) return null;
  // Saying we have been here saves the place as well; there is no second step
  // (owner, 4 Sep 2026: "if I click 'We've been here', it's going to also save it").
  const here = been || done === 'been';
  const kept = saved || done !== null;
  return (
    <View style={styles.capturePanel}>
      {here || kept ? (
        <Row style={{ flexWrap: 'wrap' }}>
          <Icon name="booked" size={17} />
          <Text style={[type.h3, { flexShrink: 1 }]}>{here ? 'In your places — you have been here' : 'Saved to your places'}</Text>
        </Row>
      ) : (
        <Text style={type.h3}>Have you been?</Text>
      )}
      {!open ? (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button label={here ? 'Been again' : "We've been here"} kind={here ? 'secondary' : 'primary'} onPress={() => setOpen(true)} />
          {!kept ? <Button label="Save as a place" kind="secondary" loading={busy} onPress={async () => { setBusy(true); try { await api.savePlace(venue.venueRef, 'saved', ctx); setDone('saved'); await onChanged(); onLanded(venue.venueRef, kindOfCategory(venue.category)); } finally { setBusy(false); } }} /> : null}
        </Row>
      ) : (
        <>
          <BeenCapture venue={venue} household={household}
            onCreate={async (body) => { await api.createVisit({ venueRef: venue.venueRef, venueLabel: venue.name, category: venue.category, lat: venue.lat, lng: venue.lng, visitedOn: body.visitedOn, note: body.note, attendeeIds: body.attendeeIds, takes: body.takes, venue: { experiences: venue.experiences, cuisines: venue.cuisines, category: venue.category }, ...where }); }}
            onSaved={async () => { setOpen(false); setDone('been'); await onChanged(); onLanded(venue.venueRef, kindOfCategory(venue.category)); }} />
          <Button label="Close" icon="close" kind="ghost" onPress={() => setOpen(false)} style={{ alignSelf: 'flex-start' }} />
        </>
      )}
    </View>
  );
}

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
        {/* "We've been here" is the first thing in the drawer now; this is the
            long way round, for another date, who came, a note or exact scores. */}
        <Button label={adding ? 'Close' : 'Record a past visit'} icon={adding ? 'close' : undefined} kind="ghost" onPress={() => { setEditing(null); setDetailed(true); setAdding((a) => !a); }} />
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
  const [suggestions, setSuggestions] = useState<{ placeId: string | null; venueRef: string; name: string; where: string | null; kind: string | null; mine: boolean }[]>([]);
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
        const r = await api.suggestPlaces({ q: text, near: centre ? `${centre.lat},${centre.lng}` : undefined, radiusKm: Math.max(radiusKm, 15), session: session.current, kind });
        setSuggestions(r.suggestions.slice(0, 8));
      } catch { /* the Search button still works */ }
    }, 250);
    return () => { if (typing.current) clearTimeout(typing.current); };
  }, [q, centre?.lat, centre?.lng, kind]);

  /**
   * A chosen prediction opens in the drawer — the first thing to know is that
   * this is the right Sebastian's, and the details, menu and order are there
   * (owner, 4 Sep 2026).
   */
  const choose = async (venueRef: string, name: string) => {
    justChose.current = true;
    setSuggestions([]); setQ(name); setBusy(true); setMsg(null);
    session.current = uuid();
    try {
      const d = await api.place(venueRef);
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
            <Pressable key={sg.venueRef} onPress={() => choose(sg.venueRef, sg.name)} style={[styles.row, i > 0 && styles.rowLine]} accessibilityRole="button">
              <View style={{ width: 22, alignItems: 'center' }}><Icon name={sg.mine ? 'places' : 'address'} size={16} /></View>
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
  pageWide: { maxWidth: 1400, alignSelf: 'center' },
  atlasCol: { width: '100%' },
  cityCol: { width: '100%' },
  // The redesign is a drill-down, so a wide window is the same one column with
  // room around it rather than a second one (CLAUDE.md: one tree shape).
  fieldWideCentred: { width: '100%', maxWidth: 860, alignSelf: 'center' },
  bodyCentred: { width: '100%', maxWidth: 860, alignSelf: 'center' },
  roundBtn: { width: 40, height: 40, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  // A country's tile: the two-letter code, which is what the handover draws
  // until there are flags we own.
  flag: { width: 44, height: 32, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  flagText: { fontFamily: fonts.heading, fontSize: 11, fontWeight: '700', letterSpacing: 0.66, color: colors.headerSub },
  // The green status line under every row: what the household did here.
  green: { fontFamily: fonts.body, fontSize: 12, fontWeight: '600', color: colors.accent },
  arow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 11, paddingHorizontal: spacing.md, minHeight: TARGET },
  tick: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  /**
   * The screen's own header. It used to be a second mint field stacked under
   * the shell's — the shell already carries the one mint band with the wordmark
   * on it (App.tsx) — and the redesign draws these screens white, so it is the
   * ground with room around it and nothing else.
   */
  field: { backgroundColor: colors.bg, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
  fieldWide: { backgroundColor: 'transparent', paddingBottom: 0 },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md },
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
  prow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 10, paddingHorizontal: spacing.md, minHeight: TARGET },
  well: { width: WELL, height: WELL, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.well, alignItems: 'center', justifyContent: 'center' },
  prowGap: { gap: spacing.md },
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
  capturePanel: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel },
  ours: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  scores: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, alignItems: 'center' },
  scoreLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
});

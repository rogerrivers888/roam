import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { CategoryIcon, Icon } from '../components/Icon';
import { api, AtlasCity, AtlasCountry, AtlasPlace, BrowseItem, HouseholdResponse, Place, Take, Venue, Visit, VisitTake } from '../api';
import { MapView, MapPin } from '../components/MapView';
import { VenueDrawer } from '../components/VenueDrawer';
import { memberColor } from '../theme';
import { VenuePhoto } from '../components/VenuePhoto';
import type { TripPrefill } from './TripsScreen';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap } from '../components/ui';
import { SourcePicker } from '../components/SourcePicker';
import { FaceRow } from '../components/Faces';
import { PlacePicker } from '../components/PlacePicker';
import { TakePicker, TakeRow } from '../components/TakePicker';

const today = () => new Date().toISOString().slice(0, 10);
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function PlacesScreen({ household, refreshHousehold, onPlanTrip }: { household: HouseholdResponse | null; refreshHousehold: () => Promise<void>; onPlanTrip?: (p: TripPrefill) => void }) {
  const [tab, setTab] = useState<'atlas' | 'find' | 'been'>('atlas');
  const { width } = useViewport();
  const wide = width >= 1000;
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={type.title}>Places</Text>
          <Text style={type.small}>Your atlas: every country and city you've been to, the places you loved, the ones to try — and the start of the next trip there.</Text>
        </View>
      </View>
      <Segmented value={tab} options={[{ value: 'atlas', label: 'Our atlas' }, { value: 'find', label: 'Find places' }, { value: 'been', label: 'Visits' }]} onChange={setTab} />
      {tab === 'atlas' ? <AtlasPanel household={household} wide={wide} refreshHousehold={refreshHousehold} onPlanTrip={onPlanTrip} /> : null}
      {tab === 'find' ? <FindPanel household={household} wide={wide} refreshHousehold={refreshHousehold} /> : null}
      {tab === 'been' ? <BeenPanel household={household} wide={wide} refreshHousehold={refreshHousehold} /> : null}
    </ScrollView>
  );
}


// ---------------------------------------------------------------------------
// Atlas: countries → cities → our places
// ---------------------------------------------------------------------------

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

function AtlasPanel({ household, wide, refreshHousehold, onPlanTrip }: { household: HouseholdResponse | null; wide: boolean; refreshHousehold: () => Promise<void>; onPlanTrip?: (p: TripPrefill) => void }) {
  const [data, setData] = useState<{ countries: AtlasCountry[]; unplaced: number } | null>(null);
  const [country, setCountry] = useState<AtlasCountry | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [places, setPlaces] = useState<AtlasPlace[]>([]);
  const [open, setOpen] = useState<AtlasPlace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingCity, setAddingCity] = useState(false);
  const [addingPlace, setAddingPlace] = useState(false);

  const loadAtlas = useCallback(async () => { try { setData(await api.atlas()); } catch (e: any) { setError(e.message); } }, []);
  useEffect(() => { loadAtlas(); }, [loadAtlas]);
  const loadPlaces = useCallback(async () => {
    if (!country || !city) { setPlaces([]); return; }
    try { setPlaces((await api.atlasPlaces({ country: country.code, city })).places); } catch (e: any) { setError(e.message); }
  }, [country?.code, city]);
  useEffect(() => { loadPlaces(); }, [loadPlaces]);

  const refreshAll = async () => { await loadAtlas(); await loadPlaces(); await refreshHousehold(); };
  // Keep the open drawer on the same place after a change (a visit saved, a status set).
  useEffect(() => { if (open) { const fresh = places.find((p) => p.venueRef === open.venueRef); if (fresh && fresh !== open) setOpen(fresh); } }, [places]);

  if (!data) return <Card><Text style={type.small}>{error ?? 'Loading your atlas…'}</Text></Card>;

  if (!country) {
    return (
      <View style={{ gap: spacing.md }}>
        <Card style={{ borderColor: colors.accent }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={type.h3}>Add a country or city</Text>
              <Text style={type.tiny}>Somewhere you've been or are going — then add the places you know there.</Text>
            </View>
            {!addingCity ? <Button label="+ Add" onPress={() => setAddingCity(true)} /> : null}
          </Row>
          {addingCity ? (
            <>
              <PlacePicker value={null} onPick={async (p) => { if (!p) return; try { const r = await api.createAtlasCity({ place: p }); await loadAtlas(); setAddingCity(false); const c = (await api.atlas()).countries.find((x) => x.code === r.city.countryCode); if (c) { setCountry(c); setCity(r.city.name); } } catch (e: any) { setError(e.message); } }} placeholder="City and country — Lisbon, Portugal · Lake District · New York" />
              <Button label="Cancel" kind="ghost" onPress={() => setAddingCity(false)} style={{ alignSelf: 'flex-start' }} />
            </>
          ) : null}
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
        </Card>
        {data.countries.length === 0 ? <Card><Text style={type.body}>Your atlas is empty so far.</Text><Text style={type.small}>Add a city above, then add the places you've been to or want to try. Visits, saves and trip shortlists also land here automatically.</Text></Card> : null}
        <View style={[styles.grid, wide && { flexDirection: 'row', flexWrap: 'wrap' }]}>
          {data.countries.map((c) => (
            <Pressable key={c.code} onPress={() => { setCountry(c); setCity(c.cities.length === 1 ? c.cities[0].name : null); }} style={wide ? { width: '49%' } : undefined}>
              <Card style={{ gap: 4 }}>
                <Text style={type.h2}>{c.name}</Text>
                <Text style={type.small}>{c.places} place{c.places === 1 ? '' : 's'} · {c.been} been · {c.cities.length} {c.cities.length === 1 ? 'city' : 'cities'}</Text>
                <Wrap>{c.cities.slice(0, 6).map((ci) => <Chip key={ci.name} label={`${ci.name} (${ci.places})`} />)}</Wrap>
              </Card>
            </Pressable>
          ))}
        </View>
        {data.unplaced ? <Text style={type.tiny}>{data.unplaced} place{data.unplaced === 1 ? '' : 's'} still being placed on the map.</Text> : null}
      </View>
    );
  }

  if (!city) {
    return (
      <View style={{ gap: spacing.md }}>
        <Button label="All countries" icon="back" kind="ghost" onPress={() => setCountry(null)} style={{ alignSelf: 'flex-start' }} />
        <Text style={type.h2}>{country.name}</Text>
        {country.cities.map((ci) => (
          <Pressable key={ci.name} onPress={() => setCity(ci.name)}>
            <Card style={{ gap: 4 }}>
              <Text style={type.h3}>{ci.name}</Text>
              <Text style={type.small}>{ci.places} place{ci.places === 1 ? '' : 's'} · {ci.been} been · {ci.special} special · {ci.trips} trip{ci.trips === 1 ? '' : 's'}</Text>
            </Card>
          </Pressable>
        ))}
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.md }}>
      <Row>
        <Button label={country.name} icon="back" kind="ghost" onPress={() => { setCity(null); setOpen(null); }} />
        <View style={{ flex: 1 }} />
        <Button label={`Plan a trip to ${city}`} onPress={() => onPlanTrip?.({ placeText: `${city}, ${country.name}`, countryCode: country.code })} />
      </Row>
      <Row style={{ flexWrap: 'wrap' }}>
        <Text style={[type.title, { flex: 1 }]}>{city}</Text>
        <Button label={addingPlace ? 'Close' : `+ Add a place`} kind={addingPlace ? 'ghost' : 'secondary'} onPress={() => setAddingPlace((a) => !a)} />
      </Row>
      {addingPlace ? (
        <AddPlaceHere household={household} country={country} city={country.cities.find((c) => c.name === city) ?? null} cityName={city} onAdded={async () => { await refreshAll(); }} />
      ) : null}
      <PlaceList
        places={places} household={household} wide={wide} openRef={open?.venueRef ?? null} onOpen={setOpen}
        map={(pins) => (
          <Card style={{ padding: spacing.sm }}>
            <MapView pins={pins} height={wide ? 560 : 260} focusId={open?.venueRef ?? null} />
            <Text style={type.tiny}>green = been · purple = to try · gold = special. Tap a pin or a row.</Text>
          </Card>
        )}
      />
      <VenueDrawer
        item={open ? atlasToBrowseItem(open) : null}
        baseLabel={city}
        onClose={() => setOpen(null)}
        onVenue={async (v) => { if (open?.unnamed && v.name) { try { await api.nameAtlasPlace(open.venueRef, v.name); await loadPlaces(); } catch { /* the drawer still shows the fetched name */ } } }}
        ours={open ? <OursPanel place={open} household={household} country={country} cityName={city} onChanged={refreshAll} /> : null}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// The city's list: dense rows, filters that stack, our own verdicts on show
// ---------------------------------------------------------------------------

type StatusFilter = '' | 'been' | 'saved' | 'special';
type VerdictFilter = '' | 'loved' | 'not_for_me';
type SortKey = 'name' | 'ours' | 'recent' | 'visits';
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1).replace(/-/g, ' ');
const CATEGORY_LABEL: Record<string, string> = { restaurant: 'Restaurant', cafe: 'Café', pub: 'Pub', bar: 'Bar', attraction: 'Attraction', event: 'Event' };

/** Everything the place is, in the words we file it under: its category plus its cuisines or kinds of thing. */
function tagsOf(p: AtlasPlace): string[] {
  const v = (p.venue ?? {}) as Partial<Venue>;
  return [...new Set([...(v.cuisines ?? []), ...(v.experiences ?? [])].filter((t) => t && t !== p.category))];
}

/** Each person's latest verdict on the place, in household order. */
function latestTakes(p: AtlasPlace, members: { name: string }[]): { member: string; index: number; take: Take; comment: string | null }[] {
  const seen = new Map<string, { member: string; index: number; take: Take; comment: string | null }>();
  for (const t of p.takes) { // takes arrive newest first
    if (!seen.has(t.member)) seen.set(t.member, { member: t.member, index: Math.max(0, members.findIndex((m) => m.name === t.member)), take: t.take, comment: t.comment });
  }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

/**
 * Forty places in a city must fit on one screen (owner, 3 Sep 2026): one line
 * per place with what the family thought, and everything else behind the
 * drawer. Filters stack — kind, then been / to try / special, then the type of
 * food or thing, then who loved it — and each choice shows how many it leaves.
 */
function PlaceList({ places, household, wide, openRef, onOpen, map }: {
  places: AtlasPlace[]; household: HouseholdResponse | null; wide: boolean; openRef: string | null; onOpen: (p: AtlasPlace) => void;
  map: (pins: MapPin[]) => React.ReactNode;
}) {
  const [kind, setKind] = useState<'' | 'food' | 'activity'>('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [verdict, setVerdict] = useState<VerdictFilter>('');
  const [facets, setFacets] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortKey>('name');
  const [q, setQ] = useState('');
  const members = household?.members ?? [];

  const inKind = useMemo(() => places.filter((p) => !kind || p.kind === kind || (kind === 'activity' && p.kind === 'other')), [places, kind]);
  const count = (list: AtlasPlace[], f: (p: AtlasPlace) => boolean) => list.filter(f).length;
  const byStatus = (p: AtlasPlace) => !status || (status === 'special' ? p.special : p.status === status);
  const byVerdict = (p: AtlasPlace) => !verdict || (verdict === 'loved' ? p.loved > 0 : p.notForMe > 0);
  const afterStatus = useMemo(() => inKind.filter(byStatus), [inKind, status]);
  const afterVerdict = useMemo(() => afterStatus.filter(byVerdict), [afterStatus, verdict]);

  // Facets from what is actually here after the filters above, most common first.
  const facetList = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of afterVerdict) for (const t of tagsOf(p)) c.set(t, (c.get(t) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16);
  }, [afterVerdict]);

  const list = useMemo(() => {
    let l = afterVerdict;
    if (facets.size) l = l.filter((p) => tagsOf(p).some((t) => facets.has(t)));
    const needle = q.trim().toLowerCase();
    if (needle) l = l.filter((p) => p.name.toLowerCase().includes(needle) || (p.note ?? '').toLowerCase().includes(needle) || tagsOf(p).some((t) => t.toLowerCase().includes(needle)));
    const by: Record<SortKey, (a: AtlasPlace, b: AtlasPlace) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      ours: (a, b) => (b.loved - b.notForMe) - (a.loved - a.notForMe) || b.loved - a.loved || b.visits - a.visits || a.name.localeCompare(b.name),
      recent: (a, b) => (b.lastOn ?? '').localeCompare(a.lastOn ?? '') || a.name.localeCompare(b.name),
      visits: (a, b) => b.visits - a.visits || a.name.localeCompare(b.name),
    };
    return [...l].sort(by[sort]);
  }, [afterVerdict, facets, q, sort]);

  const toggleFacet = (f: string) => setFacets((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });
  const switchKind = (k: typeof kind) => { setKind(k); setFacets(new Set()); };
  const pins: MapPin[] = list.filter((p) => p.lat != null && p.lng != null).map((p) => ({ id: p.venueRef, lat: p.lat!, lng: p.lng!, label: p.name, tone: p.special ? 'special' : p.status === 'been' ? 'been' : 'shortlist', onPress: () => onOpen(p) }));

  const n = (f: (p: AtlasPlace) => boolean, from: AtlasPlace[] = inKind) => count(from, f);
  const filters = (
    <View style={{ gap: spacing.sm }}>
      <Segmented value={kind} options={[
        { value: '', label: `Everything (${places.length})` },
        { value: 'activity', label: `Things to do (${count(places, (p) => p.kind !== 'food')})` },
        { value: 'food', label: `Food & drink (${count(places, (p) => p.kind === 'food')})` },
      ]} onChange={switchKind} />
      <Wrap>
        <Chip label={`All (${inKind.length})`} selected={status === ''} onPress={() => setStatus('')} />
        <Chip label={`Been (${n((p) => p.status === 'been')})`} tone="like" selected={status === 'been'} onPress={() => setStatus(status === 'been' ? '' : 'been')} />
        <Chip label={`To try (${n((p) => p.status !== 'been')})`} tone="want" selected={status === 'saved'} onPress={() => setStatus(status === 'saved' ? '' : 'saved')} />
        <Chip icon="favourite" iconFill label={`Special (${n((p) => p.special)})`} tone="accent" selected={status === 'special'} onPress={() => setStatus(status === 'special' ? '' : 'special')} />
        <View style={styles.vr} />
        <Chip icon="keep" iconFill label={`Loved (${n((p) => p.loved > 0, afterStatus)})`} tone="like" selected={verdict === 'loved'} onPress={() => setVerdict(verdict === 'loved' ? '' : 'loved')} />
        <Chip icon="close" label={`Not for us (${n((p) => p.notForMe > 0, afterStatus)})`} tone="dislike" selected={verdict === 'not_for_me'} onPress={() => setVerdict(verdict === 'not_for_me' ? '' : 'not_for_me')} />
      </Wrap>
      {facetList.length ? (
        <Wrap>
          <Text style={[type.tiny, { alignSelf: 'center' }]}>{kind === 'food' ? 'Food' : kind === 'activity' ? 'Kind' : 'Type'}</Text>
          {facetList.map(([f, c]) => <Chip key={f} label={`${cap(f)} (${c})`} selected={facets.has(f)} onPress={() => toggleFacet(f)} />)}
          {facets.size ? <Chip label="Clear" onPress={() => setFacets(new Set())} /> : null}
        </Wrap>
      ) : null}
      <Row style={{ flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 280 }}>
          <Segmented value={sort} options={[{ value: 'name', label: 'A–Z' }, { value: 'ours', label: 'Our rating' }, { value: 'recent', label: 'Most recent' }, { value: 'visits', label: 'Most visited' }]} onChange={setSort} />
        </View>
        <TextInput value={q} onChangeText={setQ} placeholder="Find by name…" placeholderTextColor={colors.inkFaint} style={[styles.input, { minWidth: 160, flex: 1, minHeight: 38 }]} accessibilityLabel="Find a place by name" />
      </Row>
    </View>
  );

  const rows = (
    <View style={styles.list}>
      {list.map((p) => <PlaceRow key={p.venueRef} place={p} members={members} selected={p.venueRef === openRef} narrow={!wide} onPress={() => onOpen(p)} />)}
      {list.length === 0 ? <Text style={[type.small, { padding: spacing.md }]}>{places.length ? 'Nothing here with those filters.' : 'No places in this city yet — add one above.'}</Text> : null}
    </View>
  );

  return (
    <View style={{ gap: spacing.md }}>
      {filters}
      <Text style={type.tiny}>{list.length} of {places.length} place{places.length === 1 ? '' : 's'} · tap a row for details, our history and where it is</Text>
      <View style={[styles.split, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
        {wide ? <View style={{ width: 400 }}>{map(pins)}</View> : null}
        <View style={{ flex: 1, minWidth: 0 }}>{rows}</View>
        {!wide ? map(pins) : null}
      </View>
    </View>
  );
}

/** One line on a wide screen; on a phone the family's verdicts drop to a second line so the name keeps its room. */
function PlaceRow({ place, members, selected, narrow, onPress }: { place: AtlasPlace; members: { name: string }[]; selected: boolean; narrow?: boolean; onPress: () => void }) {
  const takes = latestTakes(place, members);
  const tags = tagsOf(place);
  const verdicts = takes.length ? (
    <View style={[styles.verdicts, narrow && { justifyContent: 'flex-start', maxWidth: undefined }]} accessibilityLabel={takes.map((t) => `${t.member}: ${t.take === 'loved' ? 'loved it' : t.take === 'fine' ? 'fine' : 'not for them'}`).join(', ')}>
      {takes.map((t) => (
        <View key={t.member} style={[styles.verdict, { backgroundColor: t.take === 'loved' ? colors.likeSoft : t.take === 'not_for_me' ? colors.dislikeSoft : colors.surfaceMuted }]}>
          <View style={[styles.verdictDot, { backgroundColor: memberColor(t.index) }]} />
          <Text style={[styles.verdictText, { color: t.take === 'loved' ? colors.like : t.take === 'not_for_me' ? colors.dislike : colors.inkMuted }]}>{t.member.split(' ')[0]}</Text>{t.take !== 'fine' ? <Icon name={t.take === 'loved' ? 'keep' : 'close'} size={11} color={t.take === 'loved' ? colors.like : colors.dislike} fill={t.take === 'loved'} /> : null}
        </View>
      ))}
    </View>
  ) : null;
  const status = (
    <View style={{ minWidth: 84, alignItems: 'flex-end' }}>
      {place.visits ? <Text style={[type.small, { color: colors.like, fontWeight: '600' }]}>Been {place.visits}×</Text> : <Text style={[type.small, { color: colors.want, fontWeight: '600' }]}>To try</Text>}
      {place.lastOn ? <Text style={type.tiny}>{place.lastOn}</Text> : place.onTrips.length ? <Text style={type.tiny} numberOfLines={1}>on a trip</Text> : null}
    </View>
  );
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open ${place.name}`} style={({ pressed }) => [styles.placeRow, selected && styles.placeRowOn, pressed && { opacity: 0.8 }]}>
      <View style={{ width: 26, alignItems: 'center' }}><CategoryIcon category={place.category} size={18} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {place.special ? <Icon name="favourite" size={13} color={colors.rating} fill /> : null}
          <Text style={[type.h3, { flexShrink: 1 }, place.unnamed && { fontStyle: 'italic', color: colors.inkMuted }]} numberOfLines={1}>{place.unnamed ? 'Unnamed place — open for its name' : place.name}</Text>
        </View>
        <Text style={type.small} numberOfLines={1}>
          {[CATEGORY_LABEL[place.category ?? ''] ?? (place.category ? cap(place.category) : null), ...tags.map(cap)].filter(Boolean).join(' · ')}
          {place.note ? <Text style={{ color: colors.inkFaint }}> · “{place.note}”</Text> : null}
        </Text>
        {narrow && verdicts ? <View style={{ marginTop: 3 }}>{verdicts}</View> : null}
      </View>
      {!narrow ? verdicts : null}
      {status}
    </Pressable>
  );
}

/** The drawer's shape for a place we hold in the atlas; the source's record fills in the rest when it opens. */
function atlasToBrowseItem(p: AtlasPlace): BrowseItem {
  const v = (p.venue ?? {}) as Partial<Venue>;
  const [source] = p.venueRef.split(':');
  return {
    id: p.venueRef, venueRef: p.venueRef, name: p.name, category: p.category ?? v.category ?? 'attraction', lat: p.lat ?? 0, lng: p.lng ?? 0,
    dwellMinutes: 0, reasons: [], justification: null, startsAt: null, endsAt: null, pinned: false, source,
    cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], address: (v.address as any)?.line1 ?? (typeof v.address === 'string' ? v.address : null), website: v.website ?? null, openingHours: v.openingHours ?? null,
  };
}

/**
 * Our side of a place, at the top of the drawer: what it is to us (been,
 * to try, special, on which trips), what everyone thought each time with their
 * comments, and the ways to change that. Rented facts sit below in the tabs.
 */
function OursPanel({ place, household, country, cityName, onChanged }: { place: AtlasPlace; household: HouseholdResponse | null; country: AtlasCountry; cityName: string; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<{ visits: Visit[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ctx = { label: place.name, category: place.category, lat: place.lat ?? undefined, lng: place.lng ?? undefined, country: country.name, countryCode: country.code, locality: cityName };
  const venue = atlasToVenue(place);

  const load = useCallback(async () => {
    try { const d = await api.place(place.venueRef); setDetail({ visits: d.visits }); } catch { setDetail({ visits: [] }); }
  }, [place.venueRef]);
  useEffect(() => { load(); }, [load]);

  return (
    <View style={styles.ours}>
      <Row style={{ flexWrap: 'wrap' }}>
        <Text style={type.h3}>Ours</Text>
        {place.visits ? <Chip label={`Been ${place.visits}×${place.lastOn ? ` · last ${place.lastOn}` : ''}`} tone="like" /> : <Chip label="To try" tone="want" />}
        {place.special ? <Chip label="Special" tone="accent" icon="favourite" iconFill /> : null}
        {place.onTrips.map((t) => <Chip key={t} label={`On: ${t}`} />)}
      </Row>
      <Wrap>
        <Button label="We've been here" onPress={() => setAdding((a) => !a)} kind={adding ? 'ghost' : 'primary'} />
        {!place.visits && place.ledger !== 'saved' && !place.special ? <Button label="Save for later" kind="secondary" onPress={async () => { await api.savePlace(place.venueRef, 'saved', ctx); setMsg('Saved to try.'); await onChanged(); }} /> : null}
        {!place.special ? <Button label="Mark as special" kind="secondary" onPress={async () => { await api.savePlace(place.venueRef, 'special', ctx); setMsg('Marked special — the planner will go further for it.'); await onChanged(); }} /> : null}
      </Wrap>
      {msg ? <StatusLine tone="good">{msg}</StatusLine> : null}
      {adding && household ? (
        <VisitForm venue={venue} household={household} onDone={async () => { setAdding(false); await load(); await onChanged(); }} onCancel={() => setAdding(false)}
          createVia={async (body) => { await api.createVisit({ venueRef: place.venueRef, venueLabel: place.name, category: venue.category, lat: venue.lat, lng: venue.lng, visitedOn: body.visitedOn, note: body.note, attendeeIds: body.attendeeIds, takes: body.takes, venue: body.venue, country: country.name, countryCode: country.code, locality: cityName }); }} />
      ) : null}
      {place.note ? <Text style={type.small}>Our note: “{place.note}”</Text> : null}
      {detail?.visits.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.h3}>Our history here</Text>
          {detail.visits.map((v) => <VisitSummary key={v.id} visit={v} />)}
        </View>
      ) : detail ? <Text style={type.small}>No visit recorded here yet.</Text> : <Text style={type.tiny}>Loading our history…</Text>}
      <Text style={type.tiny}>Menus: none captured for this place yet — photographing a menu at the table is a later step (Requirements, Epic 6).</Text>
    </View>
  );
}

/** Search near a city and file a place under it — as somewhere we've been (rate it) or want to try. */
function AddPlaceHere({ household, country, city, cityName, onAdded }: { household: HouseholdResponse | null; country: AtlasCountry; city: AtlasCity | null; cityName: string; onAdded: () => Promise<void> }) {
  const [near, setNear] = useState<Place | null>(city?.lat != null ? { label: cityName, lat: city.lat!, lng: city.lng! } : null);
  const [cat, setCat] = useState<'things' | 'food' | ''>('things');
  const [q, setQ] = useState('');
  const [radius, setRadius] = useState(3);
  const [sources, setSources] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Venue[] | null>(null);
  const [rating, setRating] = useState<Venue | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ctx = { country: country.name, countryCode: country.code, locality: cityName };
  const search = async () => {
    if (!near) { setMsg('Pick where in the city to look.'); return; }
    setBusy(true); setMsg(null);
    try { setRes((await api.searchPlaces({ near: `${near.lat},${near.lng}`, categories: cat || undefined, q: q || undefined, radiusKm: radius, sources: sources?.join(',') })).results); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  return (
    <Card style={{ borderColor: colors.accent }}>
      <Text style={type.h3}>Add a place in {cityName}</Text>
      <Text style={type.tiny}>Near</Text>
      <PlacePicker value={near} onPick={setNear} placeholder={`A neighbourhood, landmark or address in ${cityName}`} />
      <Segmented value={cat} options={[{ value: 'things', label: 'Things to do' }, { value: 'food', label: 'Food & drink' }, { value: '', label: 'Everything' }]} onChange={setCat} />
      <Row>
        <TextInput value={q} onChangeText={setQ} placeholder="Name contains… (optional)" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} onSubmitEditing={search} />
        <Button label="Search" onPress={search} loading={busy} />
      </Row>
      <Wrap>{[1, 3, 5, 10].map((r) => <Chip key={r} label={`${r} km`} selected={radius === r} onPress={() => setRadius(r)} />)}</Wrap>
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
            <Button label="Want to try" kind="ghost" onPress={async () => { await api.savePlace(v.venueRef, 'saved', { label: v.name, venue: v, category: v.category, lat: v.lat, lng: v.lng, ...ctx }); setMsg(`Saved ${v.name} to try.`); await onAdded(); }} />
          </Row>
        } />
      ))}
    </Card>
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
  const [sources, setSources] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.searchPlaces>> | null>(null);
  const [open, setOpen] = useState<Venue | null>(null);

  useEffect(() => { if (!near && home) setNear(home); }, [home]);

  const search = useCallback(async () => {
    if (!near) { setError('Pick where to look — or set your home address in Settings.'); return; }
    setBusy(true); setError(null);
    try {
      setRes(await api.searchPlaces({ near: `${near.lat},${near.lng}`, categories: cat || undefined, q: q.trim() || undefined, radiusKm: radius, sources: sources?.join(',') }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, [near, cat, q, radius, sources]);

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
          <SourcePicker value={sources} onChange={setSources} />
          <Button label="Search" onPress={search} loading={busy} />
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
        </Card>
      </View>

      <View style={[{ flex: 1, gap: spacing.md }, wide && { minWidth: 0 }]}>
        {open ? <PlaceDetail venue={open} household={household} onClose={() => setOpen(null)} onChanged={async () => { await refreshHousehold(); await search(); }} /> : null}
        {res ? (
          <>
            <Text style={type.small}>
              {res.results.length} places within {res.radiusKm} km of {res.near.label} · from {res.sourcesQueried.join(', ')}
              {res.degradedSources.length ? ` · ${res.degradedSources.map((d) => `${d.source} failed: ${d.error}`).join('; ')}` : ''}
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
          {venue.photos?.length ? <VenuePhoto photos={venue.photos} size={56} credit={false} /> : <View style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}><CategoryIcon category={venue.category} size={22} /></View>}
          <View style={{ flex: 1 }}>
            <Text style={type.h3}>{venue.name}</Text>
            <Text style={type.small}>
              {[venue.category, ...venue.experiences, ...venue.cuisines].filter(Boolean).join(' · ')}
              {venue.rating != null ? ` · rated ${venue.rating.toFixed(1)}${venue.ratingCount ? ` (${venue.ratingCount.toLocaleString()})` : ''}` : ''}
              {venue.distanceKm != null ? ` · ${venue.distanceKm} km` : ''}
            </Text>
            <Text style={type.tiny}>via {(venue.contributingSources?.length ? venue.contributingSources : [venue.source]).join(' + ')}</Text>
          </View>
          {action}
        </Row>
        <Wrap>
          {h?.visits ? <Chip label={`Been ${h.visits}×${h.lastOn ? ` · last ${h.lastOn}` : ''}`} tone="accent" /> : null}
          {h?.loved ? <Chip label={`${h.loved}`} tone="like" icon="keep" iconFill /> : null}
          {h?.notForMe ? <Chip label={`${h.notForMe}`} tone="dislike" icon="close" /> : null}
          {h?.ledger === 'saved' && !h?.visits ? <Chip label="Saved" /> : null}
          {h?.ledger === 'special' ? <Chip label="Special" tone="accent" icon="favourite" iconFill /> : null}
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
        <CategoryIcon category={venue.category} size={24} color={colors.ink} />
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
        <Button label={saved === 'yes' ? 'Saved' : 'Save for later'} icon={saved === 'yes' ? 'check' : 'shortlist'} kind="secondary" onPress={async () => { await api.savePlace(venue.venueRef, 'saved', { label: venue.name, venue, category: venue.category, lat: venue.lat, lng: venue.lng }); setSaved('yes'); await onChanged(); }} />
        <Button label={saved === 'special' ? 'Special' : 'Mark as special'} icon={saved === 'special' ? 'check' : 'favourite'} kind="secondary" onPress={async () => { await api.savePlace(venue.venueRef, 'special', { label: venue.name, venue, category: venue.category, lat: venue.lat, lng: venue.lng }); setSaved('special'); await onChanged(); }} />
      </Row>
      <Text style={type.tiny}>Special places are worth going further for — the planner uses your "if it's special" travel limit for them.</Text>

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
                    <Row><CategoryIcon category={v.category} size={16} color={colors.ink} /><Text style={type.h3}>{v.venueLabel}</Text></Row>
                    <Text style={type.tiny}>{v.visitedOn}</Text>
                  </Row>
                  <Wrap>
                    {(v.visitTakes ?? []).map((t, i) => <Chip key={i} label={`${t.member}${t.take === 'fine' ? ': fine' : ''}`} icon={t.take === 'loved' ? 'keep' : t.take === 'fine' ? undefined : 'close'} iconFill={t.take === 'loved'} tone={t.take === 'loved' ? 'like' : t.take === 'not_for_me' ? 'dislike' : 'neutral'} />)}
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
  grid: { gap: spacing.md, justifyContent: 'space-between' },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  form: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  list: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8, paddingHorizontal: spacing.md, minHeight: TARGET, borderBottomWidth: 1, borderBottomColor: colors.line },
  placeRowOn: { backgroundColor: colors.accentSoft },
  verdicts: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end', maxWidth: 220 },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, height: 22, borderRadius: radius.pill },
  verdictDot: { width: 7, height: 7, borderRadius: 4 },
  verdictText: { fontSize: 11, fontWeight: '700' },
  vr: { width: 1, height: 24, backgroundColor: colors.line, alignSelf: 'center', marginHorizontal: 2 },
  ours: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.accent },
  visitRow: { gap: 6, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
});

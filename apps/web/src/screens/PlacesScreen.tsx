import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { api, AtlasCity, AtlasCountry, AtlasPlace, HouseholdResponse, Place, Take, Venue, Visit, VisitTake } from '../api';
import { MapView, MapPin } from '../components/MapView';
import type { TripPrefill } from './TripsScreen';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap } from '../components/ui';
import { FaceRow } from '../components/Faces';
import { PlacePicker } from '../components/PlacePicker';
import { TakePicker, TakeRow } from '../components/TakePicker';

const CATEGORY_ICON: Record<string, string> = { restaurant: '🍽', cafe: '☕', pub: '🍺', bar: '🍸', attraction: '🏛', event: '🎟' };
const today = () => new Date().toISOString().slice(0, 10);
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function PlacesScreen({ household, refreshHousehold, onPlanTrip }: { household: HouseholdResponse | null; refreshHousehold: () => Promise<void>; onPlanTrip?: (p: TripPrefill) => void }) {
  const [tab, setTab] = useState<'atlas' | 'find' | 'been'>('atlas');
  const { width } = useWindowDimensions();
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
  const [status, setStatus] = useState<'' | 'been' | 'saved' | 'special'>('');
  const [kind, setKind] = useState<'' | 'food' | 'activity'>('');
  const [open, setOpen] = useState<Venue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingCity, setAddingCity] = useState(false);
  const [addingPlace, setAddingPlace] = useState(false);

  const loadAtlas = useCallback(async () => { try { setData(await api.atlas()); } catch (e: any) { setError(e.message); } }, []);
  useEffect(() => { loadAtlas(); }, [loadAtlas]);
  useEffect(() => {
    if (!country || !city) { setPlaces([]); return; }
    api.atlasPlaces({ country: country.code, city, status: status || undefined, kind: kind || undefined }).then((r) => setPlaces(r.places)).catch((e) => setError(e.message));
  }, [country?.code, city, status, kind]);

  const refreshAll = async () => { await loadAtlas(); if (country && city) setPlaces((await api.atlasPlaces({ country: country.code, city, status: status || undefined, kind: kind || undefined })).places); await refreshHousehold(); };

  const pins: MapPin[] = places.filter((p) => p.lat != null && p.lng != null).map((p) => ({ id: p.venueRef, lat: p.lat!, lng: p.lng!, label: p.name, tone: p.special ? 'special' : p.status === 'been' ? 'been' : 'shortlist', onPress: () => setOpen(atlasToVenue(p)) }));

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
        <Button label={`← All countries`} kind="ghost" onPress={() => setCountry(null)} style={{ alignSelf: 'flex-start' }} />
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

  const been = places.filter((p) => p.status === 'been');
  const toTry = places.filter((p) => p.status !== 'been');

  return (
    <View style={{ gap: spacing.md }}>
      <Row>
        <Button label={`← ${country.name}`} kind="ghost" onPress={() => setCity(null)} />
        <View style={{ flex: 1 }} />
        <Button label={`Plan a trip to ${city}`} onPress={() => onPlanTrip?.({ placeText: `${city}, ${country.name}`, countryCode: country.code })} />
      </Row>
      <Text style={type.title}>{city}</Text>
      <Row>
        <Button label={addingPlace ? 'Close' : `+ Add a place in ${city}`} kind={addingPlace ? 'ghost' : 'secondary'} onPress={() => setAddingPlace((a) => !a)} />
      </Row>
      {addingPlace ? (
        <AddPlaceHere household={household} country={country} city={country.cities.find((c) => c.name === city) ?? null} cityName={city} onAdded={async () => { await refreshAll(); }} />
      ) : null}
      <Row>
        <Segmented value={status} options={[{ value: '', label: 'All' }, { value: 'been', label: 'Been' }, { value: 'saved', label: 'To try' }, { value: 'special', label: '★ Special' }]} onChange={setStatus} />
      </Row>
      <Segmented value={kind} options={[{ value: '', label: 'Everything' }, { value: 'activity', label: 'Things to do' }, { value: 'food', label: 'Food & drink' }]} onChange={setKind} />
      <View style={[styles.split, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
        <View style={[{ flex: 1, gap: spacing.md }, wide && { minWidth: 0 }]}>
          {open ? <PlaceDetail venue={open} household={household} onClose={() => setOpen(null)} onChanged={refreshAll} /> : null}
          {status === '' ? (
            <>
              {been.length ? <Text style={type.h2}>Been ({been.length})</Text> : null}
              {been.map((p) => <AtlasRow key={p.venueRef} place={p} onPress={() => setOpen(atlasToVenue(p))} />)}
              {toTry.length ? <Text style={type.h2}>To try ({toTry.length})</Text> : null}
              {toTry.map((p) => <AtlasRow key={p.venueRef} place={p} onPress={() => setOpen(atlasToVenue(p))} />)}
            </>
          ) : places.map((p) => <AtlasRow key={p.venueRef} place={p} onPress={() => setOpen(atlasToVenue(p))} />)}
          {places.length === 0 ? <Card><Text style={type.small}>Nothing here with that filter.</Text></Card> : null}
        </View>
        <View style={wide ? { width: 420 } : undefined}>
          <Card style={{ padding: spacing.sm }}>
            <MapView pins={pins} height={wide ? 520 : 300} />
            <Text style={type.tiny}>green = been · purple = to try · gold = special. Tap a pin.</Text>
          </Card>
        </View>
      </View>
    </View>
  );
}

/** Search near a city and file a place under it — as somewhere we've been (rate it) or want to try. */
function AddPlaceHere({ household, country, city, cityName, onAdded }: { household: HouseholdResponse | null; country: AtlasCountry; city: AtlasCity | null; cityName: string; onAdded: () => Promise<void> }) {
  const [near, setNear] = useState<Place | null>(city?.lat != null ? { label: cityName, lat: city.lat!, lng: city.lng! } : null);
  const [cat, setCat] = useState<'things' | 'food' | ''>('things');
  const [q, setQ] = useState('');
  const [radius, setRadius] = useState(3);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Venue[] | null>(null);
  const [rating, setRating] = useState<Venue | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ctx = { country: country.name, countryCode: country.code, locality: cityName };
  const search = async () => {
    if (!near) { setMsg('Pick where in the city to look.'); return; }
    setBusy(true); setMsg(null);
    try { setRes((await api.searchPlaces({ near: `${near.lat},${near.lng}`, categories: cat || undefined, q: q || undefined, radiusKm: radius })).results); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
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

function AtlasRow({ place, onPress }: { place: AtlasPlace; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Card style={{ gap: 4 }}>
        <Row>
          <Text style={{ fontSize: 20 }}>{CATEGORY_ICON[place.category ?? ''] ?? '📍'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={type.h3}>{place.special ? '★ ' : ''}{place.name}</Text>
            <Text style={type.small}>{[place.category, ...((place.venue?.experiences as string[]) ?? []), ...((place.venue?.cuisines as string[]) ?? [])].filter(Boolean).join(' · ')}</Text>
          </View>
        </Row>
        <Wrap>
          {place.visits ? <Chip label={`Been ${place.visits}×${place.lastOn ? ` · last ${place.lastOn}` : ''}`} tone="accent" /> : <Chip label="To try" tone="want" />}
          {place.takes.slice(0, 4).map((t, i) => <Chip key={i} label={`${t.member}: ${t.take === 'loved' ? '♥' : t.take === 'fine' ? '–' : '✕'}${t.comment ? ` ${t.comment}` : ''}`} tone={t.take === 'loved' ? 'like' : t.take === 'not_for_me' ? 'dislike' : 'neutral'} />)}
          {place.onTrips.length ? <Chip label={`On: ${place.onTrips.join(', ')}`} /> : null}
        </Wrap>
        {place.note ? <Text style={type.small}>“{place.note}”</Text> : null}
      </Card>
    </Pressable>
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
          {h?.ledger === 'special' ? <Chip label="★ Special" tone="accent" /> : null}
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
        <Button label={saved === 'yes' ? 'Saved ✓' : 'Save for later'} kind="secondary" onPress={async () => { await api.savePlace(venue.venueRef); setSaved('yes'); }} />
        <Button label={saved === 'special' ? 'Special ✓' : 'Mark as special'} kind="secondary" onPress={async () => { await api.savePlace(venue.venueRef, 'special'); setSaved('special'); }} />
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
  grid: { gap: spacing.md, justifyContent: 'space-between' },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  form: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  visitRow: { gap: 6, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
});

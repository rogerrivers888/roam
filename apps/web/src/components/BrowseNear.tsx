import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { api, AtlasPlace, BrowseItem, TripDetail, Venue } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, StatusLine, Wrap } from './ui';
import { BrowsePool } from './BrowsePool';
import { Icon } from './Icon';

/**
 * Find places for the shortlist (owner, 3 Sep 2026): the browse the owner
 * liked — things to do, places to eat, what's on, with sort and filters and a
 * Shortlist button on every row — searched straight around the trip's base
 * from the place sources, with no planner session to wait for. Places the
 * household already knows in this city come first.
 */

const dwellFor = (category: string) => (['restaurant', 'pub'].includes(category) ? 75 : ['cafe', 'bar'].includes(category) ? 45 : category === 'event' ? 150 : 90);

export function BrowseNear({ d, onChanged, onClose }: { d: TripDetail; onChanged: () => Promise<void>; onClose?: () => void }) {
  const { trip, shortlist } = d;
  const [q, setQ] = useState('');
  const [radiusKm, setRadiusKm] = useState(3);
  const [res, setRes] = useState<(Venue & { onShortlist?: boolean; distanceKm?: number })[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [atlas, setAtlas] = useState<AtlasPlace[]>([]);
  const baseLabel = (trip.base?.label ?? trip.destination?.label ?? trip.origin.label).split(',')[0];

  const search = useCallback(async (query: string, r: number) => {
    setBusy(true); setError(null);
    try { setRes((await api.shortlistSearch(trip.id, { q: query || undefined, radiusKm: r, sources: trip.sources ? 'default' : undefined })).results); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, [trip.id, trip.sources]);
  useEffect(() => { search('', radiusKm); }, [search, radiusKm]);
  useEffect(() => {
    if (!trip.countryCode) return;
    api.atlasPlaces({ country: trip.countryCode, city: trip.locality ?? undefined }).then((r) => setAtlas(r.places)).catch(() => null);
  }, [trip.countryCode, trip.locality]);

  const shortlisted = useMemo(() => new Set(shortlist.map((s) => s.venueRef)), [shortlist]);
  const items: BrowseItem[] = useMemo(() => (res ?? []).filter((v) => !hidden.has(v.venueRef)).map((v) => ({
    id: v.venueRef, venueRef: v.venueRef, name: v.name, category: v.category, lat: v.lat, lng: v.lng, dwellMinutes: dwellFor(v.category),
    reasons: [], justification: null, startsAt: null, endsAt: null, pinned: false,
    cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], rating: v.rating ?? null, ratingCount: v.ratingCount ?? null, priceLevel: v.priceLevel ?? null,
    photos: v.photos ?? [], distanceKm: v.distanceKm ?? null, chain: v.chain, brand: v.brand ?? null, goodForChildren: v.goodForChildren ?? null, menuForChildren: v.menuForChildren ?? null,
    address: v.address ?? null, website: v.website ?? null, openingHours: v.openingHours ?? null, summary: v.summary ?? null, mapsUrl: v.mapsUrl ?? null, attribution: v.attribution ?? null,
    source: v.source, contributingSources: v.contributingSources, ratingSource: v.source,
    // Best match without a planner session: how well rated, weighed by how many said so, nearest breaking ties.
    score: (v.rating ?? 0) * Math.log10((v.ratingCount ?? 0) + 2) - (v.distanceKm ?? 0) * 0.05,
    shortlisted: shortlisted.has(v.venueRef),
  })), [res, hidden, shortlisted]);
  const fromAtlas = atlas.filter((p) => !shortlisted.has(p.venueRef));

  const add = async (b: BrowseItem) => {
    await api.addToShortlist(trip.id, {
      venueRef: b.venueRef, venueLabel: b.name, category: b.category, lat: b.lat, lng: b.lng,
      venue: { name: b.name, category: b.category, cuisines: b.cuisines, experiences: b.experiences, rating: b.rating, ratingCount: b.ratingCount, priceLevel: b.priceLevel, lat: b.lat, lng: b.lng, photos: b.photos, address: b.address, website: b.website, openingHours: b.openingHours } as Partial<Venue>,
    });
    await onChanged();
  };

  return (
    <Card style={{ borderColor: colors.accent, gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={type.h3}>Find places near {baseLabel}</Text>
          <Text style={type.tiny}>Tap a row for reviews, hours and photos. Shortlist what you might book; decide later.</Text>
        </View>
        {onClose ? <Button label="Close" icon="close" kind="ghost" onPress={onClose} /> : null}
      </Row>
      <Row>
        <View style={styles.search}>
          <Icon name="search" size={16} color={colors.inkFaint} />
          <TextInput value={q} onChangeText={setQ} placeholder="Name or kind of place (optional)" placeholderTextColor={colors.inkFaint} style={styles.input} onSubmitEditing={() => search(q, radiusKm)} returnKeyType="search" />
        </View>
        <Button label="Search" onPress={() => search(q, radiusKm)} loading={busy} />
      </Row>
      <Wrap>
        <Text style={[type.tiny, { alignSelf: 'center' }]}>Within</Text>
        {[1, 2, 3, 5, 10].map((r) => <Chip key={r} label={`${r} km`} selected={radiusKm === r} onPress={() => setRadiusKm(r)} />)}
      </Wrap>
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}

      {fromAtlas.length ? (
        <View style={styles.atlas}>
          <Text style={type.h3}>Places you know here</Text>
          <Text style={type.tiny}>Been to or saved in {trip.locality ?? trip.country}, not yet on this trip's list.</Text>
          {fromAtlas.slice(0, 8).map((p) => (
            <Row key={p.venueRef} style={{ justifyContent: 'space-between' }}>
              {p.status === 'been' ? <Icon name="check" size={14} color={colors.like} /> : p.status === 'special' ? <Icon name="favourite" size={14} color={colors.rating} fill /> : <Icon name="shortlist" size={14} color={colors.inkFaint} />}
              <Text style={[type.body, { flex: 1 }]} numberOfLines={1}>{p.name}</Text>
              <Button label="Shortlist" icon="shortlist" kind="secondary" onPress={async () => { await api.addToShortlist(trip.id, { venueRef: p.venueRef, venueLabel: p.name, kind: p.kind ?? undefined, category: p.category, lat: p.lat, lng: p.lng, venue: p.venue ?? undefined }); await onChanged(); }} />
            </Row>
          ))}
        </View>
      ) : null}

      {busy && !res ? <StatusLine>Looking around {baseLabel}…</StatusLine> : null}
      {res ? (
        <BrowsePool
          items={items} eventsSource={null} baseLabel={baseLabel} pinned={shortlisted} busy={busy}
          addLabel="Shortlist" addedLabel="Shortlisted"
          onAdd={add}
          onDislike={(b) => setHidden((h) => new Set([...h, b.venueRef]))}
        />
      ) : null}
      {res && !res.length && !busy ? <Text style={type.small}>Nothing within {radiusKm} km from the sources that are on. Widen the radius, or turn on more sources in Settings.</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  input: { flex: 1, fontSize: 15, color: colors.ink, minHeight: TARGET - 2 },
  atlas: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
});

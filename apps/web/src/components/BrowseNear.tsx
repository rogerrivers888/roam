import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, AtlasPlace, BrowseItem, TripDetail, Venue } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, StatusLine, Wrap, clock } from './ui';
import { BrowsePool } from './BrowsePool';
import { SourcePicker } from './SourcePicker';
import { Icon } from './Icon';

/**
 * Find (owner, 3 Sep 2026): a tab of its own next to the shortlist, so a
 * place that turns out to be fully booked is one tap from the next candidate.
 * What it fetched stays put — held on the trip page and remembered by the
 * API for hours — so coming back never asks the sources again; Refresh does.
 * The sources are a filter here: fetch from any set of them, then narrow the
 * rows to one source to see what it alone returned.
 */

export type FindResult = Venue & { onShortlist?: boolean; distanceKm?: number };
export type FindState = {
  q: string; radiusKm: number; sources: string[] | null; only: string | null;
  res: FindResult[] | null; fetchedAt: string | null; cached: boolean; queried: string[]; degraded: { source: string; error: string }[];
  loading: boolean; error: string | null;
};
export const emptyFind = (): FindState => ({ q: '', radiusKm: 3, sources: null, only: null, res: null, fetchedAt: null, cached: false, queried: [], degraded: [], loading: false, error: null });

const dwellFor = (category: string) => (['restaurant', 'pub'].includes(category) ? 75 : ['cafe', 'bar'].includes(category) ? 45 : category === 'event' ? 150 : 90);
const sourcesOf = (v: FindResult) => [...new Set([v.source, ...(v.contributingSources ?? [])].filter(Boolean))];

export function BrowseNear({ d, onChanged, find, setFind, initialPrices, onShortlist }: {
  d: TripDetail; onChanged: () => Promise<void>; find: FindState; setFind: (f: FindState | ((cur: FindState) => FindState)) => void;
  /** Price chips to start with ("Free to enter" when the day was asked for on a free budget). */
  initialPrices?: string[];
  onShortlist?: () => void;
}) {
  const { trip, shortlist } = d;
  const [atlas, setAtlas] = useState<AtlasPlace[]>([]);
  const [showAtlas, setShowAtlas] = useState(false);
  const [q, setQ] = useState(find.q);
  const baseLabel = (trip.base?.label ?? trip.destination?.label ?? trip.origin.label).split(',')[0];

  const run = useCallback(async (next: Partial<FindState> = {}, refresh = false) => {
    let params: FindState = find;
    setFind((cur) => { params = { ...cur, ...next, loading: true, error: null }; return params; });
    try {
      const r = await api.shortlistSearch(trip.id, { q: params.q || undefined, radiusKm: params.radiusKm, sources: params.sources ? params.sources.join(',') : undefined, refresh: refresh ? '1' : undefined });
      setFind((cur) => ({ ...cur, res: r.results, fetchedAt: r.fetchedAt ?? new Date().toISOString(), cached: Boolean(r.cached), queried: r.sourcesQueried ?? [], degraded: r.degradedSources ?? [], loading: false }));
    } catch (e: any) { setFind((cur) => ({ ...cur, loading: false, error: e.message })); }
  }, [trip.id, find, setFind]);

  // First visit fetches; every visit after shows what is already there.
  useEffect(() => { if (!find.res && !find.loading && !find.error) run(); }, []);
  useEffect(() => {
    if (!trip.countryCode) return;
    api.atlasPlaces({ country: trip.countryCode, city: trip.locality ?? undefined }).then((r) => setAtlas(r.places)).catch(() => null);
  }, [trip.countryCode, trip.locality]);

  const shortlisted = useMemo(() => new Set(shortlist.map((s) => s.venueRef)), [shortlist]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const v of find.res ?? []) for (const s of sourcesOf(v)) c.set(s, (c.get(s) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [find.res]);
  const items: BrowseItem[] = useMemo(() => (find.res ?? []).filter((v) => !find.only || sourcesOf(v).includes(find.only)).map((v) => ({
    id: v.venueRef, venueRef: v.venueRef, name: v.name, category: v.category, lat: v.lat, lng: v.lng, dwellMinutes: dwellFor(v.category),
    reasons: [], justification: null, startsAt: null, endsAt: null, pinned: false,
    cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], rating: v.rating ?? null, ratingCount: v.ratingCount ?? null, priceLevel: v.priceLevel ?? null,
    photos: v.photos ?? [], distanceKm: v.distanceKm ?? null, chain: v.chain, brand: v.brand ?? null, goodForChildren: v.goodForChildren ?? null, menuForChildren: v.menuForChildren ?? null,
    address: v.address ?? null, website: v.website ?? null, openingHours: v.openingHours ?? null, summary: v.summary ?? null, mapsUrl: v.mapsUrl ?? null, attribution: v.attribution ?? null,
    source: v.source, contributingSources: v.contributingSources, ratingSource: v.source,
    // Best match without a planner session: how well rated, weighed by how many said so, nearest breaking ties.
    score: (v.rating ?? 0) * Math.log10((v.ratingCount ?? 0) + 2) - (v.distanceKm ?? 0) * 0.05,
    shortlisted: shortlisted.has(v.venueRef),
  })), [find.res, find.only, shortlisted]);
  const fromAtlas = atlas.filter((p) => !shortlisted.has(p.venueRef));

  const add = async (b: BrowseItem) => {
    await api.addToShortlist(trip.id, {
      venueRef: b.venueRef, venueLabel: b.name, category: b.category, lat: b.lat, lng: b.lng,
      venue: { name: b.name, category: b.category, cuisines: b.cuisines, experiences: b.experiences, rating: b.rating, ratingCount: b.ratingCount, priceLevel: b.priceLevel, lat: b.lat, lng: b.lng, photos: b.photos, address: b.address, website: b.website, openingHours: b.openingHours } as Partial<Venue>,
    });
    await onChanged();
  };
  const fetched = find.fetchedAt ? clock(find.fetchedAt) : null;

  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={type.h2}>Near {baseLabel}</Text>
          <Text style={type.tiny}>
            {find.loading ? `Asking ${find.sources?.length ? find.sources.join(', ') : 'the sources'}…`
              : find.res ? `${find.res.length} places · ${find.cached ? 'kept from' : 'fetched'} ${fetched}${find.queried.length ? ` · ${find.queried.join(' + ')}` : ''}`
              : 'Shortlist what you might book; decide later.'}
          </Text>
        </View>
        <Button label="Refresh" icon="search" kind="ghost" onPress={() => run({}, true)} disabled={find.loading} />
      </Row>
      <Row>
        <View style={styles.search}>
          <Icon name="search" size={16} color={colors.inkFaint} />
          <TextInput value={q} onChangeText={setQ} placeholder="Name or kind of place (optional)" placeholderTextColor={colors.inkFaint} style={styles.input} onSubmitEditing={() => run({ q })} returnKeyType="search" />
        </View>
        <Button label="Search" onPress={() => run({ q })} loading={find.loading} />
      </Row>
      <Wrap>
        <Text style={[type.tiny, { alignSelf: 'center' }]}>Within</Text>
        {[1, 2, 3, 5, 10].map((r) => <Chip key={r} label={`${r} km`} selected={find.radiusKm === r} onPress={() => { if (r !== find.radiusKm) run({ radiusKm: r }); }} />)}
      </Wrap>
      <SourcePicker value={find.sources} onChange={(v) => run({ sources: v })} title="Fetch from" />
      {counts.length > 1 ? (
        <Wrap>
          <Text style={[type.tiny, { alignSelf: 'center' }]}>Show only</Text>
          {counts.map(([src, n]) => <Chip key={src} label={`${src} (${n})`} selected={find.only === src} tone={find.only === src ? 'accent' : 'neutral'} onPress={() => setFind((cur) => ({ ...cur, only: cur.only === src ? null : src }))} />)}
        </Wrap>
      ) : null}
      {find.error ? <StatusLine tone="warn">{find.error} · <Text onPress={() => run({}, true)} style={{ color: colors.accent, fontWeight: '700' }}>try again</Text></StatusLine> : null}
      {find.degraded.length ? <Text style={type.tiny}>Didn't answer: {find.degraded.map((x) => x.source).join(', ')}.</Text> : null}

      {fromAtlas.length ? (
        <View>
          <Pressable onPress={() => setShowAtlas((v) => !v)} style={styles.fold}>
            <Icon name="places" size={16} color={colors.accent} />
            <Text style={[type.small, { fontWeight: '700', flex: 1 }]}>Places you know here · {fromAtlas.length}</Text>
            <Icon name={showAtlas ? 'collapse' : 'more'} size={16} color={colors.inkFaint} />
          </Pressable>
          {showAtlas ? (
            <Card style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              {fromAtlas.slice(0, 12).map((p) => (
                <Row key={p.venueRef} style={{ justifyContent: 'space-between' }}>
                  {p.status === 'been' ? <Icon name="check" size={14} color={colors.like} /> : p.status === 'special' ? <Icon name="favourite" size={14} color={colors.rating} fill /> : <Icon name="shortlist" size={14} color={colors.inkFaint} />}
                  <Text style={[type.body, { flex: 1 }]} numberOfLines={1}>{p.name}</Text>
                  <Button label="Shortlist" icon="shortlist" kind="secondary" onPress={async () => { await api.addToShortlist(trip.id, { venueRef: p.venueRef, venueLabel: p.name, kind: p.kind ?? undefined, category: p.category, lat: p.lat, lng: p.lng, venue: p.venue ?? undefined }); await onChanged(); }} />
                </Row>
              ))}
            </Card>
          ) : null}
        </View>
      ) : null}

      {find.loading && !find.res ? <Card><StatusLine>Looking around {baseLabel}. The first look can take a minute; after that it is kept.</StatusLine></Card> : null}
      {find.res ? (
        <Card style={{ paddingTop: spacing.sm }}>
          <BrowsePool
            items={items} eventsSource={null} baseLabel={baseLabel} pinned={shortlisted} busy={find.loading} initialPrices={initialPrices}
            addLabel="Shortlist" addedLabel="Shortlisted"
            onAdd={add}
            onDislike={(b) => setFind((cur) => ({ ...cur, res: (cur.res ?? []).filter((v) => v.venueRef !== b.venueRef) }))}
          />
          {shortlisted.size && onShortlist ? <Button label={`Shortlist · ${shortlisted.size}`} icon="list" kind="secondary" onPress={onShortlist} /> : null}
        </Card>
      ) : null}
      {find.res && !find.res.length && !find.loading ? <Text style={type.small}>Nothing within {find.radiusKm} km from the sources that are on. Widen the radius or fetch from more sources.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  input: { flex: 1, fontSize: 15, color: colors.ink, minHeight: TARGET - 2 },
  fold: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
});

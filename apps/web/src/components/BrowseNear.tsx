import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { api, AtlasPlace, BrowseItem, HouseholdResponse, TripDetail, Venue } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Chip, Row, StatusLine, Wrap, minutes as fmtMinutes } from './ui';
import { Icon } from './Icon';
import { VenuePhoto } from './VenuePhoto';
import { VenueDrawer } from './VenueDrawer';
import { SourcePicker } from './SourcePicker';

/**
 * Find (owner, 3 Sep 2026; mock-up /mockups/find-options.html, Option 1, to the
 * style guide): three tiles pick the kind of thing; one bar holds sort, kind,
 * budget and distance; the search is a magnifier that becomes the field; kind
 * and budget open as sheets. Cards carry a picture tile, one line of facts and
 * the one reason a place is for the family. Nothing is explained in sentences.
 * What was fetched stays on the trip page and is kept by the API, so coming
 * back never asks the sources again; Refresh, in the filters sheet, does.
 */

export type FindResult = Venue & { onShortlist?: boolean; distanceKm?: number };
export type FindCat = 'things' | 'food' | 'events';
export type FindSort = 'you' | 'rating' | 'reviews' | 'nearest';
export type FindBudget = 'any' | 'free' | 'easy' | 'medium' | 'splash';
export type FindState = {
  q: string; radiusKm: number; sources: string[] | null; only: string | null;
  res: FindResult[] | null; fetchedAt: string | null; cached: boolean; queried: string[]; degraded: { source: string; error: string }[];
  loading: boolean; error: string | null;
  cat: FindCat; sort: FindSort; kinds: string[]; budget: FindBudget;
};
export const emptyFind = (): FindState => ({ q: '', radiusKm: 3, sources: null, only: null, res: null, fetchedAt: null, cached: false, queried: [], degraded: [], loading: false, error: null, cat: 'things', sort: 'you', kinds: [], budget: 'any' });

const FOOD = new Set(['restaurant', 'cafe', 'pub', 'bar']);
const catOf = (v: FindResult): FindCat => (v.category === 'event' ? 'events' : FOOD.has(v.category) ? 'food' : 'things');
const dwellFor = (category: string) => (['restaurant', 'pub'].includes(category) ? 75 : ['cafe', 'bar'].includes(category) ? 45 : category === 'event' ? 150 : 90);
const sourcesOf = (v: FindResult) => [...new Set([v.source, ...(v.contributingSources ?? [])].filter(Boolean))];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
const priceMarks = (p: number | null | undefined) => (p == null ? '' : p === 0 ? 'free' : '£'.repeat(Math.max(1, Math.min(4, p))));
const SORT_LABEL: Record<FindSort, string> = { you: 'For you', rating: 'Top rated', reviews: 'Most reviewed', nearest: 'Nearest' };
const SORT_NEXT: Record<FindSort, FindSort> = { you: 'rating', rating: 'reviews', reviews: 'nearest', nearest: 'you' };
const BUDGET_LABEL: Record<FindBudget, string> = { any: 'Any budget', free: 'Free', easy: 'Easy', medium: 'Medium', splash: 'Splash out' };
const BUDGET_MAX: Record<FindBudget, number | null> = { any: null, free: 0, easy: 1, medium: 2, splash: null };

// The kinds of thing, grouped for the sheet. Anything the sources say that is not listed lands in Other.
const KIND_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Culture', keys: ['museum', 'gallery', 'art', 'theatre', 'theater', 'cinema', 'history', 'historic', 'church', 'cathedral', 'castle', 'monument', 'library', 'music', 'concert'] },
  { label: 'Outdoors', keys: ['park', 'garden', 'walk', 'river', 'viewpoint', 'beach', 'nature', 'trail', 'lake', 'wildlife'] },
  { label: 'For the kids', keys: ['playground', 'escape', 'aquarium', 'zoo', 'boat', 'farm', 'soft-play', 'trampoline', 'bowling', 'family'] },
  { label: 'Shopping', keys: ['market', 'shopping', 'shop', 'bookshop', 'toys', 'mall', 'antiques'] },
];

type Scored = { v: FindResult; score: number; reasons: { icon: 'keep' | 'check' | 'children' | 'plan'; text: string }[]; cat: FindCat; kinds: string[] };

export function BrowseNear({ d, household, onChanged, find, setFind, initialPrices, onShortlist }: {
  d: TripDetail; household?: HouseholdResponse | null; onChanged: () => Promise<void>; find: FindState; setFind: (f: FindState | ((cur: FindState) => FindState)) => void;
  /** Price chips to start with ("Free to enter" when the day was asked for on a free budget). */
  initialPrices?: string[];
  onShortlist?: () => void;
}) {
  const { trip, shortlist } = d;
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900;
  const [atlas, setAtlas] = useState<AtlasPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState(find.q);
  const [sheet, setSheet] = useState<null | 'kind' | 'budget' | 'filters'>(null);
  const [open, setOpen] = useState<BrowseItem | null>(null);
  const [shown, setShown] = useState(20);
  const baseLabel = (trip.base?.label ?? trip.destination?.label ?? trip.origin.label).split(',')[0];

  const run = useCallback(async (next: Partial<FindState> = {}, refresh = false) => {
    let params: FindState = find;
    setFind((cur) => { params = { ...cur, ...next, loading: true, error: null }; return params; });
    try {
      const r = await api.shortlistSearch(trip.id, { q: params.q || undefined, radiusKm: params.radiusKm, sources: params.sources ? params.sources.join(',') : undefined, refresh: refresh ? '1' : undefined });
      setFind((cur) => ({ ...cur, res: r.results, fetchedAt: r.fetchedAt ?? new Date().toISOString(), cached: Boolean(r.cached), queried: r.sourcesQueried ?? [], degraded: r.degradedSources ?? [], loading: false }));
    } catch (e: any) { setFind((cur) => ({ ...cur, loading: false, error: e.message })); }
  }, [trip.id, find, setFind]);

  // First visit fetches; every visit after shows what is already there. A free day starts on the free budget.
  useEffect(() => {
    if (initialPrices?.some((p) => /free/i.test(p))) setFind((cur) => (cur.budget === 'any' ? { ...cur, budget: 'free' } : cur));
    if (!find.res && !find.loading && !find.error) run();
  }, []);
  useEffect(() => {
    if (!trip.countryCode) return;
    api.atlasPlaces({ country: trip.countryCode, city: trip.locality ?? undefined }).then((r) => setAtlas(r.places)).catch(() => null);
  }, [trip.countryCode, trip.locality]);

  const shortlisted = useMemo(() => new Set(shortlist.map((s) => s.venueRef)), [shortlist]);
  const known = useMemo(() => new Map(atlas.map((p) => [p.venueRef, p])), [atlas]);
  const minors = household?.members.some((m) => m.isMinor) ?? false;
  const vegetarians = useMemo(() => (household?.members ?? []).filter((m) => (m.diets ?? []).some((c) => /vegetarian|vegan/i.test(c.value))).map((m) => m.name), [household]);

  // For you: how well rated, weighed by how many said so, then what the family has loved and been to, then who is coming.
  const scored = useMemo<Scored[]>(() => (find.res ?? []).map((v) => {
    const reasons: Scored['reasons'] = [];
    let score = (v.rating ?? 0) * Math.log10((v.ratingCount ?? 0) + 2) - (v.distanceKm ?? 0) * 0.05;
    const k = known.get(v.venueRef);
    if ((v.household?.loved ?? k?.loved ?? 0) > 0) { score += 2; reasons.push({ icon: 'keep', text: k?.lastOn ? `You loved it, ${k.lastOn.slice(0, 4)}` : 'You loved it' }); }
    else if ((v.household?.visits ?? k?.visits ?? 0) > 0) { score += 0.8; reasons.push({ icon: 'check', text: 'Been before' }); }
    if (minors && v.goodForChildren) { score += 0.6; reasons.push({ icon: 'children', text: v.menuForChildren ? "Good for children, children's menu" : 'Good for children' }); }
    if (vegetarians.length && (v.dietaryOptions ?? []).some((o) => /vegetarian|vegan/i.test(o))) { score += 0.5; reasons.push({ icon: 'plan', text: `${vegetarians[0]}: vegetarian options` }); }
    if ((v.household?.notForMe ?? k?.notForMe ?? 0) > 0) score -= 1.5;
    const cat = catOf(v);
    return { v, score, reasons, cat, kinds: (cat === 'food' ? v.cuisines : v.experiences) ?? [] };
  }), [find.res, known, minors, vegetarians]);

  const counts = { things: scored.filter((s) => s.cat === 'things').length, food: scored.filter((s) => s.cat === 'food').length, events: scored.filter((s) => s.cat === 'events').length };
  const inCat = useMemo(() => scored.filter((s) => s.cat === find.cat), [scored, find.cat]);
  const facets = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of inCat) for (const f of s.kinds) c.set(f, (c.get(f) ?? 0) + 1);
    return c;
  }, [inCat]);
  const budgetMax = BUDGET_MAX[find.budget];
  const list = useMemo(() => {
    let l = inCat;
    if (find.kinds.length) l = l.filter((s) => s.kinds.some((k) => find.kinds.includes(k)));
    if (budgetMax != null) l = l.filter((s) => s.v.priceLevel == null || s.v.priceLevel <= budgetMax);
    if (find.only) l = l.filter((s) => sourcesOf(s.v).includes(find.only!));
    const by: Record<FindSort, (a: Scored, b: Scored) => number> = {
      you: (a, b) => b.score - a.score,
      rating: (a, b) => (b.v.rating ?? 0) - (a.v.rating ?? 0) || (b.v.ratingCount ?? 0) - (a.v.ratingCount ?? 0),
      reviews: (a, b) => (b.v.ratingCount ?? 0) - (a.v.ratingCount ?? 0),
      nearest: (a, b) => (a.v.distanceKm ?? 99) - (b.v.distanceKm ?? 99),
    };
    return [...l].sort(by[find.sort]);
  }, [inCat, find.kinds, find.only, find.sort, budgetMax]);
  const sourceCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of scored) for (const src of sourcesOf(s.v)) c.set(src, (c.get(src) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  }, [scored]);

  const asItem = (v: FindResult): BrowseItem => ({
    id: v.venueRef, venueRef: v.venueRef, name: v.name, category: v.category, lat: v.lat, lng: v.lng, dwellMinutes: dwellFor(v.category),
    reasons: [], justification: null, startsAt: null, endsAt: null, pinned: false,
    cuisines: v.cuisines ?? [], experiences: v.experiences ?? [], rating: v.rating ?? null, ratingCount: v.ratingCount ?? null, priceLevel: v.priceLevel ?? null,
    photos: v.photos ?? [], distanceKm: v.distanceKm ?? null, chain: v.chain, brand: v.brand ?? null, goodForChildren: v.goodForChildren ?? null, menuForChildren: v.menuForChildren ?? null,
    address: v.address ?? null, website: v.website ?? null, openingHours: v.openingHours ?? null, summary: v.summary ?? null, mapsUrl: v.mapsUrl ?? null, attribution: v.attribution ?? null,
    source: v.source, contributingSources: v.contributingSources, ratingSource: v.source, shortlisted: shortlisted.has(v.venueRef),
  });
  const add = async (v: FindResult) => {
    await api.addToShortlist(trip.id, {
      venueRef: v.venueRef, venueLabel: v.name, category: v.category, lat: v.lat, lng: v.lng,
      venue: { name: v.name, category: v.category, cuisines: v.cuisines, experiences: v.experiences, rating: v.rating, ratingCount: v.ratingCount, priceLevel: v.priceLevel, lat: v.lat, lng: v.lng, photos: v.photos, address: v.address, website: v.website, openingHours: v.openingHours } as Partial<Venue>,
    });
    await onChanged();
  };
  const setCat = (cat: FindCat) => { setFind((cur) => ({ ...cur, cat, kinds: [] })); setShown(20); };
  const toggleKind = (k: string) => setFind((cur) => ({ ...cur, kinds: cur.kinds.includes(k) ? cur.kinds.filter((x) => x !== k) : [...cur.kinds, k] }));

  // The kind sheet's groups, from what the sources actually returned in this tile.
  const groups = useMemo(() => {
    const seen = new Set<string>();
    const out: { label: string; items: [string, number][] }[] = [];
    if (find.cat === 'food') { out.push({ label: 'Cuisines', items: [...facets.entries()].sort((a, b) => b[1] - a[1]) }); return out; }
    for (const g of KIND_GROUPS) {
      const items = [...facets.entries()].filter(([k]) => g.keys.some((key) => k.toLowerCase().includes(key))).sort((a, b) => b[1] - a[1]);
      items.forEach(([k]) => seen.add(k));
      if (items.length) out.push({ label: g.label, items });
    }
    const rest = [...facets.entries()].filter(([k]) => !seen.has(k)).sort((a, b) => b[1] - a[1]);
    if (rest.length) out.push({ label: out.length ? 'Other' : 'Kind', items: rest });
    return out;
  }, [facets, find.cat]);

  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const } : null;
  const sheetView = (title: string, count: string, body: React.ReactNode) => (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={() => setSheet(null)}>
      <View style={[styles.sheetWrap, frameBox]}>
        <Pressable style={styles.scrim} onPress={() => setSheet(null)} accessibilityLabel="Close" />
        <View style={[styles.sheet, wide && styles.sheetWide]}>
          <View style={styles.handle} />
          <Row style={{ justifyContent: 'space-between' }}><Text style={type.h2}>{title}</Text><Text style={type.tiny}>{count}</Text></Row>
          <ScrollView style={{ maxHeight: Math.max(240, height - 260) }} contentContainerStyle={{ gap: spacing.md }}>{body}</ScrollView>
        </View>
      </View>
    </Modal>
  );

  const tile = (cat: FindCat, icon: 'attraction' | 'restaurant' | 'ticket', label: string, n: number) => {
    const on = find.cat === cat;
    return (
      <Pressable key={cat} onPress={() => setCat(cat)} style={[styles.tile, on && styles.tileOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
        <Icon name={icon} size={20} color={on ? colors.primaryFg : colors.icon} />
        <Text style={[styles.tileN, on && { color: colors.primaryFg }]}>{n}</Text>
        <Text style={[styles.tileL, on && { color: colors.primaryFg, opacity: 0.85 }]}>{label}</Text>
      </Pressable>
    );
  };
  const pill = (label: string, onPress: () => void, opts: { on?: boolean; icon?: 'plan' | 'attraction' | 'restaurant' | 'ticket' | 'address'; chevron?: boolean } = {}) => (
    <Pressable onPress={onPress} style={[styles.pill, opts.on && styles.pillOn]} accessibilityRole="button">
      {opts.icon ? <Icon name={opts.icon} size={13} color={opts.on ? colors.primaryFg : colors.icon} /> : null}
      <Text style={[styles.pillText, opts.on && { color: colors.primaryFg }]}>{label}</Text>
      {opts.chevron ? <Icon name="expand" size={12} color={opts.on ? colors.primaryFg : colors.inkMuted} /> : null}
    </Pressable>
  );

  return (
    <View style={{ gap: spacing.md }}>
      {searching ? (
        <View style={styles.search}>
          <Icon name="search" size={16} color={colors.icon} />
          <TextInput value={q} onChangeText={setQ} autoFocus placeholder="Name or kind of place" placeholderTextColor={colors.inkMuted} style={styles.input} onSubmitEditing={() => run({ q })} returnKeyType="search" />
          <Pressable onPress={() => { setSearching(false); setQ(''); if (find.q) run({ q: '' }); }} hitSlop={8}><Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>Cancel</Text></Pressable>
        </View>
      ) : (
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={type.h2}>Near {baseLabel}</Text>
            <Text style={type.tiny}>{find.loading ? 'Looking…' : find.res ? `${find.res.length} places · ${find.radiusKm} km${find.q ? ` · “${find.q}”` : ''}` : ''}</Text>
          </View>
          <Row style={{ gap: 6 }}>
            <Pressable onPress={() => setSearching(true)} style={styles.iconBtn} accessibilityLabel="Search"><Icon name="search" size={18} color={colors.ink} /></Pressable>
            <Pressable onPress={() => setSheet('filters')} style={styles.iconBtn} accessibilityLabel="Filters"><Icon name="list" size={18} color={colors.ink} /></Pressable>
          </Row>
        </Row>
      )}

      <View style={styles.tiles}>
        {tile('things', 'attraction', 'Things to do', counts.things)}
        {tile('food', 'restaurant', 'Places to eat', counts.food)}
        {tile('events', 'ticket', "What's on", counts.events)}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {pill(SORT_LABEL[find.sort], () => setFind((cur) => ({ ...cur, sort: SORT_NEXT[cur.sort] })), { on: find.sort === 'you', icon: find.sort === 'you' ? 'plan' : undefined })}
        {pill(find.kinds.length ? `${find.kinds.length} kind${find.kinds.length === 1 ? '' : 's'}` : 'Any kind', () => setSheet('kind'), { on: find.kinds.length > 0, chevron: true, icon: find.cat === 'food' ? 'restaurant' : find.cat === 'events' ? 'ticket' : 'attraction' })}
        {pill(BUDGET_LABEL[find.budget], () => setSheet('budget'), { on: find.budget !== 'any' })}
        {pill(`${find.radiusKm} km`, () => setSheet('filters'), { icon: 'address' })}
      </ScrollView>

      {find.error ? <StatusLine tone="warn">{find.error}. <Text onPress={() => run({}, true)} style={{ color: colors.accent, fontWeight: '700' }}>Try again</Text></StatusLine> : null}
      {find.loading && !find.res ? <Text style={type.small}>Looking around {baseLabel}…</Text> : null}
      {find.res && !find.loading && !list.length ? <Text style={type.small}>{inCat.length ? 'Nothing matches those picks.' : find.cat === 'events' ? 'No listings here for that day.' : `Nothing within ${find.radiusKm} km.`}</Text> : null}

      <View>
        {list.slice(0, shown).map(({ v, reasons }, i) => {
          const saved = shortlisted.has(v.venueRef);
          const k = known.get(v.venueRef);
          const loved = (v.household?.loved ?? k?.loved ?? 0) > 0;
          const meta = [cap(v.category), ...((find.cat === 'food' ? v.cuisines : v.experiences) ?? []).slice(0, 2).map(cap), priceMarks(v.priceLevel), v.category !== 'event' ? fmtMinutes(dwellFor(v.category)) : null].filter(Boolean).join(' · ');
          return (
            <Pressable key={v.venueRef} onPress={() => setOpen(asItem(v))} style={[styles.card, i === 0 && { borderTopWidth: 0, paddingTop: 4 }]} accessibilityRole="button">
              <View style={[styles.photo, i % 2 === 1 && { backgroundColor: colors.surfaceMuted }]}>
                <VenuePhoto photos={v.photos} size={88} credit={false} />
                {loved ? <View style={styles.heart}><Icon name="keep" size={11} color="#fff" fill /></View> : null}
              </View>
              <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={2}>{v.name}</Text>
                <Text style={type.small} numberOfLines={1}>{meta}</Text>
                <Row style={{ gap: 4 }}>
                  {v.rating != null ? <><Icon name="favourite" size={13} color={colors.icon} /><Text style={[type.small, { color: colors.ink, fontWeight: '700' }]}>{v.rating.toFixed(1)}</Text></> : null}
                  <Text style={type.small}>{v.rating != null ? ' · ' : ''}{v.distanceKm != null ? `${v.distanceKm < 1 ? `${Math.round(v.distanceKm * 1000)} m` : `${v.distanceKm} km`}` : ''}</Text>
                </Row>
                {reasons[0] ? <View style={styles.why}><Icon name={reasons[0].icon} size={12} color={colors.icon} /><Text style={styles.whyText} numberOfLines={1}>{reasons[0].text}</Text></View> : null}
              </View>
              <Pressable onPress={() => { if (!saved) add(v); }} style={[styles.save, saved && styles.saveOn]} accessibilityRole="button" accessibilityLabel={saved ? 'Shortlisted' : 'Shortlist'}>
                <Icon name={saved ? 'shortlisted' : 'shortlist'} size={16} color={saved ? colors.primaryFg : colors.ink} />
              </Pressable>
            </Pressable>
          );
        })}
      </View>
      {list.length > shown ? <Button label={`Show ${Math.min(20, list.length - shown)} more of ${list.length}`} kind="ghost" onPress={() => setShown((n) => n + 20)} /> : null}
      {shortlisted.size && onShortlist ? <Button label={`Shortlist · ${shortlisted.size}`} icon="list" kind="secondary" onPress={onShortlist} /> : null}

      {sheet === 'kind' ? sheetView('What kind of thing?', `${inCat.length} near ${baseLabel}`, (
        <>
          {groups.length ? groups.map((g) => (
            <View key={g.label} style={{ gap: 6 }}>
              <Text style={styles.label}>{g.label}</Text>
              <Wrap>{g.items.map(([k, n]) => <Chip key={k} label={`${cap(k)} · ${n}`} selected={find.kinds.includes(k)} onPress={() => toggleKind(k)} />)}</Wrap>
            </View>
          )) : <Text style={type.small}>The sources gave no kinds for these.</Text>}
          <Button label={find.kinds.length ? `Show ${list.length} place${list.length === 1 ? '' : 's'}` : 'Show all'} onPress={() => setSheet(null)} />
          {find.kinds.length ? <Button label="Clear" kind="ghost" onPress={() => setFind((cur) => ({ ...cur, kinds: [] }))} /> : null}
        </>
      )) : null}
      {sheet === 'budget' ? sheetView('Budget for the day', `for ${d.attendees.length || 'the family'}`, (
        <>
          <View style={styles.seg}>
            {(['easy', 'medium', 'splash'] as FindBudget[]).map((b) => (
              <Pressable key={b} onPress={() => setFind((cur) => ({ ...cur, budget: cur.budget === b ? 'any' : b }))} style={[styles.segItem, find.budget === b && styles.segOn]}><Text style={[styles.segText, find.budget === b && { color: colors.primaryFg }]}>{BUDGET_LABEL[b]}</Text></Pressable>
            ))}
          </View>
          <Wrap><Chip label="Free things only" icon="check" selected={find.budget === 'free'} onPress={() => setFind((cur) => ({ ...cur, budget: cur.budget === 'free' ? 'any' : 'free' }))} /></Wrap>
          <Text style={type.tiny}>{find.budget === 'any' ? 'Everything' : `${list.length} of ${inCat.length} fit`}{find.budget !== 'any' && find.budget !== 'free' ? ' · places with no price stay in' : ''}</Text>
          <Button label={`Show ${list.length} place${list.length === 1 ? '' : 's'}`} onPress={() => setSheet(null)} />
        </>
      )) : null}
      {sheet === 'filters' ? sheetView('Filters', find.fetchedAt ? `fetched ${new Date(find.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '', (
        <>
          <View style={{ gap: 6 }}>
            <Text style={styles.label}>How far</Text>
            <Wrap>{[1, 2, 3, 5, 10].map((r) => <Chip key={r} label={`${r} km`} selected={find.radiusKm === r} onPress={() => { if (r !== find.radiusKm) run({ radiusKm: r }); }} />)}</Wrap>
          </View>
          {sourceCounts.length > 1 ? (
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>Show only</Text>
              <Wrap>{sourceCounts.map(([src, n]) => <Chip key={src} label={`${src} · ${n}`} selected={find.only === src} onPress={() => setFind((cur) => ({ ...cur, only: cur.only === src ? null : src }))} />)}</Wrap>
            </View>
          ) : null}
          {wide ? <SourcePicker value={find.sources} onChange={(v) => run({ sources: v })} title="Fetch from" /> : null}
          <Button label="Refresh from the sources" kind="secondary" onPress={() => { setSheet(null); run({}, true); }} loading={find.loading} />
          <Button label="Done" onPress={() => setSheet(null)} />
        </>
      )) : null}

      <VenueDrawer item={open} baseLabel={baseLabel} onClose={() => setOpen(null)} onShortlist={async (b) => { const v = (find.res ?? []).find((x) => x.venueRef === b.venueRef); if (v) await add(v); }} shortlisted={open ? shortlisted.has(open.venueRef) : false} />
    </View>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink, backgroundColor: colors.surface },
  input: { flex: 1, fontSize: 15, color: colors.ink, minHeight: TARGET - 2 },
  iconBtn: { width: 38, height: 38, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, borderRadius: radius.md, padding: 10, paddingBottom: 8, gap: 6, backgroundColor: colors.surfaceMuted },
  tileOn: { backgroundColor: colors.primary },
  tileN: { fontSize: 22, fontWeight: '800', color: colors.ink, lineHeight: 24 },
  tileL: { fontSize: 12, fontWeight: '600', color: colors.inkMuted },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  pillOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontSize: 12, fontWeight: '600', color: colors.ink },
  card: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line, alignItems: 'flex-start' },
  photo: { width: 88, height: 88, borderRadius: radius.md, backgroundColor: colors.mint, overflow: 'visible' },
  heart: { position: 'absolute', right: -6, top: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.surface },
  name: { fontSize: 15, fontWeight: '800', color: colors.ink },
  why: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, marginTop: 2, maxWidth: '100%' },
  whyText: { fontSize: 12, fontWeight: '600', color: colors.ink, flexShrink: 1 },
  save: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  saveOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  label: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7, color: colors.inkMuted },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(32,30,29,0.45)' },
  sheet: { backgroundColor: colors.panel, borderTopWidth: 1, borderTopColor: colors.line, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
  sheetWide: { width: 520, alignSelf: 'center', borderRadius: radius.lg, marginBottom: spacing.xl },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line, alignSelf: 'center' },
  seg: { flexDirection: 'row', gap: 3, padding: 3, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radius.md },
  segOn: { backgroundColor: colors.primary },
  segText: { fontSize: 12, fontWeight: '700', color: colors.inkMuted },
});

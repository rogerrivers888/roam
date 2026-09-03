import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BrowseItem } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Button, Chip, Row, Segmented, Wrap, clock, minutes } from './ui';
import { priceMarks, typeLine } from './StopCard';
import { VenuePhoto } from './VenuePhoto';
import { VenueDrawer } from './VenueDrawer';
import { SourceLine, useSourceFilter } from './SourceData';

/**
 * The planner's main view (owner, 3 Sep 2026): everything found near the base
 * in three lists — things to do, places to eat, what's on — with a filter and
 * sort bar, not a mishmash and not algorithm-named plans. "Best match" is the
 * ranking from the API: rating and review count weigh heaviest, then the
 * household's tastes, children, and distance. Tap a row for the detail drawer.
 */

export type BrowseTab = 'things' | 'food' | 'events';
type Sort = 'best' | 'rating' | 'reviews' | 'nearest' | 'time';
const FOOD = new Set(['restaurant', 'cafe', 'pub', 'bar']);
export const tabOf = (b: BrowseItem): BrowseTab => (b.category === 'event' ? 'events' : FOOD.has(b.category) ? 'food' : 'things');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');

export function BrowsePool({ items, eventsSource, baseLabel, pinned, busy, addLabel = '+ Add to plan', addedLabel = '♥ In the plan', onAdd, onRemove, onDislike, onShortlist, shortlistedRefs }: {
  items: BrowseItem[];
  eventsSource: string | null | undefined;
  baseLabel: string;
  pinned: Set<string>;
  busy: boolean;
  addLabel?: string;
  addedLabel?: string;
  onAdd: (item: BrowseItem) => void;
  onRemove?: (item: BrowseItem) => void;
  onDislike: (item: BrowseItem) => void;
  /** Present inside a trip: saves to that trip's shortlist for any day. */
  onShortlist?: (item: BrowseItem) => Promise<void>;
  shortlistedRefs?: Set<string>;
}) {
  const [tab, setTab] = useState<BrowseTab>('things');
  const [sort, setSort] = useState<Sort>('best');
  const [facets, setFacets] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(15);
  const [open, setOpen] = useState<BrowseItem | null>(null);

  const counts = useMemo(() => ({ things: items.filter((b) => tabOf(b) === 'things').length, food: items.filter((b) => tabOf(b) === 'food').length, events: items.filter((b) => tabOf(b) === 'events').length }), [items]);
  const inTab = useMemo(() => items.filter((b) => tabOf(b) === tab), [items, tab]);

  // Facets: cuisines for food, kinds of thing for the rest — from what is actually here, most common first.
  const facetList = useMemo(() => {
    const c = new Map<string, number>();
    for (const b of inTab) for (const f of (tab === 'food' ? b.cuisines : b.experiences) ?? []) c.set(f, (c.get(f) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [inTab, tab]);

  const sf = useSourceFilter(inTab);
  const list = useMemo(() => {
    let l = sf.filtered;
    if (facets.size) l = l.filter((b) => ((tab === 'food' ? b.cuisines : b.experiences) ?? []).some((f) => facets.has(f)));
    const by: Record<Sort, (a: BrowseItem, b: BrowseItem) => number> = {
      best: (a, b) => (b.score ?? 0) - (a.score ?? 0),
      rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0),
      reviews: (a, b) => (b.ratingCount ?? 0) - (a.ratingCount ?? 0),
      nearest: (a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99),
      time: (a, b) => new Date(a.startsAt ?? 0).getTime() - new Date(b.startsAt ?? 0).getTime(),
    };
    return [...l].sort(by[sort]);
  }, [sf.filtered, facets, sort, tab]);

  const switchTab = (t: BrowseTab) => { setTab(t); setFacets(new Set()); setShown(15); setSort(t === 'events' ? 'time' : 'best'); };
  const toggleFacet = (f: string) => setFacets((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });
  const sortOptions: { value: Sort; label: string }[] = tab === 'events'
    ? [{ value: 'time', label: 'By time' }, { value: 'nearest', label: 'Nearest' }, { value: 'best', label: 'Best match' }]
    : [{ value: 'best', label: 'Best match' }, { value: 'rating', label: 'Top rated' }, { value: 'reviews', label: 'Most reviewed' }, { value: 'nearest', label: 'Nearest' }];

  return (
    <View style={{ gap: spacing.sm }}>
      <Segmented value={tab} options={[{ value: 'things', label: `Things to do (${counts.things})` }, { value: 'food', label: `Places to eat (${counts.food})` }, { value: 'events', label: `What's on (${counts.events})` }]} onChange={switchTab} />
      <Row style={{ flexWrap: 'wrap' }}>
        <Text style={type.tiny}>Sort</Text>
        <View style={{ flex: 1, minWidth: 260 }}><Segmented value={sort} options={sortOptions} onChange={setSort} /></View>
      </Row>
      {facetList.length ? (
        <Wrap>
          <Text style={[type.tiny, { alignSelf: 'center' }]}>{tab === 'food' ? 'Food' : 'Kind'}</Text>
          {facetList.map(([f, n]) => <Chip key={f} label={`${cap(f)} (${n})`} selected={facets.has(f)} onPress={() => toggleFacet(f)} />)}
          {facets.size ? <Chip label="Clear" onPress={() => setFacets(new Set())} /> : null}
        </Wrap>
      ) : null}
      {sf.chips}
      {sort === 'best' ? <Text style={type.tiny}>Best match weighs the rating and how many people gave it most, then what you like, whether it suits children, and distance from {baseLabel}.</Text> : null}

      {tab === 'events' && !eventsSource ? (
        <View style={styles.notice}>
          <Text style={type.body}>No event listings source is switched on, so Roam can't see what's on that day.</Text>
          <Text style={type.small}>Ticketmaster (free key) lists shows, gigs, sport, exhibitions and family events with their times. Street performers and pop-ups aren't in any listing we can query. The owner switches it on in Settings › Sources.</Text>
        </View>
      ) : null}
      {tab === 'events' && eventsSource && !list.length ? <Text style={type.small}>Nothing listed by {eventsSource} inside this day's window and reach.</Text> : null}
      {tab !== 'events' && !list.length ? <Text style={type.small}>{facets.size ? 'Nothing matches that filter — clear it to see everything.' : 'Nothing in this group within reach.'}</Text> : null}

      {list.slice(0, shown).map((b) => (
        <BrowseRow key={b.id} item={b} isPinned={pinned.has(b.id)} isShortlisted={!!shortlistedRefs?.has(b.venueRef) || !!b.shortlisted} busy={busy}
          addLabel={addLabel} addedLabel={addedLabel} onOpen={() => setOpen(b)}
          onAdd={() => onAdd(b)} onRemove={onRemove ? () => onRemove(b) : undefined} onDislike={() => onDislike(b)} onShortlist={onShortlist ? () => onShortlist(b) : undefined} />
      ))}
      {list.length > shown ? <Button label={`Show ${Math.min(15, list.length - shown)} more of ${list.length}`} kind="ghost" onPress={() => setShown((n) => n + 15)} /> : null}

      <VenueDrawer item={open} baseLabel={baseLabel} onClose={() => setOpen(null)} onAdd={(b) => { onAdd(b); }} onShortlist={onShortlist} added={open ? pinned.has(open.id) : false} shortlisted={open ? !!shortlistedRefs?.has(open.venueRef) : false} />
    </View>
  );
}

function BrowseRow({ item, isPinned, isShortlisted, busy, addLabel, addedLabel, onOpen, onAdd, onRemove, onDislike, onShortlist }: {
  item: BrowseItem; isPinned: boolean; isShortlisted: boolean; busy: boolean; addLabel: string; addedLabel: string;
  onOpen: () => void; onAdd: () => void; onRemove?: () => void; onDislike: () => void; onShortlist?: () => Promise<void>;
}) {
  const [saved, setSaved] = useState(false);
  const price = priceMarks(item.priceLevel);
  const isEvent = item.category === 'event';
  return (
    <View style={styles.row}>
      <Pressable onPress={onOpen} style={{ flexDirection: 'row', gap: spacing.md, flex: 1 }} accessibilityRole="button" accessibilityLabel={`Open ${item.name}`}>
        <VenuePhoto photos={item.photos} size={72} credit={false} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.h3}>{item.name}{item.chain ? <Text style={[type.tiny, { color: colors.dislike }]}>  chain</Text> : null}</Text>
          <Text style={type.small}>
            {isEvent && item.startsAt ? `${clock(item.startsAt)}${item.venueName ? ` · ${item.venueName}` : ''} · ` : ''}
            {typeLine(item)}{price ? ` · ${price}` : ''}
          </Text>
          <Text style={type.small}>
            {item.rating != null ? <Text style={{ fontWeight: '700', color: colors.ink }}>★ {item.rating.toFixed(1)}</Text> : <Text style={type.tiny}>no rating</Text>}
            {item.ratingCount ? ` (${item.ratingCount.toLocaleString()})` : ''}
            {item.distanceKm != null ? ` · ${item.distanceKm} km` : ''}{item.travelFromBaseMinutes != null ? `, ${item.travelFromBaseMinutes} min` : ''}
            {!isEvent ? ` · about ${minutes(item.dwellMinutes)}` : ''}
          </Text>
          <SourceLine item={item} />
          {item.reasons.length ? <Wrap>{item.reasons.filter((r) => r.kind !== 'chain').slice(0, 3).map((r, i) => <Chip key={i} label={r.text} tone={r.kind === 'dislike' || r.kind === 'diet' ? 'dislike' : r.kind === 'note' ? 'neutral' : 'like'} />)}</Wrap> : null}
          <Text style={[type.tiny, { color: colors.accent }]}>Details, reviews, hours, photos ›</Text>
        </View>
      </Pressable>
      <View style={{ gap: 6 }}>
        <Pressable onPress={isPinned && onRemove ? onRemove : onAdd} disabled={busy || (isPinned && !onRemove)} style={[styles.btn, isPinned && styles.btnOn]} accessibilityRole="button">
          <Text style={[styles.btnText, isPinned && { color: '#fff' }]}>{isPinned ? addedLabel : addLabel}</Text>
        </Pressable>
        {onShortlist ? (
          <Pressable onPress={async () => { await onShortlist(); setSaved(true); }} disabled={busy || saved || isShortlisted} style={styles.btn} accessibilityRole="button">
            <Text style={styles.btnText}>{saved || isShortlisted ? '✓ Shortlisted' : '☆ Shortlist'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onDislike} disabled={busy} style={styles.btn} accessibilityRole="button"><Text style={styles.btnText}>✕ Not this</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  btn: { minHeight: 36, minWidth: 124, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  btnOn: { backgroundColor: colors.like },
  btnText: { fontSize: 12, fontWeight: '700', color: colors.ink },
  notice: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, gap: 4 },
});

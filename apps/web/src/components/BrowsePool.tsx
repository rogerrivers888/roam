import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { BrowseItem } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, Wrap, clock, minutes } from './ui';
import { priceMarks, typeLine } from './StopCard';
import { VenuePhoto } from './VenuePhoto';

/**
 * Everything Roam found for the day — not just the three plans. Three lists:
 * things to do, places to eat, and what's on (timed events). Each row can go
 * straight into every plan ("Add to plan"), onto the trip's shortlist for any
 * day, or be set aside. "What's on" is honest about its source: with no event
 * listings source switched on, it says so instead of showing an empty list.
 */

type Tab = 'things' | 'food' | 'events';
const FOOD = new Set(['restaurant', 'cafe', 'pub', 'bar']);
const tabOf = (b: BrowseItem): Tab => (b.category === 'event' ? 'events' : FOOD.has(b.category) ? 'food' : 'things');
const SOURCE_LABEL: Record<string, string> = { google: 'Google', tripadvisor: 'Tripadvisor', osm: 'OpenStreetMap', ticketmaster: 'Ticketmaster' };

export function BrowsePool({ items, eventsSource, baseLabel, pinned, busy, onAdd, onRemove, onDislike, onShortlist }: {
  items: BrowseItem[];
  eventsSource: string | null | undefined;
  baseLabel: string;
  pinned: Set<string>;
  busy: boolean;
  onAdd: (item: BrowseItem) => void;
  onRemove: (item: BrowseItem) => void;
  onDislike: (item: BrowseItem) => void;
  /** Present inside a trip: saves to that trip's shortlist for any day. */
  onShortlist?: (item: BrowseItem) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('things');
  const [shown, setShown] = useState(12);
  const counts = { things: items.filter((b) => tabOf(b) === 'things').length, food: items.filter((b) => tabOf(b) === 'food').length, events: items.filter((b) => tabOf(b) === 'events').length };
  const list = items.filter((b) => tabOf(b) === tab);

  return (
    <Card style={{ gap: spacing.sm }}>
      <Text style={type.h3}>Everything Roam found near {baseLabel}</Text>
      <Text style={type.tiny}>The plans above are a start. Add anything here to every plan, or shortlist it for another day. Chains and price follow the choices above.</Text>
      <Segmented value={tab} options={[{ value: 'things', label: `Things to do (${counts.things})` }, { value: 'food', label: `Places to eat (${counts.food})` }, { value: 'events', label: `What's on (${counts.events})` }]} onChange={(t) => { setTab(t); setShown(12); }} />

      {tab === 'events' && !eventsSource ? (
        <View style={styles.notice}>
          <Text style={type.body}>No event listings source is switched on, so Roam can't see what's on that day.</Text>
          <Text style={type.small}>Ticketmaster (free key) lists shows, gigs, sport, exhibitions and family events with their times; they would appear here and be planned around. Street performers and pop-ups aren't in any listing we can query. The owner switches it on in Settings › Sources.</Text>
        </View>
      ) : null}
      {tab === 'events' && eventsSource && !list.length ? <Text style={type.small}>Nothing listed on {SOURCE_LABEL[eventsSource] ?? eventsSource} inside this day's window and reach.</Text> : null}
      {tab !== 'events' && !list.length ? <Text style={type.small}>Nothing in this group within reach.</Text> : null}

      {list.slice(0, shown).map((b) => <BrowseRow key={b.id} item={b} isPinned={pinned.has(b.id)} busy={busy} onAdd={() => onAdd(b)} onRemove={() => onRemove(b)} onDislike={() => onDislike(b)} onShortlist={onShortlist ? () => onShortlist(b) : undefined} />)}
      {list.length > shown ? <Button label={`Show ${Math.min(12, list.length - shown)} more`} kind="ghost" onPress={() => setShown((n) => n + 12)} /> : null}
    </Card>
  );
}

function BrowseRow({ item, isPinned, busy, onAdd, onRemove, onDislike, onShortlist }: { item: BrowseItem; isPinned: boolean; busy: boolean; onAdd: () => void; onRemove: () => void; onDislike: () => void; onShortlist?: () => Promise<void> }) {
  const [saved, setSaved] = useState(item.shortlisted);
  const price = priceMarks(item.priceLevel);
  const isEvent = item.category === 'event';
  return (
    <View style={styles.row}>
      <VenuePhoto photos={item.photos} size={56} credit={false} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.h3}>{item.name}{item.chain ? '  ' : ''}{item.chain ? <Text style={[type.tiny, { color: colors.dislike }]}>chain</Text> : null}</Text>
        <Text style={type.small}>
          {isEvent && item.startsAt ? `${clock(item.startsAt)}${item.venueName ? ` · ${item.venueName}` : ''} · ` : ''}
          {typeLine(item)}{price ? ` · ${price}` : ''}
          {item.rating != null ? ` · ★ ${item.rating.toFixed(1)}${item.ratingCount ? ` (${item.ratingCount.toLocaleString()})` : ''}` : ''}
          {item.distanceKm != null ? ` · ${item.distanceKm} km` : ''}{item.travelFromBaseMinutes != null ? `, ${item.travelFromBaseMinutes} min` : ''}
          {!isEvent ? ` · about ${minutes(item.dwellMinutes)}` : ''}
        </Text>
        {item.reasons.length ? <Wrap>{item.reasons.filter((r) => r.kind !== 'chain').slice(0, 3).map((r, i) => <Chip key={i} label={r.text} tone={r.kind === 'dislike' || r.kind === 'diet' ? 'dislike' : r.kind === 'note' ? 'neutral' : 'like'} />)}</Wrap> : null}
        {item.justification ? <Text style={type.tiny} numberOfLines={2}>"{item.justification}"</Text> : null}
        {item.externalUrl ? <Pressable onPress={() => Linking.openURL(item.externalUrl!)}><Text style={[type.tiny, { color: colors.accent }]}>Tickets and details</Text></Pressable> : null}
      </View>
      <View style={{ gap: 6 }}>
        <Pressable onPress={isPinned ? onRemove : onAdd} disabled={busy} style={[styles.btn, isPinned && styles.btnOn]} accessibilityRole="button">
          <Text style={[styles.btnText, isPinned && { color: '#fff' }]}>{isPinned ? '♥ In every plan' : '+ Add to plan'}</Text>
        </Pressable>
        {onShortlist ? (
          <Pressable onPress={async () => { await onShortlist(); setSaved(true); }} disabled={busy || saved} style={styles.btn} accessibilityRole="button">
            <Text style={styles.btnText}>{saved ? '✓ Shortlisted' : '☆ Shortlist'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onDislike} disabled={busy} style={styles.btn} accessibilityRole="button"><Text style={styles.btnText}>✕ Not this</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  btn: { minHeight: 36, minWidth: 120, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  btnOn: { backgroundColor: colors.like },
  btnText: { fontSize: 12, fontWeight: '700', color: colors.ink },
  notice: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, gap: 4 },
});

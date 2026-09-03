import React, { useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { API_URL, api, BrowseItem, Venue } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Chip, Row, Segmented, Wrap, clock, minutes } from './ui';
import { SOURCE_LABEL, priceMarks, typeLine } from './StopCard';

/**
 * The click-through on a place (owner, 3 Sep 2026): a side drawer on a wide
 * screen, a full sheet on a phone, with tabs for what the sources actually
 * give us — overview (summary, address, price, children, booking, website,
 * map), reviews (best to most critical, with attribution), opening hours, and
 * photos. Detail is fetched when opened and never stored: licensed content is
 * rented, identifiers are ours (Technical Constraints §4).
 */

type Tab = 'overview' | 'reviews' | 'hours' | 'photos';

export function VenueDrawer({ item, baseLabel, onClose, onAdd, onShortlist, added, shortlisted, ours, onVenue }: {
  item: BrowseItem | null;
  baseLabel?: string | null;
  onClose: () => void;
  onAdd?: (item: BrowseItem) => void;
  onShortlist?: (item: BrowseItem) => Promise<void>;
  added?: boolean;
  shortlisted?: boolean;
  /** The household's own side of the place (Places tab): status, history, notes — shown above the source's tabs. */
  ours?: React.ReactNode;
  /** The source's record once fetched (the atlas uses it to learn a name it only held as an identifier). */
  onVenue?: (venue: Venue) => void;
}) {
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900;
  // Inside the shell's phone frame the Modal still portals to the whole window, so the sheet is pinned to the frame's size.
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const } : null;
  const [tab, setTab] = useState<Tab>('overview');
  const [venue, setVenue] = useState<Venue | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setTab('overview'); setVenue(undefined); setError(null); setSaved(false);
    if (!item) return;
    let live = true;
    api.place(item.venueRef).then((d) => { if (live) { setVenue(d.venue); if (d.venue) onVenue?.(d.venue); if (d.sourceError) setError(d.sourceError); } }).catch((e) => { if (live) { setVenue(null); setError(e.message); } });
    return () => { live = false; };
  }, [item?.venueRef]);

  if (!item) return null;
  const v = venue ?? undefined;
  // A place the atlas holds only by identifier takes its name from the source when the drawer opens.
  const title = item.name === item.venueRef && v?.name ? v.name : item.name;
  const photos = (v?.photos?.length ? v.photos : item.photos) ?? [];
  const reviews = [...(v?.reviews ?? [])].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const hours = (v?.openingHours ?? item.openingHours ?? '').split(' · ').filter(Boolean);
  const website = v?.website ?? item.website;
  const mapsUrl = v?.mapsUrl ?? item.mapsUrl;
  const externalUrl = v?.externalUrl ?? item.externalUrl;
  const price = priceMarks(v?.priceLevel ?? item.priceLevel);
  const rating = v?.rating ?? item.rating;
  const ratingCount = v?.ratingCount ?? item.ratingCount;
  const source = item.source ?? item.venueRef.split(':')[0];
  const sourceName = SOURCE_LABEL[source] ?? source;
  const photoUri = (p: { ref?: string; url?: string }, w: number) => p.url ?? (p.ref ? `${API_URL}/api/photos/google?name=${encodeURIComponent(p.ref)}&w=${w}` : null);

  const tabs: { value: Tab; label: string }[] = [
    { value: 'overview', label: 'Overview' }, { value: 'reviews', label: `Reviews${reviews.length ? ` (${reviews.length})` : ''}` },
    { value: 'hours', label: 'Hours' }, { value: 'photos', label: `Photos${photos.length ? ` (${photos.length})` : ''}` },
  ];

  return (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.panel, wide ? styles.panelSide : styles.panelSheet, frameBox]}>
          <ScrollView contentContainerStyle={{ gap: spacing.md, padding: spacing.lg }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.title}>{title}</Text>
                <Text style={type.small}>{typeLine(item)}{price ? ` · ${price}` : ''}{item.chain ? ` · chain${item.brand ? ` (${item.brand})` : ''}` : ''}</Text>
                {rating != null ? <Text style={type.body}><Text style={{ fontWeight: '700' }}>★ {rating.toFixed(1)}</Text>{ratingCount ? ` from ${ratingCount.toLocaleString()} reviews` : ''} · {SOURCE_LABEL[item.ratingSource ?? source] ?? sourceName}</Text> : <Text style={type.tiny}>No rating from {sourceName}.</Text>}
                {(() => {
                  const bits = [
                    item.distanceKm != null ? `${item.distanceKm} km from ${baseLabel ?? 'base'}` : null,
                    item.travelFromBaseMinutes != null ? `about ${item.travelFromBaseMinutes} min` : null,
                    item.category !== 'event' && item.dwellMinutes > 0 ? `allow ${minutes(item.dwellMinutes)}` : null,
                    item.startsAt ? clock(item.startsAt) : null,
                  ].filter(Boolean);
                  return bits.length ? <Text style={type.small}>{bits.join(' · ')}</Text> : null;
                })()}
              </View>
              <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close"><Text style={{ fontSize: 20 }}>✕</Text></Pressable>
            </Row>

            {photos[0] && photoUri(photos[0], 800) ? (
              <View>
                <Image source={{ uri: photoUri(photos[0], 800)! }} style={styles.hero} accessibilityIgnoresInvertColors />
                {photos[0].attribution ? <Text style={type.tiny}>📷 {photos[0].attribution}</Text> : null}
              </View>
            ) : null}

            <Wrap>
              {onAdd ? <Button label={added ? '♥ In the plan' : '+ Add to plan'} kind={added ? 'secondary' : 'primary'} onPress={() => onAdd(item)} disabled={added} /> : null}
              {onShortlist ? <Button label={saved || shortlisted ? '✓ Shortlisted' : '☆ Shortlist'} kind="secondary" onPress={async () => { await onShortlist(item); setSaved(true); }} disabled={saved || shortlisted} /> : null}
              {website ? <Button label="Website" kind="ghost" onPress={() => Linking.openURL(website)} /> : null}
              {mapsUrl ? <Button label="Open in Google Maps" kind="ghost" onPress={() => Linking.openURL(mapsUrl)} /> : null}
              {externalUrl && !mapsUrl ? <Button label={item.category === 'event' ? 'Tickets' : `On ${sourceName}`} kind="ghost" onPress={() => Linking.openURL(externalUrl)} /> : null}
            </Wrap>

            {ours}

            <Segmented value={tab} options={tabs} onChange={setTab} />
            {venue === undefined ? <Text style={type.tiny}>Fetching from {sourceName}…</Text> : null}
            {error ? <Text style={[type.tiny, { color: colors.dislike }]}>{error}</Text> : null}

            {tab === 'overview' ? (
              <View style={{ gap: spacing.sm }}>
                {v?.summary ?? item.summary ? <Text style={type.body}>{v?.summary ?? item.summary}</Text> : null}
                {item.reasons.length ? <Wrap>{item.reasons.filter((r) => r.kind !== 'chain').map((r, i) => <Chip key={i} label={r.text} tone={r.kind === 'dislike' || r.kind === 'diet' ? 'dislike' : r.kind === 'note' ? 'neutral' : 'like'} />)}</Wrap> : null}
                {v?.address ?? item.address ? <Text style={type.small}>📍 {v?.address ?? item.address}</Text> : null}
                {item.venueName ? <Text style={type.small}>🎟 At {item.venueName}</Text> : null}
                {(v?.goodForChildren ?? item.goodForChildren) != null ? <Text style={type.small}>{(v?.goodForChildren ?? item.goodForChildren) ? '👧 Good for children' : 'Not noted as good for children'}{(v?.menuForChildren ?? item.menuForChildren) ? " · children's menu" : ''}</Text> : null}
                {item.reservable != null ? <Text style={type.small}>{item.reservable ? '📞 Takes bookings' : 'Walk-in only'}</Text> : null}
                {(v?.dietaryOptions ?? []).length ? <Text style={type.small}>Diets: {(v?.dietaryOptions ?? []).join(', ')}</Text> : null}
                {item.justification ? <Text style={type.small}>"{item.justification}"</Text> : null}
                <Text style={type.tiny}>Menus: none of our sources publish menus; the website button is the nearest thing.</Text>
              </View>
            ) : null}

            {tab === 'reviews' ? (
              <View style={{ gap: spacing.sm }}>
                {reviews.map((r, i) => (
                  <View key={i} style={styles.review}>
                    <Text style={type.small}>
                      <Text style={{ fontWeight: '700', color: colors.ink }}>{r.rating != null ? `★ ${r.rating}` : ''}</Text>
                      {reviews.length > 1 && i === 0 ? '  best' : reviews.length > 1 && i === reviews.length - 1 ? '  most critical' : ''}
                      {r.author ? ` · ${r.author}` : ''}{r.when ? ` · ${r.when}` : ''}
                    </Text>
                    <Text style={type.body}>{r.text}</Text>
                  </View>
                ))}
                {venue !== undefined && !reviews.length ? <Text style={type.small}>{source === 'osm' || source === 'fixtures' ? 'OpenStreetMap carries no reviews. Google Places and Tripadvisor return up to five each when the place is theirs.' : `No review text returned by ${sourceName} for this place.`}</Text> : null}
                {reviews.length ? <Text style={type.tiny}>{v?.attribution ?? item.attribution ?? ''} · Up to five reviews are available through the API; the rest are on the source's own page.</Text> : null}
              </View>
            ) : null}

            {tab === 'hours' ? (
              <View style={{ gap: 4 }}>
                {hours.length ? hours.map((h, i) => <Text key={i} style={type.body}>{h}</Text>) : <Text style={type.small}>{venue === undefined ? '' : `No opening hours from ${sourceName}.`}</Text>}
              </View>
            ) : null}

            {tab === 'photos' ? (
              <View style={{ gap: spacing.sm }}>
                {photos.length ? photos.map((p, i) => { const u = photoUri(p, 800); return u ? <View key={i}><Image source={{ uri: u }} style={styles.hero} accessibilityIgnoresInvertColors />{p.attribution ? <Text style={type.tiny}>📷 {p.attribution}</Text> : null}</View> : null; }) : <Text style={type.small}>{venue === undefined ? '' : `No photos from ${sourceName}.`}</Text>}
              </View>
            ) : null}

            <Text style={type.tiny}>{v?.attribution ?? item.attribution ?? ''}</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropWrap: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(29,27,22,0.35)' },
  panel: { backgroundColor: colors.bg },
  panelSide: { width: 460, maxWidth: '100%', height: '100%', borderLeftWidth: 1, borderLeftColor: colors.line },
  panelSheet: { width: '100%', height: '100%' },
  close: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  hero: { width: '100%', height: 220, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  review: { gap: 2, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
});

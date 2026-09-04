import React, { useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { Icon, IconText, Rating, Stars } from './Icon';
import { API_URL, api, BrowseItem, MenuLink, OwnedRecord, Venue } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Chip, Row, Segmented, Wrap, clock, minutes } from './ui';
import { MenuOrder } from './MenuOrder';
import { OwnedFacts } from './OwnedFacts';
import { useOffline } from '../hooks/useOffline';
import { savedRecord } from '../offline/cache';
import { SOURCE_LABEL, priceMarks, typeLine } from './StopCard';

/**
 * The click-through on a place (owner, 3 Sep 2026): a side drawer on a wide
 * screen, a full sheet on a phone, with tabs for what the sources actually
 * give us — overview (summary, address, price, children, booking, website,
 * map), reviews (best to most critical, with attribution), opening hours, and
 * photos. Detail is fetched when opened and never stored: licensed content is
 * rented, identifiers are ours (Technical Constraints §4).
 *
 * Underneath all of that sits the part that does not disappear (owner, 4 Sep
 * 2026): Roam's own record of the place, researched when the household kept it,
 * from sources whose licences let us hold on to the answer. With no signal the
 * provider's half of this drawer is empty and that record is the whole of it —
 * the address, the phone number, the hours, the menu — which is what makes a
 * place openable standing outside it with no bars.
 *
 * Three things it answers for someone standing outside (owner, 4 Sep 2026):
 * whether it is open today, what each review actually gave it in stars, and
 * where the menu is — the last found by following the website when the drawer
 * opens, not by asking a source that does not have it.
 */

type Tab = 'overview' | 'reviews' | 'hours' | 'photos';

// Somewhere you eat, where the menu is worth a row of its own.
const EATING = new Set(['restaurant', 'cafe', 'bar', 'pub']);

/**
 * Open today, or not. Google decides `openNow` in the place's own timezone, so
 * this reads it rather than working it out; `hoursToday` is the day's own words
 * where the place is. Sources that do not say leave this empty rather than
 * guessing.
 */
function openState(v?: Venue): { state: string; detail: string | null; open: boolean | null } | null {
  if (!v) return null;
  const today = (v.hoursToday ?? '').trim();
  const closedAllDay = /^closed$/i.test(today);
  if (v.openNow === true) return { state: 'Open now', detail: v.closesAt ? `closes ${v.closesAt}` : today || null, open: true };
  if (v.openNow === false) {
    if (closedAllDay) return { state: 'Closed today', detail: null, open: false };
    return { state: 'Closed now', detail: v.opensAt ? `opens ${v.opensAt}` : today || null, open: false };
  }
  if (closedAllDay) return { state: 'Closed today', detail: null, open: false };
  if (today) return { state: 'Open today', detail: today, open: null };
  return null;
}

/** The address as you would read it aloud, without the protocol. */
const prettyUrl = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/$/, '').slice(0, 64);

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
  const [menu, setMenu] = useState<MenuLink | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Roam's own record: what survives when the provider cannot be reached.
  const [ownRecord, setOwnRecord] = useState<OwnedRecord | null | undefined>(undefined);
  const { online, serving } = useOffline();
  // The same test the shell uses: not what the browser claims, but whether the
  // answers on screen actually came off the device.
  const showingSaved = !online || serving;
  // The table half of the evening: read the menu, tick who wants what, show the
  // order to the waiter, star what stood out (owner, 4 Sep 2026).
  const [ordering, setOrdering] = useState(false);

  useEffect(() => {
    setTab('overview'); setVenue(undefined); setMenu(undefined); setError(null); setSaved(false); setOwnRecord(undefined);
    if (!item) return;
    let live = true;
    // A place the household has never opened has no saved answer of its own, but
    // every owned record arrived in one piece when the copy was filled — so with
    // no signal the address and the phone number are still here.
    const fromDevice = async () => {
      const ref = item.venueRef;
      const r = await savedRecord(ref);
      if (live) setOwnRecord(r);
    };
    api.place(item.venueRef)
      .then((d) => {
        if (!live) return;
        setVenue(d.venue); setMenu(d.menu ?? null);
        if (d.venue) onVenue?.(d.venue);
        if (d.sourceError) setError(d.sourceError);
        if (d.ours) setOwnRecord(d.ours);
        else void fromDevice();
      })
      .catch((e) => {
        if (!live) return;
        setVenue(null); setMenu(null);
        setError(e?.code === 'offline' ? null : e.message);
        void fromDevice();
      });
    return () => { live = false; };
  }, [item?.venueRef]);

  if (!item) return null;
  const v = venue ?? undefined;
  // A place the atlas holds only by identifier takes its name from the source when the drawer opens.
  const title = item.name === item.venueRef && v?.name ? v.name : item.name;
  const photos = (v?.photos?.length ? v.photos : item.photos) ?? [];
  const reviews = [...(v?.reviews ?? [])].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const hours = (v?.openingHours ?? item.openingHours ?? '').split(' · ').filter(Boolean);
  const website = v?.website ?? ownRecord?.website ?? item.website;
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
    <>
    {ordering ? (
      <MenuOrder venueRef={item.venueRef} venueLabel={title} website={website ?? null} onClose={() => setOrdering(false)} />
    ) : null}
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.panel, wide ? styles.panelSide : styles.panelSheet, frameBox]}>
          <ScrollView contentContainerStyle={{ gap: spacing.md, padding: spacing.lg }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.title}>{title}</Text>
                <Text style={type.small}>{typeLine(item)}{price ? ` · ${price}` : ''}{item.chain ? ` · chain${item.brand ? ` (${item.brand})` : ''}` : ''}</Text>
                {rating != null ? <Rating value={rating}>{ratingCount ? ` from ${ratingCount.toLocaleString()} reviews` : ''} · {SOURCE_LABEL[item.ratingSource ?? source] ?? sourceName}</Rating> : <Text style={type.tiny}>No rating from {sourceName}.</Text>}
                {(() => {
                  const o = openState(v);
                  if (!o) return null;
                  return (
                    <IconText name="hours" color={o.open === false ? colors.inkMuted : colors.icon}>
                      <Text style={{ fontWeight: '700', color: colors.ink }}>{o.state}</Text>{o.detail ? ` · ${o.detail}` : ''}
                    </IconText>
                  );
                })()}
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
              <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close"><Icon name="close" size={22} color={colors.ink} /></Pressable>
            </Row>

            {photos[0] && photoUri(photos[0], 800) ? (
              <View>
                <Image source={{ uri: photoUri(photos[0], 800)! }} style={styles.hero} accessibilityIgnoresInvertColors />
                {photos[0].attribution ? <Text style={type.tiny}>{photos[0].attribution}</Text> : null}
              </View>
            ) : null}

            <Wrap>
              {onAdd ? <Button label={added ? 'In the plan' : 'Add to plan'} icon={added ? 'keep' : 'add'} iconFill={added} kind={added ? 'secondary' : 'primary'} onPress={() => onAdd(item)} disabled={added} /> : null}
              {onShortlist ? <Button label={saved || shortlisted ? 'Shortlisted' : 'Shortlist'} icon={saved || shortlisted ? 'shortlisted' : 'shortlist'} kind="secondary" onPress={async () => { await onShortlist(item); setSaved(true); }} disabled={saved || shortlisted} /> : null}
              {website ? <Button label="Website" icon="external" kind="ghost" onPress={() => Linking.openURL(website)} /> : null}
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
                {v?.address ?? item.address ? <IconText name="address">{v?.address ?? item.address}</IconText> : null}
                {venue === null && !error ? <IconText name="offline" color={colors.inkMuted}>No signal — showing what is saved on this device.</IconText> : null}
                {item.venueName ? <IconText name="ticket">At {item.venueName}</IconText> : null}
                {(v?.goodForChildren ?? item.goodForChildren) != null ? <IconText name="children">{(v?.goodForChildren ?? item.goodForChildren) ? 'Good for children' : 'Not noted as good for children'}{(v?.menuForChildren ?? item.menuForChildren) ? " · children's menu" : ''}</IconText> : null}
                {item.reservable != null ? <IconText name="phone">{item.reservable ? 'Takes bookings' : 'Walk-in only'}</IconText> : null}
                {(v?.dietaryOptions ?? []).length ? <Text style={type.small}>Diets: {(v?.dietaryOptions ?? []).join(', ')}</Text> : null}
                {item.justification ? <Text style={type.small}>"{item.justification}"</Text> : null}
                {EATING.has(item.category) ? (
                  <View style={{ gap: 2 }}>
                    {menu === undefined ? <IconText name="restaurant">Looking for their menu…</IconText> : null}
                    {menu?.url ? (
                      <>
                        <Pressable onPress={() => Linking.openURL(menu.url!)} accessibilityRole="link" accessibilityLabel="Open the menu">
                          <IconText name="restaurant">Menu · <Text style={{ color: colors.accent, fontWeight: '700' }}>{prettyUrl(menu.url)}</Text></IconText>
                        </Pressable>
                        <Text style={type.tiny}>{menu.how} Looked up just now; no source publishes menus, so this is their own page and nothing is kept.</Text>
                      </>
                    ) : null}
                    {menu && !menu.url ? (
                      <>
                        <IconText name="restaurant" color={colors.inkMuted}>No menu address on their site.</IconText>
                        <Text style={type.tiny}>{menu.why}</Text>
                      </>
                    ) : null}
                    <Wrap style={{ marginTop: 4 }}>
                      <Button label="Menu & order" icon="list" kind="secondary" onPress={() => setOrdering(true)} />
                    </Wrap>
                    <Text style={type.tiny}>Reads their menu into dishes you can tick off, one each, and makes the order to show the waiter.</Text>
                  </View>
                ) : null}

                <OwnedFacts
                  record={ownRecord}
                  offline={showingSaved}
                  onResearch={async () => {
                    setOwnRecord(undefined);
                    const r = await api.researchPlace(item.venueRef).catch(() => null);
                    setOwnRecord(r?.record ?? null);
                  }}
                />
              </View>
            ) : null}

            {tab === 'reviews' ? (
              <View style={{ gap: spacing.sm }}>
                {reviews.map((r, i) => (
                  <View key={i} style={styles.review}>
                    <Row style={{ flexWrap: 'wrap', gap: spacing.sm }}>
                      {r.rating != null ? <Stars value={r.rating} size={14} /> : null}
                      <Text style={type.tiny}>{[
                        reviews.length > 1 && i === 0 ? 'best' : reviews.length > 1 && i === reviews.length - 1 ? 'most critical' : null,
                        r.author, r.when,
                      ].filter(Boolean).join(' · ')}</Text>
                    </Row>
                    <Text style={type.body}>{r.text}</Text>
                  </View>
                ))}
                {venue !== undefined && !reviews.length ? <Text style={type.small}>{source === 'osm' || source === 'fixtures' ? 'OpenStreetMap carries no reviews. Google Places and Tripadvisor return up to five each when the place is theirs.' : `No review text returned by ${sourceName} for this place.`}</Text> : null}
                {reviews.length ? <Text style={type.tiny}>{v?.attribution ?? item.attribution ?? ''} · Up to five reviews are available through the API; the rest are on the source's own page.</Text> : null}
              </View>
            ) : null}

            {tab === 'hours' ? (
              <View style={{ gap: 4 }}>
                {(() => {
                  const o = openState(v);
                  return o ? <Text style={[type.body, { fontWeight: '700' }]}>{o.state}{o.detail ? ` · ${o.detail}` : ''}</Text> : null;
                })()}
                {hours.length ? hours.map((h, i) => <Text key={i} style={type.body}>{h}</Text>) : <Text style={type.small}>{venue === undefined ? '' : `No opening hours from ${sourceName}.`}</Text>}
                {!hours.length && ownRecord?.openingHours ? (
                  <View style={{ gap: 1, marginTop: spacing.sm }}>
                    <Text style={type.body}>{ownRecord.openingHours}</Text>
                    <Text style={type.tiny}>Roam's own record, from {ownRecord.provenance?.opening_hours === 'site' ? 'their own website' : 'OpenStreetMap'} — kept, so it is here with no signal.</Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {tab === 'photos' ? (
              <View style={{ gap: spacing.sm }}>
                {photos.length ? photos.map((p, i) => { const u = photoUri(p, 800); return u ? <View key={i}><Image source={{ uri: u }} style={styles.hero} accessibilityIgnoresInvertColors />{p.attribution ? <Text style={type.tiny}>{p.attribution}</Text> : null}</View> : null; }) : <Text style={type.small}>{venue === undefined ? '' : `No photos from ${sourceName}.`}</Text>}
              </View>
            ) : null}

            <Text style={type.tiny}>{v?.attribution ?? item.attribution ?? ''}</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
    </>
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

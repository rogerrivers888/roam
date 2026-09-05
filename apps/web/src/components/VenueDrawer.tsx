import React, { useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { Icon, IconName, IconText, Rating, Stars } from './Icon';
import { API_URL, api, BrowseItem, MenuLink, OwnedRecord, PlaceInsideItem, Venue } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Chip, Row, Segmented, Wrap, clock, minutes } from './ui';
import { MenuPanel, OrderPanel, PastMeals, StaffSheet, useMenuOrder } from './MenuOrder';
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

// The tabs the owner asked for (4 Sep 2026): "I don't think hours and photos
// are needed… no harm, but definitely doesn't need to be a tab." Hours and
// photos fold into Overview; getting there earns one of its own; and the menu
// and the order — the two things you want while you are standing in the place —
// are tabs rather than something below the fold.
type Tab = 'overview' | 'travel' | 'reviews' | 'menu' | 'order' | 'inside';

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

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/**
 * "Monday to Friday · 12:00–22:30" rather than the same line five times (owner,
 * 4 Sep 2026). A run of days that keep the same hours becomes one row; the days
 * that differ keep their own.
 */
function foldHours(lines: string[]): string[] {
  const parsed = lines
    .map((l) => l.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => ({ day: m![1], time: m![2].replace(/\s*[–-]\s*/, '–').replace(/\s+/g, ' ') }));
  if (parsed.length !== lines.length || !parsed.length) return lines;   // an unexpected shape stays as it came
  const runs: { from: string; to: string; time: string }[] = [];
  for (const { day, time } of parsed) {
    const last = runs[runs.length - 1];
    const consecutive = last && DAYS.indexOf(day) === DAYS.indexOf(last.to) + 1;
    if (last && last.time === time && consecutive) last.to = day;
    else runs.push({ from: day, to: day, time });
  }
  return runs.map((r) => `${r.from === r.to ? r.from : `${r.from} to ${r.to}`} · ${r.time}`);
}

/** The address as you would read it aloud, without the protocol. */
const prettyUrl = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/$/, '').slice(0, 64);

/**
 * One picture, which removes itself if it does not arrive. A photo that 404s —
 * a provider's daily allowance run out — used to leave a coloured box on the
 * screen for as long as you looked at it (owner, 4 Sep 2026).
 */
function Hero({ uri, attribution }: { uri: string | null; attribution: string | null }) {
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || failed) return;
    const t = setTimeout(() => setFailed(true), 8000);
    return () => clearTimeout(t);
  }, [ready, failed, uri]);
  if (!uri || failed) return null;
  return (
    <View>
      <Image source={{ uri }} style={styles.hero} onError={() => setFailed(true)} onLoad={() => setReady(true)} accessibilityIgnoresInvertColors />
      {attribution ? <Text style={type.tiny}>{attribution}</Text> : null}
    </View>
  );
}

// Places whose grounds hold other places, and how far those grounds reach.
const GROUNDS: Record<string, number> = { 'theme-park': 1.2, zoo: 1.0, 'water-park': 0.8, aquarium: 0.4 };

/**
 * Who may ride, which is the first thing a parent asks and the last thing a
 * source gives you (owner, 4 Sep 2026: "they are useless without any age rating
 * or info on the ride"). Height in centimetres because that is how a park
 * writes it and how a family measures a child against a board.
 */
function whoCanRide(f: PlaceInsideItem['facts']): string | null {
  const cm = (m?: number) => (m ? `${Math.round(m * 100)} cm` : null);
  const bits = [
    f.minHeightM ? `${cm(f.minHeightM)} and over` : null,
    f.maxHeightM ? `up to ${cm(f.maxHeightM)}` : null,
    f.minAge ? `${f.minAge}+` : null,
    f.supervision ? f.supervision : null,
  ].filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

/** How a ride reads: 30 m high, 129 km/h, opened 2024. */
function rideLine(f: PlaceInsideItem['facts']): string {
  return [
    f.heightM ? `${Math.round(f.heightM)} m high` : null,
    f.speedKph ? `${Math.round(f.speedKph)} km/h` : null,
    f.lengthM ? `${Math.round(f.lengthM)} m long` : null,
    f.opened ? `opened ${f.opened}` : null,
    f.extraCharge ? 'extra charge' : null,
  ].filter(Boolean).join(' · ');
}

/**
 * What is inside this place. A theme park is not one thing to do, it is forty,
 * and those forty belong here rather than in the list beside the museum down
 * the road (owner, 4 Sep 2026). Everything shown is ours: the open map for the
 * rides and where they stand, Wikidata for how high and how fast, Wikipedia for
 * the paragraph — all licences that let us keep the answer.
 */
/**
 * What is inside this place, as its own tab. A theme park is not one thing to
 * do, it is forty, and those forty are why you opened it (owner, 4 Sep 2026).
 * Everything shown is ours: the open map for the rides and where they stand,
 * Wikidata for how high and how fast, the park's own pages for who may ride.
 */
function InsideList({ inside, busy, full = false }: { inside: PlaceInsideItem[] | null; busy: boolean; full?: boolean }) {
  const [open, setOpen] = useState(false);
  if (busy && !inside) return <IconText name="search">Looking up what is inside…</IconText>;
  if (!inside?.length) return null;

  const rides = inside.filter((i) => !['eat', 'shop', 'facility'].includes(i.kind));
  const eat = inside.filter((i) => i.kind === 'eat');
  const shown = full || open ? rides : rides.slice(0, 6);
  return (
    <View style={{ gap: full ? spacing.md : 6, ...(full ? {} : { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted }) }}>
      {!full ? <Text style={[type.tiny, { fontWeight: '700', color: colors.ink }]}>WHAT'S INSIDE</Text> : null}
      {shown.map((i) => {
        const f = i.facts;
        const who = whoCanRide(f);
        const facts = rideLine(f);
        return (
          <View key={i.itemRef} style={{ gap: 2 }}>
            <Text style={[full ? type.body : type.small, { color: colors.ink, fontWeight: '600' }]}>{i.name}</Text>
            <Text style={type.tiny}>{[i.kindLabel, facts].filter(Boolean).join(' · ')}</Text>
            {who ? <Row style={{ gap: 5, alignItems: 'flex-start' }}><View style={{ paddingTop: 2 }}><Icon name="children" size={13} color={colors.icon} /></View><Text style={[type.tiny, { flex: 1, color: colors.ink }]}>{who}</Text></Row> : null}
            {full && i.summary ? <Text style={type.tiny} numberOfLines={3}>{i.summary}</Text> : null}
          </View>
        );
      })}
      {full && !rides.some((r) => r.facts?.restrictionsChecked) ? <IconText name="search">Reading the park's own height restrictions…</IconText> : null}
      {rides.length > shown.length ? <Pressable onPress={() => setOpen(true)} accessibilityRole="button"><Text style={[type.tiny, { color: colors.accent, fontWeight: '700' }]}>All {rides.length}</Text></Pressable> : null}
      {eat.length ? <Text style={type.tiny}>{eat.length} place{eat.length === 1 ? '' : 's'} to eat inside.</Text> : null}
      <Text style={type.tiny}>{[...new Set(inside.flatMap((i) => i.attribution))].join(' · ')}</Text>
    </View>
  );
}

export function VenueDrawer({ item, baseLabel, onClose, onAdd, addLabel, addIcon, onShortlist, added, shortlisted, ours, capture, onVenue, gettingThere }: {
  item: BrowseItem | null;
  baseLabel?: string | null;
  onClose: () => void;
  onAdd?: (item: BrowseItem) => void;
  /**
   * What the primary action is called here. A drawer opened inside a trip is
   * adding to that day's plan; one opened from the home screen is starting a
   * trip that does not exist yet, and calling both "Add to plan" would be a
   * lie in one of the two places.
   */
  addLabel?: string;
  addIcon?: IconName;
  onShortlist?: (item: BrowseItem) => Promise<void>;
  added?: boolean;
  shortlisted?: boolean;
  /** The household's own side of the place (Places tab): status, history, notes — shown above the source's tabs. */
  ours?: React.ReactNode;
  /**
   * The one question worth asking the moment the place is open — did everyone
   * love it? — at the top of the overview, where the household's own record
   * sits behind the reviews tab (owner, 4 Sep 2026).
   */
  capture?: React.ReactNode;
  /** The source's record once fetched (the atlas uses it to learn a name it only held as an identifier). */
  onVenue?: (venue: Venue) => void;
  /** How you get to it — the station, its lines, the postcode — which now has a tab of its own. */
  gettingThere?: React.ReactNode;
}) {
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900;
  // Inside the shell's phone frame the Modal still portals to the whole window, so the sheet is pinned to the frame's size.
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const } : null;
  const [tab, setTab] = useState<Tab>('overview');
  // What is inside a place with grounds: the rides in a theme park, the animals
  // in a zoo (owner, 4 Sep 2026). Researched once from the open map, Wikidata
  // and Wikipedia, then ours — so this is a read, and it may go on the device.
  const [inside, setInside] = useState<PlaceInsideItem[] | null>(null);
  const [insideBusy, setInsideBusy] = useState(false);
  // Which places have grounds worth looking inside, decided from what the
  // search already said this place is.
  const insideOf = item?.experiences ?? [];
  const grounds = insideOf.reduce((r, e) => Math.max(r, GROUNDS[e] ?? 0), 0);
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


  // What is inside is fetched when the drawer opens, not when its tab is
  // tapped: a tab nobody can see is a tab nobody can tap.
  useEffect(() => {
    if (!item || !grounds || inside || insideBusy) return;
    setInsideBusy(true);
    let live = true;
    const ask = (): Promise<void> => api.placeInside({ ref: item.venueRef, lat: item.lat, lng: item.lng, experiences: insideOf.join(','), name: item.name, website: v?.website ?? item.website ?? undefined })
      .then(async (r) => {
        if (!live) return;
        setInside(r.items);
        // Who may ride is the park's own answer and takes a minute to read, so
        // the rides arrive first and the heights fill in underneath them.
        const missing = r.items.some((i) => !['eat', 'shop', 'facility'].includes(i.kind) && !i.facts?.restrictionsChecked);
        if (!r.askingWhoCanRide || !missing) return;
        for (let n = 0; n < 8 && live; n += 1) {
          await new Promise((res) => setTimeout(res, 8000));
          if (!live) return;
          const again = await api.placeInside({ ref: item.venueRef }).catch(() => null);
          if (!again?.items.length) continue;
          setInside(again.items);
          if (again.items.some((i) => i.facts?.restrictionsChecked)) return;
        }
      })
      .catch(() => { if (live) setInside([]); })
      .finally(() => { if (live) setInsideBusy(false); });
    void ask();
    return () => { live = false; };
  }, [item?.venueRef, grounds]);


  useEffect(() => {
    setTab('overview'); setVenue(undefined); setMenu(undefined); setError(null); setSaved(false); setOwnRecord(undefined); setInside(null);
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
    // An idea that has not been matched to a place yet has no identifier to
    // look up. That is not a reason to refuse to open: the card's own facts are
    // the drawer, and what is around it still loads (owner, 4 Sep 2026).
    if (!item.venueRef) { setVenue(null); return () => { live = false; }; }
    // Nothing to ask about a place that is ours. `wikidata:` is not a provider
    // and no source holds that identifier, so the round trip could only ever
    // come back empty — and empty is what the screen was reading as "no signal".
    if (item.venueRef.startsWith('wikidata:')) { setVenue(null); return () => { live = false; }; }
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

  // Menu and order are tabs of this drawer, so their state lives here and is
  // only fetched for somewhere you eat (owner, 4 Sep 2026).
  const ctl = useMenuOrder({
    venueRef: item?.venueRef ?? '',
    venueLabel: (item && item.name === item.venueRef && venue?.name ? venue.name : item?.name) ?? '',
    website: venue?.website ?? ownRecord?.website ?? item?.website ?? null,
    enabled: !!item && EATING.has(item.category),
  });

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
  /** Ours outright: the atlas researched it, and there is no provider behind it. */
  const weResearchedIt = source === 'atlas' || item.venueRef.startsWith('wikidata:');
  const sourceName = SOURCE_LABEL[source] ?? source;
  const photoUri = (p: { ref?: string; url?: string }, w: number) => p.url ?? (p.ref ? `${API_URL}/api/photos/google?name=${encodeURIComponent(p.ref)}&w=${w}` : null);

  const eating = EATING.has(item.category);
  const experiences = v?.experiences ?? item.experiences ?? [];
  const insideCount = (inside ?? []).filter((i) => !['eat', 'shop', 'facility'].includes(i.kind)).length;
  const insideLabel = experiences.includes('zoo') || experiences.includes('aquarium') ? 'Animals' : 'Rides';
  // Somewhere you eat leads with the two things you want while you are standing
  // in it, because only three or four tabs fit a phone without scrolling.
  const tabs: { value: Tab; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    ...(eating ? [
      { value: 'menu' as Tab, label: 'Menu' },
      { value: 'order' as Tab, label: `Order${ctl.order?.items.length ? ` (${ctl.order.items.length})` : ''}` },
    ] : []),
    // A park's rides are not an aside in the overview, they are why you are
    // reading it (owner, 4 Sep 2026: "put that in a separate tab please").
    ...(insideCount ? [{ value: 'inside' as Tab, label: `${insideLabel} (${insideCount})` }] : []),
    ...(gettingThere || mapsUrl ? [{ value: 'travel' as Tab, label: 'Getting there' }] : []),
    { value: 'reviews', label: `Reviews${reviews.length ? ` (${reviews.length})` : ''}` },
  ];
  const shown = tabs.some((t) => t.value === tab) ? tab : 'overview';

  const openNow = openState(v);
  const travelBits = [
    item.distanceKm != null ? `${item.distanceKm} km from ${baseLabel ?? 'base'}` : null,
    item.travelFromBaseMinutes != null ? `about ${item.travelFromBaseMinutes} min` : null,
    item.category !== 'event' && item.dwellMinutes > 0 ? `allow ${minutes(item.dwellMinutes)}` : null,
    item.startsAt ? clock(item.startsAt) : null,
  ].filter(Boolean);

  return (
    <>
    {ctl.staff ? <StaffSheet ctl={ctl} /> : null}
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.panel, wide ? styles.panelSide : styles.panelSheet, frameBox]}>

          {/* The head is fixed and short, so the tabs — and whichever one you
              came for — start above the fold (owner, 4 Sep 2026). */}
          <View style={styles.head}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.title}>{title}</Text>
                <Text style={type.small}>{typeLine(item)}{price ? ` · ${price}` : ''}{item.chain ? ` · chain${item.brand ? ` (${item.brand})` : ''}` : ''}</Text>
                <Row style={{ flexWrap: 'wrap', gap: spacing.sm }}>
                  {rating != null ? <Rating value={rating}>{ratingCount ? ` (${ratingCount.toLocaleString()})` : ''}</Rating> : null}
                  {openNow ? (
                    <IconText name={openNow.open === false ? 'full' : 'booked'} color={openNow.open === false ? colors.inkMuted : colors.like}>
                      <Text style={{ fontWeight: '700', color: colors.ink }}>{openNow.state}</Text>{openNow.detail ? ` · ${openNow.detail}` : ''}
                    </IconText>
                  ) : null}
                </Row>
              </View>
              <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close"><Icon name="close" size={22} color={colors.ink} /></Pressable>
            </Row>
            {onAdd || onShortlist ? (
              <Wrap>
                {onAdd ? <Button label={added ? 'In the plan' : addLabel ?? 'Add to plan'} icon={added ? 'keep' : addIcon ?? 'add'} iconFill={added} kind={added ? 'secondary' : 'primary'} onPress={() => onAdd(item)} disabled={added} /> : null}
                {onShortlist ? <Button label={saved || shortlisted ? 'Shortlisted' : 'Shortlist'} icon={saved || shortlisted ? 'shortlisted' : 'shortlist'} kind="secondary" onPress={async () => { await onShortlist(item); setSaved(true); }} disabled={saved || shortlisted} /> : null}
              </Wrap>
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
              {tabs.map((t) => <Chip key={t.value} label={t.label} selected={t.value === shown} onPress={() => setTab(t.value)} />)}
            </ScrollView>
            {venue === undefined ? <Text style={type.tiny}>Fetching from {sourceName}…</Text> : null}
            {error ? <Text style={[type.tiny, { color: colors.dislike }]}>{error}</Text> : null}
          </View>

          {shown === 'menu' ? (
            <View style={{ flex: 1 }}><MenuPanel ctl={ctl} onOrder={() => setTab('order')} /></View>
          ) : shown === 'order' ? (
            <View style={{ flex: 1 }}><OrderPanel ctl={ctl} onMenu={() => setTab('menu')} /></View>
          ) : (
            <ScrollView contentContainerStyle={{ gap: spacing.md, padding: spacing.lg }}>

              {shown === 'overview' ? (
                <View style={{ gap: spacing.sm }}>
                  {capture}
                  {v?.summary ?? item.summary ? <Text style={type.body}>{v?.summary ?? item.summary}</Text> : null}
                  {item.reasons.length ? <Wrap>{item.reasons.filter((r) => r.kind !== 'chain').map((r, i) => <Chip key={i} label={r.text} tone={r.kind === 'dislike' || r.kind === 'diet' ? 'dislike' : r.kind === 'note' ? 'neutral' : 'like'} />)}</Wrap> : null}
                  {v?.address ?? item.address ? <IconText name="address">{v?.address ?? item.address}</IconText> : null}
                  {venue === null && !error ? (
                    weResearchedIt ? (
                      // An atlas place has no provider record to be missing. It
                      // was researched by us from Wikidata, Wikipedia and
                      // Wikimedia, and everything on this screen is that
                      // research — so saying "no signal" would be inventing a
                      // network fault to explain the absence of something that
                      // was never going to be there, under a summary that
                      // loaded perfectly.
                      <IconText name="owned" color={colors.inkMuted}>Roam&#39;s own record — open data we hold outright, so it reads the same with no signal.</IconText>
                    ) : (
                      <IconText name="offline" color={colors.inkMuted}>No signal — showing what is saved on this device.</IconText>
                    )
                  ) : null}
                  {item.venueName ? <IconText name="ticket">At {item.venueName}</IconText> : null}
                  {/* Good for children carries the children's menu with it, and a
                      restaurant serving some vegetarian food is every restaurant:
                      only a genuinely vegetarian place is worth a word (owner,
                      4 Sep 2026). */}
                  {(() => {
                    const cuisines = (v?.cuisines ?? item.cuisines ?? []).map((c) => c.toLowerCase());
                    const veggie = cuisines.some((c) => /vegetarian|vegan/.test(c));
                    const good = [(v?.goodForChildren ?? item.goodForChildren) ? 'children' : null, veggie ? 'vegetarians' : null].filter(Boolean);
                    if (good.length) return <IconText name="children">Good for {good.join(' and ')}</IconText>;
                    return (v?.goodForChildren ?? item.goodForChildren) === false ? <IconText name="children" color={colors.inkMuted}>Not noted as good for children</IconText> : null;
                  })()}
                  {item.reservable != null ? <IconText name="phone">{item.reservable ? 'Takes bookings' : 'Walk-in only'}</IconText> : null}
                  {item.justification ? <Text style={type.small}>"{item.justification}"</Text> : null}
                  <Wrap>
                    {website ? <Button label="Website" icon="external" kind="ghost" onPress={() => Linking.openURL(website)} /> : null}
                    {externalUrl && !mapsUrl ? <Button label={item.category === 'event' ? 'Tickets' : `On ${sourceName}`} kind="ghost" onPress={() => Linking.openURL(externalUrl)} /> : null}
                  </Wrap>

                  {/* Hours and photos lost their tabs and live here (owner, 4 Sep 2026). */}
                  <View style={{ gap: 2, marginTop: spacing.sm }}>
                    <Text style={type.h3}>Opening hours</Text>
                    {hours.length ? foldHours(hours).map((h, i) => <Text key={i} style={type.small}>{h}</Text>)
                      : ownRecord?.openingHours ? (
                        <>
                          <Text style={type.small}>{ownRecord.openingHours}</Text>
                          <Text style={type.tiny}>Roam's own record, from {ownRecord.provenance?.opening_hours === 'site' ? 'their own website' : 'OpenStreetMap'} — kept, so it is here with no signal.</Text>
                        </>
                      ) : <Text style={type.small}>{venue === undefined ? '' : `No opening hours from ${sourceName}.`}</Text>}
                  </View>

                  {photos.length ? (
                    <View style={{ gap: spacing.sm }}>
                      {photos.map((p, i) => <Hero key={i} uri={photoUri(p, 800)} attribution={p.attribution ?? null} />)}
                    </View>
                  ) : null}


                </View>
              ) : null}

              {shown === 'travel' ? (
                <View style={{ gap: spacing.sm }}>
                  {v?.address ?? item.address ? <IconText name="address">{v?.address ?? item.address}</IconText> : null}
                  {travelBits.length ? <Text style={type.small}>{travelBits.join(' · ')}</Text> : null}
                  {gettingThere}
                  <Wrap>
                    {mapsUrl ? <Button label="Open in Google Maps" icon="map" kind="secondary" onPress={() => Linking.openURL(mapsUrl)} /> : null}
                  </Wrap>
                </View>
              ) : null}

              {shown === 'inside' ? <InsideList inside={inside} busy={insideBusy} full /> : null}

              {shown === 'reviews' ? (
                <View style={{ gap: spacing.sm }}>
                  {/* Ours first: what we ate and what we made of it, then the
                      strangers' (owner, 4 Sep 2026). */}
                  {eating ? <PastMeals ctl={ctl} /> : null}
                  {ours}
                  {reviews.length ? <Text style={type.h3}>What other people say</Text> : null}
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

              <Text style={type.tiny}>{v?.attribution ?? item.attribution ?? ''}</Text>
            </ScrollView>
          )}
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
  head: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  panelSide: { width: 460, maxWidth: '100%', height: '100%', borderLeftWidth: 1, borderLeftColor: colors.line },
  panelSheet: { width: '100%', height: '100%' },
  close: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  hero: { width: '100%', height: 220, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  review: { gap: 2, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
});

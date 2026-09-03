import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Linking, Modal, PanResponder, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, BrowseItem, Endpoint, HouseholdResponse, Journey, JourneyLeg, JourneyStop, LegMode, Place, ShortlistItem, ShortlistStatus, TripDay, TripDetail, Venue } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, StatusLine, Wrap, minutes as fmtMinutes } from './ui';
import { CategoryIcon, Icon, IconName } from './Icon';
import { MapLine, MapPin, MapView } from './MapView';
import { VenueDrawer } from './VenueDrawer';
import { DirectionsDrawer, LegPoint, MODE_LABEL } from './DirectionsDrawer';
import { PlacePicker } from './PlacePicker';

/**
 * The shortlist as the working surface, and the day that comes out of it
 * (owner, 3 Sep 2026). List and Map are two views of the same ordered list.
 * Each place carries a booking status; swiping is the quick way to set it,
 * opening the place is the thorough way. Getting around is one choice at the
 * top. Between rows still in the running, one pill: the quickest way and its
 * minutes; tap it for the others. When nothing is left to call and the day
 * fits, Save writes it to the trip as stops, and the trip shows the same legs
 * with directions on each.
 */

const RUNNING: ShortlistStatus[] = ['to_call', 'booked', 'no_booking'];
const STATUS: Record<ShortlistStatus, { label: string; icon: IconName; tone: 'like' | 'dislike' | 'accent' | 'neutral' | 'allergen' }> = {
  to_call: { label: 'To call', icon: 'phone', tone: 'dislike' },
  booked: { label: 'Booked', icon: 'booked', tone: 'like' },
  no_booking: { label: 'No booking needed', icon: 'check', tone: 'accent' },
  full: { label: 'Fully booked', icon: 'full', tone: 'allergen' },
  set_aside: { label: 'Set aside', icon: 'close', tone: 'neutral' },
};
const isRunning = (s: ShortlistStatus) => RUNNING.includes(s);
const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

function StatusChip({ status, detail }: { status: ShortlistStatus; detail?: string | null }) {
  const s = STATUS[status];
  return <Chip label={detail ? `${s.label} · ${detail}` : s.label} icon={s.icon} tone={s.tone} />;
}

/** One leg between two places: the chosen way and its minutes; the rest behind a tap (never with the car). */
export function LegPill({ leg, hasCar, onPress, hint }: { leg: JourneyLeg; hasCar: boolean; onPress?: () => void; hint?: string | null }) {
  const options = Object.keys(leg.options).length;
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={styles.legRow} accessibilityRole={onPress ? 'button' : undefined}>
      <View style={styles.legPill}><Icon name={leg.mode} size={13} color={colors.ink} /><Text style={styles.legText}>{fmtMinutes(leg.minutes)}</Text></View>
      {hint ? <Text style={type.tiny}>{hint}</Text> : null}
      {onPress && !hasCar && options > 1 ? <Row style={{ gap: 2 }}><Text style={type.tiny}>{leg.estimated ? 'estimated' : 'quickest'}</Text><Icon name="expand" size={12} color={colors.inkFaint} /></Row> : leg.estimated ? <Text style={type.tiny}>estimated</Text> : null}
      {onPress && hasCar ? <Row style={{ gap: 2 }}><Text style={type.tiny}>directions</Text><Icon name="more" size={12} color={colors.inkFaint} /></Row> : null}
    </Pressable>
  );
}

/** The three ways for a leg (no car): quickest first, the chosen one marked. */
function LegModal({ title, hint, leg, onPick, onClose }: { title: string; hint?: string | null; leg: JourneyLeg; onPick: (m: LegMode) => Promise<void>; onClose: () => void }) {
  const entries = (Object.entries(leg.options) as [LegMode, { minutes: number; estimated: boolean }][]).sort((a, b) => a[1].minutes - b[1].minutes);
  const [busy, setBusy] = useState(false);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.modalWrap} pointerEvents="box-none">
        <View style={styles.modal}>
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}><Text style={type.h3}>{title}</Text>{hint ? <Text style={type.tiny}>{hint}</Text> : null}</View>
            <Pressable onPress={onClose} style={styles.close}><Icon name="close" size={20} color={colors.inkMuted} /></Pressable>
          </Row>
          {entries.map(([m, o], i) => (
            <Pressable key={m} onPress={async () => { setBusy(true); try { await onPick(m); onClose(); } finally { setBusy(false); } }} disabled={busy} style={[styles.opt, m === leg.mode && styles.optOn]}>
              <View style={styles.optIcon}><Icon name={m} size={18} color={colors.ink} /></View>
              <View style={{ flex: 1 }}><Text style={[type.body, { fontWeight: '700' }]}>{MODE_LABEL[m]}</Text><Text style={type.tiny}>{i === 0 ? 'Quickest' : ''}{m === 'taxi' ? `${i === 0 ? ' · ' : ''}includes the wait` : ''}{o.estimated ? `${i === 0 || m === 'taxi' ? ' · ' : ''}estimated` : ''}</Text></View>
              <Text style={[type.h3, { fontSize: 16 }]}>{fmtMinutes(o.minutes)}</Text>
            </Pressable>
          ))}
          <Row><Icon name="info" size={13} color={colors.inkFaint} /><Text style={[type.tiny, { flex: 1 }]}>Step-by-step directions open from the trip once the day is saved.</Text></Row>
        </View>
      </View>
    </Modal>
  );
}

/** Swipe right to mark Booked, left to mark Fully booked; a tap still opens the row. */
function SwipeRow({ children, onRight, onLeft, enabled = true }: { children: React.ReactNode; onRight: () => void; onLeft: () => void; enabled?: boolean }) {
  const x = useRef(new Animated.Value(0)).current;
  const latest = useRef({ onRight, onLeft, enabled });
  latest.current = { onRight, onLeft, enabled };
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => latest.current.enabled && Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
    onPanResponderMove: (_, g) => x.setValue(Math.max(-150, Math.min(150, g.dx))),
    onPanResponderRelease: (_, g) => {
      const fire = g.dx > 90 ? latest.current.onRight : g.dx < -90 ? latest.current.onLeft : null;
      Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 4 }).start();
      if (fire) fire();
    },
    onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
  })).current;
  const rightOpacity = x.interpolate({ inputRange: [0, 40, 90], outputRange: [0, 0.5, 1], extrapolate: 'clamp' });
  const leftOpacity = x.interpolate({ inputRange: [-90, -40, 0], outputRange: [1, 0.5, 0], extrapolate: 'clamp' });
  return (
    <View style={{ overflow: 'hidden' }}>
      <Animated.View style={[styles.under, styles.underL, { opacity: rightOpacity }]}><Icon name="booked" size={16} color="#fff" /><Text style={styles.underText}>Booked</Text></Animated.View>
      <Animated.View style={[styles.under, styles.underR, { opacity: leftOpacity }]}><Text style={styles.underText}>Fully booked</Text><Icon name="full" size={16} color="#fff" /></Animated.View>
      <Animated.View style={{ transform: [{ translateX: x }], backgroundColor: colors.surface }} {...pan.panHandlers}>{children}</Animated.View>
    </View>
  );
}

/** The booking control inside a place's drawer: status, time, party, reference, length there, a call button. */
function BookingControl({ trip, item, venue, dwell, onChanged, onSetAside }: { trip: TripDetail; item: ShortlistItem; venue: Venue | null; dwell: number; onChanged: () => Promise<void>; onSetAside: () => Promise<void> }) {
  const [status, setStatus] = useState<ShortlistStatus>(item.status);
  const [time, setTime] = useState(item.bookedTime ?? '');
  const [party, setParty] = useState(item.partySize ?? '');
  const [ref, setRef] = useState(item.bookingRef ?? '');
  const [note, setNote] = useState(item.statusNote ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (patch: Parameters<typeof api.updateShortlist>[2]) => { setBusy(true); try { await api.updateShortlist(trip.trip.id, item.id, patch); await onChanged(); } finally { setBusy(false); } };
  const phone = venue?.phone ?? null;
  const validTime = /^\d{1,2}:\d{2}$/.test(time.trim());
  return (
    <View style={styles.booking}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={[type.tiny, { letterSpacing: 0.4 }]}>BOOKING</Text>
        {phone ? <Button label={phone} icon="phone" kind="secondary" onPress={() => Linking.openURL(`tel:${phone.replace(/\s+/g, '')}`)} /> : <Text style={type.tiny}>{venue === null ? 'No phone number from the source.' : 'Fetching the number…'}</Text>}
      </Row>
      <Segmented
        value={status === 'set_aside' ? 'to_call' : status}
        options={[{ value: 'to_call', label: 'To call' }, { value: 'booked', label: 'Booked' }, { value: 'no_booking', label: 'No booking' }, { value: 'full', label: 'Full' }]}
        onChange={(v) => { setStatus(v); save({ status: v, bookedTime: v === 'booked' && validTime ? time.trim() : null }); }}
      />
      {status === 'booked' ? (
        <>
          <Row>
            <View style={[styles.field, { flex: 1 }]}><Icon name="hours" size={14} color={colors.inkFaint} /><Text style={type.tiny}>Time</Text><TextInput value={time} onChangeText={setTime} placeholder="17:30" placeholderTextColor={colors.inkFaint} style={styles.fieldInput} keyboardType="numbers-and-punctuation" onEndEditing={() => { if (validTime) save({ bookedTime: time.trim() }); }} onBlur={() => { if (validTime) save({ bookedTime: time.trim() }); }} /></View>
            <View style={[styles.field, { flex: 1 }]}><Icon name="household" size={14} color={colors.inkFaint} /><Text style={type.tiny}>For</Text><TextInput value={party} onChangeText={setParty} placeholder="2 + 1" placeholderTextColor={colors.inkFaint} style={styles.fieldInput} onBlur={() => save({ partySize: party })} /></View>
          </Row>
          <View style={styles.field}><Icon name="edit" size={14} color={colors.inkFaint} /><Text style={type.tiny}>Ref</Text><TextInput value={ref} onChangeText={setRef} placeholder="Reference or the name it's under" placeholderTextColor={colors.inkFaint} style={styles.fieldInput} onBlur={() => save({ bookingRef: ref })} /></View>
          <Text style={type.tiny}>{validTime ? `${time.trim()} becomes a fixed point. The legs either side are worked out from it.` : 'Add the time: it becomes a fixed point the rest of the day is worked out around.'}</Text>
        </>
      ) : null}
      {status === 'full' ? <View style={styles.field}><Icon name="edit" size={14} color={colors.inkFaint} /><TextInput value={note} onChangeText={setNote} placeholder="Why (fully booked Saturday, closed…)" placeholderTextColor={colors.inkFaint} style={styles.fieldInput} onBlur={() => save({ statusNote: note })} /></View> : null}
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.small}>Time there</Text>
        <Row>
          <Chip icon="minus" label="15" onPress={() => save({ dwellMinutes: Math.max(15, dwell - 15) })} />
          <Text style={[type.h3, { minWidth: 56, textAlign: 'center' }]}>{fmtMinutes(dwell)}</Text>
          <Chip icon="add" label="15" onPress={() => save({ dwellMinutes: dwell + 15 })} />
        </Row>
      </Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <Button label={item.status === 'set_aside' ? 'Back in the running' : 'Set aside'} icon={item.status === 'set_aside' ? 'check' : 'close'} kind="ghost" onPress={onSetAside} disabled={busy} />
        {busy ? <Text style={type.tiny}>Saving…</Text> : null}
      </Row>
    </View>
  );
}

/** Where the day starts or ends: home by default, where you're staying, or anywhere you name. */
function EndpointModal({ which, journey, trip, day, onClose, onChanged }: { which: 'start' | 'end'; journey: Journey; trip: TripDetail; day: TripDay; onClose: () => void; onChanged: () => Promise<void> }) {
  const current = which === 'start' ? journey.start : journey.end;
  const [busy, setBusy] = useState(false);
  const [other, setOther] = useState(false);
  const set = async (p: Endpoint | Place | null) => {
    setBusy(true);
    try { await api.updateDay(trip.trip.id, day.id, which === 'start' ? { startPoint: p } : { endPoint: p }); await onChanged(); onClose(); } finally { setBusy(false); }
  };
  const same = (a: Endpoint | null) => !!a && a.lat === current.lat && a.lng === current.lng;
  const near = { label: current.label, lat: current.lat, lng: current.lng };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.modalWrap} pointerEvents="box-none">
        <View style={styles.modal}>
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}><Text style={type.h3}>{which === 'start' ? 'Start the day from' : 'End the day at'}</Text><Text style={type.tiny}>Now: {current.label}. Travel times are worked out from here.</Text></View>
            <Pressable onPress={onClose} style={styles.close}><Icon name="close" size={20} color={colors.inkMuted} /></Pressable>
          </Row>
          {journey.choices.home ? (
            <Pressable onPress={() => set(journey.choices.home)} disabled={busy} style={[styles.opt, same(journey.choices.home) && styles.optOn]}>
              <View style={styles.optIcon}><Icon name="home" size={18} color={colors.ink} /></View>
              <View style={{ flex: 1 }}><Text style={[type.body, { fontWeight: '700' }]}>Home</Text><Text style={type.tiny}>The usual</Text></View>
            </Pressable>
          ) : <Text style={type.small}>No home address yet. Set it in Household and every trip will start and end there.</Text>}
          {journey.choices.base ? (
            <Pressable onPress={() => set(journey.choices.base)} disabled={busy} style={[styles.opt, same(journey.choices.base) && styles.optOn]}>
              <View style={styles.optIcon}><Icon name="hotel" size={18} color={colors.ink} /></View>
              <View style={{ flex: 1 }}><Text style={[type.body, { fontWeight: '700' }]} numberOfLines={1}>{journey.choices.base.label}</Text><Text style={type.tiny}>Where you're staying</Text></View>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setOther((v) => !v)} disabled={busy} style={[styles.opt, current.kind === 'custom' && styles.optOn]}>
            <View style={styles.optIcon}><Icon name="address" size={18} color={colors.ink} /></View>
            <View style={{ flex: 1 }}><Text style={[type.body, { fontWeight: '700' }]}>Somewhere else</Text><Text style={type.tiny}>{current.kind === 'custom' ? current.label : 'A station, a friend\'s, a car park'}</Text></View>
          </Pressable>
          {other ? <PlacePicker value={null} onPick={(p) => { if (p) set(p); }} near={near} placeholder="Search a place or address" /> : null}
          <Button label="Back to the usual" kind="ghost" onPress={() => set(null)} disabled={busy} />
        </View>
      </View>
    </Modal>
  );
}

const asBrowseItem = (s: ShortlistItem): BrowseItem => ({
  id: s.id, venueRef: s.venueRef, name: s.name, category: s.category ?? 'attraction', lat: s.lat ?? 0, lng: s.lng ?? 0,
  dwellMinutes: s.dwellMinutes ?? 0, reasons: [], justification: null, startsAt: null, endsAt: null, pinned: false,
  cuisines: (s.venue?.cuisines as string[]) ?? [], experiences: (s.venue?.experiences as string[]) ?? [], rating: s.venue?.rating ?? null, ratingCount: s.venue?.ratingCount ?? null,
  priceLevel: s.venue?.priceLevel ?? null, photos: s.venue?.photos ?? [], address: s.venue?.address ?? null, website: s.venue?.website ?? null, openingHours: s.venue?.openingHours ?? null,
  source: s.venueRef.split(':')[0],
});

// ---------------------------------------------------------------------------
// The shortlist
// ---------------------------------------------------------------------------

export function ShortlistJourney({ d, day, household, onChanged, onSaved, onFind, wide }: {
  d: TripDetail; day: TripDay; household: HouseholdResponse | null; onChanged: () => Promise<void>; onSaved: () => Promise<void>; onFind: () => void; wide: boolean;
}) {
  const { trip, shortlist } = d;
  const [view, setView] = useState<'list' | 'map'>('list');
  const [journey, setJourney] = useState<Journey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [legFor, setLegFor] = useState<{ stop: JourneyStop | null; leg: JourneyLeg; title: string; hint: string | null } | null>(null);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [endpointFor, setEndpointFor] = useState<'start' | 'end' | null>(null);
  const [leave, setLeave] = useState(day.startTime ? clock24(day.startTime) : '');
  const [homeBy, setHomeBy] = useState(day.endTime ? clock24(day.endTime) : '');

  const refresh = useCallback(async () => {
    try { setJourney(await api.journey(trip.id, { dayId: day.id })); setError(null); } catch (e: any) { setError(e.message); }
  }, [trip.id, day.id]);
  useEffect(() => { refresh(); }, [refresh, shortlist, trip.hasCar, day.startTime, day.endTime]);
  useEffect(() => { setLeave(day.startTime ? clock24(day.startTime) : ''); setHomeBy(day.endTime ? clock24(day.endTime) : ''); }, [day.startTime, day.endTime]);

  const byId = useMemo(() => new Map(shortlist.map((s) => [s.id, s])), [shortlist]);
  const hasCar = Boolean(trip.hasCar);
  const stops = journey?.stops ?? [];
  const others = (journey?.others ?? []).map((o) => ({ ...o, item: byId.get(o.id) }));
  const openItem = openId ? byId.get(openId) ?? null : null;
  const act = async (fn: () => Promise<any>) => { setBusy(true); setError(null); try { await fn(); await onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const setStatus = (id: string, status: ShortlistStatus, extra: Record<string, any> = {}) => act(() => api.updateShortlist(trip.id, id, { status, ...extra }));
  const move = (index: number, dir: -1 | 1) => {
    const ids = stops.map((s) => s.id);
    const j = index + dir; if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    return act(() => api.reorderShortlist(trip.id, [...ids, ...others.map((o) => o.id)]));
  };
  const saveTimes = () => {
    const ok = (t: string) => /^\d{1,2}:\d{2}$/.test(t.trim());
    if (ok(leave) && ok(homeBy)) act(() => api.updateDay(trip.id, day.id, { startTime: leave.trim(), endTime: homeBy.trim() }));
  };
  const saving = useRef(false);
  const save = async () => {
    if (!journey || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { await api.saveJourney(trip.id, day.id); await onSaved(); } catch (e: any) { setError(e.message); } finally { saving.current = false; setBusy(false); }
  };

  // The map: numbered pins in the journey's order, then the places not in the running; the route, or the legs either side of the chosen place.
  const selected = stops.find((s) => s.id === selectedId) ?? null;
  const selIndex = selected ? stops.indexOf(selected) : -1;
  const pins: MapPin[] = [];
  const home = journey?.start;
  const endPt = journey?.end;
  const sameEnds = !!home && !!endPt && home.lat === endPt.lat && home.lng === endPt.lng;
  if (home) pins.push({ id: 'home', lat: home.lat, lng: home.lng, label: home.label, tone: 'home', number: home.kind === 'home' ? 'H' : 'S', onPress: () => setEndpointFor('start') });
  if (endPt && !sameEnds) pins.push({ id: 'end', lat: endPt.lat, lng: endPt.lng, label: endPt.label, tone: 'home', number: endPt.kind === 'home' ? 'H' : 'E', onPress: () => setEndpointFor('end') });
  stops.forEach((s, i) => { if (s.lat != null && s.lng != null) pins.push({ id: s.id, lat: s.lat, lng: s.lng, label: `${i + 1} · ${s.name}`, tone: s.fixed ? 'base' : 'day', number: i + 1, onPress: () => setSelectedId(s.id) }); });
  others.forEach((o, i) => { const it = o.item; if (it?.lat != null && it?.lng != null) pins.push({ id: o.id, lat: it.lat, lng: it.lng, label: `${o.name} · ${STATUS[o.status].label}`, tone: o.status === 'full' ? 'full' : 'aside', number: stops.length + i + 1, onPress: () => setOpenId(o.id) }); });
  const pt = (s: JourneyStop | null | undefined) => (s && s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null);
  const lines: MapLine[] = [];
  if (home && stops.length) {
    if (selected) {
      const prev = selIndex > 0 ? pt(stops[selIndex - 1]) : home;
      const next = selIndex < stops.length - 1 ? pt(stops[selIndex + 1]) : (endPt ?? home);
      const me = pt(selected);
      if (prev && me) lines.push({ id: 'in', points: [prev, me], dashed: true });
      if (me && next) lines.push({ id: 'out', points: [me, next] });
    } else {
      const route = [home, ...stops.map(pt).filter(Boolean) as { lat: number; lng: number }[], endPt ?? home];
      lines.push({ id: 'route', points: route, color: colors.accent });
    }
  }

  const legModal = legFor ? <LegModal title={legFor.title} hint={legFor.hint} leg={legFor.leg} onClose={() => setLegFor(null)} onPick={async (m) => { if (legFor.stop) await api.updateShortlist(trip.id, legFor.stop.id, { legMode: m }); await onChanged(); }} /> : null;
  const legTap = (s: JourneyStop | null, leg: JourneyLeg, toLabel: string, hint: string | null) => (hasCar ? undefined : () => setLegFor({ stop: s, leg, title: `${leg.from.label} → ${toLabel}`, hint }));

  const modeBar = (
    <View style={styles.modebar}>
      <Row><Icon name="trips" size={16} color={colors.inkMuted} /><Text style={type.small}>Getting around</Text></Row>
      <Row>
        <Chip label="Car" icon="driving" selected={hasCar} onPress={() => { if (!hasCar) act(() => api.updateTripV2(trip.id, { hasCar: true, travelMode: 'driving' })); }} />
        <Chip label="No car" icon="walking" selected={!hasCar} onPress={() => { if (hasCar) act(() => api.updateTripV2(trip.id, { hasCar: false, travelMode: 'transit' })); }} />
      </Row>
    </View>
  );
  const timesBar = (
    <View style={styles.modebar}>
      <Row><Icon name="hours" size={16} color={colors.inkMuted} /><Text style={type.small}>Leave {journey?.home.label === 'Home' ? 'home' : 'base'}</Text><TextInput value={leave} onChangeText={setLeave} onBlur={saveTimes} style={styles.timeInput} placeholder="10:00" placeholderTextColor={colors.inkFaint} /></Row>
      <Row><Text style={type.small}>home by</Text><TextInput value={homeBy} onChangeText={setHomeBy} onBlur={saveTimes} style={styles.timeInput} placeholder="20:00" placeholderTextColor={colors.inkFaint} /></Row>
    </View>
  );
  const banner = journey ? (
    journey.blockers.length ? (
      <View style={styles.warn}><Icon name="hours" size={16} color={colors.overrun} /><View style={{ flex: 1 }}>{journey.blockers.map((b, i) => <Text key={i} style={[type.small, { color: colors.overrun, fontWeight: '600' }]}>{b.text}</Text>)}</View></View>
    ) : stops.length ? (
      <View style={styles.ok}><Icon name="booked" size={16} color={colors.accent} /><Text style={[type.small, { color: colors.accent, fontWeight: '600', flex: 1 }]}>Everything booked. Fits: {journey.home.label === 'Home' ? 'home' : 'back'} {journey.homeAt}, {fmtMinutes(journey.spareMinutes)} spare.{journey.estimated ? ' Travel times are estimates.' : ''}</Text></View>
    ) : null
  ) : null;

  const rowMeta = (s: JourneyStop) => {
    const bits = [s.category, fmtMinutes(s.dwellMinutes)].filter(Boolean);
    return bits.join(' · ');
  };

  const list = (
    <Card style={{ paddingVertical: 2, paddingHorizontal: spacing.md, gap: 0 }}>
      {journey && home ? (
        <Pressable onPress={() => setEndpointFor('start')} style={styles.row} accessibilityRole="button"><Text style={styles.time}>{journey.startAt}</Text><View style={[styles.num, { backgroundColor: colors.rating }]}><Icon name="home" size={13} color="#fff" /></View><View style={{ flex: 1 }}><Text style={type.h3} numberOfLines={1}>Leave {home.kind === 'home' ? 'home' : home.label.split(',')[0]}</Text><Text style={type.tiny}>{home.kind === 'home' ? 'Tap to start somewhere else' : home.kind === 'base' ? 'Where you\'re staying · tap to change' : 'Tap to change'}</Text></View><Icon name="edit" size={14} color={colors.inkFaint} /></Pressable>
      ) : null}
      {stops.map((s, i) => (
        <View key={s.id}>
          <LegPill leg={s.legIn} hasCar={hasCar} onPress={legTap(s, s.legIn, s.name, `Arrive ${s.arriveAt}${s.fixed ? `, booked for ${s.fixedAt}` : ''}.`)} hint={s.spareBefore != null && s.spareBefore > 0 ? `${s.spareBefore} min spare before ${s.fixedAt}` : s.lateBy ? `${s.lateBy} min late for ${s.fixedAt}` : null} />
          <SwipeRow enabled={!busy} onRight={() => { setStatus(s.id, 'booked'); setOpenId(s.id); }} onLeft={() => setStatus(s.id, 'full')}>
            <Pressable onPress={() => setOpenId(s.id)} style={styles.row} accessibilityRole="button">
              <View style={styles.grip}>
                <Pressable onPress={() => move(i, -1)} disabled={i === 0 || busy} hitSlop={6}><Icon name="collapse" size={14} color={i === 0 ? colors.line : colors.inkFaint} /></Pressable>
                <Pressable onPress={() => move(i, 1)} disabled={i === stops.length - 1 || busy} hitSlop={6}><Icon name="expand" size={14} color={i === stops.length - 1 ? colors.line : colors.inkFaint} /></Pressable>
              </View>
              <Text style={[styles.time, s.fixed && { color: colors.ink, fontWeight: '700' }]}>{s.arriveAt}</Text>
              <View style={[styles.num, s.fixed && { backgroundColor: colors.ink }]}><Text style={styles.numText}>{i + 1}</Text></View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.h3} numberOfLines={1}>{s.name}</Text>
                <Wrap style={{ gap: 4 }}><Text style={type.tiny}>{rowMeta(s)}</Text><StatusChip status={s.status} detail={s.status === 'booked' && s.bookedTime ? s.bookedTime : null} /></Wrap>
              </View>
              <Pressable onPress={() => setOpenId(s.id)} style={[styles.tel, s.status !== 'to_call' && styles.telOff]} accessibilityLabel="Open"><Icon name={s.status === 'to_call' ? 'phone' : s.category === 'event' ? 'ticket' : 'more'} size={16} color={s.status === 'to_call' ? colors.accent : colors.inkFaint} /></Pressable>
            </Pressable>
          </SwipeRow>
        </View>
      ))}
      {journey && home && endPt ? (
        <>
          {journey.legHome ? <LegPill leg={journey.legHome} hasCar={hasCar} onPress={legTap(null, journey.legHome, endPt.label, `Back by ${journey.endAt}.`)} /> : null}
          <Pressable onPress={() => setEndpointFor('end')} style={styles.row} accessibilityRole="button"><Text style={[styles.time, journey.overBy ? { color: colors.overrun, fontWeight: '700' } : null]}>{stops.length ? journey.homeAt : ''}</Text><View style={[styles.num, { backgroundColor: colors.rating }]}><Icon name="home" size={13} color="#fff" /></View><View style={{ flex: 1 }}><Text style={type.h3} numberOfLines={1}>{endPt.kind === 'home' ? 'Home' : endPt.label.split(',')[0]}</Text><Text style={type.tiny}>{stops.length ? `by ${journey.endAt}` : 'Tap to end somewhere else'}</Text></View><Icon name="edit" size={14} color={colors.inkFaint} /></Pressable>
        </>
      ) : null}
      {journey && !stops.length ? (
        <View style={{ paddingVertical: spacing.md, gap: spacing.sm }}>
          <Text style={type.small}>Nothing in the running for {fmtDate(day.date)} yet.</Text>
          <Button label="Find places to shortlist" icon="search" kind="secondary" onPress={onFind} />
        </View>
      ) : null}
    </Card>
  );

  // The card under the map: the day in order around the chosen place.
  const prevStop = selIndex > 0 ? stops[selIndex - 1] : null;
  const nextStop = selIndex >= 0 && selIndex < stops.length - 1 ? stops[selIndex + 1] : null;
  const mapCard = selected && journey && home ? (
    <Card style={{ gap: 2 }}>
      <View style={styles.tlStop}>
        <View style={[styles.num, { backgroundColor: prevStop ? (prevStop.fixed ? colors.ink : colors.accent) : colors.rating }]}>{prevStop ? <Text style={styles.numText}>{selIndex}</Text> : <Icon name="home" size={13} color="#fff" />}</View>
        <View style={{ flex: 1 }}><Text style={[type.body, { fontWeight: '700' }]}>{prevStop ? prevStop.name : home.label}</Text><Text style={type.tiny}>Leave by <Text style={{ color: colors.ink, fontWeight: '700' }}>{selected.legIn.leaveBy}</Text></Text></View>
      </View>
      <View style={styles.tlLeg}><View style={[styles.tlBar, { backgroundColor: colors.want }]} /><LegPill leg={selected.legIn} hasCar={hasCar} onPress={legTap(selected, selected.legIn, selected.name, null)} /></View>
      <View style={styles.tlStop}>
        <View style={[styles.num, { backgroundColor: colors.want }]}><Text style={styles.numText}>{selIndex + 1}</Text></View>
        <View style={{ flex: 1, gap: 3 }}>
          <Row><Text style={[type.body, { fontWeight: '700', flexShrink: 1 }]}>{selected.name}</Text><StatusChip status={selected.status} detail={selected.bookedTime} /></Row>
          <Text style={type.tiny}>{rowMeta(selected)}</Text>
          <View style={styles.win}><Icon name="hours" size={13} color={colors.accent} /><Text style={[type.tiny, { color: colors.accent, fontWeight: '700' }]}>{selected.arriveAt} – {selected.mustLeaveBy} · {fmtMinutes(Math.max(0, selected.windowMinutes))} here{selected.windowMinutes < selected.dwellMinutes ? ` (you wanted ${fmtMinutes(selected.dwellMinutes)})` : ''}</Text></View>
        </View>
        <Pressable onPress={() => setOpenId(selected.id)} style={styles.tel}><Icon name={selected.status === 'to_call' ? 'phone' : 'more'} size={16} color={colors.accent} /></Pressable>
      </View>
      {nextStop || journey.legHome ? (
        <>
          <View style={styles.tlLeg}><View style={[styles.tlBar, { backgroundColor: colors.line }]} />{nextStop ? <LegPill leg={nextStop.legIn} hasCar={hasCar} onPress={legTap(nextStop, nextStop.legIn, nextStop.name, null)} hint={`leave ${selected.name.split(' ')[0]} by ${selected.mustLeaveBy}`} /> : journey.legHome ? <LegPill leg={journey.legHome} hasCar={hasCar} onPress={legTap(null, journey.legHome, (endPt ?? home).label, null)} hint={`leave by ${selected.mustLeaveBy}`} /> : null}</View>
          <View style={styles.tlStop}>
            <View style={[styles.num, { backgroundColor: nextStop ? (nextStop.fixed ? colors.ink : colors.accent) : colors.rating }]}>{nextStop ? <Text style={styles.numText}>{selIndex + 2}</Text> : <Icon name="home" size={13} color="#fff" />}</View>
            <View style={{ flex: 1 }}><Text style={[type.body, { fontWeight: '700' }]}>{nextStop ? nextStop.name : (endPt ?? home).label}</Text><Text style={type.tiny}>{nextStop ? (nextStop.fixed ? `Booked for ${nextStop.fixedAt}` : `Arrive ${nextStop.arriveAt}`) : `By ${journey.endAt}`}</Text></View>
          </View>
        </>
      ) : null}
    </Card>
  ) : journey ? <Text style={[type.tiny, { textAlign: 'center' }]}>Tap a pin to see how it sits between the fixed points of the day.</Text> : null;

  const map = (
    <View style={{ gap: spacing.sm }}>
      <MapView pins={pins} lines={lines} height={wide ? 460 : 300} focusId={selectedId} />
      {mapCard}
    </View>
  );

  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}><Text style={type.h2}>Shortlist · {stops.length + others.length}</Text><Text style={type.tiny}>{fmtDate(day.date)} · {stops.length} in the running</Text></View>
        <Button label="Find" icon="search" kind="ghost" onPress={onFind} />
      </Row>
      <Segmented value={view} options={[{ value: 'list', label: 'List' }, { value: 'map', label: 'Map' }]} onChange={setView} />
      {modeBar}
      {timesBar}
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      {banner}
      {!journey && !error ? <Text style={type.small}>Working out the day…</Text> : null}
      {view === 'list' ? list : map}
      {view === 'list' ? <Text style={[type.tiny, { textAlign: 'center' }]}>Tap a row to open it. Swipe right for Booked, left for Fully booked. Arrows reorder.</Text> : null}
      {others.length ? (
        <Pressable onPress={() => setShowOthers((v) => !v)} style={styles.fold}>
          <Text style={[type.small, { fontWeight: '700' }]}>Not this time · {others.length}</Text>
          <Text style={[type.tiny, { flex: 1 }]} numberOfLines={1}>{others.map((o) => o.name).join(', ')}</Text>
          <Icon name={showOthers ? 'collapse' : 'more'} size={16} color={colors.inkFaint} />
        </Pressable>
      ) : null}
      {showOthers ? (
        <Card style={{ paddingVertical: 2, paddingHorizontal: spacing.md, gap: 0 }}>
          {others.map((o, i) => (
            <Pressable key={o.id} onPress={() => setOpenId(o.id)} style={styles.row}>
              <View style={[styles.num, o.status === 'full' ? { backgroundColor: colors.overrunSoft } : styles.numAside]}><Text style={[styles.numText, { color: o.status === 'full' ? colors.overrun : colors.inkFaint }]}>{stops.length + i + 1}</Text></View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[type.h3, { color: colors.inkFaint, textDecorationLine: 'line-through' }]} numberOfLines={1}>{o.name}</Text>
                <Wrap style={{ gap: 4 }}><StatusChip status={o.status} detail={o.statusOn ? fmtDate(o.statusOn) : null} />{o.statusNote ? <Text style={type.tiny}>{o.statusNote}</Text> : null}</Wrap>
              </View>
              <Chip label="Bring back" onPress={() => setStatus(o.id, o.item?.category && ['attraction', 'cafe'].includes(o.item.category) ? 'no_booking' : 'to_call')} />
            </Pressable>
          ))}
        </Card>
      ) : null}
      <Button
        label={journey?.canSave ? 'Save to the trip' : `Save to the trip${journey?.blockers[0] ? ` · ${journey.blockers[0].kind === 'to_call' ? journey.blockers[0].text : 'not yet'}` : ''}`}
        icon="booked" onPress={save} disabled={!journey?.canSave || busy} loading={busy} />

      {openItem && household ? (
        <VenueDrawer
          item={asBrowseItem(openItem)} baseLabel={journey?.home.label} onClose={() => { setOpenId(null); setVenue(null); }} onVenue={setVenue}
          ours={<BookingControl trip={d} item={openItem} venue={venue} dwell={stops.find((s) => s.id === openItem.id)?.dwellMinutes ?? openItem.dwellMinutes ?? 60} onChanged={onChanged} onSetAside={async () => { await setStatus(openItem.id, openItem.status === 'set_aside' ? 'to_call' : 'set_aside'); setOpenId(null); }} />}
        />
      ) : null}
      {legModal}
      {endpointFor && journey ? <EndpointModal which={endpointFor} journey={journey} trip={d} day={day} onClose={() => setEndpointFor(null)} onChanged={onChanged} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The trip day, after Save
// ---------------------------------------------------------------------------

export function TripJourneyDay({ d, day, onChangePlan, onChanged, wide }: { d: TripDetail; day: TripDay; onChangePlan: () => void; onChanged: () => Promise<void>; wide: boolean }) {
  const { trip } = d;
  const [journey, setJourney] = useState<Journey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState<{ from: LegPoint; to: LegPoint; leg: JourneyLeg; departAt: string | null } | null>(null);
  const hasCar = Boolean(trip.hasCar);
  const refresh = useCallback(async () => { try { setJourney(await api.journey(trip.id, { dayId: day.id, source: 'day' })); } catch (e: any) { setError(e.message); } }, [trip.id, day.id]);
  useEffect(() => { refresh(); }, [refresh, d]);
  const stops = journey?.stops ?? [];
  const home = journey?.start;
  const endPt = journey?.end ?? home;
  const kept = d.shortlist.filter((s) => !s.scheduled).length;
  const pins: MapPin[] = [];
  if (home) pins.push({ id: 'home', lat: home.lat, lng: home.lng, label: home.label, tone: 'home', number: home.kind === 'home' ? 'H' : 'S' });
  if (home && endPt && (endPt.lat !== home.lat || endPt.lng !== home.lng)) pins.push({ id: 'end', lat: endPt.lat, lng: endPt.lng, label: endPt.label, tone: 'home', number: endPt.kind === 'home' ? 'H' : 'E' });
  stops.forEach((s, i) => { if (s.lat != null && s.lng != null) pins.push({ id: s.id, lat: s.lat, lng: s.lng, label: `${i + 1} · ${s.name}`, tone: s.fixed ? 'base' : 'day', number: i + 1 }); });
  const lines: MapLine[] = home && stops.length ? [{ id: 'route', points: [home, ...stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ lat: s.lat!, lng: s.lng! })), endPt ?? home], color: colors.accent }] : [];
  const point = (s: JourneyStop | null, fallback: LegPoint): LegPoint => (s && s.lat != null && s.lng != null ? { label: s.name, lat: s.lat, lng: s.lng } : fallback);
  const departIso = (hhmm: string) => `${day.date}T${hhmm}:00`;
  const openDir = (from: LegPoint, to: LegPoint, leg: JourneyLeg) => setDir({ from, to, leg, departAt: departIso(leg.leaveBy) });

  return (
    <View style={{ gap: spacing.md }}>
      <Text style={type.small}>{fmtDate(day.date)} · leave {journey?.start.kind === 'home' ? 'home' : (journey?.start.label.split(',')[0] ?? '')} {journey?.startAt ?? ''} · {journey?.end.kind === 'home' ? 'home' : (journey?.end.label.split(',')[0] ?? 'back')} {journey?.homeAt ?? ''} · {hasCar ? 'with the car' : 'no car'}</Text>
      <MapView pins={pins} lines={lines} height={wide ? 420 : 200} />
      {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
      <Card style={{ paddingVertical: 2, paddingHorizontal: spacing.md, gap: 0 }}>
        {journey && home ? <View style={styles.row}><Text style={styles.time}>{journey.startAt}</Text><View style={[styles.num, { backgroundColor: colors.rating }]}><Icon name="home" size={13} color="#fff" /></View><Text style={[type.h3, { flex: 1 }]} numberOfLines={1}>Leave {home.kind === 'home' ? 'home' : home.label.split(',')[0]}</Text></View> : null}
        {stops.map((s, i) => {
          const from = point(i > 0 ? stops[i - 1] : null, home!);
          return (
            <View key={s.id}>
              <Pressable onPress={() => openDir(from, point(s, home!), s.legIn)} style={styles.legRow}>
                <View style={styles.legPill}><Icon name={s.legIn.mode} size={13} color={colors.ink} /><Text style={styles.legText}>{fmtMinutes(s.legIn.minutes)}</Text></View>
                <Row style={{ gap: 2 }}><Text style={type.tiny}>directions</Text><Icon name="more" size={12} color={colors.inkFaint} /></Row>
              </Pressable>
              <View style={styles.row}>
                <Text style={[styles.time, s.fixed && { color: colors.ink, fontWeight: '700' }]}>{s.arriveAt}</Text>
                <View style={[styles.num, s.fixed && { backgroundColor: colors.ink }]}><Text style={styles.numText}>{i + 1}</Text></View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={type.h3} numberOfLines={1}>{s.name}</Text>
                  <Wrap style={{ gap: 4 }}>{s.status === 'booked' ? <StatusChip status="booked" /> : null}<Text style={type.tiny}>{fmtMinutes(s.dwellMinutes)}{s.bookingRef ? ` · ${s.bookingRef}` : ''}</Text></Wrap>
                </View>
                <CategoryIcon category={s.category} size={16} color={colors.inkFaint} />
              </View>
            </View>
          );
        })}
        {journey?.legHome && home && stops.length ? (
          <>
            <Pressable onPress={() => openDir(point(stops[stops.length - 1], home), endPt ?? home, journey.legHome!)} style={styles.legRow}>
              <View style={styles.legPill}><Icon name={journey.legHome.mode} size={13} color={colors.ink} /><Text style={styles.legText}>{fmtMinutes(journey.legHome.minutes)}</Text></View>
              <Row style={{ gap: 2 }}><Text style={type.tiny}>directions</Text><Icon name="more" size={12} color={colors.inkFaint} /></Row>
            </Pressable>
            <View style={styles.row}><Text style={styles.time}>{journey.homeAt}</Text><View style={[styles.num, { backgroundColor: colors.rating }]}><Icon name="home" size={13} color="#fff" /></View><Text style={[type.h3, { flex: 1 }]} numberOfLines={1}>{(endPt ?? home).kind === 'home' ? 'Home' : (endPt ?? home).label.split(',')[0]}</Text></View>
          </>
        ) : null}
        {journey && !stops.length ? <Text style={[type.small, { paddingVertical: spacing.md }]}>Nothing saved for this day yet.</Text> : null}
      </Card>
      <Pressable onPress={onChangePlan} style={styles.fold}>
        <Text style={[type.small, { fontWeight: '700' }]}>Shortlist</Text>
        <Text style={[type.tiny, { flex: 1 }]}>{kept ? `${kept} kept for another time` : 'everything is on the day'}</Text>
        <Icon name="more" size={16} color={colors.inkFaint} />
      </Pressable>
      <Button label="Change the plan" icon="edit" kind="secondary" onPress={onChangePlan} />
      {dir ? <DirectionsDrawer tripId={trip.id} from={dir.from} to={dir.to} leg={dir.leg} hasCar={hasCar} departAt={dir.departAt} onClose={() => setDir(null)} /> : null}
    </View>
  );
}

const clock24 = (iso: string) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? iso.slice(0, 5) : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface },
  grip: { width: 18, alignItems: 'center', justifyContent: 'center', gap: 2 },
  time: { width: 42, fontSize: 12, color: colors.inkMuted, fontVariant: ['tabular-nums'] },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  numAside: { backgroundColor: 'transparent', borderWidth: 2, borderColor: colors.inkFaint, borderStyle: 'dashed' },
  numText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  tel: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  telOff: { backgroundColor: colors.surfaceMuted },
  legRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3, paddingLeft: 50, backgroundColor: colors.surface },
  legPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.surfaceMuted },
  legText: { fontSize: 11, fontWeight: '700', color: colors.ink },
  under: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14 },
  underL: { backgroundColor: colors.like, justifyContent: 'flex-start' },
  underR: { backgroundColor: colors.overrun, justifyContent: 'flex-end' },
  underText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  modebar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  timeInput: { minHeight: 32, width: 64, paddingHorizontal: 8, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 13, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  warn: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', padding: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.overrunSoft },
  ok: { flexDirection: 'row', gap: 6, alignItems: 'center', padding: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  fold: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(29,27,22,0.45)' },
  modalWrap: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  modal: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm, maxWidth: 420, width: '100%', alignSelf: 'center' },
  close: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center', marginRight: -12, marginTop: -12 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  optOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  booking: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  field: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 38, paddingHorizontal: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
  fieldInput: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.ink, minHeight: 34 },
  tlStop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 4 },
  tlLeg: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 11 },
  tlBar: { width: 2, height: 22, marginRight: 4 },
  win: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: colors.accentSoft },
});

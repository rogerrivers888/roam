import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PlanRoute, RouteStop } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Button, Chip, Row, Wrap, clock, minutes } from './ui';
import { priceMarks, typeLine } from './StopCard';
import { VenuePhoto } from './VenuePhoto';
import { VenueDrawer } from './VenueDrawer';
import { Icon } from './Icon';

/**
 * The journey as part of the day (owner, 4 Sep 2026).
 *
 * A day out is two hours of road as well as six hours at the far end, and
 * everything on that road is invisible to a search around the destination.
 * This shows what is worth stopping for on the way there and on the way home:
 * only places that stand out — a rating that means something, or somewhere the
 * household already loves — and never for the sake of it. What each one costs
 * in detour is on the card, because the corridor is a bias and not a promise
 * that a place sits on the road.
 *
 * Choosing a stop moves the time they leave home; it never eats the time they
 * asked for at the destination.
 */
export function OnTheWay({ route, busy, onAdd, onDrop }: {
  route: PlanRoute;
  busy: boolean;
  onAdd: (s: RouteStop) => void;
  onDrop: (s: RouteStop) => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const [open, setOpen] = useState<RouteStop | null>(null);
  const chosen = route.stops.filter((s) => s.chosen);
  const out = chosen.filter((s) => s.leg === 'out');
  const back = chosen.filter((s) => s.leg === 'back');
  const more = route.stops.filter((s) => !s.chosen);

  return (
    <View style={{ gap: spacing.sm }}>
      <Row style={{ alignItems: 'flex-start' }}>
        <Icon name={route.mode === 'driving' ? 'driving' : route.mode === 'walking' ? 'walking' : 'transit'} size={18} />
        <Text style={[type.h3, { flex: 1 }]}>On the way</Text>
      </Row>
      <Text style={type.small}>
        {route.from} → {route.to}, about {minutes(route.minutes)}{route.estimated ? ' (estimated)' : ''}. Leaving at{' '}
        {clock(route.leaveHomeAt)}, home about {clock(route.backHomeAt)}.
      </Text>
      {chosen.length ? (
        <Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>
          The day is the same length: stopping puts you in {route.to} from {clock(route.arriveThereAt)} to{' '}
          {clock(route.leaveThereAt)} — {minutes(route.minutesThere)} there instead of {minutes(route.minutesThereWithout)}.
        </Text>
      ) : null}

      {route.mode === 'transit' ? (
        <Text style={type.tiny}>On a train or a bus, stopping means breaking the journey — check your ticket allows it before you count on one of these.</Text>
      ) : null}

      {chosen.length ? (
        <>
          {out.length ? <Text style={type.label}>On the way there</Text> : null}
          {out.map((s) => <WayRow key={s.id} stop={s} busy={busy} onOpen={() => setOpen(s)} onPress={() => onDrop(s)} />)}
          {back.length ? <Text style={type.label}>On the way home</Text> : null}
          {back.map((s) => <WayRow key={s.id} stop={s} busy={busy} onOpen={() => setOpen(s)} onPress={() => onDrop(s)} />)}
        </>
      ) : (
        <Text style={type.small}>
          Nothing on this road stood out enough to be worth breaking the journey for
          {more.length ? `, but ${more.length} ${more.length === 1 ? 'place is' : 'places are'} near it` : ''}.
        </Text>
      )}

      {more.length ? (
        <>
          <Button
            kind="ghost"
            icon={showMore ? 'collapse' : 'expand'}
            label={showMore ? 'Hide the rest of the road' : `Also on the way (${more.length})`}
            onPress={() => setShowMore((v) => !v)}
          />
          {showMore ? (
            <>
              <Text style={type.tiny}>Within {route.limitMinutes} minutes of the road. These are not in the plan; the reason each was passed over is on its row.</Text>
              {more.map((s) => <WayRow key={s.id} stop={s} busy={busy} onOpen={() => setOpen(s)} onPress={() => onAdd(s)} />)}
            </>
          ) : null}
        </>
      ) : null}

      <VenueDrawer item={open} baseLabel={route.to} onClose={() => setOpen(null)} onAdd={(b) => onAdd(b as RouteStop)} added={open?.chosen ?? false} />
    </View>
  );
}

function WayRow({ stop, busy, onOpen, onPress }: { stop: RouteStop; busy: boolean; onOpen: () => void; onPress: () => void }) {
  const price = priceMarks(stop.priceLevel);
  return (
    <View style={styles.row}>
      <Pressable onPress={onOpen} style={{ flexDirection: 'row', gap: spacing.md, flex: 1 }} accessibilityRole="button" accessibilityLabel={`Open ${stop.name}`}>
        <VenuePhoto photos={stop.photos} size={64} credit={false} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.h3}>{stop.name}</Text>
          <Text style={type.small}>{typeLine(stop)}{price ? ` · ${price}` : ''}{stop.rating != null ? ` · ${stop.rating.toFixed(1)}${stop.ratingCount ? ` (${stop.ratingCount.toLocaleString()})` : ''}` : ''}</Text>
          <Text style={[type.small, { fontWeight: '700', color: colors.ink }]}>
            {stop.chosen && stop.arriveAt ? `${clock(stop.arriveAt)} · ` : ''}{stop.why}
          </Text>
          <Text style={type.small}>
            {stop.intoJourneyMinutes ? `${minutes(stop.intoJourneyMinutes)} into the ${stop.leg === 'back' ? 'way home' : 'drive'} · ` : ''}
            {stop.detourMinutes ? `adds ${minutes(stop.detourMinutes)} off the road` : 'straight past the door'}
            {stop.detourEstimated ? ' (estimated)' : ''}
            {stop.chosen ? ` · ${minutes(stop.dwellMinutes)} there` : ''}
          </Text>
          <Wrap>
            {stop.standout ? <Chip label={stop.standout} tone="like" /> : null}
            {stop.reasons.filter((r) => r.kind !== 'chain' && r.kind !== 'note').slice(0, 2).map((r, i) => (
              <Chip key={i} label={r.text} tone={r.kind === 'dislike' || r.kind === 'diet' ? 'dislike' : 'like'} />
            ))}
          </Wrap>
          {stop.notProposed ? <Text style={type.tiny}>Not proposed: {stop.notProposed.toLowerCase()}</Text> : null}
        </View>
      </Pressable>
      <Pressable onPress={onPress} disabled={busy} style={[styles.btn, stop.chosen && styles.btnOn]} accessibilityRole="button">
        <Icon name={stop.chosen ? 'check' : 'add'} size={14} color={stop.chosen ? colors.bg : colors.ink} />
        <Text style={[styles.btnText, stop.chosen && { color: colors.bg }]}>{stop.chosen ? 'Stopping' : 'Stop here'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line, flexWrap: 'wrap' },
  btn: { minHeight: 36, minWidth: 104, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center' },
  btnOn: { backgroundColor: colors.like },
  btnText: { fontSize: 12, fontWeight: '700', color: colors.ink },
});

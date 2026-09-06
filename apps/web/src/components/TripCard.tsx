import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { TripSummary } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Row } from './ui';
import { Avatar } from './Faces';
import { VenueThumb } from './VenueThumb';
import { tripTitle } from '../screens/tripName';

const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtRange = (a?: string | null, b?: string | null) => (a && b ? (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`) : '');
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * One trip, as a card (handover 2a): a 92px picture, the name, the dates, and
 * the people, with the one thing that still needs doing beside them.
 *
 * Red is only ever "needs doing" here — a trip with dates and nowhere to sleep.
 * Everything else on the line is grey, because a count is not an alarm.
 */
export function TripCard({ trip: t, members = [], onPress }: {
  trip: TripSummary; members?: { id: string; name: string; avatarUrl?: string | null }[]; onPress: () => void;
}) {
  const start = new Date(t.startDate ? `${t.startDate}T12:00:00` : t.departAt);
  const days = Math.round((+start - +new Date(new Date().toDateString())) / 86400000);
  const away = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  const when = t.kind === 'trip'
    ? `${fmtRange(t.startDate, t.endDate)}${t.nights ? ` · ${t.nights + 1} days` : ''}`
    : `${fmtDate(t.departAt)} · day trip · leave ${clock(t.departAt)}`;
  // What is left to do, or what happened. One line, and only one.
  // A day out has nowhere to sleep by definition, so a hotel is only ever said
  // of a trip with nights in it.
  const staying = t.nights > 0 && !!t.base && t.base.kind !== 'centre' && t.base.kind !== 'home';
  const note = t.needsStay ? { text: 'Stay not booked', warn: true }
    : t.isPast ? { text: [t.placeCount ? `${t.placeCount} place${t.placeCount === 1 ? '' : 's'}` : null, t.unratedCount ? `rate ${t.unratedCount}` : null].filter(Boolean).join(' · ') || 'nothing saved', warn: false }
      : { text: [staying ? '1 hotel' : null, t.stopCount ? `${t.stopCount} stop${t.stopCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || away, warn: false };
  const indexOf = (id: string) => Math.max(0, members.findIndex((m) => m.id === id));
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <View style={styles.tripCard}>
        <VenueThumb name={tripTitle(t)} image={t.image ?? null} category="place" width={92} height={92} rounded={radius.lg} credit={false} />
        <View style={{ flex: 1, minWidth: 0, gap: 4, justifyContent: 'center' }}>
          {/* One naming rule for the whole app (tripName.ts): a name somebody
              chose beats a name we derived, and a title auto-made from a
              council gets its head swapped without losing the month. */}
          <Text style={type.h2} numberOfLines={2}>{tripTitle(t)}</Text>
          <Text style={type.small} numberOfLines={1}>{when}</Text>
          <Row style={{ gap: 6, marginTop: 2 }}>
            {t.attendees.length ? (
              <View style={{ flexDirection: 'row' }}>
                {t.attendees.slice(0, 5).map((a, i) => (
                  <View key={a.id} style={{ marginLeft: i ? -8 : 0, borderWidth: 2, borderColor: colors.surface, borderRadius: 999 }}>
                    <Avatar name={a.name} index={indexOf(a.id)} size={24} url={members.find((m) => m.id === a.id)?.avatarUrl} />
                  </View>
                ))}
              </View>
            ) : null}
            <Text style={[type.tiny, note.warn && { color: colors.red, fontWeight: '700' }]} numberOfLines={1}>{note.text}</Text>
          </Row>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tripCard: { flexDirection: 'row', gap: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, backgroundColor: colors.surface },
});

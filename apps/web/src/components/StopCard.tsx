import React, { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, OptionStop, Venue } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Chip, Row, Wrap, clock, minutes } from './ui';
import { VenuePhoto } from './VenuePhoto';

/**
 * One suggested stop, with enough on the card to judge it (owner feedback,
 * 3 Sep 2026): what kind of place, why it was chosen, how it is rated and by how
 * many people and from where, what it costs, how far it is — and a drill-down
 * to the reviews themselves, good and bad. Where a fact is missing because the
 * source has none (OpenStreetMap carries no ratings or prices) the card says
 * so rather than leaving a gap the reader fills with doubt.
 */

const CATEGORY_ICON: Record<string, string> = { restaurant: '🍽', cafe: '☕', pub: '🍺', bar: '🍸', attraction: '🏛', event: '🎟' };
const CATEGORY_LABEL: Record<string, string> = { restaurant: 'Restaurant', cafe: 'Café', pub: 'Pub', bar: 'Bar', attraction: 'Attraction', event: 'Event' };
const SOURCE_LABEL: Record<string, string> = { google: 'Google', tripadvisor: 'Tripadvisor', osm: 'OpenStreetMap', fixtures: 'sample data', ticketmaster: 'Ticketmaster' };
const MODE_WORD: Record<string, string> = { walking: 'on foot', cycling: 'by bike', driving: 'by car', transit: 'by public transport' };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const priceMarks = (level: number | null | undefined) => (level == null ? null : level === 0 ? 'Free' : '£'.repeat(Math.max(1, Math.min(4, level))));
const fmtCount = (n: number) => n.toLocaleString();

export function typeLine(stop: Pick<OptionStop, 'category' | 'cuisines' | 'experiences'>): string {
  const bits = [CATEGORY_LABEL[stop.category] ?? cap(stop.category), ...(stop.cuisines ?? []), ...(stop.experiences ?? []).filter((e) => e !== stop.category)];
  return [...new Set(bits.map((b) => (b === b.toLowerCase() ? cap(b.replace(/-/g, ' ')) : b)))].join(' · ');
}

export function StopCard({ stop, mode, baseLabel, previousName, dim, pinned, busy, onLike, onDislike }: {
  stop: OptionStop;
  mode: string;
  /** Where the day is based (hotel, theatre, home) — distances are from here. */
  baseLabel?: string | null;
  previousName?: string | null;
  dim?: boolean;
  pinned: boolean;
  busy: boolean;
  onLike: () => void;
  onDislike: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isAnchor = stop.fixed || stop.venueRef.startsWith('anchor:');
  const price = priceMarks(stop.priceLevel);

  return (
    <View style={[styles.stop, dim && { opacity: 0.35 }]}>
      {!isAnchor ? <VenuePhoto photos={stop.photos} size={84} /> : null}
      <View style={{ flex: 1, gap: 4 }}>
        <Row>
          <Text style={styles.stopPos}>{stop.position}</Text>
          <Text style={[type.h3, { flex: 1 }]} numberOfLines={2}>
            {isAnchor ? '📌 ' : `${CATEGORY_ICON[stop.category] ?? '•'} `}{stop.name}{isAnchor ? ' (your booking)' : ''}
          </Text>
          {stop.chain ? <Chip label={stop.brand ? `Chain · ${stop.brand}` : 'Chain'} tone="dislike" /> : null}
        </Row>

        {!isAnchor ? (
          <Text style={type.small}>
            {typeLine(stop)}{price ? ` · ${price}` : stop.category !== 'attraction' && stop.category !== 'event' ? ' · price unknown' : ''}
          </Text>
        ) : null}

        {!isAnchor ? (
          stop.rating != null ? (
            <Text style={type.small}>
              <Text style={{ fontWeight: '700', color: colors.ink }}>★ {stop.rating.toFixed(1)}</Text>
              {stop.ratingCount ? ` from ${fmtCount(stop.ratingCount)} reviews` : ''} · {SOURCE_LABEL[stop.ratingSource ?? ''] ?? stop.ratingSource}
            </Text>
          ) : (
            <Text style={type.tiny}>No rating — {SOURCE_LABEL[stop.source ?? ''] ?? 'this source'} carries none. Ratings and reviews arrive with Google Places or Tripadvisor (Settings › Sources).</Text>
          )
        ) : null}

        <Text style={type.small}>
          {stop.arriveAt ? `${clock(stop.arriveAt)} · ` : ''}
          {stop.travelFromPrevMinutes} min {MODE_WORD[mode] ?? mode}{previousName ? ` from ${previousName}` : ''}
          {stop.distanceKm != null ? ` · ${stop.distanceKm} km from ${baseLabel ?? 'base'}` : ''}
          {' · '}{isAnchor ? `${minutes(stop.dwellMinutes)} long` : `there for ${minutes(stop.dwellMinutes)}`}
          {stop.startsAt && stop.endsAt ? ` · ${clock(stop.startsAt)}–${clock(stop.endsAt)}` : ''}
        </Text>

        {stop.reasons.length ? (
          <Wrap>
            {stop.reasons.filter((r) => r.kind !== 'chain').slice(0, 4).map((r, i) => (
              <Chip key={i} label={r.text} tone={r.kind === 'dislike' || r.kind === 'diet' ? 'dislike' : r.kind === 'want' ? 'want' : r.kind === 'note' ? 'neutral' : 'like'} icon={r.kind === 'favourite' ? '★' : r.kind === 'kids' ? '👧' : undefined} />
            ))}
          </Wrap>
        ) : null}
        {stop.justification ? <Text style={type.tiny}>"{stop.justification}"</Text> : null}

        {!isAnchor ? (
          <Pressable onPress={() => setOpen((o) => !o)} style={styles.details} accessibilityRole="button">
            <Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>{open ? 'Hide details' : 'Details & reviews'}</Text>
          </Pressable>
        ) : null}
        {open ? <StopDetails stop={stop} /> : null}
      </View>

      <View style={{ gap: 6 }}>
        <Pressable onPress={onLike} disabled={busy} style={[styles.reactBtn, pinned && styles.reactBtnOn]} accessibilityRole="button" accessibilityLabel={pinned ? `Stop keeping ${stop.name}` : `Keep ${stop.name}`}>
          <Text style={[styles.reactText, pinned && { color: '#fff' }]}>{pinned ? '♥ Keeping' : '♡ Keep'}</Text>
        </Pressable>
        {!isAnchor ? (
          <Pressable onPress={onDislike} disabled={busy} style={styles.reactBtn} accessibilityRole="button" accessibilityLabel={`Not ${stop.name}`}>
            <Text style={styles.reactText}>✕ Not this</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** Address, hours, website, editorial summary and the reviews — fetched on demand, never stored. */
function StopDetails({ stop }: { stop: OptionStop }) {
  const [venue, setVenue] = useState<Venue | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.place(stop.venueRef).then((d) => { if (live) { setVenue(d.venue); if (d.sourceError) setError(d.sourceError); } }).catch((e) => { if (live) { setVenue(null); setError(e.message); } });
    return () => { live = false; };
  }, [stop.venueRef]);

  const v = venue ?? undefined;
  const address = v?.address ?? stop.address;
  const hours = v?.openingHours ?? stop.openingHours;
  const website = v?.website ?? stop.website;
  const summary = v?.summary ?? stop.summary;
  const reviews = [...(v?.reviews ?? [])].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const source = stop.source ?? stop.venueRef.split(':')[0];

  return (
    <View style={styles.detail}>
      {venue === undefined ? <Text style={type.tiny}>Fetching…</Text> : null}
      {summary ? <Text style={type.body}>{summary}</Text> : null}
      {address ? <Text style={type.small}>📍 {address}</Text> : null}
      {hours ? <Text style={type.small}>🕒 {hours}</Text> : null}
      {website ? <Pressable onPress={() => Linking.openURL(website)}><Text style={[type.small, { color: colors.accent }]}>{website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</Text></Pressable> : null}
      {stop.goodForChildren != null ? <Text style={type.small}>{stop.goodForChildren ? '👧 Good for children' : 'Not noted as good for children'}{stop.menuForChildren ? " · children's menu" : ''}</Text> : null}

      {reviews.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.h3}>Reviews</Text>
          {reviews.map((r, i) => (
            <View key={i} style={styles.review}>
              <Text style={type.small}>
                <Text style={{ fontWeight: '700', color: colors.ink }}>{r.rating != null ? `★ ${r.rating}` : ''}</Text>
                {i === 0 && reviews.length > 1 ? '  best' : i === reviews.length - 1 && reviews.length > 1 ? '  most critical' : ''}
                {r.author ? ` · ${r.author}` : ''}{r.when ? ` · ${r.when}` : ''}
              </Text>
              <Text style={type.body}>{r.text}</Text>
            </View>
          ))}
          <Text style={type.tiny}>{v?.attribution ?? stop.attribution ?? ''}</Text>
        </View>
      ) : venue !== undefined ? (
        <Text style={type.tiny}>
          {source === 'osm' || source === 'fixtures'
            ? 'No reviews: this place came from OpenStreetMap, which has none. Google Places and Tripadvisor bring ratings and reviews once switched on (Settings › Sources).'
            : error ? `Couldn't fetch reviews: ${error}` : 'No reviews returned for this place.'}
        </Text>
      ) : null}
      {stop.attribution && !reviews.length ? <Text style={type.tiny}>{stop.attribution}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stop: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  stopPos: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.dwell, color: '#fff', textAlign: 'center', lineHeight: 22, fontSize: 12, fontWeight: '700', overflow: 'hidden' },
  details: { minHeight: 32, justifyContent: 'center', alignSelf: 'flex-start' },
  detail: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  review: { gap: 2, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  reactBtn: { minHeight: 40, minWidth: 96, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  reactBtnOn: { backgroundColor: colors.like },
  reactText: { fontSize: 13, fontWeight: '700', color: colors.ink },
});

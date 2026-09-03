import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  ArrowLeft, ArrowRight, Baby, BedDouble, Beer, Bookmark, BookmarkCheck, Calendar, Camera, Check, ChevronDown, ChevronRight, ChevronUp,
  Clock, Coffee, Compass, ExternalLink, Heart, Landmark, MapPin, Mic, Minus, Monitor, Phone, Pin, Plus, Route, Settings, Smartphone,
  Sparkles, Square, Star, Ticket, TriangleAlert, Users, Utensils, Wine, X,
} from 'lucide-react-native';
import { colors, spacing, type } from '../theme';

/**
 * One icon set for the whole app: Lucide, drawn as SVG at the size and colour
 * the caller asks for. Every icon is named for what it means in Roam, not for
 * the picture, so a screen says `name="favourite"` and the set decides the
 * glyph. Emoji and symbol characters are not icons here (owner, 3 Sep 2026).
 */
const ICONS = {
  // navigation
  plan: Sparkles, places: Compass, trips: Route, household: Users, settings: Settings,
  web: Monitor, mobile: Smartphone,
  // actions and states
  mic: Mic, stop: Square, check: Check, close: X, add: Plus, minus: Minus,
  back: ArrowLeft, forward: ArrowRight, external: ExternalLink,
  expand: ChevronDown, collapse: ChevronUp, more: ChevronRight,
  keep: Heart, favourite: Star, shortlist: Bookmark, shortlisted: BookmarkCheck, pinned: Pin,
  allergen: TriangleAlert,
  // facts about a place
  address: MapPin, hours: Clock, children: Baby, phone: Phone, camera: Camera, calendar: Calendar, ticket: Ticket,
  // categories
  restaurant: Utensils, cafe: Coffee, pub: Beer, bar: Wine, attraction: Landmark, event: Ticket, hotel: BedDouble, place: MapPin,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, color = colors.inkMuted, fill, strokeWidth = 2 }: {
  name: IconName; size?: number; color?: string; fill?: boolean; strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return <Glyph size={size} color={color} strokeWidth={strokeWidth} fill={fill ? color : 'none'} />;
}

const CATEGORY: Record<string, IconName> = { restaurant: 'restaurant', cafe: 'cafe', pub: 'pub', bar: 'bar', attraction: 'attraction', event: 'event', hotel: 'hotel', lodging: 'hotel' };

/** The icon for a place's category; a pin when the category is unknown. */
export function CategoryIcon({ category, size = 18, color = colors.inkMuted }: { category?: string | null; size?: number; color?: string }) {
  return <Icon name={CATEGORY[category ?? ''] ?? 'place'} size={size} color={color} />;
}

/** A line of small text led by an icon: an address, opening hours, a note about children. */
export function IconText({ name, children, color = colors.inkMuted, style }: { name: IconName; children: React.ReactNode; color?: string; style?: object }) {
  return (
    <View style={styles.line}>
      <View style={styles.lineIcon}><Icon name={name} size={15} color={color} /></View>
      <Text style={[type.small, { flex: 1 }, style]}>{children}</Text>
    </View>
  );
}

/** A rating: a filled star and the number, with whatever follows it in muted text. */
export function Rating({ value, children }: { value: number; children?: React.ReactNode }) {
  return (
    <View style={styles.line}>
      <Icon name="favourite" size={14} color={colors.rating} fill />
      <Text style={type.small}><Text style={{ fontWeight: '700', color: colors.ink }}>{value.toFixed(1)}</Text>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  lineIcon: { paddingTop: 2 },
});

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Archive, ArrowLeft, ArrowRight, Baby, Ban, BedDouble, Beer, Bookmark, BookmarkCheck, Calendar, Camera, Car, CarTaxiFront, Check, ChevronDown, ChevronRight, ChevronUp, CircleCheck,
  Clock, Coffee, Compass, ExternalLink, Footprints, GripVertical, Heart, House, Info, Landmark, List, Lock, Map, MapPin, Mic, Minus, Monitor, Navigation, Pencil, Phone, Pin, Plus, Route, Search, Settings, Smartphone,
  Moon, Sparkles, Square, Star, StarHalf, Sun, Ticket, TrainFront, TriangleAlert, User, Users, Utensils, Wine, X,
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
  web: Monitor, mobile: Smartphone, person: User,
  // Light and dark mode, on the theme switch
  light: Sun, dark: Moon,
  // actions and states
  mic: Mic, stop: Square, check: Check, close: X, add: Plus, minus: Minus,
  back: ArrowLeft, forward: ArrowRight, external: ExternalLink,
  expand: ChevronDown, collapse: ChevronUp, more: ChevronRight,
  keep: Heart, favourite: Star, halfStar: StarHalf, shortlist: Bookmark, shortlisted: BookmarkCheck, pinned: Pin,
  allergen: TriangleAlert, archived: Archive,
  // facts about a place
  address: MapPin, hours: Clock, children: Baby, phone: Phone, camera: Camera, calendar: Calendar, ticket: Ticket,
  // the journey: ways of getting about, booking states, list and map, order
  walking: Footprints, driving: Car, transit: TrainFront, taxi: CarTaxiFront, directions: Navigation, home: House,
  booked: CircleCheck, full: Ban, locked: Lock, grip: GripVertical, list: List, map: Map, info: Info, search: Search, edit: Pencil,
  // categories
  restaurant: Utensils, cafe: Coffee, pub: Beer, bar: Wine, attraction: Landmark, event: Ticket, hotel: BedDouble, place: MapPin,
} as const;

export type IconName = keyof typeof ICONS;

// One icon colour per mode (style guide): leaf in light, off-white in dark; Lucide outline at 1.8px.
export function Icon({ name, size = 18, color = colors.icon, fill, strokeWidth = 1.8 }: {
  name: IconName; size?: number; color?: string; fill?: boolean; strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return <Glyph size={size} color={color} strokeWidth={strokeWidth} fill={fill ? color : 'none'} />;
}

const CATEGORY: Record<string, IconName> = { restaurant: 'restaurant', cafe: 'cafe', pub: 'pub', bar: 'bar', attraction: 'attraction', event: 'event', hotel: 'hotel', lodging: 'hotel' };

/** The icon for a place's category; a pin when the category is unknown. */
export function CategoryIcon({ category, size = 18, color = colors.icon }: { category?: string | null; size?: number; color?: string }) {
  return <Icon name={CATEGORY[category ?? ''] ?? 'place'} size={size} color={color} />;
}

/** A line of small text led by an icon: an address, opening hours, a note about children. */
export function IconText({ name, children, color = colors.icon, style }: { name: IconName; children: React.ReactNode; color?: string; style?: object }) {
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
      <Icon name="favourite" size={14} color={colors.icon} fill />
      <Text style={type.small}><Text style={{ fontWeight: '700', color: colors.ink }}>{value.toFixed(1)}</Text>{children}</Text>
    </View>
  );
}

/**
 * A rating drawn as stars (owner, 4 Sep 2026: reviews should have stars). Five
 * glyphs, filled to the nearest half, in the icon colour — never a ★ character,
 * and never red, which the guide keeps for the heart.
 */
export function Stars({ value, size = 15, children }: { value: number; size?: number; children?: React.ReactNode }) {
  const halves = Math.max(0, Math.min(10, Math.round(value * 2)));
  return (
    <View style={styles.line} accessibilityRole="text" accessibilityLabel={`${value} out of 5`}>
      <View style={[styles.stars, { paddingTop: 1 }]}>
        {[0, 1, 2, 3, 4].map((i) => {
          const filled = halves >= (i + 1) * 2;
          const half = !filled && halves === i * 2 + 1;
          return <Icon key={i} name={half ? 'halfStar' : 'favourite'} size={size} fill={filled || half} />;
        })}
      </View>
      {children ? <Text style={type.small}>{children}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  stars: { flexDirection: 'row', gap: 1 },
  lineIcon: { paddingTop: 2 },
});

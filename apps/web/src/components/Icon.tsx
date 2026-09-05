import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Archive, ArrowLeft, ArrowRight, Baby, Ban, BedDouble, Beer, Bookmark, BookmarkCheck, Calendar, Camera, Car, CarTaxiFront, Check, ChevronDown, ChevronRight, ChevronUp, CircleCheck,
  Bird, Fish,
  Clock, CloudOff, Coffee, Compass, Database, Download, ExternalLink, Footprints, GripVertical, Heart, House, Info, Landmark, List, LocateFixed, Lock, Map, MapPin, Mic, Minus, Monitor, Navigation, Pencil, Phone, Pin, Plus, Route, Search, Settings, Smartphone,
  MessageSquare, Moon, PoundSterling, RefreshCw, Sparkles, Square, Star, StarHalf, Sun, Ticket, TrainFront, TriangleAlert, User, Users, Utensils, Wine, X,
  Copy, Mail, Send, UserCog, Ellipsis,
  Bike, Binoculars, Blocks, BookOpen, Castle, Clapperboard, Drama, Droplets, Dumbbell, FerrisWheel, Gamepad2,
  Mountain, Music, Palette, PartyPopper, Popcorn, Puzzle, Ship, ShoppingBag, Snowflake, Store, Tractor, TreePine, Trophy,
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
  inspire: Sparkles, plan: Sparkles, places: Compass, trips: Route, household: Users, settings: Settings,
  web: Monitor, mobile: Smartphone, person: User,
  // Light and dark mode, on the theme switch
  light: Sun, dark: Moon,
  // actions and states
  mic: Mic, stop: Square, check: Check, close: X, add: Plus, minus: Minus,
  back: ArrowLeft, forward: ArrowRight, external: ExternalLink,
  expand: ChevronDown, collapse: ChevronUp, more: ChevronRight,
  // The ⋯ that opens the rest of a screen's controls. `more` is the chevron a
  // row ends in and means "there is a page behind this"; this one means "there
  // is a menu here", and drawing one as the other reads as a broken link.
  menu: Ellipsis,
  keep: Heart, favourite: Star, halfStar: StarHalf, shortlist: Bookmark, shortlisted: BookmarkCheck, pinned: Pin,
  allergen: TriangleAlert, archived: Archive, refresh: RefreshCw,
  // the device's own copy: no signal, saving it, and what Roam owns outright
  offline: CloudOff, download: Download, owned: Database,
  // facts about a place
  address: MapPin, hours: Clock, children: Baby, phone: Phone, message: MessageSquare, camera: Camera, calendar: Calendar, ticket: Ticket,
  // the journey: ways of getting about, booking states, list and map, order
  walking: Footprints, driving: Car, transit: TrainFront, taxi: CarTaxiFront, directions: Navigation, home: House,
  // where the device says the household is standing, right now
  here: LocateFixed,
  // who has Roam, and getting a link to them: the admin module
  accounts: UserCog, mail: Mail, send: Send, copy: Copy,
  booked: CircleCheck, full: Ban, locked: Lock, money: PoundSterling, grip: GripVertical, list: List, map: Map, info: Info, search: Search, edit: Pencil,
  // categories
  restaurant: Utensils, cafe: Coffee, pub: Beer, bar: Wine, attraction: Landmark, event: Ticket, hotel: BedDouble, place: MapPin,
  // What a place actually is, over the closed experience vocabulary
  // (api/src/domain/concepts.js). A card with no photograph shows one of these
  // instead, so four playgrounds do not all sit under a Greek temple.
  museum: Landmark, gallery: Palette, theatre: Drama, cinema: Clapperboard, liveMusic: Music, comedy: PartyPopper,
  park: TreePine, walk: Footprints, beach: Droplets, viewpoint: Binoculars, farm: Tractor, zoo: Bird, aquarium: Fish,
  playground: Blocks, arcade: Gamepad2, escapeRoom: Puzzle, themePark: FerrisWheel, bowling: Trophy, sport: Dumbbell,
  swimming: Droplets, climbing: Mountain, iceSkating: Snowflake, cycling: Bike, boat: Ship, festival: PartyPopper,
  market: Store, shopping: ShoppingBag, bookshop: BookOpen, castle: Castle, history: Castle, cinemaSnack: Popcorn,
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

/**
 * The experience vocabulary the sources answer with, in this set's names. A
 * place says it is a playground or a castle long before it says what category
 * it is, and that is the more useful thing to draw.
 */
const EXPERIENCE: Record<string, IconName> = {
  museum: 'museum', 'art-gallery': 'gallery', theatre: 'theatre', cinema: 'cinema', 'live-music': 'liveMusic', comedy: 'comedy',
  park: 'park', walk: 'walk', beach: 'beach', viewpoint: 'viewpoint', farm: 'farm', zoo: 'zoo', aquarium: 'aquarium',
  playground: 'playground', arcade: 'arcade', 'escape-room': 'escapeRoom', 'theme-park': 'themePark', bowling: 'bowling',
  'mini-golf': 'bowling', 'sports-game': 'sport', swimming: 'swimming', climbing: 'climbing', trampoline: 'sport',
  'ice-skating': 'iceSkating', cycling: 'cycling', 'boat-trip': 'boat', festival: 'festival', market: 'market',
  shopping: 'shopping', bookshop: 'bookshop', castle: 'castle', history: 'history',
};

/**
 * The atlas's own eight words for what a place is (sources/wikimedia.js
 * ATTRACTION_ROOTS). A separate table from the one above because it is a
 * separate vocabulary — the experiences list is closed and voice is
 * interpreted against it, so the atlas's words are not folded into it.
 */
const ATLAS: Record<string, IconName> = {
  heritage: 'castle', museum: 'museum', arts: 'gallery', outdoors: 'park',
  animals: 'zoo', family: 'playground', active: 'sport', landmark: 'attraction',
};

/**
 * The best icon for a place: what the atlas researched it to be, then what a
 * source tagged it, then what kind of place it is. Used where a card has no
 * photograph and the tile has to carry the meaning on its own.
 */
export function iconFor({ category, experiences, atlasCategory }: {
  category?: string | null; experiences?: string[] | null; atlasCategory?: string | null;
}): IconName {
  if (atlasCategory && ATLAS[atlasCategory]) return ATLAS[atlasCategory];
  for (const e of experiences ?? []) if (EXPERIENCE[e]) return EXPERIENCE[e];
  return CATEGORY[category ?? ''] ?? 'place';
}

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

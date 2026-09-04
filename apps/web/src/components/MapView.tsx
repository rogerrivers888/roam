import React from 'react';
import { Text, View } from 'react-native';
import { colors, type } from '../theme';

export type MapPin = { id: string; lat: number; lng: number; label: string; tone?: 'base' | 'day' | 'shortlist' | 'been' | 'special' | 'muted' | 'full' | 'aside' | 'home' | 'selected' | 'hollow'; dayIndex?: number; onPress?: () => void; /** A number or letter drawn on the pin (the journey's order); '' draws a plain pin. */ number?: string | number; /** A small red heart on the pin: a special place (style guide: red is the heart). */ heart?: boolean };
/** A line between points: the route of the day, or the legs either side of a chosen place. */
export type MapLine = { id: string; points: { lat: number; lng: number }[]; dashed?: boolean; color?: string };

/** Native fallback: the web app renders a real map (MapView.web.tsx). */
export function MapView({ pins, height = 320 }: { pins: MapPin[]; lines?: MapLine[]; center?: { lat: number; lng: number }; height?: number; fit?: boolean; focusId?: string | null }) {
  return (
    <View style={{ height, borderRadius: 12, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={type.small}>{pins.length} places on the map — map view arrives with the native app.</Text>
    </View>
  );
}

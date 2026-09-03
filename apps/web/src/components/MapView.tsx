import React from 'react';
import { Text, View } from 'react-native';
import { colors, type } from '../theme';

export type MapPin = { id: string; lat: number; lng: number; label: string; tone?: 'base' | 'day' | 'shortlist' | 'been' | 'special' | 'muted'; dayIndex?: number; onPress?: () => void };

/** Native fallback: the web app renders a real map (MapView.web.tsx). */
export function MapView({ pins, height = 320 }: { pins: MapPin[]; center?: { lat: number; lng: number }; height?: number; fit?: boolean }) {
  return (
    <View style={{ height, borderRadius: 12, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={type.small}>{pins.length} places on the map — map view arrives with the native app.</Text>
    </View>
  );
}

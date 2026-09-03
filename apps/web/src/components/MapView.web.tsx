import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapPin } from './MapView';
import { colors, memberColors } from '../theme';

const TONE: Record<NonNullable<MapPin['tone']>, string> = {
  base: colors.ink, day: colors.accent, shortlist: colors.want, been: colors.like, special: '#B0771E', muted: colors.inkFaint,
};

function Fit({ pins }: { pins: MapPin[] }) {
  const map = useMap();
  useEffect(() => {
    if (!pins.length) return;
    if (pins.length === 1) { map.setView([pins[0].lat, pins[0].lng], 14); return; }
    map.fitBounds(pins.map((p) => [p.lat, p.lng] as [number, number]), { padding: [24, 24], maxZoom: 15 });
  }, [pins.map((p) => `${p.lat},${p.lng}`).join('|')]);
  return null;
}

/**
 * The map every trip planner has (Wanderlog, Stippl, Mindtrip) — OpenStreetMap
 * tiles, pins coloured by meaning: base, today's stops, shortlist, been, special.
 */
export function MapView({ pins, center, height = 320, fit = true }: { pins: MapPin[]; center?: { lat: number; lng: number }; height?: number; fit?: boolean }) {
  const c = center ?? (pins[0] ? { lat: pins[0].lat, lng: pins[0].lng } : { lat: 51.5, lng: -0.12 });
  const valid = useMemo(() => pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)), [pins]);
  return (
    <View style={{ height, borderRadius: 12, overflow: 'hidden' }}>
      <MapContainer center={[c.lat, c.lng]} zoom={13} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {fit ? <Fit pins={valid} /> : null}
        {valid.map((p) => {
          const color = p.tone === 'day' && p.dayIndex != null ? memberColors[p.dayIndex % memberColors.length] : TONE[p.tone ?? 'muted'];
          return (
            <CircleMarker key={p.id} center={[p.lat, p.lng]} radius={p.tone === 'base' ? 10 : 7} pathOptions={{ color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.95 }} eventHandlers={p.onPress ? { click: p.onPress } : undefined}>
              <Tooltip direction="top" offset={[0, -6]}>{p.label}</Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </View>
  );
}

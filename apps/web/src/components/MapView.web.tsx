import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { MapContainer, TileLayer, CircleMarker, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapLine, MapPin } from './MapView';
import { colors, memberColors } from '../theme';

const TONE: Record<NonNullable<MapPin['tone']>, string> = {
  base: colors.ink, day: colors.accent, shortlist: colors.want, been: colors.like, special: '#B0771E', muted: colors.inkFaint,
  full: colors.overrun, aside: '#fff', home: '#B0771E', selected: colors.want,
};

/** A numbered pin: the journey's order drawn on the marker, so the list and the map read the same. */
function numberedIcon(p: MapPin, color: string, selected: boolean) {
  const size = selected ? 34 : 28;
  const aside = p.tone === 'aside';
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${aside ? '#fff' : color};border:2px ${aside ? 'dashed' : 'solid'} ${aside ? colors.inkFaint : '#fff'};box-shadow:0 2px 5px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;${selected ? `outline:4px solid ${colors.wantSoft};` : ''}"><span style="transform:rotate(45deg);color:${aside ? colors.inkFaint : '#fff'};font:700 ${selected ? 13 : 12}px/1 -apple-system,Inter,Segoe UI,Helvetica,sans-serif">${String(p.number ?? '')}</span></div>`;
  return L.divIcon({ html, className: 'roam-pin', iconSize: [size, size], iconAnchor: [size / 2, size], tooltipAnchor: [0, -size] });
}

/** Pan to the chosen pin (a tapped row) without refitting everything. */
function Focus({ pin }: { pin: MapPin | null }) {
  const map = useMap();
  useEffect(() => {
    if (!pin) return;
    map.panTo([pin.lat, pin.lng], { animate: true });
    if (map.getZoom() < 14) map.setZoom(15);
  }, [pin?.id]);
  return null;
}

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
export function MapView({ pins, lines = [], center, height = 320, fit = true, focusId }: { pins: MapPin[]; lines?: MapLine[]; center?: { lat: number; lng: number }; height?: number; fit?: boolean; focusId?: string | null }) {
  const c = center ?? (pins[0] ? { lat: pins[0].lat, lng: pins[0].lng } : { lat: 51.5, lng: -0.12 });
  const valid = useMemo(() => pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)), [pins]);
  const focused = focusId ? valid.find((p) => p.id === focusId) ?? null : null;
  return (
    <View style={{ height, borderRadius: 12, overflow: 'hidden' }}>
      <MapContainer center={[c.lat, c.lng]} zoom={13} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {fit ? <Fit pins={valid} /> : null}
        <Focus pin={focused} />
        {lines.map((l) => <Polyline key={l.id} positions={l.points.map((pt) => [pt.lat, pt.lng] as [number, number])} pathOptions={{ color: l.color ?? colors.want, weight: 3, dashArray: l.dashed ? '6 6' : undefined, opacity: 0.9 }} />)}
        {valid.map((p) => {
          const color = p.tone === 'day' && p.dayIndex != null ? memberColors[p.dayIndex % memberColors.length] : TONE[p.tone ?? 'muted'];
          const isFocus = focused?.id === p.id;
          if (p.number != null) {
            return (
              <Marker key={p.id} position={[p.lat, p.lng]} icon={numberedIcon(p, isFocus ? TONE.selected : color, isFocus)} zIndexOffset={isFocus ? 1000 : 0} eventHandlers={p.onPress ? { click: p.onPress } : undefined}>
                <Tooltip direction="top">{p.label}</Tooltip>
              </Marker>
            );
          }
          return (
            <CircleMarker key={p.id} center={[p.lat, p.lng]} radius={isFocus ? 12 : p.tone === 'base' ? 10 : 7} pathOptions={{ color: isFocus ? colors.ink : '#fff', weight: isFocus ? 3 : 2, fillColor: color, fillOpacity: isFocus ? 1 : focused ? 0.6 : 0.95 }} eventHandlers={p.onPress ? { click: p.onPress } : undefined}>
              <Tooltip direction="top" offset={[0, -6]} permanent={isFocus}>{p.label}</Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </View>
  );
}

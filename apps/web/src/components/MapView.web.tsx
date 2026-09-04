import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { MapContainer, TileLayer, CircleMarker, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapLine, MapPin } from './MapView';
import { colors, memberColors } from '../theme';

const TONE: Record<NonNullable<MapPin['tone']>, string> = {
  base: colors.ink, day: colors.accent, shortlist: colors.want, been: colors.like, special: colors.red, muted: colors.inkFaint,
  full: colors.overrun, aside: '#fff', home: colors.ink, selected: colors.want, hollow: colors.ink,
};

const HEART = `<span style="position:absolute;right:-7px;top:-7px;width:15px;height:15px;border-radius:50%;background:${colors.bg};display:flex;align-items:center;justify-content:center"><svg width="10" height="10" viewBox="0 0 24 24" fill="${colors.red}" stroke="${colors.red}" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></span>`;

/** A numbered pin: the journey's order drawn on the marker, so the list and the map read the same. */
function numberedIcon(p: MapPin, color: string, selected: boolean) {
  const plain = p.number === '';
  const size = selected ? (plain ? 30 : 34) : plain ? 24 : 28;
  const aside = p.tone === 'aside';
  // A hollow pin is "to try": the ground colour with an ink outline (style guide: filled for been, hollow for to try).
  const hollow = p.tone === 'hollow';
  const bg = aside || hollow ? colors.bg : color;
  const border = aside ? colors.inkFaint : hollow ? colors.ink : colors.bg;
  const html = `<div style="position:relative;width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${bg};border:2px ${aside ? 'dashed' : 'solid'} ${border};display:flex;align-items:center;justify-content:center;${selected ? `outline:3px solid ${colors.icon};outline-offset:2px;` : ''}"><span style="transform:rotate(45deg);color:${aside ? colors.inkFaint : colors.bg};font:700 ${selected ? 13 : 12}px/1 Archivo,-apple-system,Inter,Segoe UI,Helvetica,sans-serif">${String(p.number ?? '')}</span>${p.heart ? `<span style="position:absolute;right:-1px;top:-1px;transform:rotate(45deg)">${HEART}</span>` : ''}</div>`;
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

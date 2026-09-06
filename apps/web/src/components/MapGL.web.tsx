/**
 * The map-first canvas on the web: MapLibre GL, Roam's own style, Roam's own
 * markers.
 *
 * Why MapLibre and not Apple or Google (owner asked, 6 Sep 2026):
 *
 *   · **No key.** The web bundle may never hold a provider key (CLAUDE.md), and
 *     the surest way to obey that is not to have one. MapKit JS needs a signed
 *     token; Google Maps JS needs a browser key.
 *   · **No per-view bill.** Google bills per map load. A map on every trip
 *     screen is then a recurring cost with no ceiling.
 *   · **The style is ours**, which is where the polish in the Airbnb
 *     screenshots actually comes from — they are Google's tiles with Airbnb's
 *     style on them, and default Google looks nothing like them.
 *   · **The basemap is swappable.** Markers, routes, the sheet and every
 *     interaction are ours; the basemap is one style object. Changing our mind
 *     later is a change to `mapStyle.ts`, not a rebuild of the screen.
 *
 * Markers are HTML, not sprites in the tile, so they use the app's own icon set
 * and its own colours and stay crisp at any zoom.
 */

import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapGLProps, MapMarker } from './MapGL';
import { roamMapStyle } from './mapStyle';
import { colors } from '../theme';

/** The Lucide paths the markers use, inlined: a marker is drawn before React has a chance to. */
const GLYPH: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  bed: '<path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M2 16h20"/><path d="M6 10V7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
  sparkles: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/>',
  utensils: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 3c-1.5 1-2 3-2 5s.5 3 2 3v10"/>',
  bookmark: '<path d="M5 3h14v18l-7-5-7 5z"/>',
  flag: '<path d="M5 21V4h13l-2 4 2 4H5"/>',
  car: '<path d="M5 13h14M6.5 13 8 8h8l1.5 5M6 17h1M17 17h1"/><rect x="4" y="13" width="16" height="4" rx="1"/>',
  tree: '<path d="M12 3 6 12h3l-3 5h12l-3-5h3z"/><path d="M12 17v4"/>',
  camera: '<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3"/>',
  ticket: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1 0 4H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4z"/>',
  place: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
};

/** Each kind's shape, from the handoff's design tokens. */
const KIND: Record<MapMarker['kind'], { size: number; bg: string; border: string; borderWidth: number; dashed?: boolean; fg: string; halo?: boolean }> = {
  home: { size: 26, bg: '#FFFFFF', border: '#201E1D', borderWidth: 2.5, fg: '#201E1D' },
  base: { size: 26, bg: '#FFFFFF', border: '#201E1D', borderWidth: 2.5, fg: '#201E1D' },
  dest: { size: 30, bg: '#EC3013', border: '#FFFFFF', borderWidth: 2.5, fg: '#FFFFFF', halo: true },
  browse: { size: 26, bg: '#FFFFFF', border: '#201E1D', borderWidth: 2, fg: '#201E1D' },
  added: { size: 28, bg: '#201E1D', border: '#FFFFFF', borderWidth: 2, fg: '#FFFFFF' },
  saved: { size: 22, bg: '#FFFFFF', border: '#201E1D', borderWidth: 1.5, dashed: true, fg: '#201E1D' },
};

function markerEl(m: MapMarker): HTMLElement {
  const k = KIND[m.kind];
  const wrap = document.createElement('div');
  // The dot is centred on the point and the label hangs off it absolutely, so
  // a long label never shoves the pin off the place it is marking.
  wrap.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;cursor:pointer;will-change:transform';
  const size = m.selected ? k.size + 4 : k.size;
  const glyph = GLYPH[m.icon ?? ''] ?? GLYPH.place;
  const dot = document.createElement('div');
  dot.style.cssText = [
    `width:${size}px`, `height:${size}px`, 'border-radius:999px',
    `background:${k.bg}`, `border:${k.borderWidth}px ${k.dashed ? 'dashed' : 'solid'} ${k.border}`,
    'display:flex', 'align-items:center', 'justify-content:center',
    // The destination's ink halo, and a ring on whatever is selected.
    k.halo ? 'box-shadow:0 0 0 1.5px #201E1D' : 'box-shadow:0 1px 4px rgba(32,30,29,0.22)',
    m.selected ? 'outline:3px solid #2E8A63;outline-offset:2px' : '',
    'transition:width 120ms ease-out,height 120ms ease-out',
  ].join(';');
  dot.innerHTML = `<svg width="${Math.round(size * 0.55)}" height="${Math.round(size * 0.55)}" viewBox="0 0 24 24" fill="none" stroke="${k.fg}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg>`;
  wrap.appendChild(dot);
  if (m.label) {
    const tag = document.createElement('div');
    // An added stop's label is ink on white; everything else is white on ink,
    // which is what the handoff draws and what stays readable over green.
    const onInk = m.kind !== 'home' && m.kind !== 'base';
    tag.textContent = m.label;
    tag.style.cssText = [
      'position:absolute', 'top:100%', 'left:50%', 'transform:translate(-50%,4px)',
      'padding:3px 7px', 'border-radius:999px',
      onInk ? 'background:#201E1D;color:#FFFFFF' : 'background:#FFFFFF;color:#201E1D;border:1px solid #E5EFEA',
      'font:700 11px/1.1 Archivo,-apple-system,Segoe UI,Helvetica,sans-serif',
      'white-space:nowrap', 'pointer-events:none',
      'box-shadow:0 1px 4px rgba(32,30,29,0.18)',
    ].join(';');
    wrap.appendChild(tag);
  }
  if (m.onPress) {
    /**
     * A click is only a press if this element saw the press that started it.
     *
     * Without that check, a drag on the sheet that finishes with the pointer
     * over the map ends in a `click` on whatever marker happens to be under it
     * — so every upward drag selected a random place and shrank the sheet
     * again. A click with no pointerdown of its own is somebody else's gesture
     * ending here, not a tap.
     */
    let armed = false;
    wrap.addEventListener('pointerdown', () => { armed = true; });
    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed) return;
      armed = false;
      m.onPress!();
    });
  }
  return wrap;
}

export function MapGL({ markers, routes = [], padding, fitKey, focusId, onMapPress, dark }: MapGLProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const drawn = useRef(new Map<string, maplibregl.Marker>());
  const ready = useRef(false);

  const pad = {
    top: padding?.top ?? 24, bottom: padding?.bottom ?? 24,
    left: padding?.left ?? 24, right: padding?.right ?? 24,
  };
  const padRef = useRef(pad);
  padRef.current = pad;

  // One map, for the life of the screen.
  useEffect(() => {
    if (!host.current || map.current) return;
    const m = new maplibregl.Map({
      container: host.current,
      style: roamMapStyle(dark),
      center: [-0.6, 51.4],
      zoom: 9,
      // Added by hand below, so that where it sits can be chosen.
      attributionControl: false,
      // The map is a thing you drive (owner, 6 Sep 2026), so nothing is disabled.
      dragRotate: true,
      pitchWithRotate: true,
    });
    // No zoom buttons: the design has none, and the map is driven by hand.
    // The credit goes top-right, because the bottom of the map is under the
    // sheet and OpenStreetMap's credit being visible is a condition of using
    // the tiles, not a decoration that may be covered up.
    const credit = new maplibregl.AttributionControl({ compact: true });
    m.addControl(credit, 'top-right');
    /**
     * Collapsed to its ⓘ, and kept that way until somebody taps it.
     *
     * MapLibre opens the compact control on load and on every style change, and
     * a banner of source names across the top of the map is not what the
     * licence asks for — it asks that the credit be *reachable*, which one tap
     * is. So the class is taken off whenever it comes back, and the ⓘ still
     * opens it.
     */
    const collapse = () => {
      const el = host.current?.querySelector('.maplibregl-ctrl-attrib');
      if (el && !el.getAttribute('data-roam-opened')) el.classList.remove('maplibregl-compact-show');
    };
    const watch = new MutationObserver(collapse);
    requestAnimationFrame(() => {
      const el = host.current?.querySelector('.maplibregl-ctrl-attrib');
      collapse();
      // A tap on the ⓘ is somebody asking for it, and it stays open after that.
      el?.querySelector('.maplibregl-ctrl-attrib-button')?.addEventListener('click', () => el.setAttribute('data-roam-opened', '1'));
      if (el) watch.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
    m.on('load', () => { ready.current = true; });
    // The same rule for the map itself: a click that began somewhere else — the
    // tail of a drag on the sheet — is not a tap on the map.
    let pressed = false;
    m.on('mousedown', () => { pressed = true; });
    m.on('touchstart', () => { pressed = true; });
    m.on('click', () => { if (!pressed) return; pressed = false; onMapPress?.(); });
    map.current = m;
    return () => { watch.disconnect(); m.remove(); map.current = null; ready.current = false; };
  }, []);

  // The palette changed under it (light ↔ dark).
  useEffect(() => { if (map.current && ready.current) map.current.setStyle(roamMapStyle(dark)); }, [dark]);

  // The route, as a source and two layers: a soft casing and the line itself,
  // so it reads over both the green and the water.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      const data = {
        type: 'FeatureCollection',
        features: routes.map((r) => ({
          type: 'Feature',
          properties: { dashed: r.dashed ? 1 : 0 },
          geometry: { type: 'LineString', coordinates: r.points.map((p) => [p.lng, p.lat]) },
        })),
      } as any;
      const src = m.getSource('roam-route') as maplibregl.GeoJSONSource | undefined;
      if (src) { src.setData(data); return; }
      m.addSource('roam-route', { type: 'geojson', data });
      m.addLayer({
        id: 'roam-route-casing', type: 'line', source: 'roam-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#FFFFFF', 'line-width': 7, 'line-opacity': 0.9 },
      });
      m.addLayer({
        id: 'roam-route-line', type: 'line', source: 'roam-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#201E1D',
          'line-width': 3,
          'line-dasharray': ['case', ['==', ['get', 'dashed'], 1], ['literal', [2, 2]], ['literal', [1, 0]]] as any,
        },
      });
    };
    if (ready.current) apply(); else m.once('load', apply);
  }, [JSON.stringify(routes.map((r) => [r.id, r.points.length, r.dashed]))]);

  // Markers, diffed by id so a re-render does not tear the map apart.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const want = new Set(markers.map((x) => x.id));
    for (const [id, marker] of drawn.current) if (!want.has(id)) { marker.remove(); drawn.current.delete(id); }
    for (const spec of markers) {
      const existing = drawn.current.get(spec.id);
      if (existing) existing.remove();
      const marker = new maplibregl.Marker({ element: markerEl(spec), anchor: 'center' })
        .setLngLat([spec.lng, spec.lat])
        .addTo(m);
      drawn.current.set(spec.id, marker);
    }
  }, [markers]);

  // Fit everything into the part of the map that is not under the sheet.
  useEffect(() => {
    const m = map.current;
    if (!m || !markers.length) return;
    const fit = () => {
      const b = new maplibregl.LngLatBounds();
      for (const x of markers) b.extend([x.lng, x.lat]);
      for (const r of routes) for (const p of r.points) b.extend([p.lng, p.lat]);
      m.fitBounds(b, { padding: padRef.current, maxZoom: 15, duration: 550 });
    };
    if (ready.current) fit(); else m.once('load', fit);
  }, [fitKey]);

  // One pin chosen from the list: pan to it, above the sheet, without refitting.
  useEffect(() => {
    const m = map.current;
    if (!m || !focusId) return;
    const hit = markers.find((x) => x.id === focusId);
    if (!hit) return;
    m.easeTo({
      center: [hit.lng, hit.lat],
      zoom: Math.max(m.getZoom(), 13.5),
      // Shift the centre up by half of what the sheet covers, so the pin lands
      // in the visible band rather than behind it.
      offset: [0, -Math.round(((padRef.current.bottom ?? 0) - (padRef.current.top ?? 0)) / 2)],
      duration: 450,
    });
  }, [focusId]);

  // The sheet moved: the visible middle of the map moved with it.
  useEffect(() => {
    if (map.current && ready.current) map.current.resize();
  }, [pad.bottom]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceMuted }}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
    </View>
  );
}

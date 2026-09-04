// The wait, drawn (owner, 4 Sep 2026; signed off from /mockups/waiting-options.html).
//
// A search takes seconds, and a spinner spends them saying nothing. This spends
// them saying where we are looking: the country, then the town, then the ground
// the search actually covers, with the real areas inside it named, and a lens
// going over them while the sources answer.
//
// Three rules keep it honest, and they are the whole point of it:
//
//   1. The search sets the clock. Under 300ms nothing is drawn at all. If the
//      answer lands while the opening is still running the beats speed up
//      rather than cutting, and the map is gone within half a second.
//   2. Every word on screen is something that happened. Sources are named when
//      they are asked, ticked when they answer, and the count is the count they
//      returned — it comes from the stream (`/shortlist/search/stream`), not
//      from a timer pretending to be progress.
//   3. Nothing rented is drawn. The pins are places' positions and nothing
//      else: no names, no ratings, no photographs. Until the pool is ranked
//      there is nothing to show, and those are not ours to scatter over a map.
//
// The geometry is real and open: Natural Earth for the coast, OpenStreetMap for
// the areas, both through /api/atlas/sketch, which answers from what is stored
// and never holds a search up.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, LayoutChangeEvent, Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Path, Rect, Text as SvgText, Use } from 'react-native-svg';
import { api, SketchMap, SketchEvent } from '../api';
import { useViewport } from '../hooks/useViewport';
import { colors, radius, spacing, type } from '../theme';
import { Button, Chip, Row, Wrap } from './ui';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------
// Geometry. One projection for the coast and the boroughs both, so the camera
// can fly from one to the other without reprojecting anything.
// ---------------------------------------------------------------------------

type Box = [number, number, number, number];

export const mercator = (lon: number, lat: number): [number, number] => [
  lon,
  -(180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + Math.max(-84, Math.min(84, lat)) * Math.PI / 360)),
];
const kmPerUnit = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const pad = (b: Box, f: number): Box => [b[0] - b[2] * f, b[1] - b[3] * f, b[2] * (1 + 2 * f), b[3] * (1 + 2 * f)];
/** A viewBox of the panel's shape that contains the box — never squashed. */
function fit(b: Box, aspect: number): Box {
  let [x, y, w, h] = b;
  const cx = x + w / 2; const cy = y + h / 2;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  return [cx - w / 2, cy - h / 2, w, h];
}
function boxOf(d: string): Box {
  const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i + 1 < n.length; i += 2) {
    x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]); y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1]);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}
const union = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b[0])); const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2])); const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
};
/** How long a path is, in map units, so it can be drawn on rather than faded in. */
function pathLength(d: string): number {
  let len = 0;
  for (const sub of d.split('M').filter(Boolean)) {
    const pts = sub.replace(/Z/g, '').split('L').map((p) => p.split(',').map(Number));
    for (let i = 1; i < pts.length; i += 1) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return len || 1;
}
/** A circle as a path, because that is what the search covers: a radius, not a guess at one. */
function circlePath(cx: number, cy: number, r: number, steps = 96): string {
  const pts: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(4)},${(cy + r * Math.sin(a)).toFixed(4)}`);
  }
  return `M${pts.join('L')}Z`;
}

// ---------------------------------------------------------------------------
// The beats. The opening is framing, not progress: it says where we are, and it
// is over in three and a half seconds whatever the search is doing.
// ---------------------------------------------------------------------------

const B = { held: 0.85, city: 2.25, toGround: 2.55, ground: 3.45, areas: 3.55, sweep: 4.6 };
/** Below this a search is instant, and the kindest thing to draw is nothing. */
export const SKETCH_FLOOR_MS = 300;

export type SketchVariant = 'strip' | 'notes';

export function SearchSketch({
  variant = 'notes', centre, radiusKm, countryCode, placeLabel,
  events, done, onStop, onSettled, mapHeight,
}: {
  variant?: SketchVariant;
  centre: { lat: number; lng: number };
  radiusKm: number;
  countryCode?: string | null;
  /** What the household calls where they are searching, until the map knows better. */
  placeLabel?: string | null;
  events: SketchEvent[];
  done: boolean;
  onStop?: () => void;
  onSettled?: () => void;
  mapHeight?: number;
}) {
  // The frame's size, never the window's (CLAUDE.md): in the shell's Mobile
  // view the map must be a phone's map.
  const { height: viewportHeight } = useViewport();
  const [map, setMap] = useState<SketchMap | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [t, setT] = useState(0);
  const [shown, setShown] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (live) setReduced(Boolean(v)); }).catch(() => null);
    return () => { live = false; };
  }, []);

  // The map of where we are looking. It answers from what the API already
  // holds, so it is usually there before the first beat is over; the first
  // search in a new town draws the country and one named area, and the rest
  // arrives in time for the next one.
  useEffect(() => {
    let live = true;
    api.atlasSketch({ lat: centre.lat, lng: centre.lng, radiusKm, country: countryCode ?? undefined })
      .then((m) => { if (live) setMap(m); })
      .catch(() => null);
    return () => { live = false; };
  }, [centre.lat, centre.lng, radiusKm, countryCode]);

  // Nothing at all for the first 300ms: a search that answers in a blink should
  // look like it answered in a blink.
  useEffect(() => {
    const id = setTimeout(() => setShown(true), SKETCH_FLOOR_MS);
    return () => clearTimeout(id);
  }, []);

  // One clock. When the answer lands the remaining beats are compressed rather
  // than cut, and the map bows out.
  const doneAt = useRef<number | null>(null);
  const settled = useRef(false);
  const ready = useRef(false);
  const settle = useRef(onSettled);
  settle.current = onSettled;
  useEffect(() => {
    if (done && doneAt.current == null) doneAt.current = performance.now();
  }, [done]);
  // The map has to be here before the camera sets off, or the opening plays to
  // an empty room and the country arrives after we have left it. It comes from
  // what the API already holds, so this is normally the same frame.
  useEffect(() => { if (map) ready.current = true; }, [map]);
  useEffect(() => {
    if (reduced) { setT(B.sweep + 0.4); return undefined; }
    let raf = 0;
    const mounted = performance.now();
    let last = mounted; let clock = 0;
    const loop = () => {
      const now = performance.now();
      // A sketch that never arrives is not a reason to stand still: after
      // 700ms the camera starts anyway and draws the ground on its own.
      if (ready.current || now - mounted > 700) {
        const rate = doneAt.current != null ? 2.5 : 1;
        clock += ((now - last) / 1000) * rate;
        setT(clock);
      }
      last = now;
      if (doneAt.current != null && (clock > B.areas || now - doneAt.current > 350) && !settled.current) {
        settled.current = true;
        settle.current?.();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // Deliberately once: the caller's onSettled is held in a ref, because an
    // inline arrow would restart the clock on every render.
  }, [reduced]);

  // What has actually happened, read off the stream.
  const asked = useMemo(() => {
    const a = events.find((e) => e.type === 'asking');
    return a && a.type === 'asking' ? a.sources : [];
  }, [events]);
  const answered = useMemo(() => events.filter((e) => e.type === 'answered') as Extract<SketchEvent, { type: 'answered' }>[], [events]);
  const failed = useMemo(() => events.filter((e) => e.type === 'failed') as Extract<SketchEvent, { type: 'failed' }>[], [events]);
  const cached = events.some((e) => e.type === 'cached');
  const joining = events.some((e) => e.type === 'joining');
  const waited = events.some((e) => e.type === 'waiting');
  const found = answered.reduce((n, e) => n + e.count, 0);
  const outstanding = asked.filter((s) => !answered.some((a) => a.source === s.key) && !failed.some((f) => f.source === s.key));

  // Pins are the positions that came back, and nothing else about them.
  const pins = useMemo(() => {
    const out: [number, number][] = [];
    for (const e of answered) for (const [lat, lng] of e.points) { if (out.length < 40) out.push(mercator(lng, lat)); }
    return out;
  }, [answered]);

  if (!shown) return null;

  const areas = map?.areas ?? [];
  const place = map?.place ?? placeLabel ?? null;
  const [gx, gy] = mercator(centre.lng, centre.lat);
  const groundR = radiusKm / kmPerUnit(centre.lat);
  const ground = circlePath(gx, gy, groundR);
  const groundBox = pad([gx - groundR, gy - groundR, groundR * 2, groundR * 2] as Box, 0.16);
  const cityBox = pad(union(areas.map((a) => boxOf(a.d))) ?? [gx - groundR * 5, gy - groundR * 5, groundR * 10, groundR * 10] as Box, 0.08);
  // The country is framed on its main landmass, so a search on an island that
  // belongs to it — Northern Ireland, the Azores, Hawaii — has to pull the
  // frame out to include where we are actually looking.
  const countryBox = map?.country ? pad(union([map.country.box as Box, [gx - groundR, gy - groundR, groundR * 2, groundR * 2]])!, 0.06) : null;
  // On a phone the map takes about a third of the screen, so what the search is
  // doing is readable underneath it without scrolling.
  const height = mapHeight ?? (variant === 'strip' ? 132 : Math.max(200, Math.min(320, Math.round(viewportHeight * 0.32))));

  return (
    <View style={variant === 'strip' ? styles.strip : undefined}>
      <View
        style={[styles.map, { height }, variant === 'strip' && styles.mapRounded]}
        onLayout={(e: LayoutChangeEvent) => {
          const { width, height: h } = e.nativeEvent.layout;
          if (Math.abs(width - size.w) > 1 || Math.abs(h - size.h) > 1) setSize({ w: width, h });
        }}
      >
        {size.w > 0 ? (
          <Scene
            t={reduced ? B.sweep + 0.4 : t} reduced={reduced} w={size.w} h={size.h}
            country={map?.country ?? null} countryBox={countryBox} cityBox={cityBox} groundBox={groundBox}
            areas={areas} ground={ground} centre={[gx, gy]} pins={pins}
          />
        ) : null}
        {place ? <Text style={styles.beat}>{beatLabel(t, map, place, radiusKm, reduced)}</Text> : null}
      </View>

      {variant === 'strip' ? (
        <Row style={{ gap: 8, paddingTop: 8 }}>
          <Mark done={done} />
          <Text style={type.small} numberOfLines={1}>{stripLine({ t, place, radiusKm, areas, asked, answered, failed, found, cached, joining })}</Text>
        </Row>
      ) : (
        <View style={{ paddingTop: spacing.md, gap: 6 }}>
          <Text style={type.h2}>{place ? `Looking around ${place}` : 'Looking'}</Text>
          {areas.length > 1 ? (
            <Wrap style={{ gap: 6 }}>
              {areas.slice(0, 6).map((a, i) => <Chip key={a.ref} label={a.name} selected={t > B.areas + i * 0.28} />)}
            </Wrap>
          ) : null}
          <View style={{ marginTop: 4 }}>
            <Line done={t > B.ground}>
              Everywhere within <Text style={styles.strong}>{radiusKm} km</Text>{place ? ` of ${place}` : ''}
            </Line>
            <Line done={!outstanding.length && asked.length > 0} pending={!asked.length}>
              {cached ? 'Already held from earlier — nothing asked'
                : joining ? 'Waiting on the same search, already running'
                : !asked.length ? 'Asking'
                : outstanding.length
                  ? `${waited ? 'Still waiting on ' : 'Asking '}${outstanding.map((s) => s.label).join(', ')}`
                  : `Asked ${asked.map((s) => s.label).join(', ')}`}
            </Line>
            <Line done={done} pending={!answered.length && !cached}>
              <Text style={styles.strong}>{found}</Text> {found === 1 ? 'place' : 'places'} so far
            </Line>
            {failed.length ? (
              <Line done failed>
                {failed.map((f) => f.label).join(', ')} did not answer
              </Line>
            ) : null}
          </View>
          {onStop ? (
            <Row style={{ gap: 8, paddingTop: 4 }}>
              <Button label="Stop" kind="secondary" onPress={onStop} />
              {found > 0 ? <Text style={type.tiny}>Stop keeps the {found} already found</Text> : null}
            </Row>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** What the camera is looking at, said in words for anyone who cannot see it. */
function beatLabel(t: number, map: SketchMap | null, place: string, radiusKm: number, reduced: boolean) {
  if (reduced) return `${radiusKm} km around ${place}`;
  if (map?.country && t < B.city - 0.55) return map.country.name;
  if (t < B.toGround + 0.35) return place;
  return `${radiusKm} km around ${place}`;
}

function stripLine({ t, place, radiusKm, areas, asked, answered, failed, found, cached, joining }: any) {
  if (cached) return `${found} places, already held`;
  if (joining) return 'Waiting on the same search, already running';
  if (t < B.toGround) return `Working out ${radiusKm} km around ${place ?? 'you'}`;
  if (t < B.sweep && areas.length > 1) return `Looking through ${areas.slice(0, 3).map((a: any) => a.name).join(', ')}`;
  if (failed.length) return `${failed.map((f: any) => f.label).join(', ')} did not answer · ${found} places`;
  if (!asked.length || answered.length < asked.length) return `${found} places so far`;
  return `${found} ${found === 1 ? 'place' : 'places'}, closest first`;
}

function Mark({ done }: { done: boolean }) {
  return done
    ? <Icon name="check" size={16} color={colors.accent} />
    : <View style={styles.dot} />;
}

function Line({ children, done, pending, failed }: { children: React.ReactNode; done?: boolean; pending?: boolean; failed?: boolean }) {
  return (
    <Row style={styles.line}>
      <View style={styles.lineMark}>
        {done && !failed ? <Icon name="check" size={16} color={colors.accent} />
          : failed ? <Icon name="close" size={15} color={colors.inkFaint} />
          : <View style={[styles.dot, pending && { opacity: 0.4 }]} />}
      </View>
      <Text style={[type.small, done && { color: colors.ink }]}>{children}</Text>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// The drawing itself.
// ---------------------------------------------------------------------------

function Scene({ t, reduced, w, h, country, countryBox, cityBox, groundBox, areas, ground, centre, pins }: {
  t: number; reduced: boolean; w: number; h: number;
  country: SketchMap['country']; countryBox: Box | null; cityBox: Box; groundBox: Box;
  areas: SketchMap['areas']; ground: string; centre: [number, number]; pins: [number, number][];
}) {
  const aspect = w / Math.max(1, h);
  const boxes = useMemo(() => ({
    country: countryBox ? fit(countryBox, aspect) : null,
    city: fit(cityBox, aspect),
    ground: fit(groundBox, aspect),
  }), [countryBox, cityBox, groundBox, aspect]);
  const coastLen = useMemo(() => (country ? pathLength(country.d) : 1), [country]);

  // A search in a place we have no country outline for simply starts at the town.
  const start = boxes.country ? 0 : B.city;
  const tt = reduced ? B.sweep + 0.4 : Math.max(t, start);

  let view: Box;
  if (boxes.country && tt < B.city) view = tween(boxes.country, boxes.city, (tt - B.held) / (B.city - B.held));
  else if (tt < B.ground) view = tween(boxes.city, boxes.ground, (tt - B.toGround) / (B.ground - B.toGround));
  else view = boxes.ground;
  if (!reduced && tt > B.sweep) {
    const d = tt - B.sweep;
    view = [view[0] + Math.sin(d * 0.35) * view[2] * 0.012, view[1] + Math.cos(d * 0.28) * view[3] * 0.012, view[2], view[3]];
  }
  // Map units per screen pixel: everything that must stay the same size on
  // screen — a label, a pin, a line's width — is multiplied by this.
  const u = view[2] / Math.max(1, w);

  const coastIn = clamp(tt / B.held, 0, 1);
  const countryFade = 1 - clamp((tt - B.held - 0.15) / (B.city - B.held - 0.15), 0, 1);
  const areasIn = clamp((tt - B.areas) / 0.5, 0, 1);
  const groundIn = clamp((tt - B.toGround) / (B.ground - B.toGround), 0, 1);
  const sweeping = !reduced && tt > B.sweep - 0.5;
  const d = Math.max(0, tt - (B.sweep - 0.5));
  const lens: [number, number] = [
    centre[0] + (Math.cos(d * 0.85) * 0.42 + Math.cos(d * 0.31) * 0.22) * (groundBox[2] / 2),
    centre[1] + (Math.sin(d * 0.72) * 0.38 + Math.sin(d * 0.44) * 0.18) * (groundBox[3] / 2),
  ];

  return (
    <Svg width="100%" height="100%" viewBox={view.join(' ')}>
      <Defs>
        <ClipPath id="roam-lens">
          <Circle cx={lens[0]} cy={lens[1]} r={33 * u} />
        </ClipPath>
      </Defs>

      <G id="roam-sketch">
        {country ? (
          <>
            <Path d={country.d} fill={colors.surfaceMuted} opacity={clamp((tt - 0.35) / 0.5, 0, 1) * 0.9 * countryFade} />
            <Path
              d={country.d} fill="none" stroke={colors.ink} strokeWidth={1.1 * u}
              strokeLinejoin="round" strokeLinecap="round" opacity={countryFade}
              strokeDasharray={[coastLen]} strokeDashoffset={coastLen * (1 - ease(coastIn))}
            />
          </>
        ) : null}

        {/* The ground the search covers: a radius, drawn as the circle it is. */}
        <Path d={ground} fill={colors.mint} opacity={groundIn * 0.18} />
        <Path
          d={ground} fill="none" stroke={colors.ink} strokeWidth={2.1 * u} opacity={groundIn * 0.85}
          strokeDasharray={groundIn < 1 ? [pathLength(ground)] : [7 * u, 5 * u]}
          strokeDashoffset={groundIn < 1 ? pathLength(ground) * (1 - ease(groundIn)) : 0}
        />

        {areas.map((a, i) => {
          const on = clamp((tt - (B.areas + i * 0.28)) / 0.45, 0, 1) * areasIn;
          return <Path key={a.ref} d={a.d} fill="none" stroke={colors.accent} strokeWidth={1.2 * u} strokeLinejoin="round" opacity={on * 0.75} />;
        })}

        {pins.map(([px, py], i) => (
          <Circle key={i} cx={px} cy={py} r={3.2 * u} fill={colors.accent} opacity={0.9} />
        ))}

        <Circle cx={centre[0]} cy={centre[1]} r={7 * u} fill={colors.bg} stroke={colors.ink} strokeWidth={2 * u} opacity={clamp((tt - 0.55) / 0.4, 0, 1)} />
        <Circle cx={centre[0]} cy={centre[1]} r={2.8 * u} fill={colors.ink} opacity={clamp((tt - 0.55) / 0.4, 0, 1)} />
      </G>

      {/* Names sit above the map and outside the lens, so nothing is ever read twice. */}
      {areas.map((a, i) => {
        const on = clamp((tt - (B.areas + 0.15 + i * 0.28)) / 0.4, 0, 1) * areasIn;
        if (on <= 0) return null;
        // Twice: a paper-coloured outline underneath so the name reads over a
        // boundary or a pin, then the name itself.
        return (
          <G key={a.ref} opacity={on}>
            <SvgText x={a.cx} y={a.cy} fontSize={13 * u} fontWeight="600" textAnchor="middle" fill="none" stroke={colors.bg} strokeWidth={3.5 * u}>{a.name}</SvgText>
            <SvgText x={a.cx} y={a.cy} fontSize={13 * u} fontWeight="600" textAnchor="middle" fill={colors.headerSub}>{a.name}</SvgText>
          </G>
        );
      })}

      {sweeping ? (
        <>
          {Platform.OS === 'web' ? (
            <G clipPath="url(#roam-lens)" opacity={clamp(d / 0.4, 0, 1)}>
              <Use href="#roam-sketch" transform={`translate(${lens[0] * -0.55} ${lens[1] * -0.55}) scale(1.55)`} />
            </G>
          ) : null}
          <Circle cx={lens[0]} cy={lens[1]} r={33 * u} fill="none" stroke={colors.ink} strokeWidth={2.6 * u} opacity={clamp(d / 0.4, 0, 1)} />
          <Path
            d={`M${lens[0] + 23 * u},${lens[1] + 23 * u}L${lens[0] + 40 * u},${lens[1] + 40 * u}`}
            stroke={colors.ink} strokeWidth={6 * u} strokeLinecap="round" opacity={clamp(d / 0.4, 0, 1)}
          />
        </>
      ) : null}
    </Svg>
  );
}

const tween = (from: Box, to: Box, k: number): Box => {
  const e = ease(clamp(k, 0, 1));
  return [lerp(from[0], to[0], e), lerp(from[1], to[1], e), lerp(from[2], to[2], e), lerp(from[3], to[3], e)];
};

const styles = StyleSheet.create({
  strip: { paddingBottom: spacing.sm },
  map: { backgroundColor: colors.bg, overflow: 'hidden', justifyContent: 'flex-start' },
  mapRounded: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  beat: { position: 'absolute', left: 12, top: 10, ...type.small, color: colors.inkMuted, fontWeight: '600' },
  line: { gap: 9, alignItems: 'flex-start', paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.line },
  lineMark: { width: 17, alignItems: 'center', paddingTop: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.inkFaint, marginTop: 5 },
  strong: { color: colors.ink, fontWeight: '700' },
});

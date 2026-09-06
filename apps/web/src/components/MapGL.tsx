/**
 * The map, as a first-class citizen (owner, 6 Sep 2026).
 *
 * `MapGL` is the map-first trip screen's canvas: a full-bleed vector map you
 * can pinch, rotate and throw, with Roam's own markers drawn on top of it as
 * ordinary elements rather than as pictures baked into a tile.
 *
 * The web implementation is `MapGL.web.tsx` (MapLibre GL). This file is the
 * native fallback and the shared types, exactly as `MapView` does — the app
 * ships as a web app, and a native build gets the real thing through the same
 * component when it exists.
 *
 * Deliberately separate from `MapView`. That one is a small map inside a card
 * with a fitted list of pins; this one is a screen you drive. Merging them
 * would give one component two jobs and a prop for every difference.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { colors, type } from '../theme';

export type Point = { lat: number; lng: number };

/**
 * A marker's kind, which is its whole appearance. The handoff (§ Design tokens)
 * fixes each one:
 *   home      24px white, 2.5px ink border — where the day starts
 *   base      the same, with a bed, on a holiday
 *   dest      30px red, white ring and an ink halo — where the day is for
 *   browse    26px white, 2px ink border — a candidate you are looking at
 *   added     28px ink — something on the day
 *   saved     22px white, 1.5px dashed ink — on the shortlist, not on the day
 */
export type MarkerKind = 'home' | 'base' | 'dest' | 'browse' | 'added' | 'saved';

export type MapMarker = {
  id: string;
  lat: number;
  lng: number;
  kind: MarkerKind;
  /** Drawn beside the marker in an ink pill. Left off where there would be too many to read. */
  label?: string | null;
  /** A rank drawn inside the pin — the stay results are numbered (handoff §18). */
  badge?: string | null;
  /** A Lucide name from the app's own set, drawn inside the marker. */
  icon?: string | null;
  selected?: boolean;
  onPress?: () => void;
};

/** The route drawn under the markers: home → destination, and back. */
export type MapRoute = { id: string; points: Point[]; dashed?: boolean };

export type MapGLProps = {
  markers: MapMarker[];
  routes?: MapRoute[];
  /**
   * How much of the map is covered by something — the sheet at the bottom, the
   * pills above it. Fitting and centring happen inside what is left, or a pin
   * you just chose lands underneath the sheet.
   */
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
  /** Refit to these markers. Changing the value refits; it does not fight a drag. */
  fitKey?: string;
  /**
   * Leave the route out of the fit. While a pill is lit the subject is what
   * came back, not the drive, and stretching the frame to the far end of the
   * journey zooms so far out that eight beds a mile apart land on one pin.
   */
  fitToMarkers?: boolean;
  /** Centre on one marker without refitting everything. */
  focusId?: string | null;
  onMapPress?: () => void;
  dark?: boolean;
};

export function MapGL({ markers }: MapGLProps) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={type.small}>{markers.length} places on the map — the map arrives with the native app.</Text>
    </View>
  );
}

import React from 'react';
import { Image, StyleSheet, View } from 'react-native';

// The signed-off mark: "Roam" in Caveat with a dotted trail to a heart-pin, the
// heart pulsing. Source and static variants live in docs/brand. The GIF is drawn
// on the brand ground (#f3f2f2), so the frame takes the same colour to hide
// the rectangle.
//
// The mark sits in the middle of a 640×320 canvas and fills only half of it
// (measured across every frame: x 168–489, y 76–258). Drawn edge to edge the
// dotted trail and the heart were too small to see (owner, 3 Sep 2026), so the
// frame crops to the mark with a little breathing room: `height` is the height
// of the mark plus that margin, not of the whole canvas.
const PULSE = require('../../assets/brand/roam-heart-pulse.gif');
export const BRAND_GROUND = '#f3f2f2';

const CANVAS = { w: 640, h: 320 };
const MARK = { x: 168, y: 76, w: 322, h: 183 };
const MARGIN = 12; // canvas pixels around the mark

export function Brand({ height = 56 }: { height?: number }) {
  const scale = height / (MARK.h + MARGIN * 2);
  const width = Math.round((MARK.w + MARGIN * 2) * scale);
  const image = {
    width: CANVAS.w * scale,
    height: CANVAS.h * scale,
    left: -(MARK.x - MARGIN) * scale,
    top: -(MARK.y - MARGIN) * scale,
  };
  return (
    <View style={[styles.frame, { height, width }]} accessibilityRole="image" accessibilityLabel="Roam">
      <Image source={PULSE} style={[styles.image, image]} resizeMode="stretch" />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: BRAND_GROUND, borderRadius: 12, overflow: 'hidden' },
  image: { position: 'absolute' },
});

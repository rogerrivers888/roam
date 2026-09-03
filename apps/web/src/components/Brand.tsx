import React from 'react';
import { Image, StyleSheet, View } from 'react-native';

// The signed-off mark: "Roam" in Caveat with a dotted trail to a heart-pin, the
// heart pulsing. Source and static variants live in docs/brand. The GIF is drawn
// on the brand ground (#f3f2f2), so the frame takes the same colour to hide
// the rectangle.
const PULSE = require('../../assets/brand/roam-heart-pulse.gif');
export const BRAND_GROUND = '#f3f2f2';

export function Brand({ height = 56 }: { height?: number }) {
  return (
    <View style={[styles.frame, { height, width: height * 2 }]} accessibilityRole="image" accessibilityLabel="Roam">
      <Image source={PULSE} style={{ height, width: height * 2 }} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: BRAND_GROUND, borderRadius: 12, overflow: 'hidden' },
});

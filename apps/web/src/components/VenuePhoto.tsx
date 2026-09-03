import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { API_URL, VenuePhotoRef } from '../api';
import { colors, radius, type } from '../theme';

/**
 * A place's photo, fetched through the API so the provider key never reaches
 * the browser and each fetch is attributed (Technical Constraints §13.7).
 * Google's licence requires the photographer's credit to be shown with the
 * image, so it sits under the thumbnail rather than in a tooltip.
 * Renders nothing when the source has no photo (OpenStreetMap never does).
 */
export function VenuePhoto({ photos, size = 72, credit = true }: { photos?: VenuePhotoRef[] | null; size?: number; credit?: boolean }) {
  const [failed, setFailed] = useState(false);
  const photo = photos?.[0];
  if (!photo || failed) return null;
  const uri = `${API_URL}/api/photos/google?name=${encodeURIComponent(photo.ref)}&w=${size >= 120 ? 480 : 240}`;
  return (
    <View style={{ width: size, gap: 2 }}>
      <Image source={{ uri }} style={[styles.img, { width: size, height: size }]} onError={() => setFailed(true)} accessibilityIgnoresInvertColors />
      {credit && photo.attribution ? <Text style={[type.tiny, styles.credit]} numberOfLines={1}>📷 {photo.attribution}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  img: { borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  credit: { fontSize: 10, color: colors.inkMuted },
});

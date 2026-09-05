import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { API_URL, OwnedImage, VenuePhotoRef } from '../api';
import { Icon, IconName, iconFor } from './Icon';
import { colors, radius, spacing, type } from '../theme';

/**
 * The picture on a place's card.
 *
 * Owner, 5 Sep 2026, on the delivery apps having one food photo each: "We don't
 * even have logos or anything like that, so it would just be a text listing,
 * which is okay but not ideal. The only other option is to use generic images
 * (a huge bank) and just mix and match them for all the different restaurants,
 * but that's a bit misleading."
 *
 * He is right, so there is no bank of stock food here. There are four different
 * kinds of picture and a floor, and the whole point of this component is that
 * they are not drawn the same way:
 *
 *   a photograph   Commons, or a street-level frame of the shopfront. Fills the
 *                  tile, because that is what a photograph is for.
 *   a logo         The business's own mark. *Contained*, with room around it, on
 *                  the mint ground. Cropping a 180px square logo to fill a 240×180
 *                  tile turns a wordmark into an abstract smear, which is worse
 *                  than no picture at all.
 *   a rented photo A provider's, fetched at display time and never stored
 *                  (Technical Constraints §4). Fills the tile, credited.
 *   the floor      No picture. The category icon on the one mint ground, the
 *                  same as everywhere else in Roam.
 *
 * The floor is honest by construction: nobody reads an icon on a mint square as
 * a photograph of that restaurant's food. That is exactly what a bank of stock
 * food photography could not promise.
 *
 * A note on what was tried and dropped (5 Sep 2026). The first version varied
 * the empty tile's ground across four tones hashed from the venue_ref, so a
 * shelf of twelve would not read as twelve identical boxes. It does not survive
 * this palette: `surfaceMuted`, `accentSoft` and `well` are the same value in
 * light mode and again in dark, so "four tones" was in fact one tone and one
 * bright mint, and every fourth row lit up for no reason a household could
 * explain. The style guide has one mint and says there is no colour-coding of
 * rows; inventing a second step to get around that would be arguing with it.
 * So the distinguishing is left to the picture, and the answer to a shelf of
 * identical tiles is to find more pictures, not to tint the empties.
 *
 * `credit` is drawn whenever the licence requires it. That is a condition of
 * being allowed to show the picture, not a nicety, so it lives here rather than
 * in each caller.
 */

export type VenueThumbProps = {
  name?: string | null;
  /** Ours: stored, licensed, and served from our own origin. */
  image?: OwnedImage | null;
  /** Rented: a provider's, fetched now and never written down. */
  photos?: VenuePhotoRef[] | null;
  /** For the icon on the floor. */
  category?: string | null;
  experiences?: string[];
  atlasCategory?: string | null;
  width: number;
  height: number;
  /** Draw the credit line under the picture. Off inside a tile that has its own. */
  credit?: boolean;
  rounded?: number;
  onPress?: () => void;
  /** Anything that sits on top of the picture — a heart, a rank. */
  children?: React.ReactNode;
};

export function VenueThumb({
  name, image, photos, category, experiences, atlasCategory,
  width, height, credit = true, rounded = radius.md, onPress, children,
}: VenueThumbProps) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Ours first, always. A provider's photo is only reached when we have nothing
  // of our own, and it is never stored.
  const photo = photos?.[0];
  const rented = !image && (photo?.url ?? (photo?.ref ? `${API_URL}/api/photos/google?name=${encodeURIComponent(photo.ref)}&w=${width > 240 ? 480 : 240}` : null));
  // A mark is small by nature; asking for 960 of a 180px PNG just serves the
  // same bytes back under a different name.
  const ourWidth = image?.source === 'logo' ? 500 : width > 240 ? 960 : 500;
  const uri = image ? `${API_URL}/api/images/${image.id}/${ourWidth}` : rented || null;

  const isMark = image?.source === 'logo';
  const line = image?.creditRequired ? image.credit : photo?.attribution ?? null;
  const icon: IconName = iconFor({ category, experiences, atlasCategory });

  const tile = (
    <View style={[styles.tile, { width, height, borderRadius: rounded, backgroundColor: isMark || !uri || failed ? colors.well : colors.surfaceMuted }]}>
      {/* The photograph's own colours, half a kilobyte, before the network is
          touched. A mark does not get one: blurring a logo up from 20px is a
          smudge, and it is on its ground already. */}
      {image?.lqip && !isMark && !loaded && !failed ? (
        <Image source={{ uri: image.lqip }} style={StyleSheet.absoluteFill as any} resizeMode="cover" blurRadius={2} accessibilityIgnoresInvertColors />
      ) : null}
      {uri && !failed ? (
        <Image
          source={{ uri }}
          style={isMark ? [styles.mark, { padding: Math.round(Math.min(width, height) * 0.16) }] : (StyleSheet.absoluteFill as any)}
          resizeMode={isMark ? 'contain' : 'cover'}
          onError={() => setFailed(true)}
          onLoad={() => setLoaded(true)}
          accessibilityIgnoresInvertColors
          accessibilityLabel={name ? (isMark ? `${name} logo` : name) : undefined}
        />
      ) : (
        <View style={styles.empty}>
          <Icon name={icon} size={Math.max(18, Math.round(Math.min(width, height) * 0.28))} color={colors.icon} />
        </View>
      )}
      {children}
    </View>
  );

  return (
    <View style={{ width, gap: 2 }}>
      {onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={name ?? undefined}>{tile}</Pressable>
      ) : tile}
      {/* Not decoration. For every licence but CC0 and public domain, the
          picture without the line is the licence broken. */}
      {credit && line && !failed && uri ? (
        <Text style={[type.tiny, styles.credit]} numberOfLines={1}>{line}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  mark: { width: '100%', height: '100%' },
  empty: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  credit: { fontSize: 10, color: colors.inkMuted, paddingHorizontal: 2 },
});

/** The gap the credit line needs under a tile, so a grid can leave room for it. */
export const CREDIT_HEIGHT = 14;

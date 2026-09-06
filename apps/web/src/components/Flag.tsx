import React, { useState } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';
import { hasFlag } from 'country-flag-icons';
import { colors, fonts, radius as r } from '../theme';

/**
 * A country's flag.
 *
 * The artwork is `country-flag-icons` (MIT; the flags are public-domain
 * drawings from Wikimedia), which is the whole of ISO 3166-1 and is maintained
 * — no sprite sheet to license, and no emoji, which render as two letters on
 * Windows and are forbidden as icons anyway.
 *
 * The library is imported for one thing only: `hasFlag`, so a code we have no
 * drawing for shows the code rather than a broken picture. The SVGs themselves
 * are served as static files (`apps/web/scripts/flags.mjs` copies them into
 * `public/flags`), so a screen showing Italy fetches Italy, not 1.3 MB of every
 * country there is.
 *
 * If the copy has not run, or a fetch fails, or this is a native build with no
 * static origin to fetch from, the tile falls back to the two-letter code —
 * which is what every country row drew before the flags arrived.
 */
export function Flag({ code, width = 44, height = 32, rounded = r.sm }: {
  code: string;
  width?: number;
  height?: number;
  rounded?: number;
}) {
  const [failed, setFailed] = useState(false);
  const cc = (code || '').trim().toUpperCase();
  // "UK" is what people type; ISO 3166-1 calls it GB, and so does the artwork.
  const iso = cc === 'UK' ? 'GB' : cc;
  const drawn = Platform.OS === 'web' && !failed && iso.length === 2 && hasFlag(iso);

  return (
    <View style={[styles.tile, { width, height, borderRadius: rounded }]}>
      {drawn ? (
        <Image
          source={{ uri: `/flags/${iso}.svg` }}
          style={{ width, height }}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityLabel={`Flag of ${iso}`}
        />
      ) : (
        <Text style={styles.code}>{cc}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  code: { fontFamily: fonts.heading, fontSize: 11, fontWeight: '700', letterSpacing: 0.66, color: colors.headerSub },
});

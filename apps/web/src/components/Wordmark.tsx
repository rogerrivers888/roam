import React from 'react';
import { Platform, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors, fonts } from '../theme';

/**
 * The signed-off mark (logo pack 4i) drawn live, so it sits on any ground the
 * style guide allows: "Roam" in Caveat Bold, the badge heart-pin beside it.
 * The pin takes the type colour, the ring takes the ground, and the heart is
 * red — except on red, where it is ink. Minimum symbol height 16px.
 */
export function Wordmark({ height = 40, ink = colors.ink, ground = colors.headerBg, onRed = false }: {
  height?: number; ink?: string; ground?: string; onRed?: boolean;
}) {
  const symbol = Math.max(16, Math.round(height * 0.8));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: Math.round(height * 0.12) }} accessibilityRole="image" accessibilityLabel="Roam">
      <Text
        {...((Platform.OS === 'web' ? { dataSet: { font: 'wordmark' } } : {}) as object)}
        style={{ fontFamily: fonts.wordmark, fontWeight: '700', fontSize: Math.round(height * 1.05), lineHeight: Math.round(height * 1.15), color: ink, includeFontPadding: false }}
      >
        Roam
      </Text>
      <Svg width={Math.round(symbol * 48 / 56)} height={symbol} viewBox="0 0 48 56">
        <Path d="M24 2C13 2 5 10.5 5 21c0 13 19 33 19 33s19-20 19-33C43 10.5 35 2 24 2z" fill={ink} />
        <Circle cx={24} cy={21} r={7} fill={ground} />
        <Path d="M37 52l-7.5-6.9c-2.5-2.3-2.5-6 0.4-7.8 2.1-1.3 4.9-0.5 7.1 1.8 2.2-2.3 5-3.1 7.1-1.8 2.9 1.8 2.9 5.5 0.4 7.8z" fill={onRed ? ink : colors.red} stroke={ground} strokeWidth={2.5} />
      </Svg>
    </View>
  );
}

import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import qrcode from 'qrcode-generator';
import { radius } from '../theme';

/**
 * The invite link as a code to point a phone at (owner, 4 Sep 2026: "it should
 * just show the QR code"). Drawn as one path of squares rather than an image,
 * so it is sharp at any size, costs no request, and takes the palette with it.
 *
 * Error correction M: enough to survive a thumb over a corner, small enough
 * that a link stays a coarse grid across a clubhouse table.
 */
export function QrCode({ value, size = 148, quiet = 2 }: { value: string; size?: number; quiet?: number }) {
  const { d, span } = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(value);
    q.make();
    const n = q.getModuleCount();
    let path = '';
    for (let row = 0; row < n; row += 1) {
      for (let col = 0; col < n; col += 1) {
        if (q.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
    return { d: path, span: n + quiet * 2 };
  }, [value, quiet]);

  return (
    <View style={{ width: size, height: size, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#FFFFFF' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${span} ${span}`}>
        <Rect x={0} y={0} width={span} height={span} fill="#FFFFFF" />
        {/* Always ink on white, in both palettes: a scanner needs the contrast, not the theme. */}
        <Path d={d} fill="#201E1D" />
      </Svg>
    </View>
  );
}

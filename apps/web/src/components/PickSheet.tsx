import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { Icon } from './Icon';
import { Row } from './ui';
import { colors, radius, spacing, TARGET, type } from '../theme';

/** A dropdown as a sheet pinned to the frame: the options with counts, the current one in ink. */
export function PickSheet({ visible, title, options, value, onPick, onClose }: { visible: boolean; title: string; options: { value: string; label: string; count?: number }[]; value: string; onPick: (v: string) => void; onClose: () => void }) {
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900 && !framed;
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const } : null;
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.sheetWrap, wide && styles.sheetWrapWide, frameBox]}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, wide && styles.sheetWide]}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={type.h2}>{title}</Text>
            <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close"><Icon name="close" size={18} color={colors.ink} /></Pressable>
          </Row>
          <ScrollView style={{ maxHeight: 420 }}>
            {options.map((o) => {
              const on = o.value === value;
              return (
                <Pressable key={o.value} onPress={() => onPick(o.value)} style={[styles.opt, on && styles.optOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                  <Text style={[type.body, { flex: 1 }, on && { color: colors.primaryFg, fontWeight: '600' }]}>{o.label}</Text>
                  {o.count != null ? <Text style={[type.small, on && { color: colors.primaryFg }]}>{o.count}</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheetWrapWide: { justifyContent: 'center', alignItems: 'center' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(29,27,22,0.35)' },
  sheet: { backgroundColor: colors.panel, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, maxHeight: '80%' },
  sheetWide: { width: 360, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  close: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  opt: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md },
  optOn: { backgroundColor: colors.primary },
});

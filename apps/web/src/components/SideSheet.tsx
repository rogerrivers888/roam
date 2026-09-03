import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Icon } from './Icon';
import { Row } from './ui';

/**
 * A drawer for a thing you tapped: a side panel on a wide screen, a sheet on
 * the phone (and inside the shell's phone frame). Same container the venue
 * drawer uses, with nothing in it but what the caller passes.
 */
export function SideSheet({ title, subtitle, onClose, children, footer }: {
  title: string; subtitle?: string | null; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode;
}) {
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900;
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const } : null;
  return (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.panel, wide ? styles.panelSide : styles.panelSheet, frameBox]}>
          <ScrollView contentContainerStyle={{ gap: spacing.md, padding: spacing.lg }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.title}>{title}</Text>
                {subtitle ? <Text style={type.small}>{subtitle}</Text> : null}
              </View>
              <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close"><Icon name="close" size={22} color={colors.ink} /></Pressable>
            </Row>
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropWrap: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(29,27,22,0.35)' },
  panel: { backgroundColor: colors.bg },
  panelSide: { width: 460, maxWidth: '100%', height: '100%', borderLeftWidth: 1, borderLeftColor: colors.line },
  panelSheet: { width: '100%', height: '100%' },
  close: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  footer: { padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface, gap: spacing.sm },
});

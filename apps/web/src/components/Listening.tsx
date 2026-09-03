import React, { useEffect, useRef } from 'react';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '../theme';
import { Button, Row } from './ui';

/**
 * What the screen becomes while the household is speaking (owner, 3 Sep 2026):
 * everything else collapses and one big box shows exactly what has been heard
 * so far, growing as they talk. Done sends it all; Cancel keeps nothing. The
 * same words could have been typed into the box that was there before.
 */
export function Listening({ transcript, hint, onDone, onCancel }: {
  transcript: string;
  hint?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: false }),
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scroll = useRef<ScrollView>(null);
  useEffect(() => { scroll.current?.scrollToEnd({ animated: true }); }, [transcript]);

  return (
    <View style={styles.wrap} testID="listening">
      <Row>
        <Animated.View style={[styles.dot, { opacity: pulse }]} />
        <Text style={type.h2}>Listening…</Text>
      </Row>
      <ScrollView ref={scroll} style={styles.box} contentContainerStyle={styles.boxInner} accessibilityLiveRegion="polite" accessibilityLabel="What you've said so far">
        {transcript ? (
          <Text style={styles.transcript}>{transcript}</Text>
        ) : (
          <Text style={[styles.transcript, { color: colors.inkFaint }]}>{hint ?? 'Say where you\'re starting, how long you\'ve got, and anything you must fit in.'}</Text>
        )}
      </ScrollView>
      <Text style={type.small}>Take your time — nothing is sent until you tap Done. The recording isn't kept.</Text>
      <Row style={{ justifyContent: 'flex-end' }}>
        <Button label="Cancel" kind="ghost" onPress={onCancel} />
        <Button label="Done" onPress={onDone} disabled={!transcript.trim()} />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  dot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.overrun },
  box: {
    minHeight: 220, maxHeight: 480, borderRadius: radius.lg, borderWidth: 2, borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  boxInner: { padding: spacing.lg, flexGrow: 1 },
  transcript: { fontSize: 22, lineHeight: 32, color: colors.ink },
});

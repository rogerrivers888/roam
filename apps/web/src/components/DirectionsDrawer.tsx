import React, { useEffect, useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import { api, Directions, JourneyLeg, LegMode } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Row, Segmented, minutes as fmtMinutes } from './ui';
import { Icon } from './Icon';

/**
 * Directions for one leg of the trip (owner, 3 Sep 2026): the way you chose,
 * step by step, with the other ways a tap away; public transport with the
 * line, headsign, stops and departure; then a hand-off to a maps app. Fetched
 * when opened, never stored.
 */

export const MODE_LABEL: Record<LegMode, string> = { walking: 'Walk', transit: 'Public transport', driving: 'Drive', taxi: 'Uber' };
export const MODE_SHORT: Record<LegMode, string> = { walking: 'Walk', transit: 'Public', driving: 'Drive', taxi: 'Uber' };

export type LegPoint = { label: string; lat: number; lng: number };

export function DirectionsDrawer({ tripId, from, to, leg, hasCar, departAt, onClose, onPickMode }: {
  tripId: string; from: LegPoint; to: LegPoint; leg: JourneyLeg; hasCar: boolean; departAt?: string | null;
  onClose: () => void; onPickMode?: (mode: LegMode) => Promise<void>;
}) {
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900;
  const frameBox = framed && origin ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const } : null;
  const [mode, setMode] = useState<LegMode>(leg.mode);
  const [d, setD] = useState<Directions | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setD(undefined); setError(null);
    api.directions(tripId, { from: `${from.lat},${from.lng}`, to: `${to.lat},${to.lng}`, mode, departAt: departAt ?? undefined })
      .then((r) => { if (live) setD(r); }).catch((e) => { if (live) { setD(null); setError(e.message); } });
    return () => { live = false; };
  }, [tripId, from.lat, from.lng, to.lat, to.lng, mode]);

  const modes = (Object.keys(leg.options) as LegMode[]).filter((m) => hasCar ? m === 'driving' || m === 'walking' : true);
  const opts = modes.map((m) => ({ value: m, label: `${MODE_SHORT[m]} ${leg.options[m]?.minutes ?? ''}` }));
  const apple = `https://maps.apple.com/?saddr=${from.lat},${from.lng}&daddr=${to.lat},${to.lng}&dirflg=${mode === 'walking' ? 'w' : mode === 'transit' ? 'r' : 'd'}`;
  const google = `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=${mode === 'taxi' ? 'driving' : mode}`;
  const citymapper = `https://citymapper.com/directions?startcoord=${from.lat},${from.lng}&endcoord=${to.lat},${to.lng}&startname=${encodeURIComponent(from.label)}&endname=${encodeURIComponent(to.label)}`;
  const uber = `https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${from.lat}&pickup[longitude]=${from.lng}&pickup[nickname]=${encodeURIComponent(from.label)}&dropoff[latitude]=${to.lat}&dropoff[longitude]=${to.lng}&dropoff[nickname]=${encodeURIComponent(to.label)}`;

  return (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.panel, wide ? styles.panelSide : styles.panelSheet, frameBox]}>
          <ScrollView contentContainerStyle={{ gap: spacing.md, padding: spacing.lg }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.tiny}>DIRECTIONS</Text>
                <Text style={type.h2}>{from.label} → {to.label}</Text>
              </View>
              <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close"><Icon name="close" size={22} color={colors.ink} /></Pressable>
            </Row>
            {opts.length > 1 ? <Segmented value={mode} options={opts} onChange={setMode} /> : null}
            <View style={styles.summary}>
              <Icon name={mode} size={18} color={colors.accent} />
              <Text style={[type.small, { color: colors.accent, fontWeight: '700', flex: 1 }]}>
                {d ? `${fmtMinutes(d.minutes)}${d.meters ? ` · ${(d.meters / 1000).toFixed(1)} km` : ''}` : d === undefined ? 'Fetching…' : `about ${fmtMinutes(leg.options[mode]?.minutes ?? leg.minutes)}`}
                {leg.leaveBy ? ` · leave ${leg.leaveBy}` : ''}
              </Text>
            </View>
            {error ? <Text style={[type.tiny, { color: colors.dislike }]}>{error}</Text> : null}
            {d?.steps.length ? (
              <View style={{ gap: 2 }}>
                {d.steps.map((s, i) => (
                  <View key={i} style={styles.step}>
                    <View style={[styles.dot, s.transit?.color ? { backgroundColor: s.transit.color } : null]} />
                    <View style={{ flex: 1, gap: 2 }}>
                      {s.transit ? (
                        <>
                          <Row>
                            {s.transit.line ? <View style={[styles.line, { backgroundColor: s.transit.color ?? colors.ink }]}><Text style={[styles.lineText, { color: s.transit.textColor ?? '#fff' }]}>{s.transit.line}</Text></View> : null}
                            <Text style={[type.body, { fontWeight: '600', flexShrink: 1 }]}>{s.transit.vehicle ?? 'Transit'}{s.transit.headsign ? ` towards ${s.transit.headsign}` : ''}</Text>
                          </Row>
                          <Text style={type.small}>{s.transit.from ?? ''}{s.transit.departs ? ` · departs ${s.transit.departs}` : ''}{s.transit.stopCount ? ` · ${s.transit.stopCount} stop${s.transit.stopCount === 1 ? '' : 's'}` : ''} · {fmtMinutes(s.minutes)}</Text>
                          <Text style={type.small}>to {s.transit.to ?? ''}{s.transit.arrives ? ` · ${s.transit.arrives}` : ''}</Text>
                        </>
                      ) : (
                        <>
                          <Text style={type.body}>{s.text || (s.travelMode === 'walk' ? 'Walk' : 'Continue')}</Text>
                          <Text style={type.tiny}>{fmtMinutes(s.minutes)}{s.meters != null ? ` · ${s.meters >= 1000 ? `${(s.meters / 1000).toFixed(1)} km` : `${s.meters} m`}` : ''}</Text>
                        </>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            ) : d ? (
              <Text style={type.small}>{d.estimated ? 'Step-by-step directions need Google Routes, which is not switched on here; the time above is an estimate from the distance.' : 'No steps returned for this leg.'}</Text>
            ) : null}
            {d && !d.estimated ? <Text style={type.tiny}>Live from Google Routes when you open this. Times change with traffic and timetables.</Text> : null}

            {onPickMode && mode !== leg.mode ? <Button label={`Use ${MODE_LABEL[mode].toLowerCase()} for this leg`} icon="check" onPress={async () => { await onPickMode(mode); onClose(); }} /> : null}
            <View style={{ gap: spacing.sm }}>
              {mode === 'taxi' ? <Button label="Open in Uber" icon="external" kind="secondary" onPress={() => Linking.openURL(uber)} /> : null}
              {mode === 'transit' ? <Button label="Open in Citymapper" icon="external" kind="secondary" onPress={() => Linking.openURL(citymapper)} /> : null}
              {Platform.OS === 'ios' || Platform.OS === 'web' ? <Button label="Open in Apple Maps" icon="external" kind={mode === 'taxi' || mode === 'transit' ? 'ghost' : 'secondary'} onPress={() => Linking.openURL(apple)} /> : null}
              <Button label="Open in Google Maps" icon="external" kind="ghost" onPress={() => Linking.openURL(google)} />
            </View>
          </ScrollView>
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
  summary: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  step: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, marginTop: 7 },
  line: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 5 },
  lineText: { fontSize: 11, fontWeight: '800' },
});

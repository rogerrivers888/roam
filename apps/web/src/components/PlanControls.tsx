import React from 'react';
import { Text, View } from 'react-native';
import { PricePoint } from '../api';
import { type } from '../theme';
import { Chip, Row, Segmented } from './ui';

/**
 * Two choices the household makes for the day, by tap here and by voice in the
 * same session ("somewhere upmarket", "no chains"): both land on the same
 * session state, so neither is a separate mode.
 */

export const PRICE_LABEL: Record<PricePoint, string> = { any: 'Any price', affordable: 'Affordable', mid: 'Mid-range', upmarket: 'Upmarket' };

export function PricePointControl({ value, onChange }: { value: PricePoint; onChange: (v: PricePoint) => void }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={type.small}>Where to eat: price point</Text>
      <Segmented
        value={value}
        options={(['any', 'affordable', 'mid', 'upmarket'] as PricePoint[]).map((v) => ({ value: v, label: PRICE_LABEL[v] }))}
        onChange={onChange}
      />
      <Text style={type.tiny}>Places whose price is unknown stay in and say so — only a source with prices (Google, Tripadvisor) can filter them.</Text>
    </View>
  );
}

export function ChainsControl({ includeChains, hidden, onChange }: { includeChains: boolean; hidden: number; onChange: (include: boolean) => void }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Text style={[type.small, { flex: 1 }]}>
        {includeChains ? 'Chains are included.' : `Chains are left out${hidden ? ` (${hidden} nearby)` : ''}.`} Independents and family-run places first.
      </Text>
      <Chip label={includeChains ? 'Hide chains' : 'Include chains'} selected={includeChains} onPress={() => onChange(!includeChains)} />
    </Row>
  );
}

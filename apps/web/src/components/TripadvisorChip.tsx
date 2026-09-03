import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api, SourcesStatus } from '../api';
import { Chip } from './ui';
import { type } from '../theme';

/**
 * Per-search opt-in for Tripadvisor. The source is billed per location returned
 * (1,000 free for the account's lifetime, about 50 browses), so it is off by
 * default and only runs on the searches the household turns it on for.
 * Renders nothing while the key is not live.
 */
export function TripadvisorChip({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const [status, setStatus] = useState<SourcesStatus | null>(null);
  useEffect(() => { api.sources().then(setStatus).catch(() => null); }, []);
  const ta = status?.available.find((a) => a.key === 'tripadvisor');
  if (!ta?.on) return null;
  const used = status?.usage?.tripadvisor?.searchesAllTime ?? 0;
  return (
    <View style={{ gap: 4 }}>
      <Chip label={value ? '✓ Tripadvisor ratings' : '+ Tripadvisor ratings'} selected={value} tone={value ? 'accent' : 'neutral'} onPress={() => onChange(!value)} />
      <Text style={type.tiny}>
        {value ? 'This search will ask Tripadvisor, about 20 of its free 1,000 locations.' : 'Off unless you turn it on for a search.'} Used so far: {used} search{used === 1 ? '' : 'es'} (about 50 are free).
      </Text>
    </View>
  );
}

import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api, SourceCost, SourcesStatus } from '../api';
import { Chip, Wrap } from './ui';
import { type } from '../theme';
import { isAdmin } from '../admin';

/**
 * Which place sources a search (or a trip) may use. `null` means the default
 * set: every live source except opt-in ones. Tripadvisor is opt-in because it
 * is billed per location returned (1,000 free for the account's lifetime), so
 * it only runs when picked here.
 *
 * Picking a single source is the testing view: results come from that source
 * alone, so you can see what each one returns and how it looks.
 */
/**
 * "$0.65" for a source that costs money per search, nothing for a free one.
 * What a lookup costs is the owner's business, not the household's (owner,
 * 4 Sep 2026: "that is an admin function only"), so prices only show with
 * Settings > Admin on.
 */
const priceTag = (c?: SourceCost) => (isAdmin() && c && c.perSearchUsd > 0 ? ` · $${c.perSearchUsd.toFixed(2)}` : '');

/** What a trip's searches and plans have cost so far, beside its source picker. */
export function TripSpendLine({ tripId, refreshKey }: { tripId: string; refreshKey?: unknown }) {
  const [spend, setSpend] = useState<{ calls: number; costUsd: number; byProvider: { provider: string; calls: number; cost_usd: number }[] } | null>(null);
  useEffect(() => { api.tripSpend(tripId).then(setSpend).catch(() => null); }, [tripId, refreshKey]);
  if (!spend) return null;
  const paid = spend.byProvider.filter((p) => p.cost_usd > 0);
  return (
    <Text style={type.tiny}>
      This trip so far: {spend.calls} lookup{spend.calls === 1 ? '' : 's'} · ${spend.costUsd.toFixed(2)}{paid.length ? ` (${paid.map((p) => `${p.provider} $${p.cost_usd.toFixed(2)}`).join(', ')})` : ' — all free'}.
    </Text>
  );
}

export function SourcePicker({ value, onChange, title = 'Sources' }: { value: string[] | null; onChange: (v: string[] | null) => void; title?: string }) {
  const [status, setStatus] = useState<SourcesStatus | null>(null);
  useEffect(() => { api.sources().then(setStatus).catch(() => null); }, []);
  if (!status) return null;
  const defaults = status.defaults ?? status.enabled.filter((s) => !s.optIn).map((s) => s.key);
  const selected = value && value.length ? value : defaults;
  const isDefault = !value || !value.length;
  const toggle = (key: string) => {
    const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
    const sameAsDefault = next.length === defaults.length && defaults.every((k) => next.includes(k));
    onChange(sameAsDefault ? null : next);
  };
  const ta = status.available.find((a) => a.key === 'tripadvisor');
  const taOn = Boolean(ta?.on) && selected.includes('tripadvisor');
  const used = status.usage?.tripadvisor?.searchesAllTime ?? 0;
  const perSearch = selected.reduce((n, k) => n + (status.cost?.[k]?.perSearchUsd ?? 0), 0);
  return (
    <View style={{ gap: 4 }}>
      <Text style={type.tiny}>{title}{isDefault ? ' (default)' : selected.length === 1 ? ` — only ${status.enabled.find((s) => s.key === selected[0])?.label ?? selected[0]}` : ''}</Text>
      <Wrap>
        {status.enabled.map((s) => (
          <Chip key={s.key} icon={selected.includes(s.key) ? 'check' : undefined} label={`${s.label}${priceTag(status.cost?.[s.key])}`} selected={selected.includes(s.key)} tone={selected.includes(s.key) ? (status.cost?.[s.key]?.perSearchUsd ? 'accent' : 'like') : 'neutral'} onPress={() => toggle(s.key)} />
        ))}
        {!isDefault ? <Chip label="Reset to default" onPress={() => onChange(null)} /> : null}
      </Wrap>
      {isAdmin() && perSearch > 0 ? (
        <Text style={type.tiny}>About ${perSearch.toFixed(2)} per search with this set ({selected.filter((k) => status.cost?.[k]?.perSearchUsd).map((k) => `${status.enabled.find((s) => s.key === k)?.label ?? k} $${status.cost![k].perSearchUsd.toFixed(2)}`).join(', ')}); the rest are free.</Text>
      ) : isAdmin() ? <Text style={type.tiny}>Every source in this set is free to search.</Text> : null}
      {taOn ? (
        <Text style={type.tiny}>
          {selected.length === 1
            ? 'Tripadvisor alone: one catalog page around the point, about 10 locations billed. Terra ignores category and sort here, so expect an arbitrary slice.'
            : 'Tripadvisor adds ratings to what the other sources find, by looking up each venue by name: up to 8 lookups, 1–2 locations billed each.'}
          {' '}Used so far: {used} search{used === 1 ? '' : 'es'} (about 50 are free).
        </Text>
      ) : null}
    </View>
  );
}

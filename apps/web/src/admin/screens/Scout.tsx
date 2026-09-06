/**
 * The sweep — the back office screen for the areas Roam has gone looking in.
 *
 * Owner, 4 Sep 2026: "for every postcode sector I need to find the top-rated
 * restaurants… we want a select number of highly rated restaurants in each
 * postcode, and then we can cache them and load them extremely quickly."
 *
 * Three sections, because they are three different questions:
 *
 *   Areas    Which postcodes have been swept, what each one cost and kept, and
 *            the buttons that sweep one again or score it afresh.
 *   Places   The selection for one area, best first, with the working shown:
 *            our score, our word for the crowd, and how many dishes we hold.
 *   Menus    Every menu Roam could not read, and why. The owner opened tabs
 *            and found them empty with no explanation; this is that list with
 *            a cause against each line, so a change to the crawler is a number
 *            that moves rather than an anecdote.
 *
 * What is deliberately not on this screen: a rating. Roam does not keep the
 * licensed figure — it is banded at the moment of the call and discarded — so
 * the column says "top" or "high", which is our judgement and ours to show.
 *
 * Layout follows the shell's rule (CLAUDE.md): width from `useViewport`, one
 * tree with different styles rather than two returns, nothing over 390px.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, MenuCause, ScoutArea, ScoutMenuMiss, ScoutPlace } from '../../api';
import { colors, radius, spacing, type } from '../../theme';
import { Icon } from '../../components/Icon';
import { Button, Row, Wrap } from '../../components/ui';
import { useViewport } from '../../hooks/useViewport';
import { AdminPage, Banner, FilterChip, FilterRow, PageHead, Panel, Pill, Tile, TileRow, ago, count } from '../kit';
import { asOneOf, asText, useQueryState } from '../../router';

const WIDE = 900;

type Section = 'areas' | 'places' | 'menus';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'areas', label: 'Areas' },
  { key: 'places', label: 'Places' },
  { key: 'menus', label: 'Menus' },
];

/** Our word for the crowd, and how loudly to say it. */
const STANDING: Record<string, { label: string; tone: 'ok' | 'accent' | 'plain' | 'warn' }> = {
  top: { label: 'Top', tone: 'ok' },
  high: { label: 'High', tone: 'accent' },
  good: { label: 'Good', tone: 'plain' },
  mixed: { label: 'Mixed', tone: 'warn' },
};

const ACCOLADE: Record<string, string> = {
  'michelin-star': 'Michelin star',
  'michelin-bib': 'Bib Gourmand',
  'michelin-listed': 'Michelin guide',
  'good-food-guide': 'Good Food Guide',
  'aa-rosette': 'AA rosette',
  'top-100-gastropub': 'Top gastropub',
  'national-restaurant-award': 'NRA',
  hardens: "Harden's",
  squaremeal: 'SquareMeal',
  camra: 'CAMRA',
  wikipedia: 'Wikipedia',
};

/**
 * Why a menu is missing, in words.
 *
 * The crawler throws `menu_had_no_items` and the screen must not: a code word
 * on a page tells the owner nothing about whether it is worth another go.
 * Anything not in here is already a sentence and is shown as it is.
 */
const REASON: Record<string, string> = {
  menu_had_no_items: 'Roam opened their menu page and there were no dishes on it — it may be a picture, or a page that only links elsewhere.',
  menu_unreadable: 'Nothing readable on the page, even after running it in a browser.',
  menu_url_required: 'No menu address to open.',
};
const reason = (why: string | null) => (why ? REASON[why] ?? why : 'No reason recorded');

/**
 * How big a group a place belongs to, in a word.
 *
 * A chain is shown rather than hidden (owner, 5 Sep 2026: "some people love
 * chains… they could even just be 2 or 3 stores"). What the pill carries is the
 * scale, because that is the thing that was missing from a boolean — and the
 * score already has the weight in it, so the pill is an explanation and not a
 * warning.
 */
const SCALE: Record<string, { label: string; tone: 'plain' | 'warn' }> = {
  small: { label: '2–3 sites', tone: 'plain' },
  regional: { label: 'Regional group', tone: 'plain' },
  national: { label: 'National chain', tone: 'warn' },
};

export function Scout({ canManage }: { canManage: boolean }) {
  const { width } = useViewport();
  const wide = width >= WIDE;

  // The sweep's three views, and which area is open, are both in the address.
  const [section, setSection] = useQueryState<Section>('tab', 'areas', asOneOf(['areas', 'places', 'menus'] as const, 'areas'));
  const [areas, setAreas] = useState<ScoutArea[]>([]);
  const [chosen, setChosen] = useQueryState<string | null>('area', null, asText);
  const [places, setPlaces] = useState<ScoutPlace[]>([]);
  const [misses, setMisses] = useState<ScoutMenuMiss[]>([]);
  const [causes, setCauses] = useState<MenuCause[]>([]);
  // Which cause's places the list below is showing. The report is the way in;
  // the list is what you work.
  const [cause, setCause] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');

  const loadAreas = useCallback(async () => {
    try {
      const { areas: rows } = await api.scoutAreas();
      setAreas(rows);
      // The address wins; the first area is only the default for a bare one.
      if (!chosen && rows[0]?.code) setChosen(rows[0].code);
    } catch (err) { setNote(String((err as Error).message)); }
  }, [chosen]);

  useEffect(() => { void loadAreas(); }, [loadAreas]);

  useEffect(() => {
    if (!chosen) return;
    void api.scoutPlaces(chosen, 50).then((d) => setPlaces(d.places)).catch(() => setPlaces([]));
  }, [chosen, busy]);

  useEffect(() => {
    if (section !== 'menus') return;
    void api.scoutMisses().then((d) => setMisses(d.misses)).catch(() => setMisses([]));
    void api.scoutCauses().then((d) => setCauses(d.causes)).catch(() => setCauses([]));
  }, [section, busy]);

  /** Every button here is slow and spends something, so it says what happened. */
  const run = async (key: string, what: () => Promise<unknown>, said: (r: any) => string) => {
    setBusy(key); setNote(null);
    try {
      const r = await what();
      setNote(said(r));
      await loadAreas();
    } catch (err) { setNote(String((err as Error).message)); }
    finally { setBusy(null); }
  };

  const area = areas.find((a) => a.code === chosen) ?? null;
  const totals = areas.reduce(
    (t, a) => ({ places: t.places + a.places, menus: t.menus + a.menus, dishes: t.dishes + a.dishes, missing: t.missing + a.menus_failed }),
    { places: 0, menus: 0, dishes: 0, missing: 0 },
  );

  return (
    <AdminPage>
      <PageHead
        title="The sweep"
        sub="Postcode areas Roam has gone looking in, and what it owns of them"
      />

      <TileRow>
        <Tile label="Areas swept" value={count(areas.filter((a) => a.sweeps > 0).length)} sub={`${areas.length} in the queue`} />
        <Tile label="Places kept" value={count(totals.places)} sub="chains kept, weighted down" tone="accent" />
        <Tile label="Menus read" value={count(totals.menus)} sub={`${count(totals.missing)} still to open`} tone={totals.missing > totals.menus ? 'warn' : 'ok'} />
        <Tile label="Dishes" value={count(totals.dishes)} sub="names and prices, ours to keep" tone="ok" />
      </TileRow>

      {note ? <Banner tone="accent">{note}</Banner> : null}

      <FilterRow>
        {SECTIONS.map((s) => (
          <FilterChip key={s.key} label={s.label} on={section === s.key} onPress={() => setSection(s.key)} />
        ))}
      </FilterRow>

      {section === 'areas' ? (
        <>
          {canManage ? (
            <Panel title="Look somewhere new" sub="A postcode district and the town it is: SL4, Windsor">
              <Row style={{ gap: spacing.sm, flexWrap: 'wrap' }}>
                <TextInput
                  value={code}
                  onChangeText={(t) => setCode(t.toUpperCase())}
                  placeholder="SL4"
                  placeholderTextColor={colors.inkMuted}
                  style={[styles.input, { width: 92 }]}
                  autoCapitalize="characters"
                />
                <TextInput
                  value={label}
                  onChangeText={setLabel}
                  placeholder="Windsor"
                  placeholderTextColor={colors.inkMuted}
                  style={[styles.input, { flexGrow: 1, flexBasis: 140 }]}
                />
                <Button
                  label={busy === 'add' ? 'Adding…' : 'Add'}
                  icon="add"
                  disabled={!code.trim() || busy != null}
                  onPress={() => run('add', () => api.scoutAddArea({ code: code.trim(), label: label.trim() || undefined }), (r) => `${r.area.label ?? r.area.code} is in the queue. Sweep it when you are ready.`)}
                />
              </Row>
              <Text style={type.tiny}>
                A sweep asks the open map for every restaurant, then the licensed search for what the crowd
                thinks — about fourteen requests, twenty pence. The rating itself is never kept. Chains are
                kept and weighted down by how big they are, not dropped.
              </Text>
            </Panel>
          ) : null}

          <Panel title="Areas" padded={false}>
            {areas.length === 0 ? (
              <View style={{ padding: spacing.md }}><Text style={type.small}>Nowhere swept yet.</Text></View>
            ) : areas.map((a) => (
              <Pressable
                key={a.code}
                onPress={() => { setChosen(a.code); setSection('places'); }}
                style={[styles.areaRow, chosen === a.code ? styles.areaRowOn : null]}
              >
                <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                  <Row style={{ gap: spacing.xs, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Text style={styles.areaCode}>{a.code}</Text>
                    <Text style={type.body} numberOfLines={1}>{a.label ?? ''}</Text>
                    {a.state === 'sweeping' ? <Pill label="Sweeping" tone="accent" icon="search" /> : null}
                    {a.state === 'failed' ? <Pill label="Nothing kept" tone="crit" /> : null}
                  </Row>
                  <Text style={type.tiny}>
                    {a.sweeps > 0
                      ? `${count(a.seen)} seen · ${count(a.kept)} kept, ${count(a.chains)} of them a group · swept ${ago(a.swept_at)}`
                      : 'Never swept'}
                  </Text>
                  <Text style={type.tiny}>
                    {count(a.researched)} researched · {count(a.menus)} menus · {count(a.dishes)} dishes
                    {a.menus_failed ? ` · ${count(a.menus_failed)} without one` : ''}
                  </Text>
                </View>
                {canManage ? (
                  <Wrap style={{ gap: spacing.xs, justifyContent: 'flex-end' }}>
                    <Button
                      label={busy === `sweep:${a.code}` ? 'Sweeping…' : 'Sweep'}
                      icon="search"
                      kind="secondary"
                      disabled={busy != null}
                      onPress={() => run(`sweep:${a.code}`, () => api.scoutSweep(a.code), (r) => `${a.code}: ${r.seen} seen, ${r.chains} chains dropped, ${r.kept} kept.`)}
                    />
                    <Button
                      label="Rescore"
                      icon="favourite"
                      kind="secondary"
                      disabled={busy != null}
                      onPress={() => run(`score:${a.code}`, () => api.scoutRescore(a.code), (r) => `Scored ${r.rescored} places again from what we already own — no provider asked.`)}
                    />
                  </Wrap>
                ) : null}
              </Pressable>
            ))}
          </Panel>
        </>
      ) : null}

      {section === 'places' ? (
        <>
          <FilterRow>
            {areas.map((a) => (
              <FilterChip key={a.code} label={a.label ?? a.code} on={chosen === a.code} onPress={() => setChosen(a.code)} count={a.places} />
            ))}
          </FilterRow>
          <Panel
            title={area ? `${area.label ?? area.code}, best first` : 'Places'}
            sub="Our score, our word for the crowd. The rating behind it was never written down."
            padded={false}
          >
            {places.length === 0 ? (
              <View style={{ padding: spacing.md }}><Text style={type.small}>Nothing here yet — sweep the area first.</Text></View>
            ) : places.map((p) => {
              const s = p.standing ? STANDING[p.standing] : null;
              return (
                <View key={p.venueRef} style={styles.placeRow}>
                  <Text style={styles.rank}>{p.rank}</Text>
                  <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                    <Row style={{ gap: spacing.xs, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Text style={type.body} numberOfLines={1}>{p.name ?? '—'}</Text>
                      {s ? <Pill label={s.label} tone={s.tone} /> : null}
                      {p.accolades.map((a) => <Pill key={a} label={ACCOLADE[a] ?? a} tone="ok" icon="favourite" />)}
                      {SCALE[p.chainScale] ? <Pill label={SCALE[p.chainScale].label} tone={SCALE[p.chainScale].tone} /> : null}
                    </Row>
                    <Text style={type.tiny} numberOfLines={1}>
                      {[p.cuisines.slice(0, 3).join(', '), p.postcode].filter(Boolean).join(' · ') || '—'}
                    </Text>
                    <Row style={{ gap: spacing.xs, alignItems: 'center', flexWrap: 'wrap' }}>
                      {p.menu
                        ? <Text style={[type.tiny, { color: colors.like }]}>{count(p.menu.items)} dishes, read {ago(p.menu.readAt)}</Text>
                        : <Text style={[type.tiny, { color: colors.inkMuted }]}>no menu yet</Text>}
                      {p.menuUrl ? (
                        <Pressable onPress={() => void Linking.openURL(p.menuUrl!)}>
                          <Text style={styles.link}>their menu</Text>
                        </Pressable>
                      ) : null}
                    </Row>
                  </View>
                  <Text style={styles.score}>{p.score == null ? '—' : p.score.toFixed(1)}</Text>
                </View>
              );
            })}
          </Panel>
        </>
      ) : null}

      {section === 'menus' ? (
        <>
          {canManage ? (
            <Panel title="The menus" sub="Finding where a menu is costs nothing; reading it into dishes is a Claude call.">
              <Wrap style={{ gap: spacing.xs }}>
                <Button
                  label={busy === 'fill' ? 'Looking…' : 'Find addresses'}
                  icon="search"
                  kind="secondary"
                  disabled={busy != null}
                  onPress={() => run('fill', () => api.scoutFillMenus(8), (r) => `Looked at ${r.looked} places.`)}
                />
                <Button
                  label={busy === 'read' ? 'Started' : 'Read them'}
                  icon="restaurant"
                  disabled={busy != null}
                  onPress={() => run('read', () => api.scoutReadMenus(10), (r) => `Reading ${r.started} menus in the background — the figures above will move.`)}
                />
                <Button
                  label="Try the failures again"
                  icon="refresh"
                  kind="secondary"
                  disabled={busy != null}
                  onPress={() => run('retry', () => api.scoutRetryMenus(), (r) => `${r.requeued} put back in the queue.`)}
                />
              </Wrap>
            </Panel>
          ) : null}

          {/* The report. Sixty-three sentences became nine causes, and each one
              names a different fix — which is the whole reason for coding them
              (domain/menuCauses.js). */}
          <Panel
            title="What would fix the backlog"
            sub={`${count(causes.reduce((n, c) => n + c.n, 0))} places we could not read, grouped by what is actually wrong`}
            right={canManage ? (
              <Button label="Read the reasons again" icon="refresh" kind="secondary" disabled={busy != null}
                      onPress={() => run('classify', () => api.scoutClassify(),
                        (r) => `Read ${r.looked} recorded failures into ${r.classified} causes.`)} />
            ) : undefined}
            padded={false}
          >
            {causes.length === 0 ? (
              <View style={{ padding: spacing.md }}>
                <Text style={type.small}>Nothing outstanding — or nothing classified yet.</Text>
              </View>
            ) : causes.map((c) => (
              <Pressable
                key={c.key}
                onPress={() => setCause(cause === c.key ? null : c.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: cause === c.key }}
                style={({ hovered }: any) => [
                  styles.causeRow, hovered && { backgroundColor: colors.well }, cause === c.key && { backgroundColor: colors.accentSoft },
                ]}
              >
                <Text style={styles.causeCount}>{count(c.n)}</Text>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Row style={{ gap: spacing.xs, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Text style={[type.body, { fontWeight: '700' }]}>{c.label}</Text>
                    {/* Ours is not a finding about anybody's restaurant, and the
                        report says so rather than letting it sit in the middle
                        looking like one. */}
                    {c.key === 'ours' ? <Pill label="our fault, not theirs" tone="crit" /> : null}
                    {c.exhausted ? <Pill label={`${count(c.exhausted)} given up on`} tone="warn" /> : null}
                  </Row>
                  <Text style={type.tiny}>{c.detail}</Text>
                  <Text style={[type.tiny, { color: colors.accent }]}>{c.fix}</Text>
                  {c.examples.length ? (
                    <Text style={type.tiny} numberOfLines={1}>{c.examples.join(' · ')}</Text>
                  ) : null}
                </View>
                {canManage ? (
                  <Button
                    label={busy === `cause:${c.key}` ? 'Queued' : 'Try these again'}
                    icon="refresh" kind="secondary" disabled={busy != null}
                    onPress={() => run(`cause:${c.key}`, () => api.scoutRetryCause(c.key),
                      (r) => `${r.requeued} put back in the queue. Fix the crawler first, or they will fail the same way.`)}
                  />
                ) : null}
              </Pressable>
            ))}
          </Panel>

          <Panel
            title={cause ? `${causes.find((c) => c.key === cause)?.label ?? cause}` : 'What Roam could not read, and why'}
            sub={cause
              ? 'The places behind that cause, each with the sentence the crawler wrote about it'
              : 'An empty tab with a cause against it, so a change to the crawler is a number that moves'}
            right={cause ? <Button label="Every cause" kind="secondary" onPress={() => setCause(null)} /> : undefined}
            padded={false}
          >
            {misses.filter((m) => !cause || m.cause === cause).length === 0 ? (
              <View style={{ padding: spacing.md }}><Text style={type.small}>Nothing outstanding.</Text></View>
            ) : misses.filter((m) => !cause || m.cause === cause).map((m) => (
              <View key={m.venue_ref} style={styles.missRow}>
                <Icon name={m.state === 'found' ? 'hours' : 'info'} size={15} color={m.state === 'found' ? colors.accent : colors.inkMuted} />
                <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                  <Text style={type.body} numberOfLines={1}>{m.venue_label ?? m.venue_ref}</Text>
                  <Text style={type.tiny}>
                    {m.state === 'found' ? 'Found, waiting to be read' : reason(m.why)}
                  </Text>
                </View>
                {m.menu_url ? (
                  <Pressable onPress={() => void Linking.openURL(m.menu_url!)}><Text style={styles.link}>open</Text></Pressable>
                ) : m.website ? (
                  <Pressable onPress={() => void Linking.openURL(m.website!)}><Text style={styles.link}>site</Text></Pressable>
                ) : null}
              </View>
            ))}
          </Panel>
        </>
      ) : null}
    </AdminPage>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 8, color: colors.ink, backgroundColor: colors.surface,
  },
  areaRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line,
  },
  areaRowOn: { backgroundColor: colors.headerBg },
  areaCode: { ...type.body, fontWeight: '800' },
  placeRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line,
  },
  rank: { ...type.tiny, width: 22, textAlign: 'right', color: colors.inkMuted },
  score: { ...type.body, fontWeight: '800', width: 40, textAlign: 'right' },
  causeRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
  causeCount: { ...type.body, fontWeight: '800', width: 44, textAlign: 'right' },
  missRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line,
  },
  link: { ...type.tiny, color: colors.accent, textDecorationLine: 'underline' },
});

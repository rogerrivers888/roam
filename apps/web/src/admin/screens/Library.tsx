/**
 * The atlas library — the back office screen for the attractions Roam knows
 * about and the pictures it owns.
 *
 * Owner, 4 Sep 2026: "I'd like you to create an admin screen where we can
 * manage all of this data: the source of it, whether we need to have an
 * attribution URL for any of the images, some form of index, a proper form of
 * indexing, so we can search and find the images that we own."
 *
 * Five sections, because those are five different jobs:
 *
 *   Coverage    Which of the 107 UK regions have been harvested, how many
 *               attractions each holds against its target, and the button that
 *               runs the harvest.
 *   Attractions The ranked list for one region, with the score's working on
 *               each row, and publish / hide / pin.
 *   Pictures    The library and its index. A search box over the weighted
 *               tsvector, facets down the side, and a panel that shows every
 *               licence field on one picture — including the attribution URL,
 *               as a link, because the whole point of keeping it is being able
 *               to go there.
 *   Uploads     What households have sent in, waiting for somebody to look, and
 *               what they have earned.
 *   Types       The classifier: which Wikidata types count as somewhere to go.
 *               Editable, so "a railway station is not a day out" is a decision
 *               somebody makes once and it sticks.
 *
 * Layout follows the shell's rule (CLAUDE.md): width comes from `useViewport`,
 * the sections are one tree with different styles rather than two returns, and
 * nothing overflows 390px.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, HarvestRun, LibraryAttraction, LibraryContributor, LibraryImage, LibraryKind, LibraryOverview, LibraryRegion } from '../../api';
import { colors, radius, spacing, TARGET, type } from '../../theme';
import { Icon } from '../../components/Icon';
import { Button, Chip, Row, Wrap } from '../../components/ui';
import { useViewport } from '../../hooks/useViewport';
import { AdminPage, Banner, FilterChip, FilterRow, PageHead, Panel, Pill, Tile, TileRow, ago, count, plural } from '../kit';

const WIDE = 900;

type Section = 'coverage' | 'attractions' | 'pictures' | 'uploads' | 'types';

const SECTIONS: { key: Section; label: string; needs?: 'manage' }[] = [
  { key: 'coverage', label: 'Coverage' },
  { key: 'attractions', label: 'Attractions' },
  { key: 'pictures', label: 'Pictures' },
  { key: 'uploads', label: 'Uploads' },
  { key: 'types', label: 'Types' },
];

/** "1.2 GB", "740 MB", "18 KB" — storage said the way a person would say it. */
const size = (bytes: number | string | null | undefined) => {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
};

const STATE_TONE: Record<string, 'plain' | 'ok' | 'warn' | 'crit' | 'accent'> = {
  never: 'plain', queued: 'accent', running: 'accent', done: 'ok', failed: 'crit',
};

export function Library({ canManage }: { canManage: boolean }) {
  const { width } = useViewport();
  const wide = width >= WIDE;
  const [section, setSection] = useState<Section>('coverage');
  const [overview, setOverview] = useState<LibraryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setOverview(await api.libraryOverview()); setError(null); }
    catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // While a harvest is running the screen is a progress display, so it asks
  // again every few seconds. It stops the moment the run does — a back office
  // that polls forever is one that keeps a laptop awake all night.
  const running = overview?.running ?? null;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  const openRegion = (slug: string) => { setRegion(slug); setSection('attractions'); };

  return (
    <AdminPage>
      <PageHead
        title="Atlas library"
        sub="The attractions in every UK county, and the pictures Roam owns of them."
      />

      {error ? <Banner tone="crit">{error}</Banner> : null}

      {/* What the whole thing amounts to, on every section, because the two
          numbers that matter most — how much is published and how much it
          weighs — are the ones you want in view while you change anything. */}
      {overview ? (
        <TileRow>
          <Tile label="Published" value={count(Number(overview.totals.published))}
                sub={`of ${count(Number(overview.totals.attractions))} found, across ${overview.totals.regions_done} of ${overview.totals.regions} regions`} tone="ok" />
          <Tile label="Pictures" value={count(Number(overview.totals.images))}
                sub={`${count(Number(overview.totals.needing_credit))} need a credit line`} />
          <Tile label="Held" value={size(overview.totals.bytes)}
                sub={`${count(Number(overview.totals.variants))} files at ${overview.widths.hero.join(', ')}px`} />
          <Tile label="No picture" value={count(Number(overview.totals.published_without_image))}
                sub="Published attractions with no card image"
                tone={Number(overview.totals.published_without_image) ? 'warn' : 'plain'} />
          <Tile label="Waiting" value={count(overview.pendingUploads)}
                sub="Household uploads nobody has looked at"
                tone={overview.pendingUploads ? 'warn' : 'plain'} />
        </TileRow>
      ) : null}

      {running ? <RunProgress run={running} canManage={canManage} onChange={load} /> : null}

      {/* The section picker. A row of chips on any width — on a phone it
          scrolls sideways rather than wrapping into three lines. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }}>
        {SECTIONS.map((s) => (
          <Pressable key={s.key} onPress={() => setSection(s.key)}
                     style={[styles.tab, section === s.key && styles.tabOn]} accessibilityRole="tab"
                     accessibilityState={{ selected: section === s.key }}>
            <Text style={[type.small, section === s.key && { color: colors.primaryFg, fontWeight: '700' }]}>{s.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {section === 'coverage' ? (
        <Coverage overview={overview} canManage={canManage} onOpen={openRegion} onChanged={load} wide={wide} busy={Boolean(running)} />
      ) : null}
      {section === 'attractions' ? (
        <Attractions regions={overview?.coverage ?? []} region={region} onRegion={setRegion} canManage={canManage} wide={wide} />
      ) : null}
      {section === 'pictures' ? <Pictures regions={overview?.coverage ?? []} canManage={canManage} wide={wide} /> : null}
      {section === 'uploads' ? <Uploads canManage={canManage} /> : null}
      {section === 'types' ? <Types canManage={canManage} /> : null}
    </AdminPage>
  );
}

// ---------------------------------------------------------------------------
// a run in progress
// ---------------------------------------------------------------------------

/**
 * What the harvest is doing right now.
 *
 * The last few lines of its own log rather than a spinner, because this job
 * takes hours and "still working" is not information. Each line is what the
 * pipeline actually said — "Kent: 516 notable things with an article" — so a
 * run that is producing nothing is visibly producing nothing.
 */
function RunProgress({ run, canManage, onChange }: { run: HarvestRun; canManage: boolean; onChange: () => void }) {
  const [full, setFull] = useState<HarvestRun | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => { try { const r = await api.libraryRun(run.id); if (live) setFull(r.run); } catch { /* the overview already says it is running */ } };
    tick();
    const t = setInterval(tick, 4000);
    return () => { live = false; clearInterval(t); };
  }, [run.id]);

  const lines = (full?.log ?? []).slice(-6);
  const c = full?.counts ?? run.counts ?? {};
  return (
    <Panel title="Harvesting" sub={full?.stage ?? run.stage ?? 'starting'}
           right={canManage ? (
             <Button label="Stop" icon="stop" kind="secondary"
                     onPress={async () => { await api.libraryCancel(run.id).catch(() => null); onChange(); }} />
           ) : undefined}>
      <Wrap>
        {Object.entries({ regions: 'regions', published: 'published', stored: 'pictures', refused: 'refused on licence', failed: 'regions failed' })
          .map(([k, label]) => (
            <Pill key={k} label={`${count(Number(c[k] ?? 0))} ${label}`}
                  tone={Number(c[k]) && (k === 'refused' ? 'warn' : k === 'failed' ? 'crit' : 'plain') || 'plain'} />
          ))}
        {c.bytes ? <Pill label={size(c.bytes)} /> : null}
      </Wrap>
      <View style={styles.log}>
        {lines.length
          ? lines.map((l, i) => <Text key={i} style={styles.logLine}>{l.line}</Text>)
          : <Text style={type.tiny}>Starting…</Text>}
      </View>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

function Coverage({ overview, canManage, onOpen, onChanged, wide, busy: running }: {
  overview: LibraryOverview | null; canManage: boolean; onOpen: (slug: string) => void;
  onChanged: () => void; wide: boolean; busy?: boolean;
}) {
  const [nation, setNation] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // One harvest at a time is the API's rule, so a second button press is a 409
  // rather than a second run. Better to have the buttons off than to explain
  // the refusal afterwards — the progress panel above is already saying why.
  const busy = sending || Boolean(running);
  const [note, setNote] = useState<string | null>(null);

  const rows = (overview?.coverage ?? []).filter((r) => !nation || r.nation === nation);
  const nations = [...new Set((overview?.coverage ?? []).map((r) => r.nation))];
  const never = (overview?.coverage ?? []).filter((r) => r.harvest_state === 'never').length;
  const failed = (overview?.coverage ?? []).filter((r) => r.harvest_state === 'failed').length;

  const harvest = async (body: Parameters<typeof api.libraryHarvest>[0]) => {
    setSending(true); setNote(null);
    try { await api.libraryHarvest(body); onChanged(); }
    catch (e: any) { setNote(e.message); }
    finally { setSending(false); }
  };

  return (
    <>
      {canManage ? (
        <Panel title="Run the harvest"
               sub="Wikidata for what is there, Wikipedia for how many people look it up, Wikimedia Commons for the pictures. No key, no account, no bill — about a minute and a half a county.">
          <Wrap>
            <Button label={running ? 'A harvest is already running' : `Everything (${overview?.coverage.length ?? 0} regions)`} icon="download" disabled={busy}
                    onPress={() => harvest({ scope: 'all', withImages: true, refreshTypes: true })} />
            <Button label={`Not done yet (${never})`} kind="secondary" disabled={busy || !never}
                    onPress={() => harvest({ scope: 'never', withImages: true })} />
            <Button label={`Retry failures (${failed})`} kind="secondary" disabled={busy || !failed}
                    onPress={() => harvest({ scope: 'failed', withImages: true })} />
          </Wrap>
          {note ? <Banner tone="crit">{note}</Banner> : null}
          <Text style={type.tiny}>
            Everything harvested here is CC0, CC BY, CC BY-SA or public domain, and may be kept and shown for good
            with the credit each picture carries. Nothing from Google, Tripadvisor or Yelp is admissible — their terms
            forbid storing it (Technical Constraints §4).
          </Text>
        </Panel>
      ) : null}

      <Panel title="The United Kingdom" sub={`${rows.length} regions`} padded={false}>
        <View style={{ padding: spacing.md, paddingBottom: 0 }}>
          <FilterRow>
            <FilterChip label="All" on={!nation} onPress={() => setNation(null)} />
            {nations.map((n) => (
              <FilterChip key={n} label={n} on={nation === n} onPress={() => setNation(n)}
                          count={(overview?.coverage ?? []).filter((r) => r.nation === n).length} />
            ))}
          </FilterRow>
        </View>
        {rows.map((r) => (
          <RegionRow key={r.slug} region={r} wide={wide} canManage={canManage && !busy}
                     onOpen={() => onOpen(r.slug)}
                     onHarvest={() => harvest({ regions: [r.slug], withImages: true })} />
        ))}
      </Panel>
    </>
  );
}

function RegionRow({ region: r, wide, canManage, onOpen, onHarvest }: {
  region: LibraryRegion; wide: boolean; canManage: boolean; onOpen: () => void; onHarvest: () => void;
}) {
  const short = r.published_count < r.target_count;
  return (
    <Pressable onPress={onOpen} style={({ hovered }: any) => [styles.regionRow, hovered && styles.rowHover]} accessibilityRole="button">
      <View style={{ flex: wide ? 3 : undefined, minWidth: 0 }}>
        <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
        <Text style={type.tiny}>{r.nation} · {r.kind}</Text>
      </View>
      <View style={{ flex: wide ? 2 : undefined, minWidth: 0 }}>
        <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
          <Pill label={`${r.published_count}/${r.target_count}`} tone={short ? 'warn' : 'ok'} />
          <Pill label={plural(r.image_count, 'picture')} icon="camera" />
          {r.candidate_count ? <Pill label={`${r.candidate_count} found`} /> : null}
        </Row>
      </View>
      <View style={{ flex: wide ? 2 : undefined, minWidth: 0 }}>
        <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
          <Pill label={r.harvest_state} tone={STATE_TONE[r.harvest_state] ?? 'plain'} />
          <Text style={type.tiny}>{r.harvested_at ? ago(r.harvested_at) : 'never run'}</Text>
        </Row>
        {r.harvest_error ? <Text style={[type.tiny, { color: colors.overrun }]} numberOfLines={2}>{r.harvest_error}</Text> : null}
      </View>
      {canManage ? (
        <Pressable onPress={onHarvest} style={styles.rowAction} accessibilityRole="button" accessibilityLabel={`Harvest ${r.name}`}>
          <Icon name="refresh" size={15} color={colors.icon} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// attractions
// ---------------------------------------------------------------------------

function Attractions({ regions, region, onRegion, canManage, wide }: {
  regions: LibraryRegion[]; region: string | null; onRegion: (s: string | null) => void;
  canManage: boolean; wide: boolean;
}) {
  const [rows, setRows] = useState<LibraryAttraction[]>([]);
  const [state, setState] = useState<string>('published');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.libraryAttractions({
        region: region ?? undefined, state: state === 'all' ? undefined : state,
        q: q || undefined, limit: 300,
      });
      setRows(r.attractions);
    } finally { setBusy(false); }
  }, [region, state, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  const curate = async (row: LibraryAttraction, body: { state?: string; pinned?: boolean }) => {
    await api.libraryCurate(row.id, body);
    load();
  };

  const withImages = regions.filter((r) => r.published_count > 0);
  return (
    <Panel title={region ? regions.find((r) => r.slug === region)?.name ?? region : 'Everywhere'}
           sub="Ranked by how many people look it up, whether you can visit, how notable it is and what it is designated."
           padded={false}>
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <Row style={{ gap: spacing.sm }}>
          <View style={styles.search}>
            <Icon name="search" size={15} color={colors.inkMuted} />
            <TextInput value={q} onChangeText={setQ} placeholder="Find an attraction by name"
                       placeholderTextColor={colors.inkFaint} style={styles.searchInput} />
          </View>
        </Row>
        <FilterRow>
          <FilterChip label="Published" on={state === 'published'} onPress={() => setState('published')} />
          <FilterChip label="Candidates" on={state === 'candidate'} onPress={() => setState('candidate')} />
          <FilterChip label="Hidden" on={state === 'hidden'} onPress={() => setState('hidden')} />
          <FilterChip label="All" on={state === 'all'} onPress={() => setState('all')} />
        </FilterRow>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }}>
          <FilterChip label="Every region" on={!region} onPress={() => onRegion(null)} />
          {withImages.map((r) => (
            <FilterChip key={r.slug} label={r.name} on={region === r.slug} onPress={() => onRegion(r.slug)} count={r.published_count} />
          ))}
        </ScrollView>
      </View>

      {!rows.length ? (
        <View style={{ padding: spacing.lg }}>
          <Text style={type.small}>{busy ? 'Looking…' : 'Nothing here yet — harvest a region on Coverage.'}</Text>
        </View>
      ) : null}

      {rows.map((a) => (
        <AttractionRow key={a.id} row={a} wide={wide} canManage={canManage} onCurate={curate} />
      ))}
    </Panel>
  );
}

function AttractionRow({ row: a, wide, canManage, onCurate }: {
  row: LibraryAttraction; wide: boolean; canManage: boolean;
  onCurate: (row: LibraryAttraction, body: { state?: string; pinned?: boolean }) => void;
}) {
  const p = a.score_parts ?? {};
  return (
    <View style={styles.attractionRow}>
      {/* The card image at the size a card uses it, with the placeholder
          underneath — so this screen shows exactly what a household will see,
          including the moment before the photograph arrives. */}
      <View style={styles.thumb}>
        {a.hero_lqip ? <Image source={{ uri: a.hero_lqip }} style={StyleSheet.absoluteFill as any} resizeMode="cover" /> : null}
        {a.hero_id ? (
          <Image source={{ uri: api.imageUrl(a.hero_id, 500) }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
        ) : (
          <Icon name="camera" size={16} color={colors.inkFaint} />
        )}
      </View>

      <View style={{ flex: wide ? 4 : undefined, minWidth: 0, gap: 2 }}>
        <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
          <Text style={styles.rowName} numberOfLines={1}>{a.rank ? `${a.rank}. ` : ''}{a.name}</Text>
          {a.pinned ? <Icon name="pinned" size={13} color={colors.accent} /> : null}
        </Row>
        <Text style={type.tiny} numberOfLines={wide ? 2 : 3}>{a.summary ?? 'No description yet.'}</Text>
        <Wrap>
          {a.category ? <Pill label={a.category} /> : null}
          {a.heritage ? <Pill label={a.heritage} /> : null}
          <Pill label={plural(Number(a.image_count), 'picture')} icon="camera" />
        </Wrap>
      </View>

      {/* The score's working. "Why is this fourth" is the first question
          anybody asks of a ranked list, so the parts are on the row. */}
      <View style={{ flex: wide ? 2 : undefined, minWidth: 0, gap: 2 }}>
        <Text style={styles.score}>{a.score.toFixed(3)}</Text>
        <Text style={type.tiny}>
          {a.pageviews_year != null ? `${count(a.pageviews_year)} views/yr` : 'no view data'}
          {p.visitorsPerYear ? ` · ${count(p.visitorsPerYear)} visitors` : ''}
        </Text>
        <Text style={type.tiny}>
          {a.sitelinks} sitelinks{p.open ? ` · open ${p.open}` : ''}{p.viewsEstimated ? ' · views estimated' : ''}
        </Text>
      </View>

      {canManage ? (
        <Row style={{ gap: spacing.xs, flexWrap: 'wrap' }}>
          <Chip label={a.pinned ? 'Pinned' : 'Pin'} icon="pinned" selected={a.pinned}
                onPress={() => onCurate(a, { pinned: !a.pinned })} />
          {a.state === 'hidden'
            ? <Chip label="Restore" icon="refresh" onPress={() => onCurate(a, { state: 'candidate' })} />
            : <Chip label="Hide" icon="close" onPress={() => onCurate(a, { state: 'hidden' })} />}
        </Row>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// pictures — the index
// ---------------------------------------------------------------------------

/**
 * The library, searched.
 *
 * `q` goes to the weighted tsvector on `image_assets`, so the search covers the
 * picture's own title and tags first, then its caption and the attraction it is
 * of, then the county. "castle kent" finds Leeds Castle whether or not either
 * word is in the file name — which is the difference between a folder of JPEGs
 * and a library.
 */
function Pictures({ regions, canManage, wide }: { regions: LibraryRegion[]; canManage: boolean; wide: boolean }) {
  const [q, setQ] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [credit, setCredit] = useState<boolean | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const [images, setImages] = useState<LibraryImage[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<LibraryImage | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setBusy(true);
    try {
      const r = await api.libraryImages({
        q: q || undefined, source: source ?? undefined, region: region ?? undefined,
        credit: credit ?? undefined, unlinked: unlinked || undefined, limit: 60,
      });
      // A slow answer to an old query must not overwrite a fast answer to the
      // one being typed now.
      if (mine !== seq.current) return;
      setImages(r.images); setTotal(r.total);
    } finally { if (mine === seq.current) setBusy(false); }
  }, [q, source, region, credit, unlinked]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  return (
    <>
      <Panel title="The index" sub={`${count(total)} pictures${q ? ` matching “${q}”` : ''}`}>
        <View style={styles.search}>
          <Icon name="search" size={15} color={colors.inkMuted} />
          <TextInput value={q} onChangeText={setQ}
                     placeholder="Search the library — a place, a county, a photographer, a licence"
                     placeholderTextColor={colors.inkFaint} style={styles.searchInput} />
          {q ? (
            <Pressable onPress={() => setQ('')} accessibilityRole="button" accessibilityLabel="Clear">
              <Icon name="close" size={14} color={colors.inkMuted} />
            </Pressable>
          ) : null}
        </View>
        <FilterRow>
          <FilterChip label="Everything" on={!source && credit == null && !unlinked && !region}
                      onPress={() => { setSource(null); setCredit(null); setUnlinked(false); setRegion(null); }} />
          <FilterChip label="Wikimedia" on={source === 'wikimedia'} onPress={() => setSource(source === 'wikimedia' ? null : 'wikimedia')} />
          <FilterChip label="From households" on={source === 'household'} onPress={() => setSource(source === 'household' ? null : 'household')} />
          <FilterChip label="Needs a credit" on={credit === true} onPress={() => setCredit(credit === true ? null : true)} />
          <FilterChip label="Free of conditions" on={credit === false} onPress={() => setCredit(credit === false ? null : false)} />
          <FilterChip label="Attached to nothing" on={unlinked} onPress={() => setUnlinked(!unlinked)} />
        </FilterRow>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs }}>
          {regions.filter((r) => r.image_count > 0).map((r) => (
            <FilterChip key={r.slug} label={r.name} on={region === r.slug}
                        onPress={() => setRegion(region === r.slug ? null : r.slug)} count={r.image_count} />
          ))}
        </ScrollView>
      </Panel>

      {/* Above the grid, not below it. Six hundred pictures is a long way to
          scroll, and a panel that opens off the bottom of that reads as a click
          that did nothing — which is what it looked like the first time I tried
          it on the deployed site. */}
      {open ? <ImageDetail image={open} canManage={canManage} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }} wide={wide} /> : null}

      {!images.length ? (
        <Panel><Text style={type.small}>{busy ? 'Searching…' : 'Nothing matches.'}</Text></Panel>
      ) : null}

      <View style={styles.grid}>
        {images.map((img) => (
          <Pressable key={img.id} onPress={() => setOpen(img)} style={styles.cell} accessibilityRole="button"
                     accessibilityLabel={img.title ?? 'Picture'}>
            <View style={styles.cellShot}>
              {img.lqip ? <Image source={{ uri: img.lqip }} style={StyleSheet.absoluteFill as any} resizeMode="cover" /> : null}
              <Image source={{ uri: api.imageUrl(img.id, 500) }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
            </View>
            <Text style={styles.cellTitle} numberOfLines={1}>{img.title ?? img.source_ref}</Text>
            <Row style={{ gap: 4, flexWrap: 'wrap' }}>
              <Pill label={img.licence} tone={img.attribution_required ? 'plain' : 'ok'} />
              {img.moderation !== 'approved' ? <Pill label={img.moderation} tone="warn" /> : null}
            </Row>
          </Pressable>
        ))}
      </View>

    </>
  );
}

/**
 * One picture, and everything anybody could be asked to produce about it.
 *
 * Drawn inline underneath the grid rather than in a `Modal`, on purpose: a
 * modal has to be pinned to the phone frame (CLAUDE.md) and this panel is a
 * reference sheet somebody reads with the grid still in view, not an
 * interruption.
 *
 * The attribution URL is a link. That is the whole reason the column exists —
 * the answer to "where did this come from and what does its licence say" has to
 * be one tap, not a database query.
 */
function ImageDetail({ image, canManage, onClose, onChanged, wide }: {
  image: LibraryImage; canManage: boolean; onClose: () => void; onChanged: () => void; wide: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const fields: [string, React.ReactNode][] = [
    ['Source', image.source],
    ['File', image.source_ref ?? '—'],
    ['Licence', image.licence],
    ['Credit needed', image.attribution_required ? 'Yes — show the line below wherever this appears' : 'No conditions'],
    ['Credit line', image.credit_line ?? '—'],
    ['Photographer', image.creator ?? 'Unknown'],
    ['Size', `${image.width ?? '?'} × ${image.height ?? '?'} · ${size(image.held_bytes)} held at ${(image.widths ?? []).join(', ')}px`],
    ['Added', ago(image.fetched_at)],
  ];

  return (
    <Panel title={image.title ?? 'Picture'} sub={image.caption ?? undefined}
           right={<Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close"><Icon name="close" size={18} color={colors.inkMuted} /></Pressable>}>
      <View style={[styles.detail, wide && { flexDirection: 'row' }]}>
        <View style={[styles.detailShot, wide && { width: 320, height: 220 }]}>
          {image.lqip ? <Image source={{ uri: image.lqip }} style={StyleSheet.absoluteFill as any} resizeMode="cover" /> : null}
          <Image source={{ uri: api.imageUrl(image.id, 960) }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
        </View>

        <View style={{ flex: 1, gap: spacing.xs, minWidth: 0 }}>
          {fields.map(([k, v]) => (
            <Row key={k} style={{ gap: spacing.sm, alignItems: 'flex-start' }}>
              <Text style={[type.tiny, { width: 110 }]}>{k}</Text>
              <Text style={[type.small, { flex: 1, minWidth: 0 }]}>{v}</Text>
            </Row>
          ))}

          {/* The two links that make this row defensible. */}
          <Wrap>
            {image.source_page_url ? (
              <Chip label="Where it came from" icon="external" onPress={() => Linking.openURL(image.source_page_url!)} />
            ) : null}
            {image.licence_url ? (
              <Chip label="The licence" icon="external" onPress={() => Linking.openURL(image.licence_url!)} />
            ) : null}
            {image.creator_url ? (
              <Chip label="The photographer" icon="external" onPress={() => Linking.openURL(image.creator_url!)} />
            ) : null}
          </Wrap>

          {image.links?.length ? (
            <Wrap>
              {image.links.map((l) => (
                <Pill key={`${l.type}:${l.id}`} label={`${l.label ?? l.id}${l.role === 'hero' ? ' (card)' : ''}`} />
              ))}
            </Wrap>
          ) : <Banner tone="warn">This picture is not attached to anything, so nothing shows it.</Banner>}

          {image.tags?.length ? (
            <Row style={{ gap: spacing.sm, alignItems: 'flex-start' }}>
              <Text style={[type.tiny, { width: 110 }]}>Indexed under</Text>
              <Text style={[type.tiny, { flex: 1, minWidth: 0 }]}>{image.tags.join(' · ')}</Text>
            </Row>
          ) : null}

          {canManage ? (
            <Wrap>
              {image.moderation !== 'approved' ? (
                <Button label="Approve" icon="check" disabled={busy}
                        onPress={async () => { setBusy(true); await api.libraryModerate(image.id, { moderation: 'approved' }); onChanged(); }} />
              ) : null}
              {image.moderation !== 'rejected' && image.source === 'household' ? (
                <Button label="Reject" kind="secondary" disabled={busy}
                        onPress={async () => { setBusy(true); await api.libraryModerate(image.id, { moderation: 'rejected' }); onChanged(); }} />
              ) : null}
              <Button label="Remove from the library" kind="secondary" disabled={busy}
                      onPress={async () => { setBusy(true); await api.libraryDeleteImage(image.id); onChanged(); }} />
            </Wrap>
          ) : null}
        </View>
      </View>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// uploads
// ---------------------------------------------------------------------------

/**
 * What households have sent in.
 *
 * Nothing uploads yet — the app has no camera flow for this, and that is said
 * on the screen rather than left as an empty table that reads as "nobody has
 * bothered". What exists is the half that has to exist first: a place for the
 * pictures to land, a licence grant recorded with them, somebody to look before
 * anything is published, and a ledger of what each household earned.
 */
function Uploads({ canManage }: { canManage: boolean }) {
  const [pending, setPending] = useState<LibraryImage[]>([]);
  const [board, setBoard] = useState<LibraryContributor[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([
      api.libraryImages({ moderation: 'pending', limit: 60 }),
      api.libraryContributors().catch(() => []),
    ]);
    setPending(p.images); setBoard(c as LibraryContributor[]); setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <Panel title="Waiting to be looked at" sub={`${plural(pending.length, 'picture')} from households`}>
        {!pending.length ? (
          <Text style={type.small}>
            {loaded
              ? 'Nothing waiting. The app has no upload flow yet — this is where a household’s photographs will arrive, with the licence they granted recorded alongside them, and nothing is published before somebody here approves it.'
              : 'Looking…'}
          </Text>
        ) : null}
        <View style={styles.grid}>
          {pending.map((img) => (
            <View key={img.id} style={styles.cell}>
              <View style={styles.cellShot}>
                {img.lqip ? <Image source={{ uri: img.lqip }} style={StyleSheet.absoluteFill as any} resizeMode="cover" /> : null}
                <Image source={{ uri: api.imageUrl(img.id, 500) }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
              </View>
              <Text style={styles.cellTitle} numberOfLines={1}>{img.title ?? 'Untitled'}</Text>
              {canManage ? (
                <Row style={{ gap: spacing.xs }}>
                  <Chip label="Approve" icon="check" onPress={async () => { await api.libraryModerate(img.id, { moderation: 'approved', points: 10 }); load(); }} />
                  <Chip label="Reject" icon="close" onPress={async () => { await api.libraryModerate(img.id, { moderation: 'rejected' }); load(); }} />
                </Row>
              ) : null}
            </View>
          ))}
        </View>
      </Panel>

      <Panel title="What households have earned"
             sub="Points, not money — nothing in Roam moves money, and a reward that implied a payment would be a promise we cannot keep.">
        {!board.length ? <Text style={type.small}>Nobody has contributed a picture yet.</Text> : null}
        {board.map((c) => (
          <Row key={c.id} style={styles.boardRow}>
            <View style={{ flex: 2, minWidth: 0 }}>
              <Text style={styles.rowName} numberOfLines={1}>{c.household ?? c.email}</Text>
              <Text style={type.tiny}>{c.email}</Text>
            </View>
            <Pill label={`${c.accepted} accepted`} tone="ok" />
            {Number(c.waiting) ? <Pill label={`${c.waiting} waiting`} tone="warn" /> : null}
            <Text style={styles.score}>{c.points}</Text>
          </Row>
        ))}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// types — the classifier
// ---------------------------------------------------------------------------

function Types({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<LibraryKind[]>([]);
  const [q, setQ] = useState('');
  const [admit, setAdmit] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setRows((await api.libraryKinds({ q: q || undefined, admit: admit ?? undefined, limit: 200 })).kinds);
  }, [q, admit]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  return (
    <Panel title="What counts as somewhere to go"
           sub="Wikidata says a place is a castle or a metro station; this is where Roam decides which of those is a day out. About 5,300 types, ordered by how often they have come back."
           padded={false}>
      <View style={{ padding: spacing.md, gap: spacing.sm }}>
        <View style={styles.search}>
          <Icon name="search" size={15} color={colors.inkMuted} />
          <TextInput value={q} onChangeText={setQ} placeholder="A type, a category, or a Q-number"
                     placeholderTextColor={colors.inkFaint} style={styles.searchInput} />
        </View>
        <FilterRow>
          <FilterChip label="All" on={admit == null} onPress={() => setAdmit(null)} />
          <FilterChip label="Counted" on={admit === true} onPress={() => setAdmit(true)} />
          <FilterChip label="Refused" on={admit === false} onPress={() => setAdmit(false)} />
        </FilterRow>
      </View>
      {rows.map((k) => (
        <Row key={k.qid} style={styles.typeRow}>
          <View style={{ flex: 2, minWidth: 0 }}>
            <Text style={styles.rowName} numberOfLines={1}>{k.label ?? k.qid}</Text>
            <Text style={type.tiny}>{k.qid}{k.seen_count ? ` · seen ${count(k.seen_count)} times` : ''}</Text>
          </View>
          <Pill label={k.category ?? '—'} />
          {k.overridden ? <Pill label="decided by hand" tone="accent" /> : null}
          {canManage ? (
            <Chip label={k.admit ? 'Counted' : 'Refused'} icon={k.admit ? 'check' : 'close'} selected={k.admit}
                  onPress={async () => { await api.librarySetKind(k.qid, { admit: !k.admit }); load(); }} />
          ) : <Pill label={k.admit ? 'Counted' : 'Refused'} tone={k.admit ? 'ok' : 'plain'} />}
        </Row>
      ))}
    </Panel>
  );
}

const styles = StyleSheet.create({
  tab: {
    paddingHorizontal: spacing.md, height: 34, justifyContent: 'center',
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  tabOn: { backgroundColor: colors.primary, borderColor: colors.primary },

  log: { backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, padding: spacing.sm, gap: 2 },
  logLine: { ...type.tiny, color: colors.ink },

  regionRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
  rowHover: { backgroundColor: colors.surfaceMuted },
  rowName: { ...type.body, fontWeight: '700', color: colors.ink },
  rowAction: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },

  attractionRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, alignItems: 'flex-start',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
  thumb: {
    width: 96, height: 72, borderRadius: radius.lg, overflow: 'hidden',
    backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center',
  },
  score: { ...type.body, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },

  search: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flex: 1, minWidth: 0,
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg,
    paddingHorizontal: spacing.sm, height: TARGET, backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, minWidth: 0, ...type.body, color: colors.ink, outlineStyle: 'none' as any },

  // Auto-fitting, like the tile row: cells grow to fill the width and never
  // stretch past a size a photograph stops looking like one.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { flexGrow: 1, flexBasis: 170, minWidth: 150, maxWidth: 280, gap: 4 },
  cellShot: {
    width: '100%', aspectRatio: 4 / 3, borderRadius: radius.lg, overflow: 'hidden',
    backgroundColor: colors.surfaceMuted,
  },
  cellTitle: { ...type.small, color: colors.ink, fontWeight: '600' },

  detail: { gap: spacing.md },
  detailShot: {
    width: '100%', aspectRatio: 4 / 3, borderRadius: radius.lg, overflow: 'hidden',
    backgroundColor: colors.surfaceMuted,
  },

  boardRow: {
    gap: spacing.sm, alignItems: 'center', flexWrap: 'wrap',
    paddingVertical: spacing.xs, borderTopWidth: 1, borderTopColor: colors.line,
  },
  typeRow: {
    gap: spacing.sm, alignItems: 'center', flexWrap: 'wrap',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderTopWidth: 1, borderTopColor: colors.line,
  },
});

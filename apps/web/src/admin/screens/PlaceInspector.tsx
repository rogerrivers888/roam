/**
 * One place, opened — and corrected where the mistake is.
 *
 * Owner, 5 Sep 2026: "When I click into Windsor Castle, if I click edit on the
 * category, I should be able to train as to why this is miscategorized right
 * there."
 *
 * So Edit on the Category row does not open a dropdown. It opens a box you say
 * a sentence into, and Roam comes back with what it heard, which type it thinks
 * the rule belongs on, and **how far saving it would travel** — "41 places
 * across 19 counties" — while there is still time to disagree. Nothing is
 * written until Save.
 *
 * A dropdown would fix one row. Legoland is filed `landmark` because *amusement
 * park* is filed `landmark`, so the mistake is on the type and a per-row
 * correction has to be made forty times and drifts on the forty-first.
 *
 * **Two axes, kept apart.** The category says what a place *is*; the shelf says
 * what a day there is *like*. A sentence often implies both, so both are
 * offered — but they are two saves against two tables and the panel says which
 * is which. Roam has been bitten by conflating them before.
 *
 * It is a column rather than a Modal on purpose: a portal has to pin itself to
 * the phone frame (CLAUDE.md) and there is nothing here that needs to float.
 * Wide, it sits beside the list; narrow, it takes the width and the list waits.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, CategoryProposal, LibraryAttractionDetail, ShelfWeights } from '../../api';
import { colors, radius, spacing, type } from '../../theme';
import { Icon } from '../../components/Icon';
import { Button, Chip, Row, Wrap } from '../../components/ui';
import { AdminPage, Banner, Panel, Pill, count, plural } from '../kit';
import { MOODS } from '../../routes';

/** Roam's own eight words, for the fallback when there is no Claude key. */
const CATEGORIES = ['heritage', 'outdoors', 'museum', 'family', 'arts', 'animals', 'active', 'landmark'];

/** Only the two strongest shelves at or above the floor ever draw a card. */
const FLOOR = 0.6;
const MAX_SHELVES = 2;
const drawnShelves = (w: ShelfWeights) =>
  Object.entries(w).filter(([, v]) => (v ?? 0) >= FLOOR)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, MAX_SHELVES).map(([k]) => k);

export function PlaceInspector({ id, onClose, onChanged }: {
  id: string; onClose: () => void; onChanged?: () => void;
}) {
  const [row, setRow] = useState<LibraryAttractionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try { setRow((await api.libraryAttraction(id)).attraction); setError(null); }
    catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { setEditing(false); load(); }, [load]);

  if (error) return <Panel title="Could not open it"><Banner tone="crit">{error}</Banner></Panel>;
  if (!row) return <Panel title="Opening…"><Text style={type.small}>Fetching the record.</Text></Panel>;

  const hero = row.images?.find((i) => i.role === 'hero') ?? row.images?.[0] ?? null;

  return (
    <Panel
      title={row.name}
      sub={`${row.region_slug} · ${row.rank ? `${row.rank} of its county · ` : ''}${row.wikidata_id ?? 'no Wikidata id'}`}
      right={<Button label="Close" icon="close" kind="secondary" onPress={onClose} />}
    >
      {hero ? (
        <View style={styles.hero}>
          <Image source={{ uri: api.imageUrl(hero.id, 960) }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
          {hero.credit_line ? <Text style={styles.credit} numberOfLines={1}>{hero.credit_line}</Text> : null}
        </View>
      ) : null}

      {/* Category, and the whole point of this screen. */}
      <View style={[styles.fact, editing && styles.factOpen]}>
        <Text style={styles.factKey}>Category</Text>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Row style={{ gap: spacing.xs, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill label={row.category ?? 'nothing'} tone={row.category ? 'plain' : 'crit'} />
            {row.pinned ? <Pill label="Pinned — survives the next harvest" tone="accent" icon="pinned" /> : null}
          </Row>
          <Text style={type.tiny}>
            {row.kinds?.length
              ? `from ${plural(row.kinds.length, 'Wikidata type')} — the first one the classifier admits wins`
              : 'no Wikidata types, so only this one place can be corrected'}
          </Text>
        </View>
        {!editing ? (
          <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel="Edit the category"
                     style={styles.editBtn}>
            <Icon name="edit" size={14} color={colors.accent} />
            <Text style={[type.tiny, { color: colors.accent, fontWeight: '700' }]}>Edit</Text>
          </Pressable>
        ) : null}
      </View>

      {editing ? (
        <Teach
          row={row}
          onCancel={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await load(); onChanged?.(); }}
        />
      ) : null}

      <Fact label="Description" value={row.summary ?? null}
            source={row.wikipedia_url ? 'Wikipedia · CC BY-SA' : null}
            blank="Nothing to read in the drawer." />
      <Fact label="Website" value={row.website ?? null} link={row.website ?? undefined}
            source={row.website ? 'their own page' : null} blank="Nowhere to send anybody." />
      <Fact label="Designated" value={row.heritage ?? null} blank="No designation held." />

      <View style={styles.fact}>
        <Text style={styles.factKey}>Score</Text>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={[type.body, { fontWeight: '800' }]}>{row.score?.toFixed(3) ?? '—'}</Text>
          <Text style={type.tiny}>
            {row.pageviews_year != null ? `${count(row.pageviews_year)} views a year` : 'no view data'}
            {` · ${row.sitelinks} sitelinks`}
          </Text>
        </View>
      </View>

      <View style={styles.fact}>
        <Text style={styles.factKey}>Pictures</Text>
        <View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}>
          {row.images?.length ? (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {row.images.map((im) => (
                  <View key={im.id} style={styles.thumb}>
                    <Image source={{ uri: api.imageUrl(im.id, 500) }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
                    {im.role === 'hero' ? <Text style={styles.heroTag}>Hero</Text> : null}
                  </View>
                ))}
              </ScrollView>
              <Text style={type.tiny}>{plural(row.images.length, 'picture')} held, with the credit each one carries.</Text>
            </>
          ) : (
            <Text style={[type.small, { color: colors.overrun }]}>No picture — a household sees the category icon on mint.</Text>
          )}
        </View>
      </View>
    </Panel>
  );
}

function Fact({ label, value, source, link, blank }: {
  label: string; value: string | null; source?: string | null; link?: string; blank: string;
}) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factKey}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {value ? (
          link ? (
            <Pressable onPress={() => Linking.openURL(link)} accessibilityRole="link">
              <Text style={[type.small, { color: colors.accent, textDecorationLine: 'underline' }]} numberOfLines={2}>{value}</Text>
            </Pressable>
          ) : (
            <Text style={type.small} numberOfLines={4}>{value}</Text>
          )
        ) : (
          <Text style={[type.small, { color: colors.overrun }]}>{blank}</Text>
        )}
        {value && source ? <Text style={type.tiny}>{source}</Text> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// the teaching
// ---------------------------------------------------------------------------

function Teach({ row, onCancel, onSaved }: {
  row: LibraryAttractionDetail; onCancel: () => void; onSaved: () => void;
}) {
  const [said, setSaid] = useState('');
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proposal, setProposal] = useState<CategoryProposal | null>(null);
  const [chosen, setChosen] = useState<{ scope: 'place' | 'kind' | 'category'; subject: string } | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [withShelf, setWithShelf] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const read = async () => {
    if (!said.trim()) return;
    setReading(true); setNote(null);
    try {
      const { proposal: p } = await api.categoryRead(row.id, said.trim());
      setProposal(p);
      setCategory(p.category);
      setChosen({ scope: p.suggestedScope, subject: p.options.find((o) => o.scope === p.suggestedScope)?.subject ?? row.id });
      setWithShelf(Boolean((p as any).shelvesToo));
    } catch (e: any) {
      setNote(e.message);
      // No key on this API is the ordinary state locally, so the fallback is
      // the eight words themselves rather than a dead end.
      setProposal({
        category: row.category ?? 'heritage', reason: said.trim(), scope: 'place', suggestedScope: 'place',
        options: [{ scope: 'place', subject: row.id, label: `Only ${row.name}`, affects: 1, regions: 1 }],
        weights: {},
      });
      setCategory(row.category ?? null);
      setChosen({ scope: 'place', subject: row.id });
    } finally { setReading(false); }
  };

  const save = async () => {
    if (!chosen || !category) return;
    setSaving(true); setNote(null);
    try {
      const r = await api.categorySave(row.id, {
        scope: chosen.scope, subject: chosen.subject, category,
        reason: proposal?.reason ?? said.trim(),
        weights: withShelf && proposal?.weights && Object.keys(proposal.weights).length ? proposal.weights : null,
      });
      setNote(`${count(r.moved)} ${r.moved === 1 ? 'place' : 'places'} re-filed.`);
      onSaved();
    } catch (e: any) { setNote(e.message); }
    finally { setSaving(false); }
  };

  const option = proposal?.options.find((o) => o.scope === chosen?.scope && o.subject === chosen?.subject) ?? null;

  return (
    <View style={styles.teach}>
      <Text style={[type.body, { fontWeight: '700' }]}>Why is this wrong?</Text>

      <TextInput
        value={said} onChangeText={setSaid} multiline
        placeholder={`e.g. ${row.name} is a family day out, not something you look at. So is every theme park.`}
        placeholderTextColor={colors.inkFaint}
        style={styles.say}
        accessibilityLabel="Say what is wrong with this category"
      />

      <Wrap>
        <Button label={reading ? 'Reading…' : 'Read it'} icon="search" disabled={!said.trim() || reading} onPress={read} />
        <Button label="Cancel" kind="secondary" onPress={onCancel} />
      </Wrap>

      {note ? <Banner tone={note.includes('re-filed') ? 'ok' : 'warn'}>{note}</Banner> : null}

      {proposal ? (
        <>
          <Text style={styles.legend}>What Roam heard</Text>
          <Text style={type.small}>{proposal.reason}</Text>

          <Text style={styles.legend}>File it as</Text>
          <Wrap>
            {CATEGORIES.map((c) => (
              <Chip key={c} label={c} selected={category === c} onPress={() => setCategory(c)} />
            ))}
          </Wrap>

          <Text style={styles.legend}>And how far that travels</Text>
          <View style={{ gap: 5 }}>
            {proposal.options.map((o) => {
              const on = chosen?.scope === o.scope && chosen?.subject === o.subject;
              return (
                <Pressable
                  key={`${o.scope}:${o.subject}`}
                  onPress={() => setChosen({ scope: o.scope, subject: o.subject })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  style={[styles.scope, on && styles.scopeOn]}
                >
                  <View style={[styles.radio, on && styles.radioOn]} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[type.small, { fontWeight: '700' }]}>{o.label}</Text>
                    <Text style={type.tiny}>
                      {o.affects === 1
                        ? 'This one place only — the rule will not travel.'
                        : `${count(o.affects)} places across ${count(o.regions)} ${o.regions === 1 ? 'county' : 'counties'}.`}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* The other axis, offered and never assumed. */}
          {proposal.weights && Object.keys(proposal.weights).length ? (
            <Pressable onPress={() => setWithShelf(!withShelf)} accessibilityRole="checkbox"
                       accessibilityState={{ checked: withShelf }} style={[styles.scope, withShelf && styles.scopeOn]}>
              <View style={[styles.radio, styles.check, withShelf && styles.radioOn]} />
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <Text style={[type.small, { fontWeight: '700' }]}>Also teach the shelf</Text>
                <Text style={type.tiny}>
                  A category says what a place is; a shelf says what a day there is like. Two axes, saved separately.
                </Text>
                <Wrap>
                  {MOODS.map((m) => {
                    const v = proposal.weights[m] ?? 0;
                    const drawn = drawnShelves(proposal.weights).includes(m);
                    return <Pill key={m} label={`${m} ${v.toFixed(2)}`} tone={drawn ? 'accent' : 'plain'} />;
                  })}
                </Wrap>
                <Text style={type.tiny}>
                  Draws on {drawnShelves(proposal.weights).join(' and ') || 'no shelf'} — only the two strongest at
                  or above {FLOOR} ever show a card.
                </Text>
              </View>
            </Pressable>
          ) : null}

          <View style={styles.summary}>
            <Row style={{ gap: spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
              <Pill label={row.category ?? 'nothing'} tone="crit" />
              <Icon name="forward" size={15} color={colors.inkMuted} />
              <Pill label={category ?? '—'} tone="accent" />
              <Text style={[type.tiny, { marginLeft: 'auto' }]}>
                {option ? `${count(option.affects)} affected` : 'choose how far it travels'}
              </Text>
            </Row>
          </View>

          <Wrap>
            <Button label={saving ? 'Saving…' : 'Save the rule'} icon="check"
                    disabled={saving || !chosen || !category || category === row.category} onPress={save} />
            <Button label="Cancel" kind="secondary" onPress={onCancel} />
          </Wrap>
          <Text style={type.tiny}>
            Nothing is written until you press Save. The sentence is kept on the rule, so the list of what you
            have taught reads as an argument somebody made rather than a row that changed.
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: 130, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.well, justifyContent: 'flex-end' },
  credit: { ...type.tiny, color: '#fff', opacity: 0.9, padding: 5, textAlign: 'right' },

  fact: {
    flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start',
    paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line,
  },
  factOpen: { borderTopColor: colors.accent },
  factKey: {
    ...type.tiny, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: '700',
    width: 84, paddingTop: 2,
  },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2, paddingHorizontal: 6 },

  teach: {
    borderWidth: 1, borderColor: colors.accent, borderRadius: radius.md,
    backgroundColor: colors.accentSoft, padding: spacing.md, gap: spacing.sm,
  },
  say: {
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, backgroundColor: colors.surface,
    padding: spacing.sm, minHeight: 74, ...type.small, color: colors.ink,
    textAlignVertical: 'top', outlineStyle: 'none' as any,
  },
  legend: {
    ...type.tiny, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: '700', marginTop: 2,
  },
  scope: {
    flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start',
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm,
    backgroundColor: colors.surface, padding: spacing.sm,
  },
  scopeOn: { borderColor: colors.accent },
  radio: { width: 15, height: 15, borderRadius: 8, borderWidth: 1.5, borderColor: colors.inkFaint, marginTop: 1 },
  check: { borderRadius: 4 },
  radioOn: { borderColor: colors.accent, backgroundColor: colors.accent },

  summary: {
    borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm,
  },

  thumb: { width: 84, height: 60, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.well },
  heroTag: {
    ...type.tiny, position: 'absolute', top: 4, left: 4, backgroundColor: colors.surface,
    paddingHorizontal: 5, borderRadius: 999, fontWeight: '700',
  },
});

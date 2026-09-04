import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, PrototypeStatus } from '../api';
import { colors, fonts, radius, spacing, type } from '../theme';
import { Button, Card, Row, Wrap } from '../components/ui';
import { Icon, IconName } from '../components/Icon';
import { useViewport } from '../hooks/useViewport';

// Prototypes are filed under the part of the app they belong to, in menu order,
// so "Prototypes > Plan" shows only the Plan mock-ups (owner, 4 Sep 2026).
type Section = 'plan' | 'places' | 'trips' | 'household' | 'settings';
const SECTIONS: { key: Section; label: string; icon: IconName }[] = [
  { key: 'plan', label: 'Plan', icon: 'plan' },
  { key: 'places', label: 'Places', icon: 'places' },
  { key: 'trips', label: 'Trips', icon: 'trips' },
  { key: 'household', label: 'Household', icon: 'household' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

// What the owner has decided about a mock-up. 'new' is "not ruled on yet", and
// it is the tab the screen opens on: the pile still waiting for him.
const STATUSES: { key: PrototypeStatus; label: string; icon: IconName; verb: string }[] = [
  { key: 'new', label: 'To review', icon: 'list', verb: 'Back to review' },
  { key: 'approved', label: 'Approved', icon: 'check', verb: 'Approve' },
  { key: 'rejected', label: 'Rejected', icon: 'close', verb: 'Reject' },
  { key: 'archived', label: 'Archived', icon: 'archived', verb: 'Archive' },
];
const VERDICTS = STATUSES.filter((s) => s.key !== 'new');

// A verdict is a decision, so it reads as one: green for approved, red for
// rejected, ink for archived. Red is the heart's colour in the style guide, but
// the guide keeps a warning red for meaning that must still read, and a
// rejection is that (owner, 4 Sep 2026). Every colour is a palette token, so
// both come out right in dark mode.
const TONES: Record<'approved' | 'rejected' | 'archived', { fg: string; on: string; onFg: string; soft: string }> = {
  approved: { fg: colors.like, on: colors.like, onFg: colors.bg, soft: colors.likeSoft },
  rejected: { fg: colors.overrun, on: colors.overrun, onFg: colors.bg, soft: colors.overrunSoft },
  archived: { fg: colors.inkMuted, on: colors.primary, onFg: colors.primaryFg, soft: colors.surfaceMuted },
};
// The served mock-up pages, newest first within each section. Each is a static page
// under /mockups (apps/web/public/mockups) so it deploys with the app and opens in its own tab.
const PROTOTYPES: { file: string; section: Section; title: string; when: string; what: string }[] = [
  { file: 'menu-order.html', section: 'trips', title: 'Menu, order and stars — the table half of an evening', when: '4 Sep 2026', what: 'The real menu at Circolo Popolare, fetched from the website Google gives us (no photographing): tap a face on a dish to say who wants it or Table to share, open a dish for its allergens, then the order grouped by person and a Show to staff screen in big type. Afterwards stars — only on what stood out, everything untouched counts as fine, one tap for "not great". Live in both palettes, a five-frame storyboard and a web layout, plus what the fetching costs and what we may keep.' },
  { file: 'plan-style.html', section: 'plan', title: 'Plan screen in the Roam style guide — light and dark', when: '3 Sep 2026', what: 'The third-pass layout with the September 2026 style guide applied: light mode Mint (one mint header field, ink on white, Leaf icons, ink buttons, red only for the heart) and dark mode Night · mint (charcoal, raised panels, mint as the primary). Six phone frames and a web layout in each mode.' },
  { file: 'places-styled.html', section: 'places', title: 'Places drill-down — current design beside the style guide, light and dark', when: '3 Sep 2026', what: 'The approved drill-down three ways for each step: the current design, the Roam Style Guide light mode (Mint) and dark mode (Night · mint). Archivo type, 4px corners, ink buttons, one icon colour per mode, red only for the heart (Special is the red heart badge), outlined counts instead of coloured ones, filled or hollow pins. Two calls to check: the Underground line dot keeps its real colour; Special equals the guide\'s favourite.' },
  { file: 'inspire-options.html', section: 'plan', title: 'Inspire me — a cleaner form, three ways', when: '3 Sep 2026', what: 'The form today is twenty-two things to look at; three ways to cut it down, all with who is coming moved into the header as "The family · from home", clashing moods as one pick, budget as a from–to slider and travel on its own line. A three rows like Tell me (Mood; Travel and Budget as one split row opening two sliders); B the little planner (one question a screen, three or four tiles, a strip of picks, sliders on step 3); C a sentence with blanks (four dropdowns that read as what you would say). A web layout and a side-by-side table.' },
  { file: 'plan-palettes.html', section: 'plan', title: 'Plan screen — four colour palettes', when: '3 Sep 2026', what: 'The third-pass screens in four stronger schemes, side by side: A Roam red (ink header, the brand red for pin, trail and Plan it), B deep teal and saffron, C ink and citrus, D navy and coral. Header, pin, row icons, primary button and tiles change; rows and pills stay.' },
  { file: 'places-drilldown.html', section: 'places', title: 'Places — the drill-down, as chosen', when: '3 Sep 2026', what: 'Option A as picked: countries fold to cities (cities first when there is one country), inside a city everything you have put there with Everything / Things to do / Food & drink on top, Status and Type dropdowns with counts (pubs & bars and clubs & live music as types), List or Map, no trips block. A live phone to tap through, a seven-step storyboard and a web layout.' },
  { file: 'places-options.html', section: 'places', title: 'Places tab — what a place is, and three layouts', when: '3 Sep 2026', what: 'Destination / area / place / visit defined, with how each is created; the overlap between Places and Trips; Option A (rows that open, tabs stay), Option B (Places only remembers, search lives in a trip), Option C (one row per destination with its trips and its places, past trips move here); the screen inside a destination with an Area filter; a three-column web layout; a side-by-side table.' },
  { file: 'plan-v3.html', section: 'plan', title: 'Plan screen, third pass — clickable, compact, colour', when: '3 Sep 2026', what: 'Every row a control you can tap without speaking: To as a place search with results, When as the two-month calendar with day out / night away and arrival, Do and Eat as pills, Budget as pills plus a from–to slider for the day. Five rows, home and the family on one line, a warm header with the brand trail, picture tiles. Speaking fills the same rows.' },
  { file: 'plan-v2.html', section: 'plan', title: 'Plan screen, second pass', when: '3 Sep 2026', what: 'The rows are the screen; specific wants (climbing, a pub lunch then Italian) land by name; several things to check in a queue; corrections by voice or by tapping a row; one control instead of Done + Send; Inspire me with a query, ideas and a drawer of things to do and see. This is what was built.' },
  { file: 'plan-options.html', section: 'plan', title: 'Plan screen — three ways, and how it becomes a trip', when: '3 Sep 2026', what: 'Option A (Tell me / Inspire me modes), Option B (criteria rows as the screen), Option C (chat with a summary strip), and a four-frame storyboard from speaking through the one question and the set-up card to the trip.' },
  { file: 'find-options.html', section: 'trips', title: 'Find — three ways to choose what to look for', when: '3 Sep 2026', what: 'The Find tab inside a trip: three tiles pick things to do, places to eat or what\'s on; one bar holds For you / Top rated / Most reviewed / Nearest with a kind pill, a budget sheet and distance; sources, refresh and show-only move into a filters sheet. Option 1 is what was built.' },
  { file: 'shortlist-settle.html', section: 'trips', title: 'Shortlist → Trip', when: '3 Sep 2026', what: 'The shortlist as the working surface of a trip: booking status per place, Car / No car, legs with leave-by times, and the day settled from the running list.' },
  { file: 'trips-options.html', section: 'trips', title: 'Trips tab — three options', when: '3 Sep 2026', what: 'Up next list + journey box; week strip + Journey / Find tabs; map-led with a bottom sheet.' },
];

const origin = () => (typeof window !== 'undefined' && window.location ? window.location.origin : '');
const RAIL = 900; // Below this the left menu lies down as a row of pills above the list.

type Review = { status: PrototypeStatus; note: string | null; updatedAt: string | null };

export function PrototypesScreen() {
  const { width } = useViewport();
  const wide = width >= RAIL;
  // null is "All": every section, one after another in menu order.
  const [section, setSection] = useState<Section | null>(null);
  const [status, setStatus] = useState<PrototypeStatus>('new');
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    api.prototypeReviews().then((r) => setReviews(r.reviews)).catch(() => setProblem('Verdicts are not loading — the API is not answering.'));
  }, []);

  const statusOf = useCallback((file: string): PrototypeStatus => reviews[file]?.status ?? 'new', [reviews]);

  /** Rule on a mock-up. Tapping the verdict it already has puts it back to review. */
  const rule = async (file: string, next: PrototypeStatus) => {
    const was = reviews[file];
    const to = statusOf(file) === next ? 'new' : next;
    setReviews((r) => ({ ...r, [file]: { status: to, note: was?.note ?? null, updatedAt: new Date().toISOString() } }));
    setSaving(file);
    setProblem(null);
    try {
      const { review } = await api.reviewPrototype(file, to);
      setReviews((r) => ({ ...r, [file]: { status: review.status, note: review.note, updatedAt: review.updatedAt } }));
    } catch {
      setReviews((r) => { const n = { ...r }; if (was) n[file] = was; else delete n[file]; return n; });
      setProblem('That verdict did not save — the API is not answering.');
    } finally {
      setSaving(null);
    }
  };

  // Each menu counts what the other menu is showing: the section list counts
  // within the open status tab, the status tabs count within the open section.
  const inSection = useMemo(() => PROTOTYPES.filter((p) => !section || p.section === section), [section]);
  const inStatus = useMemo(() => PROTOTYPES.filter((p) => statusOf(p.file) === status), [statusOf, status]);
  const shown = section ? SECTIONS.filter((s) => s.key === section) : SECTIONS;
  const total = inSection.filter((p) => statusOf(p.file) === status).length;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={type.title}>Prototypes</Text>
      <Text style={type.small}>Static mock-up pages, served with the app, filed under the part of the app they belong to. Each opens in its own tab; your verdict is kept.</Text>

      {/* Along the top: what has been decided. Down the left: which part of the app. */}
      <Wrap>
        {STATUSES.map((s) => (
          <Tab
            key={s.key}
            label={`${s.label} (${inSection.filter((p) => statusOf(p.file) === s.key).length})`}
            icon={s.icon}
            selected={status === s.key}
            onPress={() => setStatus(s.key)}
          />
        ))}
      </Wrap>
      {problem ? <Text style={[type.small, { color: colors.overrun }]}>{problem}</Text> : null}

      <View style={wide ? styles.split : styles.stack}>
        <View style={wide ? styles.rail : styles.railFlat}>
          <Tab label={`All (${inStatus.length})`} selected={section === null} onPress={() => setSection(null)} wide={wide} />
          {SECTIONS.map((s) => (
            <Tab
              key={s.key}
              label={`${s.label} (${inStatus.filter((p) => p.section === s.key).length})`}
              icon={s.icon}
              selected={section === s.key}
              onPress={() => setSection(s.key)}
              wide={wide}
            />
          ))}
        </View>

        <View style={styles.list}>
          {total === 0 ? (
            <Text style={[type.small, { color: colors.inkFaint }]}>
              Nothing {STATUSES.find((s) => s.key === status)!.label.toLowerCase()} {section ? `in ${SECTIONS.find((s) => s.key === section)!.label}` : 'yet'}.
            </Text>
          ) : null}
          {shown.map((s) => {
            const list = PROTOTYPES.filter((p) => p.section === s.key && statusOf(p.file) === status);
            if (list.length === 0) return null;
            return (
              <View key={s.key} style={{ gap: spacing.md }}>
                <Row style={{ marginTop: spacing.sm }}>
                  <Icon name={s.icon} size={18} color={colors.icon} />
                  <Text style={type.h2}>{s.label}</Text>
                </Row>
                {list.map((p) => (
                  <Card key={p.file}>
                    <Row style={{ alignItems: 'flex-start' }}>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={type.h3}>{p.title}</Text>
                        <Text style={type.tiny}>{p.when} · /mockups/{p.file}</Text>
                        <Text style={type.small}>{p.what}</Text>
                      </View>
                      <Button label="Open" icon="external" kind="secondary" onPress={() => Linking.openURL(`${origin()}/mockups/${p.file}`)} />
                    </Row>
                    <Wrap>
                      {VERDICTS.map((v) => (
                        <Verdict
                          key={v.key}
                          label={statusOf(p.file) === v.key ? v.label : v.verb}
                          icon={v.icon}
                          tone={TONES[v.key as 'approved' | 'rejected' | 'archived']}
                          selected={statusOf(p.file) === v.key}
                          onPress={() => rule(p.file, v.key)}
                        />
                      ))}
                      {saving === p.file ? <Text style={[type.tiny, { alignSelf: 'center' }]}>Saving…</Text> : null}
                      {statusOf(p.file) !== 'new' && reviews[p.file]?.updatedAt ? (
                        <Text style={[type.tiny, { alignSelf: 'center' }]}>{when(reviews[p.file].updatedAt!)} · tap again to put it back to review</Text>
                      ) : null}
                    </Wrap>
                  </Card>
                ))}
              </View>
            );
          })}
        </View>
      </View>

      <Text style={[type.tiny, { color: colors.inkFaint }]}>Add a page under apps/web/public/mockups, then list it here with the section it belongs to.</Text>
    </ScrollView>
  );
}

/** "4 Sep 2026", the way the rest of the app writes a date. */
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** A menu item: an ink pill when it is the one you are in, an outline when it is not; it fills on hover so it reads as something you can press. */
function Tab({ label, icon, selected, onPress, wide }: { label: string; icon?: IconName; selected: boolean; onPress: () => void; wide?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      style={({ hovered, pressed }: any) => [styles.tab, wide && styles.tabWide, hovered && !selected && styles.tabHover, selected && styles.tabOn, pressed && { opacity: 0.85 }]}
    >
      {icon ? <Icon name={icon} size={14} color={selected ? colors.primaryFg : colors.inkMuted} /> : null}
      <Text style={[styles.tabText, selected && { color: colors.primaryFg }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A verdict on a mock-up: an outlined button in its own colour, filled the
 * moment you hover it, solid once it is the verdict this prototype holds.
 * Pressing the one it holds puts it back to review.
 */
function Verdict({ label, icon, tone, selected, onPress }: {
  label: string; icon: IconName; tone: { fg: string; on: string; onFg: string; soft: string }; selected: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ hovered, pressed }: any) => [
        styles.verdict,
        { borderColor: selected ? tone.on : tone.fg, backgroundColor: selected ? tone.on : hovered ? tone.soft : 'transparent' },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Icon name={icon} size={15} color={selected ? tone.onFg : tone.fg} />
      <Text style={[styles.verdictText, { color: selected ? tone.onFg : tone.fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, maxWidth: 940, width: '100%', alignSelf: 'center' },
  split: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
  stack: { flexDirection: 'column', gap: spacing.md },
  rail: { width: 180, gap: 6 },
  railFlat: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  list: { flex: 1, gap: spacing.md, minWidth: 0 },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, minHeight: 34,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  tabWide: { justifyContent: 'flex-start', minHeight: 38, borderRadius: radius.md, borderColor: 'transparent', backgroundColor: 'transparent' },
  tabHover: { backgroundColor: colors.surfaceMuted, borderColor: colors.line },
  tabOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  verdict: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, minHeight: 36,
    borderRadius: radius.md, borderWidth: 1,
  },
  verdictText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700' },
  tabText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '600', color: colors.ink, flexShrink: 1 },
});

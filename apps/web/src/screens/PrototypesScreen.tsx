import React, { useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, spacing, type } from '../theme';
import { Button, Card, Row, Wrap } from '../components/ui';
import { Icon, IconName } from '../components/Icon';

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

// The served mock-up pages, newest first within each section. Each is a static page
// under /mockups (apps/web/public/mockups) so it deploys with the app and opens in its own tab.
const PROTOTYPES: { file: string; section: Section; title: string; when: string; what: string }[] = [
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

export function PrototypesScreen() {
  // null is "All": every section, one after another in menu order.
  const [section, setSection] = useState<Section | null>(null);
  const counts = useMemo(() => {
    const c = {} as Record<Section, number>;
    for (const s of SECTIONS) c[s.key] = PROTOTYPES.filter((p) => p.section === s.key).length;
    return c;
  }, []);
  const shown = section ? SECTIONS.filter((s) => s.key === section) : SECTIONS;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={type.title}>Prototypes</Text>
      <Text style={type.small}>Static mock-up pages, served with the app, filed under the part of the app they belong to. Each opens in its own tab.</Text>
      <Wrap>
        <Tab label={`All (${PROTOTYPES.length})`} selected={section === null} onPress={() => setSection(null)} />
        {SECTIONS.map((s) => (
          <Tab key={s.key} label={`${s.label} (${counts[s.key]})`} icon={s.icon} selected={section === s.key} onPress={() => setSection(s.key)} />
        ))}
      </Wrap>
      {shown.map((s) => {
        const list = PROTOTYPES.filter((p) => p.section === s.key);
        return (
          <View key={s.key} style={{ gap: spacing.md }}>
            <Row style={{ marginTop: spacing.sm }}>
              <Icon name={s.icon} size={18} color={colors.icon} />
              <Text style={type.h2}>{s.label}</Text>
            </Row>
            {list.length === 0 ? (
              <Text style={[type.small, { color: colors.inkFaint }]}>No {s.label} prototypes yet.</Text>
            ) : list.map((p) => (
              <Card key={p.file}>
                <Row style={{ alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={type.h3}>{p.title}</Text>
                    <Text style={type.tiny}>{p.when} · /mockups/{p.file}</Text>
                    <Text style={type.small}>{p.what}</Text>
                  </View>
                  <Button label="Open" icon="external" kind="secondary" onPress={() => Linking.openURL(`${origin()}/mockups/${p.file}`)} />
                </Row>
              </Card>
            ))}
          </View>
        );
      })}
      <Text style={[type.tiny, { color: colors.inkFaint }]}>Add a page under apps/web/public/mockups, then list it here with the section it belongs to.</Text>
    </ScrollView>
  );
}

/** A section tab: an ink pill when it is the one you are in, an outline when it is not. */
function Tab({ label, icon, selected, onPress }: { label: string; icon?: IconName; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected }} style={[styles.tab, selected && styles.tabOn]}>
      {icon ? <Icon name={icon} size={14} color={selected ? colors.primaryFg : colors.inkMuted} /> : null}
      <Text style={[styles.tabText, selected && { color: colors.primaryFg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, maxWidth: 760, width: '100%', alignSelf: 'center' },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, minHeight: 34,
    borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  tabOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '600', color: colors.ink },
});

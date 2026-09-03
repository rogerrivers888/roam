import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '../theme';
import { Button, Card, Row } from '../components/ui';

// The served mock-up pages, newest first. Each is a static page under /mockups
// (apps/web/public/mockups) so it deploys with the app and opens in its own tab.
const PROTOTYPES: { file: string; title: string; when: string; what: string }[] = [
  { file: 'plan-style.html', title: 'Plan screen in the Roam style guide — light and dark', when: '3 Sep 2026', what: 'The third-pass layout with the September 2026 style guide applied: light mode Mint (one mint header field, ink on white, Leaf icons, ink buttons, red only for the heart) and dark mode Night · mint (charcoal, raised panels, mint as the primary). Six phone frames and a web layout in each mode.' },
  { file: 'places-styled.html', title: 'Places drill-down — current design beside the style guide, light and dark', when: '3 Sep 2026', what: 'The approved drill-down three ways for each step: the current design, the Roam Style Guide light mode (Mint) and dark mode (Night · mint). Archivo type, 4px corners, ink buttons, one icon colour per mode, red only for the heart (Special is the red heart badge), outlined counts instead of coloured ones, filled or hollow pins. Two calls to check: the Underground line dot keeps its real colour; Special equals the guide\'s favourite.' },
  { file: 'inspire-options.html', title: 'Inspire me — a cleaner form, three ways', when: '3 Sep 2026', what: 'The form today is twenty-two things to look at; three ways to cut it down, all with who is coming moved into the header as "The family · from home", clashing moods as one pick, budget as a from–to slider and travel on its own line. A three rows like Tell me (Mood; Travel and Budget as one split row opening two sliders); B the little planner (one question a screen, three or four tiles, a strip of picks, sliders on step 3); C a sentence with blanks (four dropdowns that read as what you would say). A web layout and a side-by-side table.' },
  { file: 'plan-palettes.html', title: 'Plan screen — four colour palettes', when: '3 Sep 2026', what: 'The third-pass screens in four stronger schemes, side by side: A Roam red (ink header, the brand red for pin, trail and Plan it), B deep teal and saffron, C ink and citrus, D navy and coral. Header, pin, row icons, primary button and tiles change; rows and pills stay.' },
  { file: 'places-drilldown.html', title: 'Places — the drill-down, as chosen', when: '3 Sep 2026', what: 'Option A as picked: countries fold to cities (cities first when there is one country), inside a city everything you have put there with Everything / Things to do / Food & drink on top, Status and Type dropdowns with counts (pubs & bars and clubs & live music as types), List or Map, no trips block. A live phone to tap through, a seven-step storyboard and a web layout.' },
  { file: 'places-options.html', title: 'Places tab — what a place is, and three layouts', when: '3 Sep 2026', what: 'Destination / area / place / visit defined, with how each is created; the overlap between Places and Trips; Option A (rows that open, tabs stay), Option B (Places only remembers, search lives in a trip), Option C (one row per destination with its trips and its places, past trips move here); the screen inside a destination with an Area filter; a three-column web layout; a side-by-side table.' },
  { file: 'plan-v3.html', title: 'Plan screen, third pass — clickable, compact, colour', when: '3 Sep 2026', what: 'Every row a control you can tap without speaking: To as a place search with results, When as the two-month calendar with day out / night away and arrival, Do and Eat as pills, Budget as pills plus a from–to slider for the day. Five rows, home and the family on one line, a warm header with the brand trail, picture tiles. Speaking fills the same rows.' },
  { file: 'plan-v2.html', title: 'Plan screen, second pass', when: '3 Sep 2026', what: 'The rows are the screen; specific wants (climbing, a pub lunch then Italian) land by name; several things to check in a queue; corrections by voice or by tapping a row; one control instead of Done + Send; Inspire me with a query, ideas and a drawer of things to do and see. This is what was built.' },
  { file: 'plan-options.html', title: 'Plan screen — three ways, and how it becomes a trip', when: '3 Sep 2026', what: 'Option A (Tell me / Inspire me modes), Option B (criteria rows as the screen), Option C (chat with a summary strip), and a four-frame storyboard from speaking through the one question and the set-up card to the trip.' },
  { file: 'shortlist-settle.html', title: 'Shortlist → Trip', when: '3 Sep 2026', what: 'The shortlist as the working surface of a trip: booking status per place, Car / No car, legs with leave-by times, and the day settled from the running list.' },
  { file: 'trips-options.html', title: 'Trips tab — three options', when: '3 Sep 2026', what: 'Up next list + journey box; week strip + Journey / Find tabs; map-led with a bottom sheet.' },
];

const origin = () => (typeof window !== 'undefined' && window.location ? window.location.origin : '');

export function PrototypesScreen() {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={type.title}>Prototypes</Text>
      <Text style={type.small}>Static mock-up pages, served with the app. Each opens in its own tab.</Text>
      {PROTOTYPES.map((p) => (
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
      <Text style={[type.tiny, { color: colors.inkFaint }]}>Add a page under apps/web/public/mockups and list it here.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, maxWidth: 760, width: '100%', alignSelf: 'center' },
});

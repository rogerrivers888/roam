/**
 * How it works — the decisions behind what Roam does, written down.
 *
 * The owner, 6 Sep 2026: "I think we need a 'how it works' in the desktop back
 * office thing, and you can put all of these assumptions there in terms of what
 * we've done. This is an example of something: in order to reduce cost, we've
 * decided to estimate the detour. Maybe once the user adds it to their actual
 * trip, not in a short list, then we can recalculate the actual correct number."
 *
 * Three rules keep this page honest, because a page like this is worthless the
 * moment it describes something that is not true:
 *
 *   1. Every entry says whether it is **live** or **decided and not built**.
 *      A plan and a fact look identical in prose, so they are not allowed to.
 *   2. Every entry names the file the rule is actually in, so the page can be
 *      checked against the code rather than believed.
 *   3. Where the answer changes by the minute — whether travel times are real
 *      or estimated right now — it is read from the API, not written here.
 *
 * It is the back office's answer to "why did it say that", and to "what is this
 * going to cost".
 */

import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../../api';
import { colors, fonts, radius, spacing, type } from '../../theme';
import { Icon, IconName } from '../../components/Icon';
import { AdminPage, Banner, PageHead, Panel, Pill } from '../kit';

/**
 * `live` — Roam does this today.
 * `planned` — decided, and the code does not do it yet.
 * `partial` — the rule is real but only part of it has been built.
 */
type State = 'live' | 'partial' | 'planned';

type Decision = {
  title: string;
  /** What Roam does, in one or two sentences. The rule itself. */
  rule: string;
  /** What it buys and what it costs. The part a decision is actually made on. */
  why: string;
  state: State;
  /** The file the rule lives in, so this page can be checked rather than trusted. */
  where?: string;
  /** The owner's own words, where a decision came from him rather than from the docs. */
  said?: { who: string; on: string; words: string };
};

type Section = { key: string; title: string; blurb: string; icon: IconName; decisions: Decision[] };

/** A path is a path: it reads as one, and it is meant to be copied into an editor. */
const MONO = Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined;

const SECTIONS: Section[] = [
  {
    key: 'money',
    title: 'What things cost, and where we cut',
    blurb: 'Every outbound call is somebody’s money. These are the places Roam deliberately spends less, and what it gives up to do it.',
    icon: 'money',
    decisions: [
      {
        title: 'A detour is estimated while you browse, and measured once you add it',
        rule: 'Browsing "along the route" shows how far off the route each place is, worked out from the distance. Nothing is asked of Google. The moment a place is added to the day, that one place is routed properly and the time on the day is the real one.',
        why: 'A browse is six to thirty candidates and the filters change constantly — routing all of them on every chip tap would spend the day’s quota in a few minutes. One place, once, when somebody has actually chosen it, is a single call. The cost is that a browse row can be out by a few minutes; the day itself never is.',
        state: 'live',
        where: 'apps/api/src/domain/travel.js · apps/api/src/sources/routing.js',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'As long as the detour route minutes are roughly correct, I think that’s okay… once the user adds it to their actual trip, not in a shortlist, then we can recalculate the actual correct number.' },
      },
      {
        title: 'A corridor has a width as well as two ends',
        rule: 'Browsing "along the route" keeps only what is within the detour budget, between the two ends of the journey, and within half of what that budget reaches of the road itself — about 1.8km at fifteen minutes in a car. How many were left just outside is said at the foot of the list, and one tap widens it.',
        why: 'The detour on its own lets in places nobody would call on the way: going back past the house and round really is only ten extra minutes, so Chobham Common kept appearing on the road to Thorpe Park. Being between the two ends is not enough either — a place off to one side still projects onto the route. It is the width that makes a corridor a corridor.',
        state: 'live',
        where: 'apps/api/src/routes/trips.js · GET /:id/along',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'I shouldn’t have any going in the opposite direction from my home, for example. That doesn’t make any sense.' },
      },
      {
        title: 'A stay’s must-haves filter on what a mapper positively said, and silence is not a yes',
        rule: 'Pool, kitchen, parking, family room, breakfast, air con and pet-friendly are read off the open map’s tags. A must-have leaves out every bed that has not said it has the thing — including the ones that do and were never tagged. The nice-to-haves reorder and never remove, which the screen says under the kicker. The wizard’s button carries the live count, so ticking Pool shows what it costs before anybody taps it.',
        why: 'OpenStreetMap has a tag for a pool and no tag for the absence of one, and the tagging is sparse. Keeping untagged beds in would mean inventing a pool; leaving them out is the honest half of an incomplete map, and the live count on the button is what stops that being a surprise. LiteAPI’s list endpoint carries no facilities either — the per-hotel detail call does, and that is a call per row, which is why it is not made.',
        state: 'partial',
        where: 'apps/api/src/sources/osm.js · stayAmenities · apps/api/src/routes/trips.js · GET /:id/stays',
      },
      {
        title: 'The stay wizard is three steps, and the third is the list itself',
        rule: 'Where it should be (with the minutes attached to the answer they belong to), then budget and must-haves, then the ranked results. The three chips over the results re-open the step they came from. Every answer is in the address, so a worked-through set of criteria is a page somebody can be sent.',
        why: 'What counts as a reasonable price depends on whether you said “in the middle of my plans” or “anywhere with a station”, so the money cannot come first. Making the results the third step rather than a fourth screen means the wizard is never a thing you have to finish before you see anything.',
        state: 'live',
        where: 'apps/web/src/screens/TripMapScreen.tsx · StayCriteria',
      },
      {
        title: 'A spent quota is a fallback, not a failure',
        rule: 'When Google Routes refuses for want of quota, Roam stops asking for a while — per method, because the quotas are per method — and works every travel time out from the distance instead. Anything worked out that way is flagged, and the screen says so.',
        why: 'The alternative is a screen full of errors, or a retry loop that spends the next day’s quota the moment it resets. A journey with estimated times is still a usable journey.',
        state: 'live',
        where: 'apps/api/src/sources/routing.js',
      },
      {
        title: 'Adding an option must not add a provider call',
        rule: 'A day’s options are composed from one retrieved pool. Asking for another option re-sorts what was already fetched; it never goes back to a provider.',
        why: 'It is the difference between a planning session costing one search and costing fifteen. It also makes the options comparable — they came from the same pool.',
        state: 'live',
        where: 'apps/api/src/domain/options.js',
      },
      {
        title: 'Tripadvisor is opt-in per search',
        rule: 'It runs only when a search names it. Everything else uses the default set.',
        why: 'It bills per location returned — 1,000 free for life, then about 15 cents a search. That is the one source where an idle browse costs real money.',
        state: 'live',
        where: 'apps/api/src/sources/index.js',
      },
      {
        title: 'Every outbound call is attributed to a household and a session',
        rule: 'A row goes into `provider_calls` with the units it consumed, before anything is shown. Settings and Reporting read from that.',
        why: 'Without it, "what did this month cost" is a guess, and a source that starts misbehaving is invisible until the bill arrives.',
        state: 'live',
        where: 'apps/api/src/sources/meter.js',
      },
    ],
  },
  {
    key: 'licence',
    title: 'What we may keep, and what is only rented',
    blurb: 'The difference between the two layers is the thing most likely to be broken by accident, because both look like "a place" on screen.',
    icon: 'locked',
    decisions: [
      {
        title: 'Rented and owned are two different layers',
        rule: 'A household act — shortlist, save, special, visited — claims a place. Roam then researches it from OpenStreetMap, the venue’s own published page and the open encyclopedias, and that research is kept for good. A provider’s name, hours, reviews, photos or rating is never written down.',
        why: 'The licences we hold permit keeping an identifier indefinitely and keeping what we generated ourselves. They do not permit keeping display content. When a drawer needs a fact that survives the signal going, it comes from the owned record.',
        state: 'live',
        where: 'apps/api/src/sources/own.js · docs/technical-constraints.md §13.10',
      },
      {
        title: 'A device may hold less than the server may',
        rule: 'Every answer passes one file before it is written to the phone. An endpoint not named there is not saved — the fallback is to keep nothing, never to keep it unless it looks licensed.',
        why: 'A phone in a pocket is somewhere we cannot reach to delete anything from, so the rule there is stricter than the rule on the server.',
        state: 'live',
        where: 'apps/web/src/offline/policy.ts',
      },
      {
        title: 'One name is still stored that should not be',
        rule: '`trip_stops.venue_name` holds the household’s name for a stop, including for places that came from a licensed source. It was written as a fixtures-only exception and must become fetch-at-display.',
        why: 'Recorded here rather than left as a comment in a migration, because it is the one known gap in the rule above and it is easy to forget it exists.',
        state: 'partial',
        where: 'apps/api/migrations/001_init.sql · CLAUDE.md',
      },
      {
        title: 'The web bundle never holds a provider key',
        rule: 'Every third-party call goes through the API. `EXPO_PUBLIC_*` values are inlined at build time and are public by definition, so nothing secret is ever one of them.',
        why: 'A key in the bundle is a key on every device that has ever loaded the app, and it cannot be taken back.',
        state: 'live',
        where: 'docs/technical-constraints.md §13.7',
      },
    ],
  },
  {
    key: 'decides',
    title: 'How Roam decides',
    blurb: 'The rules behind the words on screen — what counts as a holiday, what a mood means, what excludes a place and what merely ranks it.',
    icon: 'plan',
    decisions: [
      {
        title: 'Allergens exclude; dislikes rank',
        rule: 'An allergen takes a place out of the running entirely. A dislike moves it down the list and never removes it. They never share a control, a colour, or a code path.',
        why: 'They are different in kind, not in degree. Treating a dislike as an exclusion loses places the family would happily go to; treating an allergen as a ranking is dangerous.',
        state: 'live',
        where: 'apps/api/src/domain/ranking.js',
      },
      {
        title: 'A night away is what makes a holiday',
        rule: 'Trips is divided Day trips | Holidays on nights away. A trip that starts and ends on the same day is a day out, whatever it calls itself.',
        why: 'The handover left the rule open between distance and an overnight stay. An overnight stay is a fact already in the data; a distance would be a threshold somebody has to keep tuning.',
        state: 'live',
        where: 'apps/api/src/routes/trips.js · nightsOf()',
      },
      {
        title: 'An area gets a Hotels tab once it is somewhere you stay',
        rule: 'Activities and Food & drink always. Hotels appears when the household has kept somewhere to stay there, or has ever slept a night there.',
        why: 'Same reasoning as above — the fact rather than a guess about distance. Reading & around never gets one; Puglia got one on the first trip.',
        state: 'live',
        where: 'apps/api/src/routes/atlas.js · city.holiday',
      },
      {
        title: 'A place sits on at most two shelves, and the mapping is taught',
        rule: 'Each shelf carries a weight from 0 to 1. Only the strongest two above the floor are drawn. Anything in `shelf_rules` beats the built-in tables, narrowest rule first.',
        why: 'A flat list of moods put anything arguably two things on four shelves, and the home screen became the same places six times. The tables were also simply wrong in places — the atlas has one word for a Formula One circuit and a football ground — and re-guessing does not fix that; teaching it does.',
        state: 'live',
        where: 'apps/api/src/domain/moods.js · back office › Shelves',
      },
      {
        title: 'Voice is interpreted against a closed set that is on screen',
        rule: 'Speech is matched to the vocabulary the screen is already showing, and every voice action has a tap that produces the same state change.',
        why: 'An open-ended interpreter fails invisibly and cannot be corrected. A closed set can only fail in ways somebody can see and fix by tapping.',
        state: 'live',
        where: 'apps/web/src/hooks/useSpeech.ts',
      },
      {
        title: 'Red means one of two things, and never anything else',
        rule: 'Red is the heart — a place the household loves — and it is "this needs doing": a trip with dates and nowhere to sleep, a visit nobody has rated. Counts, statuses and totals are never red.',
        why: 'A colour that means five things means nothing. Two meanings, both of which want your attention, is the most it can carry.',
        state: 'live',
        where: 'apps/web/src/theme.ts',
      },
    ],
  },
  {
    key: 'pictures',
    title: 'Pictures',
    blurb: 'Why some places have a photograph, some have a logo, and some have neither — and why there is no bank of stock food photography.',
    icon: 'camera',
    decisions: [
      {
        title: 'The ladder, and the floor underneath it',
        rule: 'For each place, in order: a photograph the household took, the business’s own published mark, a Wikimedia Commons photograph, a street-level frame of the shopfront from KartaView or Mapillary. If none of those, the category icon on the mint ground.',
        why: 'The delivery apps have one food photo each because the restaurant uploaded it under a contract. We have no such contract, so we go and find the pictures that are already ours to hold. The icon floor is honest by construction — nobody reads it as a photograph of that restaurant’s food.',
        state: 'live',
        where: 'apps/api/src/sources/placePicture.js',
        said: { who: 'the owner', on: '5 Sep 2026', words: 'The only other option is to use generic images (a huge bank) and just mix and match them for all the different restaurants, but that’s a bit misleading.' },
      },
      {
        title: 'A mark is drawn differently from a photograph',
        rule: 'A photograph fills its tile. A logo is contained on the mint ground with room around it. On an area or a trip tile, a photograph is preferred over a mark even when the mark is closer to hand.',
        why: 'Cropping a square logo to fill a wide tile turns a wordmark into a smear. And a restaurant’s blue square says nothing at all about Puglia.',
        state: 'live',
        where: 'apps/web/src/components/VenueThumb.tsx',
      },
      {
        title: 'A credit is a condition, not a nicety',
        rule: 'Where the licence requires it, the credit line is drawn with the picture, by the component that draws the picture.',
        why: 'For every licence but CC0 and public domain, the picture without the line is the licence broken. Putting it in the component rather than in each caller is what stops one screen forgetting.',
        state: 'live',
        where: 'apps/web/src/components/VenueThumb.tsx',
      },
    ],
  },
];

const STATE: Record<State, { label: string; tone: 'ok' | 'warn' | 'plain' }> = {
  live: { label: 'Live', tone: 'ok' },
  partial: { label: 'Part built', tone: 'warn' },
  planned: { label: 'Decided · not built', tone: 'plain' },
};

export function HowItWorks() {
  // What is true this minute rather than in general: are travel times real
  // right now, or is the quota spent and everything an estimate?
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.sources>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.sources().then(setSources).catch((e) => setError(e.message)); }, []);

  const now = sources?.routingNow ?? null;
  const paused = now ? now.matrix ?? now.route ?? null : null;

  return (
    <AdminPage>
      <PageHead
        title="How it works"
        sub="The decisions behind what Roam does — what each one buys, what it gives up, and where the rule lives."
      />

      <Banner tone={paused ? 'warn' : 'plain'}>
        {sources == null ? 'Reading what the API is doing…'
          : error ? `Could not read the API: ${error}`
            : sources.routing !== 'google-routes' ? 'No routing key is set, so every travel time on screen is worked out from the distance.'
              : paused ? `Google Routes has no quota left just now, so travel times are worked out from the distance until ${new Date(paused.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
                : 'Google Routes is answering, so travel times on screen are real ones.'}
      </Banner>

      {SECTIONS.map((s) => (
        <Panel key={s.key} title={s.title} sub={s.blurb} padded={false}>
          {s.decisions.map((d, i) => (
            <View key={d.title} style={[styles.row, i > 0 && styles.rowLine]}>
              <View style={styles.head}>
                <Icon name={s.icon} size={16} color={colors.inkMuted} />
                <Text style={[type.h3, { flex: 1 }]}>{d.title}</Text>
                <Pill label={STATE[d.state].label} tone={STATE[d.state].tone} />
              </View>
              <Text style={type.body}>{d.rule}</Text>
              <View style={styles.why}>
                <Text style={[type.tiny, styles.whyLabel]}>WHY</Text>
                <Text style={[type.small, { flex: 1 }]}>{d.why}</Text>
              </View>
              {d.said ? (
                <Text style={styles.quote}>“{d.said.words}” — {d.said.who}, {d.said.on}</Text>
              ) : null}
              {d.where ? <Text style={styles.where}>{d.where}</Text> : null}
            </View>
          ))}
        </Panel>
      ))}

      <Panel title="Keeping this page honest" sub="What it is for, and how it is meant to be maintained.">
        <Text style={type.body}>
          A page like this is worthless the moment it describes something that is not true, so every entry says whether it is live or
          only decided, and names the file the rule is in. If an entry cannot be checked against the code in a minute, it is written wrong.
        </Text>
        <Text style={type.small}>
          Anything that changes by the minute — whether travel times are real right now — is read from the API at the top of this page rather
          than written down here.
        </Text>
        <Pressable onPress={() => Linking.openURL('https://github.com/rogerrivers888/roam/blob/main/CLAUDE.md')} accessibilityRole="link">
          <Text style={styles.link}>The working agreements this page draws on →</Text>
        </Pressable>
      </Panel>
    </AdminPage>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 6 },
  rowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  why: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginTop: 2 },
  whyLabel: { width: 34, paddingTop: 2, fontWeight: '700', letterSpacing: 0.6, color: colors.inkFaint },
  quote: { fontFamily: fonts.body, fontSize: 13, fontStyle: 'italic', color: colors.headerSub, lineHeight: 18 },
  where: {
    fontFamily: MONO, fontSize: 11, color: colors.inkFaint,
    backgroundColor: colors.surfaceMuted, alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm, overflow: 'hidden',
  },
  link: { fontFamily: fonts.body, fontSize: 13, fontWeight: '700', color: colors.accent },
});

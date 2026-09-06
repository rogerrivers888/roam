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
        rule: 'Must-haves are counted from the hotel source, which carries a facility list on every bed it returns — a hundred of a hundred in Bath. The catalogue runs to 820 facilities and 253 of them occur in Bath alone, including “Laundry washed per local authority guidelines”, so the screen is driven by a list of about a dozen things households actually decide on (`WANTS`) and the catalogue decides only which of them can be offered here. Each want matches several catalogue ids — a pool is an indoor pool and an outdoor pool and a rooftop pool. The open map’s own tags remain the fallback where there is no hotel source. Nice-to-haves reorder and never remove. The button carries the live count either way.',
        why: 'The last line of this entry used to read “LiteAPI’s list endpoint carries no facilities — the per-hotel detail call does, and that is a call per row”. That was measured and it is wrong: `facilityIds` and `hotelTypeId` arrive on every hotel in the list call the results page already makes, so proper facilities cost nothing at all. OpenStreetMap remains the fallback and its weakness is the reason to prefer the other: it has a tag for a pool and none for the absence of one, and in Windsor not one bed carries parking, so a strict filter would empty the list everywhere the map is thin. Where OSM is all there is, a must-have applies only where somebody around there has answered it, and the screen says so.',
        state: 'partial',
        where: 'apps/api/src/domain/stays.js · WANTS, wantsOnOffer · apps/api/src/sources/osm.js · stayAmenities · GET /api/stays/options',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'I\u2019d like you to look at that and check whether those criteria are available on the API we have… and whether we\u2019re intelligent enough to remove asks when they\u2019re not viable.' },
      },
      {
        title: 'A filter earns its place by dividing the pool, not by existing',
        rule: 'The must-haves offered are counted from the beds already fetched for this patch of map. Anything no bed here has is never drawn — no bed near Thorpe Park has a sea view, so there is no sea-view chip, and no rule about coastlines was written. Anything nearly every bed has is not drawn either: 99 of the 100 beds in Bath have WiFi, so the chip would narrow the list by one. The exception is pool, kitchen and air conditioning, which are shown even at 100% because “all of them have one” is a real answer to a question somebody asked. Every chip carries the number of beds left if it is ticked.',
        why: 'The alternative was a rule per amenity — sea view needs a coast within so many miles, and so on — which is a list that is never finished, wrong at its edges, and still cannot answer what the household is really asking. Counting the pool answers both at once and costs nothing: no call is made that the list was not going to make anyway. It also generalises to any future source without a line of new logic.',
        state: 'live',
        where: 'apps/api/src/domain/stays.js · wantsOnOffer, DISCRIMINATING · apps/api/src/routes/stays.js',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'this trip is the Thought Park, which is nowhere near the ocean, so there\u2019s no point in offering sea views.' },
      },
      {
        title: 'Where to stay is arithmetic on beds we hold, not an isochrone we buy',
        rule: 'Ranking a bed against several planned places is done from the beds already fetched: each one\u2019s estimated travel time to every plan, the median leg, and how many plans are within the walk. No isochrone provider is called. “Within 15 minutes of everything” is a filter on the furthest leg, which is already computed, and when nothing clears the bar the answer carries the best any bed manages so the screen can offer that number instead of an empty list.',
        why: 'Five 15-minute polygons intersected is the textbook answer and it buys nothing here: it is five provider calls for a region, when what is actually needed is an ordering of the forty beds already in memory. TravelTime is trial-only and sales-led (§11) and Google Routes\u2019 quota is spent, so the minutes are straight-line estimates and the screen says “about”. The cost of being wrong is a few minutes on a row; the day itself is routed properly when a place is added.',
        state: 'live',
        where: 'apps/api/src/domain/stays.js · rankStays, withinOfAll',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'I\u2019d like to know what sort of technology you can develop to do that and do it at speed.' },
      },
      {
        title: 'The middle of several plans is the median, not the average',
        rule: 'The point a stay search is measured from is the geometric median of the planned places — the point with the least total travel to all of them — found by Weiszfeld\u2019s algorithm starting from the mean. Two plans or fewer fall back to the midpoint, which is the same thing.',
        why: 'The mean is not the middle. Five things in Bath plus one day trip to Bristol drags the mean a third of the way to Bristol, where a hotel is wrong for five days out of six; the median stays in Bath and cuts total travel across that trip from 29.5km to 19.2km. One outlier pulls on the median once instead of once per mile. A thousand solves take five milliseconds, so there is nothing to wait for and no call to make.',
        state: 'live',
        where: 'apps/api/src/domain/stays.js · centreOfPlans',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'If there\u2019s 1 that\u2019s in the centre of them all, that would be better.' },
      },
      {
        title: 'Where it should be is several conditions at once, not one of three boxes',
        rule: 'Near my plans, near the town and near a station decide what the list is **ranked** by. Each condition — minutes to your plans, minutes to the centre, walk to a platform, minutes on the train — applies whenever it was asked for, whatever the ranking is. “Under 20 minutes from the centre and under a 10-minute walk to the station” is one search. `criteria.applied` says which conditions actually ran.',
        why: 'The three tiles read as three questions and they are one question with several answers. Until this, each condition was applied only when its own tile happened to be selected, so a household could have one or the other and never both. `criteria.applied` exists because the sheet has a number in every box whether or not it is doing anything, and reading “20 min” over a list that was never filtered by it is being misled.',
        state: 'live',
        where: 'apps/api/src/routes/trips.js · GET /:id/stays',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'I want to have a place that\u2019s less than 20 minutes\u2019 travel to the centre of whatever town, and I want it to be less than a 10-minute walk to the train station.' },
      },
      {
        title: 'Stations are held, not asked for',
        rule: 'Every station, tube stop, tram stop and light-rail stop is harvested from OpenStreetMap into `transit_stops` and read from Postgres with a bounding box. Britain is about 3,500 rows. Overpass is still where the data comes from, but it is off the path a search takes: an area nobody has harvested falls back to one live lookup, writes down what comes back, and is a database read from then on. When that fallback fails too, whatever we already hold is returned rather than an exception.',
        why: 'A screen that cannot draw a list unless somebody else\u2019s free server is having a good afternoon is not fit for purpose, and no amount of choosing between mirrors fixes it — on 6 Sep 2026 three of the four public mirrors were failing at once. This is open data under ODbL, which CLAUDE.md lists among the sources we may keep for good, and 3,500 rows is a rounding error next to the atlas. The cost is that a station opened this month is missing until the next harvest, which for a table of railway stations is the right trade.',
        state: 'live',
        where: 'apps/api/migrations/058_transit_stops.sql \u00b7 apps/api/src/repositories/transit.js \u00b7 sources/where.js \u00b7 stationsNear',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'it needs to be reliable. If it\u2019s not reliable, it\u2019s not fit for purpose.' },
      },
      {
        title: 'Never looked here is a different answer from nothing here',
        rule: '`transit_coverage` records which cells have been harvested. No row for a point means we have never looked, and the search falls back to a live lookup; a row saying zero stops means we looked and there are none. A station condition that cannot be evaluated is dropped and reported (`criteria.stationsUnavailable`), never failed by every bed.',
        why: 'Confusing those two is the exact bug that shipped. `stationsNear` swallowed every error and returned an empty list; the empty list then failed every bed\u2019s walk test; and an Overpass outage read on screen as "nowhere near here is by a station". Bath Spa is a main line station and the tile found nothing. The same rule the must-haves already follow: a question nobody has answered is not a question every candidate fails.',
        state: 'live',
        where: 'apps/api/migrations/058_transit_stops.sql \u00b7 apps/api/src/routes/trips.js \u00b7 GET /:id/stays',
      },
      {
        title: 'A tram stop is not a station, and both are worth offering',
        rule: 'Four kinds are kept apart — rail, subway, tram, light_rail — and all four count as "near a station" by default, narrowable with `stationKinds`. Trams come from `railway=tram_stop`, which nothing had ever asked for: Manchester used to return nine stops, every one of them heavy rail, with Metrolink invisible. Rides wearing the same tag are excluded by one shared classifier — miniature, funicular, cable car, heritage, disused, and anything under a metre of gauge.',
        why: '"Ten minutes from a tram stop" and "ten minutes from a station" are different promises and a household choosing where to sleep is entitled to know which they are being offered. The exclusions matter as much: `railway=station` covers Legoland\u2019s Hill Train, and a bed ranked "4 min walk to Hill Train Bottom \u00b7 about 21 min by train" is nonsense dressed up as a fact. One classifier, under test, used by the harvest and by everything reading it — `osmStation` had its own and no sieve at all.',
        state: 'live',
        where: 'apps/api/src/sources/transit.js \u00b7 isServiceStop, kindOf, dedupe',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'fix it all end to end, add trams as well' },
      },
      {
        title: 'The harvest is resumable, and a cell nobody will answer is not fatal',
        rule: 'A region is cut into cells and each is fetched with a pause between. Every cell is recorded on its own and skipped on a re-run, so an interrupted harvest is finished by running it again. A cell no mirror answers is skipped and left uncovered, so the live fallback fills it in later; the region as a whole is only claimed when every cell answered. The API continues it in four-minute slices while it is up, so nobody has to remember to press anything.',
        why: 'Britain is fifty-odd cells and on a bad afternoon for the mirrors that is hours, spread across deploys that land minutes apart. Claiming a region on a partial run would tell the fallback a hole had been filled and it would never be looked at again — which is the one failure this whole table exists to prevent.',
        state: 'live',
        where: 'apps/api/src/sources/transit.js \u00b7 harvestRegion, resumeHarvest \u00b7 POST /api/stays/transit/harvest',
      },
      {
        title: 'One list of Overpass mirrors, and a mirror that refuses gets ten minutes off',
        rule: 'Every Overpass caller shares one list of four mirrors, starts at whichever last answered, and rests one that refuses or hangs for ten minutes. One mirror is given twelve seconds on an interactive path; the background researchers wait far longer but take the same order and report back.',
        why: 'There were five copies of that loop and three of them still began with the two mirrors that are down — measured 6 Sep 2026: overpass-api.de fails in 3s, kumi.systems takes 40s to a timeout, private.coffee answers in 6–10s, osm.ch in 0.12s. The interactive search knew only the two dead ones and gave each thirty seconds, which is where the minute-long stay lookup came from. A worse trap followed: `overpass.osm.ch` was added on the strength of that 0.12s and it is a Switzerland-only extract — 200, fast, and empty for anywhere else, which is exactly what the health rules reward. It became preferred, the others rested behind it, and every search returned nothing. Only planet-wide instances belong on that list, and an answer with nothing in it no longer earns a mirror preference.',
        state: 'live',
        where: 'apps/api/src/sources/overpass.js · mirrorsInOrder, overpassQuery',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'it\u2019s taking a long time to look up… Can you please check if that\u2019s a problem on our side or their API?' },
      },
      {
        title: 'A price from a sandbox key says so on the screen it appears on',
        rule: 'LiteAPI is currently on a sandbox key, which answers with invented hotels at invented prices. Every stay list says so above the rows. Where a live key prices some beds and not others, the line says how many were priced rather than leaving most of the list reading "no price for these nights". A stay with no guest rating shows the operator\u2019s star classification instead — a fact about the building, not a rented opinion.',
        why: 'A made-up number with nothing next to it is a lie, and it is the kind of lie somebody books a holiday on. The API has always reported `pricing.sandbox`; the sheet was ignoring it. Moving to a live key is the owner\u2019s — it holds a secret and it spends money.',
        state: 'partial',
        where: 'apps/api/src/sources/liteapi.js \u00b7 apps/web/src/screens/TripMapScreen.tsx \u00b7 StayList',
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
    key: 'speed',
    title: 'How fast it is, and what makes it slow',
    blurb: 'A screen that takes three seconds is a different product from one that takes half of one. These are the rules that decide which it is, and the numbers they were decided on.',
    icon: 'search',
    decisions: [
      {
        title: 'A source too slow to wait for is not a source to drop',
        rule: 'Overpass is marked slow by nature. Once something useful has arrived and every other source has settled, the search answers without it \u2014 but its work carries on, and when it lands the fuller answer replaces what the cache holds. The first look is fast; the next look at the same place is fast and complete.',
        why: 'Measured on production, 6 Sep 2026: Overpass answered three tries in five, at 5.0s, 7.2s and 9.8s, and ran out its cap on the other two \u2014 while returning 120 restaurants in central Manchester where Google returns 7. Too slow to wait for, too good to drop. Before this, every search paid for it and then gave up: with the flag the fan-out answers in 21ms, without it 2,521ms, and not one of those 120 had ever reached a screen.',
        state: 'live',
        where: 'apps/api/src/sources/index.js \u00b7 settleBy, `settling` \u00b7 apps/api/src/sources/osm.js \u00b7 apps/api/src/sources/cache.js',
      },
      {
        title: 'The grace window is for a source that is merely late',
        rule: 'When the first useful answer arrives, the rest get two and a half seconds to join. That window is deliberately not shortened.',
        why: 'It was shortened once and the same search fell from twenty-five places to ten, because it cut sources that were only having a bad second. The fix for the one source that is slow by nature belongs on that source, not on everybody \u2014 which is what the rule above is.',
        state: 'live',
        where: 'apps/api/src/sources/index.js \u00b7 GRACE_MS',
      },
      {
        title: 'Every search goes through the cache \u2014 including the one that did not',
        rule: 'A search is held for twelve hours and a second search for the same area, radius, words and sources is answered from it. Two screens asking at once join one search rather than running two. Only the call that actually fetched is billed to the household.',
        why: 'Places was the last path calling the sources directly, so looking at the same area twice in an afternoon asked Google twice and billed twice \u2014 for an answer that was in memory the whole time. Plan, the taste tables and a trip\u2019s Find tab had gone through the cache since it was written.',
        state: 'live',
        where: 'apps/api/src/routes/places.js \u00b7 apps/api/src/sources/cache.js',
      },
      {
        title: 'What the screens actually take',
        rule: 'Measured against production on 6 Sep 2026: home 0.17s, Places 0.09s, the atlas 0.16s, a place drawer 0.29s, directions 0.22s, a photograph 0.16\u20130.37s cold and 0.07s once held. A first search of an area is about half a second; the same search again is instant.',
        why: 'Written down because \u201cit feels slow\u201d and \u201cit is slow\u201d are different claims and only one of them names a number. The pattern is the point: everything that reads Roam\u2019s own data is one indexed query and lands under 300ms, and all the time that is left is in the calls that leave the building. That is what makes it worth spending effort on the fan-out rather than on the screens.',
        state: 'live',
        where: 'apps/api/src/routes/inspire.js \u00b7 routes/atlas.js \u00b7 routes/places.js',
      },
      {
        title: 'A slow source is told apart from a broken one',
        rule: 'A source we chose not to wait for is recorded as `slow`, not as a failure. The cache keeps a degraded answer for ten minutes but a merely-slow one for the full twelve hours.',
        why: 'They look identical on screen and mean opposite things. Treating \u201cwe did not wait\u201d as \u201cit let us down\u201d would re-ask Google every ten minutes all afternoon for a search that was already answered.',
        state: 'live',
        where: 'apps/api/src/sources/index.js \u00b7 apps/api/src/sources/cache.js',
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
        title: 'The place ID is the join, and it is the one field we may keep for ever',
        rule: 'An owned record is keyed by the provider\u2019s identifier \u2014 `google:ChIJ\u2026`. Everything factual about the place (name, category, cuisine, diets, hours, address, phone, postcode, nearest station) is researched from open sources and stored against that key. Everything the provider sells (rating, review count, photographs) is fetched against the same key at display and dropped.',
        why: 'It is what makes the two layers meet without mixing. Amalfi on the atlas: its name, W1F and Oxford Circus 150m away are ours for good and work with no signal; its 4.8 stars, 17,191 reviews and its photograph are Google\u2019s and are drawn fresh every time. Google\u2019s retention allowance is place IDs indefinitely, coordinates thirty days, display fields none \u2014 so the identifier is the only thing there is to build on.',
        state: 'live',
        where: 'apps/api/migrations/021_owned_places.sql \u00b7 apps/api/src/sources/own.js \u00b7 docs/technical-constraints.md \u00a74',
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
        title: 'Where we own nothing, the provider\u2019s photograph is shown and never kept',
        rule: 'A card prefers our own picture. Where the ladder has found nothing and the place is a licensed one, the provider\u2019s photograph is drawn instead \u2014 fetched at display, never written to the database, and stripped before anything reaches a device. Where a search from the last twelve hours already carried the reference, it costs no call at all. The day the ladder finds a mark for that place, this stops being asked for it.',
        why: 'The ladder finds nothing for most restaurants \u2014 Commons does not photograph the inside of a curry house \u2014 and the alternative was a wall of mint squares. Offline the card falls back to its category icon, which is the honest thing for it to draw: we do not have that picture, we were only ever allowed to look at it.',
        state: 'live',
        where: 'apps/api/src/sources/rentedPhoto.js \u00b7 apps/web/src/offline/policy.ts \u00b7 cleanPlaceRow',
        said: { who: 'the owner', on: '5 Sep 2026', words: 'It means at least that we can have restaurant pictures, which is really useful in some instances.' },
      },
      {
        title: 'A street-level frame has to be of the place, not of the street',
        rule: 'The street rung admits a frame only within 15\u00b0 of the venue and 22m of it. Everything found under the older, looser geometry \u2014 38\u00b0 and 60m \u2014 has been retracted, and those places draw their icon until something better is found.',
        why: 'At 60m, \u201cinside the frame\u201d means somewhere in a photograph of an entire street. The first fourteen were photographs of roads: one was a wet road, a hedge and a windscreen wiper with no building in it. Nine were still on cards after the geometry was tightened, because tightening the rule does not retract what it already let through. The yield falls a long way and should \u2014 the icon is a better answer than somebody\u2019s hedge.',
        state: 'live',
        where: 'apps/api/src/sources/streetLevel.js \u00b7 image_assets.moderation',
        said: { who: 'the owner', on: '6 Sep 2026', words: 'It\u2019s not going to showcase our app if the screens look rubbish\u2026 I think we need to source them from somewhere, not have pictures of streets. That\u2019s not okay.' },
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

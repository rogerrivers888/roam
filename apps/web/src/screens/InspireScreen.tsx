import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, BrowseItem, HouseholdResponse, InspireItem, InspireNear, MoodKey, Place, API_URL } from '../api';
import { useHere } from '../hooks/useHere';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Icon, IconName, iconFor } from '../components/Icon';
import { Chip, minutes } from '../components/ui';
import { VenueDrawer } from '../components/VenueDrawer';
import { WhereSearch } from '../components/WhereSearch';
import { VenueThumb } from '../components/VenueThumb';
import { useViewport } from '../hooks/useViewport';
import { firstName } from '../components/Faces';
import { asList, asNumber, asOneOf, useQueryState, useRouter, useStickyQuery } from '../router';
import { paths, MOODS, type Route } from '../routes';
import type { OpenTripOptions } from './PlanScreen';

/**
 * Inspire — the home screen (owner, 5 Sep 2026; "Supporting docs/Roam Inspire").
 *
 * Roam opens on what there is to do, not on a form. A search bar at the top
 * asks the only question the household has to answer — where — and everything
 * under it is shelves of real places, drawn from one retrieved pool.
 *
 * Three rules this screen is built to:
 *
 *  - **One pool.** `/api/inspire/near` makes one place search and hands back
 *    every venue once, each already carrying the moods it belongs to, the
 *    journey to it and how long this household would stay. Every chip, band and
 *    shelf on this screen is composed from that array in memory. Tapping
 *    Culture, narrowing to an hour or picking a price band never asks a
 *    provider anything (Requirements: options come from one pool).
 *  - **A filter opens under the bar it belongs to** (owner, 4 Sep 2026), never
 *    as a sheet at the foot of the page, and the shelves behind it update as it
 *    is tapped. The Budget panel in the design is that pattern; the other four
 *    chips open the same way.
 *  - **Nothing here is written down.** The answer carries a provider's names,
 *    photos and ratings, which are rented, so `/api/inspire/near` is absent
 *    from `offline/policy.ts` and never reaches IndexedDB. What is remembered
 *    between visits is what the household *chose* — where they were looking and
 *    how they had it filtered — which is theirs.
 */

// How deep a shelf goes before you have to ask for the rest.
//
// The owner, 5 Sep 2026: "60 so the user can keep scrolling, but if they just
// want to keep on scrolling again, we can just keep loading more. If we have
// 250, then let them scroll until we've exhausted the 250." So there is no cut
// in the data at all — the whole pool is already in hand, from our own table —
// and these are only how much is drawn at once, so a shelf of two hundred
// places does not put two hundred images in the tree before anybody has
// scrolled. Opening a shelf shows a page of them and adds another page on ask.
const SHELF = 24;
const PAGE = 36;

/**
 * The chips, in the order the design draws them — and Food is not one of the
 * others (owner, 5 Sep 2026):
 *
 * > "for food, we should not show that on our homepage now, and we should just
 * > show inspirational activities. If they click food, then I feel like we need
 * > to take them into our food listings because food will never have photos...
 * > if I clicked on food, it would take me to the places tab and search for
 * > food."
 *
 * So Food keeps its place in the row and stops being a filter: it is a door
 * into Places, which is where somewhere to eat already lives. It carries an
 * arrow rather than the others' selected state, because a chip that navigates
 * where its neighbours filter has to say so before it is tapped.
 */
const MOOD_ORDER: MoodKey[] = MOODS;
/** The ones that are shelves. Food is a door and never a shelf. */
const SHELVES: MoodKey[] = MOOD_ORDER.filter((m) => m !== 'food') as MoodKey[];
const MOOD_LABEL: Record<MoodKey, string> = {
  fun: 'Fun', food: 'Food', culture: 'Culture', adrenaline: 'Adrenaline', relaxing: 'Relaxing', outdoors: 'Outdoors',
};

/** How far the family will go today. The chip reads the chosen label back. */
const CAPS: { label: string; value: number | null }[] = [
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: 'Any distance', value: null },
];

/** How much of a day it is. Travel there and back, plus the time spent. */
const OUTINGS: { key: string; label: string; maxMinutes: number | null }[] = [
  { key: 'any', label: 'Any length', maxMinutes: null },
  { key: 'couple', label: 'A couple of hours', maxMinutes: 180 },
  { key: 'half', label: 'Half a day', maxMinutes: 300 },
  { key: 'day', label: 'Day trip', maxMinutes: null },
];

/**
 * What it costs. `all` is the absence of a choice, not a fifth band — a place
 * whose price no source has told us is shown under All and under nothing else,
 * because putting it in a band would be inventing the price.
 */
const BUDGETS: { key: string; label: string; max: number | null }[] = [
  { key: 'all', label: 'All', max: null },
  { key: 'free', label: 'Free', max: 0 },
  { key: 'low', label: '£', max: 1 },
  { key: 'mid', label: '££', max: 2 },
  { key: 'high', label: '£££', max: 4 },
];

type Panel = null | 'travel' | 'kind' | 'who' | 'outing' | 'budget';

/**
 * Every part of this screen that somebody chose, and therefore every part of it
 * that has to survive being sent to somebody else (owner, 5 Sep 2026: "I should
 * be able to share a URL … and they should be able to get to the exact point
 * that I was on"). Where you are looking, what the day is about, how far, how
 * long, what it costs, what kind of thing and who is coming.
 *
 * They are query, not path, because they are how the page is set rather than
 * which page it is — and only what differs from the default is written down, so
 * a screen nobody has touched stays at `/inspire`.
 */
const KEYS = ['at', 'where', 'locality', 'from', 'mood', 'travel', 'outing', 'budget', 'kinds', 'who'];

/** "51.48160,-0.61130" — enough to look around the same town, and no more. */
const placeFromQuery = (q: URLSearchParams): Place | null => {
  const at = q.get('at');
  if (!at) return null;
  const [lat, lng] = at.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, label: q.get('where') ?? `${lat}, ${lng}`, locality: q.get('locality') };
};
const placeToQuery = (p: Place | null, from: 'here' | 'search' | null): Record<string, string | null> => (p
  ? {
    at: `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`,
    where: p.label,
    locality: p.locality && p.locality !== p.label ? p.locality : null,
    from: from === 'here' ? 'here' : null,
  }
  : { at: null, where: null, locality: null, from: null });

/**
 * "Fairways, Titlarks Hill, Ascot, SL5 0JD" is where somebody lives; "Ascot" is
 * where they are. The town is the last part of the address that is not a
 * postcode, which is true of every address the map gives us and of every area
 * name, where there is only one part to begin with.
 */
export function shortPlace(label: string | null | undefined): string {
  if (!label) return 'here';
  const parts = label.split(',').map((p) => p.trim()).filter((p) => p && !/\d/.test(p));
  return parts[parts.length - 1] ?? label.split(',')[0].trim();
}

/** "££" — what a source said it costs, in the marks people already read. */
const priceMarks = (p: number | null) => (p == null ? null : p === 0 ? 'Free' : '£'.repeat(Math.max(1, Math.min(4, p))));

const cap1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).replace(/-/g, ' ') : s);

/**
 * Every word we have for what kind of place this is. The atlas's own is first
 * because it is the researched one — "Heritage", "Outdoors" — and a search's
 * tags follow it.
 */
const kindsOf = (item: InspireItem): string[] =>
  [item.atlasCategory, ...(item.experiences ?? [])].filter(Boolean) as string[];

/** What kind of place this is, in its own words: "Heritage", "Castle · History", "Italian". */
function kindLine(item: InspireItem): string | null {
  const words = [...kindsOf(item), ...(item.cuisines ?? [])].filter(Boolean);
  const bits = words.length ? words.slice(0, 2) : item.category === 'attraction' ? [] : [item.category];
  return bits.length ? [...new Set(bits.map(cap1))].join(' · ') : null;
}

export function InspireScreen({ route, household, onOpenTrip, onPlanner, onFood, onCreateTrip }: {
  /** Which layer of Inspire the address asks for: the shelves, one shelf opened, or the search. */
  route: Extract<Route, { name: 'inspire' }>;
  household: HouseholdResponse | null;
  onOpenTrip?: (tripId: string, opts?: OpenTripOptions) => void;
  /**
   * The call to action on a place (owner, 5 Sep 2026): "for each place that I
   * click through, I should have a call to action: Create trip, because that
   * should then take me into the trips. It will show me the distance, how to
   * get there, how to add places for food."
   *
   * Everything he lists is already Trips' job, so this hands the place over
   * rather than growing a second version of any of it here.
   */
  onCreateTrip?: (p: { place: Place; seed: { venueRef: string; name: string; category?: string | null; lat?: number | null; lng?: number | null } }) => void;
  /** The other way to ask: say what the day is for and let Roam think about it. */
  onPlanner?: () => void;
  /** Somewhere to eat is Places' question, not this screen's. */
  onFood?: () => void;
}) {
  const { width } = useViewport();
  const wide = width >= 900;
  const { query, navigate, setQuery, back } = useRouter();
  // How this screen was last set, filled in only when the address is silent.
  useStickyQuery('inspire', KEYS);

  const home: Place | null = household?.household.home ?? null;
  const members = household?.members ?? [];

  // Everything somebody chose is in the address, so the whole screen can be sent.
  const searching = route.searching;
  const openRow = route.shelf;
  const chosen = placeFromQuery(query);
  const fromHere = query.get('from') === 'here';
  const setWhere = (p: Place | null, from: 'here' | 'search' | null) => setQuery(placeToQuery(p, from), { replace: false });

  const [mood, setMood] = useQueryState<MoodKey>('mood', 'fun', asOneOf(SHELVES, 'fun'));
  const [cap, setCap] = useQueryState<number | null>('travel', 60, asNumber(60));
  const [outing, setOuting] = useQueryState('outing', 'any', asOneOf(OUTINGS.map((o) => o.key), 'any'));
  const [budget, setBudget] = useQueryState('budget', 'all', asOneOf(BUDGETS.map((b) => b.key), 'all'));
  const [kinds, setKinds] = useQueryState<string[]>('kinds', [], asList);
  const [who, setWho] = useQueryState<string[]>('who', [], asList);
  // Nobody named is everybody: "who" is only in the address once it excludes somebody.
  const attending = who.length ? new Set(who) : null;
  const setAttending = (next: Set<string> | null) => setWho(next && next.size !== members.length ? [...next] : []);
  const [panel, setPanel] = useState<Panel>(null);
  const setOpenRow = (m: MoodKey | null) => navigate((m ? paths.inspireShelf(m) : paths.inspire()) + hereQuery());
  const hereQuery = () => { const q = query.toString(); return q ? `?${q}` : ''; };
  /** One address out of a path and a change to the query, for the taps that do both at once. */
  const withQuery = (base: string, patch: Record<string, string | null>) => {
    const q = new URLSearchParams(query);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') q.delete(k); else q.set(k, v); }
    const rest = q.toString();
    return rest ? `${base}?${rest}` : base;
  };

  const [pool, setPool] = useState<InspireNear | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Hearts turn the moment they are tapped; the pool they came from is not rewritten.
  const [kept, setKept] = useState<Record<string, boolean>>({});
  // Why a heart sprang back: said once, under the shelves, never as a dialogue.
  const [notice, setNotice] = useState<string | null>(null);

  // Where the phone is, when the browser will say without being asked.
  //
  // Roger, 5 Sep 2026: "We should identify the location from the user's mobile
  // browser." A cold permission prompt on load is still not the way to do it —
  // once refused, the browser remembers and will not ask again, which would
  // cost this feature permanently on that phone. So: if permission has already
  // been granted, the fix is taken silently and the screen opens on where they
  // are standing; if it has not, the offer is one obvious tap under the search
  // bar. Nothing here ever triggers a prompt the household did not ask for.
  const me = useHere();
  const [mayAsk, setMayAsk] = useState(false);
  const askedSilently = useRef(false);
  // The browser answers a moment later than this screen draws, by which time
  // the address may have gained a town — from the link, or from what this
  // screen was last set to. Read it then, not now.
  const chosenNow = useRef(chosen);
  chosenNow.current = chosen;
  useEffect(() => {
    if (askedSilently.current || !me.supported) return;
    askedSilently.current = true;
    const permissions = (globalThis as any).navigator?.permissions;
    if (!permissions?.query) { setMayAsk(true); return; }
    permissions.query({ name: 'geolocation' })
      .then(async (status: any) => {
        // Only when nobody has said where: a link that names a town means that
        // town, whoever opens it and wherever they are standing.
        if (status.state === 'granted') { if (!chosenNow.current) { const p = await me.ask(); if (p && !chosenNow.current) setWhere(p, 'here'); } }
        else if (status.state === 'prompt') setMayAsk(true);
      })
      .catch(() => setMayAsk(true));
  }, [me.supported]);

  const useHereNow = async () => { const p = await me.ask(); if (p) { setWhere(p, 'here'); setMayAsk(false); } };

  // Where somebody said, which wins over home: the most deliberate answer to
  // "where" is the one on screen, and it is in the address so it travels.
  const centre = chosen ?? home;
  const load = useCallback(async () => {
    if (!centre) { setPool(null); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      // The atlas alone, which is what this endpoint now answers by default
      // (owner, 5 Sep 2026: activities "from our own database with data we
      // own", loaded "within a second or 2"). One indexed table, no provider
      // asked, every place illustrated — the live look-around waits seven
      // seconds on OpenStreetMap and comes back without a photograph, and is
      // now only reachable by asking for it.
      const r = await api.inspireNear({
        lat: centre.lat, lng: centre.lng,
        label: centre.label, locality: centre.locality ?? null,
      });
      setPool(r);
    } catch (e: any) {
      setPool(null);
      setError(e?.message ?? 'Roam could not look around just now.');
    } finally {
      setLoading(false);
    }
  }, [centre?.lat, centre?.lng, centre?.label]);

  useEffect(() => { void load(); }, [load]);

  const placeName = shortPlace(pool?.place.locality ?? centre?.locality ?? centre?.label);

  // Everything the sources called a kind of place here, for the kinds panel:
  // the list is what is actually in this pool, so it is never a menu of
  // nothing (owner: no dead controls).
  const kindsHere = useMemo(() => {
    const seen = new Map<string, number>();
    for (const i of pool?.items ?? []) for (const e of kindsOf(i)) seen.set(e, (seen.get(e) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  }, [pool]);

  const pricesKnown = useMemo(() => (pool?.items ?? []).filter((i) => i.priceLevel != null).length, [pool]);

  const coming = members.filter((m) => !attending || attending.has(m.id));
  const minorComing = coming.some((m) => m.isMinor);
  // The youngest person coming decides a lot: a four-year-old and a fifteen-
  // year-old want different days out, and the household already knows both ages.
  const youngest = coming.reduce<number | null>((y, m) => (m.age == null ? y : y == null ? m.age : Math.min(y, m.age)), null);

  /**
   * Who is coming ranks; it does not exclude (Requirements: allergens exclude,
   * preferences rank — and who is in the car is a preference, not an allergy).
   *
   * The owner, 5 Sep 2026: "If the family are going, it should be focused on
   * family activities. If adults are going, then it shouldn't be showing
   * playgrounds." So a day with a child in it leads with the places built for
   * one, and a day without leads with everything else.
   *
   * It ranks rather than filters because the atlas's `family` is a coarse word:
   * it holds amusement parks and heritage railways, and it also holds
   * distilleries, which are the opposite of a children's day out. Demoting a
   * distillery on an adults' outing is a small mistake; deleting it is a
   * bigger one, and the household can always see it by scrolling.
   */
  const forWhoever = (i: InspireItem): number => {
    const kid = i.atlasCategory === 'family' || i.atlasCategory === 'animals';
    if (!kid) return 0;
    return minorComing ? -1 : 1;
  };

  /** The pool, narrowed by every chip. One pass, no calls. */
  const shown = useMemo(() => {
    const outingMax = OUTINGS.find((o) => o.key === outing)?.maxMinutes ?? null;
    const band = BUDGETS.find((b) => b.key === budget);
    return (pool?.items ?? []).filter((i) => {
      if (cap != null && i.travelMinutes > cap) return false;
      if (outingMax != null && i.travelMinutes * 2 + i.dwellMinutes > outingMax) return false;
      if (band && band.max != null && (i.priceLevel == null || i.priceLevel > band.max)) return false;
      if (kinds.length && !kindsOf(i).some((e) => kinds.includes(e))) return false;
      // A source that has said outright that children are not welcome is taken
      // at its word; one that has said nothing is not guessed about.
      if (minorComing && i.goodForChildren === false) return false;
      return true;
    });
  }, [pool, cap, outing, budget, kinds, minorComing]);

  const shelves = useMemo(() => {
    const order = [mood, ...SHELVES.filter((m) => m !== mood)];
    // A stable sort over the answer's own order, so the atlas's ranking still
    // decides everything except who is in the car.
    return order.map((key) => ({
      key,
      items: shown.filter((i) => i.moods.includes(key)).sort((a, b) => forWhoever(a) - forWhoever(b)),
    }));
  }, [shown, mood, minorComing]);

  const whoLabel = !attending || attending.size === members.length
    ? 'Family'
    : members.filter((m) => attending.has(m.id)).map((m) => firstName(m.name)).join(', ') || 'Nobody yet';

  /**
   * The place, opened.
   *
   * Our own photograph travels in as the drawer's picture, carrying its credit
   * — which is where the credit now lives (owner, 5 Sep 2026: "I don't want the
   * credits on the main image. They can go into the side drawer when you click
   * through onto the image"). The licence is still satisfied: the line is shown
   * with the picture at the size anybody would actually look at it, rather than
   * set in 10px grey under a thumbnail, and it is in the drawer's footer too.
   */
  const asDrawerItem = (item: InspireItem) => ({
    id: item.venueRef, venueRef: item.venueRef, name: item.name, category: item.category,
    lat: item.lat, lng: item.lng, dwellMinutes: item.dwellMinutes, reasons: [], justification: null,
    startsAt: null, endsAt: null, pinned: false,
    rating: item.rating, ratingCount: item.ratingCount, priceLevel: item.priceLevel,
    // Ours travels as itself; the provider's travels as `photos`. Folding ours
    // into `photos` was fine while every one of them was a Commons photograph,
    // but a logo stretched across an 800px hero is a smear, so the drawer has
    // to be able to tell them apart (5 Sep 2026).
    image: item.image ?? null,
    photos: item.photos,
    summary: item.summary ?? null, attribution: item.attribution.join(' · ') || null,
    distanceKm: item.distanceKm, travelFromBaseMinutes: item.travelMinutes,
    source: item.source,
  } as BrowseItem);
  /**
   * Opening a place is a step, so it is a step in the address too: `?place=…`
   * over whichever shelf is showing. Send that to somebody and they open the
   * same drawer, and Back closes it rather than leaving the screen.
   */
  const open = (item: InspireItem) => setQuery({ place: item.venueRef }, { replace: false });
  const openedRef = query.get('place');
  const drawer = useMemo(
    () => { const it = openedRef ? (pool?.items ?? []).find((i) => i.venueRef === openedRef) : null; return it ? asDrawerItem(it) : null; },
    [openedRef, pool],
  );
  const closeDrawer = () => setQuery({ place: null }, { replace: false });

  /**
   * The heart: keep this place, or take it back out. Taking it out removes it
   * from the atlas rather than marking it dismissed — an un-tapped heart means
   * "I did not mean to keep that", not "not for us", and the two must not wear
   * the same control. A place the household has actually been to cannot be
   * removed, and the API says so.
   */
  const keep = async (item: InspireItem) => {
    const now = !isKept(item);
    setKept((k) => ({ ...k, [item.venueRef]: now }));
    try {
      if (now) {
        await api.savePlace(item.venueRef, 'saved', { label: item.name, category: item.category, lat: item.lat, lng: item.lng });
      } else {
        await api.deleteAtlasPlace(item.venueRef);
      }
    } catch (e: any) {
      // Put the heart back rather than leave it saying something untrue.
      setKept((k) => ({ ...k, [item.venueRef]: !now }));
      setNotice(e?.message ?? 'That could not be saved just now.');
    }
  };
  const isKept = (item: InspireItem) =>
    kept[item.venueRef] ?? ['saved', 'special'].includes(item.household?.ledger ?? '');

  // The search is a whole screen, drawn in the tab so the tab bar stays put.
  if (searching) {
    return (
      <WhereSearch
        home={home}
        onClose={() => back(paths.inspire() + hereQuery())}
        // One address: the town they picked, with the search screen out of the
        // way behind them, so Back goes to where they were looking before.
        onPick={(p) => navigate(withQuery(paths.inspire(), placeToQuery(p, 'search')), { replace: true })}
        onPlanner={onPlanner}
      />
    );
  }

  return (
    <View style={styles.fill}>
      <ScrollView style={styles.fill} contentContainerStyle={styles.scroll} stickyHeaderIndices={[0]}>
        <View style={[styles.top, wide && styles.topWide]}>
          <Pressable onPress={() => navigate(paths.inspireSearch() + hereQuery())} style={[styles.search, wide && styles.searchWide]} accessibilityRole="search" accessibilityLabel="Where should we go?">
            <Icon name="search" size={18} color={colors.ink} strokeWidth={2.2} />
            <Text style={styles.searchText} numberOfLines={1}>
              {chosen ? `${fromHere ? 'Near ' : ''}${shortPlace(chosen.locality ?? chosen.label)}` : 'Where should we go?'}
            </Text>
            {chosen ? (
              <Pressable onPress={() => setWhere(null, null)} hitSlop={10} accessibilityLabel="Back to near home">
                <Icon name="close" size={16} color={colors.inkMuted} />
              </Pressable>
            ) : null}
          </Pressable>
          {/* Offered, never sprung: this only appears when the browser has not
              been asked yet, and tapping it is what asks. */}
          {mayAsk && !chosen ? (
            <Pressable onPress={useHereNow} disabled={me.busy} style={styles.hereOffer} accessibilityRole="button">
              {me.busy ? <ActivityIndicator size="small" color={colors.icon} /> : <Icon name="here" size={14} color={colors.icon} />}
              <Text style={[type.small, { color: colors.ink, fontWeight: '600' }]}>
                {me.busy ? 'Finding you…' : 'Use my location'}
              </Text>
            </Pressable>
          ) : null}
        </View>

        <View style={[styles.column, wide && styles.columnWide]}>
          <View style={styles.moods}>
            <Text style={[type.label, styles.gutter]}>What's the day about?</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
              {MOOD_ORDER.map((m) => (
                m === 'food'
                  ? <FoodDoor key={m} onPress={() => onFood?.()} />
                  // What the day is about closes any opened shelf, so it is one
                  // move and one address rather than two that race each other.
                  : <Chip key={m} label={MOOD_LABEL[m]} selected={mood === m} onPress={() => navigate(withQuery(paths.inspire(), { mood: m === 'fun' ? null : m }))} />
              ))}
            </ScrollView>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
            <FilterChip icon="driving" label={CAPS.find((c) => c.value === cap)?.label ?? 'Any distance'} open={panel === 'travel'} onPress={() => setPanel(panel === 'travel' ? null : 'travel')} />
            <FilterChip icon="list" label={kinds.length ? `${kinds.length} kind${kinds.length === 1 ? '' : 's'}` : 'All'} open={panel === 'kind'} onPress={() => setPanel(panel === 'kind' ? null : 'kind')} />
            {members.length > 1 ? (
              <FilterChip icon="household" label={whoLabel} open={panel === 'who'} onPress={() => setPanel(panel === 'who' ? null : 'who')} />
            ) : null}
            <FilterChip label={OUTINGS.find((o) => o.key === outing)?.label ?? 'Any length'} open={panel === 'outing'} onPress={() => setPanel(panel === 'outing' ? null : 'outing')} />
            <FilterChip icon="money" label={BUDGETS.find((b) => b.key === budget)?.label ?? 'All'} open={panel === 'budget'} onPress={() => setPanel(panel === 'budget' ? null : 'budget')} />
          </ScrollView>

          {panel ? (
            <View style={styles.panel}>
              <View style={styles.panelHead}>
                <Text style={styles.panelTitle}>{PANEL_TITLE[panel]}</Text>
                <Pressable onPress={() => setPanel(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                  <Icon name="close" size={16} color={colors.inkMuted} />
                </Pressable>
              </View>

              {panel === 'travel' ? (
                <Bands options={CAPS.map((c) => ({ key: String(c.value), label: c.label }))} value={String(cap)} onPick={(k) => setCap(k === 'null' ? null : Number(k))} />
              ) : null}

              {panel === 'outing' ? (
                <Bands options={OUTINGS.map((o) => ({ key: o.key, label: o.label }))} value={outing} onPick={setOuting} wrap />
              ) : null}

              {panel === 'budget' ? (
                <>
                  <Bands options={BUDGETS.map((b) => ({ key: b.key, label: b.label }))} value={budget} onPick={setBudget} />
                  <Text style={type.small}>
                    {pricesKnown
                      ? 'Defaults to All — tap a band to narrow it.'
                      : `No source has priced anything around ${placeName} yet, so the bands are empty. All shows everything.`}
                  </Text>
                </>
              ) : null}

              {panel === 'kind' ? (
                kindsHere.length ? (
                  <>
                    <View style={styles.wrap}>
                      {kindsHere.map((k) => (
                        <Chip key={k.key} label={`${cap1(k.key)} · ${k.count}`} selected={kinds.includes(k.key)}
                          onPress={() => setKinds(kinds.includes(k.key) ? kinds.filter((x) => x !== k.key) : [...kinds, k.key])} />
                      ))}
                    </View>
                    {kinds.length ? <Pressable onPress={() => setKinds([])} hitSlop={8}><Text style={type.small}>Show all kinds</Text></Pressable> : null}
                  </>
                ) : (
                  <Text style={type.small}>Nothing here has said what kind of thing it is yet.</Text>
                )
              ) : null}

              {panel === 'who' ? (
                <>
                  <View style={styles.wrap}>
                    {members.map((m) => {
                      const on = !attending || attending.has(m.id);
                      return (
                        <Chip key={m.id} label={firstName(m.name)} icon={on ? 'check' : undefined} selected={on}
                          onPress={() => {
                            const next = new Set(attending ?? members.map((x) => x.id));
                            if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                            setAttending(next.size === members.length ? null : next);
                          }} />
                      );
                    })}
                  </View>
                  <Text style={type.small}>
                    {minorComing
                      ? `With ${youngest != null ? `a ${youngest}-year-old` : 'a child'} coming, places built for children come first.`
                      : 'On an adults\u2019 day out, children\u2019s places drop down the shelves rather than off them.'}
                  </Text>
                </>
              ) : null}
            </View>
          ) : null}

          {loading && !pool ? (
            <View style={styles.waiting}>
              <ActivityIndicator color={colors.icon} />
              <Text style={type.small}>Looking around {placeName}…</Text>
            </View>
          ) : null}

          {!centre && !loading ? (
            <Empty
              title="Roam does not know where you are yet"
              body="Search for a town above, or set your home address in Household, and this screen fills with what is around it."
            />
          ) : null}

          {error ? <Empty title={`Nothing came back for ${placeName}`} body={error} onRetry={load} /> : null}

          {pool && !loading ? (
            <>
              {shelves.map(({ key, items }) => (
                <Shelf
                  key={key}
                  title={key === mood ? `${MOOD_LABEL[key]} near ${placeName}` : MOOD_LABEL[key]}
                  items={items}
                  wide={wide}
                  expanded={openRow === key}
                  onToggle={() => setOpenRow(openRow === key ? null : key)}
                  onOpen={open}
                  onKeep={keep}
                  isKept={isKept}
                  empty={key === mood
                    ? `Nothing ${MOOD_LABEL[key].toLowerCase()} within ${CAPS.find((c) => c.value === cap)?.label.toLowerCase() ?? 'reach'} of ${placeName} — widen the distance, or search another town.`
                    : null}
                />
              ))}
              {notice ? (
                <Pressable onPress={() => setNotice(null)} style={[styles.gutter, styles.notice]} accessibilityRole="button">
                  <Icon name="info" size={14} color={colors.ink} />
                  <Text style={[type.small, { flex: 1, color: colors.ink }]}>{notice}</Text>
                </Pressable>
              ) : null}
              <View style={[styles.gutter, styles.foot]}>
                <Text style={type.tiny}>
                  {pool.items.length} place{pool.items.length === 1 ? '' : 's'} within {pool.radiusKm} km of {placeName}
                  {pool.from.how === 'home' ? ' · times are from home' : ' · times are from where you are'}, estimated.
                </Text>
                {pool.attribution.length ? <Text style={type.tiny}>{pool.attribution.join(' · ')}</Text> : null}
                <Pressable onPress={load} hitSlop={8} accessibilityRole="button">
                  <Text style={[type.small, { fontWeight: '700' }]}>Look again</Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>
      <VenueDrawer
        item={drawer}
        baseLabel={placeName}
        onClose={closeDrawer}
        addLabel="Create trip"
        addIcon="trips"
        onAdd={onCreateTrip ? (it) => {
          closeDrawer();
          onCreateTrip({
            place: { label: it.name, lat: it.lat as number, lng: it.lng as number },
            seed: { venueRef: it.venueRef, name: it.name, category: it.category, lat: it.lat, lng: it.lng },
          });
        } : undefined}
      />
    </View>
  );
}

/**
 * Food, in the chip row but not of it. Somewhere to eat is judged on reviews
 * and menus rather than on a photograph — the atlas holds no restaurants by
 * the owner's own instruction — so this opens Places, where the household's
 * own food places already live, instead of drawing a shelf of grey tiles.
 */
function FoodDoor({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link" style={styles.foodDoor} accessibilityLabel="Somewhere to eat, in Places">
      <Icon name="restaurant" size={14} color={colors.ink} />
      <Text style={styles.foodDoorText}>Food</Text>
      <Icon name="forward" size={13} color={colors.inkMuted} strokeWidth={2.2} />
    </Pressable>
  );
}

const PANEL_TITLE: Record<Exclude<Panel, null>, string> = {
  travel: 'How far', kind: 'Kind of thing', who: "Who's coming", outing: 'How long', budget: 'Budget',
};

/** A chip that opens a panel under the bar. The chevron says so. */
function FilterChip({ icon, label, open, onPress }: { icon?: IconName; label: string; open: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded: open }} style={[styles.filter, open && styles.filterOpen]}>
      {icon ? <Icon name={icon} size={14} color={open ? colors.primaryFg : colors.ink} /> : null}
      <Text style={[styles.filterText, open && { color: colors.primaryFg }]} numberOfLines={1}>{label}</Text>
      <Icon name={open ? 'collapse' : 'expand'} size={13} color={open ? colors.primaryFg : colors.inkMuted} strokeWidth={2.2} />
    </Pressable>
  );
}

/** One row of equal choices, the way the Budget panel in the design draws them. */
function Bands({ options, value, onPick, wrap }: { options: { key: string; label: string }[]; value: string; onPick: (k: string) => void; wrap?: boolean }) {
  return (
    <View style={[styles.bands, wrap && styles.wrap]}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} onPress={() => onPick(o.key)} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={[styles.band, wrap ? styles.bandWrap : { flex: 1 }, on && styles.bandOn]}>
            <Text style={[styles.bandText, on && { color: colors.primaryFg }]} numberOfLines={1}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One mood's shelf: a title, and its places across or wrapped. */
function Shelf({ title, items, wide, expanded, onToggle, onOpen, onKeep, isKept, empty }: {
  title: string; items: InspireItem[]; wide: boolean; expanded: boolean; onToggle: () => void;
  onOpen: (i: InspireItem) => void; onKeep: (i: InspireItem) => void; isKept: (i: InspireItem) => boolean;
  empty: string | null;
}) {
  // How much of an opened shelf has been drawn. It starts again at a page each
  // time the shelf is closed, which is what somebody expects of a fold.
  const [drawn, setDrawn] = useState(PAGE);
  useEffect(() => { if (!expanded) setDrawn(PAGE); }, [expanded]);
  if (!items.length && !empty) return null;
  const cards = expanded ? items.slice(0, drawn) : items.slice(0, SHELF);
  const more = expanded ? items.length - cards.length : 0;
  return (
    <View style={styles.shelf}>
      <Pressable onPress={items.length > SHELF || items.length ? onToggle : undefined} style={[styles.shelfHead, styles.gutter]} accessibilityRole="button" accessibilityState={{ expanded }}>
        <Text style={styles.shelfTitle}>{title}</Text>
        {items.length ? (
          <View style={styles.shelfMore}>
            <Text style={type.tiny}>{expanded ? 'Fewer' : `All ${items.length}`}</Text>
            <Icon name={expanded ? 'collapse' : 'more'} size={18} color={colors.ink} strokeWidth={2} />
          </View>
        ) : null}
      </Pressable>
      {!items.length ? (
        <Text style={[type.small, styles.gutter]}>{empty}</Text>
      ) : expanded ? (
        <View style={[styles.grid, styles.gutter]}>
          {cards.map((i) => <Card key={i.venueRef} item={i} wide={wide} onOpen={onOpen} onKeep={onKeep} kept={isKept(i)} />)}
          {more ? (
            <Pressable onPress={() => setDrawn((n) => n + PAGE)} style={[styles.tile, styles.showMore, { width: wide ? 240 : 200, height: wide ? 180 : 150 }]} accessibilityRole="button">
              <Icon name="expand" size={20} color={colors.icon} />
              <Text style={[type.small, { color: colors.ink, fontWeight: '700' }]}>{more} more</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {cards.map((i) => <Card key={i.venueRef} item={i} wide={wide} onOpen={onOpen} onKeep={onKeep} kept={isKept(i)} />)}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * One place.
 *
 * The picture is Roam's own: harvested from Wikimedia Commons under a licence
 * that lets us keep it, held in our database at three widths, and served from
 * `/api/images/:id/500` outside the session door with a year's immutable
 * caching — so the second time anybody sees this card the bytes come from the
 * browser and nothing reaches the API at all.
 *
 * It paints in two steps. The `lqip` is a 20px JPEG inlined in the answer as a
 * data URI, about half a kilobyte, so the tile has the photograph's own colours
 * before a single image request has been made; the real picture then arrives
 * over the top. That is what "instant" is made of here, and it is why the atlas
 * exists at all.
 *
 * `credit` is drawn whenever the licence requires it. That is a condition of
 * being allowed to show the picture, not a nicety, so it is inside this
 * component rather than left to each caller to remember.
 *
 * A place with no photograph of ours still gets its own icon on the mint tile,
 * so a shelf reads as deliberate rather than broken.
 */
function Card({ item, wide, onOpen, onKeep, kept }: {
  item: InspireItem; wide: boolean; onOpen: (i: InspireItem) => void; onKeep: (i: InspireItem) => void; kept: boolean;
}) {
  const w = wide ? 240 : 200;
  const h = wide ? 180 : 150;
  const price = priceMarks(item.priceLevel);
  const kind = kindLine(item);
  return (
    <Pressable onPress={() => onOpen(item)} style={{ width: w, gap: spacing.sm }} accessibilityRole="button" accessibilityLabel={item.name}>
      {/* Ours first, then the provider's, then the card's own identity —
          VenueThumb decides which, and draws a mark differently from a
          photograph. The credit is off here because the drawer carries it: a
          shelf of cards each with a licence line under it is unreadable, and
          the line has to appear wherever the picture is large enough to be the
          point, which is the drawer. */}
      <VenueThumb
        name={item.name}
        image={item.image}
        photos={item.photos}
        category={item.category}
        experiences={item.experiences}
        atlasCategory={item.atlasCategory}
        width={w}
        height={h}
        rounded={6}
        credit={false}
      >
        <Pressable
          onPress={(e: any) => { e?.stopPropagation?.(); onKeep(item); }}
          hitSlop={8}
          style={styles.heart}
          accessibilityRole="button"
          accessibilityState={{ selected: kept }}
          accessibilityLabel={kept ? `Remove ${item.name} from your places` : `Keep ${item.name}`}
        >
          <Icon name="keep" size={16} color={kept ? colors.red : colors.ink} fill={kept} strokeWidth={2} />
        </Pressable>
      </VenueThumb>
      <View style={{ gap: 2 }}>
        <Text style={styles.cardName} numberOfLines={2}>{item.name}</Text>
        <Text style={type.small}>{minutes(item.travelMinutes)} · {minutes(item.dwellMinutes)}</Text>
        {price || kind ? <Text style={[type.small, { color: colors.ink }]} numberOfLines={1}>{price ?? kind}</Text> : null}

      </View>
    </Pressable>
  );
}

function Empty({ title, body, onRetry }: { title: string; body: string; onRetry?: () => void }) {
  return (
    <View style={[styles.empty, styles.gutter]}>
      <Text style={type.h3}>{title}</Text>
      <Text style={type.small}>{body}</Text>
      {onRetry ? <Pressable onPress={onRetry} hitSlop={8}><Text style={[type.small, { fontWeight: '700' }]}>Try again</Text></Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: spacing.xxl },
  top: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, backgroundColor: colors.bg },
  topWide: { maxWidth: 1120, width: '100%', alignSelf: 'center' },
  column: { gap: spacing.md },
  columnWide: { maxWidth: 1120, width: '100%', alignSelf: 'center' },
  gutter: { paddingHorizontal: spacing.lg },
  // The one raised thing on the screen: the question the household came to answer.
  search: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    minHeight: 52, paddingHorizontal: spacing.lg, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
    boxShadow: '0 2px 10px rgba(32,30,29,0.10)',
  },
  searchWide: { maxWidth: 560, width: '100%', alignSelf: 'center' },
  hereOffer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 34, marginTop: 6 },
  foodDoor: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34, paddingHorizontal: 12,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceMuted,
  },
  foodDoorText: { fontSize: 13, fontWeight: '600', color: colors.ink },
  searchText: { fontSize: 15, fontWeight: '700', color: colors.ink },
  moods: { gap: 2 },
  strip: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: 2 },
  filters: { gap: 6, paddingHorizontal: spacing.lg, paddingVertical: 2 },
  filter: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34, paddingHorizontal: 12,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  filterOpen: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { fontSize: 12.5, fontWeight: '600', color: colors.ink, maxWidth: 140 },
  panel: { gap: spacing.md, padding: spacing.md, marginHorizontal: spacing.lg, borderRadius: 12, backgroundColor: colors.panel },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  panelTitle: { fontSize: 13, fontWeight: '700', color: colors.ink },
  bands: { flexDirection: 'row', gap: 6 },
  band: { minHeight: 38, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  bandWrap: { flexGrow: 0 },
  bandOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  bandText: { fontSize: 12.5, fontWeight: '600', color: colors.ink },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  shelf: { gap: spacing.md, marginTop: spacing.sm },
  shelfHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, minHeight: 34 },
  shelfTitle: { fontSize: 18, fontWeight: '800', letterSpacing: -0.36, color: colors.ink, flex: 1 },
  shelfMore: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: { borderRadius: 6, overflow: 'hidden', backgroundColor: colors.surfaceMuted },
  tileEmpty: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  showMore: { alignItems: 'center', justifyContent: 'center', gap: 6 },
  // The one control that sits on a photograph, so it carries its own ground —
  // the surface colour of whichever mode is on, not a hardcoded white disc that
  // would burn a hole in a dark screen.
  heart: {
    position: 'absolute', top: 10, right: 10, width: 32, height: 32, borderRadius: radius.pill,
    backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center',
  },
  cardName: { fontSize: 14, fontWeight: '700', lineHeight: 18, color: colors.ink },
  waiting: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  empty: { gap: 6, paddingVertical: spacing.lg },
  foot: { gap: 6, paddingTop: spacing.lg },
  notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
});

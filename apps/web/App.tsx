import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, SafeAreaView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, API_URL, HouseholdResponse } from './src/api';
import { colors, radius, spacing, TARGET, type } from './src/theme';
import { useTheme } from './src/hooks/useTheme';
import { getViewer, onViewerChange } from './src/viewer';
import { Avatar } from './src/components/Faces';
import { PlanScreen } from './src/screens/PlanScreen';
import { InspireScreen } from './src/screens/InspireScreen';
import { PlacesScreen, PlacesPrefill } from './src/screens/PlacesScreen';
import { TripsScreen, TripPrefill } from './src/screens/TripsScreen';
import { HouseholdScreen } from './src/screens/HouseholdScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { PrototypesScreen } from './src/screens/PrototypesScreen';
import { JoinScreen } from './src/screens/JoinScreen';
import { AccountsScreen } from './src/screens/AccountsScreen';
import { AdminApp } from './src/admin/AdminApp';
import { useActivity } from './src/hooks/useActivity';
import { LockScreen } from './src/screens/LockScreen';
import { Wordmark } from './src/components/Wordmark';
import { useViewport, ViewportProvider } from './src/hooks/useViewport';
import { useOffline } from './src/hooks/useOffline';
import { useOutbox } from './src/hooks/useOutbox';
import { useSession } from './src/hooks/useSession';
import { Icon, IconName } from './src/components/Icon';

type Tab = 'inspire' | 'plan' | 'places' | 'trips' | 'household' | 'settings' | 'prototypes';
// Roam opens on Inspire (owner, 5 Sep 2026, "Supporting docs/Roam Inspire"):
// what there is to do, with one search bar above it. The conversational planner
// is still there and still has an address — ?tab=plan, and the door at the foot
// of the search screen — it is simply no longer the first thing Roam says.
const TABS: { key: Tab; label: string; icon: IconName; owner?: true }[] = [
  { key: 'inspire', label: 'Inspire', icon: 'inspire' },
  { key: 'places', label: 'Places', icon: 'places' },
  { key: 'trips', label: 'Trips', icon: 'trips' },
  { key: 'household', label: 'Household', icon: 'household' },
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

// Mobile-first (V1 is the installed web app on a phone), but on a wide screen
// this is a real desktop app: navigation down the side, two-column content.
const DESKTOP = 900;

// On a wide screen the owner can flip between the two (3 Sep 2026): "Web" is the
// desktop layout at full width; "Mobile" draws the whole app inside a phone-sized
// frame so every screen shows how it will look on the phone. The choice sticks.
type ViewMode = 'web' | 'mobile';
const VIEW_KEY = 'roam.viewMode';
/**
 * Which of Roam's two applications is open (owner, 4 Sep 2026: "2 profiles:
 * web client, web admin"). Remembered, because somebody working in the back
 * office for an afternoon should not land in the household app every reload.
 */
const PROFILE_KEY = 'roam.profile';
type Profile = 'client' | 'admin';
const readProfile = (): Profile =>
  (Platform.OS === 'web' && typeof localStorage !== 'undefined' && localStorage.getItem(PROFILE_KEY) === 'admin' ? 'admin' : 'client');
const rememberProfile = (p: Profile) => {
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.setItem(PROFILE_KEY, p);
};
const PHONE = { width: 390, height: 844 };
const TOOLBAR = 44;
const BEZEL = 10;
const readViewMode = (): ViewMode =>
  Platform.OS === 'web' && typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_KEY) === 'mobile' ? 'mobile' : 'web';

/**
 * An invite link (?join=<token>) is somebody else's door into one trip: the
 * checklist a group organiser asked them for, and none of the household's app.
 * It is read once, before anything else, so a participant never lands in Plan.
 */
const joinToken = () => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('join');
};

/**
 * A magic link (?signin=<token>) is how everybody except the owner gets in.
 *
 * Read once, before anything else, and taken out of the address bar the moment
 * it has been used: a link left in the URL is a link that gets bookmarked, sent
 * on and pasted into a chat, and this one signs somebody in.
 */
const signInToken = () => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('signin');
};

function forgetSignInToken() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const q = new URLSearchParams(window.location.search);
  if (!q.has('signin')) return;
  q.delete('signin');
  const rest = q.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
}

export default function App() {
  const window = useWindowDimensions();
  const [mode, setMode] = useState<ViewMode>(readViewMode);
  const join = useMemo(joinToken, []);
  const choose = (m: ViewMode) => {
    setMode(m);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.setItem(VIEW_KEY, m);
  };

  // A narrow window is a phone already: no toggle, no frame.
  //
  // An invite link is somebody else's door and is never behind the passcode:
  // it opens one trip's checklist and the API treats it as public (auth.js).
  const app = join ? <JoinScreen token={join} /> : <Gate />;
  if (window.width < DESKTOP) return app;

  const frameHeight = Math.min(PHONE.height, window.height - TOOLBAR - spacing.xl * 2 - BEZEL * 2);
  // Where the phone's screen lands in the real window: the stage centres it below the toolbar.
  const origin = { x: (window.width - PHONE.width) / 2, y: TOOLBAR + (window.height - TOOLBAR - frameHeight) / 2 };
  const mobile = mode === 'mobile';
  const viewport = mobile
    ? { width: PHONE.width, height: frameHeight, framed: true, origin }
    : { width: window.width, height: window.height - TOOLBAR, framed: false };
  return (
    <View style={styles.root}>
      <View style={styles.toolbar} testID="view-mode">
        <Text style={type.tiny}>Viewing as</Text>
        <View style={styles.modeSwitch} accessibilityRole="radiogroup">
          {(['web', 'mobile'] as ViewMode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => choose(m)}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode === m }}
              style={({ hovered }: any) => [styles.modeBtn, hovered && mode !== m && styles.modeBtnHover, mode === m && styles.modeBtnActive]}
            >
              <View style={styles.modeInner}>
                <Icon name={m} size={14} color={mode === m ? colors.primaryFg : colors.inkMuted} />
                <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>{m === 'web' ? 'Web' : 'Mobile'}</Text>
              </View>
            </Pressable>
          ))}
        </View>
        {mode === 'mobile' ? <Text style={type.tiny}>{PHONE.width} × {frameHeight}</Text> : null}
      </View>
      {/* Same tree shape in both modes so the Shell (and the screen you're on) survives the switch. */}
      <View style={mobile ? styles.stage : styles.fill}>
        <View style={mobile ? styles.bezel : styles.fill}>
          <View style={mobile ? [styles.screen, { width: PHONE.width, height: frameHeight }] : styles.fill}>
            <ViewportProvider value={viewport}>
              {app}
            </ViewportProvider>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * The passcode, then the app.
 *
 * Roam's API answered anybody until 4 Sep 2026; it now wants a session for
 * everything except health, the invite link and the door itself. This is the
 * door on the app's side of that.
 *
 * `unreachable` deliberately shows the app rather than the passcode screen: a
 * device that was signed in and now has no signal has a whole atlas saved on it
 * (offline/cache.ts), and putting a passcode box in front of somebody on a
 * train — one they cannot get past, because signing in needs the API — would
 * take away the one thing that still works.
 */
function Gate() {
  const { state, isOwner, access, recheck } = useSession();
  const [profile, setProfile] = useState<Profile>(readProfile);
  const choose = (p: Profile) => { setProfile(p); rememberProfile(p); };
  // A link in the address is redeemed before the passcode screen can appear:
  // the person holding it has never seen a Roam passcode and never will.
  const link = useMemo(signInToken, []);
  const [redeeming, setRedeeming] = useState(Boolean(link));
  const [linkFailed, setLinkFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!link) return;
    let dropped = false;
    (async () => {
      try {
        await api.signInWithLink(link);
        if (dropped) return;
        recheck();
      } catch (err: any) {
        if (!dropped) setLinkFailed(err?.message ?? 'That link did not work. Ask for a new one.');
      } finally {
        // Whether it worked or not, the token comes out of the address bar: a
        // spent link in a URL is still a link somebody pastes into a chat.
        if (!dropped) { forgetSignInToken(); setRedeeming(false); }
      }
    })();
    return () => { dropped = true; };
  }, [link, recheck]);

  if (redeeming || state === 'checking') return <View style={styles.waiting} />;
  if (state === 'out' || state === 'unconfigured') {
    return <LockScreen onIn={recheck} configured={state !== 'unconfigured'} notice={linkFailed} />;
  }

  // Two applications behind one sign-in. The back office is only reachable by a
  // session holding the `admin` door — and if this app drew it anyway, every
  // request it made would answer 404 (api/src/access.js).
  const mayAdminister = Boolean(access?.doors?.includes('admin'));
  if (profile === 'admin' && mayAdminister) {
    return <AdminApp access={access} onLeave={() => choose('client')} />;
  }
  return <Shell isOwner={isOwner} mayAdminister={mayAdminister} onAdmin={() => choose('admin')} />;
}

function Shell({ isOwner, mayAdminister = false, onAdmin }: { isOwner: boolean; mayAdminister?: boolean; onAdmin?: () => void }) {
  const { width } = useViewport();
  const desktop = width >= DESKTOP;
  // The admin module is the owner's. Everybody else's app is exactly what it
  // was before accounts existed.
  const tabs = useMemo(() => TABS.filter((t) => !t.owner || isOwner), [isOwner]);
  // A link can open a tab, and a trip, straight away (?tab=trips&trip=<id>): the address Roger keeps on his phone.
  const fromUrl = useMemo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return { tab: null as Tab | null, trip: null as string | null };
    const q = new URLSearchParams(window.location.search);
    const t = q.get('tab');
    const section = q.get('section');
    return {
      tab: TABS.some((x) => x.key === t && (!x.owner || isOwner)) || t === 'prototypes' || t === 'plan' ? (t as Tab) : null,
      trip: q.get('trip'),
      // ?section= opens the trip on one of its own tabs, so a group has an address too.
      section: ['find', 'shortlist', 'day', 'group'].includes(section ?? '') ? (section as TripPrefill['section']) : undefined,
    };
  }, []);
  const [tab, setTab] = useState<Tab>(fromUrl.tab ?? 'inspire');
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');
  const [household, setHousehold] = useState<HouseholdResponse | null>(null);
  const [tripPrefill, setTripPrefill] = useState<TripPrefill | null>(fromUrl.trip ? { openTripId: fromUrl.trip, section: fromUrl.section } : null);
  // Inspire's Food chip is a door into Places, not a filter on the home screen.
  const [placesPrefill, setPlacesPrefill] = useState<PlacesPrefill | null>(null);
  // Wherever you are has an address (owner, 4 Sep 2026: "we need a unique URL
  // structure, so wherever I am, there is a unique URL"). The tab, and the trip
  // when one is open, are written to the address bar as they change, so the
  // page can be reloaded, bookmarked or sent to somebody and come back to the
  // same place — and the browser's own back button walks the tabs.
  const openTripId = tripPrefill?.openTripId ?? null;
  const wroteUrl = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    q.set('tab', tab);
    if (openTripId) q.set('trip', openTripId); else q.delete('trip');
    const next = `${window.location.pathname}?${q.toString()}`;
    if (next === `${window.location.pathname}${window.location.search}`) return;
    // The first write is the address the app was opened at getting its name;
    // only a move afterwards is a step the back button should walk back over.
    if (wroteUrl.current) window.history.pushState({ tab, trip: openTripId }, '', next);
    else window.history.replaceState({ tab, trip: openTripId }, '', next);
    wroteUrl.current = true;
  }, [tab, openTripId]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onPop = () => {
      const q = new URLSearchParams(window.location.search);
      const t = q.get('tab');
      if (TABS.some((x) => x.key === t && (!x.owner || isOwner)) || t === 'prototypes' || t === 'plan') setTab(t as Tab);
      const trip = q.get('trip');
      if (trip) setTripPrefill({ openTripId: trip });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const offline = useOffline();
  const outbox = useOutbox();
  // Which screen, and that somebody is here. Two events, nothing identifying,
  // and always written against this session's own household (useActivity).
  useActivity(tab);
  // Showing the saved copy: the browser says there is no connection, the app has
  // already had to fall back to the device, or the API cannot be reached at all
  // and there is something saved to fall back to.
  const showingSaved = !offline.online || offline.serving || (health === 'down' && offline.pages > 0);

  const refreshHousehold = useCallback(async () => {
    try {
      const h = await api.household();
      // "3 pm" means 3 pm where the family is: keep the household's timezone in step with the device.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && h.household.timezone && h.household.timezone !== tz) {
        try { await api.updateHousehold({ timezone: tz }); h.household.timezone = tz; } catch { /* keep server value */ }
      }
      setHousehold(h);
    } catch { setHousehold(null); }
  }, []);

  useEffect(() => {
    api.health().then((h) => setHealth(h.ok ? 'ok' : 'down')).catch(() => setHealth('down'));
    refreshHousehold();
  }, [refreshHousehold]);

  // Keep the device's copy fresh without being asked (owner, 4 Sep 2026: they
  // should not have to research every time they come back). Once a day, a few
  // seconds after the app settles so it never competes with the first screen,
  // and only the pages the API answers for free — the atlas place lists can ask
  // Google what kind of place a row is, and those are saved by opening Places.
  useEffect(() => {
    const t = setTimeout(() => { void api.keepDeviceCopyFresh(); }, 8000);
    return () => clearTimeout(t);
  }, []);

  const screen = (
    <>
      {tab === 'inspire' ? (
        <InspireScreen
          household={household}
          onOpenTrip={(id, opts) => { setTripPrefill({ openTripId: id, ...(opts ?? {}) }); setTab('trips'); }}
          onPlanner={() => setTab('plan')}
          onFood={() => { setPlacesPrefill({ home: true, kind: 'eat' }); setTab('places'); }}
        />
      ) : null}
      {tab === 'plan' ? <PlanScreen household={household} onOpenTrip={(id, opts) => { setTripPrefill({ openTripId: id, ...(opts ?? {}) }); setTab('trips'); }} /> : null}
      {tab === 'places' ? <PlacesScreen household={household} refreshHousehold={refreshHousehold} prefill={placesPrefill} onPrefillConsumed={() => setPlacesPrefill(null)} onPlanTrip={(p) => { setTripPrefill(p); setTab('trips'); }} /> : null}
      {tab === 'trips' ? <TripsScreen household={household} refreshHousehold={refreshHousehold} prefill={tripPrefill} onPrefillConsumed={() => setTripPrefill(null)} /> : null}
      {tab === 'household' ? <HouseholdScreen data={household} refresh={refreshHousehold} /> : null}
      {tab === 'settings' ? <SettingsScreen data={household} refresh={refreshHousehold} /> : null}
      {tab === 'prototypes' ? <PrototypesScreen /> : null}
    </>
  );

  const banner = (
    <View style={[styles.banner, health === 'down' && styles.bannerDown]}>
      <Text style={type.small}>{health === 'checking' ? `Reaching API at ${API_URL}…` : `Can't reach the API at ${API_URL}. Is it running?`}</Text>
    </View>
  );

  // No signal is not a failure (owner, 4 Sep 2026): everything the household has
  // already looked at is on the device, so this says which and gets out of the
  // way. It replaces the "can't reach the API" banner, which would be the wrong
  // thing to say to someone on a train.
  //
  // `navigator.onLine` is not the test. It only says whether the device has a
  // network interface, so a phone attached to a train's wifi with no working
  // connection behind it reports itself online. What is actually true is
  // whether the answers on screen came from the device, which is what
  // `serving` says (src/offline/cache.ts).
  // Writes made without signal are on the device and go on their own
  // (offline/outbox.ts). Saying so is the difference between "it saved" and the
  // family wondering whether it did.
  const waitingBanner = outbox.waiting || outbox.rejected ? (
    <View style={styles.banner}>
      <View style={styles.bannerRow}>
        <Icon name={outbox.rejected ? 'allergen' : 'offline'} size={14} color={outbox.rejected ? colors.overrun : colors.ink} />
        <Text style={type.small}>
          {outbox.rejected
            ? `${outbox.rejected} change${outbox.rejected === 1 ? '' : 's'} couldn't be sent and ${outbox.rejected === 1 ? 'is' : 'are'} kept on this device — Settings › Account.`
            : outbox.sending
              ? `Sending ${outbox.waiting} change${outbox.waiting === 1 ? '' : 's'}…`
              : `${outbox.waiting} change${outbox.waiting === 1 ? '' : 's'} saved on this device, waiting for signal.`}
        </Text>
      </View>
    </View>
  ) : null;

  const offlineBanner = (
    <View style={styles.banner}>
      <View style={styles.bannerRow}>
        <Icon name="offline" size={14} color={colors.ink} />
        <Text style={type.small}>
          {offline.pages
            ? `No signal — showing what's saved on this device. Your places, trips and visits are all here.`
            : `No signal, and nothing saved yet. Open Settings › On this device when you're back to save it all.`}
        </Text>
      </View>
    </View>
  );

  // One tree for both layouts, with the screen in the same slot, so flipping
  // between desktop and phone (window resize or the Web/Mobile toggle) keeps
  // whatever is open on the screen — the trip you were looking at, a search.
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />
      <View style={desktop ? styles.desktop : styles.fill}>
        {desktop ? (
          <View style={styles.sidebar}>
            <View style={styles.sideBrand}><Wordmark height={44} ground={colors.surface} /></View>
            <Text style={[type.tiny, { marginBottom: spacing.lg }]}>Remember every place you love</Text>
            {tabs.map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={[styles.navItem, tab === t.key && styles.navItemActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
                <View style={styles.navIcon}><Icon name={t.icon} size={18} color={tab === t.key ? colors.ink : colors.inkMuted} /></View>
                <Text style={[styles.navLabel, tab === t.key && { color: colors.ink }]}>{t.label}</Text>
              </Pressable>
            ))}
            {/* Not a tab any more, but not gone: the conversational planner, which
                Inspire's search screen also opens. Named here so it is findable. */}
            <Pressable onPress={() => setTab('plan')} style={[styles.navItem, tab === 'plan' && styles.navItemActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === 'plan' }}>
              <View style={styles.navIcon}><Icon name="message" size={18} color={tab === 'plan' ? colors.ink : colors.inkMuted} /></View>
              <Text style={[styles.navLabel, tab === 'plan' && { color: colors.ink }]}>Plan</Text>
            </Pressable>
            {/* Desktop only: the served mock-up pages, for review — not part of the phone app. */}
            <Pressable onPress={() => setTab('prototypes')} style={[styles.navItem, tab === 'prototypes' && styles.navItemActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === 'prototypes' }}>
              <View style={styles.navIcon}><Icon name="list" size={18} color={tab === 'prototypes' ? colors.ink : colors.inkMuted} /></View>
              <Text style={[styles.navLabel, tab === 'prototypes' && { color: colors.ink }]}>Prototypes</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            {/* The other application, for whoever holds its door. Named rather
                than hidden behind an icon: switching profile is a deliberate act. */}
            {mayAdminister && onAdmin ? (
              <Pressable onPress={onAdmin} style={[styles.navItem, styles.navItemQuiet]} accessibilityRole="button">
                <View style={styles.navIcon}><Icon name="accounts" size={18} color={colors.inkMuted} /></View>
                <Text style={styles.navLabel}>Back office</Text>
              </Pressable>
            ) : null}
            {/* The corner is who you are and how the app looks — not the API's address (owner, 4 Sep 2026). */}
            <You household={household} onOpen={() => setTab('settings')} />
          </View>
        ) : (
          <View style={styles.header}>
            <Wordmark height={34} />
            {mayAdminister && onAdmin ? (
              <Pressable onPress={onAdmin} style={styles.headerAdmin} accessibilityRole="button" accessibilityLabel="Back office">
                <Icon name="accounts" size={16} color={colors.inkMuted} />
              </Pressable>
            ) : null}
          </View>
        )}
        {!desktop ? waitingBanner : null}
        {!desktop && showingSaved ? offlineBanner : !desktop && health !== 'ok' ? banner : null}
        <View style={styles.content}>
          {desktop ? waitingBanner : null}
          {desktop && showingSaved ? offlineBanner : desktop && health === 'down' ? banner : null}
          {screen}
        </View>
        {!desktop ? (
          <View style={styles.tabs} accessibilityRole="tablist">
            {tabs.map((t) => (
              <Pressable key={t.key} onPress={() => setTab(t.key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
                <Icon name={t.icon} size={20} color={tab === t.key ? colors.ink : colors.inkMuted} />
                <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

/**
 * The foot of the sidebar, the way Parcelvision's rail does it (owner, 4 Sep
 * 2026): one row above a rule — who is using the app, and a single square icon
 * button on the right that flips light and dark. The icon is the mode you would
 * go to, not the one you are in, so it reads as the switch it is.
 *
 * Tapping the person opens Settings for now; this is where a profile and sign-in
 * will live once there is one. There is no sign-in yet, so "you" is whoever the
 * device is set to — Settings › Ratings shown as.
 */
function You({ household, onOpen }: { household: HouseholdResponse | null; onOpen: () => void }) {
  const members = household?.members ?? [];
  const [id, setId] = useState<string | null>(null);
  const { theme, setPref } = useTheme();
  useEffect(() => onViewerChange(setId), []);
  const viewer = id && members.some((m) => m.id === id) ? id : getViewer(members);
  const index = Math.max(0, members.findIndex((m) => m.id === viewer));
  const me = members[index];
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <View style={styles.foot}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={me ? `${me.name} — your profile and settings` : 'Your profile and settings'}
        style={({ hovered }: any) => [styles.you, hovered && styles.youHover]}
      >
        {me ? <Avatar name={me.name} index={index} size={30} url={me.avatarUrl} /> : <Icon name="person" size={20} color={colors.inkMuted} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.youName} numberOfLines={1}>{me ? me.name : 'Sign in'}</Text>
          <Text style={type.tiny} numberOfLines={1}>Your profile</Text>
        </View>
      </Pressable>
      <Pressable
        onPress={() => setPref(next)}
        accessibilityRole="button"
        accessibilityLabel={next === 'dark' ? 'Switch to dark mode' : 'Switch to light mode'}
        testID="theme-switch"
        style={({ hovered, pressed }: any) => [styles.themeBtn, hovered && styles.themeBtnHover, pressed && { opacity: 0.85 }]}
      >
        <Icon name={next} size={16} color={colors.inkMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  waiting: { flex: 1, backgroundColor: colors.bg },
  root: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  toolbar: {
    height: TOOLBAR, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.md,
    paddingHorizontal: spacing.lg, backgroundColor: colors.surfaceMuted, borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  modeSwitch: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, padding: 2 },
  modeBtn: { minHeight: 28, paddingHorizontal: spacing.md, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  modeBtnActive: { backgroundColor: colors.primary },
  modeBtnHover: { backgroundColor: colors.surfaceMuted },
  foot: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  you: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.xs, borderRadius: 10 },
  themeBtn: { width: 34, height: 34, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  themeBtnHover: { backgroundColor: colors.accentSoft, borderColor: colors.icon },
  youHover: { backgroundColor: colors.accentSoft },
  youName: { fontSize: 14, fontWeight: '700', color: colors.ink },
  modeInner: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  modeText: { fontSize: 12, fontWeight: '600', color: colors.inkMuted },
  modeTextActive: { color: colors.primaryFg },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted, padding: spacing.xl },
  bezel: {
    padding: BEZEL, borderRadius: 36, backgroundColor: '#1D1B16',
    boxShadow: '0 12px 30px rgba(0,0,0,0.25)',
  },
  // The screen is exactly the size the app is told it has; the bezel sits outside it.
  screen: { borderRadius: 36 - BEZEL, backgroundColor: colors.bg, overflow: 'hidden' },
  desktop: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 220, padding: spacing.lg, borderRightWidth: 1, borderRightColor: colors.line, backgroundColor: colors.surface, gap: 4 },
  // The one mint field (style guide): no shadow, just its colour.
  // The header centres the wordmark, so the back-office door floats at its
  // right edge rather than joining the column and pushing the mark off centre.
  headerAdmin: { position: 'absolute', right: spacing.md, top: spacing.md, padding: 6 },
  navItemQuiet: { opacity: 0.9 },
  header: { alignItems: 'center', paddingVertical: spacing.md, backgroundColor: colors.headerBg, borderBottomWidth: 1, borderBottomColor: colors.line },
  sideBrand: { paddingVertical: spacing.sm },
  navItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: TARGET, paddingHorizontal: spacing.sm, borderRadius: 10 },
  navItemActive: { backgroundColor: colors.accentSoft },
  navIcon: { width: 22, alignItems: 'center' },
  navLabel: { fontSize: 15, fontWeight: '600', color: colors.ink },
  content: { flex: 1 },
  banner: { padding: spacing.sm, backgroundColor: colors.accentSoft, alignItems: 'center' },
  bannerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  bannerDown: { backgroundColor: colors.overrunSoft },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.tabbar, paddingBottom: 4 },
  tab: { flex: 1, minHeight: TARGET + 10, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabText: { fontSize: 11, fontWeight: '600', color: colors.inkMuted },
  tabTextActive: { color: colors.ink },
});

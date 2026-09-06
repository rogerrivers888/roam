import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, SafeAreaView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { api, API_URL, HouseholdResponse } from './src/api';
import { colors, radius, spacing, TARGET, type } from './src/theme';
import { useTheme } from './src/hooks/useTheme';
import { getViewer, onViewerChange } from './src/viewer';
import { Avatar } from './src/components/Faces';
import { OpenTripOptions, PlanScreen } from './src/screens/PlanScreen';
import { InspireScreen } from './src/screens/InspireScreen';
import { PlacesScreen } from './src/screens/PlacesScreen';
import { TripsScreen, TripSeed } from './src/screens/TripsScreen';
import { HouseholdScreen } from './src/screens/HouseholdScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { PrototypesScreen } from './src/screens/PrototypesScreen';
import { JoinScreen } from './src/screens/JoinScreen';
import { AdminApp } from './src/admin/AdminApp';
import { useActivity } from './src/hooks/useActivity';
import { LockScreen } from './src/screens/LockScreen';
import { Wordmark } from './src/components/Wordmark';
import { useViewport, ViewportProvider } from './src/hooks/useViewport';
import { useOffline } from './src/hooks/useOffline';
import { useOutbox } from './src/hooks/useOutbox';
import { useSession } from './src/hooks/useSession';
import { Icon, IconName } from './src/components/Icon';
import { RouterProvider, rememberedAddress, useRememberedAddress, useRouter } from './src/router';
import { isFullBleed, isImmersive, legacyHref, parseRoute, paths, Route, splitHref, Tab, TripSection, tabOf, titleOf } from './src/routes';

// Roam opens on Inspire (owner, 5 Sep 2026, "Supporting docs/Roam Inspire"):
// what there is to do, with one search bar above it. The conversational planner
// is still there and still has an address — /plan, and the door at the foot
// of the search screen — it is simply no longer the first thing Roam says.
const TABS: { key: Tab; label: string; icon: IconName; href: string; owner?: true }[] = [
  { key: 'inspire', label: 'Inspire', icon: 'inspire', href: paths.inspire() },
  { key: 'places', label: 'Places', icon: 'places', href: paths.places() },
  { key: 'trips', label: 'Trips', icon: 'trips', href: paths.trips() },
  { key: 'household', label: 'Household', icon: 'household', href: paths.household() },
  { key: 'settings', label: 'Settings', icon: 'settings', href: paths.settings() },
];

// Mobile-first (V1 is the installed web app on a phone), but on a wide screen
// this is a real desktop app: navigation down the side, two-column content.
const DESKTOP = 900;

// On a wide screen the owner can flip between the two (3 Sep 2026): "Web" is the
// desktop layout at full width; "Mobile" draws the whole app inside a phone-sized
// frame so every screen shows how it will look on the phone. The choice sticks.
type ViewMode = 'web' | 'mobile';
const VIEW_KEY = 'roam.viewMode';
const PHONE = { width: 390, height: 844 };
const TOOLBAR = 44;
const BEZEL = 10;
const readViewMode = (): ViewMode =>
  Platform.OS === 'web' && typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_KEY) === 'mobile' ? 'mobile' : 'web';

/**
 * Every screen has an address, and the address is what decides which screen is
 * drawn (src/router.tsx, src/routes.ts) — so the router goes outside everything,
 * including the phone frame, the passcode and the choice of profile.
 */
export default function App() {
  return (
    <RouterProvider>
      <Frame />
    </RouterProvider>
  );
}

/**
 * The outermost box. Normally `SafeAreaView`, which keeps the app clear of the
 * notch and the home indicator; on a full-bleed screen a plain `View`, because
 * the whole point is that the map runs under both (owner, 6 Sep 2026: "all the
 * way to the edge of the screen, including the little pill in the middle of the
 * iPhone"). What must stay clear of them is the sheet and the tab bar, and each
 * of those keeps itself clear.
 */
function Edges({ children, style, bleed }: { children: React.ReactNode; style?: any; bleed?: boolean }) {
  const Box: any = bleed ? View : SafeAreaView;
  // The app draws under the status bar (index.html), so a screen that is not
  // full-bleed puts the inset back on rather than letting the wordmark sit
  // under the clock. `env()` is nought in a browser tab and only bites in the
  // installed app, which is the only place the status bar is ours to use.
  const inset = !bleed && Platform.OS === 'web'
    ? { paddingTop: 'env(safe-area-inset-top)' as any, paddingBottom: 'env(safe-area-inset-bottom)' as any }
    : null;
  return <Box style={[style, inset]}>{children}</Box>;
}

function Frame() {
  const window = useWindowDimensions();
  const [mode, setMode] = useState<ViewMode>(readViewMode);
  const choose = (m: ViewMode) => {
    setMode(m);
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.setItem(VIEW_KEY, m);
  };

  const app = <Routed />;
  // A narrow window is a phone already: no toggle, no frame.
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
 * The address, read — and the two kinds of address that are answered before
 * anything else is drawn.
 *
 * An invite link (`/join/<token>`) is somebody else's door into one trip: the
 * checklist a group organiser asked them for, and none of the household's app.
 * It is never behind the passcode, because the API treats it as public too
 * (auth.js), and it is read here so a participant never lands in Plan.
 *
 * The addresses Roam used to have (`/?tab=trips&trip=…`, `/?join=…`) are
 * answered once and replaced with the ones it has now: the owner keeps some of
 * them on his phone, and invite links went to people who have never heard of us.
 */
function Routed() {
  const { path, query, navigate } = useRouter();
  const redirect = useMemo(() => {
    const legacy = legacyHref(path, query);
    if (legacy) return legacy;
    if (path === '/' || path === '') {
      // The query travels: `/?signin=…` is a magic link, and dropping it here
      // would sign nobody in.
      const q = query.toString();
      return q ? `${paths.inspire()}?${q}` : paths.inspire();
    }
    return null;
  }, [path, query]);
  useEffect(() => { if (redirect) navigate(redirect, { replace: true }); }, [redirect, navigate]);

  const route = useMemo(() => parseRoute(path), [path]);

  // A window full of Roam is otherwise seven identical browser tabs.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.title = titleOf(route);
  }, [route]);

  if (redirect) return <View style={styles.waiting} />;
  if (route.name === 'join') return <JoinScreen token={route.token} />;
  return <Gate route={route} />;
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
function Gate({ route }: { route: Route }) {
  const { query, setQuery, navigate } = useRouter();
  const { state, isOwner, access, recheck } = useSession();
  /**
   * A magic link (?signin=<token>) is how everybody except the owner gets in.
   *
   * Read once, before anything else, and taken out of the address bar the moment
   * it has been used: a link left in the URL is a link that gets bookmarked, sent
   * on and pasted into a chat, and this one signs somebody in.
   */
  const [link] = useState(() => query.get('signin'));
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
        if (!dropped) { setQuery({ signin: null }, { replace: true }); setRedeeming(false); }
      }
    })();
    return () => { dropped = true; };
  }, [link, recheck, setQuery]);

  if (redeeming || state === 'checking') return <View style={styles.waiting} />;
  if (state === 'out' || state === 'unconfigured') {
    return <LockScreen onIn={recheck} configured={state !== 'unconfigured'} notice={linkFailed} />;
  }

  // Two applications behind one sign-in, and the address says which you are in
  // — so somebody who spent the afternoon in the back office comes back to it
  // on reload, and can send a colleague the exact screen they were looking at.
  //
  // The back office is only reachable by a session holding the `admin` door —
  // and if this app drew it anyway, every request it made would answer 404
  // (api/src/access.js).
  const mayAdminister = Boolean(access?.doors?.includes('admin'));
  if (route.name === 'admin') {
    if (!mayAdminister) return <NotHere title="That is not a page you can open" body="The back office needs an account with the admin door." href={paths.inspire()} />;
    return <AdminApp access={access} screen={route.screen} onScreen={(s) => navigate(paths.admin(s))} onLeave={() => navigate(paths.inspire())} />;
  }
  return <Shell route={route} isOwner={isOwner} mayAdminister={mayAdminister} />;
}

/** An address that is not a page — mistyped, or one Roam used to have and no longer does. */
function NotHere({ title, body, href }: { title: string; body: string; href: string }) {
  const { navigate } = useRouter();
  return (
    <SafeAreaView style={[styles.root, { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm }]}>
      <Wordmark height={40} />
      <Text style={type.h3}>{title}</Text>
      <Text style={[type.small, { textAlign: 'center' }]}>{body}</Text>
      <Pressable onPress={() => navigate(href, { replace: true })} accessibilityRole="button" style={styles.notHereBtn}>
        <Icon name="inspire" size={16} color={colors.primaryFg} />
        <Text style={{ color: colors.primaryFg, fontWeight: '700' }}>Take me home</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function Shell({ route, isOwner, mayAdminister = false }: { route: Route; isOwner: boolean; mayAdminister?: boolean }) {
  const { width } = useViewport();
  const { href, navigate } = useRouter();
  const desktop = width >= DESKTOP;
  const tab = tabOf(route);
  /**
   * A screen that draws to every edge: no mint band above it, and the tab bar
   * over it rather than under it. A trip is one, because the trip is a map now.
   */
  const fullBleed = !desktop && isFullBleed(route);
  // A screen that is all form takes the tab bar's strip too.
  const immersive = !desktop && isImmersive(route);
  /**
   * Where each tab was left (owner, 4 Sep 2026: "I come back 10 minutes later
   * after navigating off that tab, everything's disappeared").
   *
   * The tab in the rail carries that address; a typed `/places` still means the
   * atlas list. An address that quietly turned into a different page would not
   * be an address.
   *
   * Two things are left out of what is remembered: the magic-link token, which
   * must never be written down anywhere, and an open drawer, which is something
   * you were reading rather than somewhere you were.
   */
  const here = useMemo(() => {
    const { path, query } = splitHref(href);
    query.delete('signin');
    query.delete('place');
    const q = query.toString();
    return q ? `${path}?${q}` : path;
  }, [href]);
  useRememberedAddress(tab ?? 'nowhere', here);
  // The admin module is the owner's. Everybody else's app is exactly what it
  // was before accounts existed.
  const tabs = useMemo(
    () => TABS.filter((t) => !t.owner || isOwner).map((t) => ({ ...t, href: t.key === tab ? t.href : rememberedAddress(t.key, t.href) })),
    [isOwner, tab, here],
  );
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');
  const [household, setHousehold] = useState<HouseholdResponse | null>(null);
  /**
   * The place a new trip is *for* — the one somebody tapped "Create trip" on.
   *
   * This is the one thing the address deliberately does not carry. A half-filled
   * form is not a page: `/trips/new` is the form, and what somebody had typed
   * into it is theirs, not something to send to anybody. The place's name and
   * country do travel in the query, because those are the question rather than
   * the answer.
   */
  const [tripSeed, setTripSeed] = useState<TripSeed | null>(null);
  const offline = useOffline();
  const outbox = useOutbox();
  // Which screen, and that somebody is here. Two events, nothing identifying,
  // and always written against this session's own household (useActivity). The
  // tab, not the address: a trip's identifier is nobody's business but ours.
  useActivity(tab ?? 'unknown');
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

  /** Somewhere to eat is Places' question, and it arrives there already asked. */
  const openFood = () => navigate(`${paths.placesHome()}?kind=eat`);
  /**
   * Opening a trip from somewhere else — the planner's handoff, a taste table,
   * an idea — carries how Find should be set, because that is part of the page
   * being opened rather than a message passed behind the address bar.
   */
  const openTrip = (id: string, opts?: OpenTripOptions) => {
    const q = new URLSearchParams();
    if (opts?.findRadiusKm) q.set('km', String(opts.findRadiusKm));
    if (opts?.findCat) q.set('cat', opts.findCat);
    if (opts?.findPrices?.length) q.set('prices', opts.findPrices.join(','));
    const href = paths.trip(id, (opts?.section as TripSection | undefined) ?? null);
    navigate(q.toString() ? `${href}?${q}` : href);
  };

  const screen = (
    <>
      {route.name === 'inspire' ? (
        <InspireScreen
          route={route}
          household={household}
          onOpenTrip={openTrip}
          onPlanner={() => navigate(paths.plan())}
          onFood={openFood}
          onCreateTrip={({ place, seed }) => {
            setTripSeed({ place, seed, kind: 'outing' });
            navigate(`${paths.newTrip()}?kind=outing&place=${encodeURIComponent(place.label ?? seed.name)}`);
          }}
        />
      ) : null}
      {route.name === 'plan' ? <PlanScreen household={household} onOpenTrip={openTrip} /> : null}
      {route.name === 'places' ? (
        <PlacesScreen
          route={route}
          household={household}
          refreshHousehold={refreshHousehold}
          onPlanTrip={(p) => {
            setTripSeed(p);
            const q = new URLSearchParams();
            if (p.placeText) q.set('place', p.placeText);
            if (p.countryCode) q.set('country', p.countryCode);
            navigate(`${paths.newTrip()}${q.toString() ? `?${q}` : ''}`);
          }}
        />
      ) : null}
      {route.name === 'trips' ? (
        <TripsScreen
          route={route}
          household={household}
          refreshHousehold={refreshHousehold}
          seed={tripSeed}
          onSeedUsed={() => setTripSeed(null)}
        />
      ) : null}
      {route.name === 'household' ? <HouseholdScreen data={household} refresh={refreshHousehold} route={route} /> : null}
      {route.name === 'settings' ? <SettingsScreen data={household} refresh={refreshHousehold} route={route} /> : null}
      {route.name === 'prototypes' ? <PrototypesScreen route={route} /> : null}
      {route.name === 'unknown' ? (
        <NotHere
          title="There is no page at that address"
          body={`Roam has nothing at ${route.path}. It may be a link from an older version of the app, or a typo.`}
          href={paths.inspire()}
        />
      ) : null}
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
    <Edges style={styles.root} bleed={fullBleed}>
      <StatusBar style="dark" />
      <View style={desktop ? styles.desktop : styles.fill}>
        {desktop ? (
          <View style={styles.sidebar}>
            <View style={styles.sideBrand}><Wordmark height={44} ground={colors.surface} /></View>
            <Text style={[type.tiny, { marginBottom: spacing.lg }]}>Remember every place you love</Text>
            {tabs.map((t) => (
              <NavItem key={t.key} icon={t.icon} label={t.label} href={t.href} on={tab === t.key} />
            ))}
            {/* Not a tab any more, but not gone: the conversational planner, which
                Inspire's search screen also opens. Named here so it is findable. */}
            <NavItem icon="message" label="Plan" href={paths.plan()} on={tab === 'plan'} />
            {/* Desktop only: the served mock-up pages, for review — not part of the phone app. */}
            <NavItem icon="list" label="Prototypes" href={tab === 'prototypes' ? paths.prototypes() : rememberedAddress('prototypes', paths.prototypes())} on={tab === 'prototypes'} />
            <View style={{ flex: 1 }} />
            {/* The other application, for whoever holds its door. Named rather
                than hidden behind an icon: switching profile is a deliberate act. */}
            {mayAdminister ? <NavItem icon="accounts" label="Back office" href={paths.admin('overview')} on={false} quiet /> : null}
            {/* The corner is who you are and how the app looks — not the API's address (owner, 4 Sep 2026). */}
            <You household={household} onOpen={() => navigate(paths.settings())} />
          </View>
        ) : fullBleed ? null : (
          <View style={styles.header}>
            <Wordmark height={34} />
            {mayAdminister ? (
              <Pressable onPress={() => navigate(paths.admin('overview'))} style={styles.headerAdmin} accessibilityRole="link" accessibilityLabel="Back office">
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
        {!desktop && !immersive ? (
          // On a full-bleed screen the tab bar floats over the map instead of
          // taking a strip off the bottom of it, so the map really does reach
          // every edge (owner, 6 Sep 2026).
          <View style={[styles.tabs, fullBleed && styles.tabsOver]} accessibilityRole="tablist">
            {tabs.map((t) => (
              <Pressable key={t.key} onPress={() => navigate(t.href)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}>
                <Icon name={t.icon} size={20} color={tab === t.key ? colors.ink : colors.inkMuted} />
                <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </Edges>
  );
}

/** One line of the rail. It carries an address rather than a screen name. */
function NavItem({ icon, label, href, on, quiet }: { icon: IconName; label: string; href: string; on: boolean; quiet?: boolean }) {
  const { navigate } = useRouter();
  return (
    <Pressable
      onPress={() => navigate(href)}
      style={[styles.navItem, on && styles.navItemActive, quiet && styles.navItemQuiet]}
      accessibilityRole={quiet ? 'button' : 'tab'}
      accessibilityState={{ selected: on }}
    >
      <View style={styles.navIcon}><Icon name={icon} size={18} color={on ? colors.ink : colors.inkMuted} /></View>
      <Text style={[styles.navLabel, on && { color: colors.ink }]}>{label}</Text>
    </Pressable>
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
  notHereBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md, paddingHorizontal: spacing.lg, minHeight: TARGET, borderRadius: radius.md, backgroundColor: colors.primary, justifyContent: 'center' },
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
  // Floating over the map, and clear of the home indicator on a phone that has
  // one — the map runs under the indicator, the labels must not.
  tabsOver: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingBottom: (Platform.OS === 'web' ? 'calc(4px + env(safe-area-inset-bottom))' : 20) as any,
  },
  tab: { flex: 1, minHeight: TARGET + 10, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabText: { fontSize: 11, fontWeight: '600', color: colors.inkMuted },
  tabTextActive: { color: colors.ink },
});

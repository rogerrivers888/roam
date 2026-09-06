/**
 * The sheet over the map.
 *
 * The owner, 6 Sep 2026: "we'll have a bottom-side drawer that you can swipe up
 * to see more of the drawer, or swipe down to have it in 3 states: minimised,
 * medium, and full… If I swipe up on the top bit, it should make the drawer
 * bigger. If I swipe in the middle bit, it should scroll the list."
 *
 * Three detents, from the handoff: **peek** (the header only), **half**, and
 * **full**. The animation is the easy half; the gesture routing is the job, and
 * it is three rules:
 *
 *   1. A drag that starts on the grabber or the header always moves the sheet.
 *   2. A drag that starts in the body scrolls the list — *except* at the two
 *      edges of the list, where it hands the gesture back to the sheet:
 *        · dragging down while the list is already at the top collapses a detent
 *        · dragging up below `full` raises a detent before the list moves
 *      Without that handoff the list rubber-bands against a sheet that will not
 *      move, which is the thing that makes a sheet feel broken.
 *   3. A drag that never travels far enough is a tap, and a tap on the grabber
 *      cycles the detents — because a swipe with no tap equivalent is a control
 *      some people cannot use at all.
 *
 * Three implementation notes, each of which is the difference between working
 * and feeling right:
 *
 * **It translates; it does not resize.** The sheet is always full height and
 * moves on `translateY`. Animating `height` re-lays-out every row in the list
 * on every frame, which a forty-row list cannot do at sixty a second. A
 * transform is composited and costs nothing.
 *
 * **It is in the tree, not a `Modal`.** `SideSheet` and `VenueDrawer` portal out
 * and then have to pin themselves back to the phone frame by hand (CLAUDE.md).
 * A sheet that lives over the map never leaves the screen it belongs to, so it
 * gets the frame for free and cannot escape it.
 *
 * **On the web the drag is listened for on the window, not on the sheet.** This
 * was found rather than chosen. A drag upward leaves the sheet within a few
 * pixels and crosses the map; MapLibre's canvas and react-native-web's own
 * `Pressable` each take the pointer for themselves on the way, and a listener
 * bound to the sheet stops hearing about the very gesture it started — the
 * sheet would collapse happily and refuse to open. So the sheet hears the
 * pointer *down* on itself and everything after that on the window. Native
 * keeps `PanResponder`, where no such thing happens.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { colors, spacing } from '../theme';
import { detentHeights, type Detent } from './detents';

export { DETENTS, detentHeights } from './detents';
export type { Detent } from './detents';

/** A drag shorter than this is a tap, not a swipe. */
const TAP_SLOP = 6;
/** Past this much of the way to the next detent, the sheet goes there rather than back. */
const COMMIT_FRACTION = 0.3;
/** A flick beats distance: throw it and it goes, however short the throw. */
const FLICK_VELOCITY = 0.4;

const isWeb = Platform.OS === 'web';

export function BottomSheet({ detent, onDetent, header, children, screenHeight, insetBottom = 0 }: {
  detent: Detent;
  onDetent: (d: Detent) => void;
  /** Always visible, at every detent, and the place a drag always moves the sheet. */
  header: React.ReactNode;
  /** The scrolling body. Only reachable at `half` and `full`. */
  children: React.ReactNode;
  screenHeight: number;
  insetBottom?: number;
}) {
  const heights = useMemo(() => detentHeights(screenHeight, insetBottom), [screenHeight, insetBottom]);
  const height = heights.full;

  // The sheet is always `full` tall and slid down to show less of itself, so
  // nothing re-lays-out when it moves.
  const offsetFor = useCallback((d: Detent) => height - heights[d], [height, heights]);
  const y = useRef(new Animated.Value(offsetFor(detent))).current;
  const at = useRef(detent);
  at.current = detent;

  // Where the list is scrolled to, which decides whether a downward drag in the
  // body belongs to the list or to the sheet.
  const scrollTop = useRef(0);
  const startOffset = useRef(0);

  const onDetentRef = useRef(onDetent);
  onDetentRef.current = onDetent;

  const settle = useCallback((d: Detent, velocity = 0) => {
    Animated.spring(y, {
      toValue: offsetFor(d),
      useNativeDriver: !isWeb,
      velocity,
      damping: 30, stiffness: 240, mass: 0.85,
      overshootClamping: true,
    }).start();
    if (d !== at.current) onDetentRef.current(d);
  }, [offsetFor, y]);

  // The address, or anything else, moved the detent: follow it.
  useEffect(() => { settle(detent); }, [detent, settle]);
  // The window resized (the Web / Mobile toggle): the same detent, a new offset.
  useEffect(() => { y.setValue(offsetFor(at.current)); }, [height, heights.half, offsetFor, y]);

  /** Which detent a released drag lands on. One step at a time, never two. */
  const nearest = useCallback((dy: number, vy: number): Detent => {
    const order: Detent[] = ['full', 'half', 'peek'];
    const from = at.current;
    const i = order.indexOf(from);
    const step = (dir: 1 | -1) => order[Math.min(order.length - 1, Math.max(0, i + dir))];
    if (Math.abs(vy) > FLICK_VELOCITY) return step(vy > 0 ? 1 : -1);
    const next = step(dy > 0 ? 1 : -1);
    const travel = Math.abs(offsetFor(next) - offsetFor(from));
    return travel > 0 && Math.abs(dy) > travel * COMMIT_FRACTION ? next : from;
  }, [offsetFor]);

  /** Is this drag the sheet's, or does it belong to the list under the finger? */
  const mine = useCallback((dy: number, dx: number, fromHeader: boolean) => {
    if (Math.abs(dy) < TAP_SLOP || Math.abs(dy) < Math.abs(dx)) return false;
    if (fromHeader) return true;
    if (dy > 0) return scrollTop.current <= 0;
    return at.current !== 'full';
  }, []);

  // --- web: the drag ------------------------------------------------------
  const headerRef = useRef<any>(null);
  const bodyRef = useRef<any>(null);
  /**
   * The drag in progress. A ref rather than variables inside the effect,
   * because the sheet re-renders while a finger is down — a fetch lands, a pin
   * is selected — and a drag whose state lived in the effect's closure would be
   * thrown away halfway through by the re-attach.
   */
  const drag = useRef({
    from: null as 'header' | 'body' | null, decided: false, taken: false,
    startY: 0, startX: 0, lastY: 0, lastT: 0, vy: 0,
    /**
     * When a drag last ended. A drag that begins on the grabber ends with
     * `Pressable` calling `onPress` anyway — react-native-web counts a
     * pointerup as a press however far the pointer travelled — so the tap
     * handler would undo every drag that started there. The tap ignores a press
     * that arrives on the heels of a drag.
     */
    endedAt: 0,
  });
  // The handlers are attached once and read the current logic through a ref, so
  // nothing about a re-render can interrupt a gesture.
  const fns = useRef({ mine, nearest, offsetFor, settle });
  fns.current = { mine, nearest, offsetFor, settle };

  useEffect(() => {
    if (!isWeb) return;
    /**
     * The whole gesture is listened for on the window, from the first touch to
     * the last.
     *
     * Every narrower attachment was tried and each fails in its own way, which
     * is worth writing down so it is not tried again: react-native-web's
     * `Pressable` (the grabber) and `ScrollView` (the body) both claim the
     * pointer the instant it lands on them, so a listener on the sheet never
     * hears the moves; and a drag upward leaves the sheet within a few pixels
     * and crosses MapLibre's canvas, which claims it for its own panning. The
     * window hears all of it and hears it first, and `composedPath` says where
     * the gesture began — which is the only thing the sheet needed from the
     * element in the first place.
     */
    const where = (e: PointerEvent): 'header' | 'body' | null => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const inside = (node: any) => !!node && (path.includes(node) || (e.target instanceof Node && node.contains?.(e.target)));
      if (inside(headerRef.current)) return 'header';
      if (inside(bodyRef.current)) return 'body';
      return null;
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const d = drag.current;
      d.from = where(e); d.decided = false; d.taken = false;
      d.startY = e.clientY; d.startX = e.clientX; d.lastY = e.clientY; d.lastT = e.timeStamp; d.vy = 0;
    };

    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d.from) return;
      const dy = e.clientY - d.startY;
      if (!d.decided) {
        if (Math.abs(dy) < TAP_SLOP && Math.abs(e.clientX - d.startX) < TAP_SLOP) return;
        d.decided = true;
        d.taken = fns.current.mine(dy, e.clientX - d.startX, d.from === 'header');
        if (!d.taken) { d.from = null; return; }
        startOffset.current = fns.current.offsetFor(at.current);
        y.stopAnimation();
      }
      if (e.cancelable) e.preventDefault();
      const dt = Math.max(1, e.timeStamp - d.lastT);
      d.vy = (e.clientY - d.lastY) / dt;
      d.lastY = e.clientY; d.lastT = e.timeStamp;
      const o = fns.current.offsetFor;
      y.setValue(Math.min(o('peek'), Math.max(o('full'), startOffset.current + dy)));
    };

    const up = (e: PointerEvent) => {
      const d = drag.current;
      if (!d.from) return;
      const dy = e.clientY - d.startY;
      const was = d.taken;
      const gap = e.timeStamp - d.lastT;
      const vy = d.vy;
      d.from = null; d.decided = false; d.taken = false;
      if (!was) return;
      d.endedAt = Date.now();
      // A stale velocity from a finger that paused before letting go would
      // fling a sheet nobody flung.
      const fresh = gap < 140 ? vy : 0;
      fns.current.settle(Math.abs(dy) < TAP_SLOP ? at.current : fns.current.nearest(dy, fresh), fresh);
    };

    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [y]);

  // The browser must not claim a vertical drag on the header for its own
  // scrolling before the first move is ever seen.
  useEffect(() => {
    const zone = headerRef.current as HTMLElement | null;
    if (isWeb && zone?.style) zone.style.touchAction = 'none';
  });

  // --- native: the responder system ---------------------------------------
  const responder = useMemo(() => {
    if (isWeb) return { header: {}, body: {} };
    const make = (fromHeader: boolean) => PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (_e, g) => mine(g.dy, g.dx, fromHeader),
      onMoveShouldSetPanResponder: (_e, g) => mine(g.dy, g.dx, fromHeader),
      onPanResponderGrant: () => { startOffset.current = offsetFor(at.current); y.stopAnimation(); },
      onPanResponderMove: (_e, g) => y.setValue(Math.min(offsetFor('peek'), Math.max(offsetFor('full'), startOffset.current + g.dy))),
      onPanResponderRelease: (_e, g) => settle(Math.abs(g.dy) < TAP_SLOP ? at.current : nearest(g.dy, g.vy), g.vy),
      onPanResponderTerminate: () => settle(at.current),
    }).panHandlers;
    return { header: make(true), body: make(false) };
  }, [mine, nearest, offsetFor, settle, y]);

  /** The tap equivalent: the grabber walks up to full, then back down to peek. */
  const up = useRef(true);
  const cycle = () => {
    // The tail of a drag, not a tap. See `endedAt`.
    if (Date.now() - drag.current.endedAt < 400) return;
    const order: Detent[] = ['peek', 'half', 'full'];
    const i = order.indexOf(at.current);
    if (i === order.length - 1) up.current = false;
    if (i === 0) up.current = true;
    settle(order[Math.min(order.length - 1, Math.max(0, i + (up.current ? 1 : -1)))]);
  };

  return (
    <Animated.View style={[styles.sheet, { height, bottom: insetBottom, transform: [{ translateY: y }] }]}>
      <View ref={headerRef} {...responder.header} style={styles.headerZone}>
        <Pressable
          onPress={cycle}
          accessibilityRole="button"
          accessibilityLabel={`Sheet, ${detent}. Tap to ${detent === 'full' ? 'shrink' : 'expand'}.`}
          style={styles.grabHit}
        >
          <View style={styles.grab} />
        </Pressable>
        {header}
      </View>
      <View ref={bodyRef} style={{ flex: 1, minHeight: 0 }} {...responder.body}>
        <ScrollView
          scrollEnabled={detent !== 'peek'}
          onScroll={(e) => { scrollTop.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: spacing.xl }}
        >
          {children}
        </ScrollView>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    // The handoff's shadow: 0 -6px 24px rgba(32,30,29,0.14).
    shadowColor: '#201E1D', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.14, shadowRadius: 24, elevation: 16,
    zIndex: 2,
    overflow: 'hidden',
  },
  headerZone: { paddingBottom: 2 },
  // The grabber is 40×4, and its hit area is the 44 the rest of the app uses.
  grabHit: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 24 },
  grab: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line },
});

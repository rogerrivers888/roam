/**
 * The back office — the second of Roam's two profiles.
 *
 * The owner, 4 Sep 2026: "in the Roam desktop app we need to have 2 profiles:
 * web client, web admin, which has all the admin stuff". So this is a whole
 * application rather than a tab: its own rail, its own screens, and a way back
 * to the household app that says which one you are in.
 *
 * It is drawn only for a session holding the `admin` door, and every nav item is
 * hidden unless the capability behind it is held — but neither of those is the
 * security boundary. The API answers 404 to a session without the door and 403
 * to one without the capability, whatever the app chooses to draw (access.js).
 *
 * The rail is Parcelvision's arrangement: navigation down the side on a wide
 * screen, and on a phone the same list becomes a scrolling row of chips —
 * because a back office on a phone is somebody checking one number on a train,
 * not doing a day's work.
 */

import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Access } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Icon, IconName } from '../components/Icon';
import { Wordmark } from '../components/Wordmark';
import { useViewport } from '../hooks/useViewport';
import { useActivity } from '../hooks/useActivity';
import { AccountsScreen } from '../screens/AccountsScreen';
import { Overview } from './screens/Overview';
import { People } from './screens/People';
import { Activity } from './screens/Activity';
import { Reporting } from './screens/Reporting';
import { Audit, Plans, Roles } from './screens/Governance';
import { Library } from './screens/Library';
import { Scout } from './screens/Scout';
import { Shelves } from './screens/Shelves';

const DESKTOP = 900;

type Screen = 'overview' | 'accounts' | 'households' | 'activity' | 'reporting' | 'library' | 'shelves' | 'scout' | 'roles' | 'plans' | 'audit';

/**
 * The rail.
 *
 * `needs` is the capability that makes an item worth drawing. The owner holds
 * everything, so he sees all of it; a support account sees four items and does
 * not have to wonder what the other four would have said.
 */
const NAV: { key: Screen; label: string; icon: IconName; needs?: string; sub: string }[] = [
  { key: 'overview', label: 'Overview', icon: 'plan', sub: 'The estate at a glance' },
  { key: 'accounts', label: 'Accounts', icon: 'accounts', needs: 'view_accounts', sub: 'Invite people and manage their plan' },
  { key: 'households', label: 'Households', icon: 'household', needs: 'view_accounts', sub: 'What each one does, and what it costs' },
  { key: 'activity', label: 'Activity', icon: 'list', needs: 'view_activity', sub: 'Everything that has happened' },
  { key: 'reporting', label: 'Reporting', icon: 'places', needs: 'view_reporting', sub: 'Engagement, revenue and usage' },
  { key: 'library', label: 'Atlas', icon: 'owned', needs: 'view_library', sub: 'Attractions by county, and the pictures we own' },
  { key: 'shelves', label: 'Shelves', icon: 'themePark', needs: 'view_library', sub: 'What the home screen calls a place, and how to teach it' },
  { key: 'scout', label: 'The sweep', icon: 'search', needs: 'view_library', sub: 'Postcode areas, their best restaurants and their menus' },
  { key: 'roles', label: 'Roles', icon: 'locked', needs: 'view_accounts', sub: 'Doors and capabilities' },
  { key: 'plans', label: 'Plans', icon: 'money', needs: 'view_accounts', sub: 'What a household can be on' },
  { key: 'audit', label: 'Audit', icon: 'info', needs: 'view_audit', sub: 'Who did what to whom' },
];

export function AdminApp({ access, onLeave }: { access: Access | null; onLeave: () => void }) {
  const { width } = useViewport();
  const desktop = width >= DESKTOP;
  const [screen, setScreen] = useState<Screen>('overview');

  const held = useMemo(() => new Set(access?.capabilities ?? []), [access]);
  const items = NAV.filter((n) => !n.needs || held.has(n.needs));
  const can = (c: string) => held.has(c);

  // The back office reports its own use like every other screen: an
  // administrator's time is activity too, and leaving it out would make the
  // estate's own numbers quietly wrong.
  useActivity(`admin.${screen}`);

  const current = items.find((n) => n.key === screen) ?? items[0];

  const body = (
    <>
      {screen === 'overview' ? <Overview /> : null}
      {screen === 'accounts' ? <AccountsScreen /> : null}
      {screen === 'households' ? <People canManageRoles={can('manage_roles')} /> : null}
      {screen === 'activity' ? <Activity /> : null}
      {screen === 'reporting' ? <Reporting canSeeMoney={can('view_financials')} /> : null}
      {screen === 'library' ? <Library canManage={can('manage_library')} /> : null}
      {screen === 'shelves' ? <Shelves canManage={can('manage_library')} /> : null}
      {screen === 'scout' ? <Scout canManage={can('manage_library')} /> : null}
      {screen === 'roles' ? <Roles canManage={can('manage_roles')} /> : null}
      {screen === 'plans' ? <Plans canManage={can('manage_plans')} /> : null}
      {screen === 'audit' ? <Audit /> : null}
    </>
  );

  return (
    // A row on a wide screen (rail beside the page), a column on a phone (a
    // strip of chips above it). One tree either way, so switching the shell's
    // Web/Mobile toggle keeps the screen you were on (CLAUDE.md).
    <View style={[styles.root, !desktop && styles.rootPhone]}>
      {desktop ? (
        <View style={styles.rail}>
          <View style={styles.brand}>
            <Wordmark height={34} ground={colors.surface} />
            <Text style={styles.badge}>Back office</Text>
          </View>

          {items.map((n) => (
            <Pressable
              key={n.key}
              onPress={() => setScreen(n.key)}
              style={[styles.navItem, screen === n.key && styles.navItemOn]}
              accessibilityRole="tab"
              accessibilityState={{ selected: screen === n.key }}
            >
              <Icon name={n.icon} size={17} color={screen === n.key ? colors.ink : colors.inkMuted} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.navLabel, screen === n.key && { color: colors.ink, fontWeight: '700' }]}>{n.label}</Text>
              </View>
            </Pressable>
          ))}

          <View style={{ flex: 1 }} />

          {/* Which profile you are in, and the way back. Never a silent switch:
              the two applications hold the same account and different powers. */}
          <View style={styles.profile}>
            <Text style={type.tiny}>Signed in as</Text>
            <Text style={[type.small, { color: colors.ink, fontWeight: '700' }]}>{access?.role?.label ?? 'Owner'}</Text>
            <Pressable onPress={onLeave} style={styles.leave} accessibilityRole="button">
              <Icon name="back" size={14} color={colors.ink} />
              <Text style={[type.small, { color: colors.ink }]}>The household app</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.phoneHead}>
          <View style={styles.phoneHeadTop}>
            <Text style={styles.badge}>Back office</Text>
            <Pressable onPress={onLeave} accessibilityRole="button" style={styles.leaveSmall}>
              <Icon name="back" size={13} color={colors.ink} />
              <Text style={type.tiny}>The app</Text>
            </Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {items.map((n) => (
              <Pressable
                key={n.key}
                onPress={() => setScreen(n.key)}
                style={[styles.chip, screen === n.key && styles.chipOn]}
                accessibilityRole="tab"
                accessibilityState={{ selected: screen === n.key }}
              >
                <Icon name={n.icon} size={13} color={screen === n.key ? colors.primaryFg : colors.inkMuted} />
                <Text style={[type.tiny, screen === n.key && { color: colors.primaryFg, fontWeight: '700' }]}>{n.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      <View style={styles.content}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: colors.bg },
  content: { flex: 1 },

  rail: {
    width: 208, backgroundColor: colors.surface, borderRightWidth: 1, borderRightColor: colors.line,
    paddingVertical: spacing.lg, paddingHorizontal: spacing.md, gap: 2,
  },
  brand: { gap: 4, marginBottom: spacing.lg },
  badge: {
    ...type.tiny, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '700',
    color: colors.inkMuted,
  },
  navItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 9, paddingHorizontal: spacing.sm, borderRadius: radius.md },
  navItemOn: { backgroundColor: colors.well },
  navLabel: { ...type.small, color: colors.inkMuted },

  profile: { gap: 2, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.line },
  leave: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm },

  rootPhone: { flexDirection: 'column' },
  phoneHead: {
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line,
    paddingTop: Platform.OS === 'web' ? spacing.sm : spacing.lg, gap: 6,
  },
  phoneHeadTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md },
  leaveSmall: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chips: { gap: 6, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.line, paddingHorizontal: 10, paddingVertical: 5,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
});

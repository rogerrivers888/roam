import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, memberColor, memberPastel, radius, spacing, TARGET, type } from '../theme';
import { Chip, FoldLine, Row } from './ui';
import { Icon } from './Icon';

export type Face = { id: string; name: string; isMinor?: boolean; avatarUrl?: string | null };

/**
 * People are the explanation (research §11). Faces appear wherever a
 * constraint or a reason is attributed to someone.
 */
export function Avatar({ name, index, size = 36, dim, url, pastel }: {
  name: string; index: number; size?: number; dim?: boolean; url?: string | null;
  /** The Hotels 2 §12 face: pastel fill, ink initial, 2px ink ring. */
  pastel?: boolean;
}) {
  const base = { width: size, height: size, borderRadius: size / 2, opacity: dim ? 0.35 : 1 };
  if (url) return <Image source={{ uri: url }} style={base} accessibilityLabel={name} />;
  return (
    <View
      style={[
        base,
        { alignItems: 'center', justifyContent: 'center' },
        pastel
          ? { backgroundColor: memberPastel(index), borderWidth: 2, borderColor: colors.ink }
          : { backgroundColor: memberColor(index) },
      ]}
      accessibilityLabel={name}
    >
      <Text style={{ color: pastel ? colors.ink : '#fff', fontFamily: fonts.heading, fontWeight: '800', fontSize: size * 0.37 }}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/** "Who's coming?" — a face row with toggles, never a settings screen. */
export function FaceRow({
  members,
  attending,
  onToggle,
}: {
  members: Face[];
  attending: Set<string>;
  onToggle?: (id: string) => void;
}) {
  return (
    <View style={styles.row}>
      {members.map((m, i) => {
        const on = attending.has(m.id);
        return (
          <Pressable
            key={m.id}
            onPress={onToggle ? () => onToggle(m.id) : undefined}
            style={styles.face}
            accessibilityRole="switch"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${m.name} ${on ? 'coming' : 'not coming'}`}
          >
            <Avatar name={m.name} index={i} size={40} dim={!on} url={m.avatarUrl} />
            <Text style={[type.tiny, { color: on ? colors.ink : colors.inkFaint }]}>
              {m.name}{m.isMinor ? ' ·' : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "Roger" from "Roger Sumner-Rivers": a family calls each other by one name. */
export const firstName = (n: string) => n.split(/\s+/)[0];

/** A group the household has organised before, offered again (Group Trips v2, Epic 1). */
export type PastGroup = { id: string; name: string | null; joined: number };

/**
 * Who's coming, on one line — "The family" until somebody is left out — opening
 * into a tick per person. The Plan screen's control, used wherever a form asks
 * the same question, so a new trip is not a wall of faces (owner, 4 Sep 2026).
 *
 * A group is one of the answers to it (Group Trips v2, Epic 1): a group trip is
 * not a kind of trip you go and find, it is who is coming. When `onGroup` is
 * given the row carries a Group button and the open state offers Just me, The
 * family and A group, with any group already organised offered again.
 */
export function WhoLine({ members, attending, onToggle, onGroup, groups, onUseGroup }: {
  members: Face[];
  /** Nobody named yet means everybody. */
  attending: Set<string> | null;
  onToggle: (id: string) => void;
  /** Set up a group for this trip. Its presence is what turns the row into Epic 1's row. */
  onGroup?: () => void;
  groups?: PastGroup[];
  onUseGroup?: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  if (members.length < 2 && !onGroup) return null;
  const all = !attending || attending.size === members.length;
  const chosen = members.filter((m) => !attending || attending.has(m.id));
  const solo = members.length < 2;
  const value = solo ? 'Just me' : all ? 'The family' : chosen.map((m) => firstName(m.name)).join(', ') || 'Nobody yet';

  const ticks = (
    <Row style={{ flexWrap: 'wrap', gap: 6 }}>
      {members.map((m) => {
        const on = !attending || attending.has(m.id);
        return <Chip key={m.id} label={firstName(m.name)} icon={on ? 'check' : undefined} selected={on} onPress={() => onToggle(m.id)} />;
      })}
    </Row>
  );

  if (!onGroup) return <FoldLine label="Who's coming" value={value}>{ticks}</FoldLine>;

  return (
    <View>
      <Row style={styles.whoRow}>
        <Pressable onPress={() => setOpen((o) => !o)} style={styles.whoTap} accessibilityRole="button" accessibilityLabel="Who's coming" accessibilityState={{ expanded: open }}>
          <Icon name="household" size={14} color={colors.inkMuted} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={type.tiny}>Who's coming</Text>
            <Row>
              {chosen.slice(0, 4).map((m, i) => <Avatar key={m.id} name={m.name} index={i} size={22} url={m.avatarUrl} pastel />)}
              <Text style={[type.small, { fontWeight: '600', color: colors.ink }]} numberOfLines={1}>{value}</Text>
              <Icon name={open ? 'collapse' : 'expand'} size={14} color={colors.inkMuted} />
            </Row>
          </View>
        </Pressable>
        <Chip label="Group" icon="household" onPress={onGroup} />
      </Row>

      {open ? (
        <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
          {!solo ? (
            <>
              <Pressable onPress={() => members.forEach((m) => { if (!attending || attending.has(m.id)) onToggle(m.id); })} style={styles.whoTile} accessibilityRole="button">
                <Text style={type.h3}>Just me</Text>
                <Text style={type.small}>A trip for one.</Text>
              </Pressable>
              <View style={[styles.whoTile, all && styles.whoTileOn]}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={type.h3}>The family</Text>
                  {all ? <Icon name="check" size={16} /> : null}
                </Row>
                <Text style={type.small}>Everyone at home. Untick anyone staying behind.</Text>
              </View>
              {ticks}
            </>
          ) : null}

          <Pressable onPress={onGroup} style={styles.whoTile} accessibilityRole="button">
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.h3}>A group</Text>
                <Text style={type.small}>Two friends or a coachload. Everyone books and pays their own share; Roam chases them for you.</Text>
              </View>
              <Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>Set up →</Text>
            </Row>
          </Pressable>

          {groups?.length ? (
            <View style={{ gap: 4 }}>
              <Text style={type.tiny}>YOUR GROUPS</Text>
              {groups.map((g) => (
                <Row key={g.id} style={{ justifyContent: 'space-between' }}>
                  <Row style={{ flex: 1 }}>
                    <Icon name="household" size={15} color={colors.icon} />
                    <Text style={[type.small, { color: colors.ink }]} numberOfLines={1}>{g.name ?? 'A group'} · {g.joined} in</Text>
                  </Row>
                  <Pressable onPress={() => onUseGroup?.(g.id)} accessibilityRole="button">
                    <Text style={[type.small, { color: colors.accent, fontWeight: '700' }]}>Use again</Text>
                  </Pressable>
                </Row>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  face: { alignItems: 'center', gap: 3, minWidth: TARGET, minHeight: TARGET },
  whoRow: { minHeight: TARGET, alignItems: 'center' },
  whoTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: TARGET },
  whoTile: { gap: 2, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  whoTileOn: { borderColor: colors.ink, borderWidth: 2 },
});

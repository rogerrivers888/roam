import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, memberColor, TARGET, type } from '../theme';
import { Chip, FoldLine, Row } from './ui';

export type Face = { id: string; name: string; isMinor?: boolean; avatarUrl?: string | null };

/**
 * People are the explanation (research §11). Faces appear wherever a
 * constraint or a reason is attributed to someone.
 */
export function Avatar({ name, index, size = 36, dim, url }: { name: string; index: number; size?: number; dim?: boolean; url?: string | null }) {
  const base = { width: size, height: size, borderRadius: size / 2, opacity: dim ? 0.35 : 1 };
  if (url) return <Image source={{ uri: url }} style={base} accessibilityLabel={name} />;
  return (
    <View style={[base, { backgroundColor: memberColor(index), alignItems: 'center', justifyContent: 'center' }]} accessibilityLabel={name}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.42 }}>{name.slice(0, 1).toUpperCase()}</Text>
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

/**
 * Who's coming, on one line — "The family" until somebody is left out — opening
 * into a tick per person. The Plan screen's control, used wherever a form asks
 * the same question, so a new trip is not a wall of faces (owner, 4 Sep 2026).
 */
export function WhoLine({ members, attending, onToggle }: {
  members: Face[];
  /** Nobody named yet means everybody. */
  attending: Set<string> | null;
  onToggle: (id: string) => void;
}) {
  if (members.length < 2) return null;
  const all = !attending || attending.size === members.length;
  const chosen = members.filter((m) => !attending || attending.has(m.id));
  const value = all ? 'The family' : chosen.map((m) => firstName(m.name)).join(', ') || 'Nobody yet';
  return (
    <FoldLine label="Who's coming" value={value}>
      <Row style={{ flexWrap: 'wrap', gap: 6 }}>
        {members.map((m) => {
          const on = !attending || attending.has(m.id);
          return <Chip key={m.id} label={firstName(m.name)} icon={on ? 'check' : undefined} selected={on} onPress={() => onToggle(m.id)} />;
        })}
      </Row>
    </FoldLine>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  face: { alignItems: 'center', gap: 3, minWidth: TARGET, minHeight: TARGET },
});

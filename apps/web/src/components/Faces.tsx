import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, memberColor, TARGET, type } from '../theme';

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

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  face: { alignItems: 'center', gap: 3, minWidth: TARGET, minHeight: TARGET },
});

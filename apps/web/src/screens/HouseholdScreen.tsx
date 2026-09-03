import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { api, Constraint, HouseholdResponse, Learned, Member, Suggestion } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, Wrap } from '../components/ui';
import { Avatar } from '../components/Faces';
import { SuggestInput } from '../components/SuggestInput';

const FOOD_KINDS = ['dish', 'cuisine'];
const ACTIVITY_KINDS = ['experience'];
const DIET_KINDS = ['diet'];
const RELATIONSHIP_LABEL: Record<string, string> = { parent: 'Parent', partner: 'Partner', child: 'Child', grandparent: 'Grandparent', sibling: 'Sibling', friend: 'Friend', other: 'Other' };

export function HouseholdScreen({ data, refresh }: { data: HouseholdResponse | null; refresh: () => Promise<void> }) {
  const { width } = useWindowDimensions();
  const twoCol = width >= 1000;
  const [newName, setNewName] = useState('');
  const [newRel, setNewRel] = useState<string>('child');
  const [newYear, setNewYear] = useState('');

  if (!data) return <View style={styles.page}><Text style={type.small}>Loading household…</Text></View>;
  const { household, members, learned, vocabulary } = data;
  const adult = members.find((m) => !m.isMinor);

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View>
        <Text style={type.title}>{household.name}</Text>
        <Text style={type.small}>Who's in the family and what each person will and won't eat or do. Allergens exclude places; diets, likes and dislikes only rank them.</Text>
      </View>

      <View style={[styles.grid, twoCol && { flexDirection: 'row', flexWrap: 'wrap' }]}>
        {members.map((m, i) => (
          <View key={m.id} style={twoCol ? { width: '49%' } : undefined}>
            <MemberCard member={m} index={i} managedBy={m.isMinor ? adult?.name : undefined} relationships={vocabulary.relationships} allergens={vocabulary.allergens} learned={learned.filter((l) => l.memberId === m.id)} refresh={refresh} />
          </View>
        ))}
        <View style={twoCol ? { width: '49%' } : undefined}>
          <Card>
            <Text style={type.h3}>Add someone</Text>
            <TextInput value={newName} onChangeText={setNewName} placeholder="Name" placeholderTextColor={colors.inkFaint} style={styles.input} />
            <Text style={type.tiny}>Relationship to the household</Text>
            <Wrap>{Object.entries(RELATIONSHIP_LABEL).map(([k, l]) => <Chip key={k} label={l} selected={newRel === k} onPress={() => setNewRel(k)} />)}</Wrap>
            <Row>
              <Text style={[type.small, { flex: 1 }]}>Birth year (optional)</Text>
              <TextInput value={newYear} onChangeText={setNewYear} placeholder="e.g. 2015" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 0, width: 120 }]} keyboardType="number-pad" />
            </Row>
            <Text style={type.tiny}>A child under 13 gets a full profile owned by an adult — no login, no voice capture.</Text>
            <Button label="Add" disabled={!newName.trim()} onPress={async () => {
              await api.addMember({ name: newName.trim(), relationship: newRel, birthYear: newYear ? Number(newYear) : null });
              setNewName(''); setNewYear('');
              await refresh();
            }} />
          </Card>
        </View>
      </View>
    </ScrollView>
  );
}

async function pickPhoto(): Promise<string | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted && Platform.OS !== 'web') return null;
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.9 });
  if (res.canceled || !res.assets?.[0]) return null;
  const ctx = ImageManipulator.ImageManipulator.manipulate(res.assets[0].uri);
  ctx.resize({ width: 256, height: 256 });
  const rendered = await ctx.renderAsync();
  const saved = await rendered.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.75, base64: true });
  return saved.base64 ? `data:image/jpeg;base64,${saved.base64}` : null;
}

function MemberCard({ member, index, managedBy, relationships, allergens, learned, refresh }: {
  member: Member; index: number; managedBy?: string; relationships: string[]; allergens: string[]; learned: Learned[]; refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [year, setYear] = useState(member.birthYear ? String(member.birthYear) : '');
  const [section, setSection] = useState<'food' | 'activities'>('food');
  const [pending, setPending] = useState<Suggestion[] | null>(null);

  const add = async (kind: Constraint['kind'], value: string, conceptKey?: string) => {
    const r = await api.addConstraint(member.id, { kind, value, conceptKey });
    setPending(!r.resolved && r.suggestions.length ? r.suggestions : null);
    await refresh();
  };
  const remove = async (c: Constraint) => { await api.deleteConstraint(c.id); await refresh(); };
  const save = async () => {
    await api.updateMember(member.id, { name: name.trim() || member.name, birthYear: year ? Number(year) : null });
    setEditing(false);
    await refresh();
  };

  const isActivity = (c: Constraint) => c.conceptKind === 'experience';
  const foodLikes = member.likes.filter((c) => !isActivity(c));
  const foodDislikes = member.dislikes.filter((c) => !isActivity(c));
  const actLikes = member.likes.filter(isActivity);
  const actDislikes = member.dislikes.filter(isActivity);
  const learnedFood = learned.filter((l) => l.conceptKind !== 'experience');
  const learnedAct = learned.filter((l) => l.conceptKind === 'experience');

  return (
    <Card>
      <Row>
        <Pressable onPress={async () => { const url = await pickPhoto(); if (url) { await api.updateMember(member.id, { avatarUrl: url }); await refresh(); } }} accessibilityRole="button" accessibilityLabel={`Change photo for ${member.name}`}>
          <Avatar name={member.name} index={index} size={56} url={member.avatarUrl} />
          <Text style={[type.tiny, { textAlign: 'center' }]}>{member.avatarUrl ? 'change' : 'photo'}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          {editing ? (
            <Row>
              <TextInput value={name} onChangeText={setName} style={[styles.input, { flex: 1 }]} />
              <TextInput value={year} onChangeText={setYear} placeholder="Birth year" placeholderTextColor={colors.inkFaint} style={[styles.input, { width: 110 }]} keyboardType="number-pad" />
            </Row>
          ) : (
            <>
              <Text style={type.h2}>{member.name}</Text>
              <Text style={type.small}>
                {member.relationship ? RELATIONSHIP_LABEL[member.relationship] ?? member.relationship : 'Relationship not set'}
                {member.age != null ? ` · ${member.age}` : ''}
                {member.isMinor ? ' · under 13' : ''}
              </Text>
              {managedBy ? <Text style={type.tiny}>Managed by {managedBy}</Text> : null}
            </>
          )}
        </View>
        {editing ? <Button label="Save" kind="secondary" onPress={save} /> : <Button label="Edit" kind="ghost" onPress={() => setEditing(true)} />}
      </Row>
      {editing ? (
        <Wrap>{relationships.map((r) => <Chip key={r} label={RELATIONSHIP_LABEL[r] ?? r} selected={member.relationship === r} onPress={async () => { await api.updateMember(member.id, { relationship: r }); await refresh(); }} />)}</Wrap>
      ) : null}

      <Segmented value={section} options={[{ value: 'food', label: 'Food & drink' }, { value: 'activities', label: 'Things to do' }]} onChange={setSection} />

      {section === 'food' ? (
        <View style={{ gap: spacing.md }}>
          <Group title="Allergens — will exclude places" hint="Safety, not preference. Pick from the list.">
            <Wrap>
              {member.allergens.map((c) => <Chip key={c.id} label={c.value} tone="allergen" icon="⚠" onRemove={() => remove(c)} />)}
              {allergens.filter((a) => !member.allergens.some((c) => c.value === a)).map((a) => <Chip key={a} label={`+ ${a}`} onPress={() => add('allergen', a)} />)}
            </Wrap>
          </Group>
          <Group title="Diet" hint="Vegetarian, halal, gluten-free… ranks places by whether they have something suitable.">
            <Wrap>{member.diets.map((c) => <Chip key={c.id} label={c.value} tone="accent" onRemove={() => remove(c)} />)}</Wrap>
            <SuggestInput placeholder="e.g. vegetarian, halal, gluten-free" kinds={DIET_KINDS} onPick={(s) => add('diet', s.label, s.key)} onFree={(v) => add('diet', v)} />
          </Group>
          <Group title="Likes" hint="Dishes, drinks and cuisines that make a place worth going to.">
            <Wrap>{foodLikes.map((c) => <Chip key={c.id} label={c.value} tone="like" onRemove={() => remove(c)} />)}</Wrap>
            <SuggestInput placeholder="e.g. spaghetti arrabbiata, ramen, burgers" kinds={FOOD_KINDS} onPick={(s) => add('like', s.label, s.key)} onFree={(v) => add('like', v)} />
          </Group>
          <Group title="Dislikes" hint="Ranks a place lower — never hides it.">
            <Wrap>{foodDislikes.map((c) => <Chip key={c.id} label={c.value} tone="dislike" onRemove={() => remove(c)} />)}</Wrap>
            <SuggestInput placeholder="e.g. seafood, pubs, spicy food" kinds={FOOD_KINDS} onPick={(s) => add('dislike', s.label, s.key)} onFree={(v) => add('dislike', v)} />
          </Group>
          <LearnedList items={learnedFood} />
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          <Group title="Loves doing" hint="Kinds of outing that light this person up.">
            <Wrap>{actLikes.map((c) => <Chip key={c.id} label={c.value} tone="like" onRemove={() => remove(c)} />)}</Wrap>
            <SuggestInput placeholder="e.g. playgrounds, museums, swimming, live music" kinds={ACTIVITY_KINDS} onPick={(s) => add('like', s.label, s.key)} onFree={(v) => add('like', v)} />
          </Group>
          <Group title="Would rather not" hint="Ranks these lower for outings this person is on.">
            <Wrap>{actDislikes.map((c) => <Chip key={c.id} label={c.value} tone="dislike" onRemove={() => remove(c)} />)}</Wrap>
            <SuggestInput placeholder="e.g. art galleries, long walks" kinds={ACTIVITY_KINDS} onPick={(s) => add('dislike', s.label, s.key)} onFree={(v) => add('dislike', v)} />
          </Group>
          <LearnedList items={learnedAct} />
        </View>
      )}

      {pending ? (
        <View style={styles.pendingBox}>
          <Text style={type.small}>Kept as typed. Did you mean one of these?</Text>
          <Wrap>{pending.map((s) => <Chip key={s.key} label={s.label} tone="accent" onPress={async () => { await add(section === 'food' ? 'like' : 'like', s.label, s.key); setPending(null); }} />)}</Wrap>
        </View>
      ) : null}

      <Row style={{ justifyContent: 'flex-end' }}>
        <Button label="Remove person" kind="ghost" onPress={async () => { await api.deleteMember(member.id); await refresh(); }} />
      </Row>
    </Card>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={type.h3}>{title}</Text>
      {hint ? <Text style={type.tiny}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function LearnedList({ items }: { items: Learned[] }) {
  const sorted = useMemo(() => [...items].sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.count - a.count), [items]);
  return (
    <Group title="Learned from visits" hint={items.length ? 'Counts toward recommendations once it has happened enough times.' : 'Nothing yet — rate a few visits in Places.'}>
      <Wrap>
        {sorted.map((l) => (
          <Chip key={l.conceptKey} label={`${l.kind === 'like' ? '♥' : '✕'} ${l.label} · ${l.count}/${l.threshold}${l.confirmed ? '' : ' learning'}`} tone={l.confirmed ? (l.kind === 'like' ? 'like' : 'dislike') : 'neutral'} />
        ))}
      </Wrap>
    </Group>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 1100, alignSelf: 'center' },
  grid: { gap: spacing.md, justifyContent: 'space-between' },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  pendingBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, gap: spacing.sm },
});

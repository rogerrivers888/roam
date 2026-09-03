import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { api, Constraint, HouseholdResponse, Learned, Member, Suggestion } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, Wrap } from '../components/ui';
import { Avatar } from '../components/Faces';
import { SuggestInput } from '../components/SuggestInput';
import { TastePicker } from '../components/TastePicker';

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
              <Text style={[type.small, { flex: 1 }]}>Birthday (optional)</Text>
              <TextInput value={newYear} onChangeText={setNewYear} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 0, width: 160 }]} />
            </Row>
            <Text style={type.tiny}>A child under 13 gets a full profile owned by an adult — no login, no voice capture.</Text>
            <Button label="Add" disabled={!newName.trim()} onPress={async () => {
              await api.addMember({ name: newName.trim(), relationship: newRel, birthDate: /^\d{4}-\d{2}-\d{2}$/.test(newYear) ? newYear : null, birthYear: /^\d{4}$/.test(newYear) ? Number(newYear) : null });
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
  const [birth, setBirth] = useState(member.birthDate ?? (member.birthYear ? `${member.birthYear}-01-01` : ''));
  const [browse, setBrowse] = useState<null | { section: 'food' | 'activities'; mode: 'like' | 'dislike' }>(null);
  const [limitFor, setLimitFor] = useState<Constraint | null>(null);
  const [section, setSection] = useState<'food' | 'activities'>('food');
  const [pending, setPending] = useState<Suggestion[] | null>(null);
  const [pendingKind, setPendingKind] = useState<Constraint['kind']>('like');
  const [hint, setHint] = useState<string | null>(null);

  const add = async (kind: Constraint['kind'], value: string, conceptKey?: string) => {
    const r = await api.addConstraint(member.id, { kind, value, conceptKey });
    setPending(!r.resolved && r.suggestions.length ? r.suggestions : null);
    setPendingKind(kind);
    setHint(r.hint);
    await refresh();
  };
  const remove = async (c: Constraint) => { await api.deleteConstraint(c.id); await refresh(); };
  const save = async () => {
    await api.updateMember(member.id, { name: name.trim() || member.name, birthDate: /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : null });
    setEditing(false);
    await refresh();
  };
  const haveKeys = new Set([...member.likes, ...member.dislikes, ...member.diets].map((c) => c.conceptKey).filter(Boolean) as string[]);
  const addMany = async (kind: Constraint['kind'], picked: { key: string; label: string }[]) => {
    for (const p of picked) await api.addConstraint(member.id, { kind, value: p.label, conceptKey: p.key });
    await refresh();
  };
  const setLimit = async (c: Constraint, maxMinutes: number | null) => { await api.updateConstraint(c.id, { maxMinutes }); setLimitFor(null); await refresh(); };
  const prefLabel = (c: Constraint) => (c.maxMinutes ? `${c.value} · up to ${c.maxMinutes} min` : c.value);

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
              <TextInput value={birth} onChangeText={setBirth} placeholder="Birthday YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { width: 170 }]} />
            </Row>
          ) : (
            <>
              <Text style={type.h2}>{member.name}</Text>
              <Text style={type.small}>
                {member.relationship ? RELATIONSHIP_LABEL[member.relationship] ?? member.relationship : 'Relationship not set'}
                {member.age != null ? ` · ${member.age}${member.birthDate ? '' : ' (approx.)'}` : ''}
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
          <Group title="Allergens — will exclude places" hint="Safety, not preference. Tap the common ones or type any other.">
            <Wrap>
              {member.allergens.map((c) => <Chip key={c.id} label={c.value} tone="allergen" icon="⚠" onRemove={() => remove(c)} />)}
              {allergens.filter((a) => !member.allergens.some((c) => c.value === a)).map((a) => <Chip key={a} label={`+ ${a}`} onPress={() => add('allergen', a)} />)}
            </Wrap>
            <FreeTextAdd placeholder="Another allergen, e.g. carrots, celery, mustard" onAdd={(v) => add('allergen', v)} />
          </Group>
          <Group title="Diet" hint="Vegetarian, halal, gluten-free… ranks places by whether they have something suitable.">
            <Wrap>{member.diets.map((c) => <Chip key={c.id} label={c.value} tone="accent" onRemove={() => remove(c)} />)}</Wrap>
            <SuggestInput placeholder="e.g. vegetarian, halal, gluten-free" kinds={DIET_KINDS} onPick={(s) => add('diet', s.label, s.key)} onFree={(v) => add('diet', v)} />
          </Group>
          <Group title="Likes" hint="Type anything — a dish, an ingredient (chicken), a cuisine, or a style (healthy food). Tap a pill to use the shared meaning, or Add to keep your own words.">
            <Wrap>{foodLikes.map((c) => <Chip key={c.id} label={prefLabel(c)} tone="like" onPress={() => setLimitFor(c)} onRemove={() => remove(c)} />)}</Wrap>
            <Row>
              <View style={{ flex: 1 }}><SuggestInput placeholder="e.g. chicken, salads, healthy food, ramen" kinds={FOOD_KINDS} onPick={(s) => add('like', s.label, s.key)} onFree={(v) => add('like', v)} /></View>
              <Button label="Browse" kind="secondary" onPress={() => setBrowse({ section: 'food', mode: 'like' })} />
            </Row>
            {browse?.section === 'food' && browse.mode === 'like' ? <TastePicker section="food" mode="like" already={haveKeys} onAdd={(p) => addMany('like', p)} onClose={() => setBrowse(null)} /> : null}
          </Group>
          <Group title="Dislikes" hint="Ranks a place lower — never hides it. Don't write 'not …' — this list is the 'not'.">
            <Wrap>{foodDislikes.map((c) => <Chip key={c.id} label={prefLabel(c)} tone="dislike" onRemove={() => remove(c)} />)}</Wrap>
            <Row>
              <View style={{ flex: 1 }}><SuggestInput placeholder="e.g. fried food, seafood, pubs, spicy food" kinds={FOOD_KINDS} onPick={(s) => add('dislike', s.label, s.key)} onFree={(v) => add('dislike', v)} /></View>
              <Button label="Browse" kind="secondary" onPress={() => setBrowse({ section: 'food', mode: 'dislike' })} />
            </Row>
            {browse?.section === 'food' && browse.mode === 'dislike' ? <TastePicker section="food" mode="dislike" already={haveKeys} onAdd={(p) => addMany('dislike', p)} onClose={() => setBrowse(null)} /> : null}
          </Group>
          <LearnedList items={learnedFood} />
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          <Group title="Loves doing" hint="Kinds of outing that light this person up.">
            <Wrap>{actLikes.map((c) => <Chip key={c.id} label={prefLabel(c)} tone="like" onPress={() => setLimitFor(c)} onRemove={() => remove(c)} />)}</Wrap>
            <Text style={type.tiny}>Tap a pill to set a limit — "walks, up to 40 min".</Text>
            <Row>
              <View style={{ flex: 1 }}><SuggestInput placeholder="e.g. playgrounds, museums, historical things, swimming" kinds={ACTIVITY_KINDS} onPick={(s) => add('like', s.label, s.key)} onFree={(v) => add('like', v)} /></View>
              <Button label="Browse" kind="secondary" onPress={() => setBrowse({ section: 'activities', mode: 'like' })} />
            </Row>
            {browse?.section === 'activities' && browse.mode === 'like' ? <TastePicker section="activities" mode="like" already={haveKeys} onAdd={(p) => addMany('like', p)} onClose={() => setBrowse(null)} /> : null}
          </Group>
          <Group title="Would rather not" hint="Ranks these lower for outings this person is on.">
            <Wrap>{actDislikes.map((c) => <Chip key={c.id} label={prefLabel(c)} tone="dislike" onRemove={() => remove(c)} />)}</Wrap>
            <Row>
              <View style={{ flex: 1 }}><SuggestInput placeholder="e.g. art galleries, shopping" kinds={ACTIVITY_KINDS} onPick={(s) => add('dislike', s.label, s.key)} onFree={(v) => add('dislike', v)} /></View>
              <Button label="Browse" kind="secondary" onPress={() => setBrowse({ section: 'activities', mode: 'dislike' })} />
            </Row>
            {browse?.section === 'activities' && browse.mode === 'dislike' ? <TastePicker section="activities" mode="dislike" already={haveKeys} onAdd={(p) => addMany('dislike', p)} onClose={() => setBrowse(null)} /> : null}
          </Group>
          <LearnedList items={learnedAct} />
        </View>
      )}

      {limitFor ? (
        <View style={styles.pendingBox}>
          <Text style={type.small}>{limitFor.value} — how long is enough?</Text>
          <Wrap>
            {[30, 45, 60, 90, 120, 180].map((m) => <Chip key={m} label={`up to ${m} min`} selected={limitFor.maxMinutes === m} onPress={() => setLimit(limitFor, m)} />)}
            <Chip label="no limit" selected={!limitFor.maxMinutes} onPress={() => setLimit(limitFor, null)} />
          </Wrap>
          <Button label="Cancel" kind="ghost" onPress={() => setLimitFor(null)} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : null}
      {hint ? (
        <View style={styles.pendingBox}>
          <Text style={type.small}>{hint}</Text>
          <Button label="OK" kind="ghost" onPress={() => setHint(null)} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : null}
      {pending ? (
        <View style={styles.pendingBox}>
          <Text style={type.small}>Kept as typed. Also add the shared meaning?</Text>
          <Wrap>{pending.map((s) => <Chip key={s.key} label={s.label} tone="accent" onPress={async () => { await add(pendingKind, s.label, s.key); setPending(null); }} />)}</Wrap>
          <Button label="No, keep my words" kind="ghost" onPress={() => setPending(null)} style={{ alignSelf: 'flex-start' }} />
        </View>
      ) : null}

      <Row style={{ justifyContent: 'flex-end' }}>
        <Button label="Remove person" kind="ghost" onPress={async () => { await api.deleteMember(member.id); await refresh(); }} />
      </Row>
    </Card>
  );
}

function FreeTextAdd({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => Promise<void> }) {
  const [v, setV] = useState('');
  const commit = async () => { const t = v.trim(); if (!t) return; setV(''); await onAdd(t); };
  return (
    <Row>
      <TextInput value={v} onChangeText={setV} placeholder={placeholder} placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} onSubmitEditing={commit} returnKeyType="done" autoCapitalize="none" />
      <Button label="Add" kind="secondary" onPress={commit} disabled={!v.trim()} />
    </Row>
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

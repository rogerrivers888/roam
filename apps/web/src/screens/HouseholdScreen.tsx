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

// Everything a person can say about food: a dish, a cuisine, an ingredient
// (chicken) or a style (healthy food). Leaving kinds out here is why "healthy
// food" used to match nothing even though the placeholder suggested it.
const FOOD_KINDS = ['dish', 'cuisine', 'ingredient', 'style'];
const ACTIVITY_KINDS = ['experience'];
const DIET_KINDS = ['diet'];
const RELATIONSHIP_LABEL: Record<string, string> = { parent: 'Parent', partner: 'Partner', child: 'Child', grandparent: 'Grandparent', sibling: 'Sibling', friend: 'Friend', other: 'Other' };

type Section = 'food' | 'activities';
type Mode = 'like' | 'dislike';
// Where the last add happened, so its follow-up ("kept as typed — also add…")
// shows under that list rather than at the foot of the card.
type Notice = { section: Section; kind: Constraint['kind']; hint: string | null; pending: Suggestion[] | null };

export function HouseholdScreen({ data, refresh }: { data: HouseholdResponse | null; refresh: () => Promise<void> }) {
  const { width } = useWindowDimensions();
  const twoCol = width >= 1000;
  const [newName, setNewName] = useState('');
  const [newRel, setNewRel] = useState<string>('child');
  const [newYear, setNewYear] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  if (!data) return <View style={styles.page}><Text style={type.small}>Loading household…</Text></View>;
  const { household, members, learned, vocabulary } = data;
  const adult = members.find((m) => !m.isMinor);

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View>
        <Text style={type.title}>{household.name}</Text>
        <Text style={type.small}>Who's in the family and what each person will and won't eat or do. Allergens exclude places; diets, likes and dislikes only rank them. Tap a person to edit their tastes.</Text>
      </View>

      <View style={[styles.grid, twoCol && { flexDirection: 'row', flexWrap: 'wrap' }]}>
        {members.map((m, i) => (
          <View key={m.id} style={twoCol ? { width: '49%' } : undefined}>
            <MemberCard
              member={m} index={i} managedBy={m.isMinor ? adult?.name : undefined}
              relationships={vocabulary.relationships} allergens={vocabulary.allergens}
              learned={learned.filter((l) => l.memberId === m.id)} refresh={refresh}
              open={openId === m.id} onToggle={() => setOpenId(openId === m.id ? null : m.id)}
            />
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
              const r = await api.addMember({ name: newName.trim(), relationship: newRel, birthDate: /^\d{4}-\d{2}-\d{2}$/.test(newYear) ? newYear : null, birthYear: /^\d{4}$/.test(newYear) ? Number(newYear) : null });
              setNewName(''); setNewYear('');
              await refresh();
              const id = (r as any)?.member?.id ?? (r as any)?.id;
              if (id) setOpenId(id);
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

const isActivity = (c: Constraint) => c.conceptKind === 'experience';
// Favourites first, then the order they were added.
const byFavourite = (a: Constraint, b: Constraint) => Number(Boolean(b.favourite)) - Number(Boolean(a.favourite));
const listOf = (cs: Constraint[], max = 4) => {
  const labels = cs.map((c) => c.value);
  return labels.length <= max ? labels.join(', ') : `${labels.slice(0, max).join(', ')} +${labels.length - max}`;
};

/** One line that says what this person is about, for the collapsed card. */
function summarise(m: Member): string {
  const parts: string[] = [];
  if (m.allergens.length) parts.push(`⚠ allergic to ${listOf(m.allergens)}`);
  if (m.diets.length) parts.push(m.diets.map((c) => c.value).join(', '));
  const favs = m.likes.filter((c) => c.favourite);
  const likes = [...favs, ...m.likes.filter((c) => !c.favourite)];
  if (likes.length) parts.push(`likes ${listOf(likes)}`);
  if (m.dislikes.length) parts.push(`dislikes ${listOf(m.dislikes, 3)}`);
  return parts.length ? parts.join(' · ') : 'Nothing set yet — tap to add what they like.';
}

function MemberCard({ member, index, managedBy, relationships, allergens, learned, refresh, open, onToggle }: {
  member: Member; index: number; managedBy?: string; relationships: string[]; allergens: string[]; learned: Learned[]; refresh: () => Promise<void>;
  open: boolean; onToggle: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [birth, setBirth] = useState(member.birthDate ?? (member.birthYear ? `${member.birthYear}-01-01` : ''));
  const [browse, setBrowse] = useState<null | { section: Section; mode: Mode }>(null);
  const [detailFor, setDetailFor] = useState<Constraint | null>(null);
  const [section, setSection] = useState<Section>('food');
  const [notice, setNotice] = useState<Notice | null>(null);

  const add = async (kind: Constraint['kind'], value: string, conceptKey?: string) => {
    const r = await api.addConstraint(member.id, { kind, value, conceptKey });
    const pending = !r.resolved && r.suggestions.length ? r.suggestions : null;
    setNotice(pending || r.hint ? { section, kind, hint: r.hint, pending } : null);
    await refresh();
  };
  const remove = async (c: Constraint) => { if (detailFor?.id === c.id) setDetailFor(null); await api.deleteConstraint(c.id); await refresh(); };
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
  const setLimit = async (c: Constraint, maxMinutes: number | null) => { await api.updateConstraint(c.id, { maxMinutes }); setDetailFor(null); await refresh(); };
  const setFavourite = async (c: Constraint, favourite: boolean) => { await api.updateConstraint(c.id, { favourite }); setDetailFor(null); await refresh(); };
  const prefLabel = (c: Constraint) => (c.maxMinutes ? `${c.value} · up to ${c.maxMinutes} min` : c.value);
  const openBrowse = (s: Section, mode: Mode) => setBrowse({ section: s, mode });

  const foodLikes = member.likes.filter((c) => !isActivity(c)).sort(byFavourite);
  const foodDislikes = member.dislikes.filter((c) => !isActivity(c));
  const actLikes = member.likes.filter(isActivity).sort(byFavourite);
  const actDislikes = member.dislikes.filter(isActivity);
  const learnedFood = learned.filter((l) => l.conceptKind !== 'experience');
  const learnedAct = learned.filter((l) => l.conceptKind === 'experience');

  const noticeFor = (s: Section, kind: Constraint['kind']) => (notice && notice.section === s && notice.kind === kind ? (
    <View style={styles.pendingBox}>
      {notice.hint ? <Text style={type.small}>{notice.hint}</Text> : null}
      {notice.pending ? (
        <>
          <Text style={type.small}>Kept as typed. Also add the shared meaning?</Text>
          <Wrap>{notice.pending.map((sg) => <Chip key={sg.key} label={sg.label} tone="accent" onPress={async () => { setNotice(null); await add(kind, sg.label, sg.key); }} />)}</Wrap>
        </>
      ) : null}
      <Button label={notice.pending ? 'No, keep my words' : 'OK'} kind="ghost" onPress={() => setNotice(null)} style={{ alignSelf: 'flex-start' }} />
    </View>
  ) : null);

  // Tapping a like: make it a favourite (food) or set a time limit (activities).
  const detailBox = detailFor ? (
    <View style={styles.pendingBox}>
      <Text style={type.small}>{detailFor.value}</Text>
      {detailFor.kind === 'like' ? (
        <Wrap>
          <Chip label={detailFor.favourite ? '★ A favourite' : '☆ Make it a favourite'} tone="like" selected={Boolean(detailFor.favourite)} onPress={() => setFavourite(detailFor, !detailFor.favourite)} />
        </Wrap>
      ) : null}
      {detailFor.kind === 'like' ? <Text style={type.tiny}>A favourite is the one {member.name} would generally pick over the other things they like. It ranks higher; it never hides anything.</Text> : null}
      {isActivity(detailFor) ? (
        <>
          <Text style={type.tiny}>How long is enough?</Text>
          <Wrap>
            {[30, 45, 60, 90, 120, 180].map((m) => <Chip key={m} label={`up to ${m} min`} selected={detailFor.maxMinutes === m} onPress={() => setLimit(detailFor, m)} />)}
            <Chip label="no limit" selected={!detailFor.maxMinutes} onPress={() => setLimit(detailFor, null)} />
          </Wrap>
        </>
      ) : null}
      <Row>
        <Button label="Remove" kind="ghost" onPress={() => remove(detailFor)} />
        <Button label="Done" kind="ghost" onPress={() => setDetailFor(null)} />
      </Row>
    </View>
  ) : null;

  const likeChip = (c: Constraint) => (
    <Chip key={c.id} label={prefLabel(c)} tone="like" icon={c.favourite ? '★' : undefined} selected={detailFor?.id === c.id} onPress={() => setDetailFor(detailFor?.id === c.id ? null : c)} onRemove={() => remove(c)} />
  );

  return (
    <Card>
      <Pressable onPress={editing ? undefined : onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${member.name}`}>
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
                {!open ? <Text style={[type.small, { marginTop: 4 }]}>{summarise(member)}</Text> : null}
              </>
            )}
          </View>
          {editing ? <Button label="Save" kind="secondary" onPress={save} /> : open ? <Button label="Edit" kind="ghost" onPress={() => setEditing(true)} /> : null}
          <Text style={[type.h3, { color: colors.inkMuted, paddingHorizontal: 4 }]}>{open ? '▴' : '▾'}</Text>
        </Row>
      </Pressable>
      {editing ? (
        <Wrap>{relationships.map((r) => <Chip key={r} label={RELATIONSHIP_LABEL[r] ?? r} selected={member.relationship === r} onPress={async () => { await api.updateMember(member.id, { relationship: r }); await refresh(); }} />)}</Wrap>
      ) : null}

      {!open ? null : (
        <>
          <Segmented value={section} options={[{ value: 'food', label: 'Food & drink' }, { value: 'activities', label: 'Things to do' }]} onChange={(s) => { setSection(s); setBrowse(null); setDetailFor(null); }} />

          {section === 'food' ? (
            <View style={{ gap: spacing.md }}>
              <AllergenGroup member={member} common={allergens} add={(v) => add('allergen', v)} remove={remove} notice={noticeFor('food', 'allergen')} />
              <Group title="Diet" hint="Vegetarian, halal, gluten-free… ranks places by whether they have something suitable.">
                <Wrap>{member.diets.map((c) => <Chip key={c.id} label={c.value} tone="accent" onRemove={() => remove(c)} />)}</Wrap>
                <SuggestInput placeholder="e.g. vegetarian, halal, gluten-free" kinds={DIET_KINDS} onPick={(s) => add('diet', s.label, s.key)} onFree={(v) => add('diet', v)} />
                {noticeFor('food', 'diet')}
              </Group>
              <Group title="Likes" hint="Tap into the box to pick from cuisines, styles and dishes, or type anything. Tap a pill to make it a favourite.">
                <Wrap>{foodLikes.map(likeChip)}</Wrap>
                {detailFor && !isActivity(detailFor) && detailFor.kind === 'like' ? detailBox : null}
                <SuggestInput placeholder="e.g. Italian, chicken, healthy food, noodles" kinds={FOOD_KINDS} onPick={(s) => add('like', s.label, s.key)} onFree={(v) => add('like', v)} onFocus={() => openBrowse('food', 'like')} onBrowse={() => openBrowse('food', 'like')} />
                {browse?.section === 'food' && browse.mode === 'like' ? <TastePicker section="food" mode="like" already={haveKeys} onAdd={(p) => addMany('like', p)} onClose={() => setBrowse(null)} /> : null}
                {noticeFor('food', 'like')}
              </Group>
              <Group title="Dislikes" hint="Ranks a place lower — never hides it. Don't write 'not …' — this list is the 'not'.">
                <Wrap>{foodDislikes.map((c) => <Chip key={c.id} label={prefLabel(c)} tone="dislike" onRemove={() => remove(c)} />)}</Wrap>
                <SuggestInput placeholder="e.g. fried food, seafood, pubs, spicy food" kinds={FOOD_KINDS} onPick={(s) => add('dislike', s.label, s.key)} onFree={(v) => add('dislike', v)} onFocus={() => openBrowse('food', 'dislike')} onBrowse={() => openBrowse('food', 'dislike')} />
                {browse?.section === 'food' && browse.mode === 'dislike' ? <TastePicker section="food" mode="dislike" already={haveKeys} onAdd={(p) => addMany('dislike', p)} onClose={() => setBrowse(null)} /> : null}
                {noticeFor('food', 'dislike')}
              </Group>
              <LearnedList items={learnedFood} />
            </View>
          ) : (
            <View style={{ gap: spacing.md }}>
              <Group title="Loves doing" hint={'Kinds of outing that light this person up. Tap a pill to make it a favourite or set a limit — "walks, up to 40 min".'}>
                <Wrap>{actLikes.map(likeChip)}</Wrap>
                {detailFor && isActivity(detailFor) ? detailBox : null}
                <SuggestInput placeholder="e.g. playgrounds, museums, historical things, swimming" kinds={ACTIVITY_KINDS} onPick={(s) => add('like', s.label, s.key)} onFree={(v) => add('like', v)} onFocus={() => openBrowse('activities', 'like')} onBrowse={() => openBrowse('activities', 'like')} />
                {browse?.section === 'activities' && browse.mode === 'like' ? <TastePicker section="activities" mode="like" already={haveKeys} onAdd={(p) => addMany('like', p)} onClose={() => setBrowse(null)} /> : null}
                {noticeFor('activities', 'like')}
              </Group>
              <Group title="Would rather not" hint="Ranks these lower for outings this person is on.">
                <Wrap>{actDislikes.map((c) => <Chip key={c.id} label={prefLabel(c)} tone="dislike" onRemove={() => remove(c)} />)}</Wrap>
                <SuggestInput placeholder="e.g. art galleries, shopping" kinds={ACTIVITY_KINDS} onPick={(s) => add('dislike', s.label, s.key)} onFree={(v) => add('dislike', v)} onFocus={() => openBrowse('activities', 'dislike')} onBrowse={() => openBrowse('activities', 'dislike')} />
                {browse?.section === 'activities' && browse.mode === 'dislike' ? <TastePicker section="activities" mode="dislike" already={haveKeys} onAdd={(p) => addMany('dislike', p)} onClose={() => setBrowse(null)} /> : null}
                {noticeFor('activities', 'dislike')}
              </Group>
              <LearnedList items={learnedAct} />
            </View>
          )}

          <Row style={{ justifyContent: 'flex-end' }}>
            <Button label="Remove person" kind="ghost" onPress={async () => { await api.deleteMember(member.id); await refresh(); }} />
          </Row>
        </>
      )}
    </Card>
  );
}

/**
 * Allergens: the person's own list in red, then one box to type into. The
 * common nine appear as you type (so "pea" offers peanuts) and behind a
 * "Common ones" toggle — not as a permanent row that looks like more choices.
 */
function AllergenGroup({ member, common, add, remove, notice }: {
  member: Member; common: string[]; add: (v: string) => Promise<void>; remove: (c: Constraint) => Promise<void>; notice: React.ReactNode;
}) {
  const [v, setV] = useState('');
  const [showCommon, setShowCommon] = useState(false);
  const have = new Set(member.allergens.map((c) => c.value.toLowerCase()));
  const q = v.trim().toLowerCase();
  const matches = q ? common.filter((a) => !have.has(a) && a.includes(q)) : [];
  const commit = async (value = v) => { const t = value.trim(); if (!t) return; setV(''); await add(t); };
  return (
    <Group title="Allergens — will exclude places" hint="Safety, not preference. A place that can't avoid it is hidden, not ranked lower.">
      {member.allergens.length ? (
        <Wrap>{member.allergens.map((c) => <Chip key={c.id} label={c.value} tone="allergen" icon="⚠" onRemove={() => remove(c)} />)}</Wrap>
      ) : <Text style={type.tiny}>None recorded.</Text>}
      <Row>
        <TextInput value={v} onChangeText={setV} placeholder="Type an allergen, e.g. peanuts, milk, carrots" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} onSubmitEditing={() => commit(matches.length === 1 ? matches[0] : v)} returnKeyType="done" autoCapitalize="none" />
        <Button label="Add" kind="secondary" onPress={() => commit()} disabled={!q} />
        <Button label={showCommon ? 'Hide' : 'Common ones'} kind="secondary" onPress={() => setShowCommon((s) => !s)} />
      </Row>
      {matches.length ? <Wrap>{matches.map((a) => <Chip key={a} label={a} tone="allergen" onPress={() => commit(a)} />)}</Wrap> : null}
      {showCommon ? (
        <View style={{ gap: 4 }}>
          <Text style={type.tiny}>The nine most common. Tap to add.</Text>
          <Wrap>{common.filter((a) => !have.has(a)).map((a) => <Chip key={a} label={`+ ${a}`} onPress={() => { void add(a); }} />)}</Wrap>
        </View>
      ) : null}
      {notice}
    </Group>
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

import React, { useEffect, useMemo, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useViewport } from '../hooks/useViewport';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { api, Constraint, Household, HouseholdInvitation, HouseholdResponse, Learned, Member, Place, SenderStatus, Suggestion } from '../api';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, Wrap } from '../components/ui';
import { asFlag, asOneOf, useQueryState, useRouter } from '../router';
import { paths, type Route } from '../routes';
import { Avatar } from '../components/Faces';
import { Icon, IconText } from '../components/Icon';
import { PlacePicker } from '../components/PlacePicker';
import { SuggestInput } from '../components/SuggestInput';
import { TastePicker } from '../components/TastePicker';

// Everything a person can say about food: a dish, a cuisine, an ingredient
// (chicken) or a style (healthy food).
const FOOD_KINDS = ['dish', 'cuisine', 'ingredient', 'style'];
const ACTIVITY_KINDS = ['experience'];
const DIET_KINDS = ['diet'];
const RELATIONSHIP_LABEL: Record<string, string> = { parent: 'Parent', partner: 'Partner', child: 'Child', grandparent: 'Grandparent', sibling: 'Sibling', friend: 'Friend', other: 'Other' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Section = 'food' | 'activities';
type Mode = 'like' | 'dislike';
// Where the last add happened, so its follow-up ("kept as typed — also add…")
// shows under that list rather than somewhere else on the card.
type Notice = { section: Section; kind: Constraint['kind']; hint: string | null; pending: Suggestion[] | null };

/**
 * People down the left, one after another; the chosen person's tastes on the
 * right (owner, 3 Sep 2026). Nothing here has a Save button — every change is
 * stored as it is made.
 */
export function HouseholdScreen({ data, refresh, route }: {
  data: HouseholdResponse | null; refresh: () => Promise<void>;
  /** Whose tastes are open: `/household/<memberId>`, so one person is a page you can be sent to. */
  route: Extract<Route, { name: 'household' }>;
}) {
  const { width } = useViewport();
  const { navigate } = useRouter();
  const sideBySide = width >= 900;
  const selectedId = route.memberId;
  const setSelectedId = (id: string | null) => navigate(paths.household(id), { replace: !id });
  const [adding, setAdding] = useState(false);

  const members = data?.members ?? [];
  const selected = members.find((m) => m.id === selectedId) ?? (sideBySide ? members[0] : undefined);
  // On a wide screen somebody is always open, so the address says who — a link
  // to the household is a link to a person, not to "whoever is first today".
  useEffect(() => { if (selected && selected.id !== selectedId && sideBySide) setSelectedId(selected.id); }, [selected?.id, sideBySide]);

  if (!data) return <View style={styles.page}><Text style={type.small}>Loading household…</Text></View>;
  const { household, learned, vocabulary, senders } = data;
  const adult = members.find((m) => !m.isMinor);

  const detail = (m: Member, i: number) => (
    <MemberDetail
      key={m.id}
      member={m} index={i} managedBy={m.isMinor ? adult?.name : undefined}
      relationships={vocabulary.relationships} allergens={vocabulary.allergens}
      learned={learned.filter((l) => l.memberId === m.id)} refresh={refresh}
      senders={senders}
      onRemoved={() => setSelectedId(null)}
    />
  );

  const addCard = (
    <AddPerson
      onAdded={async (id) => { setAdding(false); await refresh(); if (id) setSelectedId(id); }}
      onCancel={() => setAdding(false)}
    />
  );

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <HomeCard household={household} refresh={refresh} wide={sideBySide} />
      <Text style={type.small}>Allergens exclude places; diets, likes and dislikes only rank them. Everything saves as you go.</Text>

      {sideBySide ? (
        <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
          <View style={styles.sidebar}>
            {members.map((m, i) => (
              <PersonRow key={m.id} member={m} index={i} selected={!adding && selected?.id === m.id} onPress={() => { setAdding(false); setSelectedId(m.id); }} />
            ))}
            <Button label="+ Add someone" kind={adding ? 'secondary' : 'ghost'} onPress={() => setAdding(true)} style={{ alignSelf: 'stretch' }} />
          </View>
          <View style={{ flex: 1 }}>
            {adding ? addCard : selected ? detail(selected, members.indexOf(selected)) : <Card><Text style={type.small}>Choose someone on the left.</Text></Card>}
          </View>
        </View>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {members.map((m, i) => (
            <View key={m.id} style={{ gap: spacing.sm }}>
              <PersonRow member={m} index={i} selected={selectedId === m.id} onPress={() => setSelectedId(selectedId === m.id ? null : m.id)} />
              {selectedId === m.id ? detail(m, i) : null}
            </View>
          ))}
          {adding ? addCard : <Button label="+ Add someone" kind="ghost" onPress={() => setAdding(true)} style={{ alignSelf: 'flex-start' }} />}
        </View>
      )}
    </ScrollView>
  );
}

/**
 * The household itself, at the top of its own tab: what it is called, where it
 * lives, and a picture of home (owner, 6 Sep 2026 — "I feel like maybe my
 * address should also be in my household, and the name of my household").
 *
 * The three of them were only in Settings, which is where the pace and the
 * radius and the export still are: this is the page about the household, so the
 * household's own name and front door belong here too. Settings keeps its
 * copies — same fields, same endpoint, both write the same row.
 *
 * Nothing has a Save button, like everything else on this page. The name is
 * stored when the box is left, the address when a real match is tapped, and the
 * picture when it is chosen.
 */
function HomeCard({ household, refresh, wide }: { household: Household; refresh: () => Promise<void>; wide: boolean }) {
  const [name, setName] = useState(household.name);
  const [changing, setChanging] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => { setName(household.name); }, [household.name]);

  const saveName = async () => {
    const v = name.trim();
    if (!v || v === household.name) { setName(household.name); return; }
    try { await api.updateHousehold({ name: v }); await refresh(); setMsg({ tone: 'good', text: `Saved. This household is ${v}.` }); }
    catch (e: any) { setMsg({ tone: 'bad', text: e.message }); }
  };

  const setHome = async (p: Place | null) => {
    if (!p) return;
    try { await api.updateHousehold({ home: p }); await refresh(); setChanging(false); setMsg({ tone: 'good', text: `Home saved: ${p.formatted ?? p.label}` }); }
    catch (e: any) { setMsg({ tone: 'bad', text: e.message }); }
  };

  // A photograph of the household's own house — theirs, kept as they sent it,
  // wide rather than square because a house is not a face.
  const setPhoto = async () => {
    const url = await pickPhoto({ aspect: [3, 2], width: 900, height: 600 });
    if (!url) return;
    try { await api.updateHousehold({ homePhotoUrl: url }); await refresh(); setMsg(null); }
    catch (e: any) { setMsg({ tone: 'bad', text: e.message }); }
  };

  const removePhoto = async () => {
    try { await api.updateHousehold({ homePhotoUrl: '' }); await refresh(); }
    catch (e: any) { setMsg({ tone: 'bad', text: e.message }); }
  };

  const photo = household.homePhotoUrl ?? null;
  const address = household.home?.formatted ?? household.home?.label ?? null;

  return (
    <Card>
      <View style={[styles.homeCard, wide && styles.homeCardWide]}>
        <View style={{ gap: 4 }}>
          <Pressable
            onPress={setPhoto}
            accessibilityRole="button"
            accessibilityLabel={photo ? 'Change the picture of home' : 'Add a picture of home'}
            style={[styles.homePhoto, wide && styles.homePhotoWide]}
          >
            {photo
              ? <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityLabel="Home" />
              : (
                <View style={{ alignItems: 'center', gap: 6 }}>
                  <Icon name="home" size={26} color={colors.headerSub} />
                  <Text style={type.tiny}>Add a picture of home</Text>
                </View>
              )}
          </Pressable>
          {photo ? (
            <Row style={{ justifyContent: 'center', gap: spacing.md }}>
              <Pressable onPress={setPhoto} accessibilityRole="button"><Text style={type.tiny}>change</Text></Pressable>
              <Pressable onPress={removePhoto} accessibilityRole="button"><Text style={type.tiny}>remove</Text></Pressable>
            </Row>
          ) : null}
        </View>

        <View style={{ flex: 1, minWidth: 0, gap: spacing.sm }}>
          <View style={{ gap: 4 }}>
            <Text style={type.tiny}>This household is called</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              onBlur={saveName}
              onSubmitEditing={saveName}
              returnKeyType="done"
              placeholder="Household name"
              placeholderTextColor={colors.inkFaint}
              accessibilityLabel="Household name"
              style={[styles.input, styles.homeName]}
            />
          </View>

          <View style={{ gap: 4 }}>
            <Text style={type.tiny}>Home</Text>
            {address && !changing ? (
              <Row style={{ gap: spacing.sm }}>
                <Icon name="address" size={16} color={colors.headerSub} />
                <Text style={[type.small, { flex: 1 }]}>{address}</Text>
                <Button label="Change" kind="ghost" onPress={() => setChanging(true)} />
              </Row>
            ) : (
              <>
                <PlacePicker value={household.home} onPick={setHome} placeholder="House name or number, street, town, postcode" />
                {address ? <Button label="Keep it as it is" kind="ghost" onPress={() => setChanging(false)} /> : null}
              </>
            )}
            <Text style={type.tiny}>Used whenever you say "from home", and for everything Places keeps close to home.</Text>
          </View>

          {msg ? <Text style={[type.tiny, { color: msg.tone === 'good' ? colors.accent : colors.dislike }]}>{msg.text}</Text> : null}
        </View>
      </View>
    </Card>
  );
}

function PersonRow({ member, index, selected, onPress }: { member: Member; index: number; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Show ${member.name}`} style={[styles.personRow, selected && styles.personRowSelected]}>
      <Avatar name={member.name} index={index} size={44} url={member.avatarUrl} />
      <View style={{ flex: 1 }}>
        <Row style={{ gap: 6 }}>
          <Text style={[type.h3, { flexShrink: 1 }]} numberOfLines={1}>{member.name}</Text>
          {/* Who has Roam on their own phone, without opening them. A tick is
              somebody who has signed in; the paper plane is an invitation
              nobody has opened yet. */}
          {member.access && member.access.status !== 'none' ? (
            <Icon
              name={(member.access.signInCount ?? 0) > 0 ? 'check' : 'send'}
              size={14}
              color={(member.access.signInCount ?? 0) > 0 ? colors.accent : colors.headerSub}
            />
          ) : null}
        </Row>
        <Text style={type.tiny} numberOfLines={2}>{summarise(member)}</Text>
        {prettyMobile(member.access?.mobile) ? (
          <Text style={type.tiny} numberOfLines={1}>{prettyMobile(member.access?.mobile)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function AddPerson({ onAdded, onCancel }: { onAdded: (id: string | null) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [rel, setRel] = useState<string>('child');
  const [birth, setBirth] = useState('');
  return (
    <Card>
      <Text style={type.h3}>Add someone</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.inkFaint} style={styles.input} autoFocus />
      <Text style={type.tiny}>Relationship to the household</Text>
      <Wrap>{Object.entries(RELATIONSHIP_LABEL).map(([k, l]) => <Chip key={k} label={l} selected={rel === k} onPress={() => setRel(k)} />)}</Wrap>
      <Row>
        <Text style={[type.small, { flex: 1 }]}>Birthday (optional)</Text>
        <TextInput value={birth} onChangeText={setBirth} placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 0, width: 160 }]} />
      </Row>
      <Text style={type.tiny}>A child under 13 gets a full profile owned by an adult — no login, no voice capture.</Text>
      <Row>
        <Button label="Add" disabled={!name.trim()} onPress={async () => {
          const r = await api.addMember({ name: name.trim(), relationship: rel, birthDate: DATE.test(birth) ? birth : null, birthYear: /^\d{4}$/.test(birth) ? Number(birth) : null });
          await onAdded((r as any)?.member?.id ?? null);
        }} />
        <Button label="Cancel" kind="ghost" onPress={onCancel} />
      </Row>
    </Card>
  );
}

/**
 * A picture from this device, cropped and shrunk here so what leaves the phone
 * is small enough to store: a face is square and small, a house is wide and a
 * little bigger, and both arrive as a data URI the household owns.
 */
async function pickPhoto({ aspect = [1, 1] as [number, number], width = 256, height = 256 } = {}): Promise<string | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted && Platform.OS !== 'web') return null;
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect, quality: 0.9 });
  if (res.canceled || !res.assets?.[0]) return null;
  const ctx = ImageManipulator.ImageManipulator.manipulate(res.assets[0].uri);
  ctx.resize({ width, height });
  const rendered = await ctx.renderAsync();
  const saved = await rendered.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.75, base64: true });
  return saved.base64 ? `data:image/jpeg;base64,${saved.base64}` : null;
}

/**
 * A stored number read back the way it was dialled.
 *
 * `+447779993777` is what a sender needs and what the database holds; it is not
 * what anybody in this household would recognise as their own number. Only the
 * British shape is spaced, because guessing at the grouping of a number from
 * somewhere else would make it less readable rather than more.
 */
function prettyMobile(e164?: string | null): string | null {
  const v = (e164 ?? '').trim();
  if (!v) return null;
  if (v.startsWith('+44') && v.length === 13) return `${v.slice(0, 3)} ${v.slice(3, 7)} ${v.slice(7)}`;
  return v;
}

const isActivity = (c: Constraint) => c.conceptKind === 'experience';
// Favourites first, then the order they were added.
const byFavourite = (a: Constraint, b: Constraint) => Number(Boolean(b.favourite)) - Number(Boolean(a.favourite));
const listOf = (cs: Constraint[], max = 4) => {
  const labels = cs.map((c) => c.value);
  return labels.length <= max ? labels.join(', ') : `${labels.slice(0, max).join(', ')} +${labels.length - max}`;
};

/** One line that says what this person is about, for the list. */
function summarise(m: Member): string {
  const parts: string[] = [];
  if (m.allergens.length) parts.push(`allergic to ${listOf(m.allergens)}`);
  if (m.diets.length) parts.push(m.diets.map((c) => c.value).join(', '));
  const likes = [...m.likes].sort(byFavourite);
  if (likes.length) parts.push(`likes ${listOf(likes)}`);
  if (m.dislikes.length) parts.push(`not ${listOf(m.dislikes, 3)}`);
  return parts.length ? parts.join(' · ') : 'Nothing set yet';
}

function MemberDetail({ member, index, managedBy, relationships, allergens, learned, refresh, senders, onRemoved }: {
  member: Member; index: number; managedBy?: string; relationships: string[]; allergens: string[]; learned: Learned[];
  refresh: () => Promise<void>; senders?: { sms: SenderStatus; email: SenderStatus }; onRemoved: () => void;
}) {
  const [browse, setBrowse] = useState<null | { section: Section; mode: Mode }>(null);
  const [detailFor, setDetailFor] = useState<Constraint | null>(null);
  // Food or things to do: part of the address, so a person's tastes open where
  // the link says (`/household/<id>?tastes=activities`).
  const [section, setSection] = useQueryState<Section>('tastes', 'food', asOneOf(['food', 'activities'] as const, 'food'));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Reset per-person UI when the selection changes.
  useEffect(() => { setBrowse(null); setDetailFor(null); setNotice(null); setConfirmRemove(false); }, [member.id]);

  const add = async (kind: Constraint['kind'], value: string, conceptKey?: string) => {
    try {
      const r = await api.addConstraint(member.id, { kind, value, conceptKey });
      const pending = !r.resolved && r.suggestions.length ? r.suggestions : null;
      setNotice(pending || r.hint ? { section, kind, hint: r.hint, pending } : null);
    } catch (e: any) {
      // 409: it's already on the other list. Say so where they typed.
      const msg = e?.body?.message ?? e?.message ?? 'Could not add that.';
      setNotice({ section, kind, hint: msg, pending: null });
    }
    await refresh();
  };
  const remove = async (c: Constraint) => { if (detailFor?.id === c.id) setDetailFor(null); await api.deleteConstraint(c.id); await refresh(); };
  const haveKeys = new Set([...member.likes, ...member.dislikes, ...member.diets].map((c) => c.conceptKey).filter(Boolean) as string[]);
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

  // Tapping a like: make it a favourite, and for activities set a time limit.
  const detailBox = detailFor ? (
    <View style={styles.pendingBox}>
      <Text style={type.small}>{detailFor.value}</Text>
      {detailFor.kind === 'like' ? (
        <>
          <Wrap>
            <Chip label={detailFor.favourite ? 'A favourite' : 'Make it a favourite'} icon="favourite" iconFill={Boolean(detailFor.favourite)} tone="like" selected={Boolean(detailFor.favourite)} onPress={() => setFavourite(detailFor, !detailFor.favourite)} />
          </Wrap>
          <Text style={type.tiny}>A favourite is the one {member.name} would generally pick over the other things they like. It ranks higher; it never hides anything.</Text>
        </>
      ) : null}
      {isActivity(detailFor) ? (
        <>
          <Text style={type.tiny}>How long is enough? Short ones are fine, longer ones count against a place.</Text>
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
    <Chip key={c.id} label={prefLabel(c)} tone="like" icon={c.favourite ? 'favourite' : undefined} iconFill selected={detailFor?.id === c.id} onPress={() => setDetailFor(detailFor?.id === c.id ? null : c)} onRemove={() => remove(c)} />
  );
  const picker = (s: Section, mode: Mode) => (browse?.section === s && browse.mode === mode ? (
    <TastePicker section={s} mode={mode} already={haveKeys} onPick={(p) => add(mode, p.label, p.key)} onClose={() => setBrowse(null)} />
  ) : null);

  return (
    <Card>
      <Row>
        <Pressable onPress={async () => { const url = await pickPhoto(); if (url) { await api.updateMember(member.id, { avatarUrl: url }); await refresh(); } }} accessibilityRole="button" accessibilityLabel={`Change photo for ${member.name}`}>
          <Avatar name={member.name} index={index} size={56} url={member.avatarUrl} />
          <Text style={[type.tiny, { textAlign: 'center' }]}>{member.avatarUrl ? 'change' : 'photo'}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={type.h2}>{member.name}</Text>
          {managedBy ? <Text style={type.tiny}>Managed by {managedBy}</Text> : null}
          {/* How to reach them, beside their face — owner, 6 Sep 2026. Shown
              here rather than only inside the invite panel, because "what is
              Gina's number" is a thing to be able to read off the page without
              opening the machinery for sending her something. */}
          {prettyMobile(member.access?.mobile) ? (
            <IconText name="phone">{prettyMobile(member.access?.mobile)}</IconText>
          ) : null}
          {member.access?.email ? <IconText name="mail">{member.access.email}</IconText> : null}
        </View>
      </Row>

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
            {picker('food', 'like')}
            {noticeFor('food', 'like')}
          </Group>
          <Group title="Dislikes" hint="Ranks a place lower — never hides it. Don't write 'not …' — this list is the 'not'.">
            <Wrap>{foodDislikes.map((c) => <Chip key={c.id} label={prefLabel(c)} tone="dislike" onRemove={() => remove(c)} />)}</Wrap>
            <SuggestInput placeholder="e.g. fried food, seafood, pubs, spicy food" kinds={FOOD_KINDS} onPick={(s) => add('dislike', s.label, s.key)} onFree={(v) => add('dislike', v)} onFocus={() => openBrowse('food', 'dislike')} onBrowse={() => openBrowse('food', 'dislike')} />
            {picker('food', 'dislike')}
            {noticeFor('food', 'dislike')}
          </Group>
          <LearnedList items={learnedFood} />
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          <Group title="Loves doing" hint={'Tap a pill to make it a favourite or set a limit — "walks, up to 30 min" means short ones yes, long ones no.'}>
            <Wrap>{actLikes.map(likeChip)}</Wrap>
            {detailFor && isActivity(detailFor) ? detailBox : null}
            <SuggestInput placeholder="e.g. playgrounds, museums, historical things, swimming" kinds={ACTIVITY_KINDS} onPick={(s) => add('like', s.label, s.key)} onFree={(v) => add('like', v)} onFocus={() => openBrowse('activities', 'like')} onBrowse={() => openBrowse('activities', 'like')} />
            {picker('activities', 'like')}
            {noticeFor('activities', 'like')}
          </Group>
          <Group title="Would rather not" hint="Ranks these lower for outings this person is on. Anything already in Loves doing isn't offered here.">
            <Wrap>{actDislikes.map((c) => <Chip key={c.id} label={prefLabel(c)} tone="dislike" onRemove={() => remove(c)} />)}</Wrap>
            <SuggestInput placeholder="e.g. art galleries, shopping" kinds={ACTIVITY_KINDS} onPick={(s) => add('dislike', s.label, s.key)} onFree={(v) => add('dislike', v)} onFocus={() => openBrowse('activities', 'dislike')} onBrowse={() => openBrowse('activities', 'dislike')} />
            {picker('activities', 'dislike')}
            {noticeFor('activities', 'dislike')}
          </Group>
          <LearnedList items={learnedAct} />
        </View>
      )}

      <AboutGroup member={member} relationships={relationships} refresh={refresh} />

      <AccessGroup member={member} senders={senders} refresh={refresh} />

      <Row style={{ justifyContent: 'flex-end' }}>
        {confirmRemove ? (
          <>
            <Text style={type.small}>Remove {member.name} and everything they like?</Text>
            <Button label="Yes, remove" kind="danger" onPress={async () => { await api.deleteMember(member.id); onRemoved(); await refresh(); }} />
            <Button label="Keep" kind="ghost" onPress={() => setConfirmRemove(false)} />
          </>
        ) : <Button label="Remove person" kind="ghost" onPress={() => setConfirmRemove(true)} />}
      </Row>
    </Card>
  );
}


/**
 * Whether this person can open Roam on their own phone, and how to send them
 * the link (owner, 6 Sep 2026: "how can I invite Gina and anyone else that's in
 * my household to the app?").
 *
 * Below their tastes rather than above, because who somebody is comes before
 * how they sign in — and immediately above "Remove person", because taking
 * their sign-in away and removing them are next to each other in the mind and
 * must not be next to each other by accident: one leaves everything they have
 * ever rated in place, the other does not, and both say so before they act.
 *
 * A household member is a full peer once they are in (owner, 6 Sep 2026:
 * "Everything, no exceptions"), so this promises nothing about what they can
 * and cannot do. It says the true thing instead: it is the same Roam.
 *
 * With no sender configured nothing here fails. The link is minted, the screen
 * says plainly that it could not be sent, and shows it to be copied — the rule
 * the group screen and the admin screen already keep, rather than implying that
 * somebody has been texted when nobody has.
 */
function AccessGroup({ member, senders, refresh }: {
  member: Member; senders?: { sms: SenderStatus; email: SenderStatus }; refresh: () => Promise<void>;
}) {
  const access = member.access ?? null;
  const [mobile, setMobile] = useState(access?.mobile ?? '');
  const [email, setEmail] = useState(access?.email ?? '');
  const [open, setOpen] = useQueryState<boolean>('invite', false, asFlag);
  const [busy, setBusy] = useState<null | 'sms' | 'email' | 'both' | 'remove'>(null);
  const [result, setResult] = useState<HouseholdInvitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** What just happened outside the panel — "X can no longer sign in", and so on. */
  const [sent, setSent] = useState<string | null>(null);

  // Keyed on the person and nothing else, deliberately.
  //
  // Sending an invitation calls `refresh()`, which brings back a member whose
  // contact details have just changed — a number typed as `07700 900123` comes
  // back normalised to `+447700900123`. An effect that also watched those would
  // therefore fire on every successful send and clear `result`, which holds the
  // link. With no sender configured that link is the only copy there will ever
  // be: it is minted once, never stored, and shown once. Wiping it here would
  // mean the screen said "copy the link below" and then removed it.
  useEffect(() => {
    setMobile(access?.mobile ?? ''); setEmail(access?.email ?? '');
    setResult(null); setError(null); setCopied(false); setConfirmRemove(false); setSent(null);
  }, [member.id]);

  // Their number and address as the server now holds them, but only into a box
  // nobody has typed into. Somebody halfway through correcting a number must
  // not have it changed underneath them by a refresh happening elsewhere.
  useEffect(() => { if (!mobile && access?.mobile) setMobile(access.mobile); }, [access?.mobile]);
  useEffect(() => { if (!email && access?.email) setEmail(access.email); }, [access?.email]);

  // A profile Roam knows is under thirteen is looked after by an adult (Epic 1
  // C8), so there is nothing to offer — only the reason there is nothing.
  if (access?.blocked) {
    return <Group title="Roam on their own phone"><Text style={type.tiny}>{access.blocked}</Text></Group>;
  }

  const send = async (channels: ('sms' | 'email')[]) => {
    setBusy(channels.length > 1 ? 'both' : channels[0]);
    setError(null); setResult(null); setCopied(false);
    try {
      const r = await api.inviteMember(member.id, { mobile: mobile.trim() || null, email: email.trim() || null, channels });
      setResult(r.invitation);
      await refresh();
    } catch (e: any) {
      setError(e?.body?.message ?? e?.message ?? 'Could not send that.');
    } finally { setBusy(null); }
  };

  const removeAccess = async () => {
    setBusy('remove'); setError(null);
    try { const r = await api.removeMemberAccess(member.id); setResult(null); setConfirmRemove(false); setError(null); await refresh(); setSent(r.message); }
    catch (e: any) { setError(e?.body?.message ?? e?.message ?? 'Could not do that.'); }
    finally { setBusy(null); }
  };

  const invited = access && access.status !== 'none';
  const signedInBefore = (access?.signInCount ?? 0) > 0;

  // What is true right now, in one sentence. Three different facts and each is
  // the one that matters at that moment: never asked, asked and not answered,
  // and in.
  const standing = (() => {
    if (!invited) return `${member.name} can't open Roam yet.`;
    if (access!.status === 'suspended') return `${member.name}'s sign-in is switched off.`;
    if (!signedInBefore) {
      const when = access!.lastInvite?.at ? new Date(access!.lastInvite.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : null;
      return `Invited${when ? ` on ${when}` : ''} — not opened yet.`;
    }
    const seen = access!.lastSeenAt ? new Date(access!.lastSeenAt) : null;
    const today = seen && seen.toDateString() === new Date().toDateString();
    return `Signed in${seen ? `, last here ${today ? 'today' : `on ${seen.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`}` : ''}.`;
  })();

  const canText = Boolean(mobile.trim());
  const canMail = Boolean(email.trim());
  const sendLabel = signedInBefore || invited ? 'Send a new link' : 'Send the invite';

  // Why a message would not leave the building, if it would not — one clause,
  // beside the channel it applies to, so "texts are off" does not appear under
  // an e-mail address that would send perfectly well. The variable names are
  // said once, at the foot of the panel: they are for the one person who can
  // set them, and repeating them beside every box turns a form into a stack
  // trace.
  const warn = (which: 'sms' | 'email') => {
    const s = senders?.[which];
    return s && !s.configured ? <Text style={type.tiny}>{s.short ?? s.message}</Text> : null;
  };
  const missing = (['sms', 'email'] as const).map((k) => senders?.[k]).filter((s) => s && !s.configured);

  return (
    <Group title="Roam on their own phone">
      <Row style={{ gap: spacing.sm }}>
        <Icon name={invited && signedInBefore ? 'check' : invited ? 'send' : 'mobile'} size={16} color={invited && signedInBefore ? colors.accent : colors.headerSub} />
        <Text style={[type.small, { flex: 1 }]}>{standing}</Text>
        {!open ? (
          <Button label={invited ? 'Manage' : 'Invite them'} kind={invited ? 'ghost' : 'secondary'} onPress={() => setOpen(true)} />
        ) : null}
      </Row>
      <Text style={type.tiny}>
        They get the same Roam you do — the same trips, the same saved places, and everybody's tastes and allergies already in it.
      </Text>
      {sent ? <Text style={[type.small, { color: colors.accent }]}>{sent}</Text> : null}

      {open ? (
        <View style={styles.pendingBox}>
          <View style={{ gap: 4 }}>
            <Text style={type.tiny}>Mobile</Text>
            <Row style={{ gap: spacing.sm }}>
              <Icon name="mobile" size={16} color={colors.headerSub} />
              <TextInput
                value={mobile} onChangeText={setMobile} placeholder="07700 900123"
                placeholderTextColor={colors.inkFaint} keyboardType="phone-pad" autoCapitalize="none"
                style={[styles.input, { flex: 1 }]}
                accessibilityLabel={`Mobile number for ${member.name}`}
              />
            </Row>
            {warn('sms')}
          </View>

          <View style={{ gap: 4 }}>
            <Text style={type.tiny}>E-mail</Text>
            <Row style={{ gap: spacing.sm }}>
              <Icon name="mail" size={16} color={colors.headerSub} />
              <TextInput
                value={email} onChangeText={setEmail} placeholder="gina@example.com"
                placeholderTextColor={colors.inkFaint} keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
                style={[styles.input, { flex: 1 }]}
                accessibilityLabel={`E-mail address for ${member.name}`}
              />
            </Row>
            {warn('email')}
          </View>

          <Wrap>
            <Button label={busy === 'sms' ? 'Texting…' : `${sendLabel} by text`} icon="message" disabled={!canText || busy !== null} onPress={() => send(['sms'])} />
            <Button label={busy === 'email' ? 'Sending…' : `${sendLabel} by e-mail`} icon="mail" kind="secondary" disabled={!canMail || busy !== null} onPress={() => send(['email'])} />
            {canText && canMail ? (
              <Button label={busy === 'both' ? 'Sending…' : 'Both'} kind="ghost" disabled={busy !== null} onPress={() => send(['sms', 'email'])} />
            ) : null}
          </Wrap>
          <Text style={type.tiny}>
            {canText || canMail
              ? 'One link, however it goes out — it signs them in on the device they open it on, works once, and lasts a week.'
              : 'Add a mobile number or an e-mail address — a link has to go somewhere.'}
          </Text>
          {/* Said once, and only to whoever can act on it. */}
          {missing.map((s) => <Text key={s!.reason} style={type.tiny}>{s!.setup ?? s!.message}</Text>)}
          {/* Configured, but something about it looks wrong enough to say so
              before a send fails on it. Not an error — the buttons still work. */}
          {(['sms', 'email'] as const).map((k) => senders?.[k]?.caution
            ? <Text key={`caution-${k}`} style={[type.tiny, { color: colors.dislike }]}>{senders[k].caution}</Text>
            : null)}

          {error ? <Text style={[type.small, { color: colors.dislike }]}>{error}</Text> : null}

          {result ? (
            <View style={{ gap: spacing.sm }}>
              <Text style={[type.small, { color: result.sent ? colors.accent : colors.ink }]}>{result.message}</Text>
              {/* Only a real refusal — "Twilio would not take it", "that domain
                  is not verified". A channel that is simply not switched on has
                  already said so twice above, and saying it a third time next to
                  the link buries the link. */}
              {result.channels.filter((c) => !c.sent && c.message && senders?.[c.channel]?.configured).map((c) => (
                <Text key={c.channel} style={[type.tiny, { color: colors.dislike }]}>{c.message}</Text>
              ))}
              {/* Shown once and never stored. With no sender configured this is
                  the only way the invitation reaches anybody. */}
              <Text style={type.tiny} selectable numberOfLines={2}>{result.url}</Text>
              <Row>
                <Button
                  label={copied ? 'Copied' : 'Copy the link'} icon={copied ? 'check' : 'copy'} kind="secondary"
                  onPress={async () => {
                    try { await navigator.clipboard.writeText(result.url); setCopied(true); } catch { setCopied(false); }
                  }}
                />
              </Row>
            </View>
          ) : null}

          <Row style={{ justifyContent: 'space-between' }}>
            <Button label="Done" kind="ghost" onPress={() => { setOpen(false); setResult(null); setError(null); }} />
            {invited && !access?.isLead ? (
              confirmRemove ? (
                <Row style={{ gap: spacing.sm, flexWrap: 'wrap' }}>
                  <Text style={type.small}>Take {member.name}'s sign-in away?</Text>
                  <Button label={busy === 'remove' ? 'Removing…' : 'Yes, remove it'} kind="danger" disabled={busy !== null} onPress={removeAccess} />
                  <Button label="Keep it" kind="ghost" onPress={() => setConfirmRemove(false)} />
                </Row>
              ) : <Button label="Remove their sign-in" kind="ghost" onPress={() => setConfirmRemove(true)} />
            ) : null}
          </Row>
          {invited && !access?.isLead && confirmRemove ? (
            <Text style={type.tiny}>Their profile, tastes and everything they have rated stay exactly where they are. Only the way in goes.</Text>
          ) : null}
        </View>
      ) : null}
    </Group>
  );
}

/** Name, birthday and relationship — below the tastes, saved as they are changed. */
function AboutGroup({ member, relationships, refresh }: { member: Member; relationships: string[]; refresh: () => Promise<void> }) {
  const [name, setName] = useState(member.name);
  const [birth, setBirth] = useState(member.birthDate ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { setName(member.name); setBirth(member.birthDate ?? ''); }, [member.id, member.name, member.birthDate]);

  const flash = (what: string) => { setSaved(what); setTimeout(() => setSaved(null), 1500); };
  const saveName = async () => {
    const t = name.trim();
    if (!t || t === member.name) { setName(member.name); return; }
    await api.updateMember(member.id, { name: t }); await refresh(); flash('Name saved');
  };
  const saveBirth = async () => {
    const t = birth.trim();
    if (t === (member.birthDate ?? '')) return;
    if (t && !DATE.test(t)) { setBirth(member.birthDate ?? ''); return; }
    await api.updateMember(member.id, { birthDate: t || null }); await refresh(); flash(t ? 'Birthday saved' : 'Birthday cleared');
  };
  const ageText = member.age != null ? `${member.age}${member.birthDate ? '' : ' (approx.)'}${member.isMinor ? ' · under 13' : ''}` : null;

  return (
    <Group title="About" hint="Saves as you go.">
      <Row>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={type.tiny}>Name</Text>
          <TextInput value={name} onChangeText={setName} onBlur={saveName} onSubmitEditing={saveName} returnKeyType="done" style={styles.input} />
        </View>
        <View style={{ width: 170, gap: 4 }}>
          <Text style={type.tiny}>Birthday{ageText ? ` · ${ageText}` : ''}</Text>
          <TextInput value={birth} onChangeText={setBirth} onBlur={saveBirth} onSubmitEditing={saveBirth} returnKeyType="done" placeholder="YYYY-MM-DD" placeholderTextColor={colors.inkFaint} style={styles.input} />
        </View>
      </Row>
      <Text style={type.tiny}>Relationship to the household</Text>
      <Wrap>{relationships.map((r) => <Chip key={r} label={RELATIONSHIP_LABEL[r] ?? r} selected={member.relationship === r} onPress={async () => { await api.updateMember(member.id, { relationship: r }); await refresh(); flash('Relationship saved'); }} />)}</Wrap>
      {saved ? <Text style={[type.tiny, { color: colors.like }]}>{saved}</Text> : null}
    </Group>
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
        <Wrap>{member.allergens.map((c) => <Chip key={c.id} label={c.value} tone="allergen" icon="allergen" onRemove={() => remove(c)} />)}</Wrap>
      ) : <Text style={type.tiny}>None recorded.</Text>}
      <Row>
        <TextInput value={v} onChangeText={setV} placeholder="e.g. peanuts, milk, carrots" placeholderTextColor={colors.inkFaint} style={[styles.input, { flex: 1 }]} onSubmitEditing={() => commit(matches.length === 1 ? matches[0] : v)} returnKeyType="done" autoCapitalize="none" />
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
          <Chip key={l.conceptKey} icon={l.kind === 'like' ? 'keep' : 'close'} label={`${l.label} · ${l.count}/${l.threshold}${l.confirmed ? '' : ' learning'}`} tone={l.confirmed ? (l.kind === 'like' ? 'like' : 'dislike') : 'neutral'} />
        ))}
      </Wrap>
    </Group>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 1100, alignSelf: 'center' },
  sidebar: { width: 300, gap: spacing.sm },
  personRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  personRowSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
  pendingBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, gap: spacing.sm },
  // The household's own card. One tree, two shapes: the picture sits above the
  // name on a phone and beside it on a wide window.
  homeCard: { flexDirection: 'column', gap: spacing.md },
  homeCardWide: { flexDirection: 'row', alignItems: 'flex-start' },
  homePhoto: {
    width: '100%', height: 150, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
    backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  homePhotoWide: { width: 240, height: 160 },
  homeName: { fontFamily: fonts.heading, fontSize: 20, fontWeight: '700' },
});

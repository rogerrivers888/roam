import React, { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { api, Constraint, HouseholdResponse, Member } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Chip, Row, Segmented, SectionTitle, Stepper, Wrap, minutes } from '../components/ui';
import { Avatar } from '../components/Faces';

// FDA major allergens. The canonical list is still an open question (Epic 1 Q&A).
const ALLERGENS = ['milk', 'eggs', 'fish', 'shellfish', 'tree nuts', 'peanuts', 'wheat', 'soybeans', 'sesame'];

export function HouseholdScreen({ data, refresh }: { data: HouseholdResponse | null; refresh: () => Promise<void> }) {
  const [newName, setNewName] = useState('');
  const [newMinor, setNewMinor] = useState(false);

  if (!data) return <View style={styles.page}><Text style={type.small}>Loading household…</Text></View>;

  const { household, members } = data;
  const adult = members.find((m) => !m.isMinor);

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={type.title}>{household.name}</Text>
      <Text style={type.small}>What Roam knows about the family. Allergens exclude places; dislikes and likes only rank them.</Text>

      {members.map((m, i) => (
        <MemberCard key={m.id} member={m} index={i} managedBy={m.isMinor ? adult?.name : undefined} refresh={refresh} />
      ))}

      <Card>
        <Text style={type.h3}>Add someone</Text>
        <Row>
          <TextInput value={newName} onChangeText={setNewName} placeholder="Name" placeholderTextColor={colors.inkFaint} style={styles.input} />
          <Row><Text style={type.small}>Under 13</Text><Switch value={newMinor} onValueChange={setNewMinor} /></Row>
        </Row>
        {newMinor ? <Text style={type.tiny}>A child's record is owned by an adult. No login, no voice capture, edited only here.</Text> : null}
        <Button label="Add" disabled={!newName.trim()} onPress={async () => {
          await api.addMember({ name: newName.trim(), isMinor: newMinor });
          setNewName(''); setNewMinor(false);
          await refresh();
        }} />
      </Card>

      <SectionTitle hint="Applied to every plan unless you change them for one outing.">Our pace</SectionTitle>
      <Card>
        <Text style={type.body}>
          We usually spend <Text style={{ fontWeight: '700' }}>about {minutes(household.defaultVisitMinutes)}</Text> at a place and will travel <Text style={{ fontWeight: '700' }}>up to {minutes(household.maxTravelMinutes)}</Text>.
        </Text>
        <Stepper label="Time at a place" value={household.defaultVisitMinutes} min={15} max={240} step={15} format={minutes}
          onChange={async (v) => { await api.updateHousehold({ defaultVisitMinutes: v }); await refresh(); }} />
        <Stepper label="Max travelling" value={household.maxTravelMinutes} min={10} max={180} step={5} format={minutes}
          onChange={async (v) => { await api.updateHousehold({ maxTravelMinutes: v }); await refresh(); }} />
        <Text style={[type.small, { marginTop: 4 }]}>How full we like a day</Text>
        <Segmented value={household.defaultIntensity}
          options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'packed', label: 'Packed' }]}
          onChange={async (v) => { await api.updateHousehold({ defaultIntensity: v }); await refresh(); }} />
      </Card>
    </ScrollView>
  );
}

function MemberCard({ member, index, managedBy, refresh }: { member: Member; index: number; managedBy?: string; refresh: () => Promise<void> }) {
  const [kind, setKind] = useState<Constraint['kind']>('allergen');
  const [value, setValue] = useState('');

  const add = async (v: string) => {
    if (!v.trim()) return;
    await api.addConstraint(member.id, { kind, value: v.trim() });
    setValue('');
    await refresh();
  };
  const remove = async (c: Constraint) => { await api.deleteConstraint(c.id); await refresh(); };

  return (
    <Card>
      <Row>
        <Avatar name={member.name} index={index} />
        <View style={{ flex: 1 }}>
          <Text style={type.h3}>{member.name}</Text>
          {managedBy ? <Text style={type.tiny}>Managed by {managedBy}</Text> : null}
        </View>
        <Button label="Remove" kind="ghost" onPress={async () => { await api.deleteMember(member.id); await refresh(); }} />
      </Row>

      <ConstraintGroup title="Allergens — will exclude places" tone="allergen" items={member.allergens} onRemove={remove} empty="None recorded" />
      <ConstraintGroup title="Dislikes — will rank places lower" tone="dislike" items={member.dislikes} onRemove={remove} empty="None" />
      <ConstraintGroup title="Likes — will rank places higher" tone="like" items={member.likes} onRemove={remove} empty="None yet — visits will teach this" />

      <Segmented value={kind}
        options={[{ value: 'allergen', label: 'Allergen' }, { value: 'dislike', label: 'Dislike' }, { value: 'like', label: 'Like' }]}
        onChange={setKind} />
      {kind === 'allergen' ? (
        <Wrap>
          {ALLERGENS.filter((a) => !member.allergens.some((c) => c.value === a)).map((a) => (
            <Chip key={a} label={a} tone="allergen" onPress={() => add(a)} />
          ))}
        </Wrap>
      ) : (
        <Row>
          <TextInput value={value} onChangeText={setValue} placeholder={kind === 'like' ? 'e.g. ramen, museums, live music' : 'e.g. pubs, spicy food'}
            placeholderTextColor={colors.inkFaint} style={styles.input} onSubmitEditing={() => add(value)} returnKeyType="done" />
          <Button label="Add" kind="secondary" onPress={() => add(value)} disabled={!value.trim()} />
        </Row>
      )}
    </Card>
  );
}

function ConstraintGroup({ title, tone, items, onRemove, empty }: {
  title: string; tone: 'allergen' | 'dislike' | 'like'; items: Constraint[]; onRemove: (c: Constraint) => void; empty: string;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={type.tiny}>{title}</Text>
      {items.length ? (
        <Wrap>{items.map((c) => <Chip key={c.id} label={c.value} tone={tone} icon={tone === 'allergen' ? '⚠' : undefined} onRemove={() => onRemove(c)} />)}</Wrap>
      ) : <Text style={type.small}>{empty}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md, maxWidth: 760, width: '100%', alignSelf: 'center' },
  input: {
    flex: 1, minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
  },
});

import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, DishNote, HouseholdResponse, Member, MenuItem, MenuLink, Order, OrderItem, ReadMenu } from '../api';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { useViewport } from '../hooks/useViewport';
import { Icon } from './Icon';
import { Button, Card, Chip, Row, Segmented, Wrap } from './ui';

/**
 * The table half of an evening (owner, 4 Sep 2026): "surface the functionality
 * where I can go through the menu and tick who wants what. It will create it as
 * an order that I can then read to the waiter. After that, I can go in and
 * review or give stars to the particular dishes that we had."
 *
 * Four steps, one screen: the menu (read from the restaurant's own page, not
 * photographed), the order grouped by person, a staff view in big type, and
 * stars afterwards.
 *
 * The rating rule is the owner's and it is deliberately sparse: stars mean
 * good, a dish nobody touches counts as fine and writes nothing, and "not
 * great" is one tap that only then asks why.
 *
 * Allergens exclude and dislikes rank, and they never share a control or a
 * colour (CLAUDE.md). An allergen the menu declares strikes the dish out in the
 * warning red; an allergen that is only *likely* — carrot in a ragù, which no
 * menu has to declare — can never be a clearance, so it asks.
 */

type Step = 'menu' | 'order' | 'staff' | 'rate' | 'saved';
type Picks = Record<string, { members: Record<string, boolean>; table: boolean; note: string }>;
type Marks = Record<string, { stars: number; notGreat: boolean; comment: string; concept: boolean }>;

/** Ingredients that carry an allergen without naming it. A prompt, never a clearance. */
const HIDDEN: Record<string, string[]> = {
  carrot: ['soffritto', 'ragù', 'ragu', 'bolognese', 'minestrone', 'stock', 'broth', 'mirepoix', 'slaw', 'stew'],
  celery: ['soffritto', 'stock', 'broth', 'mirepoix', 'bolognese', 'ragù', 'ragu'],
  egg: ['mayonnaise', 'aioli', 'carbonara', 'meringue', 'custard', 'brioche'],
  milk: ['butter', 'cream', 'cheese', 'parmigiano', 'mozzarella', 'burrata', 'gelato', 'béchamel'],
  peanut: ['satay'],
  sesame: ['tahini', 'hummus'],
  fish: ['anchov', 'worcestershire', 'caesar', 'bisque', 'nduja'],
  gluten: ['pasta', 'bread', 'bruschetta', 'pizza', 'breadcrumb', 'flour', 'batter'],
};
const MEAT = ['prosciutto', 'ragù', 'ragu', 'bolognese', 'guanciale', 'beef', 'manzo', 'pollo', 'chicken', 'polpette', 'pork', 'bresaola', 'salame', 'ham', 'bacon', 'lamb', 'duck', 'steak', 'meat', 'carbonara'];
const FISHY = ['fish', 'tuna', 'anchov', 'crab', 'granchio', 'prawn', 'seafood', 'squid', 'octopus', 'mussel', 'clam', 'salmon', 'cod'];

const words = (item: MenuItem) => `${item.name} ${item.description ?? ''}`.toLowerCase();
/**
 * Vegetarian gets one letter after the name rather than a row per person
 * (owner, 4 Sep 2026). The menu's own mark is taken when it makes one; where it
 * says nothing, a dish with meat or fish in it is not vegetarian and a dish
 * with a description and none of either is — a dish with no description at all
 * gets no letter, because silence is not a claim.
 */
const isVeg = (item: MenuItem) => {
  if (item.vegetarian != null) return item.vegetarian;
  const text = words(item);
  if (MEAT.some((w) => text.includes(w)) || FISHY.some((w) => text.includes(w))) return false;
  return item.description ? true : null;
};
const singular = (s: string) => s.replace(/s$/, '');

type Flag = { kind: 'allergen' | 'check' | 'dislike'; who: string; text: string };

/** Only the flags that concern the people at this table, so they stay rare enough to read. */
function flagsFor(item: MenuItem, members: Member[]): Flag[] {
  const text = words(item);
  const declared = (item.allergens ?? '').toLowerCase();
  const out: Flag[] = [];
  for (const m of members) {
    const first = m.name.split(' ')[0];
    for (const a of m.allergens ?? []) {
      const term = singular(a.value.toLowerCase());
      if (declared && declared.includes(term)) { out.push({ kind: 'allergen', who: first, text: `${a.value} — the menu says so` }); continue; }
      if (text.includes(term)) { out.push({ kind: 'check', who: first, text: `${a.value} — ask` }); continue; }
      const hidden = (HIDDEN[term] ?? []).find((h) => text.includes(h));
      if (hidden) out.push({ kind: 'check', who: first, text: `${a.value}? ${hidden} — ask` });
    }
    for (const d of m.dislikes ?? []) {
      const term = singular(d.value.toLowerCase());
      const hit = text.includes(term) || (/(fish|seafood)/.test(term) && FISHY.some((w) => text.includes(w)));
      if (hit) out.push({ kind: 'dislike', who: first, text: d.value });
    }
  }
  return out;
}

const FLAG_STYLE = {
  allergen: { border: colors.allergen, bg: colors.allergenSoft, fg: colors.allergen, icon: 'allergen' as const },
  check: { border: colors.ink, bg: 'transparent', fg: colors.ink, icon: 'allergen' as const },
  dislike: { border: colors.line, bg: 'transparent', fg: colors.inkMuted, icon: 'info' as const },
};

function FlagChip({ flag }: { flag: Flag }) {
  const s = FLAG_STYLE[flag.kind];
  return (
    <View style={[styles.flag, { borderColor: s.border, backgroundColor: s.bg }]}>
      <Icon name={s.icon} size={11} color={s.fg} />
      <Text style={[styles.flagText, { color: s.fg }]}>{flag.who} · {flag.text}</Text>
    </View>
  );
}

/** A face is one person wanting one dish; "Table" is a plate to share. */
function Face({ label, on, onPress, size = 30 }: { label: string; on: boolean; onPress: () => void; size?: number }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      style={[styles.face, { width: size, height: size, borderRadius: size / 2 }, on && styles.faceOn]}
    >
      <Text style={[styles.faceText, on && styles.faceTextOn]}>{label[0]}</Text>
    </Pressable>
  );
}

const money = (n: number) => `£${n.toFixed(2).replace(/\.00$/, '')}`;

export function MenuOrder({ venueRef, venueLabel, website, onClose }: {
  venueRef: string;
  venueLabel: string;
  website?: string | null;
  onClose: () => void;
}) {
  const { width, height, framed, origin } = useViewport();
  const wide = width >= 900;
  const frameBox = framed && origin
    ? { position: 'absolute' as const, left: origin.x, top: origin.y, width, height, borderRadius: radius.lg, overflow: 'hidden' as const }
    : null;

  const [step, setStep] = useState<Step>('menu');
  const [menu, setMenu] = useState<ReadMenu | null | undefined>(undefined);
  const [link, setLink] = useState<MenuLink | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [how, setHow] = useState<string[]>([]);
  const [household, setHousehold] = useState<HouseholdResponse | null>(null);
  const [section, setSection] = useState<string | null>(null);
  const [picks, setPicks] = useState<Picks>({});
  const [order, setOrder] = useState<Order | null>(null);
  const [marks, setMarks] = useState<Marks>({});
  const [staffBy, setStaffBy] = useState<'person' | 'course'>('person');
  const [busy, setBusy] = useState(false);
  // An order that was already here when the screen opened is one the table has
  // placed; the meal comes after it, so that is the only one offered "we ate
  // it" (owner, 4 Sep 2026). One being written now is still being written.
  const [resumed, setResumed] = useState(false);
  // A note for the waiter is a fallback for the one you can write while
  // ordering, so it hides behind a pencil rather than taking a row on every
  // line (owner, 4 Sep 2026).
  const [noting, setNoting] = useState<Record<string, boolean>>({});
  // "What's this?": a menu often gives a name in another language and nothing
  // else. Asked for one dish at a time, on a tap, and kept once written.
  const [asked, setAsked] = useState<Record<string, DishNote | 'asking' | 'failed'>>({});

  useEffect(() => {
    let live = true;
    api.household().then((h) => live && setHousehold(h)).catch(() => {});
    api.heldMenu(venueRef)
      .then((d) => { if (!live) return; setMenu(d.menu); setLink(d.link ?? null); setSection(d.menu?.sections[0]?.title ?? null); })
      .catch((e) => { if (live) { setMenu(null); setError(e.message); } });
    api.order(venueRef).then((d) => {
      if (!live || !d.order || d.order.visitId) return;
      setOrder(d.order);
      setResumed(true);
      setStep('order');
      // The picks are what the menu draws and what saving writes, so an order
      // that came back from the server has to become picks again or editing it
      // would quietly wipe it.
      setPicks(Object.fromEntries(d.order.items.reduce((map, i) => {
        if (!i.menuItemId) return map;
        const at = map.get(i.menuItemId) ?? { members: {} as Record<string, boolean>, table: false, note: '' };
        if (i.memberId) at.members[i.memberId] = true; else at.table = true;
        if (i.note) at.note = i.note;
        return map.set(i.menuItemId, at);
      }, new Map<string, Picks[string]>())));
    }).catch(() => {});
    return () => { live = false; };
  }, [venueRef]);

  const members = household?.members ?? [];
  const sections = menu?.sections ?? [];
  const shown = sections.find((s) => s.title === section) ?? sections[0];
  const itemsById = useMemo(() => {
    const map = new Map<string, MenuItem & { section: string }>();
    for (const s of sections) for (const i of s.items) map.set(i.id, { ...i, section: s.title });
    return map;
  }, [menu]);

  const rowsFrom = (from: Picks) => {
    const rows: { itemId: string; memberId: string | null; note: string }[] = [];
    for (const [itemId, p] of Object.entries(from)) {
      if (!itemsById.has(itemId)) continue;
      if (p.table) rows.push({ itemId, memberId: null, note: p.note });
      for (const m of members) if (p.members[m.id]) rows.push({ itemId, memberId: m.id, note: p.note });
    }
    return rows;
  };
  const chosen = useMemo(() => rowsFrom(picks), [picks, itemsById, members]);
  const total = chosen.reduce((n, r) => n + (itemsById.get(r.itemId)?.price ?? 0), 0);

  const pickOf = (id: string) => picks[id] ?? { members: {}, table: false, note: '' };
  const setPick = (id: string, next: Partial<{ members: Record<string, boolean>; table: boolean; note: string }>) =>
    setPicks((p) => ({ ...p, [id]: { ...pickOf(id), ...next } }));

  async function whatIsThis(item: MenuItem) {
    if (asked[item.id]) { setAsked(({ [item.id]: _drop, ...rest }) => rest); return; }   // tapping again folds it away
    setAsked((a) => ({ ...a, [item.id]: 'asking' }));
    try {
      const d = await api.dishNote(item.name, venueLabel);
      setAsked((a) => ({ ...a, [item.id]: d.dish }));
    } catch {
      setAsked((a) => ({ ...a, [item.id]: 'failed' }));
    }
  }

  async function readTheMenu() {
    setReading(true); setError(null); setHow([]);
    try {
      const d = await api.readMenu({ ref: venueRef, label: venueLabel, website: website ?? undefined, url: link?.url ?? undefined });
      setMenu(d.menu); setSection(d.menu.sections[0]?.title ?? null); setHow(d.menu.how ?? []);
    } catch (e: any) {
      setError(e.message || 'Their menu would not open.');
      setHow(e.body?.how ?? []);
    } finally {
      setReading(false);
    }
  }

  async function writeOrder(from: Picks = picks) {
    const d = await api.saveOrder({
      clientId: order?.clientId ?? undefined,
      ref: venueRef,
      label: venueLabel,
      menuId: menu?.id ?? null,
      items: rowsFrom(from).map((r) => {
        const item = itemsById.get(r.itemId)!;
        return { menuItemId: item.id, memberId: r.memberId, name: item.name, priceText: item.priceText, note: r.note || null };
      }),
    });
    setOrder(d.order);
    return d.order;
  }

  async function toTheOrder() {
    setBusy(true);
    try { await writeOrder(); setStep('order'); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  /** Take one thing off the order, from the order itself. */
  async function removeFromOrder(item: OrderItem) {
    if (!item.menuItemId) return;
    const p = pickOf(item.menuItemId);
    const next: Picks = {
      ...picks,
      [item.menuItemId]: item.memberId
        ? { ...p, members: { ...p.members, [item.memberId]: false } }
        : { ...p, table: false },
    };
    setPicks(next);
    setBusy(true);
    try { await writeOrder(next); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  /** A word for the waiter, changed on the order rather than back on the menu. */
  async function noteOnOrder(item: OrderItem, note: string) {
    if (!item.menuItemId) return;
    const next: Picks = { ...picks, [item.menuItemId]: { ...pickOf(item.menuItemId), note } };
    setPicks(next);
    try { await writeOrder(next); } catch (e: any) { setError(e.message); }
  }

  /** The table changed its mind: the order in progress goes, the menu stays. */
  async function startAgain() {
    setBusy(true);
    try {
      if (order && !order.visitId) await api.clearOrder(order.id);
      setOrder(null); setPicks({}); setMarks({}); setResumed(false); setStep('menu');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function weAteIt() {
    if (!order) return;
    setBusy(true);
    try {
      const d = order.visitId ? { order } : await api.orderEaten(order.id);
      setOrder(d.order);
      setStep('rate');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function saveStars() {
    if (!order) return;
    setBusy(true);
    try {
      const d = await api.rateOrder(order.id, order.items.map((i) => {
        const m = marks[i.id] ?? { stars: 0, notGreat: false, comment: '', concept: false };
        return {
          orderItemId: i.id,
          score: m.stars || null,
          notGreat: m.notGreat,
          comment: m.comment || null,
          conceptKey: m.concept ? i.conceptSuggestion?.key ?? null : null,
        };
      }));
      setOrder(d.order);
      setStep('saved');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  // Keep the screen awake while it is being read across a table.
  useEffect(() => {
    if (step !== 'staff' || typeof navigator === 'undefined') return;
    let lock: any;
    (navigator as any).wakeLock?.request?.('screen').then((l: any) => { lock = l; }).catch(() => {});
    return () => { lock?.release?.().catch(() => {}); };
  }, [step]);

  const groups = useMemo(() => {
    const list = order?.items ?? [];
    return [{ id: null as string | null, name: 'For the table' }, ...members.map((m) => ({ id: m.id as string | null, name: m.name.split(' ')[0] }))]
      .map((g) => ({ ...g, items: list.filter((i) => i.memberId === g.id) }))
      .filter((g) => g.items.length || g.id !== null);
  }, [order, members]);

  const allergenLines = members
    .flatMap((m) => (m.allergens ?? []).map((a) => `${m.name.split(' ')[0]} is allergic to ${a.value.toLowerCase()}.`));
  const dietLines = members
    .flatMap((m) => (m.diets ?? []).map((d) => `${m.name.split(' ')[0]} is ${d.value.toLowerCase()}.`));

  const header = (title: string, sub: string | null, back?: () => void) => (
    <Row style={{ alignItems: 'flex-start' }}>
      <View style={{ flex: 1, gap: 2 }}>
        {back ? (
          <Pressable onPress={back} accessibilityRole="button" style={styles.backRow}>
            <Icon name="back" size={14} /><Text style={type.tiny}>Back</Text>
          </Pressable>
        ) : null}
        <Text style={type.title}>{title}</Text>
        {sub ? <Text style={type.small}>{sub}</Text> : null}
      </View>
      <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close">
        <Icon name="close" size={22} color={colors.ink} />
      </Pressable>
    </Row>
  );

  return (
    <Modal visible transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
      <View style={styles.backdropWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.panel, wide ? styles.panelSide : styles.panelSheet, frameBox]}>

          {/* ------------------------------------------------------- the menu */}
          {step === 'menu' ? (
            <>
              <ScrollView contentContainerStyle={styles.body}>
                {header(venueLabel, menu ? `Menu · ${menu.items} things · read ${menu.ageDays === 0 ? 'today' : `${menu.ageDays} days ago`}` : 'Menu')}

                {menu === undefined ? <Text style={type.small}>Looking for the menu we hold…</Text> : null}

                {menu === null ? (
                  <Card>
                    <Text style={type.h3}>Read their menu</Text>
                    {link?.url ? (
                      <Text style={type.small}>{link.how ?? `Their menu is at ${link.url.replace(/^https?:\/\//, '').slice(0, 60)}.`}</Text>
                    ) : (
                      <Text style={type.small}>{link?.why ?? 'We will follow the website Google gave us and look for their menu.'}</Text>
                    )}
                    <Text style={type.tiny}>
                      Roam opens their own page — a PDF is read, a page that draws itself is rendered in a browser, and only a menu
                      that will not open any other way is read by Claude. Nobody has to photograph anything.
                    </Text>
                    {how.length ? <Text style={type.tiny}>{how.join(' · ')}</Text> : null}
                    {error ? <Text style={[type.small, { color: colors.allergen }]}>{error}</Text> : null}
                    <Wrap>
                      <Button label={reading ? 'Reading their menu…' : 'Read their menu'} icon="restaurant" onPress={readTheMenu} disabled={reading} />
                      {reading ? <ActivityIndicator color={colors.icon} /> : null}
                    </Wrap>
                  </Card>
                ) : null}

                {menu ? (
                  <>
                    <Text style={type.tiny}>
                      {menu.how?.join(' · ')} · {new URL(menu.sourceUrl).hostname}
                      {menu.stale ? ` · prices as printed ${menu.ageDays} days ago` : ''}
                    </Text>
                    {menu.note ? <Text style={type.small}>{menu.note}</Text> : null}
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
                      {sections.map((s) => (
                        <Chip key={s.title} label={s.title} selected={s.title === shown?.title} onPress={() => setSection(s.title)} />
                      ))}
                    </ScrollView>
                    {shown?.note ? <Text style={type.tiny}>{shown.note}</Text> : null}
                    <Text style={type.tiny}>(V) is vegetarian.{dietLines.length ? ` ${dietLines.join(' ')}` : ''}</Text>
                    {shown?.items.map((item) => {
                      const p = pickOf(item.id);
                      const flags = flagsFor(item, members);
                      const picked = p.table || members.some((m) => p.members[m.id]);
                      return (
                        <View key={item.id} style={[styles.row, picked && styles.rowPicked]}>
                          <Row style={{ alignItems: 'flex-start' }}>
                            <Text style={[type.body, styles.itemName]}>
                              {item.name}
                              {isVeg(item) ? <Text style={styles.veg}> (V)</Text> : null}
                            </Text>
                            <Text style={styles.price}>{item.priceText ?? ''}</Text>
                            <Pressable
                              onPress={() => whatIsThis(item)}
                              accessibilityRole="button"
                              accessibilityLabel={`What is ${item.name}?`}
                              style={styles.rowBtn}
                            >
                              <Icon name="info" size={14} color={asked[item.id] ? colors.icon : colors.inkMuted} />
                            </Pressable>
                          </Row>
                          {item.description ? <Text style={type.small}>{item.description}</Text> : null}
                          {asked[item.id] ? (
                            <View style={styles.whatIs}>
                              {asked[item.id] === 'asking' ? <Text style={type.tiny}>Looking it up…</Text> : null}
                              {asked[item.id] === 'failed' ? <Text style={type.tiny}>Could not look that one up just now.</Text> : null}
                              {typeof asked[item.id] === 'object' ? (
                                <>
                                  <Text style={type.small}>
                                    {(asked[item.id] as DishNote).known
                                      ? (asked[item.id] as DishNote).what
                                      : `Not a dish Roam knows — ask at the table. ${(asked[item.id] as DishNote).what}`}
                                  </Text>
                                  {(asked[item.id] as DishNote).origin ? <Text style={type.tiny}>{(asked[item.id] as DishNote).origin}</Text> : null}
                                  <Text style={type.tiny}>Roam's own words about the dish, not the restaurant's.</Text>
                                </>
                              ) : null}
                            </View>
                          ) : null}
                          {item.kcal || item.allergens ? (
                            <Text style={type.tiny}>
                              {item.kcal ? `${item.kcal} kcal` : ''}{item.kcal && item.allergens ? ' · ' : ''}{item.allergens ?? ''}
                            </Text>
                          ) : null}
                          {flags.length ? <Wrap>{flags.map((f, i) => <FlagChip key={i} flag={f} />)}</Wrap> : null}
                          <Row style={{ flexWrap: 'wrap', gap: 6 }}>
                            {members.map((m) => (
                              <Face key={m.id} label={m.name} on={!!p.members[m.id]}
                                onPress={() => setPick(item.id, { members: { ...p.members, [m.id]: !p.members[m.id] } })} />
                            ))}
                            <Chip label="Table" icon="household" selected={p.table} onPress={() => setPick(item.id, { table: !p.table })} />
                            {picked ? (
                              <TextInput
                                value={p.note}
                                onChangeText={(t) => setPick(item.id, { note: t })}
                                placeholder="no chilli"
                                placeholderTextColor={colors.inkFaint}
                                style={styles.noteInput}
                                accessibilityLabel={`A word about ${item.name}`}
                              />
                            ) : null}
                          </Row>
                        </View>
                      );
                    })}
                  </>
                ) : null}
              </ScrollView>
              {menu ? (
                <View style={styles.bar}>
                  <View style={{ flex: 1 }}>
                    <Text style={type.body}>
                      {chosen.length ? `${chosen.length} ${chosen.length === 1 ? 'thing' : 'things'}${total ? ` · ${money(total)}` : ''}` : 'Nothing chosen yet'}
                    </Text>
                    <Text style={type.tiny}>
                      {!chosen.length ? 'Tap a face on a dish' : total ? 'Tap to check it over' : 'Priced by the set menu — tap to check it over'}
                    </Text>
                  </View>
                  <Button label="The order" icon="forward" onPress={toTheOrder} disabled={!chosen.length || busy} />
                </View>
              ) : null}
            </>
          ) : null}

          {/* ------------------------------------------------------ the order */}
          {step === 'order' && order ? (
            <>
              <ScrollView contentContainerStyle={styles.body}>
                {header('The order', `${venueLabel}${resumed ? ' · placed earlier' : ''}`, () => setStep('menu'))}
                {groups.map((g) => (
                  <View key={g.id ?? 'table'} style={{ gap: 4 }}>
                    <Row>
                      {g.id ? <Face label={g.name} on onPress={() => {}} size={26} /> : <Icon name="household" size={18} />}
                      <Text style={type.h3}>{g.name}</Text>
                    </Row>
                    {g.items.length ? g.items.map((i) => (
                      <View key={i.id} style={styles.orderRow}>
                        <Row style={{ alignItems: 'center' }}>
                          <Text style={[type.body, { flex: 1 }]}>{i.name}</Text>
                          <Text style={type.small}>{i.priceText ?? ''}</Text>
                          <Pressable
                            onPress={() => setNoting((n) => ({ ...n, [i.id]: !n[i.id] }))}
                            accessibilityRole="button"
                            accessibilityLabel={`${i.note ? 'Change the' : 'Add a'} word for the waiter about ${i.name}`}
                            style={styles.rowBtn}
                          >
                            <Icon name="edit" size={14} color={i.note ? colors.icon : colors.inkMuted} />
                          </Pressable>
                          <Pressable
                            onPress={() => removeFromOrder(i)}
                            disabled={busy}
                            accessibilityRole="button"
                            accessibilityLabel={`Take ${i.name} off the order`}
                            style={styles.rowBtn}
                          >
                            <Icon name="close" size={15} color={colors.inkMuted} />
                          </Pressable>
                        </Row>
                        {i.note && !noting[i.id] ? <Text style={type.tiny}>{i.note}</Text> : null}
                        {noting[i.id] ? (
                          <TextInput
                            defaultValue={i.note ?? ''}
                            autoFocus
                            onEndEditing={(e) => { noteOnOrder(i, e.nativeEvent.text); setNoting((n) => ({ ...n, [i.id]: false })); }}
                            onBlur={(e: any) => { noteOnOrder(i, e?.nativeEvent?.text ?? ''); setNoting((n) => ({ ...n, [i.id]: false })); }}
                            placeholder="a word for the waiter"
                            placeholderTextColor={colors.inkFaint}
                            style={[styles.noteInput, { marginTop: 4 }]}
                            accessibilityLabel={`A word about ${i.name}`}
                          />
                        ) : null}
                      </View>
                    )) : <Text style={type.tiny}>Nothing yet</Text>}
                  </View>
                ))}
                {order.total ? (
                  <Row style={styles.totalRow}>
                    <Text style={type.h3}>Total</Text><Text style={type.h3}>{money(order.total)}</Text>
                  </Row>
                ) : (
                  <Text style={type.tiny}>These courses are priced by the set menu, not one by one, so there is no total to show.</Text>
                )}
                {allergenLines.length ? (
                  <View style={styles.warn}>
                    <Icon name="allergen" size={14} color={colors.allergen} />
                    <Text style={[type.small, { color: colors.allergen, flex: 1 }]}>
                      {allergenLines.join(' ')} Roam can never clear a dish of an allergen a menu does not have to declare — ask at the table.
                    </Text>
                  </View>
                ) : null}
                {dietLines.length ? <Text style={type.tiny}>{dietLines.join(' ')}</Text> : null}
                {resumed ? (
                  <Card>
                    <Text style={type.small}>
                      This order was already here. When you have eaten it, say so and star whatever stood out.
                    </Text>
                    <Wrap>
                      <Button label="We ate it" icon="favourite" kind="secondary" onPress={weAteIt} disabled={busy} />
                    </Wrap>
                  </Card>
                ) : null}
              </ScrollView>
              <View style={styles.bar}>
                <Pressable
                  onPress={startAgain}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Start again"
                  style={styles.barIcon}
                >
                  <Icon name="refresh" size={18} color={colors.ink} />
                </Pressable>
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <Button label="Add/Change" icon="edit" kind="secondary" style={styles.barBtn} onPress={() => setStep('menu')} disabled={busy} />
                </View>
                <Button label="Show staff" icon="list" style={styles.barBtn} onPress={() => setStep('staff')} disabled={!order.items.length} />
              </View>
            </>
          ) : null}

          {/* --------------------------------------------- the waiter's screen */}
          {step === 'staff' && order ? (
            <ScrollView contentContainerStyle={[styles.body, { gap: spacing.sm }]}>
              <Row style={{ alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Segmented
                    value={staffBy}
                    onChange={setStaffBy}
                    options={[{ value: 'person', label: 'By person' }, { value: 'course', label: 'By course' }]}
                  />
                </View>
                <Pressable onPress={() => setStep('order')} style={styles.close} accessibilityRole="button" accessibilityLabel="Close">
                  <Icon name="close" size={22} color={colors.ink} />
                </Pressable>
              </Row>
              {staffBy === 'person'
                ? groups.filter((g) => g.items.length).map((g) => (
                    <View key={g.id ?? 'table'} style={{ gap: 2 }}>
                      <Text style={styles.staffWho}>{g.name}</Text>
                      {g.items.map((i) => (
                        <View key={i.id}>
                          <Text style={styles.staffDish}>{i.name}</Text>
                          {i.note ? <Text style={type.small}>{i.note}</Text> : null}
                        </View>
                      ))}
                    </View>
                  ))
                : [...new Set(order.items.map((i) => itemsById.get(i.menuItemId ?? '')?.section ?? 'Ordered'))].map((sec) => (
                    <View key={sec} style={{ gap: 2 }}>
                      <Text style={styles.staffWho}>{sec}</Text>
                      {order.items
                        .filter((i) => (itemsById.get(i.menuItemId ?? '')?.section ?? 'Ordered') === sec)
                        .map((i) => (
                          <View key={i.id}>
                            <Text style={styles.staffDish}>{i.name}</Text>
                            <Text style={type.small}>{i.member ? `for ${i.member.split(' ')[0]}` : 'for the table'}{i.note ? ` · ${i.note}` : ''}</Text>
                          </View>
                        ))}
                    </View>
                  ))}
              {allergenLines.length ? (
                <View style={styles.staffAlert}>
                  <Text style={styles.staffAlertText}>{allergenLines.join(' ')} Please check anything cooked in a stock or a soffritto.</Text>
                </View>
              ) : null}
              {dietLines.length ? <Text style={styles.staffDiet}>{dietLines.join(' ')}</Text> : null}
              <Text style={type.tiny}>Big type, no chrome, the screen stays awake. Works with no signal.</Text>
            </ScrollView>
          ) : null}

          {/* ---------------------------------------------------- the stars */}
          {step === 'rate' && order ? (
            <>
              <ScrollView contentContainerStyle={styles.body}>
                {header('How was it?', venueLabel, () => setStep('order'))}
                <Card>
                  <Text style={type.small}>
                    <Text style={{ fontWeight: '700' }}>Only star what stood out.</Text> Anything you leave alone is taken as fine —
                    that is the answer for most plates. Say so only when it was not.
                  </Text>
                </Card>
                {order.items.map((i) => {
                  const m = marks[i.id] ?? { stars: 0, notGreat: false, comment: '', concept: false };
                  const set = (next: Partial<typeof m>) => setMarks((s) => ({ ...s, [i.id]: { ...m, ...next } }));
                  return (
                    <View key={i.id} style={styles.row}>
                      <Row>
                        {i.member ? <Face label={i.member} on onPress={() => {}} size={26} /> : <Icon name="household" size={16} />}
                        <Text style={[type.body, { flex: 1 }]}>{i.name}</Text>
                      </Row>
                      <Row style={{ gap: spacing.md }}>
                        <Row style={{ gap: 2 }}>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <Pressable key={n} onPress={() => set({ stars: m.stars === n ? 0 : n, notGreat: false })}
                              accessibilityRole="button" accessibilityLabel={`${n} star${n > 1 ? 's' : ''} for ${i.name}`} hitSlop={4}>
                              <Icon name="favourite" size={24} fill={m.stars >= n} color={m.stars >= n ? colors.rating : colors.inkFaint} />
                            </Pressable>
                          ))}
                        </Row>
                        <Chip label="Not great" icon="close" selected={m.notGreat} onPress={() => set({ notGreat: !m.notGreat, stars: 0 })} />
                      </Row>
                      {m.stars || m.notGreat ? (
                        <>
                          <TextInput
                            value={m.comment}
                            onChangeText={(t) => set({ comment: t })}
                            placeholder={m.notGreat ? 'what was wrong with it?' : 'what made it good?'}
                            placeholderTextColor={colors.inkFaint}
                            style={[styles.noteInput, { flex: 1, width: '100%' }]}
                            accessibilityLabel={`A word about ${i.name}`}
                          />
                          {i.conceptSuggestion ? (
                            <Chip
                              label={`This is ${i.conceptSuggestion.label.toLowerCase()}`}
                              icon={m.concept ? 'check' : 'add'}
                              selected={m.concept}
                              onPress={() => set({ concept: !m.concept })}
                            />
                          ) : i.concept ? (
                            <Text style={type.tiny}>→ {i.concept.label}, so it counts everywhere</Text>
                          ) : null}
                        </>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
              <View style={styles.bar}>
                <View style={{ flex: 1 }}>
                  <Text style={type.body}>
                    {Object.values(marks).filter((m) => m.stars).length} starred · {Object.values(marks).filter((m) => m.notGreat).length} not great
                  </Text>
                  <Text style={type.tiny}>{order.items.length - Object.values(marks).filter((m) => m.stars || m.notGreat).length} left as fine</Text>
                </View>
                <Button label="Save" icon="check" onPress={saveStars} disabled={busy} />
              </View>
            </>
          ) : null}

          {/* ----------------------------------------------------- what it kept */}
          {step === 'saved' && order ? (
            <ScrollView contentContainerStyle={styles.body}>
              {header('Saved', `${venueLabel} · the visit is in Places`)}
              {order.items.map((i) => {
                const r = i.ratings[0];
                return (
                  <Row key={i.id} style={styles.orderRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={type.body}>{i.name}</Text>
                      <Text style={type.tiny}>
                        {r?.score ? `liked by ${i.member?.split(' ')[0] ?? 'the table'}` : r?.take === 'not_for_me' ? `${i.member?.split(' ')[0] ?? 'the table'} would not have it again` : 'nothing said, so it counts as fine'}
                        {r?.comment ? ` — “${r.comment}”` : ''}
                      </Text>
                    </View>
                    {r?.score ? <Row style={{ gap: 1 }}>{[1, 2, 3, 4, 5].map((n) => <Icon key={n} name="favourite" size={13} fill={(r.score ?? 0) >= n} color={(r.score ?? 0) >= n ? colors.rating : colors.inkFaint} />)}</Row> : null}
                  </Row>
                );
              })}
              <Text style={type.tiny}>
                A star goes to the dish as well as to the plate you had, so it counts the next time you are anywhere that serves it.
                “Not great” lowers that one dish and nothing else. Fine changes nothing.
              </Text>
              <Button label="Done" icon="check" onPress={onClose} />
            </ScrollView>
          ) : null}

          {error && step !== 'menu' ? <Text style={[type.tiny, { color: colors.allergen, padding: spacing.md }]}>{error}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropWrap: { flex: 1 },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(32,30,29,0.45)' },
  panel: { backgroundColor: colors.bg, overflow: 'hidden' },
  panelSide: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 520, borderLeftWidth: 1, borderLeftColor: colors.line },
  panelSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 40, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  body: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  close: { width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' },
  row: { gap: 6, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  rowPicked: { backgroundColor: colors.surfaceMuted, borderRadius: radius.sm, paddingHorizontal: spacing.sm },
  itemName: { flex: 1, fontWeight: '700' },
  veg: { color: colors.accent, fontWeight: '800', fontSize: 13 },
  price: { ...type.body, fontWeight: '700' },
  flag: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  flagText: { fontSize: 11, fontWeight: '700' },
  face: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  faceOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  faceText: { fontSize: 12, fontWeight: '800', color: colors.inkMuted },
  faceTextOn: { color: colors.primaryFg },
  noteInput: {
    height: 32, minWidth: 120, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm,
    paddingHorizontal: 10, color: colors.ink, backgroundColor: colors.surface, fontSize: 13,
  },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.surface,
  },
  // Three actions have to sit on one row inside 390px, so the bar's buttons are
  // tighter than the standard one (owner, 4 Sep 2026).
  barBtn: { paddingHorizontal: 12 },
  // Starting again is one refresh, not a word: it buys the room for the other
  // two to keep their icons (owner, 4 Sep 2026).
  barIcon: {
    width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
  },
  orderRow: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.line },
  whatIs: { backgroundColor: colors.surfaceMuted, borderRadius: radius.sm, padding: spacing.sm, gap: 2 },
  rowBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 15, borderWidth: 1, borderColor: colors.line, marginLeft: 6 },
  totalRow: { borderTopWidth: 1, borderTopColor: colors.ink, paddingTop: spacing.sm, justifyContent: 'space-between' },
  warn: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start', borderWidth: 1, borderColor: colors.allergen,
    backgroundColor: colors.allergenSoft, borderRadius: radius.sm, padding: spacing.sm,
  },
  staffWho: { ...type.tiny, textTransform: 'uppercase', letterSpacing: 1, fontWeight: '800', marginTop: spacing.sm },
  staffDish: { fontSize: 21, fontWeight: '800', letterSpacing: -0.4, color: colors.ink, lineHeight: 26 },
  staffDiet: { fontSize: 15, fontWeight: '600', color: colors.ink },
  staffAlert: { borderWidth: 2, borderColor: colors.allergen, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm },
  staffAlertText: { fontSize: 16, fontWeight: '800', color: colors.allergen, lineHeight: 21 },
});

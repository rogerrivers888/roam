import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, AroundThing, MenuRead, Taste, TasteFit, TastePlace, TasteTable } from '../api';
import { colors, radius, spacing, type } from '../theme';
import { Card, Chip, Row, StatusLine, Wrap, minutes } from './ui';
import { Icon, IconName, Rating } from './Icon';
import { VenuePhoto } from './VenuePhoto';
import type { OpenTripOptions } from '../screens/PlanScreen';

/**
 * The family's table (owner, 4 Sep 2026): "the best arrabbiata within my
 * radius… how would that work if other people have favourite foods… present
 * those choices, like 'Best arrabbiata' or 'Best steak'… because Phoenix loves
 * this."
 *
 * One card per food somebody coming loves, named with the people it belongs
 * to. Under each, the best places for it inside the travel cap, what the
 * published evidence says about that food there, whether everyone coming is
 * catered for, and what else there is to do around it — every line in a
 * person's name. Reading a menu is a tap, because it costs money.
 */
const PRICE = ['Free', '£', '££', '£££', '££££'];
const FIT_ICON: Record<TasteFit['tone'], IconName> = { good: 'check', warn: 'info', fact: 'info', allergen: 'allergen' };
const FIT_COLOUR: Record<TasteFit['tone'], string> = { good: colors.accent, warn: colors.inkMuted, fact: colors.inkMuted, allergen: colors.overrun };
const VERDICT_ICON: Record<string, IconName> = { yes: 'check', no: 'close', unknown: 'info' };
const VERDICT_COLOUR: Record<string, string> = { yes: colors.accent, no: colors.inkMuted, unknown: colors.inkMuted };

function Fit({ fit }: { fit: TasteFit }) {
  return (
    <Row style={{ alignItems: 'flex-start', gap: 6 }}>
      <View style={{ paddingTop: 2 }}><Icon name={FIT_ICON[fit.tone]} size={14} color={FIT_COLOUR[fit.tone]} /></View>
      <Text style={[type.tiny, fit.tone === 'allergen' ? { color: colors.overrun } : null, { flex: 1 }]}>{fit.text}</Text>
    </Row>
  );
}

/** What one menu said, in the same shape as the lines above it. */
function MenuLines({ menu }: { menu: MenuRead }) {
  if (!menu.checked) return <StatusLine tone="warn">{menu.whyNot || 'No menu published anywhere Roam could read.'}</StatusLine>;
  const line = (verdict: string, text: string, key: string) => (
    <Row key={key} style={{ alignItems: 'flex-start', gap: 6 }}>
      <View style={{ paddingTop: 2 }}><Icon name={VERDICT_ICON[verdict] ?? 'info'} size={14} color={VERDICT_COLOUR[verdict] ?? colors.inkMuted} /></View>
      <Text style={[type.tiny, { flex: 1 }]}>{text}</Text>
    </Row>
  );
  return (
    <View style={styles.menu}>
      <Text style={[type.tiny, { fontWeight: '700', color: colors.ink }]}>ON THE MENU</Text>
      {menu.dish ? line(menu.dish.verdict, menu.dish.verdict === 'yes'
        ? `${menu.dish.named || menu.dish.label}${menu.dish.price ? ` · ${menu.dish.price}` : ''}`
        : menu.dish.verdict === 'no' ? `No ${menu.dish.label.toLowerCase()} on the menu today${menu.dish.note ? ` — ${menu.dish.note}` : ''}`
        : `The menu doesn't say whether they do ${menu.dish.label.toLowerCase()}${menu.dish.note ? ` — ${menu.dish.note}` : ''}`, 'dish') : null}
      {menu.people.map((p) => line(p.verdict, p.verdict === 'yes'
        ? `${p.need} for ${p.person}${p.examples.length ? `: ${p.examples.join(', ')}` : ''}`
        : p.verdict === 'no' ? `Nothing ${p.need.toLowerCase()} for ${p.person} on the menu`
        : `The menu doesn't say what is ${p.need.toLowerCase()} for ${p.person}`, `p-${p.person}-${p.need}`))}
      {menu.allergens.map((a) => (
        <Row key={`a-${a.person}-${a.allergen}`} style={{ alignItems: 'flex-start', gap: 6 }}>
          <View style={{ paddingTop: 2 }}><Icon name="allergen" size={14} color={colors.overrun} /></View>
          <Text style={[type.tiny, { flex: 1, color: colors.overrun }]}>
            {a.allergen} ({a.person}): {a.verdict === 'yes' ? 'named on the menu' : a.verdict === 'no' ? 'not named in what the menu lists' : 'the menu does not list ingredients'}
            {a.note ? ` — ${a.note}` : ''}. Ask when you book.
          </Text>
        </Row>
      ))}
      {menu.kidsMenu != null ? line(menu.kidsMenu ? 'yes' : 'no', menu.kidsMenu ? "There is a children's menu" : "No children's menu", 'kids') : null}
      <Row style={{ flexWrap: 'wrap', gap: 6 }}>
        <Text style={type.tiny}>Read from their own menu{menu.menuDated ? ` (${menu.menuDated})` : ''}. Menus change — the kitchen is the last word.</Text>
        {menu.menuUrl ? <Pressable onPress={() => Linking.openURL(menu.menuUrl!)} accessibilityRole="link"><Text style={[type.tiny, { color: colors.accent, fontWeight: '700' }]}>Open the menu</Text></Pressable> : null}
      </Row>
    </View>
  );
}

function Place({ table, place, open, onToggle, sessionId, attendingIds, onOpenTrip }: {
  table: TasteTable; place: TastePlace; open: boolean; onToggle: () => void;
  sessionId: string; attendingIds: string[] | null; onOpenTrip?: (tripId: string, opts?: OpenTripOptions) => void;
}) {
  const [menu, setMenu] = useState<MenuRead | null>(place.menu);
  const [reading, setReading] = useState(false);
  const [around, setAround] = useState<{ status: 'loading' | 'ready' | 'error'; forUs: AroundThing[]; count: number }>({ status: 'loading', forUs: [], count: 0 });
  const [trip, setTrip] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What else is around it: the ordinary look-around, but only the things
  // somebody coming actually likes are named.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAround((a) => (a.status === 'ready' ? a : { status: 'loading', forUs: [], count: 0 }));
    api.tastesAround({ sessionId, tasteKey: table.key, venueRef: place.venueRef, members: attendingIds?.join(',') })
      .then((r) => { if (alive) setAround({ status: 'ready', forUs: r.forUs, count: r.items.length }); })
      .catch(() => { if (alive) setAround({ status: 'error', forUs: [], count: 0 }); });
    return () => { alive = false; };
  }, [open, sessionId, table.key, place.venueRef]);

  const readMenu = async () => {
    setReading(true); setError(null);
    try {
      const r = await api.tastesMenu({ sessionId, tasteKey: table.key, venueRef: place.venueRef, attendingMemberIds: attendingIds });
      setMenu(r.menu);
    } catch (e: any) { setError(e?.message || String(e)); } finally { setReading(false); }
  };

  const openDay = async () => {
    if (trip) { onOpenTrip?.(trip.id, { section: 'find', findRadiusKm: 5 }); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.tastesTrip({ sessionId, tasteKey: table.key, venueRef: place.venueRef, attendingMemberIds: attendingIds, around: around.forUs.map((t) => t.name) });
      setTrip({ id: r.tripId, title: r.title });
      onOpenTrip?.(r.tripId, { section: 'find', findRadiusKm: 5 });
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(false); }
  };

  const facts = [
    place.travelEstimated ? `${minutes(place.travelMinutes)} by car (estimated)` : `${minutes(place.travelMinutes)} by car`,
    `${place.distanceKm} km`,
    place.priceLevel != null ? PRICE[place.priceLevel] : null,
    place.chain ? 'Chain' : null,
  ].filter(Boolean).join(' · ');

  return (
    <View style={styles.place}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.placeHead}>
        <VenuePhoto photos={place.photos} size={56} credit={false} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.h3}>{place.name}</Text>
          <Row style={{ flexWrap: 'wrap', gap: 10 }}>
            {place.rating != null ? <Rating value={place.rating}>{place.ratingCount ? ` (${place.ratingCount.toLocaleString()})` : ''}</Rating> : null}
            <Text style={type.small}>{facts}</Text>
          </Row>
        </View>
        <Icon name={open ? 'expand' : 'more'} size={16} color={colors.inkMuted} />
      </Pressable>

      {open ? (
        <View style={{ gap: 6, paddingTop: 2 }}>
          {place.evidence?.text ? (
            <View>
              <Text style={styles.quote}>“{place.evidence.text}”</Text>
              <Text style={type.tiny}>From a review of this place — the only thing any source publishes about a dish.</Text>
            </View>
          ) : place.evidence ? (
            <Text style={type.tiny}>Listed as {place.evidence.matched}{place.evidence.where === 'name' ? ' in its name' : ''}.</Text>
          ) : (
            <Text style={type.tiny}>Nothing published says they do {table.label.toLowerCase()} — reading the menu is the way to know.</Text>
          )}

          {place.fits.filter((f) => f.kind !== 'rating').map((f, i) => <Fit key={`${f.kind}-${i}`} fit={f} />)}
          {menu ? <MenuLines menu={menu} /> : null}

          {around.status === 'loading' ? (
            <Row style={{ gap: 6 }}><ActivityIndicator size="small" color={colors.accent} /><Text style={type.tiny}>Looking around {place.name}…</Text></Row>
          ) : around.status === 'ready' && around.forUs.length ? (
            <View style={{ gap: 3 }}>
              <Text style={[type.tiny, { fontWeight: '700', color: colors.ink }]}>WHILE YOU'RE THERE</Text>
              {around.forUs.map((t) => (
                <Row key={t.venueRef} style={{ alignItems: 'flex-start', gap: 6 }}>
                  <View style={{ paddingTop: 2 }}><Icon name="place" size={14} color={colors.icon} /></View>
                  <Text style={[type.tiny, { flex: 1 }]}>
                    <Text style={{ color: colors.ink, fontWeight: '700' }}>{t.name}</Text>
                    {t.distanceKm != null ? ` · ${t.distanceKm} km` : ''} — {t.why.map((w) => w.text).join(', ')}
                  </Text>
                </Row>
              ))}
              <Text style={type.tiny}>{around.count} places within 5 km of the table.</Text>
            </View>
          ) : around.status === 'error' ? <Text style={type.tiny}>Couldn't look around it just now.</Text> : null}

          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
          <Wrap>
            <Chip label={reading ? 'Reading the menu…' : menu ? 'Read it again' : 'Check the menu'} icon="search" onPress={reading ? undefined : readMenu} />
            <Chip label={busy ? 'Setting up the day…' : trip ? 'Open in Trips' : 'Things to do and see'} tone="accent" icon={trip ? 'trips' : 'more'} onPress={busy ? undefined : openDay} />
            {place.website ? <Chip label="Their website" icon="external" onPress={() => Linking.openURL(place.website!)} /> : null}
          </Wrap>
          {place.address ? <Text style={type.tiny}>{place.address}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function TableCard({ table, sessionId, attendingIds, onOpenTrip }: {
  table: TasteTable; sessionId: string; attendingIds: string[] | null; onOpenTrip?: (tripId: string, opts?: OpenTripOptions) => void;
}) {
  const [open, setOpen] = useState<string | null>(table.places?.[0]?.venueRef ?? null);
  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={{ gap: 4 }}>
        <Text style={type.h2}>{table.title}</Text>
        <Wrap>
          {table.loved.map((w) => <Chip key={w.memberId} label={w.name} tone="like" icon={w.favourite ? 'favourite' : 'keep'} iconFill />)}
          {table.notFor.map((w) => <Chip key={w.memberId} label={`${w.name}: not ${w.value}`} tone="dislike" />)}
        </Wrap>
        {table.because ? <Text style={type.small}>{table.because}.</Text> : null}
      </View>
      {table.error ? <StatusLine tone="warn">{table.error}</StatusLine> : null}
      {!table.error && !table.places.length ? <Text style={type.small}>Nothing within reach came back for {table.label.toLowerCase()} — try a wider travel cap.</Text> : null}
      {table.places.map((p) => (
        <Place key={p.venueRef} table={table} place={p} open={open === p.venueRef} onToggle={() => setOpen(open === p.venueRef ? null : p.venueRef)}
          sessionId={sessionId} attendingIds={attendingIds} onOpenTrip={onOpenTrip} />
      ))}
    </Card>
  );
}

export function TasteTables({ sessionId, tastes, tables, running, note, error, attendingIds, onOpenTrip }: {
  sessionId: string | null; tastes: Taste[]; tables: TasteTable[]; running: boolean;
  note: string | null; error: string | null; attendingIds: string[] | null;
  onOpenTrip?: (tripId: string, opts?: OpenTripOptions) => void;
}) {
  if (!sessionId || (!tastes.length && !tables.length && !error)) return null;
  const waiting = tastes.filter((t) => !tables.some((tb) => tb.key === t.key));
  return (
    <>
      {tastes.length ? (
        <Card style={{ gap: 6 }}>
          <Text style={[type.tiny, { fontWeight: '700', color: colors.ink }]}>BECAUSE YOU LOVE</Text>
          <Wrap>{tastes.map((t) => <Chip key={t.key} label={`${t.label} · ${t.loved.map((w) => w.name).join(', ') || 'you asked for it'}`} icon={t.named ? 'search' : 'restaurant'} />)}</Wrap>
          {note ? <Text style={type.tiny}>{note}</Text> : null}
          {error ? <StatusLine tone="warn">{error}</StatusLine> : null}
        </Card>
      ) : null}
      {tables.map((t) => <TableCard key={t.key} table={t} sessionId={sessionId} attendingIds={attendingIds} onOpenTrip={onOpenTrip} />)}
      {running && waiting.length ? (
        <Row style={{ gap: 8 }}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={type.small}>Finding the best {waiting[0].label.toLowerCase()}…</Text>
        </Row>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  place: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm, gap: 6 },
  placeHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  quote: { ...type.small, color: colors.ink, fontStyle: 'italic' },
  menu: { gap: 4, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
});

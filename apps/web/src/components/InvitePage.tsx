import React, { useMemo, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { API_URL, GroupItem, GroupItemKind, GroupPricing, JoinView, TripGroup } from '../api';
import { colors, fonts, radius, spacing, TARGET, type } from '../theme';
import { Button, Card, Row, Segmented, StatusLine, Wrap } from './ui';
import { Icon, IconName } from './Icon';
import { Wordmark } from './Wordmark';

/**
 * What the link opens (Group Trips v2, Epic 3).
 *
 * One page, drawn twice: the organiser writes four things into it — a cover, a
 * title, a paragraph and up to four how-it-works points — and everything else
 * is read off the group itself, so the page cannot drift away from the trip it
 * is selling. Preview is the same component the guest gets, not a picture of
 * it, which is the only way "exactly as the link will show it" stays true.
 *
 * The prices here are per person and before anybody has said how many are
 * coming: a ceiling for anything that varies (the promise), the price for
 * anything fixed, and "free" for the rest. The guest is never shown a number
 * that could go up.
 */

const ROAM_GALLERY = ['/covers/1.jpg', '/covers/2.jpg', '/covers/3.jpg', '/covers/4.jpg', '/covers/5.jpg', '/covers/6.jpg'];
export const TITLE_MAX = 40;
export const SUMMARY_MAX = 160;
export const POINT_MAX = 90;
export const POINTS_MAX = 4;

const money = (p?: number | null) => (p == null ? '' : `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: p % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`);
const range = (low?: number | null, high?: number | null) =>
  low == null && high == null ? '' : low === high || high == null ? money(low) : low == null ? money(high) : `${money(low)}–${money(high)}`;
const shortDay = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const ICON: Record<GroupItemKind, IconName> = { stay: 'hotel', activity: 'ticket', fee: 'money' };

/**
 * The tile beside a group item. Kind alone draws a ticket on a mountain walk
 * and a ticket on a coach, so the words are read first — a closed list of the
 * things groups actually put on a trip, and the kind's icon underneath it.
 */
const WORDS: [RegExp, IconName][] = [
  [/coach|bus|minibus/i, 'transit'],
  [/train|railway|rail\b/i, 'transit'],
  [/ferry|boat/i, 'boat'],
  [/walk|track|summit|hike|climb|mountain|peak/i, 'climbing'],
  [/curry|dinner|lunch|breakfast|meal|restaurant|pub|bbq/i, 'restaurant'],
  [/band|gig|music|disco/i, 'liveMusic'],
  [/hostel|yha|hotel|bunk|room|bed|camp/i, 'hotel'],
  [/ticket|entry|museum|castle/i, 'ticket'],
  [/kitty|fee|deposit|whip/i, 'money'],
];
export function itemIcon(label: string, kind: GroupItemKind): IconName {
  for (const [re, name] of WORDS) if (re.test(label)) return name;
  return ICON[kind] ?? 'place';
}

/**
 * A picture reference to something to draw. A cover is either one of ours
 * (`/covers/…`), one the organiser uploaded (a data URL, theirs), or a place
 * photograph named by reference — and that last one is fetched at display
 * through the API and never stored as an image, because it is rented
 * (Technical Constraints §4).
 */
export function coverUri(url?: string | null, width = 1200): string | null {
  if (!url) return null;
  if (url.startsWith('photo:')) return `${API_URL}/api/photos/google?name=${encodeURIComponent(url.slice(6))}&w=${width}`;
  return url;
}

// --- what the page is made of ----------------------------------------------

export type InviteItem = {
  id: string; kind: GroupItemKind; label: string; detail: string | null; required: boolean;
  startsOn: string | null; startsAt: string | null; endsAt: string | null;
  bookWhere: GroupItem['bookWhere']; pricing: GroupPricing; amountPence: number | null;
  ceilingPence: number | null; likelyPence: number | null;
};
export type InvitePageData = {
  organiser: string | null;
  invite: { coverKind: 'banner' | 'full'; coverUrl: string | null; title: string | null; summary: string | null; howItWorks: string[]; placesLeft: number | null };
  trip: { title: string | null; place: string | null; startDate: string | null; endDate: string | null };
  going: number; items: InviteItem[];
  closed: boolean; cancelled: boolean; cancelledNote: string | null;
};

const itemOf = (i: any, m: any): InviteItem => ({
  id: i.id, kind: i.kind, label: i.label, detail: i.detail, required: i.required,
  startsOn: i.startsOn, startsAt: i.startsAt, endsAt: i.endsAt,
  bookWhere: i.bookWhere, pricing: i.pricing, amountPence: i.amountPence,
  ceilingPence: m?.ceilingPence ?? (i.pricing === 'fixed' ? i.amountPence : null),
  likelyPence: m?.likelyPence ?? (i.pricing === 'fixed' ? i.amountPence : null),
});

/** The page as the guest's own view of it supplies it. */
export const pageFromJoin = (v: JoinView): InvitePageData => ({
  organiser: v.group.organiser,
  invite: v.invite,
  trip: v.trip,
  going: v.group.heads,
  items: v.items.filter((i) => i.state !== 'cancelled').map((i) => itemOf(i, i.money)),
  closed: v.group.closed, cancelled: v.group.cancelled, cancelledNote: v.group.cancelledNote,
});

/** The same page from the organiser's side, for Preview. */
export const pageFromGroup = (g: TripGroup): InvitePageData => ({
  organiser: g.participants.find((p) => p.memberId)?.name ?? null,
  invite: {
    ...g.group.invite,
    title: g.group.invite.title || g.group.name || g.trip.title,
    placesLeft: g.group.maximumCount ? Math.max(0, g.group.maximumCount - g.summary.heads) : null,
  },
  trip: g.trip,
  going: g.summary.heads,
  items: g.items.filter((i) => i.state !== 'cancelled').map((i) => itemOf(i, i.money)),
  closed: g.group.closed, cancelled: Boolean(g.group.cancelledAt), cancelledNote: g.group.cancelledNote,
});

/** What one row of What you get says on the right. Never a figure that can rise. */
export function priceWord(i: InviteItem): string {
  if (i.bookWhere === 'yourself') return i.amountPence ? `from ${money(i.amountPence)}` : 'you book it';
  if (i.pricing === 'variable') return i.ceilingPence == null ? 'by numbers' : `≤ ${money(i.ceilingPence)}`;
  if (i.pricing === 'fixed' || i.amountPence) return money(i.amountPence ?? i.likelyPence);
  if (i.bookWhere === 'there') return 'pay there';
  return 'free';
}

/**
 * What the trip costs a person, before anybody has said how many are coming.
 * Everything mandatory that is paid through the group makes the floor; a bed
 * you book yourself is real money but not ours to collect, so it is footnoted
 * rather than added in.
 */
export function totals(items: InviteItem[]) {
  let low = 0; let high = 0; let optional: number | null = null;
  const yourselves: InviteItem[] = [];
  for (const i of items) {
    if (i.bookWhere === 'yourself') { if (i.amountPence) yourselves.push(i); continue; }
    const l = i.likelyPence ?? i.ceilingPence; const h = i.ceilingPence ?? i.likelyPence;
    if (!l && !h) continue;
    if (i.required) { low += l ?? 0; high += h ?? 0; }
    else if (l != null) optional = optional == null ? l : Math.min(optional, l);
  }
  return { low, high, optional, yourselves };
}

// --- the landing ------------------------------------------------------------

export function InviteLanding({ data, cta, onNext, onBack, busy, narrow }: {
  data: InvitePageData; cta?: string; onNext?: () => void; onBack?: () => void; busy?: boolean; narrow?: boolean;
}) {
  const { invite } = data;
  const t = useMemo(() => totals(data.items), [data.items]);
  // What everybody has to do, first and in the order the trip happens: three
  // rows have to answer "what am I being asked into?", and an optional extra
  // does not.
  const shown = [...data.items]
    .sort((a, b) => Number(b.required) - Number(a.required)
      || (a.startsOn ?? '9999').localeCompare(b.startsOn ?? '9999')
      || (a.startsAt ?? '').localeCompare(b.startsAt ?? ''))
    .slice(0, 3);
  const uri = coverUri(invite.coverUrl);
  const full = invite.coverKind === 'full' && Boolean(uri);
  const title = invite.title || data.trip.title || 'A trip';
  const dates = data.trip.startDate ? `${shortDay(data.trip.startDate)} – ${shortDay(data.trip.endDate)}` : '';
  const line = [dates, data.trip.place, data.going ? `${data.going} going` : null].filter(Boolean).join(' · ');

  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        {onBack ? <Pressable onPress={onBack} accessibilityRole="button" style={{ padding: 4 }}><Icon name="back" size={20} /></Pressable> : <Wordmark height={28} />}
        {data.organiser ? <Text style={type.label}>INVITED BY {data.organiser.toUpperCase()}</Text> : null}
      </Row>

      {/* The hero: a photograph the type sits on, or a strip above the mint. */}
      <View style={styles.hero}>
        {uri ? <Image source={{ uri }} style={[styles.heroImg, { height: full ? (narrow ? 260 : 300) : 104 }]} accessibilityIgnoresInvertColors /> : null}
        {full ? <View style={styles.scrim} /> : null}
        <View style={[styles.heroText, full ? styles.heroOver : styles.heroUnder]}>
          <Text style={[type.title, full && { color: '#FFFFFF' }]}>{title}</Text>
          {line ? <Text style={[type.small, { fontWeight: '700' }, full ? { color: '#FFFFFF' } : { color: colors.headerSub }]}>{line}</Text> : null}
          {invite.summary ? <Text style={[type.body, full ? { color: '#FFFFFF' } : { color: colors.ink }, { marginTop: 6 }]}>{invite.summary}</Text> : null}
        </View>
      </View>

      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <Text style={type.label}>WHAT YOU GET</Text>
        <Text style={type.small}>{data.items.length > shown.length ? `${shown.length} of ${data.items.length} · the rest on the next step` : `${data.items.length} thing${data.items.length === 1 ? '' : 's'}`}</Text>
      </Row>
      <View>
        {shown.map((i) => (
          <Row key={i.id} style={styles.getRow}>
            <View style={styles.tile}><Icon name={itemIcon(i.label, i.kind)} size={16} /></View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={type.h3}>{i.label}</Text>
              <Text style={type.small}>{[i.startsAt, i.detail].filter(Boolean).join(' · ')}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={[type.h3, { fontWeight: '700' }]}>{priceWord(i)}</Text>
              <Text style={[type.label, { marginBottom: 0, marginTop: 0 }]}>{i.required ? 'EVERYONE' : 'OPTIONAL'}</Text>
            </View>
          </Row>
        ))}
      </View>

      <View style={styles.totals}>
        <Total label="Mandatory activities" value={range(t.low, t.high) || 'free'} />
        {t.optional != null ? <Total label="Optional activities" value={`from ${money(t.optional)}`} /> : null}
        <Total label="Minimum trip cost" value={range(t.low, t.high) || 'free'} strong />
        {t.yourselves.map((i) => (
          <Text key={i.id} style={[type.small, { textAlign: 'right' }]}>+ your own {i.label}, from {money(i.amountPence)}</Text>
        ))}
      </View>

      {invite.howItWorks.length ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.label}>HOW IT WORKS</Text>
          {invite.howItWorks.map((p, n) => (
            <Row key={n} style={{ alignItems: 'flex-start' }}>
              <View style={styles.numDot}><Text style={styles.numDotText}>{n + 1}</Text></View>
              <Text style={[type.body, { flex: 1 }]}>{p}</Text>
            </Row>
          ))}
        </View>
      ) : null}

      {data.cancelled ? (
        <StatusLine tone="warn">This trip is off. {data.cancelledNote ?? ''} Nothing has been taken from anybody.</StatusLine>
      ) : data.closed ? (
        <StatusLine tone="warn">This group is not taking any more people. Ask {data.organiser ?? 'the organiser'} if you think that is wrong.</StatusLine>
      ) : onNext ? (
        <View style={{ gap: 6 }}>
          <Button label={cta ?? 'Next · Book your itinerary'} icon="forward" loading={busy} onPress={onNext} />
          <Text style={[type.small, { textAlign: 'center' }]}>
            Free Roam account first (30 days, no card){invite.placesLeft != null ? ` · ${invite.placesLeft} place${invite.placesLeft === 1 ? '' : 's'} left` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Row style={{ justifyContent: 'flex-end' }}>
      <Text style={[type.small, strong && { color: colors.ink, fontWeight: '700' }]}>{label}</Text>
      <Text style={[type.small, { color: colors.ink, fontWeight: '700', minWidth: 76, textAlign: 'right' }, strong && type.h3]}>{value}</Text>
    </Row>
  );
}

// --- the editor -------------------------------------------------------------

/** A count that turns red as it runs out (within a tenth of the limit). */
function Counter({ n, max }: { n: number; max: number }) {
  const tight = n > max - Math.ceil(max / 10);
  return <Text style={[type.small, tight && { color: colors.overrun, fontWeight: '700' }]}>{n}/{max}</Text>;
}

export type InviteEdit = {
  coverKind: 'banner' | 'full'; coverUrl: string | null; coverSource: string | null;
  inviteTitle: string; inviteSummary: string; howItWorks: string[];
};

/**
 * Edit the invite page. Four fields and a picture; the item list underneath is
 * shown but not editable here, because it is the trip's and changing it is what
 * step 2 is for.
 */
export function InviteEditor({ data, tripPhotos, saving, onSave, onClose, onPreview }: {
  data: InvitePageData; tripPhotos?: string[]; saving?: boolean;
  onSave: (body: InviteEdit) => void; onClose: () => void; onPreview: (draft: InviteEdit) => void;
}) {
  const [coverKind, setCoverKind] = useState<'banner' | 'full'>(data.invite.coverKind ?? 'banner');
  const [coverUrl, setCoverUrl] = useState<string | null>(data.invite.coverUrl);
  const [source, setSource] = useState<string>(data.invite.coverUrl?.startsWith('photo:') ? 'trip' : data.invite.coverUrl?.startsWith('data:') ? 'upload' : 'gallery');
  const [title, setTitle] = useState(data.invite.title ?? '');
  const [summary, setSummary] = useState(data.invite.summary ?? '');
  const [points, setPoints] = useState<string[]>(data.invite.howItWorks.length ? data.invite.howItWorks : ['']);
  const draft = (): InviteEdit => ({
    coverKind, coverUrl, coverSource: source,
    inviteTitle: title.trim(), inviteSummary: summary.trim(),
    howItWorks: points.map((p) => p.trim()).filter(Boolean),
  });

  // The organiser's own photograph, kept small enough to live in a text column
  // and never sent anywhere else.
  const upload = () => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new (window as any).Image();
        img.onload = () => {
          const w = Math.min(1200, img.width); const h = Math.round((img.height / img.width) * w);
          const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
          canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
          setCoverUrl(canvas.toDataURL('image/jpeg', 0.72)); setSource('upload');
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const gallery = source === 'trip' ? (tripPhotos ?? []) : ROAM_GALLERY;
  return (
    <View style={{ gap: spacing.md }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={onClose} accessibilityRole="button" style={{ padding: 4 }}><Icon name="back" size={20} /></Pressable>
        <Text style={type.h2}>Edit the invite page</Text>
        <Pressable onPress={() => onPreview(draft())} accessibilityRole="button">
          <Row><Icon name="preview" size={16} color={colors.accent} /><Text style={[type.h3, { color: colors.accent }]}>Preview</Text></Row>
        </Pressable>
      </Row>

      <View style={{ gap: spacing.sm }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={type.label}>COVER PHOTO</Text>
          <View style={{ width: 176 }}>
            <Segmented value={coverKind} onChange={setCoverKind} options={[{ value: 'banner', label: 'Banner' }, { value: 'full', label: 'Full' }]} />
          </View>
        </Row>
        <Row style={{ alignItems: 'flex-start' }}>
          <View style={styles.coverNow}>
            {coverUri(coverUrl, 480) ? <Image source={{ uri: coverUri(coverUrl, 480)! }} style={styles.coverNowImg} accessibilityIgnoresInvertColors /> : <Icon name="picture" size={20} color={colors.inkFaint} />}
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Wrap>
              <Pill label="Upload" icon="upload" on={source === 'upload'} onPress={upload} />
              <Pill label="From the trip" icon="picture" on={source === 'trip'} onPress={() => setSource('trip')} />
              <Pill label="Roam gallery" icon="climbing" on={source === 'gallery'} onPress={() => setSource('gallery')} />
            </Wrap>
            {source === 'trip' && !(tripPhotos ?? []).length
              ? <Text style={type.small}>This trip has no picture of its own yet. Pick one from the gallery, or upload yours.</Text>
              : null}
          </View>
        </Row>
        {source !== 'upload' ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
            {gallery.map((g) => (
              <Pressable key={g} onPress={() => setCoverUrl(g)} accessibilityRole="button">
                <Image source={{ uri: coverUri(g, 240)! }} style={[styles.thumb, coverUrl === g && styles.thumbOn]} accessibilityIgnoresInvertColors />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>

      <View>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={type.label}>TITLE</Text><Counter n={title.length} max={TITLE_MAX} />
        </Row>
        <TextInput value={title} onChangeText={(t) => setTitle(t.slice(0, TITLE_MAX))} placeholder={data.trip.title ?? 'What to call it'} placeholderTextColor={colors.inkFaint} style={[styles.input, type.h3 as any]} />
      </View>

      <View>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={type.label}>WHAT THIS IS</Text><Counter n={summary.length} max={SUMMARY_MAX} />
        </Row>
        <TextInput
          value={summary} onChangeText={(t) => setSummary(t.slice(0, SUMMARY_MAX))} multiline
          placeholder="Two nights at Pen-y-Pass, up Snowdon on the Saturday, curry after."
          placeholderTextColor={colors.inkFaint} style={[styles.input, { minHeight: 84, paddingTop: spacing.sm }]}
        />
      </View>

      <View style={{ gap: spacing.sm }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={type.label}>HOW IT WORKS</Text><Text style={type.small}>Up to {POINTS_MAX} points</Text>
        </Row>
        {points.map((p, n) => (
          <Row key={n} style={{ alignItems: 'flex-start' }}>
            <View style={styles.numDot}><Text style={styles.numDotText}>{n + 1}</Text></View>
            <View style={{ flex: 1 }}>
              <TextInput
                value={p} multiline
                onChangeText={(t) => setPoints(points.map((x, j) => (j === n ? t.slice(0, POINT_MAX) : x)))}
                placeholder="One thing they have to do, in a line"
                placeholderTextColor={colors.inkFaint} style={[styles.input, { minHeight: 56, paddingTop: spacing.sm }]}
              />
              <View style={{ alignItems: 'flex-end' }}><Counter n={p.length} max={POINT_MAX} /></View>
            </View>
            <Pressable onPress={() => setPoints(points.filter((_, j) => j !== n))} accessibilityRole="button" style={{ padding: 6 }}>
              <Icon name="close" size={16} color={colors.inkMuted} />
            </Pressable>
          </Row>
        ))}
        {points.length < POINTS_MAX ? (
          <Pressable onPress={() => setPoints([...points, ''])} accessibilityRole="button">
            <Row><Icon name="add" size={16} color={colors.accent} /><Text style={[type.h3, { color: colors.accent }]}>Add a point</Text></Row>
          </Pressable>
        ) : null}
      </View>

      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.label}>WHAT YOU GET · {data.items.length} ITEMS</Text>
        <Text style={type.small}>From the trip · shown in date order</Text>
      </Row>

      <Button label="Save" icon="forward" loading={saving} onPress={() => onSave(draft())} />
    </View>
  );
}

function Pill({ label, icon, on, onPress }: { label: string; icon: IconName; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.pill, on && styles.pillOn]}>
      <Icon name={icon} size={14} color={on ? colors.primaryFg : colors.ink} />
      <Text style={[styles.pillText, on && { color: colors.primaryFg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.mint },
  heroImg: { width: '100%' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(32,30,29,0.42)' },
  heroText: { padding: spacing.md, gap: 2 },
  heroOver: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  heroUnder: { backgroundColor: colors.mint },
  getRow: { alignItems: 'flex-start', paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  tile: { width: 34, height: 34, borderRadius: radius.sm, backgroundColor: colors.well, alignItems: 'center', justifyContent: 'center' },
  totals: { gap: 4, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm },
  numDot: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  numDotText: { color: colors.primaryFg, fontFamily: fonts.body, fontSize: 12, fontWeight: '700' },
  coverNow: { width: 104, height: 68, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  coverNowImg: { width: '100%', height: '100%' },
  thumb: { width: 84, height: 56, borderRadius: radius.sm, backgroundColor: colors.surfaceMuted, borderWidth: 2, borderColor: 'transparent' },
  thumbOn: { borderColor: colors.ink },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  pillOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '600', color: colors.ink },
  input: {
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink, fontFamily: fonts.body,
    outlineColor: colors.accent as any, outlineWidth: 2 as any, outlineOffset: 1 as any,
  },
});

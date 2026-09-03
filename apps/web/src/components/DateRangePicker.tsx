import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button } from './ui';

/**
 * The two-month range calendar — the same control Parcelvision's shipments tab
 * uses (portal/src/ui/Calendar.tsx + DateRangePicker.tsx), without its shortcut
 * rail: a trip has real dates, not "last 7 days". Tap a start, tap an end;
 * tapping before the start flips the range instead of emptying it. Dates are
 * ISO strings (YYYY-MM-DD) in and out, which is what the API stores.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const pad = (n: number) => String(n).padStart(2, '0');

export const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromIso = (s: string | null | undefined): Date | null => (s ? new Date(`${s.slice(0, 10)}T12:00:00`) : null);
const sameDay = (a: Date | null, b: Date | null) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const short = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;

/** "4 Jun 2026" / "29 May – 4 Jun 2026" — the year once, on the end. */
export function rangeLabel(start: Date | null, end: Date | null, empty = 'Pick dates'): string {
  if (!start) return empty;
  return end && !sameDay(start, end) ? `${short(start)} – ${short(end)} ${end.getFullYear()}` : `${short(start)} ${start.getFullYear()}`;
}

/** "Sep 2026" / "Sep–Oct 2026" / "Dec 2026 – Jan 2027" — for default trip names. */
export function monthSpanLabel(startIso: string, endIso: string): string {
  const a = fromIso(startIso); const b = fromIso(endIso) ?? a;
  if (!a || !b) return '';
  const ma = MONTHS[a.getMonth()].slice(0, 3); const mb = MONTHS[b.getMonth()].slice(0, 3);
  if (a.getFullYear() !== b.getFullYear()) return `${ma} ${a.getFullYear()} – ${mb} ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${ma}–${mb} ${a.getFullYear()}`;
  return `${ma} ${a.getFullYear()}`;
}

export function DateRangePicker({ start, end, onApply, single = false }: {
  start: string | null;
  end: string | null;
  /** Both ISO dates; for `single`, end === start. */
  onApply: (start: string, end: string) => void;
  /** One date rather than a range (a day out). */
  single?: boolean;
}) {
  const { width } = useWindowDimensions();
  const sideBySide = width >= 680;
  const [open, setOpen] = useState(false);
  const [selStart, setSelStart] = useState<Date | null>(fromIso(start));
  const [selEnd, setSelEnd] = useState<Date | null>(fromIso(end));
  // The applied dates are the source of truth: reopening never shows a draft the form doesn't have.
  useEffect(() => { setSelStart(fromIso(start)); setSelEnd(fromIso(end)); }, [start, end]);

  const today = new Date();
  const first = fromIso(start) ?? today;
  const [vy, setVy] = useState(first.getFullYear());
  const [vm, setVm] = useState(first.getMonth());
  const next = vm === 11 ? { y: vy + 1, m: 0 } : { y: vy, m: vm + 1 };
  const nav = (dir: number) => { let m = vm + dir; let y = vy; if (m < 0) { m = 11; y -= 1; } if (m > 11) { m = 0; y += 1; } setVm(m); setVy(y); };

  const pick = (y: number, m: number, d: number) => {
    const ds = new Date(y, m, d, 12);
    if (single) { setSelStart(ds); setSelEnd(ds); return; }
    if (!selStart || (selStart && selEnd)) { setSelStart(ds); setSelEnd(null); }
    else if (ds.getTime() < selStart.getTime()) { setSelEnd(selStart); setSelStart(ds); }
    else setSelEnd(ds);
  };
  const apply = () => { if (!selStart) return; onApply(toIso(selStart), toIso(selEnd ?? selStart)); setOpen(false); };
  const cancel = () => { setSelStart(fromIso(start)); setSelEnd(fromIso(end)); setOpen(false); };

  const applied = { s: fromIso(start), e: fromIso(end) };
  const draftLabel = selStart ? rangeLabel(selStart, selEnd) : single ? 'Tap a day' : 'Tap a start date, then an end date';

  return (
    <View style={{ gap: spacing.sm }}>
      <Pressable onPress={() => (open ? cancel() : setOpen(true))} style={[styles.trigger, open && { borderColor: colors.accent }]} accessibilityRole="button" accessibilityLabel={single ? 'Choose the date' : 'Choose the dates'}>
        <Text style={{ fontSize: 15 }}>📅</Text>
        <Text style={[type.body, { flex: 1 }, !applied.s && { color: colors.inkFaint }]}>{rangeLabel(applied.s, single ? applied.s : applied.e, single ? 'Pick a date' : 'Pick dates')}</Text>
        <Text style={[type.small, { color: colors.inkMuted }]}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.panel}>
          <View style={[styles.months, sideBySide ? { flexDirection: 'row' } : { flexDirection: 'column' }]}>
            <MonthGrid y={vy} m={vm} selStart={selStart} selEnd={selEnd} onPick={pick} onNav={nav} navLeft navRight={!sideBySide} today={today} />
            <MonthGrid y={next.y} m={next.m} selStart={selStart} selEnd={selEnd} onPick={pick} onNav={nav} navLeft={!sideBySide} navRight today={today} />
          </View>
          <View style={styles.footer}>
            <Text style={[type.small, { flex: 1 }]}>{draftLabel}</Text>
            <Button label="Cancel" kind="ghost" onPress={cancel} />
            <Button label="Apply" onPress={apply} disabled={!selStart} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function MonthGrid({ y, m, selStart, selEnd, onPick, onNav, navLeft, navRight, today }: {
  y: number; m: number; selStart: Date | null; selEnd: Date | null;
  onPick: (y: number, m: number, d: number) => void; onNav: (dir: number) => void;
  navLeft?: boolean; navRight?: boolean; today: Date;
}) {
  // Monday-first: getDay() is Sunday-based, so shift by +6 mod 7.
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < startDow; i += 1) cells.push(<View key={`b${i}`} style={styles.cell} />);
  for (let d = 1; d <= days; d += 1) {
    const ds = new Date(y, m, d, 12);
    const t = ds.getTime();
    const isSel = sameDay(ds, selStart) || sameDay(ds, selEnd);
    const inRange = !!selStart && !!selEnd && t > selStart.getTime() && t < selEnd.getTime();
    const isToday = sameDay(ds, today);
    cells.push(
      <Pressable key={d} onPress={() => onPick(y, m, d)} style={styles.cell} accessibilityRole="button" accessibilityLabel={`${d} ${MONTHS[m]} ${y}`} accessibilityState={{ selected: isSel }}>
        <View style={[styles.day, isSel && styles.daySelected, inRange && styles.dayInRange, !isSel && isToday && styles.dayToday]}>
          <Text style={[styles.dayText, isSel && { color: '#fff', fontWeight: '700' }]}>{d}</Text>
        </View>
      </Pressable>,
    );
  }
  return (
    <View style={styles.month}>
      <View style={styles.monthHeader}>
        {navLeft ? <Pressable onPress={() => onNav(-1)} style={styles.nav} accessibilityLabel="Previous month"><Text style={styles.navText}>‹</Text></Pressable> : <View style={styles.nav} />}
        <Text style={type.h3}>{MONTHS[m]} {y}</Text>
        {navRight ? <Pressable onPress={() => onNav(1)} style={styles.nav} accessibilityLabel="Next month"><Text style={styles.navText}>›</Text></Pressable> : <View style={styles.nav} />}
      </View>
      <View style={styles.grid}>{DOW.map((x) => <View key={x} style={styles.cell}><Text style={[type.tiny, { fontWeight: '700' }]}>{x}</Text></View>)}</View>
      <View style={styles.grid}>{cells}</View>
    </View>
  );
}

const CELL = 40;

const styles = StyleSheet.create({
  trigger: { minHeight: TARGET, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  panel: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, gap: spacing.md, alignSelf: 'flex-start', maxWidth: '100%' },
  months: { gap: spacing.xl, alignItems: 'flex-start' },
  month: { width: CELL * 7 },
  monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 32, marginBottom: 4 },
  nav: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 20, color: colors.inkMuted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', width: CELL * 7 },
  cell: { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center' },
  day: { width: CELL - 4, height: CELL - 4, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  dayText: { fontSize: 14, color: colors.ink },
  daySelected: { backgroundColor: colors.accent },
  dayInRange: { backgroundColor: colors.accentSoft },
  dayToday: { borderWidth: 1, borderColor: colors.accent },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: spacing.sm },
});

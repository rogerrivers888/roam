import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button } from './ui';
import { Icon } from './Icon';

/**
 * From and to, on two wheels you slide (owner, 4 Sep 2026: "It should just come
 * up with the iPhone-like time wheel where I can just slide it up and down and
 * choose my time from and to"). Same shape as DateRangePicker: a trigger that
 * says what is set, opening an inline panel — nothing portals out, so it works
 * the same inside the 390px phone frame.
 *
 * Every row is also a tap target, so the wheel never has to be scrolled
 * precisely to be used, and it works with a keyboard and a screen reader.
 */

const ROW = 36;
const VISIBLE = 5; // two above, the chosen one, two below

const pad = (n: number) => String(n).padStart(2, '0');
export const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${pad(m)}${ampm}` : `${h12}${ampm}`;
};

/** Every quarter hour of the day, which is how people say a time. */
function slots(step: number, from = '00:00', to = '23:45') {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const out: string[] = [];
  for (let t = fh * 60 + fm; t <= th * 60 + tm; t += step) out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
  return out;
}

/** The nearest slot at or before a time that is not on the grid ("09:37" → "09:30"). */
function nearest(value: string, list: string[]) {
  if (list.includes(value)) return value;
  const [h, m] = (value || '').split(':').map(Number);
  if (Number.isNaN(h)) return list[0];
  const want = h * 60 + m;
  let best = list[0];
  let gap = Infinity;
  for (const s of list) {
    const [sh, sm] = s.split(':').map(Number);
    const d = Math.abs(sh * 60 + sm - want);
    if (d < gap) { gap = d; best = s; }
  }
  return best;
}

function Wheel({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  const ref = useRef<ScrollView | null>(null);
  const settle = useRef<any>(null);
  const chosen = nearest(value, options);
  const index = Math.max(0, options.indexOf(chosen));

  // Open on the time that is set, and follow it when it is changed from outside
  // (picking a "from" after the "to" pushes the "to" along).
  useEffect(() => { ref.current?.scrollTo({ y: index * ROW, animated: false }); }, [index]);

  const land = (y: number) => {
    const i = Math.max(0, Math.min(options.length - 1, Math.round(y / ROW)));
    if (options[i] !== chosen) onChange(options[i]);
    ref.current?.scrollTo({ y: i * ROW, animated: true });
  };

  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={type.tiny}>{label}</Text>
      <View style={styles.wheel}>
        <View style={styles.window} pointerEvents="none" />
        <ScrollView
          ref={ref}
          style={styles.scroll}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingVertical: ((VISIBLE - 1) / 2) * ROW }}
          snapToInterval={ROW}
          decelerationRate="fast"
          scrollEventThrottle={16}
          onScroll={(e) => {
            // react-native-web has no momentum event for a mouse wheel: settle
            // on the row it stopped on, a moment after it stops moving.
            const y = e.nativeEvent.contentOffset.y;
            clearTimeout(settle.current);
            settle.current = setTimeout(() => land(y), 120);
          }}
        >
          {options.map((o) => (
            <Pressable
              key={o}
              onPress={() => onChange(o)}
              style={styles.slot}
              accessibilityRole="button"
              accessibilityState={{ selected: o === chosen }}
              accessibilityLabel={`${label} ${timeLabel(o)}`}
            >
              <Text style={[styles.slotText, o === chosen && styles.slotTextOn]}>{timeLabel(o)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * "10am → 4pm", tapped to open two wheels. `start` and `end` are 24-hour
 * "HH:MM" strings, which is what the API stores.
 */
export function TimeRangePicker({ start, end, onChange, step = 15, labels = ['From', 'To'], hint }: {
  start: string; end: string;
  onChange: (start: string, end: string) => void;
  step?: number;
  labels?: [string, string] | string[];
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const options = slots(step);
  const setStart = (s: string) => {
    // The end never lands before the start: pushing one along pushes the other.
    const after = options.indexOf(s) >= options.indexOf(nearest(end, options));
    onChange(s, after ? options[Math.min(options.length - 1, options.indexOf(s) + Math.round(60 / step))] : end);
  };
  const setEnd = (e: string) => {
    const before = options.indexOf(e) <= options.indexOf(nearest(start, options));
    onChange(before ? options[Math.max(0, options.indexOf(e) - Math.round(60 / step))] : start, e);
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <Pressable onPress={() => setOpen((o) => !o)} style={[styles.trigger, open && { borderColor: colors.accent }]} accessibilityRole="button" accessibilityLabel="Choose the times" accessibilityState={{ expanded: open }}>
        <Icon name="hours" size={16} color={colors.inkMuted} />
        <Text style={[type.body, { flex: 1 }]}>{timeLabel(start)} – {timeLabel(end)}</Text>
        <Icon name={open ? 'collapse' : 'expand'} size={16} color={colors.inkMuted} />
      </Pressable>
      {open ? (
        <View style={styles.panel}>
          <View style={styles.wheels}>
            <Wheel label={labels[0]} value={start} options={options} onChange={setStart} />
            <Wheel label={labels[1]} value={end} options={options} onChange={setEnd} />
          </View>
          <View style={styles.footer}>
            <Text style={[type.small, { flex: 1 }]}>{hint ?? `${timeLabel(start)} to ${timeLabel(end)}`}</Text>
            <Button label="Done" onPress={() => setOpen(false)} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  panel: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.md },
  wheels: { flexDirection: 'row', gap: spacing.md },
  wheel: { height: ROW * VISIBLE, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, overflow: 'hidden' },
  // The chosen row sits in a lit window, the way a wheel reads on a phone. It is
  // painted behind the times, not over them.
  window: {
    position: 'absolute', left: 0, right: 0, top: ((VISIBLE - 1) / 2) * ROW, height: ROW,
    borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line, backgroundColor: colors.accentSoft, zIndex: 0,
  },
  scroll: { zIndex: 1, backgroundColor: 'transparent' },
  slot: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  slotText: { fontSize: 15, color: colors.inkMuted },
  slotTextOn: { color: colors.ink, fontWeight: '700' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});

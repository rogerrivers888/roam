/**
 * A holiday's days, cut into weeks (Hotels 2 §21).
 *
 * The owner asked what a fortnight would do to the day strip: sixteen chips
 * scroll off the edge and nothing tells you where you are in the trip. So past
 * a week the strip is cut into eights, a segmented control picks which one, and
 * the chips shrink so a week fits without scrolling.
 *
 * Pure, and separate from the screen, so it can be tested — `apps/web/test`
 * cannot import anything that pulls in react-native.
 */

export type Week<T> = { label: string; when: string; days: T[] };

const CHUNK = 8;
/** A tail shorter than this is named for what it is rather than "Week 3". */
const TAIL = 5;

export function weeksOf<T extends { date: string }>(days: T[]): Week<T>[] {
  if (days.length <= CHUNK) return [{ label: 'All', when: '', days }];
  const out: Week<T>[] = [];
  const at = (d: T) => new Date(`${d.date}T12:00:00`);
  const month = (d: Date) => d.toLocaleDateString([], { month: 'short' });
  for (let i = 0; i < days.length; i += CHUNK) {
    const chunk = days.slice(i, i + CHUNK);
    const tail = i + CHUNK >= days.length && chunk.length < TAIL;
    const a = at(chunk[0]);
    const b = at(chunk[chunk.length - 1]);
    out.push({
      label: tail ? (chunk.length === 1 ? 'Last day' : `Last ${chunk.length} days`) : `Week ${out.length + 1}`,
      when: chunk.length === 1
        ? String(a.getDate())
        : `${a.getDate()}${month(a) === month(b) ? '' : ` ${month(a)}`} – ${b.getDate()} ${month(b)}`,
      days: chunk,
    });
  }
  return out;
}

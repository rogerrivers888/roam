// When Roam chases, and what it says.
//
// The organiser does not chase people (owner, 4 Sep 2026: "reminders should
// actually be out of the box… as long as they're assured that the reminders are
// being sent, they shouldn't really need to manually trigger reminders. The
// next option open to them is to start calling people"). So the schedule is a
// property of the group — a set of days before the date everything is wanted
// by — and the organiser's screen shows when the next one goes, who it will go
// to, and how many have gone.
//
// The schedule is computed, never stored: people join and drop out for six
// weeks, and a stored list of sends would be wrong by the following morning.
// What is stored is what was actually written (group_reminders).

import { wallToUtc, DEFAULT_TZ } from './time.js';

/** How many times Roam writes to somebody who still has something outstanding. */
export const CADENCES = {
  gentle: { label: 'Gentle', count: 3 },
  standard: { label: 'Standard', count: 5 },
  firm: { label: 'Firm', count: 8 },
};
export const DEFAULT_CADENCE = 'standard';
/** Reminders land at breakfast, in the household's own time. */
export const REMINDER_AT = '09:00';
/** Nobody is written to twice inside this many hours, however many runs fall close together. */
export const QUIET_HOURS = 48;

const iso = (d) => d.toISOString().slice(0, 10);
// Dates arrive as 'YYYY-MM-DD' from a date column and as a Date from a
// timestamp one; both have to come out the same.
const ymd = (d) => {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};
const addDays = (dateStr, n) => {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86_400_000);

/**
 * Every run for a group, oldest first: `{ date, instant, daysBefore }`.
 *
 * The cadence says how many reminders there are; they are spread evenly between
 * the day the chasing starts and the day everything is wanted by. A group with
 * no date to work to is not chased at all — there is nothing to say beyond
 * "some time", which is what a group chat already says badly.
 */
export function schedule(group, tz = DEFAULT_TZ) {
  const end = ymd(group?.wanted_by);
  if (!end) return [];
  const from = ymd(group.first_reminder_on) ?? ymd(group.created_at) ?? iso(new Date());
  const count = (CADENCES[group.reminder_cadence] ?? CADENCES[DEFAULT_CADENCE]).count;
  const span = daysBetween(from, end);
  if (span <= 0) return [{ daysBefore: 0, date: end, instant: wallToUtc(end, REMINDER_AT, tz) }];
  const dates = [];
  for (let i = 0; i < count; i += 1) {
    const at = addDays(from, count === 1 ? 0 : Math.round((span * i) / (count - 1)));
    if (!dates.includes(at)) dates.push(at);
  }
  return dates.map((date) => ({ date, daysBefore: daysBetween(date, end), instant: wallToUtc(date, REMINDER_AT, tz) }));
}

/** The runs whose moment has passed and which have not been done yet. */
export function dueRuns(group, tz = DEFAULT_TZ, now = new Date(), doneDates = new Set()) {
  return schedule(group, tz).filter((r) => r.instant <= now && !doneDates.has(r.date));
}

/** The next run that has not happened, for the organiser's screen. */
export function nextRun(group, tz = DEFAULT_TZ, now = new Date()) {
  return schedule(group, tz).find((r) => r.instant > now) ?? null;
}

/**
 * What a reminder says. Written here rather than in a template so the organiser
 * can be shown the exact words before they go out, and the same words are kept
 * on the row afterwards.
 */
export function reminderBody({ organiser, groupName, participant, outstanding, wantedBy, joined, short }) {
  const by = wantedBy ? ` by ${new Date(`${String(wantedBy).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}` : '';
  const who = participant?.name ? `${participant.name.split(' ')[0]} — ` : '';
  if (!joined) return `${who}${organiser} has asked you to ${groupName}. Open the link they sent to say you are coming and see what is needed${by}.`;
  // Two things by name and a count for the rest: a text message nobody reads
  // to the end is not a reminder.
  const names = outstanding.slice(0, 2).map((o) => o.label);
  const rest = outstanding.length - names.length;
  const list = names.join(' and ') + (rest > 0 ? ` and ${rest} more thing${rest === 1 ? '' : 's'}` : '');
  // A cost that is short of its minimum is the one thing worth adding: it is
  // the only line in a reminder anybody can do something about together.
  const nudge = short ? ` ${short.more} more and ${short.label} runs.` : '';
  return `${who}${organiser} still needs ${list || 'a couple of things'} from you for ${groupName}${by}.${nudge} Your list is in Roam.`;
}

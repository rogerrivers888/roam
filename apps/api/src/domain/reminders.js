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

/** Days before `wanted_by` on which Roam writes to whoever still has something outstanding. */
export const CADENCES = {
  gentle: { label: 'Gentle', days: [21, 7, 2] },
  standard: { label: 'Standard', days: [28, 14, 7, 3, 1] },
  firm: { label: 'Firm', days: [28, 21, 14, 10, 7, 4, 2, 1] },
};
export const DEFAULT_CADENCE = 'standard';
/** Reminders land at breakfast, in the household's own time. */
export const REMINDER_AT = '09:00';
/** Nobody is written to twice inside this many hours, however many runs fall close together. */
export const QUIET_HOURS = 48;

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/**
 * Every run for a group, oldest first: `{ date, instant, daysBefore }`.
 * A group with no date to work to is not chased at all — there is nothing to
 * say beyond "some time", which is what a group chat already says badly.
 */
export function schedule(group, tz = DEFAULT_TZ) {
  if (!group?.wanted_by) return [];
  const wanted = String(group.wanted_by).slice(0, 10);
  const days = (CADENCES[group.reminder_cadence] ?? CADENCES[DEFAULT_CADENCE]).days;
  return days
    .map((daysBefore) => ({ daysBefore, date: addDays(wanted, -daysBefore) }))
    .filter((r) => r.date <= wanted) // never after the date itself
    .map((r) => ({ ...r, instant: wallToUtc(r.date, REMINDER_AT, tz) }))
    .sort((a, b) => a.instant - b.instant);
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

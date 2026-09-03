// Wall-clock ↔ instant conversion in an IANA timezone, without a library.
// "3 pm on Saturday" is 3 pm where the household is, whatever the server runs in.

function offsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), p.hour === '24' ? 0 : Number(p.hour), Number(p.minute), Number(p.second));
  return (asUtc - date.getTime()) / 60_000;
}

export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** 'YYYY-MM-DD' + 'HH:MM' in tz → Date (instant). */
export function wallToUtc(dateStr, hhmm, tz) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(hhmm || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi || 0);
  let utc = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  const off2 = offsetMinutes(new Date(utc), tz);
  if (off2 !== offsetMinutes(new Date(guess), tz)) utc = guess - off2 * 60_000;
  return new Date(utc);
}

/** Instant → wall clock in tz. */
export function wallClock(date, tz) {
  const d = new Date(date);
  const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  return { dateStr: `${p.year}-${p.month}-${p.day}`, hhmm: `${String(hour).padStart(2, '0')}:${p.minute}`, hour, minute: Number(p.minute), hours: hour + Number(p.minute) / 60 };
}

export const DEFAULT_TZ = 'Europe/London';

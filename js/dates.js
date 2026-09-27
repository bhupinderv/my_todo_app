// Date helpers. Due dates are date-only strings ("YYYY-MM-DD") in the user's
// local calendar; snooze times are full timestamps.

const DAY_MS = 86_400_000;

export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole calendar days from `fromISO` to `toISO` (negative if `toISO` is earlier). */
export function daysBetween(fromISO, toISO) {
  return Math.round((toUTC(toISO) - toUTC(fromISO)) / DAY_MS);
}

export function addDays(iso, n) {
  const d = new Date(toUTC(iso) + n * DAY_MS);
  return d.toISOString().slice(0, 10);
}

export function isValidISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(toUTC(value)).toISOString().slice(0, 10) === value;
}

/** Human label for a due date, plus a tone used for styling. */
export function formatDue(dueISO, today) {
  const days = daysBetween(today, dueISO);
  if (days < 0) {
    const n = -days;
    return { label: `Overdue ${n} day${n === 1 ? '' : 's'}`, tone: 'overdue' };
  }
  if (days === 0) return { label: 'Due today', tone: 'today' };
  if (days === 1) return { label: 'Tomorrow', tone: 'soon' };
  const date = new Date(toUTC(dueISO));
  if (days < 7) {
    return { label: date.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' }), tone: 'soon' };
  }
  return { label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }), tone: '' };
}

export function relativeTime(iso, now = new Date()) {
  const mins = Math.round((now - new Date(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Short label for a future timestamp, e.g. "15:30", "tomorrow 08:00", "Mon 08:00". */
export function formatWhen(iso, now = new Date()) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = daysBetween(todayISO(now), todayISO(d));
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const SNOOZE_OPTIONS = {
  later: 'Later today',
  tomorrow: 'Tomorrow morning',
  '3days': 'In 3 days',
  nextweek: 'Next week',
};

/** When a snooze of the given kind should end. Morning = 08:00 local. */
export function snoozeUntil(kind, now = new Date()) {
  const morning = (addDaysCount) => {
    const d = new Date(now);
    d.setDate(d.getDate() + addDaysCount);
    d.setHours(8, 0, 0, 0);
    return d;
  };
  switch (kind) {
    case 'later': return new Date(now.getTime() + 3 * 3_600_000);
    case 'tomorrow': return morning(1);
    case '3days': return morning(3);
    case 'nextweek': {
      // Next Monday — but never tomorrow, which "Tomorrow morning" already covers.
      const days = ((8 - now.getDay()) % 7) || 7;
      return morning(days === 1 ? 8 : days);
    }
    default: throw new Error(`Unknown snooze option: ${kind}`);
  }
}

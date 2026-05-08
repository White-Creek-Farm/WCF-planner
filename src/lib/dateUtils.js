// Date + format utilities. Verbatim extract from main.jsx.

export function addDays(dateOrISO, n) {
  const d = typeof dateOrISO === 'string' ? new Date(dateOrISO + 'T12:00:00') : new Date(dateOrISO);
  d.setDate(d.getDate() + n);
  return d;
}
export function toISO(d) {
  return new Date(d).toISOString().split('T')[0];
}
// Canonical calendar display = mm/dd/yy (2-digit month / 2-digit day / 2-digit
// year). Applied site-wide for any ISO date the user sees. Ronnie's request
// 2026-04-23. Accepts either a plain date string (YYYY-MM-DD) or a full ISO
// timestamp (YYYY-MM-DDTHH:MM:...) -- only the date portion is used.
export function fmt(iso) {
  if (!iso) return '—';
  const datePart = String(iso).slice(0, 10);
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return '—';
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const yy = String(y).slice(-2);
  return mm + '/' + dd + '/' + yy;
}
// Short variant drops the year for compact tiles; still mm/dd.
export function fmtS(iso) {
  if (!iso) return '—';
  const datePart = String(iso).slice(0, 10);
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return '—';
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return mm + '/' + dd;
}
export function todayISO() {
  return toISO(new Date());
}

// "Today" as a YYYY-MM-DD string in America/Chicago (Central Time).
//
// Tasks are date-only / Central time per Ronnie's lock — overdue and
// due-today comparisons must not flip just because a user opens the
// app on a phone whose timezone is set to UTC, Mountain, or anywhere
// else. Implementation uses Intl.formatToParts so we never construct
// an intermediate Date in the browser's local zone (which would
// reintroduce the same drift this helper exists to prevent).
//
// Caller passes an optional Date (or epoch ms) for testability;
// production callers can omit and get new Date().
export function todayCentralISO(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now instanceof Date ? now : new Date(now));
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : '';
  };
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Format a timestamptz (ISO string, Date, or epoch ms) as
//   "mm/dd/yy h:mm AM/PM" in America/Chicago.
//
// Used by the Task Center's Completed tab so completed_at displays
// in farm time regardless of the viewer's browser timezone (Tasks
// are Central-time per Ronnie's lock — same reason todayCentralISO
// exists). Returns "—" for null/empty/malformed input.
export function fmtCentralDateTime(input) {
  if (input === null || input === undefined || input === '') return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
}

// ── HOLIDAY LOGIC ──────────────────────────────────────────────────────────

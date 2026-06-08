import {centralISOFor} from './dateUtils.js';

function csvText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function csvCell(value) {
  let text = csvText(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Neutralize spreadsheet formula/DDE injection: prefix a leading =,+,-,@,tab,
  // newline, or | (pipe — DDE in some locales) with a single quote.
  if (/^[=+\-@\t\n|]/.test(text)) text = "'" + text;
  if (/[",\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

export function rowsToCsv(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  lines.push(cols.map((c) => csvCell(c.header || c.key || '')).join(','));
  for (const row of list) {
    lines.push(
      cols
        .map((c) => {
          if (typeof c.value === 'function') return csvCell(c.value(row));
          return csvCell(row ? row[c.key] : '');
        })
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export function csvFilename(prefix, date = new Date()) {
  const safePrefix = String(prefix || 'export')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const stamp = centralISOFor(date) || 'today';
  return (safePrefix || 'export') + '-' + stamp + '.csv';
}

export function downloadCsv(filename, csv) {
  if (
    typeof document === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return false;
  }
  const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof URL.revokeObjectURL === 'function') {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return true;
}

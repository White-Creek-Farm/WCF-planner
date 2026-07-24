import {csvCell} from './csvExport.js';

export function roundToHundredths(value) {
  return Math.round(value * 100) / 100;
}

export function averageEntryWeight(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const average = entries.reduce((sum, entry) => sum + (parseFloat(entry.weight) || 0), 0) / entries.length;
  return roundToHundredths(average);
}

export function buildRuminantWeighInSessionColumns({
  groupHeader,
  groupLabels,
  entriesBySession,
  tagQ,
  entryMatchesTag,
}) {
  return [
    {header: 'Date', value: (session) => session.date || ''},
    {header: groupHeader, value: (session) => groupLabels[session.herd] || session.herd || ''},
    {header: 'Status', value: (session) => session.status || ''},
    {header: 'Team member', value: (session) => session.team_member || ''},
    {header: 'Entry count', value: (session) => (entriesBySession[session.id] || []).length},
    {
      header: 'Matching tag entries',
      value: (session) =>
        tagQ && typeof entryMatchesTag === 'function'
          ? (entriesBySession[session.id] || []).filter(entryMatchesTag).length
          : '',
    },
    {
      header: 'New tag count',
      value: (session) => (entriesBySession[session.id] || []).filter((entry) => entry.new_tag_flag).length,
    },
    {header: 'Started at', value: (session) => session.started_at || ''},
    {header: 'Session ID', value: (session) => session.id || ''},
  ];
}

export function buildLivestockWeighInSessionColumns({species, speciesLabel, entriesBySession}) {
  return [
    {header: 'Date', value: (session) => session.date || ''},
    {header: 'Species', value: () => speciesLabel},
    {header: 'Batch ID', value: (session) => session.batch_id || ''},
    {header: 'Broiler week', value: (session) => (species === 'broiler' ? session.broiler_week || '' : '')},
    {header: 'Status', value: (session) => session.status || ''},
    {header: 'Team member', value: (session) => session.team_member || ''},
    {header: 'Entry count', value: (session) => (entriesBySession[session.id] || []).length},
    {header: 'Average weight', value: (session) => averageEntryWeight(entriesBySession[session.id] || [])},
    {header: 'Started at', value: (session) => session.started_at || ''},
    {header: 'Session ID', value: (session) => session.id || ''},
  ];
}

// ── Weigh-in session RECORD-PAGE entry sorting + CSV export ───────────────────
//
// The functions below power the per-session entry table on
// WeighInSessionPage.jsx: sortable columns and an "Export CSV" of every entry in
// the current on-screen sort order. They are PURE — the component projects each
// entry into a plain typed row and hands the rows here, so comparators, missing
// handling, stability, CSV escaping/injection-defense, and filenames are all
// unit-testable without React.

// Natural / numeric-aware alphanumeric compare for tags ("A9" < "A10", "2" < "10").
export function compareAlnum(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  const ra = sa.match(/\d+|\D+/g) || [];
  const rb = sb.match(/\d+|\D+/g) || [];
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const ca = ra[i];
    const cb = rb[i];
    const numA = /^\d/.test(ca);
    const numB = /^\d/.test(cb);
    if (numA && numB) {
      const da = parseInt(ca, 10);
      const db = parseInt(cb, 10);
      if (da !== db) return da < db ? -1 : 1;
    } else {
      const c = ca.localeCompare(cb, undefined, {sensitivity: 'base'});
      if (c !== 0) return c;
    }
  }
  if (ra.length !== rb.length) return ra.length < rb.length ? -1 : 1;
  return 0;
}

export function compareNumber(a, b) {
  const na = typeof a === 'number' ? a : parseFloat(a);
  const nb = typeof b === 'number' ? b : parseFloat(b);
  if (na < nb) return -1;
  if (na > nb) return 1;
  return 0;
}

export function compareText(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  return sa.localeCompare(sb, undefined, {sensitivity: 'base'});
}

// ISO date/timestamp strings sort chronologically under lexicographic compare.
export function compareChrono(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

const COMPARATORS = {alnum: compareAlnum, number: compareNumber, text: compareText, time: compareChrono};

// A value is "missing" (always sorts last, regardless of direction) when it is
// null/undefined, an empty/whitespace string, or a non-finite number.
export function isMissingValue(value, type) {
  if (value == null) return true;
  if (type === 'number') {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return !Number.isFinite(n);
  }
  return String(value).trim() === '';
}

// Stable typed sort of already-projected rows. Missing values always sort last;
// present values obey the direction; ties break deterministically by the row's
// _tie key then _id so equal rows never reorder run-to-run.
export function sortWeighInEntryRows(rows, sortState, columnsByKey) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!sortState || !sortState.key) return list;
  const col = (columnsByKey || {})[sortState.key];
  if (!col || col.sortable === false) return list;
  const type = col.type || 'text';
  const cmp = COMPARATORS[type] || compareText;
  const dir = sortState.dir === 'desc' ? -1 : 1;
  const withIndex = list.map((row, index) => ({row, index}));
  withIndex.sort((a, b) => {
    const av = a.row ? a.row[sortState.key] : undefined;
    const bv = b.row ? b.row[sortState.key] : undefined;
    const am = isMissingValue(av, type);
    const bm = isMissingValue(bv, type);
    if (am && bm) return tieBreak(a, b);
    if (am) return 1;
    if (bm) return -1;
    const c = cmp(av, bv);
    if (c !== 0) return c * dir;
    return tieBreak(a, b);
  });
  return withIndex.map((w) => w.row);
}

function tieBreak(a, b) {
  const ta = a.row && a.row._tie != null ? String(a.row._tie) : '';
  const tb = b.row && b.row._tie != null ? String(b.row._tie) : '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = a.row && a.row._id != null ? String(a.row._id) : '';
  const ib = b.row && b.row._id != null ? String(b.row._id) : '';
  if (ia !== ib) return ia < ib ? -1 : 1;
  // Final fallback: original input index keeps the sort deterministic + stable.
  return a.index - b.index;
}

// On-screen sortable-column model per species. Action/selection columns are
// present (so the component can render every header) but sortable:false.
export function weighInEntrySortColumns(species) {
  if (species === 'pig') {
    return [
      {key: 'select', label: 'Trip', type: null, sortable: false},
      {key: 'weight', label: 'Weight', type: 'number', sortable: true},
      {key: 'note', label: 'Note', type: 'text', sortable: true},
      {key: 'priorWeight', label: 'Prior', type: 'number', sortable: true},
      {key: 'days', label: 'Days', type: 'number', sortable: true},
      {key: 'delta', label: '+/-', type: 'number', sortable: true},
      {key: 'adg', label: 'ADG', type: 'number', sortable: true},
      {key: 'rowStatus', label: 'Status', type: 'text', sortable: true},
      {key: 'actions', label: '', type: null, sortable: false},
    ];
  }
  return [
    {key: 'tag', label: 'Tag', type: 'alnum', sortable: true},
    {key: 'weight', label: 'Weight', type: 'number', sortable: true},
    {key: 'note', label: 'Note', type: 'text', sortable: true},
    {key: 'priorWeight', label: 'Prior', type: 'number', sortable: true},
    {key: 'days', label: 'Days', type: 'number', sortable: true},
    {key: 'delta', label: '+/-', type: 'number', sortable: true},
    {key: 'adg', label: 'ADG', type: 'number', sortable: true},
    {key: 'groupSort', label: species === 'sheep' ? 'Flock/Status' : 'Herd/Status', type: 'text', sortable: true},
    {key: 'time', label: 'Time', type: 'time', sortable: true},
    {key: 'actions', label: '', type: null, sortable: false},
  ];
}

// CSV export columns per species. type drives serialization: 'number' cells emit
// the raw numeric value (never formula-escaped, so a legitimate negative like
// -3.2 stays a number); every other cell is treated as text and injection-defended.
export function weighInEntryExportColumns(species) {
  const common = [
    {header: 'Session date', key: 'sessionDate', type: 'text'},
    {header: 'Species', key: 'species', type: 'text'},
  ];
  if (species === 'pig') {
    return [
      ...common,
      {header: 'Batch', key: 'group', type: 'text'},
      {header: 'Session status', key: 'sessionStatus', type: 'text'},
      {header: 'Team member', key: 'teamMember', type: 'text'},
      {header: 'Weight (lb)', key: 'weight', type: 'number'},
      {header: 'Note', key: 'note', type: 'text'},
      {header: 'Prior weight (lb)', key: 'priorWeight', type: 'number'},
      {header: 'Prior date', key: 'priorDate', type: 'text'},
      {header: 'Days since prior', key: 'days', type: 'number'},
      {header: 'Weight change (lb)', key: 'delta', type: 'number'},
      {header: 'ADG (lb/day)', key: 'adg', type: 'number'},
      {header: 'Row status', key: 'rowStatus', type: 'text'},
    ];
  }
  return [
    ...common,
    {header: species === 'sheep' ? 'Flock' : 'Herd', key: 'group', type: 'text'},
    {header: 'Session status', key: 'sessionStatus', type: 'text'},
    {header: 'Team member', key: 'teamMember', type: 'text'},
    {header: 'Tag', key: 'tag', type: 'text'},
    {header: 'Weight (lb)', key: 'weight', type: 'number'},
    {header: 'Note', key: 'note', type: 'text'},
    {header: 'Prior weight (lb)', key: 'priorWeight', type: 'number'},
    {header: 'Prior date', key: 'priorDate', type: 'text'},
    {header: 'Days since prior', key: 'days', type: 'number'},
    {header: 'Weight change (lb)', key: 'delta', type: 'number'},
    {header: 'ADG (lb/day)', key: 'adg', type: 'number'},
    {header: 'Row status', key: 'rowStatus', type: 'text'},
    {header: 'Entry time', key: 'time', type: 'text'},
  ];
}

// Serialize projected rows to Excel-compatible UTF-8 CSV. A leading BOM makes
// Excel read UTF-8 correctly; numeric columns emit the raw value (no formula
// prefix, so legitimate numbers keep their type); text columns route through
// csvCell for quote/comma/newline escaping AND formula/DDE-injection defense.
export function serializeWeighInEntriesCsv(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];
  const cell = (col, row) => {
    const raw = typeof col.value === 'function' ? col.value(row) : row ? row[col.key] : '';
    if (col.type === 'number') {
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      return Number.isFinite(n) ? String(n) : '';
    }
    return csvCell(raw == null ? '' : raw);
  };
  const lines = [cols.map((c) => csvCell(c.header || c.key || '')).join(',')];
  for (const row of list) lines.push(cols.map((c) => cell(c, row)).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Meaningful, filesystem-safe filename: weighin-<species>-<group>-<date>.csv.
export function weighInSessionCsvFilename({species, group, date} = {}) {
  const clean = (s) =>
    String(s == null ? '' : s)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const parts = ['weighin', clean(species), clean(group), clean(date)].filter(Boolean);
  return (parts.join('-') || 'weighin') + '.csv';
}

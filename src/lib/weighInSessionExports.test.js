import {describe, expect, it} from 'vitest';
import {
  averageEntryWeight,
  buildLivestockWeighInSessionColumns,
  buildRuminantWeighInSessionColumns,
  roundToHundredths,
  compareAlnum,
  compareNumber,
  compareText,
  compareChrono,
  isMissingValue,
  sortWeighInEntryRows,
  weighInEntrySortColumns,
  weighInEntryExportColumns,
  serializeWeighInEntriesCsv,
  weighInSessionCsvFilename,
} from './weighInSessionExports.js';

function byKey(columns) {
  return Object.fromEntries(columns.map((c) => [c.key, c]));
}

function valueFor(columns, header, session) {
  return columns.find((column) => column.header === header).value(session);
}

describe('weighInSessionExports', () => {
  it('rounds average entry weights to hundredths while preserving empty sessions', () => {
    expect(roundToHundredths(12.345)).toBe(12.35);
    expect(averageEntryWeight([])).toBe('');
    expect(averageEntryWeight([{weight: '10'}, {weight: '13.333'}, {weight: ''}])).toBe(7.78);
  });

  it('builds ruminant session columns with group labels and tag counts', () => {
    const columns = buildRuminantWeighInSessionColumns({
      groupHeader: 'Herd',
      groupLabels: {mommas: 'Mommas'},
      entriesBySession: {
        session1: [
          {tag: '101', new_tag_flag: true},
          {tag: '202', new_tag_flag: false},
        ],
      },
      tagQ: '10',
      entryMatchesTag: (entry) => entry.tag.includes('10'),
    });
    const session = {id: 'session1', date: '2026-06-08', herd: 'mommas', status: 'draft', team_member: 'Ronni'};

    expect(columns.map((column) => column.header)).toEqual([
      'Date',
      'Herd',
      'Status',
      'Team member',
      'Entry count',
      'Matching tag entries',
      'New tag count',
      'Started at',
      'Session ID',
    ]);
    expect(valueFor(columns, 'Herd', session)).toBe('Mommas');
    expect(valueFor(columns, 'Entry count', session)).toBe(2);
    expect(valueFor(columns, 'Matching tag entries', session)).toBe(1);
    expect(valueFor(columns, 'New tag count', session)).toBe(1);
  });

  it('leaves ruminant matching-tag counts blank when no tag search is active', () => {
    const columns = buildRuminantWeighInSessionColumns({
      groupHeader: 'Flock',
      groupLabels: {},
      entriesBySession: {session1: [{tag: '101', new_tag_flag: false}]},
      tagQ: '',
      entryMatchesTag: () => true,
    });

    expect(valueFor(columns, 'Flock', {id: 'session1', herd: 'ewes'})).toBe('ewes');
    expect(valueFor(columns, 'Matching tag entries', {id: 'session1'})).toBe('');
  });

  it('builds livestock session columns with species, broiler week, and average weight', () => {
    const columns = buildLivestockWeighInSessionColumns({
      species: 'broiler',
      speciesLabel: 'Broiler',
      entriesBySession: {session1: [{weight: '4.1'}, {weight: '4.245'}]},
    });
    const session = {id: 'session1', date: '2026-06-08', batch_id: 'B-1', broiler_week: '5'};

    expect(columns.map((column) => column.header)).toEqual([
      'Date',
      'Species',
      'Batch ID',
      'Broiler week',
      'Status',
      'Team member',
      'Entry count',
      'Average weight',
      'Started at',
      'Session ID',
    ]);
    expect(valueFor(columns, 'Species', session)).toBe('Broiler');
    expect(valueFor(columns, 'Broiler week', session)).toBe('5');
    expect(valueFor(columns, 'Entry count', session)).toBe(2);
    expect(valueFor(columns, 'Average weight', session)).toBe(4.17);
  });

  it('omits broiler week values for non-broiler livestock lists', () => {
    const columns = buildLivestockWeighInSessionColumns({
      species: 'pig',
      speciesLabel: 'Pig',
      entriesBySession: {session1: [{weight: '20'}]},
    });

    expect(valueFor(columns, 'Broiler week', {id: 'session1', broiler_week: '9'})).toBe('');
  });
});

describe('weigh-in entry comparators', () => {
  it('compareAlnum sorts tags numerically-aware and naturally', () => {
    expect(compareAlnum('2', '10')).toBeLessThan(0);
    expect(compareAlnum('10', '2')).toBeGreaterThan(0);
    expect(compareAlnum('A9', 'A10')).toBeLessThan(0);
    expect(compareAlnum('A10', 'A9')).toBeGreaterThan(0);
    expect(compareAlnum('101', '101')).toBe(0);
    expect(compareAlnum('B1', 'A1')).toBeGreaterThan(0);
  });

  it('compareNumber orders numbers including negatives', () => {
    expect(compareNumber(-5, 3)).toBeLessThan(0);
    expect(compareNumber(3, -5)).toBeGreaterThan(0);
    expect(compareNumber('2.5', '2.5')).toBe(0);
  });

  it('compareText is locale-aware and case-insensitive', () => {
    expect(compareText('alpha', 'beta')).toBeLessThan(0);
    expect(compareText('Beta', 'alpha')).toBeGreaterThan(0);
    expect(compareText('x', 'x')).toBe(0);
  });

  it('compareChrono orders ISO timestamps chronologically', () => {
    expect(compareChrono('2026-01-01T09:00:00Z', '2026-01-01T10:00:00Z')).toBeLessThan(0);
    expect(compareChrono('2026-01-02', '2026-01-01')).toBeGreaterThan(0);
  });

  it('isMissingValue treats null/blank/non-finite as missing', () => {
    expect(isMissingValue(null, 'number')).toBe(true);
    expect(isMissingValue(NaN, 'number')).toBe(true);
    expect(isMissingValue(0, 'number')).toBe(false);
    expect(isMissingValue(-3.2, 'number')).toBe(false);
    expect(isMissingValue('', 'text')).toBe(true);
    expect(isMissingValue('   ', 'text')).toBe(true);
    expect(isMissingValue('x', 'text')).toBe(false);
  });
});

describe('sortWeighInEntryRows', () => {
  const cols = byKey(weighInEntrySortColumns('cattle'));
  const rows = () => [
    {_id: 'a', _tie: '2026-01-01T10:00:00Z', tag: '10', weight: 500, note: 'beta', days: 30, delta: -5, adg: -0.2},
    {_id: 'b', _tie: '2026-01-01T09:00:00Z', tag: '2', weight: 520, note: 'alpha', days: 10, delta: 3, adg: 0.5},
    {_id: 'c', _tie: '2026-01-01T11:00:00Z', tag: '', weight: null, note: '', days: null, delta: null, adg: null},
  ];

  it('returns the input order unchanged when no sort is active', () => {
    expect(sortWeighInEntryRows(rows(), null, cols).map((r) => r._id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts a numeric-aware tag column ascending with missing last', () => {
    expect(sortWeighInEntryRows(rows(), {key: 'tag', dir: 'asc'}, cols).map((r) => r._id)).toEqual(['b', 'a', 'c']);
  });

  it('descending keeps missing values last (missing is never affected by direction)', () => {
    expect(sortWeighInEntryRows(rows(), {key: 'tag', dir: 'desc'}, cols).map((r) => r._id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts numeric columns including negatives, missing last', () => {
    expect(sortWeighInEntryRows(rows(), {key: 'delta', dir: 'asc'}, cols).map((r) => r._id)).toEqual(['a', 'b', 'c']);
    expect(sortWeighInEntryRows(rows(), {key: 'delta', dir: 'desc'}, cols).map((r) => r._id)).toEqual(['b', 'a', 'c']);
  });

  it('is stable + deterministic: equal values break by _tie then _id', () => {
    const tied = [
      {_id: 'z', _tie: '2026-01-01T10:00:00Z', weight: 500},
      {_id: 'y', _tie: '2026-01-01T09:00:00Z', weight: 500},
      {_id: 'x', _tie: '2026-01-01T09:00:00Z', weight: 500},
    ];
    // All equal weight -> order by _tie asc (y,x before z), then _id asc (x before y).
    expect(sortWeighInEntryRows(tied, {key: 'weight', dir: 'asc'}, cols).map((r) => r._id)).toEqual(['x', 'y', 'z']);
    expect(sortWeighInEntryRows(tied, {key: 'weight', dir: 'desc'}, cols).map((r) => r._id)).toEqual(['x', 'y', 'z']);
  });

  it('does not mutate the input array', () => {
    const input = rows();
    const snapshot = input.map((r) => r._id);
    sortWeighInEntryRows(input, {key: 'weight', dir: 'desc'}, cols);
    expect(input.map((r) => r._id)).toEqual(snapshot);
  });

  it('ignores a non-sortable column key', () => {
    expect(sortWeighInEntryRows(rows(), {key: 'actions', dir: 'asc'}, cols).map((r) => r._id)).toEqual(['a', 'b', 'c']);
  });
});

describe('weighInEntrySortColumns', () => {
  it('marks action + selection columns non-sortable and every data column sortable', () => {
    const pig = weighInEntrySortColumns('pig');
    expect(pig.find((c) => c.key === 'select').sortable).toBe(false);
    expect(pig.find((c) => c.key === 'actions').sortable).toBe(false);
    expect(pig.some((c) => c.key === 'tag')).toBe(false);
    for (const key of ['weight', 'note', 'priorWeight', 'days', 'delta', 'adg', 'rowStatus']) {
      expect(pig.find((c) => c.key === key).sortable).toBe(true);
    }
    const cattle = weighInEntrySortColumns('cattle');
    expect(cattle.find((c) => c.key === 'actions').sortable).toBe(false);
    expect(cattle.find((c) => c.key === 'groupSort').label).toBe('Herd/Status');
    for (const key of ['tag', 'weight', 'note', 'priorWeight', 'days', 'delta', 'adg', 'groupSort', 'time']) {
      expect(cattle.find((c) => c.key === key).sortable).toBe(true);
    }
    expect(weighInEntrySortColumns('sheep').find((c) => c.key === 'groupSort').label).toBe('Flock/Status');
  });
});

describe('weighInEntryExportColumns', () => {
  it('includes Tag + Entry time for cattle/sheep and Batch (no Tag/Time) for pig', () => {
    const cattle = weighInEntryExportColumns('cattle').map((c) => c.header);
    for (const h of [
      'Session date',
      'Species',
      'Herd',
      'Session status',
      'Team member',
      'Tag',
      'Weight (lb)',
      'Note',
      'Prior weight (lb)',
      'Prior date',
      'Days since prior',
      'Weight change (lb)',
      'ADG (lb/day)',
      'Row status',
      'Entry time',
    ]) {
      expect(cattle).toContain(h);
    }
    expect(weighInEntryExportColumns('sheep').map((c) => c.header)).toContain('Flock');
    const pig = weighInEntryExportColumns('pig').map((c) => c.header);
    expect(pig).toContain('Batch');
    expect(pig).not.toContain('Tag');
    expect(pig).not.toContain('Entry time');
  });
});

describe('serializeWeighInEntriesCsv', () => {
  const cols = [
    {header: 'Tag', key: 'tag', type: 'text'},
    {header: 'Weight (lb)', key: 'weight', type: 'number'},
    {header: 'Note', key: 'note', type: 'text'},
    {header: 'ADG (lb/day)', key: 'adg', type: 'number'},
  ];

  it('emits a BOM, CRLF rows, numeric-raw negatives, and injection-defended text', () => {
    const csv = serializeWeighInEntriesCsv(cols, [
      {tag: '101', weight: 500, note: 'ok', adg: -0.25},
      {tag: '=danger', weight: 520, note: 'a,b\nc', adg: 1.5},
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('Tag,Weight (lb),Note,ADG (lb/day)\r\n');
    // Legitimate negative numeric stays a raw number (NOT converted to text).
    expect(csv).toContain('101,500,ok,-0.25\r\n');
    expect(csv).not.toContain("'-0.25");
    // Text formula-injection is neutralized; comma+newline text is quote-escaped.
    expect(csv).toContain("'=danger");
    expect(csv).toContain('"a,b\nc"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('exports rows in the exact order given (current on-screen order)', () => {
    const first = serializeWeighInEntriesCsv(cols, [
      {tag: 'b', weight: 1},
      {tag: 'a', weight: 2},
    ]);
    const body = first.slice(1).split('\r\n');
    expect(body[1]).toBe('b,1,,');
    expect(body[2]).toBe('a,2,,');
  });

  it('renders missing numeric cells as empty, never NaN', () => {
    const csv = serializeWeighInEntriesCsv(cols, [{tag: 'x', weight: null, note: '', adg: undefined}]);
    expect(csv).toContain('x,,,\r\n');
    expect(csv).not.toContain('NaN');
  });
});

describe('weighInSessionCsvFilename', () => {
  it('builds a sanitized species/group/date filename', () => {
    expect(weighInSessionCsvFilename({species: 'cattle', group: 'Finishers', date: '2026-07-24'})).toBe(
      'weighin-cattle-finishers-2026-07-24.csv',
    );
    expect(weighInSessionCsvFilename({species: 'pig', group: 'P-26-01', date: '2026-07-24'})).toBe(
      'weighin-pig-p-26-01-2026-07-24.csv',
    );
    expect(weighInSessionCsvFilename({})).toBe('weighin.csv');
  });
});

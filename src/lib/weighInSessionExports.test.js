import {describe, expect, it} from 'vitest';
import {
  averageEntryWeight,
  buildLivestockWeighInSessionColumns,
  buildRuminantWeighInSessionColumns,
  roundToHundredths,
} from './weighInSessionExports.js';

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

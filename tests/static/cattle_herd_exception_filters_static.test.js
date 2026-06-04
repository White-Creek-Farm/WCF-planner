import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const herdsView = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
const filtersLib = fs.readFileSync(path.join(ROOT, 'src/lib/cattleHerdFilters.js'), 'utf8');

describe('Cattle herd exception checkbox filters', () => {
  it('renders both requested herd-tab checkbox labels with stable data hooks', () => {
    expect(herdsView).toContain('Non Calving Cows');
    expect(herdsView).toContain('Unmatched Calves');
    expect(herdsView).toContain('data-cattle-special-filter={filterKey}');
    expect(herdsView).toContain('data-cattle-special-filter-checkbox={filterKey}');
  });

  it('registers the exception filter keys in the pure cattle filter module', () => {
    expect(filtersLib).toContain("'nonCalvingCows'");
    expect(filtersLib).toContain("'unmatchedCalves'");
    expect(filtersLib).toContain('isNonCalvingCow(cow, calvingRecs, todayMs)');
    expect(filtersLib).toContain('isUnmatchedCalf(cow, todayMs)');
  });
});

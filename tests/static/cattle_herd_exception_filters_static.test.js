import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const herdsView = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
const filtersLib = fs.readFileSync(path.join(ROOT, 'src/lib/cattleHerdFilters.js'), 'utf8');
const savedViewsApi = fs.readFileSync(path.join(ROOT, 'src/lib/savedViewsApi.js'), 'utf8');

// ============================================================================
// Cattle herd filter UX lock (post smart-assistant removal) — surface_key
// cattle.herds saved views, organized always-visible groups, configurable
// non-calving cutoff, and flat/grouped row parity.
// ============================================================================

describe('Cattle herd exception filters + groups', () => {
  it('still renders both exception filter labels', () => {
    expect(herdsView).toContain('Non Calving Cows');
    expect(herdsView).toContain('Unmatched Calves');
  });

  it('registers the exception + cutoff filter keys in the pure module', () => {
    expect(filtersLib).toContain("'nonCalvingCows'");
    expect(filtersLib).toContain("'nonCalvingCutoffDate'");
    expect(filtersLib).toContain("'unmatchedCalves'");
    expect(filtersLib).toContain('isNonCalvingCow(cow, calvingRecs, todayMs)');
    expect(filtersLib).toContain('export function isNonCalvingCowSince');
    expect(filtersLib).toContain('isUnmatchedCalf(cow, todayMs)');
  });

  it('wires the configurable "no calf since" cutoff control', () => {
    expect(herdsView).toContain('nonCalvingCutoffDate');
    expect(herdsView).toContain('data-cattle-noncalving-cutoff');
  });
});

describe('Cattle herd filters — smart assistant fully removed', () => {
  it('drops the plain-English/Parse smart filter from the view', () => {
    expect(herdsView).not.toContain('parseSmartFilter');
    expect(herdsView).not.toContain('data-smart-input');
    expect(herdsView).not.toContain('data-smart-apply');
    expect(herdsView).not.toContain('data-smart-preview');
    expect(herdsView).not.toMatch(/plain English/i);
  });

  it('drops the smart parser + vocabulary from the pure module', () => {
    expect(filtersLib).not.toContain('parseSmartFilter');
    expect(filtersLib).not.toContain('CATTLE_FILTER_VOCAB');
  });
});

describe('Cattle herd filters — always-visible organized groups', () => {
  it('removes the More filters / Hide more filters toggle', () => {
    expect(herdsView).not.toContain('More filters');
    expect(herdsView).not.toContain('Hide more filters');
    expect(herdsView).not.toContain('data-more-filters-toggle');
    expect(herdsView).not.toContain('showMoreFilters');
    expect(herdsView).not.toContain('data-cattle-special-filters-row');
  });

  it('renders the four organized filter groups', () => {
    expect(herdsView).toContain('data-cattle-filter-groups');
    expect(herdsView).toContain('data-filter-group');
    expect(herdsView).toContain("label: 'Core'");
    expect(herdsView).toContain("label: 'Calving/Breeding'");
    expect(herdsView).toContain("label: 'Lineage/Other'");
    expect(herdsView).toContain("label: 'Exceptions'");
  });
});

describe('Cattle herd rows — flat/grouped parity via shared renderer', () => {
  it('uses one CowListRow for both lists', () => {
    expect(herdsView).toContain('function CowListRow');
    // Both the flat list and the grouped tiles render through CowListRow.
    const cowListRowUses = herdsView.match(/<CowListRow/g) || [];
    expect(cowListRowUses.length).toBeGreaterThanOrEqual(2);
  });

  it('shows calf count + last calved metadata in the shared row', () => {
    expect(herdsView).toContain('data-calf-count');
    expect(herdsView).toContain("'Calves: '");
    expect(herdsView).toContain("'last calved '");
  });
});

describe('Cattle herd saved views (surface_key cattle.herds)', () => {
  it('imports the saved-views API into the view', () => {
    expect(herdsView).toContain("from '../lib/savedViewsApi.js'");
    expect(herdsView).toContain("CATTLE_HERDS_SURFACE_KEY = 'cattle.herds'");
  });

  it('renders save / select / update / delete controls', () => {
    expect(herdsView).toContain('data-saved-view-select');
    expect(herdsView).toContain('data-saved-view-save');
    expect(herdsView).toContain('data-saved-view-update');
    expect(herdsView).toContain('data-saved-view-delete');
    expect(herdsView).toContain('data-saved-view-visibility');
  });

  it('saved state captures filters + sortRules + viewMode', () => {
    expect(savedViewsApi).toContain('filters');
    expect(savedViewsApi).toContain('sortRules');
    expect(savedViewsApi).toContain('viewMode');
    expect(herdsView).toContain('buildViewState({filters, sortRules, viewMode})');
  });

  it('saved-view load failures degrade gracefully (cold-boot safety)', () => {
    expect(herdsView).toContain('data-saved-views-error');
    expect(herdsView).toContain('savedViewsError');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {VIEW_TO_PATH, PATH_TO_VIEW} from '../../src/lib/routes.js';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const homeSrc = read('src/dashboard/HomeDashboard.jsx');
const pageSrc = read('src/dashboard/AnimalHistoryPage.jsx');
const mainSrc = read('src/main.jsx');
const helperSrc = read('src/lib/animalHistory.js');
const housingHelperSrc = read('src/lib/layerHousing.js');
const homeCssSrc = read('src/dashboard/homeRedesign.css');

describe('Home Animals on Farm history route', () => {
  it('registers the canonical Animals on Farm history path', () => {
    expect(VIEW_TO_PATH.animalHistory).toBe('/animals-on-farm');
    expect(PATH_TO_VIEW['/animals-on-farm']).toBe('animalHistory');
  });

  it('homepage Animals on Farm card opens the real history view', () => {
    expect(homeSrc).toContain("onClick={() => setView('animalHistory')}");
    expect(homeSrc).not.toContain("setComingSoon('Animals on Farm')");
    expect(homeSrc).not.toMatch(/Animals on Farm[\s\S]{0,400}data-status="not-built"/);
  });

  it('main.jsx allows and renders the animalHistory view', () => {
    expect(mainSrc).toContain("import AnimalHistoryPage from './dashboard/AnimalHistoryPage.jsx'");
    expect(mainSrc).toMatch(/VALID_VIEWS\s*=\s*\[[\s\S]*?'animalHistory'/);
    expect(mainSrc).toContain("if (view === 'animalHistory') return React.createElement(AnimalHistoryPage, {Header})");
  });

  it('AnimalHistoryPage builds the table and species small multiples from the shared helper plus cattle/sheep transfers', () => {
    expect(pageSrc).toContain('buildAnimalHistoryRows');
    expect(pageSrc).toContain("fetchAllRows('cattle'");
    expect(pageSrc).toContain("fetchAllRows('sheep'");
    expect(pageSrc).toContain("fetchAllRows('cattle_transfers'");
    expect(pageSrc).toContain("fetchAllRows('sheep_transfers'");
    expect(pageSrc).toContain('data-animal-history-chart="multiples"');
    expect(pageSrc).toContain('data-animal-history-chart-empty="true"');
    expect(pageSrc).toContain('data-animal-history-table="true"');
    expect(pageSrc).toContain('data-animal-history-loaded={loading || loadError ?');
    expect(pageSrc).toContain('data-animal-history-retry="1"');
    expect(pageSrc).toContain('<InlineNotice notice={loadError} />');
    expect(pageSrc).toContain('row.isPartialMonth');
    expect(pageSrc).toContain('fmt(row.snapshotDate)');
    expect(pageSrc).toContain('current month as of');
  });

  it('species small multiples each own their y-scale and stay off a shared axis', () => {
    // One chart per species; the y-max comes from that species' values only.
    expect(pageSrc).toContain('animalHistoryScaleMax(chronological.map((row) => row[species.key] || 0))');
    expect(pageSrc).toContain('data-animal-history-series={species.key}');
    expect(pageSrc).toContain('data-animal-history-latest={species.key}');
    expect(pageSrc).toContain('data-animal-history-scale-note="true"');
    // The retired shared-scale single chart and its legend must not return.
    expect(pageSrc).not.toContain('CHART_SERIES');
    expect(pageSrc).not.toContain('data-animal-history-chart="line"');
    expect(pageSrc).not.toContain('animal-history-legend');
    // Small multiples are honest headcounts: no log scale or normalization.
    expect(pageSrc).not.toMatch(/Math\.log|logScale|percentOfMax/);
  });

  it('Home Animals on Farm card uses the shared current animal snapshot', () => {
    expect(homeSrc).toContain('buildAnimalHistorySnapshot');
    expect(homeSrc).toContain('animalSnapshot.layers');
    expect(homeSrc).toContain('layerBatches');
    expect(homeSrc).not.toContain('computeHousingDisplayCount');
    expect(homeSrc).not.toContain('const totalHens =');
    expect(homeSrc).not.toContain('cattleOnFarmCount.toLocaleString()');
  });

  it('freshness disclosure binds to the OLDEST contributing evidence date on Home and the history page', () => {
    // The counts are "latest recorded", not verified current counts. Because a
    // combined layer figure can mix report dates, the disclosed date must be
    // the model's layersOldestReported (the oldest contributing evidence, so
    // newer reports cannot mask older ones), plus an explicit warning when any
    // positive contributor has no reported date. Never a hardcoded date and
    // never the as-of/today date.
    expect(helperSrc).toContain('export function layersFreshnessAt');
    expect(helperSrc).toContain('layersOldestReported: layersFreshness.oldestReported');
    expect(helperSrc).toContain('layersHasUndatedCounts: layersFreshness.hasUndatedCounts');

    expect(homeSrc).toContain('data-animals-freshness-note="true"');
    expect(homeSrc).toContain('Latest recorded counts, not verified current counts');
    expect(homeSrc).toContain('data-layers-oldest-reported={animalSnapshot.layersOldestReported');
    expect(homeSrc).toContain('Oldest layer count used was reported ${fmt(animalSnapshot.layersOldestReported)}');
    expect(homeSrc).toContain('Some layer counts used have no reported date.');

    expect(pageSrc).toContain('Latest recorded month-end counts');
    expect(pageSrc).toContain('data-animal-history-layers-oldest-reported={latest.layersOldestReported');
    expect(pageSrc).toContain('Oldest layer count used was reported ${fmt(latest.layersOldestReported)}');
    expect(pageSrc).toContain('Some layer counts used have no reported date.');
    expect(pageSrc).toContain('data-animal-history-oldest-reported={freshness.oldestReported}');
    expect(pageSrc).toContain('data-animal-history-has-undated="true"');
    expect(pageSrc).toContain('data-animal-history-method-note="true"');
    expect(pageSrc).toMatch(/latest count recorded on or before/);

    // Newest-date semantics must not return, no hardcoded disclosure dates,
    // and no purported "current" derivation by subtracting mortality.
    expect(helperSrc).not.toContain('layersLastReported');
    expect(homeSrc).not.toContain('layersLastReported');
    expect(pageSrc).not.toContain('layersLastReported');
    expect(homeSrc).not.toMatch(/reported\s+\d/i);
    expect(pageSrc).not.toMatch(/reported\s+\d/i);
    expect(pageSrc).not.toMatch(/mortality/i);
  });

  it('no combined animal Total remains on Home, the history page, the model, or the styles', () => {
    expect(helperSrc).not.toContain('row.total');
    expect(helperSrc).not.toMatch(/total:\s*ANIMAL_HISTORY_SPECIES/);
    expect(homeSrc).not.toContain('animalSnapshot.total');
    expect(homeSrc).not.toContain('stat-total');
    expect(homeSrc).not.toContain('sdot-total');
    expect(pageSrc).not.toContain('.total');
    expect(pageSrc).not.toContain('>Total<');
    expect(pageSrc).not.toContain('animal-history-latest-total');
    expect(pageSrc).not.toContain('animal-history-total-cell');
    expect(homeCssSrc).not.toContain('stat-total');
    expect(homeCssSrc).not.toContain('sdot-total');
    expect(homeCssSrc).not.toContain('animal-history-total-cell');
    expect(homeCssSrc).not.toContain('animal-history-latest');
  });

  it('mobile collapses the species charts to one per row without page overflow', () => {
    expect(homeCssSrc).toMatch(/@media[\s\S]*?\.home \.animal-history-multiples \{[^}]*grid-template-columns: 1fr;/);
    // Charts scale down (no fixed min-width forcing horizontal page scroll).
    expect(homeCssSrc).not.toContain('.animal-history-chart-scroll');
  });

  it('animalHistory helper exports month-end species logic and the shared housing matcher is canonical', () => {
    for (const name of [
      'ANIMAL_HISTORY_SPECIES',
      'broilersOnFarmAt',
      'layersOnFarmAt',
      'pigsOnFarmAt',
      'cattleOnFarmAt',
      'sheepOnFarmAt',
      'buildAnimalHistoryRows',
      'buildAnimalHistorySnapshot',
      'animalHistoryScaleMax',
    ]) {
      expect(helperSrc).toContain(`export ${name === 'ANIMAL_HISTORY_SPECIES' ? 'const' : 'function'} ${name}`);
    }
    expect(helperSrc).toContain("export const ANIMAL_HISTORY_START_MONTH = '2024-10'");
    // Housing <-> daily matching is owned by layerHousing.js; animalHistory
    // must consume it instead of keeping a competing local rule.
    expect(housingHelperSrc).toContain('export function createLayerDailyHousingMatcher');
    expect(housingHelperSrc).toContain('export function layerDailyMatchesHousing');
    expect(helperSrc).toContain("import {createLayerDailyHousingMatcher} from './layerHousing.js'");
    expect(helperSrc).not.toMatch(/function layerDailyMatchesHousing/);
  });
});

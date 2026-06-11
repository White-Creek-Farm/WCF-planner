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

  it('AnimalHistoryPage builds the table and line chart from the shared helper plus cattle/sheep transfers', () => {
    expect(pageSrc).toContain('buildAnimalHistoryRows');
    expect(pageSrc).toContain("fetchAllRows('cattle'");
    expect(pageSrc).toContain("fetchAllRows('sheep'");
    expect(pageSrc).toContain("fetchAllRows('cattle_transfers'");
    expect(pageSrc).toContain("fetchAllRows('sheep_transfers'");
    expect(pageSrc).toContain('data-animal-history-chart="line"');
    expect(pageSrc).toContain('data-animal-history-table="true"');
    expect(pageSrc).toContain('data-animal-history-loaded={loading || loadError ?');
    expect(pageSrc).toContain('data-animal-history-retry="1"');
    expect(pageSrc).toContain('<InlineNotice notice={loadError} />');
    expect(pageSrc).toContain('CHART_SERIES');
  });

  it('animalHistory helper exports month-end species logic', () => {
    for (const name of [
      'ANIMAL_HISTORY_SPECIES',
      'broilersOnFarmAt',
      'layersOnFarmAt',
      'pigsOnFarmAt',
      'cattleOnFarmAt',
      'sheepOnFarmAt',
      'buildAnimalHistoryRows',
    ]) {
      expect(helperSrc).toContain(`export ${name === 'ANIMAL_HISTORY_SPECIES' ? 'const' : 'function'} ${name}`);
    }
  });
});

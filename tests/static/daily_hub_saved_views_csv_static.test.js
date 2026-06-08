import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const savedViewsApi = read('src/lib/savedViewsApi.js');
const csvExport = read('src/lib/csvExport.js');

const DAILY_HUBS = [
  {
    name: 'BroilerDailysView',
    src: read('src/broiler/BroilerDailysView.jsx'),
    prefix: 'broiler-dailys',
    surfaceConst: 'BROILER_DAILYS_SURFACE_KEY',
    sourceConst: 'VALID_BROILER_DAILY_SOURCE_FILTERS',
    surface: 'broiler.dailys',
    stateFn: 'broilerDailysViewState',
    restoreFn: 'applyBroilerDailysSavedView',
    filters: ['fBatch', 'fTeam', 'fFrom', 'fTo'],
    csvBase: 'broiler-dailys',
    rawRowsName: 'records',
    headers: [
      'Date',
      'Broiler group',
      'Team member',
      'Source',
      'Feed type',
      'Feed lbs',
      'Grit lbs',
      'Mortality count',
      'Mortality reason',
      'Group moved',
      'Waterer checked',
      'Comments',
      'Photo count',
      'Record ID',
    ],
  },
  {
    name: 'CattleDailysView',
    src: read('src/cattle/CattleDailysView.jsx'),
    prefix: 'cattle-dailys',
    surfaceConst: 'CATTLE_DAILYS_SURFACE_KEY',
    sourceConst: 'VALID_CATTLE_DAILY_SOURCE_FILTERS',
    surface: 'cattle.dailys',
    stateFn: 'cattleDailysViewState',
    restoreFn: 'applyCattleDailysSavedView',
    filters: ['fHerd', 'fTeam', 'fFrom', 'fTo'],
    csvBase: 'cattle-dailys',
    rawRowsName: 'records',
    headers: [
      'Date',
      'Herd',
      'Team member',
      'Source',
      'Feed summary',
      'Feed lbs as fed',
      'Mineral summary',
      'Mineral lbs',
      'Fence voltage',
      'Water checked',
      'Mortality count',
      'Mortality reason',
      'Issues',
      'Photo count',
      'Record ID',
    ],
  },
  {
    name: 'SheepDailysView',
    src: read('src/sheep/SheepDailysView.jsx'),
    prefix: 'sheep-dailys',
    surfaceConst: 'SHEEP_DAILYS_SURFACE_KEY',
    sourceConst: 'VALID_SHEEP_DAILY_SOURCE_FILTERS',
    surface: 'sheep.dailys',
    stateFn: 'sheepDailysViewState',
    restoreFn: 'applySheepDailysSavedView',
    filters: ['fFlock', 'fTeam', 'fFrom', 'fTo'],
    csvBase: 'sheep-dailys',
    rawRowsName: 'records',
    headers: [
      'Date',
      'Flock',
      'Team member',
      'Source',
      'Feed summary',
      'Feed lbs as fed',
      'Hay bales',
      'Mineral summary',
      'Mineral lbs',
      'Fence voltage kV',
      'Waterers working',
      'Mortality count',
      'Comments',
      'Photo count',
      'Record ID',
    ],
  },
];

describe('daily hub saved views (Lane F)', () => {
  it('uses the shared app_saved_views API owner', () => {
    expect(savedViewsApi).toContain("from('app_saved_views')");
    expect(savedViewsApi).toContain('export async function listSavedViews');
    expect(savedViewsApi).toContain('export async function createSavedView');
    expect(savedViewsApi).toContain('export async function updateSavedView');
    expect(savedViewsApi).toContain('export async function deleteSavedView');
  });

  for (const hub of DAILY_HUBS) {
    it(`${hub.name} wires saved views to its own surface`, () => {
      expect(hub.src).toContain("from '../lib/savedViewsApi.js'");
      expect(hub.src).toContain(`const ${hub.surfaceConst} = '${hub.surface}'`);
      expect(hub.src).toContain(`listSavedViews(sb, ${hub.surfaceConst})`);
      expect(hub.src).toContain(`surfaceKey: ${hub.surfaceConst}`);
      expect(hub.src).toContain('createSavedView(sb, {');
      expect(hub.src).toContain('updateSavedView(sb, selectedView.id');
      expect(hub.src).toContain('deleteSavedView(sb, view.id)');
    });

    it(`${hub.name} saves and restores every visible filter`, () => {
      expect(hub.src).toContain(`function ${hub.stateFn}()`);
      expect(hub.src).toContain(`function ${hub.restoreFn}(view)`);
      for (const field of hub.filters) {
        expect(hub.src).toContain(`${field}: ${field} || ''`);
        expect(hub.src).toContain(`typeof st.${field} === 'string' ? st.${field} : ''`);
      }
      expect(hub.src).toContain(`srcFilter: ${hub.sourceConst}.has(srcFilter) ? srcFilter : 'all'`);
      expect(hub.src).toContain(`setSrcFilter(${hub.sourceConst}.has(st.srcFilter) ? st.srcFilter : 'all')`);
      expect(hub.src).toContain(`data-${hub.prefix}-team-filter="1"`);
    });

    it(`${hub.name} renders saved-view controls and degrades failures locally`, () => {
      for (const marker of [
        `data-${hub.prefix}-saved-views-row`,
        `data-${hub.prefix}-saved-view-select`,
        `data-${hub.prefix}-saved-view-save-open`,
        `data-${hub.prefix}-saved-view-form`,
        `data-${hub.prefix}-saved-view-name`,
        `data-${hub.prefix}-saved-view-visibility="private"`,
        `data-${hub.prefix}-saved-view-visibility="public"`,
        `data-${hub.prefix}-saved-view-save`,
        `data-${hub.prefix}-saved-view-update`,
        `data-${hub.prefix}-saved-view-delete`,
        `data-${hub.prefix}-saved-views-error`,
      ]) {
        expect(hub.src).toContain(marker);
      }
      expect(hub.src).toContain('Saved views unavailable. Filters still work.');
      expect(hub.src).toContain('setSavedViewsError(e.message || String(e))');
      expect(hub.src).toContain('window._wcfConfirmDelete');
      expect(hub.src).not.toContain('window.prompt');
      expect(hub.src).not.toContain('window.confirm');
    });
  }
});

describe('daily hub CSV export (Lane K)', () => {
  it('uses the shared csvExport owner for browser download mechanics', () => {
    expect(csvExport).toContain('export function rowsToCsv');
    expect(csvExport).toContain('export function csvFilename');
    expect(csvExport).toContain('export function downloadCsv');
    expect(csvExport).toContain('new Blob');
    expect(csvExport).toContain('URL.createObjectURL');
  });

  for (const hub of DAILY_HUBS) {
    it(`${hub.name} exports the current filtered rows, not raw records`, () => {
      expect(hub.src).toContain("from '../lib/csvExport.js'");
      expect(hub.src).toContain('function handleExportCsv');
      expect(hub.src).toContain(`data-${hub.prefix}-export-csv="1"`);
      expect(hub.src).toContain(`csvFilename('${hub.csvBase}')`);
      expect(hub.src).toContain('rowsToCsv(columns, filtered)');
      expect(hub.src).not.toContain(`rowsToCsv(columns, ${hub.rawRowsName})`);
    });

    it(`${hub.name} keeps export columns useful for daily review`, () => {
      for (const header of hub.headers) {
        expect(hub.src).toContain(`header: '${header}'`);
      }
    });

    it(`${hub.name} keeps CSV fallback browser-only and free of alert/confirm`, () => {
      expect(hub.src).toContain('CSV export is only available in the browser.');
      expect(hub.src).not.toContain('window.alert');
      expect(hub.src).not.toContain('window.confirm');
    });
  }
});

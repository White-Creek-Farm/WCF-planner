import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const savedViewsApi = read('src/lib/savedViewsApi.js');
const csvExport = read('src/lib/csvExport.js');
const dailyReportExports = read('src/lib/dailyReportExports.js');
const printExport = read('src/lib/printExport.js');
const layerDailysSrc = read('src/layer/LayerDailysView.jsx');
const eggDailysSrc = read('src/layer/EggDailysView.jsx');

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
    builder: 'buildBroilerDailyExportColumns',
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
    builder: 'buildCattleDailyExportColumns',
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
    builder: 'buildSheepDailyExportColumns',
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

const LAYER_EGG_DAILY_SAVED_VIEW_HUBS = [
  {
    name: 'LayerDailysView',
    src: layerDailysSrc,
    prefix: 'layer-dailys',
    surfaceConst: 'LAYER_DAILYS_SURFACE_KEY',
    sourceConst: 'VALID_LAYER_DAILY_SOURCE_FILTERS',
    surface: 'layer.dailys',
    stateFn: 'layerDailysViewState',
    restoreFn: 'applyLayerDailysSavedView',
    filters: ['fGroup', 'fTeam', 'fFrom', 'fTo'],
  },
  {
    name: 'EggDailysView',
    src: eggDailysSrc,
    prefix: 'egg-dailys',
    surfaceConst: 'EGG_DAILYS_SURFACE_KEY',
    surface: 'layer.eggs',
    stateFn: 'eggDailysViewState',
    restoreFn: 'applyEggDailysSavedView',
    filters: ['fTeam', 'fFrom', 'fTo'],
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

describe('layer and egg daily saved views (Lane F)', () => {
  for (const hub of LAYER_EGG_DAILY_SAVED_VIEW_HUBS) {
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
      if (hub.sourceConst) {
        expect(hub.src).toContain(`srcFilter: ${hub.sourceConst}.has(srcFilter) ? srcFilter : 'all'`);
        expect(hub.src).toContain(`setSrcFilter(${hub.sourceConst}.has(st.srcFilter) ? st.srcFilter : 'all')`);
      }
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
  it('uses the shared dailyReportExports owner for daily column specs', () => {
    for (const name of [
      'buildBroilerDailyExportColumns',
      'buildPigDailyExportColumns',
      'buildCattleDailyExportColumns',
      'buildSheepDailyExportColumns',
      'buildLayerDailyExportColumns',
      'buildEggDailyExportColumns',
    ]) {
      expect(dailyReportExports).toContain(`export function ${name}`);
    }
  });

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
      expect(hub.src).toContain("from '../lib/dailyReportExports.js'");
      expect(hub.src).toContain('function handleExportCsv');
      expect(hub.src).toContain(`data-${hub.prefix}-export-csv="1"`);
      expect(hub.src).toContain(`csvFilename('${hub.csvBase}')`);
      expect(hub.src).toContain(`const columns = ${hub.builder}(`);
      expect(hub.src).toContain('rowsToCsv(columns, filtered)');
      expect(hub.src).not.toContain(`rowsToCsv(columns, ${hub.rawRowsName})`);
    });

    it(`${hub.name} keeps export columns useful for daily review`, () => {
      for (const header of hub.headers) {
        expect(dailyReportExports).toContain(`header: '${header}'`);
      }
    });

    it(`${hub.name} keeps CSV fallback browser-only and free of alert/confirm`, () => {
      expect(hub.src).toContain('CSV export is only available in the browser.');
      expect(hub.src).not.toContain('window.alert');
      expect(hub.src).not.toContain('window.confirm');
    });
  }
});

describe('daily hub print export (Lane K)', () => {
  it('uses the shared printExport owner for browser print mechanics', () => {
    expect(printExport).toContain('export function rowsToPrintHtml');
    expect(printExport).toContain('export function printRows');
    expect(printExport).toContain('data-print-export-frame');
    expect(printExport).toContain('window.print');
    expect(printExport).toContain('escapeHtml');
  });

  for (const hub of DAILY_HUBS) {
    it(`${hub.name} prints the current filtered rows, not raw records`, () => {
      expect(hub.src).toContain("from '../lib/printExport.js'");
      expect(hub.src).toContain('function handlePrintRows');
      expect(hub.src).toContain(`data-${hub.prefix}-print="1"`);
      expect(hub.src).toContain("subtitle: filtered.length + ' filtered daily reports'");
      expect(hub.src).toContain('rows: filtered');
      expect(hub.src).not.toContain(`rows: ${hub.rawRowsName}`);
    });

    it(`${hub.name} uses one column spec for CSV and print`, () => {
      expect(hub.src).toContain(`const columns = ${hub.builder}(`);
      expect(hub.src).toContain('rowsToCsv(columns, filtered)');
      expect(hub.src).toContain('printRows({');
    });
  }
});

describe('layer and egg daily list export parity (Lane K)', () => {
  const layerEggHubs = [
    {
      name: 'LayerDailysView',
      src: layerDailysSrc,
      prefix: 'layer-dailys',
      csvBase: 'layer-dailys',
      builder: 'buildLayerDailyExportColumns',
      subtitle: "subtitle: filtered.length + ' filtered daily reports'",
      headers: [
        'Date',
        'Layer group',
        'Team member',
        'Source',
        'Feed type',
        'Feed lbs',
        'Grit lbs',
        'Layer count',
        'Group moved',
        'Waterer checked',
        'Mortality count',
        'Mortality reason',
        'Comments',
        'Photo count',
        'Record ID',
      ],
    },
    {
      name: 'EggDailysView',
      src: eggDailysSrc,
      prefix: 'egg-dailys',
      csvBase: 'egg-dailys',
      builder: 'buildEggDailyExportColumns',
      subtitle: "subtitle: filtered.length + ' filtered egg reports'",
      headers: [
        'Date',
        'Team member',
        'Group 1 name',
        'Group 1 eggs',
        'Group 2 name',
        'Group 2 eggs',
        'Group 3 name',
        'Group 3 eggs',
        'Group 4 name',
        'Group 4 eggs',
        'Total eggs',
        'Daily dozens',
        'Dozens on hand',
        'Comments',
        'Record ID',
      ],
    },
  ];

  for (const hub of layerEggHubs) {
    it(`${hub.name} exports the current filtered rows through the shared CSV owner`, () => {
      expect(hub.src).toContain("from '../lib/csvExport.js'");
      expect(hub.src).toContain("from '../lib/dailyReportExports.js'");
      expect(hub.src).toContain('function handleExportCsv');
      expect(hub.src).toContain(`data-${hub.prefix}-export-csv="1"`);
      expect(hub.src).toContain(`csvFilename('${hub.csvBase}')`);
      expect(hub.src).toContain(`const columns = ${hub.builder}(`);
      expect(hub.src).toContain('rowsToCsv(columns, filtered)');
      expect(hub.src).not.toContain('rowsToCsv(columns, records)');
    });

    it(`${hub.name} prints the current filtered rows through the shared print owner`, () => {
      expect(hub.src).toContain("from '../lib/printExport.js'");
      expect(hub.src).toContain('function handlePrintRows');
      expect(hub.src).toContain(`data-${hub.prefix}-print="1"`);
      expect(hub.src).toContain(hub.subtitle);
      expect(hub.src).toContain('rows: filtered');
      expect(hub.src).not.toContain('rows: records');
    });

    it(`${hub.name} keeps CSV and print on one column spec`, () => {
      expect(hub.src).toContain(`const columns = ${hub.builder}(`);
      expect(hub.src).toContain('rowsToCsv(columns, filtered)');
      expect(hub.src).toContain('printRows({');
      for (const header of hub.headers) {
        expect(dailyReportExports).toContain(`header: '${header}'`);
      }
    });

    it(`${hub.name} keeps export fallbacks browser-only`, () => {
      expect(hub.src).toContain('CSV export is only available in the browser.');
      expect(hub.src).toContain('Print is only available in the browser.');
      expect(hub.src).not.toContain('window.alert');
      expect(hub.src).not.toContain('window.confirm');
    });
  }
});

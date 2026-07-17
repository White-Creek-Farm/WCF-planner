// Static lock for Lane K export/print parity.
//
// The operational export surfaces should go through the shared CSV/print
// owners plus shared column builders. This keeps browser-only download/print
// behavior, CSV escaping, and per-surface column contracts in one place.

import {describe, expect, it} from 'vitest';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

const sharedColumns = read('src/lib/operationalExportColumns.js');
const exportSurfaces = [
  {
    name: 'Activity Log',
    file: 'src/activity/ActivityLogView.jsx',
    builder: 'buildActivityLogExportColumns',
    csvMarker: 'data-activity-log-export-csv',
    printMarker: 'data-activity-log-print',
    rowVar: 'rows',
  },
  {
    name: 'Equipment Fleet',
    file: 'src/equipment/EquipmentFleetView.jsx',
    builder: 'buildEquipmentFleetExportColumns',
    csvMarker: 'data-equipment-fleet-export-csv',
    printMarker: 'data-equipment-fleet-print',
    rowVar: 'fleetExportRows',
  },
  {
    name: 'Cattle Processing Batches',
    file: 'src/cattle/CattleBatchesView.jsx',
    builder: 'buildProcessingBatchExportColumns',
    csvMarker: 'data-cattle-batches-export-csv',
    printMarker: 'data-cattle-batches-print',
    rowVar: 'batchExportRows',
  },
  {
    name: 'Sheep Processing Batches',
    file: 'src/sheep/SheepBatchesView.jsx',
    builder: 'buildProcessingBatchExportColumns',
    csvMarker: 'data-sheep-batches-export-csv',
    printMarker: 'data-sheep-batches-print',
    rowVar: 'batchExportRows',
  },
  {
    name: 'Broiler Batches',
    file: 'src/broiler/BroilerListView.jsx',
    builder: 'buildBroilerBatchExportColumns',
    csvMarker: 'data-broiler-batches-export-csv',
    printMarker: 'data-broiler-batches-print',
    rowVar: 'broilerExportRows',
  },
  {
    name: 'Layer Batches',
    file: 'src/layer/LayerBatchesView.jsx',
    builder: 'buildLayerBatchExportColumns',
    csvMarker: 'data-layer-batches-export-csv',
    printMarker: 'data-layer-batches-print',
    rowVar: 'layerBatchExportRows',
  },
  {
    name: 'Pig Batches',
    file: 'src/pig/PigBatchesView.jsx',
    builder: 'buildPigBatchExportColumns',
    csvMarker: 'data-pig-batches-export-csv',
    printMarker: 'data-pig-batches-print',
    rowVar: 'pigBatchExportRows',
  },
];

describe('Lane K operational export columns', () => {
  for (const name of [
    'buildActivityLogExportColumns',
    'buildEquipmentFleetExportColumns',
    'buildProcessingBatchExportColumns',
    'buildBroilerBatchExportColumns',
    'buildLayerBatchExportColumns',
    'buildPigBatchExportColumns',
  ]) {
    it(`exports ${name}`, () => {
      expect(sharedColumns).toMatch(new RegExp(`export function ${name}\\(`));
    });
  }

  it('keeps formatting helpers centralized in the column owner', () => {
    expect(sharedColumns).toMatch(/function dateValue\(fmt, value\)/);
    expect(sharedColumns).toMatch(/function money\(value\)/);
    expect(sharedColumns).toMatch(/function rounded\(value, digits = 1\)/);
  });
});

describe('Lane K operational export surface wiring', () => {
  for (const surface of exportSurfaces) {
    it(`${surface.name} uses shared CSV/print owners with stable buttons`, () => {
      const src = read(surface.file);
      expect(src).toMatch(/import \{csvFilename, downloadCsv, rowsToCsv\} from/);
      expect(src).toMatch(/import \{printRows\} from/);
      expect(src).toContain(surface.builder);
      expect(src).toContain(surface.csvMarker);
      expect(src).toContain(surface.printMarker);
      expect(src).toMatch(/downloadCsv\(csvFilename\('/);
      expect(src).toMatch(new RegExp(`rowsToCsv\\(exportColumns,\\s*${surface.rowVar}\\)`));
      expect(src).toMatch(/printRows\(\{/);
      expect(src).toContain('columns: exportColumns');
      expect(src).not.toMatch(/new Blob\(/);
      expect(src).not.toMatch(/window\.print\(/);
    });
  }

  it('broiler exports use the same daily-report metric helper as live batch surfaces', () => {
    const src = read('src/broiler/BroilerListView.jsx');
    expect(src).toMatch(/calcBroilerStatsFromDailys\(batch, broilerDailys\)/);
    expect(src).toContain('export_feed_per_processed_bird');
    expect(src).toContain('useManualFeedFallback');
    expect(src).not.toContain('stats.dailyCount === 0 && stats.starterFeed === 0 && stats.growerFeed === 0');
  });

  it('activity exports mask deleted comment bodies and avoid empty header-only exports', () => {
    const columns = read('src/lib/operationalExportColumns.js');
    const src = read('src/activity/ActivityLogView.jsx');
    expect(columns).toContain("r.deleted_at ? '(comment deleted)' : r.body || ''");
    expect(src).toContain('No loaded activity rows to export.');
    expect(src).toContain('No loaded activity rows to print.');
  });

  it('cattle processing exports count attached detail rows only', () => {
    const src = read('src/cattle/CattleBatchesView.jsx');
    expect(src).toContain('animal_count: detailRows.length');
    expect(src).not.toContain('Array.isArray(batch.animalIds) ? batch.animalIds.length');
  });

  it('layer exports are derived from batch stats and active housing display counts', () => {
    const src = read('src/layer/LayerBatchesView.jsx');
    expect(src).toMatch(/computeHousingDisplayCount\(housing, rawLayerDailys, layerHousings\)/);
    expect(src).toMatch(/computeLayerFeedCost\(stats\.starterFeed, stats\.growerFeed, stats\.layerFeed, batch\)/);
    expect(src).toContain('active_housing_names');
  });

  it('pig exports use the same metric model as the visible hub grid', () => {
    const src = read('src/pig/PigBatchesView.jsx');
    const columns = read('src/lib/operationalExportColumns.js');
    for (const token of [
      'buildPigBatchGridMetrics',
      'started_head: metrics.started',
      'current_head: metrics.current',
      'total_feed_lbs: metrics.totalFeedLbs',
      'feed_per_pig: metrics.feedPerPig',
      'gilts_started: metrics.gilts.started',
      'boars_feed_per_pig: metrics.boars.feedPerPig',
    ]) {
      expect(src).toContain(token);
    }
    for (const header of ['Started Head', 'Current Head', 'Feed / Pig', 'Gilts Feed / Pig', 'Boars Feed / Pig']) {
      expect(columns).toContain(header);
    }
  });
});

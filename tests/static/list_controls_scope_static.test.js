import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

const disallowedListControlFiles = [
  'src/activity/ActivityLogView.jsx',
  'src/cattle/CattleBatchesView.jsx',
  'src/cattle/CattleWeighInsView.jsx',
  'src/dashboard/ProductionPage.jsx',
  'src/equipment/EquipmentFleetView.jsx',
  'src/equipment/EquipmentFuelLogView.jsx',
  'src/layer/LayerBatchesView.jsx',
  'src/livestock/LivestockWeighInsView.jsx',
  'src/pig/PigBatchesView.jsx',
  'src/pig/SowsView.jsx',
  'src/sheep/SheepBatchesView.jsx',
  'src/sheep/SheepWeighInsView.jsx',
];

const allowedRichControlFiles = [
  'src/broiler/BroilerDailysView.jsx',
  'src/broiler/BroilerListView.jsx',
  'src/cattle/CattleDailysView.jsx',
  'src/cattle/CattleHerdsView.jsx',
  'src/layer/EggDailysView.jsx',
  'src/layer/LayerDailysView.jsx',
  'src/pig/PigDailysView.jsx',
  'src/sheep/SheepDailysView.jsx',
  'src/sheep/SheepFlocksView.jsx',
];

describe('site-wide list controls scope', () => {
  it('gates saved views, filters, export, and print off outside herds/flocks/dailys', () => {
    for (const relPath of disallowedListControlFiles) {
      expect(read(relPath), relPath).toContain('const EXTENDED_LIST_CONTROLS_ENABLED = false;');
    }
  });

  it('does not install the disabled gate on the allowed rich-control surfaces', () => {
    for (const relPath of allowedRichControlFiles) {
      expect(read(relPath), relPath).not.toContain('const EXTENDED_LIST_CONTROLS_ENABLED = false;');
    }
  });

  it('keeps cattle herds and sheep flocks behind compact icon toggles', () => {
    const cattle = read('src/cattle/CattleHerdsView.jsx');
    const sheep = read('src/sheep/SheepFlocksView.jsx');

    for (const marker of [
      'data-cattle-herds-saved-views-toggle="1"',
      'data-cattle-herds-filters-toggle="1"',
      'data-cattle-herds-sort-toggle="1"',
      'data-cattle-herds-columns-toggle="1"',
    ]) {
      expect(cattle).toContain(marker);
    }
    expect(cattle).toContain("openToolPanel === 'savedViews'");
    expect(cattle).toContain("openToolPanel === 'filters'");
    expect(cattle).toContain("openToolPanel === 'columns'");
    // The grouped/flat view toggle is gone — results are always flat.
    expect(cattle).not.toContain('data-cattle-herds-view-toggle="1"');

    for (const marker of [
      'data-sheep-flocks-saved-views-toggle="1"',
      'data-sheep-flocks-filters-toggle="1"',
      'data-sheep-flocks-sort-toggle="1"',
      'data-sheep-flocks-columns-toggle="1"',
    ]) {
      expect(sheep).toContain(marker);
    }
    expect(sheep).toContain("openToolPanel === 'savedViews'");
    expect(sheep).toContain("openToolPanel === 'filters'");
    expect(sheep).toContain("openToolPanel === 'columns'");
    expect(sheep).not.toContain('data-sheep-flocks-view-toggle="1"');
  });

  it('keeps broiler batches behind the same compact icon toggles', () => {
    const broiler = read('src/broiler/BroilerListView.jsx');
    for (const marker of [
      'data-broiler-batches-saved-views-toggle="1"',
      'data-broiler-batches-filters-toggle="1"',
      'data-broiler-batches-sort-toggle="1"',
      'data-broiler-batches-columns-toggle="1"',
    ]) {
      expect(broiler).toContain(marker);
    }
    expect(broiler).toContain("openToolPanel === 'savedViews'");
    expect(broiler).toContain("openToolPanel === 'filters'");
    expect(broiler).toContain("openToolPanel === 'sort'");
    expect(broiler).toContain("openToolPanel === 'columns'");
  });
});

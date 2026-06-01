import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const broilerPage = read('src/broiler/PoultryDailyPage.jsx');
const broilerView = read('src/broiler/BroilerDailysView.jsx');
const layerPage = read('src/layer/LayerDailyPage.jsx');
const layerView = read('src/layer/LayerDailysView.jsx');
const layerGroupsHelper = read('src/layer/layerDailyGroups.js');
const pigPage = read('src/pig/PigDailyPage.jsx');
const pigView = read('src/pig/PigDailysView.jsx');
const mainSrc = read('src/main.jsx');
const webformHub = read('src/webforms/WebformHub.jsx');

describe('daily record group dropdowns', () => {
  it('Broiler daily record uses a Group select from active broiler batches', () => {
    expect(broilerPage).toContain("batch_label: 'Group'");
    expect(broilerPage).toContain('function buildBroilerGroupOptions');
    expect(broilerPage).toContain('formatBroilerBatchLabel');
    expect(broilerPage).toMatch(/<span style=\{fieldLabel\}>Group<\/span>[\s\S]*?<select/);
    expect(broilerPage).toContain('Select group...');
    expect(broilerPage).not.toContain('<span style={fieldLabel}>Batch</span>');
    expect(broilerView).toContain('batches: props.batches');
    expect(broilerView).toContain('All groups');
  });

  it('Layer daily record uses a Group select and resolves batch_id from layer data', () => {
    expect(layerPage).toContain("batch_label: 'Group'");
    expect(layerPage).toContain("'batch_id'");
    expect(layerGroupsHelper).toContain('export function buildLayerDailyGroupOptions');
    expect(layerGroupsHelper).toContain('export function resolveLayerDailyBatchId');
    expect(layerPage).toContain('buildLayerDailyGroupOptions');
    expect(layerPage).toContain('resolveLayerDailyBatchId');
    expect(layerPage).toContain('batch_id: batchId');
    expect(layerPage).toMatch(/<span style=\{fieldLabel\}>Group<\/span>[\s\S]*?<select/);
    expect(layerPage).toContain('Select group...');
    expect(layerPage).not.toContain('<span style={fieldLabel}>Batch</span>');
    expect(layerView).toContain('layerBatches: props.layerBatches');
    expect(layerView).toContain('layerHousings: props.layerHousings');
    expect(layerView).toContain('buildLayerDailyGroupOptions');
    expect(layerView).toContain('resolveLayerDailyBatchId');
    expect(layerView).toContain('batch_id: batchId');
    expect(layerView).not.toContain("(layerGroups || []).filter((g) => g.status === 'active').map((g) => g.name)");
    expect(mainSrc).toMatch(/React\.createElement\(LayerDailysView[\s\S]*?layerBatches,[\s\S]*?layerHousings,/);
  });

  it('Pig daily record uses a Group select from feeder parent/sub groups', () => {
    expect(pigPage).toContain("batch_label: 'Group'");
    expect(pigPage).toContain('function buildPigGroupOptions');
    expect(pigPage).toMatch(/<span style=\{fieldLabel\}>Group<\/span>[\s\S]*?<select/);
    expect(pigPage).toContain('Select group...');
    expect(pigPage).not.toContain('<span style={fieldLabel}>Batch</span>');
    expect(pigView).toContain('feederGroups: props.feederGroups');
    expect(pigView).toContain('All groups');
    expect(pigView).toContain('Pig Group');
    expect(pigView).not.toContain('Pig Group / Batch');
  });

  it('Broiler public daily form placeholder matches the Group label', () => {
    expect(webformHub).toContain('Broiler Group');
    expect(webformHub).toContain('Select group...');
    expect(webformHub).not.toContain('Select batch...');
  });
});

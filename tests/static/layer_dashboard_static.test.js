import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const homeSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayersHomeView.jsx'), 'utf8');
const batchesSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchesView.jsx'), 'utf8');
const housingSrc = fs.readFileSync(path.join(ROOT, 'src/lib/layerHousing.js'), 'utf8');

describe('Layer dashboard active-batch lifetime stats', () => {
  it('removes the active-batch 30/90/120 rolling-window toggle', () => {
    expect(homeSrc).toMatch(/ACTIVE BATCHES[\s\S]*?LIFETIME/);
    expect(homeSrc).not.toMatch(/layerDashPeriod/);
    expect(homeSrc).not.toMatch(/setLayerDashPeriod/);
    expect(homeSrc).not.toMatch(/ACTIVE BATCHES[\s\S]{0,200}ROLLING WINDOW/);
  });

  it('computes active batch cards from lifetime start through today', () => {
    expect(homeSrc).toMatch(/lifetimeFromForBatch/);
    expect(homeSrc).toMatch(
      /const lifetimeFrom = lifetimeFromForBatch\(batch\);[\s\S]*computeBatchWindow\(batch, lifetimeFrom, today\)/,
    );
  });

  it('does not render lbs-per-dozen metrics in the layer dashboard or batches tab', () => {
    expect(homeSrc).not.toMatch(/Lbs\/dozen|feedPerDoz/);
    expect(batchesSrc).not.toMatch(/Feed \/ Dozen|feedPerDozen/);
  });

  it('does not repeat housing metrics when a batch has only one housing', () => {
    expect(homeSrc).toMatch(/myHousings\.length > 1 && \(/);
    expect(batchesSrc).toMatch(/batchHousings\.length > 1 && \(/);
  });

  it('keeps Cost / Dozen in the batch summary but removes the duplicate lifetime performance tile', () => {
    expect(batchesSrc).toMatch(/Cost \/ Dozen/);
    expect(batchesSrc).not.toMatch(/Cost \/ Dozen \(lifetime\)/);
  });
});

describe('Layer housing count fallback', () => {
  it('computeProjectedCount falls back to daily layer_count when current_count is null', () => {
    expect(housingSrc).toMatch(/if \(anchor == null\)/);
    expect(housingSrc).toMatch(/layer_count/);
    expect(housingSrc).toContain('housing.housing_name');
    expect(housingSrc).toContain('batch_label');
  });

  it('LayersHomeView uses computeProjectedCount for all hen totals', () => {
    expect(homeSrc).toContain('computeProjectedCount');
    expect(homeSrc).not.toMatch(/totalHens\s*=\s*activeHousings\.reduce\([^)]*parseInt\(h\.current_count\)/);
  });

  it('LayerBatchesView uses computeProjectedCount for utilization', () => {
    expect(batchesSrc).toMatch(/const proj = computeProjectedCount/);
    expect(batchesSrc).toMatch(/const util = proj && cap/);
  });

  it('LayerBatchesView fetches layer_count in the dailys query', () => {
    expect(batchesSrc).toMatch(/fetchAll\('layer_dailys'[^)]*layer_count/);
  });

  it('LayerBatchesView chip does not use raw h.current_count for hens', () => {
    expect(batchesSrc).not.toMatch(/h\.current_count\s*\?\s*['"].*hens/);
    expect(batchesSrc).toMatch(/computeProjectedCount\(h, rawLayerDailys\)/);
  });

  it('LayerBatchesView currentHens does not sum raw h.current_count', () => {
    expect(batchesSrc).not.toMatch(/currentHens\s*=\s*bHousings\.reduce\([^)]*parseInt\(h\.current_count\)/);
    expect(batchesSrc).toMatch(/currentHens\s*=\s*bHousings\.reduce/);
  });
});

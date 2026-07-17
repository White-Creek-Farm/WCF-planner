import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const homeSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayersHomeView.jsx'), 'utf8');
const batchesSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchesView.jsx'), 'utf8');
const batchPageSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchPage.jsx'), 'utf8');
const housingPageSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayerHousingPage.jsx'), 'utf8');
const housingSrc = fs.readFileSync(path.join(ROOT, 'src/lib/layerHousing.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');

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

  it('does not render lbs-per-dozen metrics in the layer dashboard or record page', () => {
    expect(homeSrc).not.toMatch(/Lbs\/dozen|feedPerDoz/);
    expect(batchPageSrc).not.toMatch(/Feed \/ Dozen|feedPerDozen/);
  });

  it('keeps Cost / Dozen in the batch summary but removes the duplicate lifetime performance tile', () => {
    expect(batchPageSrc).toMatch(/Cost \/ Dozen/);
    expect(batchPageSrc).not.toMatch(/Cost \/ Dozen \(lifetime\)/);
  });
});

describe('Layer housing count — display helper consistency', () => {
  it('layerHousing.js exports computeHousingDisplayCount', () => {
    expect(housingSrc).toContain('export function computeHousingDisplayCount');
  });

  it('layerHousing.js owns the canonical housing<->daily matcher and the helpers use it', () => {
    expect(housingSrc).toContain('export function createLayerDailyHousingMatcher');
    expect(housingSrc).toContain('export function layerDailyMatchesHousing');
    // Both count helpers route matching through the shared rule; the legacy
    // "name OR shared batch_id" inline predicate must not return.
    expect(housingSrc).toMatch(/computeHousingDisplayCount[\s\S]{0,400}createLayerDailyHousingMatcher/);
    expect(housingSrc).toMatch(/computeProjectedCount[\s\S]{0,600}createLayerDailyHousingMatcher/);
    expect(housingSrc).not.toContain('=== hName) ||');
  });

  it('layer count surfaces pass the housing roster so sibling dailys cannot cross over', () => {
    expect(homeSrc).toContain('computeHousingDisplayCount(h, allLayerDailys, layerHousings)');
    expect(homeSrc).toContain('computeHousingDisplayCount(housing, allLayerDailys, layerHousings)');
    expect(batchesSrc).toContain('computeHousingDisplayCount(housing, rawLayerDailys, layerHousings)');
    expect(batchPageSrc).toContain('computeHousingDisplayCount(h, rawLayerDailys, layerHousings)');
    expect(batchPageSrc).toContain('computeProjectedCount(h, rawLayerDailys, layerHousings)');
    expect(housingPageSrc).toContain('computeHousingDisplayCount(housing, rawLayerDailys, layerHousings)');
    expect(housingPageSrc).toContain('computeProjectedCount(housing, rawLayerDailys, layerHousings)');
  });

  it('HomeDashboard delegates Animals on Farm layer totals to the shared animal snapshot', () => {
    expect(dashSrc).toContain('buildAnimalHistorySnapshot');
    expect(dashSrc).toContain('animalSnapshot.layers');
    expect(dashSrc).not.toContain('computeHousingDisplayCount');
    expect(dashSrc).not.toContain('const totalHens =');
    expect(dashSrc).not.toMatch(/totalHens[\s\S]*?parseInt\(h\.current_count\)/);
  });

  it('LayersHomeView uses computeHousingDisplayCount for all hen totals', () => {
    expect(homeSrc).toContain('computeHousingDisplayCount');
    expect(homeSrc).not.toContain('computeProjectedCount');
    expect(homeSrc).not.toMatch(/parseInt\(h\.current_count\)/);
  });

  it('LayerBatchesView hub chip uses computeHousingDisplayCount', () => {
    // Cards -> unified grid: the per-housing reduce var was renamed h -> housing
    // in decorateBatch; still computeHousingDisplayCount(<housing>, rawLayerDailys, <roster>).
    expect(batchesSrc).toContain('computeHousingDisplayCount(housing, rawLayerDailys, layerHousings)');
    expect(batchesSrc).not.toMatch(/h\.current_count\s*\?\s*['"].*hens/);
  });

  it('LayerBatchPage currentHens uses computeHousingDisplayCount', () => {
    expect(batchPageSrc).toMatch(/currentHens[\s\S]*?computeHousingDisplayCount/);
    expect(batchPageSrc).not.toMatch(/currentHens[\s\S]*?parseInt\(h\.current_count\)/);
  });

  it('LayerBatchPage fetches layer_count in the dailys query', () => {
    expect(batchPageSrc).toMatch(/fetchAll\('layer_dailys'[^)]*layer_count/);
  });

  it('LayerBatchPage uses computeProjectedCount for the Projected label', () => {
    expect(batchPageSrc).toMatch(/const proj = computeProjectedCount/);
  });

  it('LayerHousingPage uses computeProjectedCount for the Projected label', () => {
    expect(housingPageSrc).toMatch(/computeProjectedCount\(housing,/);
  });
});

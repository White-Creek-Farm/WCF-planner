import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Farrowing-created pig batches CP1 — wiring locks. Normal farm-born batches
// are created from the first farrowing record (create-only, idempotent by
// cycleId), not from the manual Add Batch flow. Counts are neutral (no fake
// sex split): farmBorn batches store the alive-derived started count and the
// ledger/display read it via batchStartedCount.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('FarrowingView — farm-born batch creation on save', () => {
  const src = read('src/pig/FarrowingView.jsx');
  it('imports the farrow-batch helpers', () => {
    expect(src).toContain("from '../lib/pigFarrowBatch.js'");
    expect(src).toContain('matchCycleForFarrowing');
    expect(src).toContain('ensureFarrowBatchForCycle');
  });
  it('receives persistFeeders and pulls feederGroups', () => {
    expect(src).toMatch(/persistFeeders/);
    expect(src).toMatch(/feederGroups/);
  });
  it('saveFarrowForm ensures a batch for the matched cycle and persists only when created', () => {
    expect(src).toMatch(/matchCycleForFarrowing\(rec, breedingCycles\)/);
    expect(src).toMatch(/ensureFarrowBatchForCycle\(feederGroups, cycle, nb, breedingCycles\)/);
    expect(src).toMatch(/if \(created\) persistFeeders\(next\)/);
  });
});

describe('main.jsx — FarrowingView gets persistFeeders', () => {
  const src = read('src/main.jsx');
  it('passes persistFeeders into FarrowingView', () => {
    expect(src).toMatch(/FarrowingView,\s*\{[\s\S]*?persistFeeders/);
  });
});

describe('pig.js — neutral started count', () => {
  const src = read('src/lib/pig.js');
  it('exports batchStartedCount', () => {
    expect(src).toMatch(/export function batchStartedCount/);
  });
  it('computeBatchCurrentCount derives parentStarted from batchStartedCount', () => {
    expect(src).toMatch(/const parentStarted = batchStartedCount\(group\)/);
  });
});

describe('pigFarrowBatch.js — generated batch shape contract', () => {
  const src = read('src/lib/pigFarrowBatch.js');
  it('uses a deterministic farrowing-cycle-<id> id but detects by cycleId first', () => {
    expect(src).toMatch(/'farrowing-cycle-'/);
    expect(src).toMatch(/g\.cycleId === cycle\.id/);
  });
  it('marks generated batches farmBorn with no sex split', () => {
    expect(src).toMatch(/farmBorn: true/);
    expect(src).toMatch(/giltCount: 0/);
    expect(src).toMatch(/boarCount: 0/);
  });
});

describe('Display — farm-born batches suppress the Gilts/Boars main count', () => {
  it('PigBatchPage gates the Gilts/Boars badges on !g.farmBorn', () => {
    const src = read('src/pig/PigBatchPage.jsx');
    expect(src).toMatch(/!g\.farmBorn && <span[^>]*>Gilts:/);
    expect(src).toMatch(/!g\.farmBorn && <span[^>]*>Boars:/);
  });
  it('PigBatchesView hub tile started uses batchStartedCount', () => {
    const viewSrc = read('src/pig/PigBatchesView.jsx');
    const metricSrc = read('src/lib/pigBatchGridMetrics.js');
    expect(viewSrc).toContain('buildPigBatchGridMetrics(g, {');
    expect(metricSrc).toContain('const started = batchStartedCount(group)');
  });
});

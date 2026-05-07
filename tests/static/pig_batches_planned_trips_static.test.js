import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Pig Batches planned-trip forecast — commit 4a hard-gate locks
// ============================================================================
// Codex hard gates:
//   - Persisted plannedProcessingTrips shape stays minimal: id, date, sex,
//     subBatchId, plannedCount, order. No projection fields, no warning
//     fields, no Global ADG copy.
//   - The auto-allocation effect must not write to processingTrips, must
//     not stamp weigh_ins.sent_to_trip_id, and must not change ledger
//     count semantics.
//   - Sex-mixed subs do not auto-allocate.
//
// Playwright is the main behavioral proof; this static lock keeps the
// hard gates visible at the source level.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const viewSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');
const forecastSrc = fs.readFileSync(path.join(ROOT, 'src/lib/pigForecast.js'), 'utf8');

describe('Commit 4a — Global ADG persistence + role gate', () => {
  it('PigBatchesView reads/writes app_store key ppp-pig-global-adg-v1', () => {
    expect(viewSrc).toMatch(/['"]ppp-pig-global-adg-v1['"]/);
  });

  it('Global ADG edit is gated on authState.role === "admin" (manager-and-above for v1)', () => {
    expect(viewSrc).toMatch(/authState && authState\.role === 'admin'/);
  });

  it('imports the four pigForecast pieces commit 4a needs', () => {
    expect(viewSrc).toMatch(/PLANNED_TRIP_MIN_SIZE/);
    expect(viewSrc).toMatch(/PLANNED_TRIP_TARGET_WEIGHT_LBS/);
    expect(viewSrc).toMatch(/PLANNED_TRIP_OVER_WEIGHT_WARN_LBS/);
    expect(viewSrc).toMatch(/allocatePlannedTrips/);
    expect(viewSrc).toMatch(/recalculateProjections/);
    expect(viewSrc).toMatch(/seedGlobalADG/);
  });

  it('does NOT add a "use system estimate" reset button (Codex Q4)', () => {
    expect(viewSrc).not.toMatch(/Use system estimate/i);
  });
});

describe('Commit 4a — Auto-allocation hard gates', () => {
  it('auto-allocation skips sex-mixed subs (Codex Q1)', () => {
    expect(viewSrc).toMatch(/giltCount > 0 && boarCount > 0/);
  });

  it('auto-allocation never writes when feederGroup.cycleId is missing', () => {
    expect(viewSrc).toMatch(/g\.status === 'processed' \|\| !g\.cycleId/);
  });

  it('auto-allocation skips when an existing (sub, sex) pair already has trips (Codex Q2)', () => {
    // Filter check ensures we don't regenerate over manual edits.
    expect(viewSrc).toMatch(/existingForPair = planned\.filter/);
  });

  it('auto-allocation never sets sent_to_trip_id or sent_to_group_id', () => {
    // Pull the auto-allocation effect body and verify it has no writes
    // to weigh_ins. Defensive — the effect operates on app_store only.
    const effect = viewSrc.match(/Auto-allocate planned trips[\s\S]*?effectiveAdgLbsPerDay\]\);/);
    expect(effect, 'expected to find the auto-allocation effect').not.toBeNull();
    expect(effect[0]).not.toMatch(/sent_to_trip_id/);
    expect(effect[0]).not.toMatch(/sent_to_group_id/);
    expect(effect[0]).not.toMatch(/from\(['"]weigh_ins['"]\)/);
  });

  it('auto-allocation only writes to plannedProcessingTrips, never to processingTrips', () => {
    const effect = viewSrc.match(/Auto-allocate planned trips[\s\S]*?effectiveAdgLbsPerDay\]\);/);
    expect(effect[0]).toMatch(/plannedProcessingTrips/);
    // Negative lock: never assigns to feederGroup.processingTrips inside
    // the effect.
    expect(effect[0]).not.toMatch(/processingTrips:\s*\[/);
  });
});

describe('Commit 4a — Persisted shape stays minimal', () => {
  // The persisted shape locked in commit 1 unit tests
  // (allocatePlannedTrips returns only six keys). This static check
  // anchors that commit 4a doesn't grow new fields when persisting.
  it('allocatePlannedTrips returns only the documented persistable keys', () => {
    const fn = forecastSrc.match(/export function allocatePlannedTrips\([\s\S]*?return trips;\s*\}/);
    expect(fn, 'expected to find allocatePlannedTrips').not.toBeNull();
    // Must push these six keys exactly. No projectedMin/Max/Avg/ready/
    // warnings/daysUntil persisted.
    expect(fn[0]).not.toMatch(/projectedMinLbs:/);
    expect(fn[0]).not.toMatch(/projectedMaxLbs:/);
    expect(fn[0]).not.toMatch(/projectedAvgLbs:/);
    expect(fn[0]).not.toMatch(/ready:/);
    expect(fn[0]).not.toMatch(/warnings:/);
    expect(fn[0]).not.toMatch(/daysUntil:/);
    expect(fn[0]).not.toMatch(/globalAdg/);
  });
});

describe('Commit 4a — calcAgeRange numeric bounds extension', () => {
  it('calcAgeRange returns minDays/maxDays alongside text', () => {
    const libSrc = fs.readFileSync(path.join(ROOT, 'src/lib/pig.js'), 'utf8');
    const fn = libSrc.match(/export function calcAgeRange[\s\S]*?return \{\s*text,[\s\S]*?\}\s*;\s*\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/minDays:/);
    expect(fn[0]).toMatch(/maxDays:/);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Pig batch age freeze on processor-trip empty — Hotfix 3 lock
// ============================================================================
// While Current > 0, age advances daily. Once Current hits 0 AND there is
// at least one processor trip, age freezes at the latest trip date so
// archived batches stop ticking forward. Mortality/transfer-only emptying
// keeps using today (no trip date to pin to).
//
// calcAgeRange now lives as a pure helper in src/lib/pig.js (extracted
// during the per-view internalization lane). PigBatchesView keeps a thin
// wrapper closure that supplies the React-context-bound breedingCycles +
// farrowingRecs arrays. Locks: lib helper accepts asOfDate and uses the
// ref variable for day-delta math; the view wrapper preserves the
// (cycleId, asOfDate) signature; the batch-card render path computes
// latestTripDate and passes it when currentPigCount === 0.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const src = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');
// CP11: the batch-card render path (latestTripDate + age-freeze conditional)
// moved into PigBatchPage. The view keeps a calcAgeRange wrapper for the
// feeder-form modal, so signature assertions stay on `src`; card-render
// assertions read `pageSrc`.
const pageSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchPage.jsx'), 'utf8');
const libSrc = fs.readFileSync(path.join(ROOT, 'src/lib/pig.js'), 'utf8');

describe('PigBatchesView age freeze on processor-trip empty', () => {
  it('PigBatchesView wrapper preserves the (cycleId, asOfDate) signature', () => {
    expect(src).toMatch(/function calcAgeRange\(cycleId,\s*asOfDate\)/);
  });

  it('lib calcAgeRange uses asOfDate as the reference instead of today when provided', () => {
    // Library helper signature: (cycleId, asOfDate, breedingCycles, farrowingRecs)
    expect(libSrc).toMatch(/export function calcAgeRange\(cycleId,\s*asOfDate,\s*breedingCycles,\s*farrowingRecs\)/);
    // Reference variable computed from asOfDate (with NaN/Date guard)
    expect(libSrc).toMatch(/asOfDate\s+instanceof\s+Date/);
    // Day-delta math uses the ref variable, not `today`
    expect(libSrc).toMatch(/oldestDays\s*=\s*Math\.round\(\(ref\s*-\s*firstDate\)/);
    expect(libSrc).toMatch(/youngestDays\s*=\s*Math\.round\(\(ref\s*-\s*lastDate\)/);
  });

  it('batch card derives latestTripDate from trips before computing ageRange', () => {
    expect(pageSrc).toMatch(/const\s+latestTripDate\s*=\s*\n?\s*trips\s*\n?\s*\.map/);
  });

  it('batch card freezes ageRange when currentPigCount === 0 AND a trip date exists', () => {
    // Conditional pins the reference to the trip date, otherwise default today.
    expect(pageSrc).toMatch(
      /currentPigCount\s*===\s*0\s*&&\s*latestTripDate\s*\n?\s*\?\s*calcAgeRange\(g\.cycleId,\s*new Date\(latestTripDate\s*\+\s*'T12:00:00'\)\)\s*\n?\s*:\s*calcAgeRange\(g\.cycleId\)/,
    );
  });

  it('does not freeze when there are no trips (mortality/transfer-only emptying)', () => {
    // The condition requires latestTripDate truthy; when trips=[], that's null
    // and calcAgeRange falls through to the default (today). Lock that the
    // freeze branch's && requires both halves, not just the count.
    const m = pageSrc.match(
      /currentPigCount\s*===\s*0\s*&&\s*latestTripDate\s*\n?\s*\?\s*calcAgeRange\(g\.cycleId,\s*new Date\(latestTripDate/,
    );
    expect(m).not.toBeNull();
  });

  it('removed the early ageRange computation that ran before currentPigCount was known', () => {
    // The pre-hotfix call site sat between `tl = ...calcBreedingTimeline...`
    // and `const sc = statusColors...`. Make sure that exact early invocation
    // is gone — leaving it would silently shadow the freeze logic.
    expect(pageSrc).not.toMatch(
      /const tl = cycle \? calcBreedingTimeline\(cycle\.exposureStart\) : null;\s*\n\s*const ageRange = calcAgeRange\(g\.cycleId\);\s*\n\s*const sc/,
    );
  });
});

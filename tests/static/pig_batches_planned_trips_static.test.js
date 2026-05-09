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

  it('Planned-trip mutations are gated on admin OR management (pig planned trips lane: farm_team is read-only)', () => {
    // The mutation gate predicate: admin OR management (Codex pig
    // planned trips lane spec). farm_team can view but not mutate the
    // inline date editor, manual Add, Delete, ← / → arrows, or the
    // Global ADG editor.
    expect(viewSrc).toMatch(/authState\.role === 'admin' \|\| authState\.role === 'management'/);
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

describe('Commit 4b — date edit + count move handler hard gates', () => {
  // Anchor on the handler bodies so unrelated JSX doesn't false-match.
  const dateHandler = viewSrc.match(/function setPlannedTripDateById\([\s\S]*?persistFeeders\(nb\);\s*\}/);
  const moveHandler = viewSrc.match(/function movePlannedTripPigsById\([\s\S]*?persistFeeders\(nb\);\s*\}/);

  it('setPlannedTripDateById exists', () => {
    expect(dateHandler, 'expected setPlannedTripDateById handler').not.toBeNull();
  });

  it('movePlannedTripPigsById exists', () => {
    expect(moveHandler, 'expected movePlannedTripPigsById handler').not.toBeNull();
  });

  it('both handlers persist via persistFeeders only — never to processingTrips/weigh_ins', () => {
    for (const body of [dateHandler[0], moveHandler[0]]) {
      expect(body).not.toMatch(/processingTrips:/);
      expect(body).not.toMatch(/sent_to_trip_id/);
      expect(body).not.toMatch(/sent_to_group_id/);
      expect(body).not.toMatch(/from\(['"]weigh_ins['"]\)/);
    }
  });

  it('setPlannedTripDateById preserves all six persistable fields via {...t}', () => {
    expect(dateHandler[0]).toMatch(/\{\.\.\.t,\s*date:\s*newDate\s*\}/);
    // Negative lock: must NOT introduce projection/warning/ready fields
    // into the persisted shape.
    expect(dateHandler[0]).not.toMatch(/projectedMinLbs:/);
    expect(dateHandler[0]).not.toMatch(/projectedMaxLbs:/);
    expect(dateHandler[0]).not.toMatch(/projectedAvgLbs:/);
    expect(dateHandler[0]).not.toMatch(/ready:/);
    expect(dateHandler[0]).not.toMatch(/warnings:/);
    expect(dateHandler[0]).not.toMatch(/daysUntil:/);
  });

  it('movePlannedTripPigsById delegates to movePigsBetweenTrips (preserves shape and rejects cross-pair)', () => {
    expect(moveHandler[0]).toMatch(/movePigsBetweenTrips\(/);
    // Single-pig moves only (Codex W1) — count arg literal is 1.
    expect(moveHandler[0]).toMatch(/movePigsBetweenTrips\([\s\S]*?,\s*1\s*\)/);
  });

  it('Calendar / date-step / move / delete / add controls all gate on isManager (admin OR management)', () => {
    // Each gated control's data-attr is preceded by an isManager check.
    // The pig planned trips lane renamed move-out/move-in to
    // move-forward/move-back (semantic clarification: forward = current
    // → next, back = current → previous) and added Add + Delete.
    const gatedAttrs = [
      'data-planned-trip-edit-date',
      'data-planned-trip-date-back',
      'data-planned-trip-date-forward',
      'data-planned-trip-move-forward',
      'data-planned-trip-move-back',
      'data-planned-trip-delete',
      'data-planned-trip-add-button',
    ];
    for (const attr of gatedAttrs) {
      // The attribute should appear inside an {isManager && ...} block.
      // Loose anchor: look for "isManager" within the 12000 chars preceding
      // the attribute usage. The Planned trips card body is large enough
      // that the +Add and Delete affordances sit several thousand chars
      // after their enclosing gates.
      const idx = viewSrc.indexOf(attr);
      expect(idx, `expected ${attr} to render in JSX`).toBeGreaterThan(0);
      const window = viewSrc.slice(Math.max(0, idx - 12000), idx);
      expect(window, `expected ${attr} to be gated by isManager`).toMatch(/isManager/);
    }
  });

  it('date picker and day steppers autosave without explicit Save/Cancel buttons', () => {
    expect(viewSrc).toMatch(/data-planned-trip-date-back/);
    expect(viewSrc).toMatch(/data-planned-trip-date-forward/);
    expect(viewSrc).toMatch(/shiftPlannedTripDateById\(/);
    expect(viewSrc).not.toMatch(/data-planned-trip-save-date/);

    const inputDecl = viewSrc.match(/data-planned-trip-date-input=\{t\.id\}[\s\S]*?\/>/);
    expect(inputDecl, 'expected planned-trip date input').not.toBeNull();
    expect(inputDecl[0]).toMatch(/onChange=/);
    expect(inputDecl[0]).toMatch(/setPlannedTripDateById\(/);
    expect(inputDecl[0]).not.toMatch(/onBlur=/);
  });
});

describe('Commit 5 — Add Batch breeding-cycle filter', () => {
  // Filter shape: cycles already linked to OTHER feederGroups are hidden.
  // In Add mode (no editFeederId), any link hides. In Edit mode, only
  // links from OTHER batches hide; the self batch's own cycle stays
  // visible.
  it('breedingCycles is filtered before being mapped into <option> rows', () => {
    expect(viewSrc).toMatch(/breedingCycles\s*\.filter\(/);
  });

  it('Add mode hides any cycle linked by any feederGroup', () => {
    expect(viewSrc).toMatch(/!editFeederId/);
    expect(viewSrc).toMatch(/feederGroups[\s\S]*?\.some\(\s*\(fg\)\s*=>\s*fg\.cycleId\s*===\s*c\.id\s*\)/);
  });

  it('Edit mode keeps self-batch cycle visible by excluding self from the link check', () => {
    expect(viewSrc).toMatch(/fg\.id !== editFeederId/);
  });

  it('renders the empty-state hint only in Add mode when no available cycles remain', () => {
    expect(viewSrc).toMatch(/data-feeder-cycle-empty-hint/);
    // Whitespace/newlines tolerated so Prettier wrap doesn't false-fail.
    expect(viewSrc).toMatch(
      /All breeding cycles are already linked to a pig batch\.\s+Add a new breeding cycle in the\s+Breeding tab before creating another batch\./,
    );
  });

  it('the filtered <select> exposes data-feeder-cycle-select for tests', () => {
    expect(viewSrc).toMatch(/data-feeder-cycle-select/);
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

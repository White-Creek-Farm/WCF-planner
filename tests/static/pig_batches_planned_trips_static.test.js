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
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const tileSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchHubTile.jsx'), 'utf8');
const mortalityHookSrc = fs.readFileSync(path.join(ROOT, 'src/pig/usePigMortality.js'), 'utf8');
const subHookSrc = fs.readFileSync(path.join(ROOT, 'src/pig/usePigSubBatches.js'), 'utf8');
const plannedHookSrc = fs.readFileSync(path.join(ROOT, 'src/pig/usePigPlannedTrips.js'), 'utf8');
const procHookSrc = fs.readFileSync(path.join(ROOT, 'src/pig/usePigProcessingTrips.js'), 'utf8');
// CP11: the record-page workspace JSX (card + mortality modal + planned-trip UI +
// RecordCollaborationSection) lives in PigBatchPage. Record-only assertions read
// pageSrc; hub-only assertions stay on viewSrc.
const pageSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchPage.jsx'), 'utf8');

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

  it('imports the four pigForecast pieces commit 4a needs (CP11: split view hub vs record page)', () => {
    // Hub-side (auto-allocation effect + ADG seed) stays in the view.
    expect(viewSrc).toMatch(/allocatePlannedTrips/);
    expect(viewSrc).toMatch(/seedGlobalADG/);
    expect(viewSrc).toMatch(/PLANNED_TRIP_TARGET_WEIGHT_LBS/);
    // Planned-trip card projector pieces moved to the record page.
    expect(pageSrc).toMatch(/PLANNED_TRIP_MIN_SIZE/);
    expect(pageSrc).toMatch(/PLANNED_TRIP_TARGET_WEIGHT_LBS/);
    expect(pageSrc).toMatch(/PLANNED_TRIP_OVER_WEIGHT_WARN_LBS/);
    expect(pageSrc).toMatch(/recalculateProjections/);
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
    const effect = viewSrc.match(/Auto-allocate planned trips[\s\S]*?effectiveAdgLbsPerDay,\s*\]\);/);
    expect(effect, 'expected to find the auto-allocation effect').not.toBeNull();
    expect(effect[0]).not.toMatch(/sent_to_trip_id/);
    expect(effect[0]).not.toMatch(/sent_to_group_id/);
    expect(effect[0]).not.toMatch(/from\(['"]weigh_ins['"]\)/);
  });

  it('auto-allocation only writes to plannedProcessingTrips, never to processingTrips', () => {
    const effect = viewSrc.match(/Auto-allocate planned trips[\s\S]*?effectiveAdgLbsPerDay,\s*\]\);/);
    expect(effect[0]).toMatch(/plannedProcessingTrips/);
    // Negative lock: never assigns to feederGroup.processingTrips inside
    // the effect.
    expect(effect[0]).not.toMatch(/processingTrips:\s*\[/);
  });

  it('auto-allocation planned dates use effective Global ADG, not local rank-matched ADG', () => {
    const effect = viewSrc.match(/Auto-allocate planned trips[\s\S]*?effectiveAdgLbsPerDay,\s*\]\);/);
    expect(effect, 'expected to find the auto-allocation effect').not.toBeNull();
    expect(effect[0]).toContain('planned trip dates');
    expect(effect[0]).toMatch(/const adg = effectiveAdgLbsPerDay/);
    expect(effect[0]).toContain('buildFarrowingAgeDistribution');
    expect(effect[0]).toContain('projectFarrowingAgeWindow');
    expect(effect[0]).not.toMatch(/const adg = latestAdgBySubId/);
  });

  it('planned-trip forecast cards stay age-at-trip-date times Global ADG', () => {
    expect(pageSrc).toContain('DOB/farrowing age at');
    expect(pageSrc).toContain('buildFarrowingAgeDistribution');
    expect(pageSrc).toContain('ageDistributionAtRef');
    expect(pageSrc).toMatch(/populationCount:\s*forecastPopulationCount/);
    expect(pageSrc).not.toMatch(/latestEntries:\s*\[\]/);
    expect(pageSrc).toMatch(/globalAdgLbsPerDay:\s*effectiveAdgLbsPerDay/);
    expect(pageSrc).not.toContain('projectionAdgLbsPerDay');
    expect(pageSrc).not.toContain('latestEntriesBySubId');
  });

  it('processing trips compare age-based forecast against actual live weights', () => {
    expect(pageSrc).toContain('data-pig-trip-forecast-compare');
    expect(pageSrc).toContain('processingForecastByTripId');
    expect(pageSrc).toContain('projectFarrowingAgeWindow');
    expect(pageSrc).toContain('forecastDelta');
    expect(pageSrc).toMatch(/avg - tripForecastAvg/);
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
  // Anchor on the handler bodies so unrelated JSX doesn't false-match. As of
  // CP9 the handlers live in usePigPlannedTrips; the JSX (data-attrs, isManager
  // gating) stays in PigBatchesView and is asserted against viewSrc below.
  const dateHandler = plannedHookSrc.match(/function setPlannedTripDateById\([\s\S]*?persistFeeders\(nb\);\s*\}/);
  const moveHandler = plannedHookSrc.match(/function movePlannedTripPigsById\([\s\S]*?persistFeeders\(nb\);\s*\}/);

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
      // CP11: the planned-trip card JSX lives in PigBatchPage now.
      const idx = pageSrc.indexOf(attr);
      expect(idx, `expected ${attr} to render in JSX`).toBeGreaterThan(0);
      const window = pageSrc.slice(Math.max(0, idx - 12000), idx);
      expect(window, `expected ${attr} to be gated by isManager`).toMatch(/isManager/);
    }
  });

  it('date picker and day steppers autosave without explicit Save/Cancel buttons', () => {
    expect(pageSrc).toMatch(/data-planned-trip-date-back/);
    expect(pageSrc).toMatch(/data-planned-trip-date-forward/);
    expect(pageSrc).toMatch(/shiftPlannedTripDateById\(/);
    expect(pageSrc).not.toMatch(/data-planned-trip-save-date/);

    const inputDecl = pageSrc.match(/data-planned-trip-date-input=\{t\.id\}[\s\S]*?\/>/);
    expect(inputDecl, 'expected planned-trip date input').not.toBeNull();
    expect(inputDecl[0]).toMatch(/onChange=/);
    expect(inputDecl[0]).toMatch(/setPlannedTripDateById\(/);
    expect(inputDecl[0]).not.toMatch(/onBlur=/);
  });
});

describe('Farrowing-created batches CP1 — Add Manual Batch retires the cycle selector', () => {
  // Normal farm-born batches are now created from the first farrowing record
  // (FarrowingView), so the /pig/batches Add flow is manual/admin only: no
  // breeding-cycle selector in Add mode, and the linked cycle is read-only in
  // Edit mode. The old commit-5 empty-state hint is gone.
  it('the Add button is renamed to "Add Manual Batch"', () => {
    expect(viewSrc).toContain('+ Add Manual Batch');
  });
  it('the breeding-cycle field is gated to Edit mode with an existing linked cycle', () => {
    expect(viewSrc).toMatch(/editFeederId && feederForm\.cycleId && \(/);
  });
  it('the linked-cycle select is read-only (disabled) in Edit mode', () => {
    expect(viewSrc).toMatch(/data-feeder-cycle-select[\s\S]*?disabled/);
  });
  it('the retired Add-mode empty-state hint is removed', () => {
    expect(viewSrc).not.toMatch(/data-feeder-cycle-empty-hint/);
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

// ============================================================================
// Pig planned-trip locks lane — sidecar + handler-level neighbor guards
// ============================================================================

describe('Pig planned-trip locks — sidecar persistence', () => {
  // CP9: the lock sidecar + handlers live in usePigPlannedTrips (plannedHookSrc).
  it('uses app_store key ppp-pig-planned-trip-locks-v1', () => {
    expect(plannedHookSrc).toMatch(/['"]ppp-pig-planned-trip-locks-v1['"]/);
  });

  it('does not expand the six-key plannedProcessingTrips shape', () => {
    // The sidecar lives in a separate app_store key so persisted trip rows stay
    // byte-identical (id, date, sex, subBatchId, plannedCount, order). No handler
    // writes lock keys onto a planned trip when persisting feederGroups.
    expect(plannedHookSrc).not.toMatch(/plannedProcessingTrips:\s*[\s\S]*?lockedAt:/);
    expect(plannedHookSrc).not.toMatch(/plannedProcessingTrips:\s*[\s\S]*?lockedByName:/);
    expect(plannedHookSrc).not.toMatch(/plannedProcessingTrips:\s*[\s\S]*?locked:\s*true/);
  });

  it('locks read from / write to the sidecar key, not to ppp-feeders-v1', () => {
    // The lockPlannedTrip helper upserts to ppp-pig-planned-trip-locks-v1.
    expect(plannedHookSrc).toMatch(/upsert\(\{key:\s*'ppp-pig-planned-trip-locks-v1',\s*data:\s*next\}/);
    // Lock records carry the four documented fields.
    expect(plannedHookSrc).toMatch(/locked:\s*true/);
    expect(plannedHookSrc).toMatch(/lockedByName/);
    expect(plannedHookSrc).toMatch(/lockedByUserId/);
    expect(plannedHookSrc).toMatch(/lockedAt/);
  });

  it('lock display name falls back authState.name → user.email → "Unknown"', () => {
    expect(plannedHookSrc).toMatch(
      /\(authState && authState\.name\)\s*\|\|\s*\(authState && authState\.user && authState\.user\.email\)\s*\|\|\s*'Unknown'/,
    );
  });
});

describe('Pig planned-trip locks — neighbor mutation guards live in handlers', () => {
  // Codex's correction: the locked state must block mutations end-to-end,
  // not just hide JSX affordances. Each handler refuses early before
  // touching feederGroups.
  const dateHandler = plannedHookSrc.match(/function setPlannedTripDateById\([\s\S]*?persistFeeders\(nb\);\s*\}/);
  const shiftHandler = plannedHookSrc.match(/function shiftPlannedTripDateById\([\s\S]*?\}\s*\n/);
  const moveHandler = plannedHookSrc.match(/function movePlannedTripPigsById\([\s\S]*?persistFeeders\(nb\);\s*\}/);
  const addHandler = plannedHookSrc.match(/function addPlannedTripById\([\s\S]*?return \{ok: true\};\s*\}/);
  const deleteHandler = plannedHookSrc.match(/function deletePlannedTripById\([\s\S]*?return \{ok: true\};\s*\}/);

  it('setPlannedTripDateById refuses when target trip is locked', () => {
    expect(dateHandler[0]).toMatch(/if \(isTripLocked\(tripId\)\) return;/);
  });

  it('shiftPlannedTripDateById refuses when target trip is locked', () => {
    expect(shiftHandler[0]).toMatch(/if \(isTripLocked\(tripId\)\) return;/);
  });

  it('movePlannedTripPigsById refuses when source OR target is locked', () => {
    expect(moveHandler[0]).toMatch(/if \(isTripLocked\(fromTripId\) \|\| isTripLocked\(toTripId\)\) return;/);
  });

  it('addPlannedTripById refuses when any trip in the (subBatchId, sex) chain is locked', () => {
    expect(addHandler[0]).toMatch(/isChainLocked\(fg\.plannedProcessingTrips \|\| \[\], subBatchId, sex\)/);
    expect(addHandler[0]).toMatch(/return \{error:\s*'chain locked'\};/);
  });

  it('deletePlannedTripById refuses when target OR reconciliation recipient is locked', () => {
    expect(deleteHandler[0]).toMatch(/if \(isTripLocked\(tripId\)\) return \{error:\s*'locked'\};/);
    expect(deleteHandler[0]).toMatch(/deleteReconciliationRecipient/);
    expect(deleteHandler[0]).toMatch(
      /if \(recipient && isTripLocked\(recipient\.id\)\) return \{error:\s*'recipient locked'\};/,
    );
  });

  it('isChainLocked helper returns true if any same-sex chain trip is locked', () => {
    const fn = plannedHookSrc.match(/function isChainLocked\([\s\S]*?\}\s*\n/);
    expect(fn, 'expected isChainLocked helper').not.toBeNull();
    expect(fn[0]).toMatch(/subBatchId === subBatchId && t\.sex === sex/);
    expect(fn[0]).toMatch(/\.some\(\(t\) => isTripLocked\(t\.id\)\)/);
  });
});

describe('Pig planned-trip locks — UI affordances', () => {
  // CP11: the planned-trip UI affordances render in PigBatchPage now.
  it('locked trip card renders the "Locked by user: <name>" badge', () => {
    expect(pageSrc).toMatch(/'Locked by user: '\s*\+\s*\(lockEntry\.lockedByName \|\| 'Unknown'\)/);
    expect(pageSrc).toMatch(/data-planned-trip-locked-by/);
  });

  it('locked trips hide date / move / delete affordances', () => {
    // The date-controls row is gated on !tripLocked && isManager.
    expect(pageSrc).toMatch(/\{!tripLocked && isManager && \(\s*<div style=\{\{display: 'inline-flex'/);
    // The move + delete row is also gated on !tripLocked.
    expect(pageSrc).toMatch(/\{!tripLocked && isManager && \(nextSameSex \|\| prevSameSex \|\| canDelete\)/);
    // The date input only renders when not locked.
    expect(pageSrc).toMatch(/\{!tripLocked && isEditingDate && \(/);
  });

  it('admin/management get an inline Lock button on unlocked trips', () => {
    expect(pageSrc).toMatch(/data-planned-trip-lock=/);
    expect(pageSrc).toMatch(/onClick=\{\(\) => lockPlannedTrip\(t\.id\)\}/);
  });

  it('Unlock uses an inline two-step warning — no window.confirm', () => {
    // The two-step path: Unlock button toggles unlockingTripId; the
    // warning panel renders when unlockingTripId === t.id.
    expect(pageSrc).toMatch(/data-planned-trip-unlock=/);
    expect(pageSrc).toMatch(/data-planned-trip-unlock-warning=/);
    expect(pageSrc).toMatch(/data-planned-trip-unlock-cancel=/);
    expect(pageSrc).toMatch(/data-planned-trip-unlock-confirm=/);
    // Exact Codex warning copy. Tolerant of Prettier reflow that may break
    // the JSX text across multiple lines.
    expect(pageSrc).toMatch(
      /This trip has already been scheduled with the processor\.\s+Only unlock if[\s\S]*?rescheduled with the processor\./,
    );
    // No window.confirm anywhere in the unlock path.
    const unlockBlock = pageSrc.match(/data-planned-trip-unlock-warning[\s\S]*?Confirm unlock[\s\S]*?<\/button>/);
    expect(unlockBlock, 'expected unlock warning JSX').not.toBeNull();
    expect(unlockBlock[0]).not.toMatch(/window\.confirm/);
  });

  it('Add gilt/boar trip buttons disable when the corresponding chain has a locked trip', () => {
    expect(pageSrc).toMatch(/giltChainLocked\s*=\s*isChainLocked\([\s\S]*?g\.plannedProcessingTrips[\s\S]*?'gilt'/);
    expect(pageSrc).toMatch(/boarChainLocked\s*=\s*isChainLocked\([\s\S]*?g\.plannedProcessingTrips[\s\S]*?'boar'/);
    expect(pageSrc).toMatch(/disabled=\{giltChainLocked\}/);
    expect(pageSrc).toMatch(/disabled=\{boarChainLocked\}/);
  });
});

describe('CP2 — pig.batch record-page helper extraction (no re-inlining)', () => {
  it('imports current-count ledger helpers from lib/pig.js', () => {
    // CP11: the sub-level ledger helpers moved with the record card to
    // PigBatchPage. computeBatchCurrentCount stays in the view too (hub tiles).
    expect(pageSrc).toMatch(/computeSubLedgerCurrent/);
    expect(pageSrc).toMatch(/computeSubCurrentCount/);
    expect(pageSrc).toMatch(/computeBatchCurrentCount/);
    expect(viewSrc).toMatch(/computeBatchCurrentCount/);
  });

  it('deleteReconciliationRecipient is provided by lib/pigForecast.js and consumed by the planned-trip hook (CP9)', () => {
    // CP9 moved the planned-trip delete handler (and this import) from
    // PigBatchesView into usePigPlannedTrips.
    expect(plannedHookSrc).toMatch(
      /import \{[\s\S]*?deleteReconciliationRecipient[\s\S]*?\} from '\.\.\/lib\/pigForecast\.js'/,
    );
    expect(forecastSrc).toMatch(/export function deleteReconciliationRecipient\(/);
  });

  it('no longer defines deleteReconciliationRecipient locally', () => {
    expect(viewSrc).not.toMatch(/function deleteReconciliationRecipient\(/);
  });

  it('no longer re-inlines the parent-only current-count ledger branch', () => {
    // The parentStarted/parentTrips else-branch moved into computeBatchCurrentCount.
    expect(viewSrc).not.toMatch(/const parentStarted =/);
    expect(viewSrc).not.toMatch(/parentStarted > 0/);
    expect(viewSrc).toMatch(/computeBatchCurrentCount\(g, breeders, \{/);
  });
});

describe('CP3 — /pig/batches/<id> record-page routing + hub/record branch', () => {
  it('PigBatchesView reads the router hooks and derives record mode from the URL', () => {
    expect(viewSrc).toMatch(/import \{useNavigate, useLocation\} from 'react-router-dom'/);
    expect(viewSrc).toMatch(/const recordMode = location\.pathname\.startsWith\('\/pig\/batches\/'\)/);
    expect(viewSrc).toMatch(
      /const recordGroup = recordMode \? \(feederGroups \|\| \[\]\)\.find\(\(g\) => g\.id === recordId\)/,
    );
  });

  it('uses group.id as the encoded route identity for tile navigation (via PigBatchHubTile)', () => {
    expect(viewSrc).toMatch(/navigate\('\/pig\/batches\/' \+ encodeURIComponent\(id\)/);
    // CP6: the hub renders the extracted presentational tile and routes on open
    // by group.id; the tile carries the data-pig-batch-tile hook. CP3: the open
    // call also threads the visible hub order for record sequence nav.
    expect(viewSrc).toMatch(
      /<PigBatchHubTile[\s\S]*?group=\{g\}[\s\S]*?onOpen=\{\(\) => goToBatch\(g\.id, visiblePigBatches\)\}/,
    );
    expect(tileSrc).toMatch(/data-pig-batch-tile=\{group\.id\}/);
  });

  it('renders a not-found state for an unknown id', () => {
    expect(viewSrc).toMatch(/recordMode && !recordGroup/);
    expect(viewSrc).toMatch(/Batch not found/);
  });

  it('decodes the route id defensively (malformed %-URL -> not-found, no crash)', () => {
    expect(viewSrc).toMatch(/try \{\s*recordId = decodeURIComponent\(recordRawId\)/);
  });

  it('hub-tile current-count fallback sorts dailys by date then submitted_at (cannot drift from the record page)', () => {
    // Both the hub tile and the record workspace must pick the same latest
    // daily for a parent-only batch — date desc, then submitted_at desc.
    const tileFallback = viewSrc.match(/const rows = dailysForName\(g\.batchName\);[\s\S]*?\.sort\([\s\S]*?\);/);
    expect(tileFallback, 'expected the hub-tile latestDailyPigCount fallback').not.toBeNull();
    expect(tileFallback[0]).toMatch(/b\.date \|\| ''\)\.localeCompare\(a\.date/);
    expect(tileFallback[0]).toMatch(/b\.submitted_at \|\| ''\)\.localeCompare\(a\.submitted_at/);
  });

  it('keeps Global ADG + Add Batch on the hub only (not the record page)', () => {
    expect(viewSrc).toMatch(/\{!recordMode && \(/);
  });

  it('main.jsx wires the /pig/batches/<id> sub-path to the pigbatches view', () => {
    expect(mainSrc).toMatch(
      /isPigBatchesSubpath = !exactPathView && location\.pathname\.startsWith\('\/pig\/batches\/'\)/,
    );
    expect(mainSrc).toMatch(/isPigBatchesSubpath\s*\?\s*'pigbatches'/);
    expect(mainSrc).toMatch(/view === 'pigbatches' && location\.pathname\.startsWith\('\/pig\/batches\/'\)\) return/);
  });
});

describe('CP6 — presentational extraction (behavior unchanged)', () => {
  it('PigBatchHubTile is a render-only component carrying the tile hook + open handler', () => {
    expect(tileSrc).toMatch(
      /export default function PigBatchHubTile\(\{[\s\S]*?group,[\s\S]*?current,[\s\S]*?started,[\s\S]*?feedPerStarted,[\s\S]*?subSummaries = \[\],[\s\S]*?statusColor,[\s\S]*?onOpen,[\s\S]*?\}\)/,
    );
    expect(tileSrc).toMatch(/data-pig-batch-tile=\{group\.id\}/);
    expect(tileSrc).toMatch(/data-pig-batch-sub-batches=\{group\.id\}/);
    expect(tileSrc).toMatch(/onClick=\{onOpen\}/);
    // Presentational only — no data/hooks/mutations leaked into the tile.
    expect(tileSrc).not.toContain('useState');
    expect(tileSrc).not.toContain('computeBatchCurrentCount');
    expect(tileSrc).not.toContain("from('app_store')");
  });

  it('record page still mounts RecordCollaborationSection with the pig.batch entity contract', () => {
    // CP11: the RCS mount moved with the card into PigBatchPage (group prop).
    expect(pageSrc).toMatch(
      /<RecordCollaborationSection[\s\S]*?entityType="pig\.batch"[\s\S]*?entityId=\{group\.id\}[\s\S]*?entityLabel=\{group\.batchName\}/,
    );
  });

  it('legacy inline activity surface stays absent from PigBatchesView', () => {
    expect(viewSrc).not.toContain('ActivityPanel');
    expect(viewSrc).not.toContain('ActivityModal');
    expect(viewSrc).not.toContain('wcf-entity-deep-link');
  });
});

describe('CP7 — mortality workflow extracted to usePigMortality', () => {
  it('PigBatchesView imports and wires the usePigMortality hook', () => {
    expect(viewSrc).toMatch(/import \{usePigMortality\} from '\.\/usePigMortality\.js'/);
    expect(viewSrc).toMatch(/usePigMortality\(\{feederGroups, setFeederGroups, setNotice, authState\}\)/);
  });

  it('PigBatchesView no longer declares the mortality state/handlers directly', () => {
    expect(viewSrc).not.toMatch(/const \[mortalityModal, setMortalityModal\] = React\.useState/);
    expect(viewSrc).not.toMatch(/const \[mortalityForm, setMortalityForm\] = React\.useState/);
    expect(viewSrc).not.toMatch(/const \[mortalityBusy, setMortalityBusy\] = React\.useState/);
    expect(viewSrc).not.toMatch(/async function saveMortality\(/);
    expect(viewSrc).not.toMatch(/async function deleteMortality\(/);
  });

  it('the hook preserves the ppp-feeders-v1 pigMortalities persisted shape + count guard', () => {
    expect(mortalityHookSrc).toContain('pigMortalities');
    expect(mortalityHookSrc).toMatch(/upsert\(\{key: 'ppp-feeders-v1', data: nb\}/);
    expect(mortalityHookSrc).toMatch(/Number\.isFinite\(count\) \|\| count <= 0/);
    // Hook is React-context-free: deps passed in explicitly.
    expect(mortalityHookSrc).toMatch(
      /export function usePigMortality\(\{feederGroups, setFeederGroups, setNotice, authState\}\)/,
    );
  });
});

describe('CP8 — sub-batch workflow extracted to usePigSubBatches', () => {
  it('PigBatchesView imports and wires the usePigSubBatches hook', () => {
    expect(viewSrc).toMatch(/import \{usePigSubBatches\} from '\.\/usePigSubBatches\.js'/);
    // partitionDirtyRef stays view-owned (closeFeederForm reads it) and is passed in.
    expect(viewSrc).toMatch(/usePigSubBatches\(\{[\s\S]*?partitionDirtyRef,[\s\S]*?\}\)/);
  });

  it('PigBatchesView no longer declares the moved sub-batch state/handlers directly', () => {
    expect(viewSrc).not.toMatch(/const \[showSubForm, setShowSubForm\] = React\.useState/);
    expect(viewSrc).not.toMatch(/const \[subForm, setSubForm\] = React\.useState/);
    expect(viewSrc).not.toMatch(/const \[editSubId, setEditSubId\] = React\.useState/);
    expect(viewSrc).not.toMatch(/function persistSubBatch\(/);
    expect(viewSrc).not.toMatch(/function validateNewSub\(/);
    expect(viewSrc).not.toMatch(/function updSubPartition\(/);
  });

  it('the hook keeps the explicit dependency signature (React-context-free)', () => {
    expect(subHookSrc).toMatch(
      /export function usePigSubBatches\(\{\s*feederGroups,\s*setFeederGroups,\s*persistFeeders,\s*setNotice,\s*confirmDelete,\s*subAutoSaveTimer,\s*pigAutoSaveTimer,\s*partitionDirtyRef,?\s*\}\)/,
    );
  });

  it('the hook preserves the subBatches shape + originalPigCount invariant + validation', () => {
    expect(subHookSrc).toContain('subBatches');
    expect(subHookSrc).toMatch(/originalPigCount: c/);
    expect(subHookSrc).toContain('Sub-batch name is required.');
    expect(subHookSrc).toMatch(/available on parent batch/);
    expect(subHookSrc).toMatch(/persistFeeders\(nb\)/);
    expect(subHookSrc).toMatch(/partitionDirtyRef\.current = true/);
  });
});

describe('CP9 — planned-trip workflow extracted to usePigPlannedTrips', () => {
  it('PigBatchesView imports and wires the usePigPlannedTrips hook', () => {
    expect(viewSrc).toMatch(/import \{usePigPlannedTrips\} from '\.\/usePigPlannedTrips\.js'/);
    expect(viewSrc).toMatch(/usePigPlannedTrips\(\{feederGroups, persistFeeders, authState, isManager\}\)/);
  });

  it('PigBatchesView no longer declares the moved planned-trip state/handlers/lock-load', () => {
    expect(viewSrc).not.toMatch(/const \[plannedTripLocks, setPlannedTripLocks\] = React\.useState/);
    expect(viewSrc).not.toMatch(/const \[editingPlannedTripId, setEditingPlannedTripId\] = React\.useState/);
    expect(viewSrc).not.toMatch(/const \[addingTripFor, setAddingTripFor\] = React\.useState/);
    expect(viewSrc).not.toMatch(/function setPlannedTripDateById\(/);
    expect(viewSrc).not.toMatch(/function addPlannedTripById\(/);
    expect(viewSrc).not.toMatch(/function deletePlannedTripById\(/);
    expect(viewSrc).not.toMatch(/function lockPlannedTrip\(/);
    // The lock-sidecar load effect moved into the hook.
    expect(viewSrc).not.toMatch(/eq\('key', 'ppp-pig-planned-trip-locks-v1'\)/);
  });

  it('the hook keeps the explicit dependency signature (React-context-free)', () => {
    expect(plannedHookSrc).toMatch(
      /export function usePigPlannedTrips\(\{feederGroups, persistFeeders, authState, isManager\}\)/,
    );
  });

  it('the hook still uses the pigForecast pure cores for add/move/delete/reconcile', () => {
    expect(plannedHookSrc).toMatch(
      /import \{[\s\S]*?addPlannedTrip,[\s\S]*?movePigsBetweenTrips,[\s\S]*?deletePlannedTripWithReconciliation,[\s\S]*?deleteReconciliationRecipient,[\s\S]*?\} from '\.\.\/lib\/pigForecast\.js'/,
    );
    expect(plannedHookSrc).toMatch(/plannedProcessingTrips/);
  });
});

describe('CP10 — processing-trip workflow extracted to usePigProcessingTrips', () => {
  it('PigBatchesView imports and wires the usePigProcessingTrips hook (PigContext form state threaded in)', () => {
    expect(viewSrc).toMatch(/import \{usePigProcessingTrips\} from '\.\/usePigProcessingTrips\.js'/);
    expect(viewSrc).toMatch(
      /usePigProcessingTrips\(\{[\s\S]*?activeTripBatchId,[\s\S]*?tripForm,[\s\S]*?editTripId,[\s\S]*?\}\)/,
    );
  });

  it('PigBatchesView no longer declares the moved processing-trip state/handlers/helper', () => {
    expect(viewSrc).not.toMatch(/const \[tripSentWeighins, setTripSentWeighins\] = React\.useState/);
    expect(viewSrc).not.toMatch(/const \[tripSessionBatch, setTripSessionBatch\] = React\.useState/);
    expect(viewSrc).not.toMatch(/function tripSourceCounts\(/);
    expect(viewSrc).not.toMatch(/function persistTrip\(/);
    expect(viewSrc).not.toMatch(/function updTrip\(/);
    expect(viewSrc).not.toMatch(/function closeTripForm\(/);
    expect(viewSrc).not.toMatch(/function deleteTrip\(/);
  });

  it('the hook keeps the explicit dependency signature (PigContext form setters threaded)', () => {
    expect(procHookSrc).toMatch(
      /export function usePigProcessingTrips\(\{[\s\S]*?activeTripBatchId,\s*setActiveTripBatchId,\s*tripForm,\s*setTripForm,\s*editTripId,\s*setEditTripId,?\s*\}\)/,
    );
  });

  it('preserves the processingTrips persistence + fcrCached set/delete contract', () => {
    expect(procHookSrc).toContain('processingTrips');
    expect(procHookSrc).toMatch(/persistFeeders\(nb\)/);
    expect(procHookSrc).toMatch(/computePigBatchFCR\(next, dailysForName, breeders\)/);
    expect(procHookSrc).toMatch(/if \(fcr != null\) next\.fcrCached = fcr;/);
    expect(procHookSrc).toMatch(/else delete next\.fcrCached;/);
  });

  it('preserves subAttributions via the existing-trip spread + numeric coercion + date guard', () => {
    expect(procHookSrc).toMatch(/const trip = \{\.\.\.existing, \.\.\.tripFormNum, id: tripId\}/);
    expect(procHookSrc).toMatch(/\['pigCount', 'hangingWeight'\]\.forEach/);
    expect(procHookSrc).toMatch(/if \(!formSnapshot\.date\) return;/);
    expect(procHookSrc).toMatch(/updated\.sort\(\(a, b\) => a\.date\.localeCompare\(b\.date\)\)/);
  });

  it('preserves the delete confirmation + the sent_to_trip_id source-count load path', () => {
    expect(procHookSrc).toContain('Delete this processing trip? This cannot be undone.');
    expect(procHookSrc).toMatch(/\.not\('sent_to_trip_id', 'is', null\)/);
    expect(procHookSrc).toMatch(/from\('weigh_in_sessions'\)/);
  });
});

describe('CP11 — record-page render surface extracted to PigBatchPage', () => {
  it('PigBatchesView imports PigBatchPage and renders it only for recordGroup', () => {
    expect(viewSrc).toMatch(/import PigBatchPage from '\.\/PigBatchPage\.jsx'/);
    // The view delegates the single-batch workspace to PigBatchPage, gated on
    // recordMode && recordGroup, passing the group + the threaded view bundle.
    expect(viewSrc).toMatch(
      /recordMode && recordGroup &&[\s\S]*?<PigBatchPage\s+group=\{recordGroup\}\s+view=\{pigBatchPageView\}/,
    );
  });

  it('PigBatchPage is a context-consuming component that takes {group, view}', () => {
    expect(pageSrc).toMatch(/export default function PigBatchPage\(\{group, view\}\)/);
    // Consumes the shared contexts directly rather than re-threading them.
    expect(pageSrc).toMatch(/const \{authState\} = useAuth\(\)/);
    expect(pageSrc).toMatch(/= usePig\(\)/);
  });

  it('PigBatchPage imports React (the card JSX references React.Fragment)', () => {
    // eslint treats React as a global under the automatic JSX runtime, so an
    // explicit React.Fragment with no import compiles + lints clean but throws
    // ReferenceError at render. Lock the import alongside the usage.
    expect(pageSrc).toMatch(/import React from 'react'/);
    expect(pageSrc).toContain('React.Fragment');
  });

  it('the record-only workspace JSX now lives in PigBatchPage, not the view', () => {
    // Mortality entry modal moved with the card.
    expect(pageSrc).toContain('Record Mortality');
    expect(viewSrc).not.toContain('Record Mortality');
    // Planned-trip lock affordances moved with the card.
    expect(pageSrc).toMatch(/data-planned-trip-lock=/);
    expect(viewSrc).not.toMatch(/data-planned-trip-lock=/);
    // The RecordCollaborationSection mount moved with the card.
    expect(pageSrc).toContain('RecordCollaborationSection');
    expect(viewSrc).not.toContain('RecordCollaborationSection');
  });

  it('PigBatchesView keeps the hub-only surfaces (Global ADG, Add Batch, archive, hub tile)', () => {
    expect(viewSrc).toMatch(/['"]ppp-pig-global-adg-v1['"]/); // Global ADG persistence
    expect(viewSrc).toMatch(/import PigBatchHubTile from '\.\/PigBatchHubTile\.jsx'/);
    expect(viewSrc).toMatch(/<PigBatchHubTile/);
    // Archive/unarchive batch handlers stay view-owned and are threaded into the page.
    expect(viewSrc).toMatch(/archiveBatch/);
    expect(viewSrc).toMatch(/unarchiveBatch/);
  });

  it('legacy inline activity surface stays absent from BOTH the view and the page', () => {
    for (const src of [viewSrc, pageSrc]) {
      expect(src).not.toContain('ActivityPanel');
      expect(src).not.toContain('ActivityModal');
      expect(src).not.toContain('wcf-entity-deep-link');
    }
  });

  it('the /pig/batches/<id> route contract is unchanged (view still owns routing)', () => {
    expect(viewSrc).toMatch(/import \{useNavigate, useLocation\} from 'react-router-dom'/);
    expect(viewSrc).toMatch(/const recordMode = location\.pathname\.startsWith\('\/pig\/batches\/'\)/);
    expect(viewSrc).toMatch(/navigate\('\/pig\/batches\/' \+ encodeURIComponent\(id\)/);
  });
});

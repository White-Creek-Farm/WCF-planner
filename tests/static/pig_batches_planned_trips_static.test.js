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

// ============================================================================
// Pig planned-trip locks lane — sidecar + handler-level neighbor guards
// ============================================================================

describe('Pig planned-trip locks — sidecar persistence', () => {
  it('uses app_store key ppp-pig-planned-trip-locks-v1', () => {
    expect(viewSrc).toMatch(/['"]ppp-pig-planned-trip-locks-v1['"]/);
  });

  it('does not expand the six-key plannedProcessingTrips shape', () => {
    // The sidecar lives in a separate app_store key so persisted trip
    // rows stay byte-identical (id, date, sex, subBatchId, plannedCount,
    // order). The forecast allocator still returns only those six keys
    // — that lock is in the prior commit-4a block. Here, just make sure
    // no handler writes additional keys onto a planned trip when
    // persisting feederGroups.
    expect(viewSrc).not.toMatch(/plannedProcessingTrips:\s*[\s\S]*?lockedAt:/);
    expect(viewSrc).not.toMatch(/plannedProcessingTrips:\s*[\s\S]*?lockedByName:/);
    expect(viewSrc).not.toMatch(/plannedProcessingTrips:\s*[\s\S]*?locked:\s*true/);
  });

  it('locks read from / write to the sidecar key, not to ppp-feeders-v1', () => {
    // The lockPlannedTrip helper upserts to ppp-pig-planned-trip-locks-v1.
    expect(viewSrc).toMatch(/upsert\(\{key:\s*'ppp-pig-planned-trip-locks-v1',\s*data:\s*next\}/);
    // Lock records carry the four documented fields.
    expect(viewSrc).toMatch(/locked:\s*true/);
    expect(viewSrc).toMatch(/lockedByName/);
    expect(viewSrc).toMatch(/lockedByUserId/);
    expect(viewSrc).toMatch(/lockedAt/);
  });

  it('lock display name falls back authState.name → user.email → "Unknown"', () => {
    expect(viewSrc).toMatch(
      /\(authState && authState\.name\)\s*\|\|\s*\(authState && authState\.user && authState\.user\.email\)\s*\|\|\s*'Unknown'/,
    );
  });
});

describe('Pig planned-trip locks — neighbor mutation guards live in handlers', () => {
  // Codex's correction: the locked state must block mutations end-to-end,
  // not just hide JSX affordances. Each handler refuses early before
  // touching feederGroups.
  const dateHandler = viewSrc.match(/function setPlannedTripDateById\([\s\S]*?persistFeeders\(nb\);\s*\}/);
  const shiftHandler = viewSrc.match(/function shiftPlannedTripDateById\([\s\S]*?\}\s*\n/);
  const moveHandler = viewSrc.match(/function movePlannedTripPigsById\([\s\S]*?persistFeeders\(nb\);\s*\}/);
  const addHandler = viewSrc.match(/function addPlannedTripById\([\s\S]*?return \{ok: true\};\s*\}/);
  const deleteHandler = viewSrc.match(/function deletePlannedTripById\([\s\S]*?return \{ok: true\};\s*\}/);

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
    const fn = viewSrc.match(/function isChainLocked\([\s\S]*?\}\s*\n/);
    expect(fn, 'expected isChainLocked helper').not.toBeNull();
    expect(fn[0]).toMatch(/subBatchId === subBatchId && t\.sex === sex/);
    expect(fn[0]).toMatch(/\.some\(\(t\) => isTripLocked\(t\.id\)\)/);
  });
});

describe('Pig planned-trip locks — UI affordances', () => {
  it('locked trip card renders the "Locked by user: <name>" badge', () => {
    expect(viewSrc).toMatch(/'Locked by user: '\s*\+\s*\(lockEntry\.lockedByName \|\| 'Unknown'\)/);
    expect(viewSrc).toMatch(/data-planned-trip-locked-by/);
  });

  it('locked trips hide date / move / delete affordances', () => {
    // The date-controls row is gated on !tripLocked && isManager.
    expect(viewSrc).toMatch(/\{!tripLocked && isManager && \(\s*<div style=\{\{display: 'inline-flex'/);
    // The move + delete row is also gated on !tripLocked.
    expect(viewSrc).toMatch(/\{!tripLocked && isManager && \(nextSameSex \|\| prevSameSex \|\| canDelete\)/);
    // The date input only renders when not locked.
    expect(viewSrc).toMatch(/\{!tripLocked && isEditingDate && \(/);
  });

  it('admin/management get an inline Lock button on unlocked trips', () => {
    expect(viewSrc).toMatch(/data-planned-trip-lock=/);
    expect(viewSrc).toMatch(/onClick=\{\(\) => lockPlannedTrip\(t\.id\)\}/);
  });

  it('Unlock uses an inline two-step warning — no window.confirm', () => {
    // The two-step path: Unlock button toggles unlockingTripId; the
    // warning panel renders when unlockingTripId === t.id.
    expect(viewSrc).toMatch(/data-planned-trip-unlock=/);
    expect(viewSrc).toMatch(/data-planned-trip-unlock-warning=/);
    expect(viewSrc).toMatch(/data-planned-trip-unlock-cancel=/);
    expect(viewSrc).toMatch(/data-planned-trip-unlock-confirm=/);
    // Exact Codex warning copy. Tolerant of Prettier reflow that may break
    // the JSX text across multiple lines.
    expect(viewSrc).toMatch(
      /This trip has already been scheduled with the processor\.\s+Only unlock if[\s\S]*?rescheduled with the processor\./,
    );
    // No window.confirm anywhere in the unlock path.
    const unlockBlock = viewSrc.match(/data-planned-trip-unlock-warning[\s\S]*?Confirm unlock[\s\S]*?<\/button>/);
    expect(unlockBlock, 'expected unlock warning JSX').not.toBeNull();
    expect(unlockBlock[0]).not.toMatch(/window\.confirm/);
  });

  it('Add gilt/boar trip buttons disable when the corresponding chain has a locked trip', () => {
    expect(viewSrc).toMatch(/giltChainLocked\s*=\s*isChainLocked\([\s\S]*?g\.plannedProcessingTrips[\s\S]*?'gilt'/);
    expect(viewSrc).toMatch(/boarChainLocked\s*=\s*isChainLocked\([\s\S]*?g\.plannedProcessingTrips[\s\S]*?'boar'/);
    expect(viewSrc).toMatch(/disabled=\{giltChainLocked\}/);
    expect(viewSrc).toMatch(/disabled=\{boarChainLocked\}/);
  });
});

describe('CP2 — pig.batch record-page helper extraction (no re-inlining)', () => {
  it('imports current-count ledger helpers from lib/pig.js', () => {
    expect(viewSrc).toMatch(/computeSubLedgerCurrent/);
    expect(viewSrc).toMatch(/computeSubCurrentCount/);
    expect(viewSrc).toMatch(/computeBatchCurrentCount/);
  });

  it('imports deleteReconciliationRecipient from lib/pigForecast.js', () => {
    expect(viewSrc).toMatch(
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
    expect(viewSrc).toMatch(/navigate\('\/pig\/batches\/' \+ encodeURIComponent\(id\)\)/);
    // CP6: the hub renders the extracted presentational tile and routes on open
    // by group.id; the tile carries the data-pig-batch-tile hook.
    expect(viewSrc).toMatch(/<PigBatchHubTile[\s\S]*?group=\{g\}[\s\S]*?onOpen=\{\(\) => goToBatch\(g\.id\)\}/);
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
      /export default function PigBatchHubTile\(\{group, current, started, statusColor, onOpen\}\)/,
    );
    expect(tileSrc).toMatch(/data-pig-batch-tile=\{group\.id\}/);
    expect(tileSrc).toMatch(/onClick=\{onOpen\}/);
    // Presentational only — no data/hooks/mutations leaked into the tile.
    expect(tileSrc).not.toContain('useState');
    expect(tileSrc).not.toContain('computeBatchCurrentCount');
    expect(tileSrc).not.toContain("from('app_store')");
  });

  it('record page still mounts RecordCollaborationSection with the pig.batch entity contract', () => {
    expect(viewSrc).toMatch(
      /<RecordCollaborationSection[\s\S]*?entityType="pig\.batch"[\s\S]*?entityId=\{recordGroup\.id\}[\s\S]*?entityLabel=\{recordGroup\.batchName\}/,
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

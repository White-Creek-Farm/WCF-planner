import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const cattleHerds = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
const cattleForecast = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleForecastView.jsx'), 'utf8');
const sheepFlocks = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepFlocksView.jsx'), 'utf8');
const sheepAnimalPage = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepAnimalPage.jsx'), 'utf8');
const eqAdmin = fs.readFileSync(path.join(ROOT, 'src/admin/EquipmentWebformsAdmin.jsx'), 'utf8');
const livestockFeedInputs = fs.readFileSync(path.join(ROOT, 'src/admin/LivestockFeedInputsPanel.jsx'), 'utf8');
const diffHelper = fs.readFileSync(path.join(ROOT, 'src/lib/activityChangeDiff.js'), 'utf8');
const pigBatchesView = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');
const pigSubBatches = fs.readFileSync(path.join(ROOT, 'src/pig/usePigSubBatches.js'), 'utf8');
const pigMortality = fs.readFileSync(path.join(ROOT, 'src/pig/usePigMortality.js'), 'utf8');
const pigProcessingTrips = fs.readFileSync(path.join(ROOT, 'src/pig/usePigProcessingTrips.js'), 'utf8');
const pigBreedingView = fs.readFileSync(path.join(ROOT, 'src/pig/BreedingView.jsx'), 'utf8');
const mainJsx = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const broilerListView = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerListView.jsx'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const eqAdminCode = stripComments(eqAdmin);

describe('Activity change logging - cattle.animal', () => {
  it('CattleHerdsView imports runMutation and recordFieldChange', () => {
    expect(cattleHerds).toContain("import {runMutation, recordFieldChange} from '../lib/entityMutations.js'");
  });

  it('CattleHerdsView imports buildChanges', () => {
    expect(cattleHerds).toContain("import {buildChanges, countSummary} from '../lib/activityChangeDiff.js'");
  });

  it('CattleHerdsView patchCow uses runMutation with cattle.animal', () => {
    expect(cattleHerds).toContain("entityType: 'cattle.animal'");
    expect(cattleHerds).toContain('runMutation(');
  });

  it('CattleHerdsView excludes herd and processing_batch_id', () => {
    expect(cattleHerds).toContain("'herd'");
    expect(cattleHerds).toContain("'processing_batch_id'");
    expect(cattleHerds).toContain('CATTLE_EXCLUDE');
  });

  it('CattleForecastView patchCow uses runMutation with cattle.animal', () => {
    expect(cattleForecast).toContain("entityType: 'cattle.animal'");
    expect(cattleForecast).toContain('runMutation(');
  });

  it('neither cattle view routes deletes through record.deleted', () => {
    const deleteMatches = cattleHerds.match(/record\.deleted/g);
    expect(deleteMatches).toBeNull();
    const forecastDeleteMatches = cattleForecast.match(/record\.deleted/g);
    expect(forecastDeleteMatches).toBeNull();
  });
});

describe('Activity change logging - sheep.animal', () => {
  it('SheepAnimalPage imports runMutation and recordFieldChange', () => {
    expect(sheepAnimalPage).toContain(
      "import {runMutation, recordFieldChange, recordActivityEvent} from '../lib/entityMutations.js'",
    );
  });

  it('SheepAnimalPage imports buildChanges', () => {
    expect(sheepAnimalPage).toContain("import {buildChanges, countSummary} from '../lib/activityChangeDiff.js'");
  });

  it('SheepAnimalPage patchSheep uses runMutation with sheep.animal', () => {
    expect(sheepAnimalPage).toContain("entityType: 'sheep.animal'");
    expect(sheepAnimalPage).toContain('runMutation(');
  });

  it('SheepAnimalPage excludes flock and processing_batch_id', () => {
    expect(sheepAnimalPage).toContain("'flock'");
    expect(sheepAnimalPage).toContain("'processing_batch_id'");
    expect(sheepAnimalPage).toContain('SHEEP_EXCLUDE');
  });

  it('does not route deletes through record.deleted', () => {
    expect(sheepAnimalPage.match(/record\.deleted/g)).toBeNull();
  });

  it('imports recordActivityEvent for the best-effort lambing-add emit', () => {
    expect(sheepAnimalPage).toMatch(/import \{[^}]*recordActivityEvent[^}]*\} from '\.\.\/lib\/entityMutations\.js'/);
  });

  it('addLambingRecord emits a best-effort sheep.animal record.created scoped to the dam', () => {
    // The mig 094 delete RPC already logs record.deleted against the dam's
    // sheep.animal record; adding a lambing must emit the symmetric
    // record.created so the audit stream is not one-sided.
    const fn = sheepAnimalPage.match(/async function addLambingRecord\([\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toContain('recordActivityEvent(sb');
    expect(fn[0]).toContain("entityType: 'sheep.animal'");
    // Scoped to the dam's id, NOT the lambing record id.
    expect(fn[0]).toContain('entityId: sheepRecord.id');
    expect(fn[0]).toContain("eventType: 'record.created'");
    // Lambing summary (date + counts) rides the payload.
    expect(fn[0]).toContain("record: 'sheep.lambing'");
    expect(fn[0]).toContain('lambing_date: rec.lambing_date');
    expect(fn[0]).toContain('total_born: rec.total_born');
    // Best-effort: logged only AFTER the insert succeeds (error path returns
    // first), wrapped in try/catch so it never blocks the save.
    expect(fn[0]).toMatch(/if \(error\) \{[\s\S]*?return false;[\s\S]*?recordActivityEvent\(sb/);
    expect(fn[0]).toMatch(/try \{[\s\S]*?recordActivityEvent[\s\S]*?\} catch \(_e\) \{/);
  });
});

describe('Activity change logging - equipment.item', () => {
  it('EquipmentWebformsAdmin imports runMutation and recordFieldChange and recordStatusChange', () => {
    expect(eqAdmin).toContain(
      "import {runMutation, recordFieldChange, recordStatusChange} from '../lib/entityMutations.js'",
    );
  });

  it('EquipmentWebformsAdmin imports countSummary and makeFieldChange', () => {
    expect(eqAdmin).toContain("import {countSummary, makeFieldChange} from '../lib/activityChangeDiff.js'");
  });

  it('uses equipment.item entity type', () => {
    expect(eqAdmin).toContain("entityType: 'equipment.item'");
  });

  it('IdentityEditor uses recordStatusChange for status', () => {
    expect(eqAdmin).toContain('recordStatusChange(sb');
  });

  it('retires per-equipment team_members assignment writes', () => {
    expect(eqAdminCode).not.toContain('TeamMembersEditor');
    expect(eqAdminCode).not.toContain("'team_members'");
    expect(eqAdminCode).not.toContain('equipment.team_members');
    expect(eqAdminCode).not.toContain("'Team members'");
  });

  it('uses countSummary for complex array fields', () => {
    expect(eqAdmin).toContain('countSummary(');
  });

  it('does not log documents', () => {
    expect(eqAdmin).not.toContain("field: 'documents'");
    expect(eqAdmin).not.toMatch(/recordFieldChange.*documents/);
  });

  it('does not route deletes through record.deleted', () => {
    expect(eqAdmin.match(/record\.deleted/g)).toBeNull();
  });
});

describe('Activity change logging - diff helper', () => {
  it('exports buildChanges', () => {
    expect(diffHelper).toContain('export function buildChanges');
  });

  it('exports countSummary', () => {
    expect(diffHelper).toContain('export function countSummary');
  });

  it('supports exclude parameter', () => {
    expect(diffHelper).toContain('exclude');
  });

  it('supports formatters parameter', () => {
    expect(diffHelper).toContain('formatters');
  });
});

describe('Custom editable-table Activity — cattle forecast hide/unhide (CP1)', () => {
  it('CattleForecastView imports recordActivityEvent from entityMutations', () => {
    expect(cattleForecast).toMatch(/import \{[^}]*recordActivityEvent[^}]*\} from '\.\.\/lib\/entityMutations\.js'/);
  });
  it('has a recordForecastHiddenActivity helper', () => {
    expect(cattleForecast).toContain('async function recordForecastHiddenActivity(');
  });
  it('scopes the audit to the cattle.forecast workflow entity (NOT cattle.animal)', () => {
    expect(cattleForecast).toMatch(
      /recordActivityEvent\(sb, \{[\s\S]*?entityType: 'cattle\.forecast'[\s\S]*?eventType: 'status\.changed'/,
    );
    // The forecast audit must not be logged against the cattle.animal record.
    const fn = cattleForecast.match(/async function recordForecastHiddenActivity\([\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).not.toContain("entityType: 'cattle.animal'");
  });
  it('uses the cattle forecast stream and carries the cow + month in the payload', () => {
    expect(cattleForecast).toContain("entityId: 'cattle-forecast'");
    expect(cattleForecast).toContain("cow && cow.tag ? '#' + cow.tag : cattleId");
    expect(cattleForecast).toContain('cattle_id: cattleId');
    expect(cattleForecast).toContain('month_key: monthKey');
  });
  it('mounts a month-filtered Activity log inside each expanded forecast month bucket', () => {
    expect(cattleForecast).toContain('RecordCollaborationSection');
    expect(cattleForecast).toContain('data-month-activity-log={bucket.monthKey}');
    expect(cattleForecast).toContain('ev?.payload?.month_key === bucket.monthKey');
    expect(cattleForecast).toMatch(
      /<RecordCollaborationSection[\s\S]*?entityType="cattle\.forecast"[\s\S]*?entityId="cattle-forecast"[\s\S]*?activityEventFilter=\{activityEventFilter\}[\s\S]*?showComments=\{false\}/,
    );
  });
  it('body + payload make the month, cow, and visible<->hidden action clear', () => {
    expect(cattleForecast).toContain('const month = monthLabel(monthKey)');
    expect(cattleForecast).toContain("const from = nowHidden ? 'visible' : 'hidden'");
    expect(cattleForecast).toContain("const to = nowHidden ? 'hidden' : 'visible'");
    expect(cattleForecast).toContain("'Forecast month ' + month + ' for ' + cowLabel + ' changed '");
    expect(cattleForecast).toContain('forecast_month_visibility');
  });
  it('toggleHidden logs only AFTER a successful write (returns on write error first)', () => {
    expect(cattleForecast).toMatch(
      /Could not update hide state[\s\S]*?return;[\s\S]*?recordForecastHiddenActivity\(cattleId, monthKey, !currentlyHidden\)/,
    );
  });
  it('registry + global Activity recognize the cattle.forecast entity', () => {
    const registry = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
    expect(registry).toContain("CATTLE_FORECAST: 'cattle.forecast'");
    expect(registry).toMatch(/CATTLE_FORECAST\]: \{[\s\S]*?route: \(\) => '\/cattle\/forecast'/);
    const view = fs.readFileSync(path.join(ROOT, 'src/activity/ActivityLogView.jsx'), 'utf8');
    expect(view).toContain("'cattle.forecast': 'Cattle Forecast'");
  });
});

describe('Custom editable-table Activity — feed inputs and feed tests (CP2)', () => {
  it('LivestockFeedInputsPanel imports recordActivityEvent and diff helpers', () => {
    expect(livestockFeedInputs).toMatch(
      /import \{[^}]*buildChanges[^}]*countSummary[^}]*\} from '\.\.\/lib\/activityChangeDiff\.js'/,
    );
    expect(livestockFeedInputs).toMatch(
      /import \{[^}]*recordActivityEvent[^}]*\} from '\.\.\/lib\/entityMutations\.js'/,
    );
  });

  it('scopes feed-edit audit entries to the cattle.forecast workflow entity', () => {
    expect(livestockFeedInputs).toContain("entityType: 'cattle.forecast'");
    expect(livestockFeedInputs).toContain("entityId: 'cattle-forecast'");
    expect(livestockFeedInputs).toContain("entityLabel: 'Cattle Forecast'");
  });

  it('records feed input create/update/delete payloads with stable ids', () => {
    expect(livestockFeedInputs).toContain('async function recordFeedInputSavedActivity(');
    expect(livestockFeedInputs).toContain('async function recordFeedInputDeletedActivity(');
    expect(livestockFeedInputs).toContain("eventType: created ? 'record.created' : 'field.updated'");
    expect(livestockFeedInputs).toContain("eventType: 'record.deleted'");
    expect(livestockFeedInputs).toContain('feed_input_action');
    expect(livestockFeedInputs).toContain('feed_input_id');
    expect(livestockFeedInputs).toContain('synced_from_feed_test');
  });

  it('records feed test create/update/delete payloads with stable ids', () => {
    expect(livestockFeedInputs).toContain('async function recordFeedTestSavedActivity(');
    expect(livestockFeedInputs).toContain('async function recordFeedTestDeletedActivity(');
    expect(livestockFeedInputs).toContain('feed_test_action');
    expect(livestockFeedInputs).toContain('feed_test_id');
    expect(livestockFeedInputs).toContain('effective_date');
  });

  it('does not record every debounced feed autosave tick', () => {
    const updStart = livestockFeedInputs.indexOf('function upd(k, v)');
    const updEnd = livestockFeedInputs.indexOf('function toggleHerdScope', updStart);
    expect(updStart).toBeGreaterThan(-1);
    expect(updEnd).toBeGreaterThan(updStart);
    const updBody = livestockFeedInputs.slice(updStart, updEnd);
    expect(updBody).toContain('setTimeout(() => saveFeed(next, editingId), 1500)');
    expect(updBody).not.toContain('recordActivity');
  });

  it('closeForm records one summary Activity event for intentional feed saves', () => {
    const closeStart = livestockFeedInputs.indexOf('async function closeForm()');
    const closeEnd = livestockFeedInputs.indexOf('function cancelForm()', closeStart);
    expect(closeStart).toBeGreaterThan(-1);
    expect(closeEnd).toBeGreaterThan(closeStart);
    const closeBody = livestockFeedInputs.slice(closeStart, closeEnd);
    expect(closeBody).toContain('recordActivity: true');
    expect(closeBody).toContain('previousFeed: buildFeedRecord(originalForm, editingId)');
    expect(closeBody).toContain('await saveFeed(form, null, {recordActivity: true})');
  });

  it('test-delete Activity is logged only after the delete write succeeds', () => {
    // deleteTest deletes the cattle_feed_tests row FIRST, bails on error, then
    // logs the record.deleted Activity (and only then sweeps the PDF + reloads).
    expect(livestockFeedInputs).toMatch(
      /from\('cattle_feed_tests'\)\.delete\(\)\.eq\('id', testId\);[\s\S]*?if \(error\) \{[\s\S]*?return;[\s\S]*?await recordFeedTestDeletedActivity\(currentFeed, test\)/,
    );
  });

  it('test-delete sweeps the PDF AFTER the row delete succeeds (no orphan removal on failure)', () => {
    // The storage PDF remove must come AFTER the .delete() + error bail, so a
    // failed/blocked delete never orphan-removes the PDF.
    expect(livestockFeedInputs).toMatch(
      /from\('cattle_feed_tests'\)\.delete\(\)\.eq\('id', testId\);[\s\S]*?if \(error\) \{[\s\S]*?return;[\s\S]*?storage\.from\('cattle-feed-pdfs'\)\.remove\(\[pdfPath\]\)/,
    );
  });

  it('test-delete surfaces a warning (does not silently swallow) when the record.deleted Activity fails', () => {
    // recordFeedTestDeletedActivity re-throws (surfaceErrors:true) and deleteTest
    // catches it to show an InlineNotice warning rather than losing the audit.
    expect(livestockFeedInputs).toContain('surfaceErrors: true');
    expect(livestockFeedInputs).toMatch(
      /await recordFeedTestDeletedActivity\(currentFeed, test\);[\s\S]*?catch \(e\) \{[\s\S]*?setTestNotice\(\{[\s\S]*?kind: 'warning'/,
    );
  });

  it('feed-input permanent delete routes through the SECDEF RPC (mig 108), not a client cattle_feed_inputs delete', () => {
    // The permanent-delete path moved to delete_feed_input (mig 108): no client
    // cattle_feed_inputs .delete() remains, the wrapper is called, and the
    // redundant client recordFeedInputDeletedActivity is NOT invoked on this path
    // (the RPC writes the record.deleted Activity in the same transaction).
    expect(livestockFeedInputs).toContain("import {deleteFeedInput} from '../lib/feedInputDeleteApi.js'");
    const fn = livestockFeedInputs.match(/async function deleteFeedPermanently\([\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toContain('deleteFeedInput(sb, id)');
    expect(fn[0]).not.toMatch(/from\('cattle_feed_inputs'\)\.delete\(\)/);
    expect(fn[0]).not.toContain('recordFeedInputDeletedActivity');
    // The PDF bulk-remove stays best-effort AFTER the RPC succeeds.
    expect(fn[0]).toMatch(/result[\s\S]*?\.ok[\s\S]*?storage\.from\('cattle-feed-pdfs'\)\.remove\(pdfPaths\)/);
  });
});

describe('mig 076 — _activity_can_read cattle.forecast branch', () => {
  const mig076 = fs.readFileSync(
    path.join(ROOT, 'supabase-migrations/076_cattle_forecast_activity_entity.sql'),
    'utf8',
  );
  it('replaces _activity_can_read and adds a cattle.forecast branch gated on cattle program', () => {
    expect(mig076).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_can_read/);
    expect(mig076).toMatch(/IF p_entity_type = 'cattle\.forecast' THEN[\s\S]*?RETURN 'cattle' = ANY\(v_access\)/);
  });
  it('preserves the existing weighin.session branch (full-replace, not a partial)', () => {
    expect(mig076).toContain("IF p_entity_type = 'weighin.session' THEN");
  });
  it('keeps anon revoked + authenticated granted and reloads PostgREST', () => {
    expect(mig076).toMatch(/REVOKE ALL ON FUNCTION public\._activity_can_read\(text, text\) FROM PUBLIC, anon/);
    expect(mig076).toMatch(/GRANT EXECUTE ON FUNCTION public\._activity_can_read\(text, text\) TO authenticated/);
    expect(mig076).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('Activity change logging - pig.batch (best-effort client events, app_store JSON)', () => {
  // Pig batch/sub-batch/trip/mortality data lives in app_store JSON (ppp-feeders-v1),
  // NOT a relational table, so there is no SECDEF delete RPC. The pig.batch Activity
  // stream (mounted in PigBatchPage, entity_id = group.id) is fed by best-effort
  // recordActivityEvent calls from the mutation hooks/view. Every emit is wrapped in
  // try/catch (+ swallowed promise reject) so it can never block the mutation.

  it('the four pig mutation sources import recordActivityEvent from activityApi', () => {
    for (const src of [pigBatchesView, pigSubBatches, pigMortality, pigProcessingTrips]) {
      expect(src).toMatch(/import \{[^}]*recordActivityEvent[^}]*\} from '\.\.\/lib\/activityApi\.js'/);
    }
  });

  it('every pig emit targets the pig.batch stream (entity_id = group.id)', () => {
    for (const src of [pigBatchesView, pigSubBatches, pigMortality, pigProcessingTrips]) {
      expect(src).toContain("entityType: 'pig.batch'");
    }
  });

  it('usePigSubBatches.deleteSubBatch emits a best-effort record.deleted sub-batch event', () => {
    const fn = pigSubBatches.match(/function deleteSubBatch\([\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toContain('recordActivityEvent(sb');
    expect(fn[0]).toContain("entityType: 'pig.batch'");
    expect(fn[0]).toContain('entityId: batchId');
    expect(fn[0]).toContain("eventType: 'record.deleted'");
    // Orphaned attribution/transfer/mortality counts ride in the payload.
    expect(fn[0]).toContain('orphanedTransfers');
    expect(fn[0]).toContain('orphanedTripPigs');
    expect(fn[0]).toContain('orphanedMortality');
    // Best-effort: try/catch wrap + swallowed reject; the persist still runs.
    expect(fn[0]).toContain('persistFeeders(nb)');
    expect(fn[0]).toMatch(/try \{[\s\S]*?recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
  });

  it('usePigMortality emits record.created on save and record.deleted on delete (after the upsert)', () => {
    const save = pigMortality.match(/async function saveMortality\([\s\S]*?\n {2}\}/);
    expect(save).not.toBeNull();
    expect(save[0]).toContain("eventType: 'record.created'");
    expect(save[0]).toContain("entityType: 'pig.batch'");
    expect(save[0]).toContain('entityId: batchId');
    // Logged only after the app_store upsert succeeds (the error path returns first).
    expect(save[0]).toMatch(/upsert\([\s\S]*?recordActivityEvent\(sb/);

    const del = pigMortality.match(/async function deleteMortality\([\s\S]*?\n {2}\}/);
    expect(del).not.toBeNull();
    expect(del[0]).toContain("eventType: 'record.deleted'");
    expect(del[0]).toContain('entityId: batchId');
    expect(del[0]).toMatch(/upsert\([\s\S]*?recordActivityEvent\(sb/);
  });

  it('usePigProcessingTrips.deleteTrip emits a best-effort record.deleted trip event', () => {
    const fn = pigProcessingTrips.match(/function deleteTrip\([\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toContain("eventType: 'record.deleted'");
    expect(fn[0]).toContain('entityId: batchId');
    expect(fn[0]).toContain("record: 'pig.processingTrip'");
    // Trip date + pigCount + weights ride the payload.
    expect(fn[0]).toContain('pigCount');
    expect(fn[0]).toContain('hangingWeight');
    expect(fn[0]).toMatch(/try \{[\s\S]*?recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
  });

  it('PigBatchesView emits record.deleted for the batch root and status.changed for archive/unarchive', () => {
    expect(pigBatchesView).toContain("eventType: 'record.deleted'");
    expect(pigBatchesView).toContain("record: 'pig.batch'");
    // Root delete carries sub/trip/mortality cascade counts.
    expect(pigBatchesView).toContain('subBatchCount');
    expect(pigBatchesView).toContain('processingTripCount');
    expect(pigBatchesView).toContain('mortalityCount');
    // archive/unarchive route through a shared status.changed helper.
    expect(pigBatchesView).toContain('function recordBatchStatusChange(');
    expect(pigBatchesView).toContain("eventType: 'status.changed'");
    expect(pigBatchesView).toContain('subCascadeCount');
  });

  it('does NOT change pig delete BEHAVIOR — no blocking guard added around the deletes', () => {
    // The deletes still filter + persist unconditionally; the Activity emit is
    // additive and swallowed. Assert the persist/setFeederGroups calls survive.
    expect(pigSubBatches).toContain('persistFeeders(nb)');
    expect(pigProcessingTrips).toContain('persistFeeders(nb)');
    expect(pigBatchesView).toContain('setFeederGroups(nb)');
  });

  it('pig breeding cycles are intentionally SKIPPED — no pig.breeding entity is invented', () => {
    // BreedingView deletes a breeding cycle but pig breeding has NO registered
    // Activity entity/stream (the registry only has pig.batch + pig.daily for pig;
    // breeding/forecast workflow entities are cattle-only). So we do NOT emit there
    // and we must not fabricate a pig.breeding entity_type.
    expect(pigBreedingView).not.toContain('recordActivityEvent');
    expect(pigBreedingView).not.toContain('pig.breeding');
    const registry = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
    expect(registry).not.toContain("'pig.breeding'");
    expect(registry).not.toContain('PIG_BREEDING');
  });
});

describe('Activity change logging - broiler.batch (best-effort client events, app_store JSON)', () => {
  // Broiler batches live in app_store JSON (ppp-v4), NOT a relational table, so
  // there is no SECDEF delete RPC. The broiler.batch Activity stream (mounted in
  // BroilerBatchPage, entity_id = batch.name) is fed by best-effort
  // recordActivityEvent calls: the batch delete in src/main.jsx del(id), and the
  // process/reactivate status flips in BroilerListView. Every emit is wrapped in
  // try/catch (+ swallowed promise reject) so it can never block the mutation.

  it('main.jsx and BroilerListView import recordActivityEvent from activityApi', () => {
    for (const src of [mainJsx, broilerListView]) {
      expect(src).toMatch(/import \{[^}]*recordActivityEvent[^}]*\} from '\.[./]*lib\/activityApi\.js'/);
    }
  });

  it('every broiler emit targets the broiler.batch stream (entity_id = batch.name)', () => {
    for (const src of [mainJsx, broilerListView]) {
      expect(src).toContain("entityType: 'broiler.batch'");
    }
  });

  it('main.jsx del(id) emits a best-effort record.deleted AFTER the persist', () => {
    const fn = mainJsx.match(/function del\(id\) \{[\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toContain('recordActivityEvent(sb');
    expect(fn[0]).toContain("entityType: 'broiler.batch'");
    expect(fn[0]).toContain('entityId: name');
    expect(fn[0]).toContain("eventType: 'record.deleted'");
    // breed/hatchery/status/processing context ride in the payload.
    expect(fn[0]).toContain('breed:');
    expect(fn[0]).toContain('hatchery:');
    expect(fn[0]).toContain('status:');
    expect(fn[0]).toContain('processingDate:');
    // Best-effort: logged only after persist; try/catch + swallowed reject; the
    // delete still filters + persists unconditionally (behavior unchanged).
    expect(fn[0]).toMatch(/persist\(nb\)[\s\S]*?recordActivityEvent\(sb/);
    expect(fn[0]).toMatch(/try \{[\s\S]*?recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
  });

  it('BroilerListView routes process/reactivate flips through a shared status.changed helper', () => {
    expect(broilerListView).toContain('function recordBroilerStatusChange(');
    expect(broilerListView).toContain("eventType: 'status.changed'");
    expect(broilerListView).toContain('entityId: name');
    // Both flip sites call the helper after persist (process -> processed,
    // reactivate -> active); the persist still runs unconditionally.
    expect(broilerListView).toContain("recordBroilerStatusChange(b, b.status || 'active', 'processed')");
    expect(broilerListView).toContain("recordBroilerStatusChange(b, b.status || 'processed', 'active')");
    expect(broilerListView).toMatch(/persist\(nb\);\s*recordBroilerStatusChange\(/);
    // Best-effort: try/catch + swallowed reject inside the helper.
    const fn = broilerListView.match(/function recordBroilerStatusChange\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/try \{[\s\S]*?recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
  });

  it('does NOT change broiler delete/persist BEHAVIOR — emit is additive and swallowed', () => {
    // del still filters + persists; the status flips still map + persist.
    const fn = mainJsx.match(/function del\(id\) \{[\s\S]*?\n {2}\}/);
    expect(fn[0]).toContain('batches.filter((b) => b.id !== id)');
    expect(fn[0]).toContain('persist(nb)');
    expect(broilerListView).toContain("{...x, status: 'processed'}");
    expect(broilerListView).toContain("{...x, status: 'active'}");
  });
});

describe('Activity change logging - no direct table access', () => {
  const allSrc = [
    cattleHerds,
    cattleForecast,
    sheepFlocks,
    eqAdmin,
    livestockFeedInputs,
    pigBatchesView,
    pigSubBatches,
    pigMortality,
    pigProcessingTrips,
    mainJsx,
    broilerListView,
  ];
  for (const src of allSrc) {
    it('does not reference .from(activity_events)', () => {
      expect(src).not.toMatch(/\.from\(['"]activity_events['"]\)/);
    });
    it('does not reference .from(activity_mentions)', () => {
      expect(src).not.toMatch(/\.from\(['"]activity_mentions['"]\)/);
    });
  }
});

describe('Activity change logging - PR2A best-effort logging additions', () => {
  // PR2A (mutation-audit lane) adds best-effort recordActivityEvent/recordFieldChange
  // AFTER the existing successful mutation (never wraps it in runMutation, so
  // mutation behavior + the mutation-inventory counts are unchanged). These lock the
  // new emits so a future refactor cannot silently drop the create/delete-symmetry
  // leg. Deferred sites (autosave-diff + entity-scoping) and the ratified documents
  // exclusion are asserted absent below.
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const cattleAnimalPage = read('src/cattle/CattleAnimalPage.jsx');
  const cattleBatchesView = read('src/cattle/CattleBatchesView.jsx');
  const sowsView = read('src/pig/SowsView.jsx');
  const weighInSession = read('src/livestock/WeighInSessionPage.jsx');
  const weighInsWebform = read('src/webforms/WeighInsWebform.jsx');
  const eqAddModal = read('src/equipment/EquipmentAddModal.jsx');
  const eqMaintModal = read('src/equipment/EquipmentMaintenanceModal.jsx');
  const eqDetail = read('src/equipment/EquipmentDetail.jsx');
  const sheepProc = read('src/lib/sheepProcessingBatch.js');
  const cattleProc = read('src/lib/cattleProcessingBatch.js');

  it('cattle: calving + new-cow record.created on cattle.animal, schedule on cattle.processing', () => {
    expect(cattleAnimalPage).toContain("record: 'cattle.calving'");
    expect(cattleAnimalPage).toContain("entityType: 'cattle.animal'");
    expect(cattleHerds).toContain("record: 'cattle.animal'");
    expect(cattleBatchesView).toContain("entityType: 'cattle.processing'");
    expect(cattleBatchesView).toContain("eventType: 'record.created'");
  });

  it('pig: add batch record.created, sub-batch archive/unarchive status.changed, breeder delete record.deleted', () => {
    expect(pigBatchesView).toContain("'Added batch '");
    expect(pigSubBatches).toContain("'Archived sub-batch '");
    expect(pigSubBatches).toContain("'Reopened sub-batch '");
    expect(pigSubBatches).toContain("eventType: 'status.changed'");
    expect(sowsView).toContain("'Deleted breeding pig '");
    expect(sowsView).toContain("eventType: 'record.deleted'");
  });

  it('weigh-in identity: animal-scoped field.updated in addition to the session event', () => {
    expect(weighInSession).toContain('changes: animalChanges');
    expect(weighInSession).toContain('changes: swapChanges');
    expect(weighInSession).toContain("session.species === 'sheep' ? 'sheep.animal' : 'cattle.animal'");
  });

  it('webform weigh-in: new_cow record.created, retag/reconcile field.updated, finalize status.changed', () => {
    expect(weighInsWebform).toContain("'Added cattle animal #'");
    expect(weighInsWebform).toContain('changes: retagChanges');
    expect(weighInsWebform).toContain('changes: reconcileChanges');
    expect(weighInsWebform).toContain("entityType: 'weighin.session'");
    expect(weighInsWebform).toContain("to: 'complete'");
  });

  it('equipment: add + maintenance record.created, interval edits field.updated', () => {
    expect(eqAddModal).toContain("'Added equipment '");
    expect(eqAddModal).toContain("eventType: 'record.created'");
    expect(eqMaintModal).toContain("'Logged maintenance event'");
    expect(eqDetail).toContain("action: 'remove_interval_entry'");
    expect(eqDetail).toContain("action: 'toggle_interval_task'");
  });

  it('processing: login-gated webform attach emits field.updated on the batch (cattle + sheep parity)', () => {
    expect(sheepProc).toContain("entityType: 'sheep.processing'");
    expect(sheepProc).toContain("action: 'attach'");
    expect(cattleProc).toContain("entityType: 'cattle.processing'");
    expect(cattleProc).toContain("action: 'attach'");
  });

  it('every PR2A emit stays best-effort (try/catch or swallowed reject; never blocks the mutation)', () => {
    expect(cattleAnimalPage).toMatch(/try \{[\s\S]*?recordActivityEvent[\s\S]*?\} catch \(_e\)/);
    expect(sheepProc).toMatch(/try \{[\s\S]*?recordActivityEvent[\s\S]*?\} catch \(_e\)/);
    expect(pigSubBatches).toMatch(/recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
  });

  it('PR2B closed the deferred sites — FarrowingView + FuelBillsView now emit best-effort', () => {
    // Formerly deferred in PR2A; PR2B added the scoped emits (see the PR2B
    // describe below for the full behavior locks).
    expect(read('src/pig/FarrowingView.jsx')).toContain('recordActivityEvent');
    expect(read('src/admin/FuelBillsView.jsx')).toContain('recordActivityEvent');
    // EquipmentWebformsAdmin documents stay unaudited (ratified exclusion — see the
    // 'does not log documents' test above).
    expect(eqAdmin).not.toContain("field: 'documents'");
  });
});

describe('Activity change logging - PR2B (autosave low-noise, farrowing scoping, fuel-bill entity)', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const pigBatches = read('src/pig/PigBatchesView.jsx');
  const eqDetail = read('src/equipment/EquipmentDetail.jsx');
  const farrowing = read('src/pig/FarrowingView.jsx');
  const fuelBills = read('src/admin/FuelBillsView.jsx');
  const registry = read('src/lib/activityRegistry.js');
  const activityLogView = read('src/activity/ActivityLogView.jsx');
  const mig154 = read('supabase-migrations/154_fuel_bill_activity_entity.sql');
  const mig107 = read('supabase-migrations/107_delete_fuel_bill_rpc.sql');

  // ── 1. Pig batch parent autosave — ONE summary on close, stable baseline ──
  describe('pig batch parent autosave (low-noise, stable-baseline diff)', () => {
    it('imports buildChanges and keeps a baseline ref separate from originalFeederForm', () => {
      expect(pigBatches).toContain("import {buildChanges} from '../lib/activityChangeDiff.js'");
      // The stable baseline is NOT originalFeederForm (which the debounce rewrites).
      expect(pigBatches).toContain('feederActivityBaselineRef');
    });

    it('updFeeder does NOT emit per debounce tick — it only captures the baseline', () => {
      const fn = pigBatches.match(/function updFeeder\(k, v\)[\s\S]*?\n {2}\}/);
      expect(fn).not.toBeNull();
      expect(fn[0]).not.toContain('recordActivityEvent');
      // Baseline captured once, guarded by id so it survives every tick.
      expect(fn[0]).toContain('feederActivityBaselineRef');
      // Autosave timing preserved (1.5s debounce).
      expect(fn[0]).toContain('1500');
    });

    it('closeFeederForm emits ONE best-effort pig.batch field.updated via buildChanges', () => {
      const fn = pigBatches.match(/function closeFeederForm\(\)[\s\S]*?\n {2}\}/);
      expect(fn).not.toBeNull();
      expect(fn[0]).toContain("entityType: 'pig.batch'");
      expect(fn[0]).toContain("eventType: 'field.updated'");
      expect(fn[0]).toContain('buildChanges(');
      expect(fn[0]).toContain("action: 'edit_batch_fields'");
      // Skips a no-op close and stays best-effort (swallowed reject).
      expect(fn[0]).toContain('if (changes.length > 0)');
      expect(fn[0]).toMatch(/recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
      // Close-before-1.5s + partition-dirty flush behavior preserved.
      expect(fn[0]).toContain('partitionDirtyRef.current');
    });
  });

  // ── 2. Equipment fueling autosave — ONE summary per field session ──
  // The emit must NOT live in the 800ms debounce target (patchFuelingField); a
  // slow multi-pause edit fires that several times. Baseline captured on queue,
  // persisted per tick, emitted once on blur/close/flush.
  describe('equipment fueling autosave (one summary per session, no debounce-tick rows)', () => {
    it('imports buildChanges and keeps a per-field Activity baseline ref', () => {
      expect(eqDetail).toContain("import {buildChanges} from '../lib/activityChangeDiff.js'");
      expect(eqDetail).toContain('fuelingActivityBaselineRef');
    });

    it('patchFuelingField (the 800ms debounce target) PERSISTS only — it does NOT emit Activity', () => {
      const fn = eqDetail.match(/async function patchFuelingField\([\s\S]*?\n {2}\}/);
      expect(fn).not.toBeNull();
      expect(fn[0]).not.toContain('recordActivityEvent');
      // It only records the latest durable value for the close/flush emit to diff.
      expect(fn[0]).toContain('fuelingActivityBaselineRef.current[key].latest = next');
    });

    it('queueFuelingSave captures the pre-edit baseline once per (fueling, field) session', () => {
      const fn = eqDetail.match(/function queueFuelingSave\([\s\S]*?\n {2}\}/);
      expect(fn).not.toBeNull();
      expect(fn[0]).toContain('fuelingActivityBaselineRef');
      expect(fn[0]).not.toContain('recordActivityEvent');
    });

    it('the close/flush path owns the ONE equipment.item field.updated emit (edit_fueling_field)', () => {
      const fn = eqDetail.match(/function emitFuelingFieldActivity\([\s\S]*?\n {2}\}/);
      expect(fn).not.toBeNull();
      expect(fn[0]).toContain("entityType: 'equipment.item'");
      expect(fn[0]).toContain("record: 'equipment.fueling'");
      expect(fn[0]).toContain("action: 'edit_fueling_field'");
      expect(fn[0]).toContain('fueling_id: base.fuelingId');
      // Diffs baseline -> latest; unchanged / never-saved sessions emit nothing.
      expect(fn[0]).toContain('buildChanges(');
      expect(fn[0]).toContain('if (changes.length === 0) return');
      expect(fn[0]).toContain('if (base.latest === undefined) return');
      expect(fn[0]).toMatch(/recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
    });

    it('emit/clear happens ONLY after a durable flush — failed/pending saves keep their baseline for retry', () => {
      const blur = eqDetail.match(/async function flushFuelingFieldSave\([\s\S]*?\n {2}\}/);
      expect(blur).not.toBeNull();
      // Blur emits only when the flush succeeded (ok); a failed flush leaves the
      // pending save + baseline untouched for the next retry.
      expect(blur[0]).toContain('if (ok) emitFuelingFieldActivity(key)');
      const flushAll = eqDetail.match(/async function flushAllEquipmentAutosaves\([\s\S]*?\n {2}\}/);
      expect(flushAll).not.toBeNull();
      // Flush-all emits only baselines whose save is no longer pending (durably
      // complete); a still-pending (failed) save keeps its baseline.
      expect(flushAll[0]).toContain('emitFuelingFieldActivity(key)');
      expect(flushAll[0]).toContain('!(key in pendingFuelingSaves.current)');
    });

    it('does NOT log the derived current-reading sync as a separate user edit', () => {
      const fn = eqDetail.match(/async function syncCurrentReadingFromFuelings\([\s\S]*?\n {2}\}/);
      expect(fn).not.toBeNull();
      expect(fn[0]).not.toContain('recordActivityEvent');
    });
  });

  // ── 3. Farrowing → pig.breeder scoping (create/edit/delete on matched sow) ──
  describe('farrowing pig.breeder scoping', () => {
    it('uses the existing pig.breeder entity and never invents pig.farrowing/pig.breeding', () => {
      expect(farrowing).toContain("const BREEDING_PIG_ENTITY_TYPE = 'pig.breeder'");
      // record: 'pig.farrowing' is a PAYLOAD discriminator only, never an entity_type.
      expect(farrowing).toContain("record: 'pig.farrowing'");
      expect(farrowing).not.toMatch(/entityType: 'pig\.farrowing'/);
      expect(farrowing).not.toContain("'pig.breeding'");
    });

    it('scopes the emit to the matched breeder id and SKIPS when no breeder matches', () => {
      const fn = farrowing.match(/function recordFarrowingActivity\([\s\S]*?\n {2}\}/);
      expect(fn).not.toBeNull();
      expect(fn[0]).toContain('matchBreederForSow(');
      // No breeder match → skip (do not write to an invalid entity id).
      expect(fn[0]).toContain('if (!breeder) return;');
      expect(fn[0]).toContain('entityId: breeder.id');
      expect(fn[0]).toMatch(/recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
    });

    it('covers create, edit (diffed), and delete of a farrowing record', () => {
      expect(farrowing).toContain("recordFarrowingActivity(rec, 'record.created')");
      expect(farrowing).toContain("recordFarrowingActivity(rec, 'field.updated', changes)");
      expect(farrowing).toContain("recordFarrowingActivity(deleted, 'record.deleted')");
      // Edit path diffs the prior record so a no-op save logs nothing.
      expect(farrowing).toContain('buildChanges(existing, rec');
    });
  });

  // ── 4. Dedicated equipment.fuel_bill entity (registry + log + create + mig) ──
  describe('equipment.fuel_bill Activity entity', () => {
    it('registry registers equipment.fuel_bill with an intentionally inert route', () => {
      expect(registry).toContain("EQUIPMENT_FUEL_BILL: 'equipment.fuel_bill'");
      // route null on purpose — no per-bill record page / stable deep-link, and we
      // must not fabricate a /fleet route that lands on the wrong surface.
      expect(registry).toMatch(/EQUIPMENT_FUEL_BILL\]: \{[\s\S]*?route: null/);
    });

    it('Activity Log labels + filters recognize equipment.fuel_bill', () => {
      expect(activityLogView).toContain("'equipment.fuel_bill': 'Fuel Bill'");
      expect(activityLogView).toContain("{value: 'equipment.fuel_bill', label: 'Fuel Bill'}");
    });

    it('FuelBillsView emits record.created after the bill + lines save, past every rollback', () => {
      expect(fuelBills).toContain("import {recordActivityEvent} from '../lib/activityApi.js'");
      const fn = fuelBills.match(/async function save\(\)[\s\S]*?\n {2}\}/);
      expect(fn).not.toBeNull();
      expect(fn[0]).toContain("entityType: 'equipment.fuel_bill'");
      expect(fn[0]).toContain("eventType: 'record.created'");
      expect(fn[0]).toContain("action: 'create_fuel_bill'");
      // Ordered AFTER the fuel_bill_lines insert (so a rolled-back save emits nothing).
      expect(fn[0]).toMatch(/fuel_bill_lines'\)\.insert\(lineRows\)[\s\S]*?recordActivityEvent\(sb/);
      expect(fn[0]).toMatch(/recordActivityEvent[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
    });

    it('mig 154 adds an admin-only fuel_bill read branch with NO row-existence gate', () => {
      expect(mig154).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_can_read/);
      expect(mig154).toMatch(/IF p_entity_type = 'equipment\.fuel_bill' THEN\s*\n\s*RETURN v_role = 'admin';/);
      // Full re-issue preserves every existing branch (not a partial).
      for (const t of [
        'pig.breeder',
        'todo.item',
        'cattle.log',
        'weighin.session',
        'equipment.item',
        'cattle.daily',
        'cattle.forecast',
      ]) {
        expect(mig154, `mig 154 dropped the ${t} branch`).toContain(`'${t}'`);
      }
      expect(mig154).toMatch(/REVOKE ALL ON FUNCTION public\._activity_can_read\(text, text\) FROM PUBLIC, anon/);
      expect(mig154).toMatch(/GRANT EXECUTE ON FUNCTION public\._activity_can_read\(text, text\) TO authenticated/);
      expect(mig154).toMatch(/NOTIFY pgrst, 'reload schema'/);
    });

    it('mig 154 re-scopes delete_fuel_bill onto equipment.fuel_bill (not equipment.item)', () => {
      const delFn = mig154.slice(mig154.indexOf('FUNCTION public.delete_fuel_bill'));
      expect(delFn).toContain("'equipment.fuel_bill'");
      expect(delFn).not.toContain("'equipment.item'");
    });

    it('mig 154 does NOT re-issue _activity_can_write (it delegates to _activity_can_read)', () => {
      expect(mig154).not.toContain('CREATE OR REPLACE FUNCTION public._activity_can_write');
    });

    it('mig 107 is left untouched — it still emits equipment.item; the re-scope lives in 154', () => {
      expect(mig107).toContain("'equipment.item'");
      expect(mig107).not.toContain("'equipment.fuel_bill'");
    });
  });

  // ── 5. No source file writes activity_events / activity_mentions directly ──
  it('every PR2B source emits via the RPC layer, never .from(activity_events/mentions)', () => {
    for (const src of [pigBatches, eqDetail, farrowing, fuelBills]) {
      expect(src).not.toMatch(/\.from\(['"]activity_events['"]\)/);
      expect(src).not.toMatch(/\.from\(['"]activity_mentions['"]\)/);
    }
  });
});

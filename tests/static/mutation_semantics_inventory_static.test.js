import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_LITERAL_MUTATION_TOTALS = new Map([
  // +1 delete from savedViewsApi.deleteSavedView (app_saved_views, mig 095).
  ['delete', 29],
  // +1 insert from savedViewsApi.createSavedView (app_saved_views, mig 095).
  // -2 insert: PR3 removes the obsolete cattle/sheep client-side processing-
  // detach transfer inserts; migration 170 owns both atomically.
  ['insert', 63],
  // CP2: 12 direct daily-table .update() literals (6 record pages + 6 list
  // views) moved to the update_daily_report SECDEF RPC (mig 091).
  // +1 update from savedViewsApi.updateSavedView (app_saved_views, mig 095).
  // -1 update from retiring per-equipment team_members assignment.
  // -1 update from removing the team-roster → equipment.team_members cascade
  //    in WebformsAdminView (roster teardown).
  // +2 update from pig processing trip source-entry stamping + rollback.
  // -6 update: PR3 removes client-side batch/animal/weigh-in detach updates
  // from the cattle and sheep processing helpers.
  ['update', 76],
  // -3 upsert from deleting teamMembers.js (2) + teamAvailability.js (1), the
  //    webform_config roster/availability writers (roster teardown).
  // -9 upsert from collapsing main.jsx public-webform mirror writers behind
  //    a compare-before-write helper (Disk IO budget protection).
  ['upsert', 31],
]);

const EXPECTED_OWNER_OPERATION_COUNTS = new Map([
  ['src/admin/EquipmentMaterialsEditor.jsx|delete', 2],
  ['src/admin/EquipmentMaterialsEditor.jsx|insert', 1],
  ['src/admin/EquipmentMaterialsEditor.jsx|update', 1],
  ['src/admin/EquipmentWebformsAdmin.jsx|update', 9],
  ['src/admin/FuelBillsView.jsx|delete', 2],
  ['src/admin/FuelBillsView.jsx|insert', 2],
  ['src/admin/FuelLogAdmin.jsx|delete', 1],
  ['src/admin/FuelLogAdmin.jsx|upsert', 1],
  ['src/admin/LivestockFeedInputsPanel.jsx|delete', 2],
  ['src/admin/LivestockFeedInputsPanel.jsx|insert', 1],
  ['src/admin/LivestockFeedInputsPanel.jsx|update', 2],
  ['src/admin/LivestockFeedInputsPanel.jsx|upsert', 1],
  ['src/admin/NutritionTargetsPanel.jsx|upsert', 1],
  ['src/auth/UsersModal.jsx|delete', 1],
  ['src/auth/UsersModal.jsx|update', 4],
  ['src/broiler/BroilerDailysView.jsx|insert', 1],
  ['src/cattle/CattleAnimalPage.jsx|delete', 1],
  ['src/cattle/CattleAnimalPage.jsx|insert', 1],
  ['src/cattle/CattleAnimalPage.jsx|update', 1],
  ['src/cattle/CattleBatchPage.jsx|delete', 1],
  ['src/cattle/CattleBatchPage.jsx|update', 3],
  ['src/cattle/CattleBatchesView.jsx|insert', 1],
  ['src/cattle/CattleBulkImport.jsx|insert', 7],
  ['src/cattle/CattleForecastView.jsx|update', 1],
  ['src/cattle/CattleHerdsView.jsx|delete', 1],
  ['src/cattle/CattleHerdsView.jsx|insert', 3],
  ['src/cattle/CattleHerdsView.jsx|update', 2],
  ['src/cattle/CattleWeighInsView.jsx|insert', 1],
  ['src/dashboard/HomeDashboard.jsx|insert', 1],
  ['src/dashboard/HomeDashboard.jsx|upsert', 2],
  ['src/equipment/EquipmentAddModal.jsx|insert', 1],
  ['src/equipment/EquipmentDetail.jsx|delete', 2],
  ['src/equipment/EquipmentDetail.jsx|update', 7],
  ['src/equipment/EquipmentMaintenanceModal.jsx|insert', 1],
  ['src/equipment/EquipmentMaintenanceModal.jsx|update', 1],
  ['src/equipment/EquipmentMeterStatusPanel.jsx|update', 1],
  ['src/layer/EggDailysView.jsx|insert', 1],
  ['src/layer/LayerBatchPage.jsx|delete', 2],
  ['src/layer/LayerBatchPage.jsx|upsert', 2],
  ['src/layer/LayerBatchesView.jsx|upsert', 1],
  ['src/layer/LayerDailysView.jsx|insert', 1],
  ['src/layer/LayerHousingPage.jsx|upsert', 2],
  ['src/lib/broiler.js|upsert', 2],
  ['src/lib/cattleForecastApi.js|delete', 2],
  ['src/lib/savedViewsApi.js|delete', 1],
  ['src/lib/savedViewsApi.js|insert', 1],
  ['src/lib/savedViewsApi.js|update', 1],
  ['src/lib/cattleForecastApi.js|insert', 2],
  ['src/lib/cattleForecastApi.js|update', 2],
  ['src/lib/cattleForecastApi.js|upsert', 1],
  ['src/lib/cattleProcessingBatch.js|insert', 2],
  ['src/lib/cattleProcessingBatch.js|update', 4],
  ['src/lib/layerHousing.js|update', 1],
  ['src/lib/notificationsApi.js|update', 2],
  ['src/lib/sheepProcessingBatch.js|insert', 2],
  ['src/lib/sheepProcessingBatch.js|update', 3],
  ['src/lib/tasksAdminApi.js|delete', 1],
  ['src/lib/tasksAdminApi.js|insert', 1],
  ['src/lib/tasksAdminApi.js|upsert', 2],
  ['src/lib/tasksCenterMutationsApi.js|delete', 1],
  ['src/lib/tasksCenterMutationsApi.js|update', 2],
  ['src/lib/tasksCenterMutationsApi.js|upsert', 1],
  ['src/livestock/WeighInSessionPage.jsx|delete', 3],
  ['src/livestock/WeighInSessionPage.jsx|insert', 3],
  ['src/livestock/WeighInSessionPage.jsx|update', 15],
  ['src/livestock/WeighInSessionPage.jsx|upsert', 6],
  ['src/main.jsx|update', 1],
  ['src/main.jsx|upsert', 5],
  ['src/pig/PigBatchesView.jsx|upsert', 1],
  ['src/pig/PigDailysView.jsx|insert', 1],
  ['src/pig/usePigMortality.js|upsert', 2],
  ['src/pig/usePigPlannedTrips.js|upsert', 1],
  ['src/shared/AdminAddReportModal.jsx|insert', 6],
  ['src/shared/AdminNewWeighInModal.jsx|insert', 1],
  ['src/sheep/SheepAnimalPage.jsx|insert', 1],
  ['src/sheep/SheepAnimalPage.jsx|update', 1],
  ['src/sheep/SheepBatchPage.jsx|delete', 1],
  ['src/sheep/SheepBatchPage.jsx|update', 4],
  ['src/sheep/SheepBatchesView.jsx|insert', 1],
  ['src/sheep/SheepBulkImport.jsx|insert', 7],
  ['src/sheep/SheepFlocksView.jsx|insert', 1],
  ['src/sheep/SheepWeighInsView.jsx|insert', 1],
  ['src/webforms/WebformHub.jsx|insert', 4],
  ['src/webforms/WeighInsWebform.jsx|delete', 5],
  ['src/webforms/WeighInsWebform.jsx|insert', 6],
  ['src/webforms/WeighInsWebform.jsx|update', 8],
]);

const EXPECTED_TABLE_OPERATION_COUNTS = new Map([
  ['app_saved_views|delete', 1],
  ['app_saved_views|insert', 1],
  ['app_saved_views|update', 1],
  ['app_store|upsert', 17],
  ['cattle_breeds|insert', 1],
  ['cattle_calving_records|delete', 2],
  ['cattle_calving_records|insert', 3],
  ['cattle_comments|delete', 2],
  ['cattle_comments|insert', 3],
  ['cattle_comments|update', 1],
  ['cattle_dailys|insert', 1],
  ['cattle_feed_inputs|delete', 1],
  ['cattle_feed_inputs|update', 1],
  ['cattle_feed_inputs|upsert', 1],
  ['cattle_feed_tests|delete', 1],
  ['cattle_feed_tests|insert', 1],
  ['cattle_feed_tests|update', 1],
  ['cattle_forecast_heifer_includes|delete', 1],
  ['cattle_forecast_heifer_includes|insert', 1],
  ['cattle_forecast_hidden|delete', 1],
  ['cattle_forecast_hidden|insert', 1],
  ['cattle_forecast_settings|upsert', 1],
  ['cattle_nutrition_targets|upsert', 1],
  ['cattle_origins|insert', 2],
  ['cattle_processing_batches|delete', 1],
  ['cattle_processing_batches|insert', 2],
  ['cattle_processing_batches|update', 7],
  ['cattle_transfers|insert', 1],
  ['cattle|insert', 3],
  ['cattle|update', 7],
  ['egg_dailys|insert', 3],
  ['equipment_fuelings|delete', 1],
  ['equipment_fuelings|update', 4],
  ['equipment_maintenance_events|delete', 1],
  ['equipment_maintenance_events|insert', 1],
  ['equipment_maintenance_events|update', 1],
  ['equipment_material_clears|delete', 1],
  ['equipment_material_clears|insert', 1],
  ['equipment_service_materials|delete', 1],
  ['equipment_service_materials|insert', 1],
  ['equipment_service_materials|update', 1],
  ['equipment|insert', 1],
  ['equipment|update', 13],
  ['fuel_bill_lines|insert', 1],
  ['fuel_bills|delete', 2],
  ['fuel_bills|insert', 1],
  ['fuel_supplies|delete', 1],
  ['fuel_supplies|upsert', 1],
  ['layer_batches|delete', 1],
  ['layer_batches|update', 1],
  ['layer_batches|upsert', 2],
  ['layer_dailys|insert', 3],
  ['layer_housings|delete', 1],
  ['layer_housings|update', 1],
  ['layer_housings|upsert', 3],
  ['notifications|update', 2],
  ['pig_dailys|insert', 3],
  ['pig_dailys|upsert', 1],
  ['poultry_dailys|insert', 3],
  ['profiles|delete', 1],
  ['profiles|update', 4],
  ['sheep_breeds|insert', 1],
  ['sheep_comments|delete', 1],
  ['sheep_comments|insert', 1],
  ['sheep_dailys|insert', 1],
  ['sheep_lambing_records|insert', 2],
  ['sheep_origins|insert', 1],
  ['sheep_processing_batches|delete', 1],
  ['sheep_processing_batches|insert', 2],
  ['sheep_processing_batches|update', 4],
  ['sheep_transfers|insert', 1],
  ['sheep|insert', 2],
  ['sheep|update', 3],
  ['task_instances|insert', 1],
  ['task_system_rules|update', 1],
  ['task_templates|delete', 2],
  ['task_templates|update', 1],
  ['task_templates|upsert', 2],
  ['webform_config|upsert', 2],
  ['weigh_in_sessions|delete', 1],
  ['weigh_in_sessions|insert', 6],
  ['weigh_in_sessions|update', 7],
  ['weigh_ins|delete', 4],
  ['weigh_ins|insert', 7],
  ['weigh_ins|update', 15],
]);

const EXPECTED_DYNAMIC_MUTATIONS = [
  'src/lib/useOfflineSubmit.js|cfg.table|insert',
  'src/lib/useOfflineSubmit.js|cfg.table|insert',
  'src/livestock/WeighInSessionPage.jsx|animalTable|update',
  'src/livestock/WeighInSessionPage.jsx|commentsTable2|update',
  // The weighin session delete's dynamic cattle/sheep comment cleanup moved into
  // delete_weigh_in_session (SECDEF, mig 101); no client-side commentsTable
  // delete remains on this page.
  'src/livestock/WeighInSessionPage.jsx|swapTable|update',
];

const EXPECTED_RUN_MUTATION_CALLERS = new Map([
  ['src/admin/EquipmentWebformsAdmin.jsx', 8],
  ['src/cattle/CattleAnimalPage.jsx', 1],
  ['src/cattle/CattleForecastView.jsx', 1],
  ['src/cattle/CattleHerdsView.jsx', 2],
  ['src/equipment/EquipmentDetail.jsx', 1],
  ['src/livestock/WeighInSessionPage.jsx', 5],
  // Processing drawer (processing-complete lane, per-caller reviewed): 19 sites,
  // every one an RPC-backed processingApi wrapper — saveProcessor, toggleCustomer,
  // saveAssignee, saveMilestoneTitle, saveMilestoneDate, saveMilestoneStatus,
  // saveLocalField (set_processing_field), markComplete, reopen, toggleSubtask,
  // addSubtask, saveSubtaskLabel, reassignSubtask, deleteSubtask, moveSubtask
  // (reorder RPC), applyTemplate, doDeleteMilestone, doArchiveRecord,
  // doRestoreRecord. NO direct .from() table writes.
  ['src/processing/ProcessingDrawer.jsx', 19],
  // Reconciliation workbench modal (migs 157/159 + comments lane, per-caller
  // reviewed): 8 sites — reconcile-planner, populate review queue
  // (sync_review_queue via Edge), resolve-link, triage, supersede-duplicate,
  // acknowledge-drift, comments preview, comments import. All RPC/Edge-backed;
  // NO direct .from() table writes.
  ['src/processing/ProcessingReconciliationModal.jsx', 8],
  ['src/sheep/SheepAnimalPage.jsx', 1],
]);

function stripComments(src) {
  return src.replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

function listRuntimeSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listRuntimeSourceFiles(full));
      continue;
    }
    if (!entry.isFile() || !/\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function runtimeSourceFiles() {
  return listRuntimeSourceFiles(path.join(ROOT, 'src'));
}

function hasTransactionalCalvingDeleteRpc() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/cattleCalvingApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/079_delete_cattle_calving_record_rpc.sql'))
  );
}

function hasProcessingBatchDeleteRpcs() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/processingBatchDeleteApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/100_processing_batch_lifecycle_rpcs.sql'))
  );
}

function hasWeighInDeleteRpcs() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/weighInDeleteApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/101_weighin_delete_activity_rpcs.sql'))
  );
}

function hasEquipmentLogDeleteRpcs() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/equipmentLogDeleteApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/102_equipment_log_delete_activity_rpcs.sql'))
  );
}

function hasLayerBatchDeleteRpc() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/layerBatchDeleteApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/106_delete_layer_batch_rpc.sql'))
  );
}

function hasFuelBillDeleteRpc() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/fuelBillDeleteApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/107_delete_fuel_bill_rpc.sql'))
  );
}

function hasFeedInputDeleteRpc() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/feedInputDeleteApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/108_delete_feed_input_rpc.sql'))
  );
}

function hasAuditedUserManagementRpcs() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/userManagementApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/171_audited_user_management.sql'))
  );
}

function expectedLiteralMutationTotals() {
  const expected = new Map(EXPECTED_LITERAL_MUTATION_TOTALS);
  // The two literal calving deletes (CattleAnimalPage + CattleHerdsView) route
  // through the SECDEF RPC instead; the saved-view delete (29 - 2) remains.
  if (hasTransactionalCalvingDeleteRpc()) expected.set('delete', 27);
  // Processing-batch lifecycle RPCs (mig 100) move CattleBatchPage.handleUnschedule
  // (cattle_processing_batches delete) and SheepBatchPage.handleDeleteBatch
  // (sheep_processing_batches delete + the sheep straggler-clear update) into
  // SECDEF RPCs: -2 delete, -1 update.
  if (hasProcessingBatchDeleteRpcs()) {
    expected.set('delete', expected.get('delete') - 2);
    expected.set('update', expected.get('update') - 1);
  }
  // Weigh-in lifecycle RPCs (mig 101) move WeighInSessionPage deleteEntry
  // (weigh_ins delete) and deleteSession (weigh_in_sessions delete) into SECDEF
  // RPCs: -2 delete. The session's dynamic comment cleanup also moved server-side
  // but was never counted in these LITERAL totals.
  if (hasWeighInDeleteRpcs()) {
    expected.set('delete', expected.get('delete') - 2);
  }
  // Equipment-log lifecycle RPCs (mig 102) move EquipmentDetail deleteFueling
  // (equipment_fuelings) and deleteMaintenance (equipment_maintenance_events)
  // into SECDEF RPCs: -2 delete.
  if (hasEquipmentLogDeleteRpcs()) {
    expected.set('delete', expected.get('delete') - 2);
  }
  // Layer-batch lifecycle RPC (mig 106) moves LayerBatchPage.handleDeleteBatch
  // (layer_housings child clear + layer_batches root) into one SECDEF RPC:
  // -2 delete.
  if (hasLayerBatchDeleteRpc()) {
    expected.set('delete', expected.get('delete') - 2);
  }
  // Fuel-bill delete RPC (mig 107) moves FuelBillsView BillDetail.del
  // (fuel_bills root; lines cascade) into a SECDEF RPC: -1 delete. The
  // BillUploadModal rollback fuel_bills delete stays a direct client delete.
  if (hasFuelBillDeleteRpc()) {
    expected.set('delete', expected.get('delete') - 1);
  }
  // Feed-input delete RPC (mig 108) moves LivestockFeedInputsPanel
  // deleteFeedPermanently (cattle_feed_inputs root; tests cascade) into a SECDEF
  // RPC: -1 delete. The deleteTest cattle_feed_tests delete stays a direct client
  // delete (it is tightened in-place, not moved server-side).
  if (hasFeedInputDeleteRpc()) {
    expected.set('delete', expected.get('delete') - 1);
  }
  // mig 171 moves UsersModal's four profile updates + redundant profile delete
  // behind audited SECDEF RPCs / the Auth-owned cascade.
  if (hasAuditedUserManagementRpcs()) {
    expected.set('delete', expected.get('delete') - 1);
    expected.set('update', expected.get('update') - 4);
  }
  return expected;
}

function expectedOwnerOperationCounts() {
  const expected = new Map(EXPECTED_OWNER_OPERATION_COUNTS);
  if (hasTransactionalCalvingDeleteRpc()) {
    expected.delete('src/cattle/CattleAnimalPage.jsx|delete');
    expected.delete('src/cattle/CattleHerdsView.jsx|delete');
  }
  if (hasProcessingBatchDeleteRpcs()) {
    expected.delete('src/cattle/CattleBatchPage.jsx|delete');
    expected.delete('src/sheep/SheepBatchPage.jsx|delete');
    expected.set('src/sheep/SheepBatchPage.jsx|update', 3);
  }
  // mig 101 removes the entry + session literal deletes; only the broiler grid
  // clear (weigh_ins delete) remains in WeighInSessionPage.
  if (hasWeighInDeleteRpcs()) {
    expected.set('src/livestock/WeighInSessionPage.jsx|delete', 1);
  }
  // mig 102 removes both EquipmentDetail literal deletes (fueling + maintenance).
  if (hasEquipmentLogDeleteRpcs()) {
    expected.delete('src/equipment/EquipmentDetail.jsx|delete');
  }
  // mig 106 removes both LayerBatchPage literal deletes (housing + batch root).
  if (hasLayerBatchDeleteRpc()) {
    expected.delete('src/layer/LayerBatchPage.jsx|delete');
  }
  // mig 107 drops FuelBillsView from 2 deletes to 1 (BillUploadModal rollback).
  if (hasFuelBillDeleteRpc()) {
    expected.set('src/admin/FuelBillsView.jsx|delete', 1);
  }
  // mig 108 drops LivestockFeedInputsPanel from 2 deletes to 1 (deleteTest's
  // cattle_feed_tests delete remains; deleteFeedPermanently moves to the RPC).
  if (hasFeedInputDeleteRpc()) {
    expected.set('src/admin/LivestockFeedInputsPanel.jsx|delete', 1);
  }
  if (hasAuditedUserManagementRpcs()) {
    expected.delete('src/auth/UsersModal.jsx|delete');
    expected.delete('src/auth/UsersModal.jsx|update');
  }
  return expected;
}

function expectedTableOperationCounts() {
  const expected = new Map(EXPECTED_TABLE_OPERATION_COUNTS);
  if (hasTransactionalCalvingDeleteRpc()) expected.delete('cattle_calving_records|delete');
  if (hasProcessingBatchDeleteRpcs()) {
    expected.delete('cattle_processing_batches|delete');
    expected.delete('sheep_processing_batches|delete');
    expected.set('sheep|update', 2);
  }
  // mig 101: the only literal weigh_in_sessions delete is gone; weigh_ins drops
  // from 4 to 3 (broiler grid clear remains).
  if (hasWeighInDeleteRpcs()) {
    expected.delete('weigh_in_sessions|delete');
    expected.set('weigh_ins|delete', 3);
  }
  // mig 102: both equipment-log delete targets are gone from client source.
  if (hasEquipmentLogDeleteRpcs()) {
    expected.delete('equipment_fuelings|delete');
    expected.delete('equipment_maintenance_events|delete');
  }
  // mig 106: both layer delete targets are gone from client source.
  if (hasLayerBatchDeleteRpc()) {
    expected.delete('layer_batches|delete');
    expected.delete('layer_housings|delete');
  }
  // mig 107: the bill-root delete moves to the RPC; fuel_bills drops 2 -> 1
  // (BillUploadModal rollback delete remains).
  if (hasFuelBillDeleteRpc()) {
    expected.set('fuel_bills|delete', 1);
  }
  // mig 108: the feed-input root delete moves to the RPC; no runtime client
  // delete remains on cattle_feed_inputs (the cattle_feed_tests delete in
  // deleteTest is unaffected).
  if (hasFeedInputDeleteRpc()) {
    expected.delete('cattle_feed_inputs|delete');
  }
  if (hasAuditedUserManagementRpcs()) {
    expected.delete('profiles|delete');
    expected.delete('profiles|update');
  }
  return expected;
}

function diffMap(expected, actual) {
  const unexpected = [...actual.keys()].filter((key) => !expected.has(key));
  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const wrongCounts = [...expected.entries()]
    .filter(([key, count]) => actual.get(key) !== count)
    .map(([key, count]) => `${key}: expected ${count}, saw ${actual.get(key) ?? 0}`);
  return {unexpected, missing, wrongCounts};
}

function collectLiteralTableMutations() {
  const mutationRe = /\.from\(\s*(['"])([^'"]+)\1\s*\)(?:(?!\.from\().){0,360}?\.(insert|update|upsert|delete)\s*\(/gs;
  const byOperation = new Map();
  const byOwnerOperation = new Map();
  const byTableOperation = new Map();
  let total = 0;

  for (const file of runtimeSourceFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of code.matchAll(mutationRe)) {
      const [, , table, operation] = match;
      byOperation.set(operation, (byOperation.get(operation) ?? 0) + 1);
      byOwnerOperation.set(`${rel}|${operation}`, (byOwnerOperation.get(`${rel}|${operation}`) ?? 0) + 1);
      byTableOperation.set(`${table}|${operation}`, (byTableOperation.get(`${table}|${operation}`) ?? 0) + 1);
      total += 1;
    }
  }

  return {byOperation, byOwnerOperation, byTableOperation, total};
}

function collectDynamicTableMutations() {
  const dynamicRe =
    /\.from\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)(?:(?!\.from\().){0,360}?\.(insert|update|upsert|delete)\s*\(/gs;
  const entries = [];

  for (const file of runtimeSourceFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of code.matchAll(dynamicRe)) {
      entries.push(`${rel}|${match[1]}|${match[2]}`);
    }
  }

  return entries.sort();
}

function collectRunMutationCallers() {
  const callRe = /runMutation\s*\(/g;
  const callers = new Map();

  for (const file of runtimeSourceFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel === 'src/lib/entityMutations.js') continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const count = [...code.matchAll(callRe)].length;
    if (count) callers.set(rel, count);
  }

  return callers;
}

describe('mutation semantics inventory', () => {
  it('keeps literal Supabase table mutation operation totals intentional', () => {
    const {byOperation, total} = collectLiteralTableMutations();
    const expected = expectedLiteralMutationTotals();
    const {unexpected, missing, wrongCounts} = diffMap(expected, byOperation);

    expect(total).toBe([...expected.values()].reduce((sum, count) => sum + count, 0));
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps literal Supabase table mutation owners intentional', () => {
    const {byOwnerOperation} = collectLiteralTableMutations();
    const {unexpected, missing, wrongCounts} = diffMap(expectedOwnerOperationCounts(), byOwnerOperation);

    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps literal Supabase mutation target tables intentional', () => {
    const {byTableOperation} = collectLiteralTableMutations();
    const {unexpected, missing, wrongCounts} = diffMap(expectedTableOperationCounts(), byTableOperation);

    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps dynamic table mutation sites explicit and reviewed', () => {
    expect(collectDynamicTableMutations()).toEqual(EXPECTED_DYNAMIC_MUTATIONS);
  });

  it('keeps current runMutation adoption visible while future SECDEF lanes reduce direct mutations', () => {
    const callers = collectRunMutationCallers();
    const {unexpected, missing, wrongCounts} = diffMap(EXPECTED_RUN_MUTATION_CALLERS, callers);

    expect([...callers.values()].reduce((sum, count) => sum + count, 0)).toBe(46);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_LITERAL_MUTATION_TOTALS = new Map([
  ['delete', 30],
  ['insert', 65],
  ['update', 94],
  ['upsert', 43],
]);

const EXPECTED_OWNER_OPERATION_COUNTS = new Map([
  ['src/admin/EquipmentMaterialsEditor.jsx|delete', 2],
  ['src/admin/EquipmentMaterialsEditor.jsx|insert', 1],
  ['src/admin/EquipmentMaterialsEditor.jsx|update', 1],
  ['src/admin/EquipmentWebformsAdmin.jsx|update', 10],
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
  ['src/broiler/BroilerDailysView.jsx|update', 1],
  ['src/broiler/PoultryDailyPage.jsx|update', 1],
  ['src/cattle/CattleAnimalPage.jsx|delete', 1],
  ['src/cattle/CattleAnimalPage.jsx|insert', 1],
  ['src/cattle/CattleAnimalPage.jsx|update', 1],
  ['src/cattle/CattleBatchPage.jsx|delete', 1],
  ['src/cattle/CattleBatchPage.jsx|update', 3],
  ['src/cattle/CattleBatchesView.jsx|insert', 1],
  ['src/cattle/CattleBreedingView.jsx|delete', 1],
  ['src/cattle/CattleBreedingView.jsx|insert', 1],
  ['src/cattle/CattleBreedingView.jsx|update', 1],
  ['src/cattle/CattleBulkImport.jsx|insert', 7],
  ['src/cattle/CattleDailyPage.jsx|update', 1],
  ['src/cattle/CattleDailysView.jsx|update', 1],
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
  ['src/layer/EggDailyPage.jsx|update', 1],
  ['src/layer/EggDailysView.jsx|insert', 1],
  ['src/layer/EggDailysView.jsx|update', 1],
  ['src/layer/LayerBatchPage.jsx|delete', 2],
  ['src/layer/LayerBatchPage.jsx|upsert', 2],
  ['src/layer/LayerBatchesView.jsx|upsert', 1],
  ['src/layer/LayerDailyPage.jsx|update', 1],
  ['src/layer/LayerDailysView.jsx|insert', 1],
  ['src/layer/LayerDailysView.jsx|update', 1],
  ['src/layer/LayerHousingPage.jsx|upsert', 2],
  ['src/lib/broiler.js|upsert', 2],
  ['src/lib/cattleForecastApi.js|delete', 2],
  ['src/lib/cattleForecastApi.js|insert', 2],
  ['src/lib/cattleForecastApi.js|update', 2],
  ['src/lib/cattleForecastApi.js|upsert', 1],
  ['src/lib/cattleProcessingBatch.js|insert', 3],
  ['src/lib/cattleProcessingBatch.js|update', 7],
  ['src/lib/layerHousing.js|update', 1],
  ['src/lib/notificationsApi.js|update', 2],
  ['src/lib/sheepProcessingBatch.js|insert', 3],
  ['src/lib/sheepProcessingBatch.js|update', 6],
  ['src/lib/tasksAdminApi.js|delete', 1],
  ['src/lib/tasksAdminApi.js|insert', 1],
  ['src/lib/tasksAdminApi.js|upsert', 2],
  ['src/lib/tasksCenterMutationsApi.js|delete', 1],
  ['src/lib/tasksCenterMutationsApi.js|update', 2],
  ['src/lib/tasksCenterMutationsApi.js|upsert', 1],
  ['src/lib/teamAvailability.js|upsert', 1],
  ['src/lib/teamMembers.js|upsert', 2],
  ['src/livestock/WeighInSessionPage.jsx|delete', 3],
  ['src/livestock/WeighInSessionPage.jsx|insert', 3],
  ['src/livestock/WeighInSessionPage.jsx|update', 13],
  ['src/livestock/WeighInSessionPage.jsx|upsert', 6],
  ['src/main.jsx|update', 1],
  ['src/main.jsx|upsert', 14],
  ['src/pig/PigBatchesView.jsx|upsert', 1],
  ['src/pig/PigDailyPage.jsx|update', 1],
  ['src/pig/PigDailysView.jsx|insert', 1],
  ['src/pig/PigDailysView.jsx|update', 1],
  ['src/pig/usePigMortality.js|upsert', 2],
  ['src/pig/usePigPlannedTrips.js|upsert', 1],
  ['src/shared/AdminAddReportModal.jsx|insert', 6],
  ['src/shared/AdminNewWeighInModal.jsx|insert', 1],
  ['src/sheep/SheepAnimalPage.jsx|delete', 1],
  ['src/sheep/SheepAnimalPage.jsx|insert', 1],
  ['src/sheep/SheepAnimalPage.jsx|update', 1],
  ['src/sheep/SheepBatchPage.jsx|delete', 1],
  ['src/sheep/SheepBatchPage.jsx|update', 4],
  ['src/sheep/SheepBatchesView.jsx|insert', 1],
  ['src/sheep/SheepBulkImport.jsx|insert', 7],
  ['src/sheep/SheepDailyPage.jsx|update', 1],
  ['src/sheep/SheepDailysView.jsx|update', 1],
  ['src/sheep/SheepFlocksView.jsx|insert', 1],
  ['src/sheep/SheepWeighInsView.jsx|insert', 1],
  ['src/webforms/WebformHub.jsx|insert', 4],
  ['src/webforms/WebformsAdminView.jsx|update', 1],
  ['src/webforms/WeighInsWebform.jsx|delete', 5],
  ['src/webforms/WeighInsWebform.jsx|insert', 6],
  ['src/webforms/WeighInsWebform.jsx|update', 8],
]);

const EXPECTED_TABLE_OPERATION_COUNTS = new Map([
  ['app_store|upsert', 17],
  ['cattle_breeding_cycles|delete', 1],
  ['cattle_breeding_cycles|insert', 1],
  ['cattle_breeding_cycles|update', 1],
  ['cattle_breeds|insert', 1],
  ['cattle_calving_records|delete', 2],
  ['cattle_calving_records|insert', 3],
  ['cattle_comments|delete', 2],
  ['cattle_comments|insert', 3],
  ['cattle_comments|update', 1],
  ['cattle_dailys|insert', 1],
  ['cattle_dailys|update', 2],
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
  ['cattle_processing_batches|update', 8],
  ['cattle_transfers|insert', 2],
  ['cattle|insert', 3],
  ['cattle|update', 8],
  ['egg_dailys|insert', 3],
  ['egg_dailys|update', 2],
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
  ['equipment|update', 15],
  ['fuel_bill_lines|insert', 1],
  ['fuel_bills|delete', 2],
  ['fuel_bills|insert', 1],
  ['fuel_supplies|delete', 1],
  ['fuel_supplies|upsert', 1],
  ['layer_batches|delete', 1],
  ['layer_batches|update', 1],
  ['layer_batches|upsert', 2],
  ['layer_dailys|insert', 3],
  ['layer_dailys|update', 2],
  ['layer_housings|delete', 1],
  ['layer_housings|update', 1],
  ['layer_housings|upsert', 3],
  ['notifications|update', 2],
  ['pig_dailys|insert', 3],
  ['pig_dailys|update', 2],
  ['pig_dailys|upsert', 1],
  ['poultry_dailys|insert', 3],
  ['poultry_dailys|update', 2],
  ['profiles|delete', 1],
  ['profiles|update', 4],
  ['sheep_breeds|insert', 1],
  ['sheep_comments|delete', 1],
  ['sheep_comments|insert', 1],
  ['sheep_dailys|insert', 1],
  ['sheep_dailys|update', 2],
  ['sheep_lambing_records|delete', 1],
  ['sheep_lambing_records|insert', 2],
  ['sheep_origins|insert', 1],
  ['sheep_processing_batches|delete', 1],
  ['sheep_processing_batches|insert', 2],
  ['sheep_processing_batches|update', 5],
  ['sheep_transfers|insert', 2],
  ['sheep|insert', 2],
  ['sheep|update', 4],
  ['task_instances|insert', 1],
  ['task_system_rules|update', 1],
  ['task_templates|delete', 2],
  ['task_templates|update', 1],
  ['task_templates|upsert', 2],
  ['webform_config|upsert', 14],
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
  'src/livestock/WeighInSessionPage.jsx|commentsTable|delete',
  'src/livestock/WeighInSessionPage.jsx|swapTable|update',
];

const EXPECTED_RUN_MUTATION_CALLERS = new Map([
  ['src/admin/EquipmentWebformsAdmin.jsx', 9],
  ['src/broiler/PoultryDailyPage.jsx', 1],
  ['src/cattle/CattleAnimalPage.jsx', 1],
  ['src/cattle/CattleDailyPage.jsx', 1],
  ['src/cattle/CattleForecastView.jsx', 1],
  ['src/cattle/CattleHerdsView.jsx', 2],
  ['src/equipment/EquipmentDetail.jsx', 1],
  ['src/layer/EggDailyPage.jsx', 1],
  ['src/layer/LayerDailyPage.jsx', 1],
  ['src/livestock/WeighInSessionPage.jsx', 5],
  ['src/pig/PigDailyPage.jsx', 1],
  ['src/sheep/SheepAnimalPage.jsx', 1],
  ['src/sheep/SheepDailyPage.jsx', 1],
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

function expectedLiteralMutationTotals() {
  const expected = new Map(EXPECTED_LITERAL_MUTATION_TOTALS);
  if (hasTransactionalCalvingDeleteRpc()) expected.set('delete', 28);
  return expected;
}

function expectedOwnerOperationCounts() {
  const expected = new Map(EXPECTED_OWNER_OPERATION_COUNTS);
  if (hasTransactionalCalvingDeleteRpc()) {
    expected.delete('src/cattle/CattleAnimalPage.jsx|delete');
    expected.delete('src/cattle/CattleHerdsView.jsx|delete');
  }
  return expected;
}

function expectedTableOperationCounts() {
  const expected = new Map(EXPECTED_TABLE_OPERATION_COUNTS);
  if (hasTransactionalCalvingDeleteRpc()) expected.delete('cattle_calving_records|delete');
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

    expect([...callers.values()].reduce((sum, count) => sum + count, 0)).toBe(26);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });
});

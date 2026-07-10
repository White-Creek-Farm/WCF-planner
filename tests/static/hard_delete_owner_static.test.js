import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Layer-batch lifecycle RPC (mig 106): LayerBatchPage.handleDeleteBatch routes
// its two raw client deletes (layer_housings child clear + layer_batches root)
// through delete_layer_batch instead, so once the wrapper + migration exist the
// page has no runtime .delete() and neither layer table is a client delete
// target anymore.
function hasLayerBatchDeleteRpc() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/layerBatchDeleteApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/106_delete_layer_batch_rpc.sql'))
  );
}

// Fuel-bill delete RPC (mig 107): FuelBillsView BillDetail.del routes the
// fuel_bills root hard-delete through delete_fuel_bill instead. The
// BillUploadModal rollback delete (a partial-state cleanup of a just-inserted
// bill) stays a direct client delete, so FuelBillsView drops from 2 client
// deletes to 1 and fuel_bills drops from 2 to 1 once the wrapper + migration
// exist.
function hasFuelBillDeleteRpc() {
  return (
    fs.existsSync(path.join(ROOT, 'src/lib/fuelBillDeleteApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/107_delete_fuel_bill_rpc.sql'))
  );
}

// Feed-input delete RPC (mig 108): LivestockFeedInputsPanel.deleteFeedPermanently
// routes the cattle_feed_inputs root hard-delete through delete_feed_input
// instead (tests cascade via the FK). The deleteTest cattle_feed_tests delete
// stays a direct client delete, so LivestockFeedInputsPanel drops from 2 client
// deletes to 1 and cattle_feed_inputs drops from 1 to 0 once the wrapper +
// migration exist.
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

const EXPECTED_DELETE_OWNERS = new Map([
  ['src/admin/EquipmentMaterialsEditor.jsx', 2],
  ['src/admin/FuelBillsView.jsx', 2],
  ['src/admin/FuelLogAdmin.jsx', 1],
  ['src/admin/LivestockFeedInputsPanel.jsx', 2],
  ['src/auth/UsersModal.jsx', 1],
  // CattleAnimalPage + CattleHerdsView no longer hard-delete calving records
  // directly — that moved to the delete_cattle_calving_record SECDEF RPC
  // (migration 079). CattleBreedingView (cattle_breeding_cycles) and
  // SheepAnimalPage (sheep_lambing_records) likewise routed their literal
  // deletes through audited RPCs in commit 235647c, so none of those files
  // has a runtime .delete() anymore.
  // CattleBatchPage.handleUnschedule + SheepBatchPage.handleDeleteBatch no
  // longer direct-delete a processing-batch root — both route through the
  // SECDEF lifecycle RPCs (migration 100), so neither file has a runtime
  // .delete() anymore.
  // EquipmentDetail fueling + maintenance-event deletes moved to the SECDEF
  // equipment-log delete RPCs (migration 102); no runtime client delete remains.
  // LayerBatchPage.handleDeleteBatch (layer_housings child clear + layer_batches
  // root) moved to the SECDEF delete_layer_batch RPC (migration 106); the entry
  // is removed below via the override helper once the wrapper + migration exist.
  ['src/layer/LayerBatchPage.jsx', 2],
  ['src/lib/cattleForecastApi.js', 2],
  // Saved views are user preferences (mig 095), not a soft-delete entity root —
  // direct client delete is owner-scoped by RLS.
  ['src/lib/savedViewsApi.js', 1],
  ['src/lib/tasksAdminApi.js', 1],
  ['src/lib/tasksCenterMutationsApi.js', 1],
  // WeighInSessionPage.deleteEntry (weigh_ins) + deleteSession (weigh_in_sessions)
  // moved to the SECDEF weigh-in delete RPCs (migration 101); only the broiler
  // grid-clear weigh_ins delete remains here.
  ['src/livestock/WeighInSessionPage.jsx', 1],
  ['src/webforms/WeighInsWebform.jsx', 5],
]);

const EXPECTED_DELETE_TABLES = new Map([
  // Saved views (mig 095): owner-scoped direct delete via RLS.
  ['app_saved_views', 1],
  // cattle_breeding_cycles / cattle_calving_records / sheep_lambing_records
  // deletes all moved to audited SECDEF RPCs (mig 079 + commit 235647c); no
  // runtime client delete remains for any of them.
  ['cattle_comments', 2],
  ['cattle_feed_inputs', 1],
  ['cattle_feed_tests', 1],
  ['cattle_forecast_heifer_includes', 1],
  ['cattle_forecast_hidden', 1],
  // cattle_processing_batches + sheep_processing_batches deletes moved to the
  // SECDEF lifecycle RPCs (migration 100); no runtime client delete remains.
  // equipment_fuelings + equipment_maintenance_events deletes moved to the
  // SECDEF equipment-log delete RPCs (migration 102); no runtime client delete
  // remains on either table.
  ['equipment_material_clears', 1],
  ['equipment_service_materials', 1],
  ['fuel_bills', 2],
  ['fuel_supplies', 1],
  // layer_batches + layer_housings client deletes moved to the SECDEF
  // delete_layer_batch RPC (migration 106); both entries are removed below via
  // the override helper once the wrapper + migration exist.
  ['layer_batches', 1],
  ['layer_housings', 1],
  ['profiles', 1],
  ['sheep_comments', 1],
  ['task_templates', 2],
  // weigh_in_sessions delete + one weigh_ins delete moved to the SECDEF weigh-in
  // delete RPCs (migration 101). No runtime client delete remains on
  // weigh_in_sessions; weigh_ins drops to 3 (broiler grid clear + the two
  // anon-webform deletes left intentionally untouched).
  ['weigh_ins', 3],
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

function collectSupabaseDeletes() {
  const deleteRe = /\.from\(\s*(['"])([^'"]+)\1\s*\)(?:(?!\.from\().){0,220}?\.delete\s*\(/gs;
  const owners = new Map();
  const tables = new Map();
  let total = 0;

  for (const file of runtimeSourceFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of code.matchAll(deleteRe)) {
      owners.set(rel, (owners.get(rel) ?? 0) + 1);
      tables.set(match[2], (tables.get(match[2]) ?? 0) + 1);
      total += 1;
    }
  }

  return {owners, tables, total};
}

function expectedDeleteOwners() {
  const expected = new Map(EXPECTED_DELETE_OWNERS);
  // mig 106: LayerBatchPage routes its two deletes through delete_layer_batch,
  // so it has no runtime client delete anymore.
  if (hasLayerBatchDeleteRpc()) expected.delete('src/layer/LayerBatchPage.jsx');
  // mig 107: FuelBillsView routes the bill-root delete through delete_fuel_bill;
  // only the BillUploadModal rollback delete remains (2 -> 1).
  if (hasFuelBillDeleteRpc()) expected.set('src/admin/FuelBillsView.jsx', 1);
  // mig 108: LivestockFeedInputsPanel routes the feed-input root delete through
  // delete_feed_input; only the deleteTest cattle_feed_tests delete remains
  // (2 -> 1).
  if (hasFeedInputDeleteRpc()) expected.set('src/admin/LivestockFeedInputsPanel.jsx', 1);
  // mig 171: UsersModal no longer deletes profiles after the Auth API call;
  // auth.users owns the profile cascade and its database trigger audit.
  if (hasAuditedUserManagementRpcs()) expected.delete('src/auth/UsersModal.jsx');
  return expected;
}

function expectedDeleteTables() {
  const expected = new Map(EXPECTED_DELETE_TABLES);
  // mig 106: no runtime client delete remains on either layer table.
  if (hasLayerBatchDeleteRpc()) {
    expected.delete('layer_batches');
    expected.delete('layer_housings');
  }
  // mig 107: the bill-root delete moves to the RPC; the BillUploadModal rollback
  // delete remains, so fuel_bills drops 2 -> 1.
  if (hasFuelBillDeleteRpc()) expected.set('fuel_bills', 1);
  // mig 108: the feed-input root delete moves to the RPC; no runtime client
  // delete remains on cattle_feed_inputs (the cattle_feed_tests delete stays).
  if (hasFeedInputDeleteRpc()) expected.delete('cattle_feed_inputs');
  if (hasAuditedUserManagementRpcs()) expected.delete('profiles');
  return expected;
}

function expectedDeleteTotal() {
  // 21 before mig 106; LayerBatchPage's two deletes drop out once mig 106 lands
  // (19), FuelBillsView's bill-root delete drops out once mig 107 lands (18),
  // and LivestockFeedInputsPanel's feed-input root delete drops out once mig 108
  // lands (17).
  let total = 21;
  if (hasLayerBatchDeleteRpc()) total -= 2;
  if (hasFuelBillDeleteRpc()) total -= 1;
  if (hasFeedInputDeleteRpc()) total -= 1;
  // UsersModal's redundant profiles.delete moved behind the Auth cascade.
  if (hasAuditedUserManagementRpcs()) total -= 1;
  return total;
}

function diffMap(expected, actual) {
  const unexpected = [...actual.keys()].filter((key) => !expected.has(key));
  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const wrongCounts = [...expected.entries()]
    .filter(([key, count]) => actual.get(key) !== count)
    .map(([key, count]) => `${key}: expected ${count}, saw ${actual.get(key) ?? 0}`);
  return {unexpected, missing, wrongCounts};
}

describe('Supabase hard-delete owner boundary', () => {
  it('keeps runtime table deletes in known owner modules', () => {
    const {owners, total} = collectSupabaseDeletes();
    const {unexpected, missing, wrongCounts} = diffMap(expectedDeleteOwners(), owners);

    expect(total).toBe(expectedDeleteTotal());
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps runtime table-delete targets in the known table set', () => {
    const {tables} = collectSupabaseDeletes();
    const {unexpected, missing, wrongCounts} = diffMap(expectedDeleteTables(), tables);

    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('does not reintroduce hard deletes for soft-delete protected animal/daily roots', () => {
    const forbiddenTables = [
      'cattle',
      'cattle_dailys',
      'egg_dailys',
      'layer_dailys',
      'pig_dailys',
      'poultry_dailys',
      'sheep',
      'sheep_dailys',
    ];
    const {tables} = collectSupabaseDeletes();
    const offenders = forbiddenTables.filter((table) => tables.has(table));

    expect(offenders).toEqual([]);
  });
});

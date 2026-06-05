import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

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
  ['src/cattle/CattleBatchPage.jsx', 1],
  ['src/equipment/EquipmentDetail.jsx', 2],
  ['src/layer/LayerBatchPage.jsx', 2],
  ['src/lib/cattleForecastApi.js', 2],
  // Saved views are user preferences (mig 095), not a soft-delete entity root —
  // direct client delete is owner-scoped by RLS.
  ['src/lib/savedViewsApi.js', 1],
  ['src/lib/tasksAdminApi.js', 1],
  ['src/lib/tasksCenterMutationsApi.js', 1],
  ['src/livestock/WeighInSessionPage.jsx', 3],
  ['src/sheep/SheepBatchPage.jsx', 1],
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
  ['cattle_processing_batches', 1],
  ['equipment_fuelings', 1],
  ['equipment_maintenance_events', 1],
  ['equipment_material_clears', 1],
  ['equipment_service_materials', 1],
  ['fuel_bills', 2],
  ['fuel_supplies', 1],
  ['layer_batches', 1],
  ['layer_housings', 1],
  ['profiles', 1],
  ['sheep_comments', 1],
  ['sheep_processing_batches', 1],
  ['task_templates', 2],
  ['weigh_in_sessions', 1],
  ['weigh_ins', 4],
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
    const {unexpected, missing, wrongCounts} = diffMap(EXPECTED_DELETE_OWNERS, owners);

    expect(total).toBe(27);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps runtime table-delete targets in the known table set', () => {
    const {tables} = collectSupabaseDeletes();
    const {unexpected, missing, wrongCounts} = diffMap(EXPECTED_DELETE_TABLES, tables);

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

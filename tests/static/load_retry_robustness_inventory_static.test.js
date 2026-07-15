import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_READY_MARKERS = new Map([
  ['src/activity/ActivityLogView.jsx', ['data-activity-log-loaded']],
  ['src/admin/ClientErrorsView.jsx', ['data-client-errors-loaded']],
  ['src/admin/RecentlyDeletedDailyReports.jsx', ['data-recently-deleted-dailys-loaded']],
  ['src/broiler/BroilerBatchPage.jsx', ['data-broiler-batch-record-loaded']],
  ['src/broiler/BroilerDailysView.jsx', ['data-broiler-dailys-loaded']],
  ['src/broiler/BroilerListView.jsx', ['data-broiler-batches-loaded']],
  ['src/broiler/PoultryDailyPage.jsx', ['data-poultry-daily-record-loaded']],
  ['src/cattle/CattleBatchPage.jsx', ['data-cattle-batch-record-loaded']],
  ['src/cattle/CattleBatchesView.jsx', ['data-cattle-batches-loaded']],
  ['src/cattle/CattleDailyPage.jsx', ['data-cattle-daily-record-loaded']],
  ['src/cattle/CattleDailysView.jsx', ['data-cattle-dailys-loaded']],
  ['src/cattle/CattleHerdsView.jsx', ['data-cattle-herds-loaded']],
  ['src/cattle/CattleHomeView.jsx', ['data-cattle-home-loaded']],
  ['src/cattle/CattleLogPage.jsx', ['data-cattle-log-loaded']],
  ['src/cattle/CattleWeighInsView.jsx', ['data-weighin-list-loaded']],
  ['src/dashboard/AnimalHistoryPage.jsx', ['data-animal-history-loaded']],
  ['src/dashboard/ProductionPage.jsx', ['data-production-loaded']],
  ['src/equipment/EquipmentChecklistEntryPage.jsx', ['data-equipment-checklist-record-loaded']],
  ['src/equipment/EquipmentDetail.jsx', ['data-equipment-record-loaded']],
  ['src/equipment/EquipmentFleetView.jsx', ['data-equipment-fleet-loaded']],
  ['src/equipment/EquipmentFuelingEntryPage.jsx', ['data-equipment-fueling-record-loaded']],
  ['src/equipment/EquipmentHome.jsx', ['data-equipment-home-loaded']],
  ['src/layer/EggDailyPage.jsx', ['data-egg-daily-record-loaded']],
  ['src/layer/EggDailysView.jsx', ['data-egg-dailys-loaded']],
  ['src/layer/LayerBatchPage.jsx', ['data-layer-batch-record-loaded']],
  ['src/layer/LayerBatchesView.jsx', ['data-layer-batches-loaded']],
  ['src/layer/LayerDailyPage.jsx', ['data-layer-daily-record-loaded']],
  ['src/layer/LayerDailysView.jsx', ['data-layer-dailys-loaded']],
  ['src/layer/LayerHousingPage.jsx', ['data-layer-housing-record-loaded']],
  ['src/livestock/LivestockWeighInsView.jsx', ['data-weighin-list-loaded']],
  ['src/livestock/WeighInSessionPage.jsx', ['data-weighin-session-record-loaded']],
  ['src/pig/PigBatchPage.jsx', ['data-pig-batch-record-loaded']],
  ['src/pig/PigBatchesView.jsx', ['data-pig-feeders-loaded']],
  ['src/pig/PigDailyPage.jsx', ['data-pig-daily-record-loaded']],
  ['src/pig/PigDailysView.jsx', ['data-pig-dailys-loaded']],
  ['src/pig/SowsView.jsx', ['data-breeding-pig-record-loaded']],
  ['src/processing/ProcessingCalendarView.jsx', ['data-processing-loaded']],
  ['src/shared/Header.jsx', ['data-notifications-panel-loaded']],
  ['src/sheep/SheepBatchPage.jsx', ['data-sheep-batch-record-loaded']],
  ['src/sheep/SheepBatchesView.jsx', ['data-sheep-batches-loaded']],
  ['src/sheep/SheepDailyPage.jsx', ['data-sheep-daily-record-loaded']],
  ['src/sheep/SheepDailysView.jsx', ['data-sheep-dailys-loaded']],
  ['src/sheep/SheepFlocksView.jsx', ['data-sheep-flocks-loaded']],
  ['src/sheep/SheepHomeView.jsx', ['data-sheep-home-loaded']],
  ['src/sheep/SheepWeighInsView.jsx', ['data-weighin-list-loaded']],
  ['src/tasks/CompletedTab.jsx', ['data-tasks-completed-loaded']],
  ['src/tasks/MyTasksTab.jsx', ['data-tasks-my-loaded']],
  ['src/tasks/RecurringTab.jsx', ['data-tasks-recurring-loaded']],
  ['src/tasks/SystemTasksTab.jsx', ['data-tasks-system-loaded']],
  ['src/tasks/TaskInstancePage.jsx', ['data-task-instance-record-loaded']],
  ['src/tasks/TodoItemPage.jsx', ['data-todo-record-loaded']],
  ['src/tasks/TodoListTab.jsx', ['data-todo-list-loaded']],
  // Broiler select stage exposes when the webform_config schooner mirror has
  // resolved: startNewSession refuses a broiler start until labels resolve,
  // so tests/deploy checks need this readiness signal instead of racing the
  // second (meta) fetch behind the batch-options fetch.
  ['src/webforms/WeighInsWebform.jsx', ['data-weighins-broiler-meta-loaded']],
]);

const EXPECTED_LOAD_ERROR_SURFACES = new Map([
  ['src/activity/ActivityLogView.jsx', {retry: true, inlineNotice: true}],
  ['src/admin/ClientErrorsView.jsx', {retry: true, inlineNotice: true}],
  ['src/admin/RecentlyDeletedDailyReports.jsx', {retry: true, inlineNotice: true}],
  ['src/broiler/BroilerDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/broiler/PoultryDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleAnimalPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleBatchesView.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleBatchPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleHerdsView.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleHomeView.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleLogPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleWeighInsView.jsx', {retry: true, inlineNotice: true}],
  ['src/dashboard/AnimalHistoryPage.jsx', {retry: true, inlineNotice: true}],
  ['src/dashboard/ProductionPage.jsx', {retry: true, inlineNotice: true}],
  ['src/equipment/EquipmentChecklistEntryPage.jsx', {retry: true, inlineNotice: true}],
  ['src/equipment/EquipmentFuelingEntryPage.jsx', {retry: true, inlineNotice: true}],
  ['src/equipment/EquipmentHome.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/EggDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/EggDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerBatchPage.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerBatchesView.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerHousingPage.jsx', {retry: true, inlineNotice: true}],
  ['src/livestock/LivestockWeighInsView.jsx', {retry: true, inlineNotice: true}],
  // Newsletter admin issue editor: fail-closed load with Retry + InlineNotice.
  ['src/newsletter/NewsletterAdminView.jsx', {retry: true, inlineNotice: true}],
  ['src/pig/PigDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/pig/PigDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/processing/ProcessingCalendarView.jsx', {retry: true, inlineNotice: true}],
  ['src/processing/ProcessingDrawer.jsx', {retry: true, inlineNotice: true}],
  ['src/processing/ProcessingTemplatesModal.jsx', {retry: true, inlineNotice: true}],
  ['src/shared/Header.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepAnimalPage.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepBatchPage.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepBatchesView.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepFlocksView.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepHomeView.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepWeighInsView.jsx', {retry: true, inlineNotice: true}],
  ['src/tasks/CompletedTab.jsx', {retry: true, inlineNotice: false}],
  ['src/tasks/MyTasksTab.jsx', {retry: true, inlineNotice: false}],
  ['src/tasks/RecurringTab.jsx', {retry: true, inlineNotice: false}],
  ['src/tasks/SystemTasksTab.jsx', {retry: true, inlineNotice: false}],
  ['src/tasks/TaskInstancePage.jsx', {retry: true, inlineNotice: true}],
  ['src/tasks/TodoItemPage.jsx', {retry: true, inlineNotice: true}],
  ['src/tasks/TodoListTab.jsx', {retry: true, inlineNotice: true}],
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

function hasClientErrorReviewSurface() {
  return (
    fs.existsSync(path.join(ROOT, 'src/admin/ClientErrorsView.jsx')) &&
    fs.existsSync(path.join(ROOT, 'src/lib/clientErrorsApi.js')) &&
    fs.existsSync(path.join(ROOT, 'supabase-migrations/077_client_error_review_rpc.sql'))
  );
}

function expectedReadyMarkers() {
  const expected = new Map(EXPECTED_READY_MARKERS);
  if (hasClientErrorReviewSurface()) {
    expected.set('src/admin/ClientErrorsView.jsx', ['data-client-errors-loaded']);
  }
  return expected;
}

function expectedLoadErrorSurfaces() {
  const expected = new Map(EXPECTED_LOAD_ERROR_SURFACES);
  if (hasClientErrorReviewSurface()) {
    expected.set('src/admin/ClientErrorsView.jsx', {retry: true, inlineNotice: true});
  }
  return expected;
}

function collectReadyMarkers() {
  const markers = new Map();
  const markerRe = /data-[a-z0-9-]+-loaded/g;

  for (const file of runtimeSourceFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const found = [...new Set([...code.matchAll(markerRe)].map((match) => match[0]))].sort();
    if (found.length) markers.set(rel, found);
  }

  return markers;
}

function collectLoadErrorSurfaces() {
  const out = new Map();

  for (const file of runtimeSourceFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel === 'src/shared/OperationalListEmptyState.jsx') continue;
    // DataTable is a generic primitive that RECEIVES loadError as a prop and
    // renders the shared InlineNotice + Retry on behalf of its host surface.
    // The consuming surfaces carry their own inventoried fail-closed loading;
    // the primitive itself is not a load-bearing surface. (CP0 §A6.)
    if (rel === 'src/shared/DataTable.jsx') continue;

    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (!/\b(loadError|loadFailed|notifLoadError)\b/.test(code)) continue;
    const usesRecordPageLoadError = /\bRecordPageLoadError\b/.test(code);
    out.set(rel, {
      retry: /\bRetry\b|Retry loading more/.test(code) || /<RecordPageLoadError[\s\S]*onRetry=/.test(code),
      inlineNotice: /\bInlineNotice\b/.test(code) || usesRecordPageLoadError,
    });
  }

  return out;
}

function normalizeMap(map) {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

describe('load/retry robustness inventory', () => {
  it('keeps current readiness markers explicit for tests and deploy verification', () => {
    expect(normalizeMap(collectReadyMarkers())).toEqual(normalizeMap(expectedReadyMarkers()));
  });

  it('keeps load-error surfaces and their retry/notice status explicit', () => {
    expect(normalizeMap(collectLoadErrorSurfaces())).toEqual(normalizeMap(expectedLoadErrorSurfaces()));
  });

  it('keeps every loadError surface backed by a Retry action (no remaining gaps)', () => {
    const noRetry = normalizeMap(collectLoadErrorSurfaces())
      .filter(([, meta]) => !meta.retry)
      .map(([rel]) => rel);

    // CattleBatchPage + SheepBatchPage gained Retry in the processing-detach
    // lane; there are no remaining no-retry loadError surfaces.
    expect(noRetry).toEqual([]);
  });

  it('keeps task tab load failures as the only non-InlineNotice load-error surfaces', () => {
    const withoutNotice = normalizeMap(collectLoadErrorSurfaces())
      .filter(([, meta]) => !meta.inlineNotice)
      .map(([rel]) => rel);

    expect(withoutNotice).toEqual([
      'src/tasks/CompletedTab.jsx',
      'src/tasks/MyTasksTab.jsx',
      'src/tasks/RecurringTab.jsx',
      'src/tasks/SystemTasksTab.jsx',
    ]);
  });
});

describe('load/retry fail-closed behavior details', () => {
  // MySubmissions was rebuilt into a no-data "View Past Reports" navigation hub
  // (commit a56e57e); it no longer fetches fuelings/supplies, so there is no
  // stale-data / fail-closed surface to lock here. Edit/delete moved to the
  // daily record pages, which carry their own fail-closed loading.
  const recentlyDeleted = fs.readFileSync(path.join(ROOT, 'src/admin/RecentlyDeletedDailyReports.jsx'), 'utf8');

  it('keeps Recently Deleted Daily Reports from showing partial recovery data after a failed load', () => {
    expect(recentlyDeleted).toContain("data-recently-deleted-dailys-loaded={loading || loadError ? 'false' : 'true'}");
    expect(recentlyDeleted).toContain('data-recently-deleted-dailys-load-error="true"');
    expect(recentlyDeleted).toContain('data-recently-deleted-dailys-retry="1"');
    expect(recentlyDeleted).toMatch(/if \(errors\.length > 0\) \{[\s\S]*?throw new Error\(errors\.join\('\\n'\)\);/);
    expect(recentlyDeleted).toMatch(/catch \(e\) \{[\s\S]*?setRows\(\[\]\);[\s\S]*?setLoadError\(/);
    expect(recentlyDeleted).toContain('!loading && !loadError && rows.length === 0');
    expect(recentlyDeleted).toContain('!loading && !loadError && rows.length > 0');
  });
});

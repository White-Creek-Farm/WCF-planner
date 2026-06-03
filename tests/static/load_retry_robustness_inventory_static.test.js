import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_READY_MARKERS = new Map([
  ['src/activity/ActivityLogView.jsx', ['data-activity-log-loaded']],
  ['src/admin/ClientErrorsView.jsx', ['data-client-errors-loaded']],
  ['src/broiler/BroilerBatchPage.jsx', ['data-broiler-batch-record-loaded']],
  ['src/broiler/BroilerDailysView.jsx', ['data-broiler-dailys-loaded']],
  ['src/broiler/BroilerListView.jsx', ['data-broiler-batches-loaded']],
  ['src/broiler/PoultryDailyPage.jsx', ['data-poultry-daily-record-loaded']],
  ['src/cattle/CattleBatchPage.jsx', ['data-cattle-batch-record-loaded']],
  ['src/cattle/CattleBatchesView.jsx', ['data-cattle-batches-loaded']],
  ['src/cattle/CattleDailyPage.jsx', ['data-cattle-daily-record-loaded']],
  ['src/cattle/CattleDailysView.jsx', ['data-cattle-dailys-loaded']],
  ['src/cattle/CattleHomeView.jsx', ['data-cattle-home-loaded']],
  ['src/cattle/CattleWeighInsView.jsx', ['data-weighin-list-loaded']],
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
  ['src/pig/PigBatchesView.jsx', ['data-pig-feeders-loaded']],
  ['src/pig/PigDailyPage.jsx', ['data-pig-daily-record-loaded']],
  ['src/pig/PigDailysView.jsx', ['data-pig-dailys-loaded']],
  ['src/shared/Header.jsx', ['data-notifications-panel-loaded']],
  ['src/sheep/SheepBatchPage.jsx', ['data-sheep-batch-record-loaded']],
  ['src/sheep/SheepBatchesView.jsx', ['data-sheep-batches-loaded']],
  ['src/sheep/SheepDailyPage.jsx', ['data-sheep-daily-record-loaded']],
  ['src/sheep/SheepDailysView.jsx', ['data-sheep-dailys-loaded']],
  ['src/sheep/SheepHomeView.jsx', ['data-sheep-home-loaded']],
  ['src/sheep/SheepWeighInsView.jsx', ['data-weighin-list-loaded']],
  ['src/tasks/CompletedTab.jsx', ['data-tasks-completed-loaded']],
  ['src/tasks/MyTasksTab.jsx', ['data-tasks-my-loaded']],
  ['src/tasks/RecurringTab.jsx', ['data-tasks-recurring-loaded']],
  ['src/tasks/SystemTasksTab.jsx', ['data-tasks-system-loaded']],
  ['src/tasks/TaskInstancePage.jsx', ['data-task-instance-record-loaded']],
]);

const EXPECTED_LOAD_ERROR_SURFACES = new Map([
  ['src/activity/ActivityLogView.jsx', {retry: true, inlineNotice: true}],
  ['src/admin/ClientErrorsView.jsx', {retry: true, inlineNotice: true}],
  ['src/broiler/BroilerDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/broiler/PoultryDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleAnimalPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleBatchesView.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleBatchPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleHomeView.jsx', {retry: true, inlineNotice: true}],
  ['src/cattle/CattleWeighInsView.jsx', {retry: true, inlineNotice: true}],
  ['src/equipment/EquipmentHome.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/EggDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/EggDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerBatchPage.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerBatchesView.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/layer/LayerHousingPage.jsx', {retry: true, inlineNotice: true}],
  ['src/livestock/LivestockWeighInsView.jsx', {retry: true, inlineNotice: true}],
  ['src/pig/PigDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/pig/PigDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/shared/Header.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepAnimalPage.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepBatchPage.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepBatchesView.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepDailyPage.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepDailysView.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepHomeView.jsx', {retry: true, inlineNotice: true}],
  ['src/sheep/SheepWeighInsView.jsx', {retry: true, inlineNotice: true}],
  ['src/tasks/CompletedTab.jsx', {retry: true, inlineNotice: false}],
  ['src/tasks/MyTasksTab.jsx', {retry: true, inlineNotice: false}],
  ['src/tasks/RecurringTab.jsx', {retry: true, inlineNotice: false}],
  ['src/tasks/SystemTasksTab.jsx', {retry: true, inlineNotice: false}],
  ['src/tasks/TaskInstancePage.jsx', {retry: true, inlineNotice: true}],
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
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (!/\b(loadError|loadFailed|notifLoadError)\b/.test(code)) continue;
    out.set(rel, {
      retry: /\bRetry\b|Retry loading more/.test(code),
      inlineNotice: /\bInlineNotice\b/.test(code),
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

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_SHARED_IMPORT_OWNERS = {
  RecordPageShell: [
    'src/broiler/BroilerBatchPage.jsx',
    'src/broiler/PoultryDailyPage.jsx',
    'src/cattle/CattleAnimalPage.jsx',
    'src/cattle/CattleBatchPage.jsx',
    'src/cattle/CattleDailyPage.jsx',
    'src/layer/EggDailyPage.jsx',
    'src/layer/LayerBatchPage.jsx',
    'src/layer/LayerDailyPage.jsx',
    'src/layer/LayerHousingPage.jsx',
    'src/livestock/WeighInSessionPage.jsx',
    'src/pig/PigDailyPage.jsx',
    'src/sheep/SheepAnimalPage.jsx',
    'src/sheep/SheepBatchPage.jsx',
    'src/sheep/SheepDailyPage.jsx',
    'src/tasks/TaskInstancePage.jsx',
  ],
  RecordCollaborationSection: [
    'src/broiler/BroilerBatchPage.jsx',
    'src/broiler/PoultryDailyPage.jsx',
    'src/cattle/CattleAnimalPage.jsx',
    'src/cattle/CattleBatchPage.jsx',
    'src/cattle/CattleBreedingView.jsx',
    'src/cattle/CattleDailyPage.jsx',
    'src/cattle/CattleForecastView.jsx',
    'src/equipment/EquipmentDetail.jsx',
    'src/layer/EggDailyPage.jsx',
    'src/layer/LayerBatchPage.jsx',
    'src/layer/LayerDailyPage.jsx',
    'src/layer/LayerHousingPage.jsx',
    'src/livestock/WeighInSessionPage.jsx',
    'src/pig/PigBatchPage.jsx',
    'src/pig/PigDailyPage.jsx',
    'src/sheep/SheepAnimalPage.jsx',
    'src/sheep/SheepBatchPage.jsx',
    'src/sheep/SheepDailyPage.jsx',
    'src/tasks/TaskInstancePage.jsx',
  ],
  RecordSequenceNav: [
    'src/broiler/BroilerBatchPage.jsx',
    'src/broiler/PoultryDailyPage.jsx',
    'src/cattle/CattleAnimalPage.jsx',
    'src/cattle/CattleBatchPage.jsx',
    'src/cattle/CattleDailyPage.jsx',
    'src/equipment/EquipmentHome.jsx',
    'src/layer/EggDailyPage.jsx',
    'src/layer/LayerBatchPage.jsx',
    'src/layer/LayerDailyPage.jsx',
    'src/layer/LayerHousingPage.jsx',
    'src/livestock/WeighInSessionPage.jsx',
    'src/pig/PigBatchesView.jsx',
    'src/pig/PigDailyPage.jsx',
    'src/sheep/SheepAnimalPage.jsx',
    'src/sheep/SheepBatchPage.jsx',
    'src/sheep/SheepDailyPage.jsx',
    'src/tasks/TaskInstancePage.jsx',
  ],
  DeleteModal: ['src/admin/NutritionTargetsPanel.jsx', 'src/main.jsx', 'src/webforms/WeighInsWebform.jsx'],
  ConfirmModal: ['src/main.jsx'],
};

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

function collectSharedImportOwners(componentName) {
  const owners = [];
  const importRe = new RegExp(`import[\\s\\S]*?['"][^'"]*shared/${componentName}\\.jsx['"]`);
  const mainImportRe = new RegExp(`import[\\s\\S]*?['"]\\./shared/${componentName}\\.jsx['"]`);

  for (const file of runtimeSourceFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (importRe.test(code) || mainImportRe.test(code)) owners.push(rel);
  }

  return owners.sort();
}

describe('shared UI extraction contract', () => {
  for (const [componentName, expectedOwners] of Object.entries(EXPECTED_SHARED_IMPORT_OWNERS)) {
    it(`keeps ${componentName} adoption owners explicit`, () => {
      expect(collectSharedImportOwners(componentName)).toEqual(expectedOwners);
    });
  }

  it('keeps CommentsSection and RecordActivityLog composed only by RecordCollaborationSection', () => {
    const directOwners = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (
        /import\s+.*(?:CommentsSection|RecordActivityLog).*['"][^'"]*(?:CommentsSection|RecordActivityLog)\.jsx['"]/.test(
          code,
        )
      ) {
        directOwners.push(rel);
      }
    }

    expect(directOwners).toEqual(['src/shared/RecordCollaborationSection.jsx']);
  });

  it('keeps RecordCollaborationSection as a pure composition wrapper', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/shared/RecordCollaborationSection.jsx'), 'utf8'));

    expect(src).toContain('data-record-collaboration-section="1"');
    expect(src).toContain('<CommentsSection');
    expect(src).toContain('<RecordActivityLog');
    expect(src).not.toContain('.from(');
    expect(src).not.toContain('.rpc(');
  });

  it('keeps RecordPageShell presentational and free of data/collaboration concerns', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/shared/RecordPageShell.jsx'), 'utf8'));

    expect(src).toContain('export function RecordPageFrame');
    expect(src).toContain('export function RecordPageBody');
    expect(src).toContain('export function RecordPageLoading');
    expect(src).toContain('export function RecordPageNotFound');
    expect(src).toContain('data-record-title="1"');
    expect(src).not.toContain('.from(');
    expect(src).not.toContain('.rpc(');
    expect(src).not.toContain('CommentsSection');
    expect(src).not.toContain('RecordActivityLog');
  });

  it('keeps app-level confirm modal ownership centralized in main.jsx', () => {
    const main = stripComments(fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8'));

    expect(main).toContain("import DeleteModal from './shared/DeleteModal.jsx'");
    expect(main).toContain("import ConfirmModal from './shared/ConfirmModal.jsx'");
    expect(main).toContain('window._wcfConfirmDelete = confirmDelete');
    expect(main).toContain('window._wcfConfirm = confirmActionPrompt');
  });
});

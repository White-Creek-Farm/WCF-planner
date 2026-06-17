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
    'src/equipment/EquipmentChecklistEntryPage.jsx',
    'src/equipment/EquipmentDetail.jsx',
    'src/equipment/EquipmentFuelingEntryPage.jsx',
    'src/layer/EggDailyPage.jsx',
    'src/layer/LayerBatchPage.jsx',
    'src/layer/LayerDailyPage.jsx',
    'src/layer/LayerHousingPage.jsx',
    'src/livestock/WeighInSessionPage.jsx',
    'src/pig/PigBatchPage.jsx',
    'src/pig/PigBatchesView.jsx',
    'src/pig/PigDailyPage.jsx',
    'src/pig/SowsView.jsx',
    'src/sheep/SheepAnimalPage.jsx',
    'src/sheep/SheepBatchPage.jsx',
    'src/sheep/SheepDailyPage.jsx',
    'src/tasks/TaskInstancePage.jsx',
    // To Do item record page (mig 115).
    'src/tasks/TodoItemPage.jsx',
  ],
  RecordCollaborationSection: [
    'src/broiler/BroilerBatchPage.jsx',
    'src/broiler/PoultryDailyPage.jsx',
    'src/cattle/CattleAnimalPage.jsx',
    'src/cattle/CattleBatchPage.jsx',
    'src/cattle/CattleBreedingView.jsx',
    'src/cattle/CattleDailyPage.jsx',
    'src/cattle/CattleForecastView.jsx',
    'src/equipment/EquipmentChecklistEntryPage.jsx',
    'src/equipment/EquipmentDetail.jsx',
    'src/equipment/EquipmentFuelingEntryPage.jsx',
    'src/layer/EggDailyPage.jsx',
    'src/layer/LayerBatchPage.jsx',
    'src/layer/LayerDailyPage.jsx',
    'src/layer/LayerHousingPage.jsx',
    'src/livestock/WeighInSessionPage.jsx',
    'src/pig/PigBatchPage.jsx',
    'src/pig/PigDailyPage.jsx',
    // SowsView hosts the pig.breeder record surface inline and mounts
    // RecordCollaborationSection (comments + audit) for the selected breeding pig.
    'src/pig/SowsView.jsx',
    'src/sheep/SheepAnimalPage.jsx',
    'src/sheep/SheepBatchPage.jsx',
    'src/sheep/SheepDailyPage.jsx',
    'src/tasks/TaskInstancePage.jsx',
    // To Do item record page (mig 115): comments + audit on todo.item.
    'src/tasks/TodoItemPage.jsx',
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
    'src/pig/PigBatchPage.jsx',
    'src/pig/PigDailyPage.jsx',
    'src/pig/SowsView.jsx',
    'src/sheep/SheepAnimalPage.jsx',
    'src/sheep/SheepBatchPage.jsx',
    'src/sheep/SheepDailyPage.jsx',
    'src/tasks/TaskInstancePage.jsx',
  ],
  DeleteModal: [
    'src/admin/NutritionTargetsPanel.jsx',
    // Cattle Log: management/admin delete of a log entry confirms through the
    // shared DeleteModal before calling delete_cattle_log_entry.
    'src/cattle/CattleLogPage.jsx',
    'src/main.jsx',
    // To Do List (mig 115): management/admin Remove confirms through the
    // shared DeleteModal before calling remove_todo_item.
    'src/tasks/TodoItemPage.jsx',
    'src/tasks/TodoListTab.jsx',
    'src/webforms/WeighInsWebform.jsx',
  ],
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

function readRuntimeSource(rel) {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
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
    const src = readRuntimeSource('src/shared/RecordCollaborationSection.jsx');

    expect(src).toContain('data-record-collaboration-section="1"');
    expect(src).toContain('<CommentsSection');
    expect(src).toContain('<RecordActivityLog');
    expect(src).not.toContain('.from(');
    expect(src).not.toContain('.rpc(');
  });

  it('keeps RecordPageShell presentational and free of data/collaboration concerns', () => {
    const src = readRuntimeSource('src/shared/RecordPageShell.jsx');

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
    const main = readRuntimeSource('src/main.jsx');

    expect(main).toContain("import DeleteModal from './shared/DeleteModal.jsx'");
    expect(main).toContain("import ConfirmModal from './shared/ConfirmModal.jsx'");
    expect(main).toContain('window._wcfConfirmDelete = confirmDelete');
    expect(main).toContain('window._wcfConfirm = confirmActionPrompt');
  });

  it('locks shared modal focus trap, Escape cancel, and return-focus behavior', () => {
    const src = readRuntimeSource('src/shared/useModalFocusTrap.js');

    expect(src).toContain('export function useModalFocusTrap');
    expect(src).toContain("initialFocusSelector = '[data-modal-initial-focus]'");
    expect(src).toContain('returnFocusRef.current');
    expect(src).toContain("e.key === 'Escape'");
    expect(src).toContain("e.key !== 'Tab'");
    expect(src).toContain('e.shiftKey && active === first');
    expect(src).toContain('!e.shiftKey && active === last');
    expect(src).toContain('target.focus()');
  });

  it('locks DeleteModal typed-confirm behavior, dialog semantics, focus trap, and canonical control tokens', () => {
    const src = readRuntimeSource('src/shared/DeleteModal.jsx');

    expect(src).toContain("import {useModalFocusTrap} from './useModalFocusTrap.js'");
    expect(src).toContain('useModalFocusTrap({onCancel})');
    expect(src).toContain('data-delete-modal="1"');
    expect(src).toContain('data-overlay-dismiss="disabled"');
    expect(src).toContain('data-focus-trap="active"');
    expect(src).toContain('ref={dialogRef}');
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('aria-labelledby="delete-modal-title"');
    expect(src).toContain('aria-describedby="delete-modal-message"');
    expect(src).toContain('tabIndex={-1}');
    expect(src).toContain('onKeyDown={handleDialogKeyDown}');
    expect(src).toContain('aria-label="Type delete to confirm"');
    expect(src).toContain('data-modal-initial-focus="1"');
    expect(src).toContain('zIndex: 11000');
    expect(src).toContain("typed.trim().toLowerCase() === 'delete'");
    expect(src).toContain("e.key === 'Enter' && ready");
    expect(src).toMatch(/Cancel[\s\S]*Delete/);
    expect(src).toContain("padding: '10px 16px'");
    expect(src).not.toMatch(/borderRadius:\s*(?:7|8|12)\b/);
    expect(src).not.toMatch(/window\.(?:alert|confirm|prompt)\s*\(/);
  });

  it('locks ConfirmModal dialog semantics, focus trap, and canonical control tokens', () => {
    const src = readRuntimeSource('src/shared/ConfirmModal.jsx');

    expect(src).toContain("import {useModalFocusTrap} from './useModalFocusTrap.js'");
    expect(src).toContain('useModalFocusTrap({onCancel})');
    expect(src).toContain('data-confirm-modal="1"');
    expect(src).toContain('data-overlay-dismiss="disabled"');
    expect(src).toContain('data-focus-trap="active"');
    expect(src).toContain('ref={dialogRef}');
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('aria-labelledby="confirm-modal-title"');
    expect(src).toContain('aria-describedby="confirm-modal-message"');
    expect(src).toContain('tabIndex={-1}');
    expect(src).toContain('onKeyDown={handleDialogKeyDown}');
    expect(src).toContain("const label = confirmLabel || 'Confirm'");
    expect(src).toContain('autoFocus');
    expect(src).toContain('data-modal-initial-focus="1"');
    expect(src).toMatch(/Cancel[\s\S]*\{label\}/);
    expect(src).toContain('zIndex: 11000');
    expect(src).toContain("padding: '10px 16px'");
    expect(src).not.toMatch(/borderRadius:\s*(?:7|8|12)\b/);
    expect(src).not.toMatch(/window\.(?:alert|confirm|prompt)\s*\(/);
  });
});

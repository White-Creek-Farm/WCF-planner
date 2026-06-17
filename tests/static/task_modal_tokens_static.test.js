import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const taskModalStyles = read('src/tasks/taskModalStyles.js');
const TOKENIZED_TASK_MODALS = [
  'src/tasks/NewTaskModal.jsx',
  'src/tasks/CompleteTaskModal.jsx',
  'src/tasks/EditDueDateModal.jsx',
  'src/tasks/AssignTaskModal.jsx',
  'src/tasks/DeleteTaskModal.jsx',
  'src/tasks/RecurringTemplateModal.jsx',
  'src/tasks/SystemRuleEditModal.jsx',
  'src/tasks/TaskPhotoLightbox.jsx',
];

describe('Lane I CP5 task modal token cleanup', () => {
  it('owns the core task modal visual tokens in taskModalStyles', () => {
    for (const name of [
      'taskModalOverlay',
      'taskModalPanel',
      'taskModalSmallPanel',
      'taskModalSystemRulePanel',
      'taskModalFieldLabel',
      'taskModalInput',
      'taskModalReadOnlyBlock',
      'taskModalPrimaryButton',
      'taskModalDangerButton',
      'taskModalGhostButton',
      'taskModalErrorNotice',
      'taskModalHistoryRow',
      'taskModalSubtleText',
      'taskPhotoLightboxOverlay',
      'taskPhotoLightboxPanel',
      'taskPhotoLightboxButton',
      'taskPhotoLightboxFrame',
    ]) {
      expect(taskModalStyles).toContain(`export const ${name}`);
    }
    expect(taskModalStyles).toContain("padding: '10px 16px'");
    expect(taskModalStyles).toContain("padding: '8px 11px'");
    // CP0 §A3: 10px radius floor (was 6).
    expect(taskModalStyles).toContain('borderRadius: 10');
  });

  for (const rel of TOKENIZED_TASK_MODALS) {
    it(`${rel} consumes taskModalStyles instead of local modal token copies`, () => {
      const src = read(rel);
      expect(src).toContain("from './taskModalStyles.js'");
      for (const oldLocalName of [
        'const OVERLAY = {',
        'const PANEL = {',
        'const FIELD_LABEL = {',
        'const INPUT = {',
        'const BTN_PRIMARY = {',
        'const BTN_GHOST = {',
        'const BTN_DANGER = {',
        'const SUB = {',
        'const BTN = {',
      ]) {
        expect(src).not.toContain(oldLocalName);
      }
      expect(src).not.toContain("padding: '8px 14px'");
      expect(src).not.toContain("padding: '8px 10px'");
      expect(src).not.toContain('borderRadius: 8');
    });
  }
});

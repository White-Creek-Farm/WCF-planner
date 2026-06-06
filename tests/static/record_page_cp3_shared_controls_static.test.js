import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Record Page Visual Consistency CP3 — migrate the task + weigh-in session
// record pages toward the shared record-page foundation WITHOUT changing
// workflow behavior, persistence, photos, or domain math.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('CP3: TaskInstancePage on the shared shell, workflows preserved', () => {
  const src = read('src/tasks/TaskInstancePage.jsx');

  it('uses RecordPageShell + shared record controls', () => {
    expect(src).toContain("from '../shared/RecordPageShell.jsx'");
    expect(src).toContain('RecordPageFrame');
    expect(src).toContain('RecordPageBody');
    expect(src).toContain('RecordPageNotFound');
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    expect(src).toContain('className={recordFieldRowClass}');
    // No regression to the old custom 760 wrapper / bespoke fieldRow consts.
    expect(src).not.toMatch(/const fieldRow = \{/);
  });

  it('keeps the task photo lightbox + photo button', () => {
    expect(src).toContain('TaskPhotoLightbox');
    expect(src).toContain('data-task-photo-open');
    expect(src).toContain('photoPresenceFor');
  });

  it('keeps all task modal workflows + their data-task-* selectors', () => {
    for (const m of ['CompleteTaskModal', 'EditDueDateModal', 'AssignTaskModal', 'DeleteTaskModal']) {
      expect(src).toContain(m);
    }
    for (const sel of [
      'data-task-complete-button',
      'data-task-edit-due-button',
      'data-task-assign-button',
      'data-task-delete-button',
    ]) {
      expect(src).toContain(sel);
    }
    expect(src).toContain('RecordCollaborationSection');
  });
});

describe('CP3: WeighInSessionPage metadata controls, workflows preserved', () => {
  const src = read('src/livestock/WeighInSessionPage.jsx');

  it('adopts shared record controls on the broiler metadata panel', () => {
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    expect(src).toContain('recordControl');
    expect(src).toContain('recordFieldLabel');
    // Broiler metadata keeps week controls and displays the saved Team via
    // the locked signed-in-user primitive.
    expect(src).toContain('data-testid="broiler-meta-panel"');
    expect(src).toContain('LockedTeamMemberField');
    expect(src).not.toContain('data-testid="broiler-meta-team"');
    expect(src).toContain('data-testid="broiler-meta-wk4"');
  });

  it('keeps the existing shell + collaboration + entry selectors', () => {
    expect(src).toContain('RecordPageFrame');
    expect(src).toContain('RecordPageBody');
    expect(src).toContain('RecordCollaborationSection');
    expect(src).toContain('data-weighin-entries');
  });

  it('keeps weigh-in workflow + broiler-average functions intact', () => {
    expect(src).toContain('writeBroilerBatchAvg');
    expect(src).toContain('recomputeBroilerBatchWeekAvg');
    expect(src).toContain('saveBroilerMetadata');
    // Send / transfer workflows untouched.
    expect(src).toContain('PigSendToTripModal');
    expect(src).toContain('reconcilePlannedTripsForSend');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Record Page Visual Consistency CP2: migrate ONLY the contained form surfaces
// of three shell record pages onto src/shared/recordPageControls.jsx, with no
// change to persistence semantics, workflows, math, or the heavy domain panels.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('CP2: contained record-page forms adopt the shared controls', () => {
  it('SheepBatchPage metadata editor uses shared field rows / control / textarea', () => {
    const src = read('src/sheep/SheepBatchPage.jsx');
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    expect(src).toContain('className={recordFieldRowClass}');
    expect(src).toContain('style={recordControl}');
    expect(src).toContain('style={recordTextarea}');
    // Save behavior + data attributes preserved.
    expect(src).toContain('data-sheep-batch-name');
    expect(src).toContain('saveMetaField');
    expect(src).toContain('saveStatus');
    // No regression to the old bespoke cramped meta input/label styles.
    expect(src).not.toMatch(/const inpS = \{/);
    expect(src).not.toMatch(/const lbl = \{/);
  });

  it('LayerHousingPage edit-modal form uses shared controls + responsive rows', () => {
    const src = read('src/layer/LayerHousingPage.jsx');
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    expect(src).toContain('className={recordFieldRowClass}');
    expect(src).toContain('style={recordControl}');
    expect(src).toContain('style={recordTextarea}');
    // Autosave + capacity warning preserved; old S.label cramped labels gone.
    expect(src).toContain('scheduleHousingAutosave');
    expect(src).toContain('Capacity:');
    expect(src).not.toContain('S.label');
  });

  it('CattleBatchPage inline editors use shared control/label styling', () => {
    const src = read('src/cattle/CattleBatchPage.jsx');
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    expect(src).toContain('recordControl');
    expect(src).toContain('recordFieldLabel');
    // Preserved save handlers + data attributes for the two inline editors.
    expect(src).toContain('data-scheduled-batch-date');
    expect(src).toContain('data-rename-input');
    expect(src).toContain('handleSaveRename');
    expect(src).toContain('handleUpdateScheduledDate');
  });

  it('guardrail: heavy domain panels/logic stay out of this lane', () => {
    const cattle = read('src/cattle/CattleBatchPage.jsx');
    const sheep = read('src/sheep/SheepBatchPage.jsx');
    // Weight grid + auto-complete + detach action still present on cattle.
    // (Detach moved to the audited SECDEF RPC wrapper in migration 081.)
    expect(cattle).toContain('data-batch-hanging-weight');
    expect(cattle).toContain('batchHasAllHangingWeights');
    expect(cattle).toContain('detachCattleFromProcessingBatch');
    // Sheep weight-grid detach action still present.
    expect(sheep).toContain('detachSheepFromProcessingBatch');
  });

  it('recordPageControls documents the maxWidth convention', () => {
    const src = read('src/shared/recordPageControls.jsx');
    expect(src).toContain('RECORD_FORM_MAXWIDTH');
    expect(src).toMatch(/maxWidth convention/i);
  });
});

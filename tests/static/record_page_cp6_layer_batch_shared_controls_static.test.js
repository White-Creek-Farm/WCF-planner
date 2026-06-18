import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Record Page Visual Consistency CP6 — LayerBatchPage's two editable form
// surfaces (the + Add Housing helper modal and the Edit Layer Batch modal)
// adopt the shared record-page control styling, becoming single-column +
// mobile-legible, WITHOUT changing layer batch behavior: autosave, flush on
// close, brooder/schooner date math + conflict detection, Retirement Home
// conditionals, read-only feed cost rates, note Activity logging, Add Housing
// shell+navigation, and the hard Delete Batch cascade are all unchanged.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchPage.jsx'), 'utf8');

describe('CP6: LayerBatchPage adopts shared record-page controls', () => {
  it('imports the shared control primitives', () => {
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    for (const name of ['recordFieldRowClass', 'recordFieldLabel', 'recordControl', 'recordTextarea']) {
      expect(src).toContain(name);
    }
  });

  it('styles visible controls with the shared primitives in both modals', () => {
    expect(src).toContain('style={recordControl}');
    expect(src).toContain('style={recordTextarea}');
    expect(src).toContain('<span style={recordFieldLabel}>');
    expect(src).toContain('className={recordFieldRowClass}');
    // The responsive field row must wrap multiple controls, not just one — both
    // the Add Housing modal and the Edit Batch modal migrate.
    const rows = src.match(/className=\{recordFieldRowClass\}/g) || [];
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });

  it('drops the old S.label styling but keeps S for buttons/layout helpers', () => {
    expect(src).not.toContain('S.label');
    // CP0 primary-button re-tint: reconciled `import {S}` -> `import {S, getReadableText}`
    // (getReadableText is now co-imported for the program-tinted + Add Housing / Save buttons).
    // Guard still fails if S is dropped from the styles.js import.
    expect(src).toMatch(/import \{S(,[^}]*)?\} from '\.\.\/lib\/styles\.js'/);
    expect(src).toContain('S.btnDanger');
  });

  it('preserves small meaningful local overrides on shared controls', () => {
    // Compact numeric width for Cost per Bird.
    expect(src).toMatch(/\{\.\.\.recordControl, maxWidth: 160\}/);
    // Read-only brooder Exit Date keeps its muted background (parity tokens).
    expect(src).toMatch(/\{\.\.\.recordControl, background: 'var\(--surface-2\)', color: 'var\(--ink-muted\)'\}/);
  });

  it('keeps the modal scaffolding + indicators + data attributes', () => {
    for (const attr of [
      'data-layer-batch-record-loaded',
      'data-layer-batch-edit',
      'data-layer-batch-form-modal',
      'data-layer-batch-delete',
      'data-layer-batch-add-housing',
      'data-layer-add-housing-modal',
      'data-layer-add-housing-save',
    ]) {
      expect(src).toContain(attr);
    }
    expect(src).toContain('Auto-saves as you type');
    expect(src).toContain("'Saving…'");
    expect(src).toContain("'Unsaved…'");
    expect(src).toContain("'✓ Saved'");
  });

  it('preserves batch autosave (1500ms) + flush-on-close + note Activity logging', () => {
    expect(src).toContain('}, 1500);');
    expect(src).toContain('flushBatchAutosave');
    expect(src).toContain('async function closeBatchForm()');
    expect(src).toContain('recordFieldChange');
  });

  it('preserves brooder/schooner phase math, fields, and conflict detection', () => {
    for (const f of ['brooder_entry_date', 'brooder_exit_date', 'schooner_entry_date', 'schooner_exit_date']) {
      expect(src).toContain(f);
    }
    expect(src).toContain('BROODER_CLEANOUT');
    expect(src).toContain('SCHOONER_CLEANOUT');
    expect(src).toContain('overlaps(');
    // Retirement Home conditional fields still gate the phase rows.
    expect(src).toContain("bForm.name !== 'Retirement Home'");
  });

  it('keeps feed cost rates read-only and sourced from existing fields', () => {
    expect(src).toContain('computeLayerFeedCost');
    expect(src).toContain('FEED COST RATES');
    expect(src).toContain('per_lb_starter_cost');
  });

  it('keeps Add Housing creating a shell + navigating to the housing record page', () => {
    expect(src).toContain('async function saveNewHousing()');
    expect(src).toContain("navigate('/layer/housings/' + id)");
    // setLayerHousings is called with concrete arrays, not function updaters.
    expect(src).toContain('setLayerHousings(nextHousings)');
    expect(src).not.toMatch(/setLayerHousings\(\s*\(/);
  });

  it('routes Delete Batch through the SECDEF RPC (mig 106) and emits no client record.deleted', () => {
    expect(src).toContain('confirmDelete');
    // The page no longer issues client deletes or a client record.deleted event;
    // delete_layer_batch does the cascade + audit server-side in one transaction.
    expect(src).toContain('deleteLayerBatch(sb, batch.id)');
    expect(src).not.toContain('record.deleted');
  });
});

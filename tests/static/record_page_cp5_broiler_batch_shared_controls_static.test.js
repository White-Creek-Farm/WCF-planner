import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Record Page Visual Consistency CP5 — the broiler batch BatchForm adopts the
// shared record-page control styling on its visible inputs/selects/textarea/
// checkboxes, keeping its dense grid/step-card layout and WITHOUT changing
// scheduling, processor math, document upload, autosave, navigation, or modals.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/broiler/BatchForm.jsx'), 'utf8');

describe('CP5: BatchForm adopts shared record-page controls', () => {
  it('imports the shared control primitives', () => {
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    for (const name of ['recordControl', 'recordTextarea', 'recordFieldLabel', 'recordCheckbox']) {
      expect(src).toContain(name);
    }
  });

  it('composes the Broiler record controls from the shared primitives', () => {
    expect(src).toContain('...recordControl');
    expect(src).toContain('...recordTextarea');
    expect(src).toContain('...recordFieldLabel');
    expect(src).toContain('style={broilerControl}');
    expect(src).toContain('style={broilerTextarea}');
    expect(src).toContain('style={recordCheckbox}');
    expect(src).toContain('style={broilerLabel}');
  });

  it('drops the old S.label styling but keeps S for buttons/layout helpers', () => {
    expect(src).not.toContain('S.label');
    // S is still imported + used for existing buttons / field-group helpers.
    // CP0 WI-2d: reconciled exact `import {S}` line -> `S` co-imported from
    // styles.js (sweep added getReadableText for the program-accent chips).
    // Guard still fails if the S import is dropped.
    expect(src).toMatch(/import \{[^}]*\bS\b[^}]*\} from '\.\.\/lib\/styles\.js'/);
    expect(src).toMatch(/S\.(btnPrimary|btnGhost|btnDanger|fieldGroup)/);
  });

  it('stacks redesigned section grids full-width on mobile', () => {
    // SectionCard owns the card-body grid wrapper now; grid bodies still opt
    // into the app's mobile single-column override so selects do not cramp on
    // phones.
    expect(src).toContain("data-mobile-1col={bodyStyle ? '1' : undefined}");
    expect(src).toContain('bodyStyle={broilerGrid2}');
    expect(src).toContain('bodyStyle={broilerGrid3}');
  });

  it('keeps the hidden file input hidden (not record-controlled)', () => {
    expect(src).toContain('type="file"');
    expect(src).toContain("display: 'none'");
  });

  it('preserves embedded mode + record-page close override (prev/next now on shared nav)', () => {
    expect(src).toContain("embedded ? 'transparent'");
    expect(src).toContain('onClose');
    // Prev/Next moved to the shared RecordSequenceNav on the record page.
    expect(src).not.toContain('onNavigatePrev');
    expect(src).not.toContain('onNavigateNext');
  });

  it('preserves the critical broiler workflows + math', () => {
    expect(src).toContain('parseProcessorXlsx');
    expect(src).toContain('docUploading');
    expect(src).toContain('batch-documents');
    expect(src).toContain('calcBroilerStatsFromDailys');
    expect(src).toContain('calcTimeline');
    expect(src).toContain('setShowLegacy');
    expect(src).toMatch(/Override.*Save Anyway/);
    expect(src).toContain('Auto-saves as you type');
  });
});

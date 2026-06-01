import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Record Page Visual Consistency CP8 — CowDetail + SheepDetail.
//
// These two panels are dense inline auto-save editors, NOT stacked label/value
// forms. The only clean shared-control candidates are the calving / lambing
// sub-forms, which adopt recordFieldRowClass + recordFieldLabel + recordControl
// + recordTextarea + recordCheckbox (single-column, mobile-legible). The dense
// header chip-bar and the compact 120px-grid info panels are INTENTIONALLY left
// on the local editInp styling — forcing the shared single-column controls there
// would reduce density/scannability and make the UI worse. Behavior (onPatch
// autosave, calving/lambing save-delete, comments, lineage, ageLabel) unchanged.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const cow = fs.readFileSync(path.join(ROOT, 'src/cattle/CowDetail.jsx'), 'utf8');
const sheep = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepDetail.jsx'), 'utf8');

const FILES = [
  ['CowDetail', cow],
  ['SheepDetail', sheep],
];

describe('CP8: animal detail sub-forms adopt shared controls', () => {
  for (const [name, src] of FILES) {
    it(`${name} imports the shared control primitives`, () => {
      expect(src).toContain("from '../shared/recordPageControls.jsx'");
      for (const p of [
        'recordFieldRowClass',
        'recordFieldLabel',
        'recordControl',
        'recordTextarea',
        'recordCheckbox',
      ]) {
        expect(src).toContain(p);
      }
    });

    it(`${name} migrates the sub-form to shared rows + controls`, () => {
      expect(src).toContain('className={recordFieldRowClass}');
      expect(src).toContain('<span style={recordFieldLabel}>');
      expect(src).toContain('style={recordControl}');
      expect(src).toContain('style={recordTextarea}');
      expect(src).toContain('style={recordCheckbox}');
    });

    it(`${name} drops the now-unused local inpC/lblC sub-form styles`, () => {
      expect(src).not.toContain('const inpC');
      expect(src).not.toContain('const lblC');
      expect(src).not.toContain('style={inpC}');
      expect(src).not.toContain('style={lblC}');
    });

    it(`${name} leaves the dense header chip-bar + info grids on editInp (intentional exception)`, () => {
      expect(src).toContain('const editInp');
      // chip-bar uppercase mini-labels and the compact 120px info grid stay.
      expect(src).toContain("textTransform: 'uppercase'");
      expect(src).toContain("gridTemplateColumns: '120px 1fr'");
      // controls in those surfaces still use editInp, not recordControl.
      expect(src).toContain('style={editInp}');
    });

    it(`${name} preserves onPatch autosave wiring`, () => {
      expect(src).toContain('onPatch');
      expect(src).toContain('patchOnBlur');
      expect(src).toContain('patchOnChange');
    });
  }

  it('CowDetail preserves calving form save + state handlers', () => {
    expect(cow).toContain('submitCalving');
    expect(cow).toContain('setCalvingForm');
    expect(cow).toContain('showCalvingForm');
    expect(cow).toContain('ageLabel');
  });

  it('SheepDetail preserves lambing form save + state handlers', () => {
    expect(sheep).toContain('submitLambing');
    expect(sheep).toContain('setLambForm');
    expect(sheep).toContain('showLambForm');
    expect(sheep).toContain('ageLabel');
  });
});

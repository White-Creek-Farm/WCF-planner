import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Record Page Visual Consistency — FINAL sweep / static lock (after CP1-CP8 and
// the Daily Group dropdown lane). This test pins the accepted contract so it is
// not silently regressed or re-litigated:
//   1. src/shared/recordPageControls.jsx is the shared control layer and exports
//      the agreed primitives.
//   2. Every migrated record-page surface imports that shared layer.
//   3. The broiler/layer/pig daily record pages expose the group field as a
//      Group dropdown (not free-text, not labeled "Batch").
//   4. Animal-detail dense surfaces (CowDetail/SheepDetail header chip-bar +
//      info grids) stay an INTENTIONAL exception — only the calving/lambing
//      sub-forms were migrated in CP8.
//   5. Real processing "Batch" pages keep the Batch term.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. Shared control contract module ───────────────────────────────────────
describe('shared record-page controls module', () => {
  const src = read('src/shared/recordPageControls.jsx');
  it('exports the agreed primitives', () => {
    for (const sym of [
      'recordFieldRowClass',
      'recordFieldLabel',
      'recordControl',
      'recordTextarea',
      'recordCheckbox',
      'recordFormCard',
      'RECORD_FORM_MAXWIDTH',
    ]) {
      expect(src).toContain(`export const ${sym}`);
    }
    expect(src).toContain('export function TeamMemberSelect');
  });
});

// ── 2. Migrated surfaces import the shared layer ─────────────────────────────
const MIGRATED = [
  'src/broiler/BatchForm.jsx',
  'src/broiler/PoultryDailyPage.jsx',
  'src/cattle/CattleBatchPage.jsx',
  'src/cattle/CattleDailyPage.jsx',
  'src/cattle/CowDetail.jsx',
  'src/equipment/EquipmentDetail.jsx',
  'src/layer/EggDailyPage.jsx',
  'src/layer/LayerBatchPage.jsx',
  'src/layer/LayerDailyPage.jsx',
  'src/layer/LayerHousingPage.jsx',
  'src/livestock/WeighInSessionPage.jsx',
  'src/pig/PigBatchPage.jsx',
  'src/pig/PigDailyPage.jsx',
  'src/sheep/SheepBatchPage.jsx',
  'src/sheep/SheepDailyPage.jsx',
  'src/sheep/SheepDetail.jsx',
  'src/tasks/TaskInstancePage.jsx',
];

describe('migrated record-page surfaces use the shared controls', () => {
  for (const rel of MIGRATED) {
    it(`${rel} imports recordPageControls`, () => {
      expect(read(rel)).toMatch(/from ['"][./]*shared\/recordPageControls\.jsx['"]/);
    });
  }
});

// ── 3. Daily record pages: Group dropdown, never free-text "Batch" ───────────
const DAILY_GROUP_PAGES = [
  ['src/broiler/PoultryDailyPage.jsx', 'buildBroilerGroupOptions'],
  ['src/layer/LayerDailyPage.jsx', 'buildLayerDailyGroupOptions'],
  ['src/pig/PigDailyPage.jsx', 'buildPigGroupOptions'],
];

describe('daily record pages expose a Group dropdown', () => {
  for (const [rel, optionBuilder] of DAILY_GROUP_PAGES) {
    const src = read(rel);
    it(`${rel} labels the group field "Group" not "Batch"`, () => {
      expect(src).toContain("batch_label: 'Group'");
      expect(src).not.toContain("batch_label: 'Batch'");
    });
    it(`${rel} renders the group field as a dropdown fed by ${optionBuilder}`, () => {
      expect(src).toContain(optionBuilder);
      expect(src).toContain('groupOptions');
      // group field is a <select>, not a free-text <input type="text"> bound to batchLabel.
      expect(src).not.toMatch(/type="text"[^>]*value=\{form\.batchLabel\}/s);
    });
  }
});

// ── 4. Intentional exceptions — dense animal detail surfaces ─────────────────
describe('CowDetail/SheepDetail keep dense surfaces as an exception', () => {
  for (const rel of ['src/cattle/CowDetail.jsx', 'src/sheep/SheepDetail.jsx']) {
    const src = read(rel);
    it(`${rel} migrated only the sub-form (recordFieldRowClass present)`, () => {
      expect(src).toContain('recordFieldRowClass');
      expect(src).toContain('recordCheckbox');
    });
    it(`${rel} keeps the dense header chip-bar + info grid on editInp (NOT migrated)`, () => {
      expect(src).toContain('const editInp');
      expect(src).toContain("textTransform: 'uppercase'");
      expect(src).toContain("gridTemplateColumns: '120px 1fr'");
    });
    it(`${rel} dropped the obsolete local inpC/lblC sub-form styles`, () => {
      expect(src).not.toContain('const inpC');
      expect(src).not.toContain('const lblC');
    });
  }
});

// ── 5. Real processing Batch pages keep the Batch term ───────────────────────
describe('real processing batch pages keep "Batch" terminology', () => {
  for (const rel of [
    'src/layer/LayerBatchPage.jsx',
    'src/pig/PigBatchPage.jsx',
    'src/cattle/CattleBatchPage.jsx',
    'src/sheep/SheepBatchPage.jsx',
  ]) {
    it(`${rel} still uses "Batch"`, () => {
      expect(read(rel)).toMatch(/Batch/);
    });
  }
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DAILY_RECORD_PAGES = [
  'src/broiler/PoultryDailyPage.jsx',
  'src/pig/PigDailyPage.jsx',
  'src/layer/LayerDailyPage.jsx',
  'src/layer/EggDailyPage.jsx',
  'src/cattle/CattleDailyPage.jsx',
  'src/sheep/SheepDailyPage.jsx',
];

const SUBMIT_STYLE_WEBFORMS = [
  {rel: 'src/webforms/AddFeedWebform.jsx', handler: 'handleSubmit'},
  {rel: 'src/webforms/EquipmentFuelingWebform.jsx', handler: 'submit'},
  {rel: 'src/webforms/FuelSupplyWebform.jsx', handler: 'handleSubmit'},
  {rel: 'src/webforms/PigDailysWebform.jsx', handler: 'wfSubmit'},
  {rel: 'src/webforms/TasksWebform.jsx', handler: 'handleSubmit'},
  {rel: 'src/webforms/WebformHub.jsx', handler: null},
  {rel: 'src/webforms/WeighInsWebform.jsx', handler: 'saveDraftViaRpc'},
];

describe('Lane D save model - submit-style surfaces use explicit actions', () => {
  for (const rel of DAILY_RECORD_PAGES) {
    it(`${rel} keeps explicit Save via the daily ownership RPC wrapper`, () => {
      const src = read(rel);
      expect(src).toContain('async function handleSave()');
      expect(src).toContain('updateDailyReport');
      expect(src).toMatch(/onClick=\{handleSave\}/);
      expect(src).toContain('RecordTitle');
      expect(src).not.toContain('data-entry-autosave');
    });
  }

  for (const {rel, handler} of SUBMIT_STYLE_WEBFORMS) {
    it(`${rel} exposes an explicit submit/save action and terminal state markers`, () => {
      const src = read(rel);
      expect(src).toContain('data-submit-state');
      expect(src).toContain('Saved on this device');
      if (handler) {
        expect(src).toContain(handler);
      }
      expect(src).not.toContain('data-entry-autosave');
    });
  }
});

describe('Lane D save model - edit-in-place record surfaces use autosave', () => {
  it('weigh-in session entry edits stay autosave instead of per-row save/revert', () => {
    const src = read('src/livestock/WeighInSessionPage.jsx');
    expect(src).toContain('data-entry-autosave');
    expect(src).toContain('buildEntryDraftSave');
    expect(src).toContain('setEntryAutosaveState');
  });

  it('EquipmentDetail keeps queued autosave plus blur/pagehide/visibility flushes', () => {
    const src = read('src/equipment/EquipmentDetail.jsx');
    expect(src).toContain('const pendingFieldSaves = React.useRef({})');
    expect(src).toContain('const pendingFuelingSaves = React.useRef({})');
    expect(src).toContain('function queueFieldSave');
    expect(src).toContain('function queueFuelingSave');
    expect(src).toContain("window.addEventListener('pagehide', flush)");
    expect(src).toContain("document.addEventListener('visibilitychange', flushOnVisibility)");
    expect(src).toContain('onBlur={() => flushFuelingFieldSave');
  });
});

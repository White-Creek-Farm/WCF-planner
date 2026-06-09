import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function buttonBlock(src, dataAttr) {
  const re = new RegExp(`<button(?:(?!<\\/button>)[\\s\\S])*?${dataAttr}="1"(?:(?!<\\/button>)[\\s\\S])*?<\\/button>`);
  const match = src.match(re);
  expect(match).not.toBeNull();
  return match[0];
}

const RETRY_SURFACES = [
  'src/cattle/CattleAnimalPage.jsx',
  'src/sheep/SheepAnimalPage.jsx',
  'src/cattle/CattleBatchPage.jsx',
  'src/sheep/SheepBatchPage.jsx',
  'src/layer/LayerBatchPage.jsx',
  'src/layer/LayerHousingPage.jsx',
  'src/tasks/TaskInstancePage.jsx',
];

describe('Lane E CP3 record-page action buttons', () => {
  it('keeps the shared action button tokens exported from recordPageControls', () => {
    const controls = read('src/shared/recordPageControls.jsx');
    for (const symbol of ['recordSaveButton', 'recordSecondaryButton', 'recordDeleteButton']) {
      expect(controls).toContain(`export const ${symbol}`);
    }
    expect(controls).toContain("padding: '10px 16px'");
    expect(controls).toContain('borderRadius: 6');
  });

  for (const rel of RETRY_SURFACES) {
    it(`${rel} routes load-error Retry through RecordPageLoadError`, () => {
      const src = read(rel);
      expect(src).toContain("from '../shared/RecordPageLoadError.jsx'");
      expect(src).toMatch(/<RecordPageLoadError[\s\S]*notice=\{loadError\}[\s\S]*onRetry=\{loadAll\}/);
    });
  }

  it('RecordPageLoadError owns the shared secondary Retry button chrome', () => {
    const src = read('src/shared/RecordPageLoadError.jsx');
    expect(src).toContain('recordSecondaryButton');
    expect(src).toContain('<InlineNotice notice={notice} />');
    expect(src).toContain('onClick={onRetry}');
    expect(src).toContain('{retryLabel}');
    expect(src).not.toContain("padding: '7px 14px'");
    expect(src).not.toContain('borderRadius: 7');
  });

  it('TaskInstancePage routes its record actions through shared action buttons', () => {
    const src = read('src/tasks/TaskInstancePage.jsx');
    expect(src).toContain('recordSaveButton');
    expect(src).toContain('recordSecondaryButton');
    expect(src).toContain('recordDeleteButton');

    expect(buttonBlock(src, 'data-task-complete-button')).toContain('style={recordSaveButton}');
    expect(buttonBlock(src, 'data-task-edit-due-button')).toContain('style={recordSecondaryButton}');
    expect(buttonBlock(src, 'data-task-assign-button')).toContain('style={recordSecondaryButton}');
    expect(buttonBlock(src, 'data-task-delete-button')).toContain('style={recordDeleteButton}');

    for (const attr of [
      'data-task-complete-button',
      'data-task-edit-due-button',
      'data-task-assign-button',
      'data-task-delete-button',
    ]) {
      const block = buttonBlock(src, attr);
      expect(block).not.toContain('borderRadius: 8');
      expect(block).not.toContain("padding: '6px 14px'");
    }
  });
});

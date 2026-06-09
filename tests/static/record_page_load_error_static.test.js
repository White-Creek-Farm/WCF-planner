import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const loadError = read('src/shared/RecordPageLoadError.jsx');

const ADOPTED_RECORD_PAGES = [
  ['src/tasks/TaskInstancePage.jsx', 'data-task-instance-load-error="true"'],
  ['src/cattle/CattleAnimalPage.jsx', 'data-cattle-animal-load-error="true"'],
  ['src/sheep/SheepAnimalPage.jsx', 'data-sheep-animal-load-error="true"'],
  ['src/cattle/CattleBatchPage.jsx', 'data-cattle-batch-load-error="true"'],
  ['src/sheep/SheepBatchPage.jsx', 'data-sheep-batch-load-error="true"'],
  ['src/layer/LayerBatchPage.jsx', 'data-layer-batch-load-error="true"'],
  ['src/layer/LayerHousingPage.jsx', 'data-layer-housing-load-error="true"'],
];

describe('Lane E CP4 record-page load-error primitive', () => {
  it('composes the shared shell, InlineNotice, and secondary retry button', () => {
    expect(loadError).toContain("from './RecordPageShell.jsx'");
    expect(loadError).toContain("from './InlineNotice.jsx'");
    expect(loadError).toContain('recordSecondaryButton');
    expect(loadError).toContain('<InlineNotice notice={notice} />');
    expect(loadError).toContain('onClick={onRetry}');
    expect(loadError).toContain('{retryLabel}');
    expect(loadError).toContain('...bodyProps');
  });

  for (const [rel, marker] of ADOPTED_RECORD_PAGES) {
    it(`${rel} delegates fail-closed loadError chrome to RecordPageLoadError`, () => {
      const src = read(rel);
      expect(src).toContain("RecordPageLoadError from '../shared/RecordPageLoadError.jsx'");
      expect(src).toContain(marker);
      expect(src).toMatch(/if \(loadError\)[\s\S]*?<RecordPageLoadError[\s\S]*notice=\{loadError\}/);
      expect(src).toMatch(/<RecordPageLoadError[\s\S]*onRetry=\{loadAll\}/);
    });
  }
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const loadError = read('src/shared/RecordPageLoadError.jsx');

const ADOPTED_RECORD_PAGES = [
  ['src/tasks/TaskInstancePage.jsx', 'data-task-instance-load-error="true"', 'loadAll'],
  ['src/cattle/CattleAnimalPage.jsx', 'data-cattle-animal-load-error="true"', 'loadAll'],
  ['src/sheep/SheepAnimalPage.jsx', 'data-sheep-animal-load-error="true"', 'loadAll'],
  ['src/cattle/CattleBatchPage.jsx', 'data-cattle-batch-load-error="true"', 'loadAll'],
  ['src/sheep/SheepBatchPage.jsx', 'data-sheep-batch-load-error="true"', 'loadAll'],
  ['src/layer/LayerBatchPage.jsx', 'data-layer-batch-load-error="true"', 'loadAll'],
  ['src/layer/LayerHousingPage.jsx', 'data-layer-housing-load-error="true"', 'loadAll'],
  ['src/broiler/PoultryDailyPage.jsx', 'data-poultry-daily-load-error="true"', 'loadAll'],
  ['src/layer/LayerDailyPage.jsx', 'data-layer-daily-load-error="true"', 'loadAll'],
  ['src/layer/EggDailyPage.jsx', 'data-egg-daily-load-error="true"', 'loadAll'],
  ['src/pig/PigDailyPage.jsx', 'data-pig-daily-load-error="true"', 'loadAll'],
  ['src/cattle/CattleDailyPage.jsx', 'data-cattle-daily-load-error="true"', 'loadAll'],
  ['src/sheep/SheepDailyPage.jsx', 'data-sheep-daily-load-error="true"', 'loadAll'],
  ['src/equipment/EquipmentFuelingEntryPage.jsx', 'data-equipment-fueling-load-error="true"', 'onRetry'],
  ['src/equipment/EquipmentChecklistEntryPage.jsx', 'data-equipment-checklist-load-error="true"', 'onRetry'],
];

describe('Lane E CP4 record-page load-error primitive', () => {
  it('composes the shared shell, InlineNotice, and secondary retry button', () => {
    expect(loadError).toContain("from './RecordPageShell.jsx'");
    expect(loadError).toContain("from './InlineNotice.jsx'");
    expect(loadError).toContain('recordSecondaryButton');
    expect(loadError).toContain('<InlineNotice notice={notice} />');
    expect(loadError).toContain('onClick={onRetry}');
    expect(loadError).toContain('{retryLabel}');
    expect(loadError).toContain('retryButtonProps = {}');
    expect(loadError).toContain('...restRetryButtonProps');
    expect(loadError).toContain('...bodyProps');
  });

  for (const [rel, marker, retryOwner] of ADOPTED_RECORD_PAGES) {
    it(`${rel} delegates fail-closed loadError chrome to RecordPageLoadError`, () => {
      const src = read(rel);
      expect(src).toContain("RecordPageLoadError from '../shared/RecordPageLoadError.jsx'");
      expect(src).toContain(marker);
      expect(src).toMatch(/if \(loadError\)[\s\S]*?<RecordPageLoadError[\s\S]*notice=\{loadError\}/);
      expect(src).toContain(`onRetry={${retryOwner}}`);
    });
  }

  it('daily record pages preserve the shared Retry hook for existing tests', () => {
    for (const [rel] of ADOPTED_RECORD_PAGES.filter(([page]) => /DailyPage\.jsx$/.test(page))) {
      expect(read(rel)).toContain("retryButtonProps={{'data-daily-record-retry': '1'}}");
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const broilerList = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerListView.jsx'), 'utf8');
const layerBatches = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchesView.jsx'), 'utf8');
const cattleHerds = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
const sheepFlocks = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepFlocksView.jsx'), 'utf8');
const activityPanel = fs.readFileSync(path.join(ROOT, 'src/shared/ActivityPanel.jsx'), 'utf8');

// All operational batch/list surfaces now use dedicated record pages with
// RecordCollaborationSection — none render inline Activity chips/modal. As of
// CP5 that includes PigBatchesView (pig.batch was the last inline holdout).
const pigBatches = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');
// CP11: RecordCollaborationSection mount moved into PigBatchPage.
const pigBatchPage = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchPage.jsx'), 'utf8');

describe('PigBatchesView — retired legacy Activity surfaces (CP5)', () => {
  it('no longer imports or renders ActivityPanel', () => {
    expect(pigBatches).not.toContain('ActivityPanel');
  });
  it('no longer imports or renders ActivityModal', () => {
    expect(pigBatches).not.toContain('ActivityModal');
  });
  it('has no activityTarget state', () => {
    expect(pigBatches).not.toContain('activityTarget');
  });
  it('no longer listens for wcf-entity-deep-link', () => {
    expect(pigBatches).not.toContain('wcf-entity-deep-link');
  });
  it('uses RecordCollaborationSection for pig.batch Comments + Activity', () => {
    expect(pigBatchPage).toContain('RecordCollaborationSection');
    expect(pigBatchPage).toContain('entityType="pig.batch"');
  });
});

describe('LayerBatchesView — retired legacy Activity surfaces', () => {
  it('LayerBatchesView no longer imports or renders ActivityPanel', () => {
    expect(layerBatches).not.toContain('ActivityPanel');
  });
  it('LayerBatchesView no longer imports or renders ActivityModal', () => {
    expect(layerBatches).not.toContain('ActivityModal');
  });
  it('LayerBatchesView has no activityTarget state', () => {
    expect(layerBatches).not.toContain('activityTarget');
  });
  it('LayerBatchesView no longer listens for wcf-entity-deep-link', () => {
    expect(layerBatches).not.toContain('wcf-entity-deep-link');
  });
});

describe('BroilerListView — retired legacy Activity surfaces', () => {
  it('BroilerListView no longer imports or renders ActivityPanel', () => {
    expect(broilerList).not.toContain('ActivityPanel');
  });
  it('BroilerListView no longer imports or renders ActivityModal', () => {
    expect(broilerList).not.toContain('ActivityModal');
  });
  it('BroilerListView has no activityTarget state', () => {
    expect(broilerList).not.toContain('activityTarget');
  });
  it('BroilerListView no longer listens for wcf-entity-deep-link', () => {
    expect(broilerList).not.toContain('wcf-entity-deep-link');
  });
});

describe('no batch/list view retains an inline ActivityPanel surface (CP5)', () => {
  it('pig, broiler, and layer batch views are all free of ActivityPanel', () => {
    expect(pigBatches).not.toContain('ActivityPanel');
    expect(broilerList).not.toContain('ActivityPanel');
    expect(layerBatches).not.toContain('ActivityPanel');
  });
});

describe('No direct activity table access', () => {
  const layerBatchPage = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchPage.jsx'), 'utf8');
  const layerHousingPage = fs.readFileSync(path.join(ROOT, 'src/layer/LayerHousingPage.jsx'), 'utf8');
  const allSrc = [broilerList, layerBatches, cattleHerds, sheepFlocks, layerBatchPage, layerHousingPage];
  it('no view directly queries activity_events or activity_mentions', () => {
    for (const src of allSrc) {
      expect(src).not.toContain("from('activity_events')");
      expect(src).not.toContain("from('activity_mentions')");
    }
  });
});

describe('Cattle + sheep wired in both flat and grouped modes', () => {
  it('CattleHerdsView has cattle.animal chips in both flat and grouped rows', () => {
    const flatIdx = cattleHerds.indexOf('sortedFlat');
    const groupedIdx = cattleHerds.indexOf('herdOpen');
    const flatChip = cattleHerds.indexOf("entityType: 'cattle.animal'");
    const groupedChip = cattleHerds.indexOf("entityType: 'cattle.animal'", flatChip + 1);
    expect(flatChip).toBeGreaterThan(-1);
    expect(groupedChip).toBeGreaterThan(flatChip);
  });
});

describe('ActivityPanel compact click includes entityCtx', () => {
  it('onCompactClick payload includes entityCtx', () => {
    expect(activityPanel).toContain('entityCtx, entityRoute');
  });
});

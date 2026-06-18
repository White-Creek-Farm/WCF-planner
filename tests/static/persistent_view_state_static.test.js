import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('persistent list view state hotfix', () => {
  it('uses same-tab sessionStorage, not permanent localStorage, for scan filters', () => {
    const hook = src('src/lib/usePersistentViewState.js');
    expect(hook).toContain('window.sessionStorage');
    expect(hook).toContain("'wcf:view-state:'");
    expect(hook).not.toContain('localStorage');
  });

  it('writes synchronously inside the setter before navigation can unmount the list', () => {
    const hook = src('src/lib/usePersistentViewState.js');
    expect(hook).toMatch(/const setPersistentValue = React\.useCallback/);
    expect(hook).toMatch(/const valueRef = React\.useRef\(value\)/);
    expect(hook).toMatch(/typeof nextValue === 'function' \? nextValue\(valueRef\.current\) : nextValue/);
    expect(hook).toMatch(
      /valueRef\.current = resolved;[\s\S]*?writeStoredValue\(key, resolved\);[\s\S]*?setValue\(resolved\)/,
    );
    expect(hook).toMatch(/return \[value, setPersistentValue\]/);
  });

  it('persists cattle herd filters, sort, and shown columns', () => {
    const view = src('src/cattle/CattleHerdsView.jsx');
    expect(view).toMatch(/usePersistentViewState\(\s*'cattle\.herds\.columns'/);
    expect(view).toContain("usePersistentViewState('cattle.herds.filters'");
    expect(view).toContain("usePersistentViewState('cattle.herds.sortRules'");
    // The grouped/flat mode is gone — results are always flat.
    expect(view).not.toContain("usePersistentViewState('cattle.herds.viewMode'");
  });

  it('persists sheep flock filters, sort, and shown columns', () => {
    const view = src('src/sheep/SheepFlocksView.jsx');
    expect(view).toMatch(/usePersistentViewState\(\s*'sheep\.flocks\.columns'/);
    expect(view).toContain("usePersistentViewState('sheep.flocks.filters'");
    expect(view).toContain("usePersistentViewState('sheep.flocks.sortRules'");
    expect(view).not.toContain("usePersistentViewState('sheep.flocks.viewMode'");
  });

  it('persists daily-report scan filters that navigate to records', () => {
    const files = [
      ['src/cattle/CattleDailysView.jsx', 'cattle.dailys.herdFilter'],
      ['src/sheep/SheepDailysView.jsx', 'sheep.dailys.flockFilter'],
      ['src/pig/PigDailysView.jsx', 'pig.dailys.batchFilter'],
      ['src/broiler/BroilerDailysView.jsx', 'broiler.dailys.batchFilter'],
      ['src/layer/LayerDailysView.jsx', 'layer.dailys.groupFilter'],
      ['src/layer/EggDailysView.jsx', 'layer.eggs.teamFilter'],
    ];
    for (const [rel, key] of files) {
      const view = src(rel);
      expect(view).toContain("from '../lib/usePersistentViewState.js'");
      expect(view).toContain(key);
    }
  });

  it('persists weigh-in, task, forecast, activity, and fuel-log scan filters', () => {
    const files = [
      ['src/cattle/CattleWeighInsView.jsx', 'cattle.weighins.statusFilter'],
      ['src/sheep/SheepWeighInsView.jsx', 'sheep.weighins.statusFilter'],
      ['src/livestock/LivestockWeighInsView.jsx', '.weighins.statusFilter'],
      ['src/tasks/MyTasksTab.jsx', 'tasks.my.filter'],
      ['src/tasks/CompletedTab.jsx', 'tasks.completed.filter'],
      ['src/cattle/CattleForecastView.jsx', 'cattle.forecast.yearFilter'],
      ['src/activity/ActivityLogView.jsx', 'activity.log.entityFilter'],
      ['src/equipment/EquipmentFuelLogView.jsx', 'equipment.fuelLog.equipmentFilter'],
    ];
    for (const [rel, key] of files) {
      const view = src(rel);
      expect(view).toContain('usePersistentViewState');
      expect(view).toContain(key);
    }
  });
});

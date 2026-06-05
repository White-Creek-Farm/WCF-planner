import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const dashSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');
const alertSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/homeAlerts.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const pigBatchesSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');
// CP11: the sub-batch form + its no-sub-batch setup copy moved to PigBatchPage.
const pigBatchPageSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchPage.jsx'), 'utf8');

describe('HomeDashboard — pig breeding stock missed dailys', () => {
  it('destructures breeders from usePig()', () => {
    expect(dashSrc).toMatch(/\bbreeders\b/);
    expect(dashSrc).toMatch(/usePig\(\)/);
  });

  it('uses the shared missed-daily builder', () => {
    expect(dashSrc).toMatch(/const allMissed = buildMissedDailyReports\(/);
    expect(alertSrc).toMatch(/export function buildMissedDailyReports\b/);
  });

  it('computes hasActiveSows from non-archived Sow/Gilt breeders', () => {
    expect(alertSrc).toContain('hasActiveSows');
    expect(alertSrc).toMatch(/!b\.archived\s*&&\s*\(b\.sex === 'Sow' \|\| b\.sex === 'Gilt'\)/);
  });

  it('computes hasActiveBoars from non-archived Boar breeders', () => {
    expect(alertSrc).toContain('hasActiveBoars');
    expect(alertSrc).toMatch(/!b\.archived\s*&&\s*b\.sex === 'Boar'/);
  });

  it('checks pigCheck for sows label (lowercase match)', () => {
    expect(alertSrc).toContain("pigCheck.has('sows')");
  });

  it('checks pigCheck for boars label (lowercase match)', () => {
    expect(alertSrc).toContain("pigCheck.has('boars')");
  });

  it('uses pig-stock-sows stable key prefix', () => {
    expect(alertSrc).toContain('pig-stock-sows|');
  });

  it('uses pig-stock-boars stable key prefix', () => {
    expect(alertSrc).toContain('pig-stock-boars|');
  });

  it('pushes SOWS missed row with pig icon and Pig type', () => {
    expect(alertSrc).toMatch(/label:\s*'SOWS'/);
    expect(alertSrc).toMatch(/SOWS.*iconKey:\s*ANIMAL_ICON_KEYS\.pig/s);
  });

  it('pushes BOARS missed row with pig icon and Pig type', () => {
    expect(alertSrc).toMatch(/label:\s*'BOARS'/);
    expect(alertSrc).toMatch(/BOARS.*iconKey:\s*ANIMAL_ICON_KEYS\.pig/s);
  });

  it('does not flag SOWS when hasActiveSows is false', () => {
    expect(alertSrc).toMatch(/if\s*\(hasActiveSows\)/);
  });

  it('does not flag BOARS when hasActiveBoars is false', () => {
    expect(alertSrc).toMatch(/if\s*\(hasActiveBoars\)/);
  });

  it('respects missedCleared for sows key', () => {
    expect(alertSrc).toMatch(/pig-stock-sows.*cleared/s);
  });

  it('respects missedCleared for boars key', () => {
    expect(alertSrc).toMatch(/pig-stock-boars.*cleared/s);
  });
});

describe('HomeDashboard — green banner includes breeding stock', () => {
  it('uses hasAnyActivePig for the all-clear condition', () => {
    expect(dashSrc).toContain('hasAnyActivePig');
  });

  it('hasAnyActivePig is driven by active feeder daily targets (no bare parent-group fallback)', () => {
    expect(dashSrc).toMatch(/hasAnyActivePig[\s\S]*?activePigFeederDailyTargets\(feederGroups\)\.length/);
    expect(dashSrc).not.toMatch(/hasAnyActivePig[\s\S]*?feederGroups\.some\(\(g\)\s*=>\s*g\.status === 'active'\)/);
  });

  it('hasAnyActivePig includes non-archived breeders', () => {
    expect(dashSrc).toMatch(/hasAnyActivePig[\s\S]*?breeders.*!b\.archived/);
  });

  it('green banner references hasAnyActivePig not activePigBatches2', () => {
    expect(dashSrc).toMatch(/allMissed\.length === 0[\s\S]*?hasAnyActivePig/);
    expect(dashSrc).not.toMatch(/allMissed\.length === 0[\s\S]*?activePigBatches2/);
  });
});

describe('HomeDashboard — pig feeder missed targets via shared helper (no parent fallback)', () => {
  it('derives feeder missed targets from activePigFeederDailyTargets', () => {
    expect(alertSrc).toContain('activePigFeederDailyTargets(asArray(feederGroups)).forEach');
  });

  it('labels feeder missed rows with the parent batch name from the target', () => {
    expect(alertSrc).toMatch(/type:\s*`Pig · \$\{t\.parentBatchName\}`/);
  });

  it('no longer has the parent-batch fallback branch for subs.length === 0', () => {
    expect(alertSrc).not.toMatch(/subs\.length === 0/);
    expect(alertSrc).not.toMatch(/label:\s*g\.batchName/);
  });
});

describe('main.jsx — pig webform active_groups via shared helper (no parent fallback)', () => {
  it('builds pigGroups from SOWS/BOARS plus activePigFeederDailyTargets names', () => {
    expect(mainSrc).toMatch(
      /pigGroups = \[\s*'SOWS',\s*'BOARS',\s*\.\.\.activePigFeederDailyTargets\(fgs\)\.map\(\(t\) => t\.name\)/,
    );
  });

  it('no longer falls back to the parent batchName when a group has no sub-batches', () => {
    expect(mainSrc).not.toMatch(/\?\s*\[g\.batchName\]/);
  });
});

describe('PigBatchPage — no-sub-batch setup copy', () => {
  it('no longer claims daily reports go directly to the parent batch', () => {
    // The copy must not regress in either the view or the record page.
    expect(pigBatchesSrc).not.toMatch(/daily reports go directly to this batch/);
    expect(pigBatchPageSrc).not.toMatch(/daily reports go directly to this batch/);
  });

  it('tells the operator daily reports start once a sub-batch is added', () => {
    expect(pigBatchPageSrc).toMatch(/daily reports start once you add a sub-batch/);
  });
});

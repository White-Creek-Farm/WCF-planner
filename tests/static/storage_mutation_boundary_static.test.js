import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_REMOVE_OWNERS = new Map([
  ['src/admin/EquipmentWebformsAdmin.jsx', 2],
  ['src/admin/FuelBillsView.jsx', 2],
  ['src/admin/LivestockFeedInputsPanel.jsx', 3],
  ['src/broiler/BatchForm.jsx', 1],
  ['src/equipment/EquipmentMaintenanceModal.jsx', 1],
  ['src/lib/commentAttachments.js', 1],
  ['src/webforms/EquipmentFuelingWebform.jsx', 1],
]);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function listRuntimeSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listRuntimeSourceFiles(full));
      continue;
    }
    if (!entry.isFile() || !/\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

describe('Storage mutation boundary', () => {
  it('does not use Storage API update/move/copy from runtime source', () => {
    const mutatingOverwriteRe = /\.storage\.from\([^)]*\)[\s\S]{0,220}?\.(?:update|move|copy)\s*\(/g;
    const offenders = [];

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (mutatingOverwriteRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps Storage API remove calls in known cleanup owner modules', () => {
    const removeRe = /\.storage\.from\([^)]*\)[\s\S]{0,220}?\.remove\s*\(/g;
    const seen = new Map();
    let removeCount = 0;

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = [...code.matchAll(removeRe)].length;
      if (!count) continue;
      seen.set(rel, count);
      removeCount += count;
    }

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_REMOVE_OWNERS.has(rel));
    const missing = [...EXPECTED_REMOVE_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_REMOVE_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(removeCount).toBe(11);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('never removes append-only daily/task photo bucket objects from runtime source', () => {
    const appendOnlyBucket =
      '(?:DAILY_BUCKET|TASK_PHOTOS_BUCKET|TASK_REQUEST_PHOTOS_BUCKET|[\'"]daily-photos[\'"]|[\'"]task-photos[\'"]|[\'"]task-request-photos[\'"])';
    const appendOnlyRemoveRe = new RegExp(
      `\\.storage\\.from\\(\\s*${appendOnlyBucket}\\s*\\)[\\s\\S]{0,220}?\\.remove\\s*\\(`,
      'g',
    );
    const offenders = [];

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (appendOnlyRemoveRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });
});

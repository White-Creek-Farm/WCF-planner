import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_UPLOAD_OWNERS = new Map([
  ['src/admin/EquipmentWebformsAdmin.jsx', 2],
  ['src/admin/FuelBillsView.jsx', 1],
  ['src/admin/LivestockFeedInputsPanel.jsx', 1],
  ['src/broiler/BatchForm.jsx', 2],
  ['src/equipment/EquipmentMaintenanceModal.jsx', 1],
  ['src/lib/commentAttachments.js', 1],
  ['src/lib/dailyPhotos.js', 2],
  ['src/lib/tasksAdminApi.js', 1],
  ['src/lib/tasksCenterMutationsApi.js', 1],
  ['src/lib/tasksUserApi.js', 1],
  ['src/lib/useOfflineRpcSubmit.js', 1],
  ['src/lib/useOfflineSubmit.js', 1],
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

describe('Storage upload owner boundary', () => {
  it('keeps runtime storage uploads in the known upload-owner modules', () => {
    const uploadRe = /\.upload\s*\(/g;
    const seen = new Map();
    let uploadCount = 0;

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = [...code.matchAll(uploadRe)].length;
      if (!count) continue;
      seen.set(rel, count);
      uploadCount += count;
    }

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_UPLOAD_OWNERS.has(rel));
    const missing = [...EXPECTED_UPLOAD_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_UPLOAD_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(uploadCount).toBe(16);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });
});

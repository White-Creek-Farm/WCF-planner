import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Mig 176 moved the pig planned-trip mutations, weigh-in Send-to-Trip,
// undo-send, and processing-trip edit/delete into transactional SECDEF RPCs:
// WeighInSessionPage lost its two ppp-feeders-v1 upserts (send + undo), while
// usePigPlannedTrips / usePigProcessingTrips each gained ONE read-only
// post-RPC reload of ppp-feeders-v1 (plus usePigProcessingTrips keeps its
// client-owned fcrCached persist via persistFeeders, counted under main.jsx).
const EXPECTED_APP_STORE_OWNERS = new Map([
  ['src/dashboard/HomeDashboard.jsx', 2],
  ['src/lib/broiler.js', 4],
  ['src/lib/productionApi.js', 1],
  ['src/livestock/WeighInSessionPage.jsx', 8],
  ['src/main.jsx', 4],
  ['src/pig/PigBatchesView.jsx', 2],
  ['src/pig/usePigMortality.js', 2],
  ['src/pig/usePigPlannedTrips.js', 3],
  ['src/pig/usePigProcessingTrips.js', 1],
]);

const ALLOWED_APP_STORE_KEYS = new Set([
  'ppp-breeders-v1',
  'ppp-feeders-v1',
  'ppp-pig-global-adg-v1',
  'ppp-pig-planned-trip-locks-v1',
  'ppp-v4',
]);

function stripComments(src) {
  return src.replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
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

function runtimeSourceFiles() {
  return listRuntimeSourceFiles(path.join(ROOT, 'src'));
}

describe('app_store boundary', () => {
  it('keeps runtime app_store access in known owner modules', () => {
    const accessRe = /\.from\(\s*['"]app_store['"]\s*\)/g;
    const seen = new Map();
    let total = 0;

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = [...code.matchAll(accessRe)].length;
      if (!count) continue;
      seen.set(rel, count);
      total += count;
    }

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_APP_STORE_OWNERS.has(rel));
    const missing = [...EXPECTED_APP_STORE_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_APP_STORE_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(total).toBe(27);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps public webforms away from app_store', () => {
    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src/webforms'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      expect(code, rel).not.toMatch(/\.from\(\s*['"]app_store['"]\s*\)/);
    }
  });

  it('keeps literal app_store keys in the known set', () => {
    const keyRe = /\.from\(\s*['"]app_store['"]\s*\)[\s\S]{0,120}?\.eq\(\s*['"]key['"]\s*,\s*(['"])(.*?)\1\s*\)/g;
    const offenders = [];
    const keys = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(keyRe)) {
        keys.push(`${match[2]} @ ${rel}`);
        if (!ALLOWED_APP_STORE_KEYS.has(match[2])) offenders.push(`${match[2]} @ ${rel}`);
      }
    }

    // 8 pre-mig-176 keyed reads + the two post-RPC ppp-feeders-v1 reloads in
    // usePigPlannedTrips / usePigProcessingTrips.
    expect(keys).toHaveLength(10);
    expect(offenders).toEqual([]);
  });
});

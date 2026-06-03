import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_LOCAL_STORAGE_OWNERS = new Map([
  ['src/cattle/CattleNewWeighInModal.jsx', 1],
  ['src/contexts/PigContext.jsx', 5],
  ['src/main.jsx', 4],
  ['src/shared/AdminNewWeighInModal.jsx', 1],
  ['src/sheep/SheepNewWeighInModal.jsx', 1],
  ['src/webforms/AddFeedWebform.jsx', 1],
  ['src/webforms/EquipmentFuelingWebform.jsx', 3],
  ['src/webforms/FuelSupplyWebform.jsx', 3],
  ['src/webforms/PigDailysWebform.jsx', 1],
  ['src/webforms/TasksWebform.jsx', 1],
  ['src/webforms/WebformHub.jsx', 6],
  ['src/webforms/WeighInsWebform.jsx', 6],
]);

const ALLOWED_LITERAL_KEYS = new Set([
  'ppp-boars-v1',
  'ppp-breeding-v1',
  'ppp-farrowing-v1',
  'ppp-feeders-v1',
  'ppp-pigs-v1',
  'wcf-test-role-override',
  'wcf_team',
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

describe('localStorage boundary', () => {
  it('keeps localStorage usage in known owners', () => {
    const accessRe = /(?:window\.)?localStorage\s*\./g;
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

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_LOCAL_STORAGE_OWNERS.has(rel));
    const missing = [...EXPECTED_LOCAL_STORAGE_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_LOCAL_STORAGE_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(total).toBe(33);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps literal localStorage keys in the known set and away from secret-like names', () => {
    const literalCallRe = /(?:window\.)?localStorage\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*(['"])(.*?)\1/g;
    const offenders = [];
    const secretLike = [];
    const keys = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(literalCallRe)) {
        keys.push(`${match[2]} @ ${rel}`);
        if (!ALLOWED_LITERAL_KEYS.has(match[2])) offenders.push(`${match[2]} @ ${rel}`);
        if (/(auth|password|secret|service|supabase|token)/i.test(match[2])) secretLike.push(`${match[2]} @ ${rel}`);
      }
    }

    expect(keys).toHaveLength(30);
    expect(offenders).toEqual([]);
    expect(secretLike).toEqual([]);
  });

  it('keeps the only dynamic localStorage key removal scoped to legacy wcf-babel cache cleanup', () => {
    const main = stripComments(fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8'));
    expect(main).toMatch(/localStorage\.key\(i\)/);
    expect(main).toMatch(/k\.startsWith\('wcf-babel-'\)[\s\S]*?localStorage\.removeItem\(k\)/);
  });
});

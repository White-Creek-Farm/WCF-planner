import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_PROFILE_OWNERS = new Map([['src/main.jsx', 2]]);

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

describe('profiles table boundary', () => {
  it('keeps direct profiles access read-only in the app boot owner', () => {
    const accessRe = /\.from\(\s*['"]profiles['"]\s*\)/g;
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

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_PROFILE_OWNERS.has(rel));
    const missing = [...EXPECTED_PROFILE_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_PROFILE_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(total).toBe(2);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps public webforms away from profiles', () => {
    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src/webforms'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      expect(code, rel).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
    }
  });

  it('keeps every runtime profile mutation behind RPCs', () => {
    const mutationRe =
      /\.from\(\s*['"]profiles['"]\s*\)(?:(?!\.from\().){0,240}\.(?:insert|upsert|update|delete)\s*\(/gs;
    const offenders = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = [...code.matchAll(mutationRe)].length;
      if (count) offenders.push(`${rel}: ${count}`);
    }

    expect(offenders).toEqual([]);
  });
});

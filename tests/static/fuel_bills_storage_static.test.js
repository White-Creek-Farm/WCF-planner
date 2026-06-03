import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

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

describe('fuel-bills append-only storage contract', () => {
  it('all runtime uploads to fuel-bills use upsert:false', () => {
    const uploadRe = /\.from\(\s*['"]fuel-bills['"]\s*\)\s*\.upload\([\s\S]*?\);/g;
    const offenders = [];
    let uploadCount = 0;

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(uploadRe)) {
        uploadCount += 1;
        const chunk = match[0];
        if (/upsert:\s*true/.test(chunk) || !/upsert:\s*false/.test(chunk)) offenders.push(rel);
      }
    }

    expect(uploadCount).toBe(1);
    expect(offenders).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

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

describe('client error persistence boundary', () => {
  it('keeps client_error_events table writes behind the record_client_error RPC', () => {
    const directTableRe = /\.from\(\s*['"]client_error_events['"]\s*\)/;
    const directInsertRe = /client_error_events[\s\S]{0,160}\b(?:insert|upsert|update|delete)\b/;
    const offenders = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (directTableRe.test(code) || directInsertRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the record_client_error runtime caller in clientErrorReporting only', () => {
    const seen = [];
    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = [...code.matchAll(/record_client_error/g)].length;
      if (count) seen.push(`${rel}: ${count}`);
    }

    expect(seen).toEqual(['src/lib/clientErrorReporting.js: 1']);
  });

  it('keeps clientErrorReporting redacted and free of localStorage/raw payload logging', () => {
    const reporting = fs.readFileSync(path.join(ROOT, 'src/lib/clientErrorReporting.js'), 'utf8');
    expect(reporting).toContain('export function redactString');
    expect(reporting).toContain('buildErrorEvent');
    expect(reporting).toContain("_sb.rpc('record_client_error'");
    expect(reporting).not.toMatch(/localStorage\.getItem/);
    expect(reporting).not.toMatch(/JSON\.stringify\([^)]*(?:body|payload|localStorage)/i);
  });
});

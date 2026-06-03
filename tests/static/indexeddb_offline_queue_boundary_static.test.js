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

describe('IndexedDB / offline queue boundary', () => {
  it('keeps idb/openDB ownership in offlineQueue.js', () => {
    const seenOpenDb = [];
    const seenIdbImport = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const openDbCount = [...code.matchAll(/\bopenDB\b/g)].length;
      const idbImportCount = [...code.matchAll(/from\s+['"]idb['"]/g)].length;
      if (openDbCount) seenOpenDb.push(`${rel}: ${openDbCount}`);
      if (idbImportCount) seenIdbImport.push(`${rel}: ${idbImportCount}`);
    }

    expect(seenOpenDb).toEqual(['src/lib/offlineQueue.js: 2']);
    expect(seenIdbImport).toEqual(['src/lib/offlineQueue.js: 1']);
  });

  it('keeps direct indexedDB global access out of src runtime', () => {
    const offenders = [];
    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (/\bindexedDB\b/.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the queue database/store names stable', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/offlineQueue.js'), 'utf8');
    expect(src).toMatch(/DB_NAME\s*=\s*'wcf-offline-queue'/);
    expect(src).toMatch(/STORE_SUBMISSIONS\s*=\s*'submissions'/);
    expect(src).toMatch(/STORE_PHOTO_BLOBS\s*=\s*'photo_blobs'/);
    expect(src).toMatch(/DB_VERSION\s*=\s*1/);
  });
});

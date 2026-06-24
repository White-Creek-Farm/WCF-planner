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

    // offlineQueue owns the offline-queue DB; pastureImagery is the intentional
    // SECOND idb owner (its own imagery-tile DB, asserted below). Sort so the check
    // is independent of directory-traversal order across platforms.
    expect(seenOpenDb.sort()).toEqual(['src/lib/offlineQueue.js: 2', 'src/lib/pastureImagery.js: 2'].sort());
    expect(seenIdbImport.sort()).toEqual(['src/lib/offlineQueue.js: 1', 'src/lib/pastureImagery.js: 1'].sort());
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

  it('keeps pasture imagery on its OWN idb database, with offlineQueue the only offline-queue owner', () => {
    // The offline-queue DB name is referenced by exactly one runtime source file.
    const queueOwners = [];
    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (code.includes('wcf-offline-queue')) queueOwners.push(rel);
    }
    expect(queueOwners).toEqual(['src/lib/offlineQueue.js']);

    // Pasture imagery uses a SEPARATE database (own name/version/store) so large
    // imagery blobs never touch the version-pinned offline-queue schema.
    const imagery = fs.readFileSync(path.join(ROOT, 'src/lib/pastureImagery.js'), 'utf8');
    expect(imagery).toMatch(/IMAGERY_DB_NAME\s*=\s*'wcf-pasture-imagery'/);
    expect(imagery).toMatch(/IMAGERY_DB_VERSION\s*=\s*1/);
    expect(imagery).toMatch(/createObjectStore\('tiles'\)/);
    expect(imagery).not.toContain('wcf-offline-queue');
  });
});

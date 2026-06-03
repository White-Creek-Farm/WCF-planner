import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const tasksSrc = fs.readFileSync(path.join(ROOT, 'src/lib/tasks.js'), 'utf8');
const tasksUserApiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/tasksUserApi.js'), 'utf8');
const tasksCenterMutationsApiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/tasksCenterMutationsApi.js'), 'utf8');

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

describe('task-photos append-only storage contract', () => {
  it('tasks.js keeps the completion-photo bucket constant stable', () => {
    expect(tasksSrc).toMatch(/export const TASK_PHOTOS_BUCKET\s*=\s*'task-photos'/);
  });

  it('legacy completion upload helper uses TASK_PHOTOS_BUCKET with upsert:false', () => {
    const fn = tasksUserApiSrc.match(/export async function uploadCompletionPhoto\([\s\S]*?\n\}\n/);
    expect(fn, 'expected uploadCompletionPhoto helper').not.toBeNull();
    expect(fn[0]).toMatch(/\.from\(TASK_PHOTOS_BUCKET\)\s*\.upload\([\s\S]*?upsert:\s*false/);
    expect(fn[0]).not.toMatch(/upsert:\s*true/);
    expect(fn[0]).toMatch(/isStorageDuplicateError\(error\)/);
  });

  it('v2 shared photo uploader is append-only and duplicate-as-success', () => {
    const fn = tasksCenterMutationsApiSrc.match(/async function uploadOnePhoto\([\s\S]*?\n\}\n/);
    expect(fn, 'expected uploadOnePhoto helper').not.toBeNull();
    expect(fn[0]).toMatch(/\.from\(bucket\)\s*\.upload\([\s\S]*?upsert:\s*false/);
    expect(fn[0]).not.toMatch(/upsert:\s*true/);
    expect(fn[0]).toMatch(/isStorageDuplicateError\(error\)/);
  });

  it('v2 completion upload helper routes task-photos through the shared uploader', () => {
    const fn = tasksCenterMutationsApiSrc.match(/export async function uploadTaskCompletionPhotos\([\s\S]*?\n\}\n/);
    expect(fn, 'expected uploadTaskCompletionPhotos helper').not.toBeNull();
    expect(fn[0]).toMatch(/uploadOnePhoto\(\s*sb,\s*TASK_PHOTOS_BUCKET,/);
    expect(fn[0]).toMatch(/buildCompletionPhotoStoragePathV2/);
    expect(fn[0]).toMatch(/buildCompletionPhotoDbPathV2/);
  });

  it('all direct runtime uploads to task-photos use upsert:false', () => {
    const uploadRe = /\.from\(\s*(?:TASK_PHOTOS_BUCKET|['"]task-photos['"])\s*\)\s*\.upload\([\s\S]*?\);/g;
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

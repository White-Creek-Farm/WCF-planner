import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const dailyPhotosSrc = fs.readFileSync(path.join(ROOT, 'src/lib/dailyPhotos.js'), 'utf8');

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

describe('daily-photos append-only storage contract', () => {
  it('uploadDailyPhoto uses the daily-photos bucket with upsert:false', () => {
    expect(dailyPhotosSrc).toContain("export const DAILY_BUCKET = 'daily-photos'");

    const fn = dailyPhotosSrc.match(/export async function uploadDailyPhoto\([\s\S]*?\n\}\n/);
    expect(fn, 'expected uploadDailyPhoto helper').not.toBeNull();
    expect(fn[0]).toMatch(/\.from\(DAILY_BUCKET\)[\s\S]*?\.upload\([\s\S]*?\{upsert:\s*false/);
    expect(fn[0]).not.toMatch(/upsert:\s*true/);
  });

  it('runtime direct daily-photos uploads outside dailyPhotos.js stay append-only', () => {
    const uploadRe = /\.from\(\s*(?:DAILY_BUCKET|['"]daily-photos['"])\s*\)[\s\S]{0,500}?\.upload\([\s\S]*?\);/g;
    const offenders = [];
    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (rel === 'src/lib/dailyPhotos.js') continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(uploadRe)) {
        const chunk = match[0];
        if (/upsert:\s*true/.test(chunk) || !/upsert:\s*false/.test(chunk)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime callers never request prepared daily-photo upsert:true', () => {
    const callRe = /\buploadPreparedPhotosSequential\s*\([\s\S]*?\);/g;
    const offenders = [];
    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (rel === 'src/lib/dailyPhotos.js') continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(callRe)) {
        const chunk = match[0];
        if (/upsert:\s*true/.test(chunk) || !/upsert:\s*false/.test(chunk)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PUBLIC_BUCKET = '(?:[\'"]equipment-maintenance-docs[\'"]|[\'"]cattle-feed-pdfs[\'"]|[\'"]batch-documents[\'"])';

const EXPECTED_PUBLIC_URL_OWNERS = new Map([
  ['src/admin/EquipmentWebformsAdmin.jsx', 2],
  ['src/admin/LivestockFeedInputsPanel.jsx', 1],
  ['src/broiler/BatchForm.jsx', 2],
  ['src/equipment/EquipmentMaintenanceModal.jsx', 1],
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

describe('Public storage buckets use public URLs', () => {
  it('does not create signed URLs for public document buckets', () => {
    const signedUrlRe = new RegExp(
      `\\.from\\(\\s*${PUBLIC_BUCKET}\\s*\\)[\\s\\S]{0,180}?\\.createSignedUrl\\s*\\(`,
      'g',
    );
    const offenders = [];

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (signedUrlRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps public URL creation in known owner modules', () => {
    const publicUrlRe = new RegExp(`\\.from\\(\\s*${PUBLIC_BUCKET}\\s*\\)[\\s\\S]{0,180}?\\.getPublicUrl\\s*\\(`, 'g');
    const seen = new Map();
    let publicUrlCount = 0;

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = [...code.matchAll(publicUrlRe)].length;
      if (!count) continue;
      seen.set(rel, count);
      publicUrlCount += count;
    }

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_PUBLIC_URL_OWNERS.has(rel));
    const missing = [...EXPECTED_PUBLIC_URL_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_PUBLIC_URL_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(publicUrlCount).toBe(7);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_IMAGE_INPUT_OWNERS = new Map([
  ['src/equipment/EquipmentMaintenanceModal.jsx', 1],
  ['src/shared/CommentsSection.jsx', 2],
  ['src/tasks/CompleteTaskModal.jsx', 1],
  ['src/tasks/NewTaskModal.jsx', 1],
  ['src/webforms/DailyPhotoCapture.jsx', 1],
  ['src/webforms/EquipmentFuelingWebform.jsx', 1],
  ['src/webforms/TasksWebform.jsx', 1],
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

describe('Image file inputs avoid forced camera capture', () => {
  it('keeps image-capable file inputs in known owner modules and omits capture=', () => {
    const seen = new Map();
    const missingType = [];
    const captureOffenders = [];
    let imageInputCount = 0;

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const imageAcceptMatches = [...code.matchAll(/accept="[^"]*image\/\*[^"]*"/g)];
      if (!imageAcceptMatches.length) continue;

      seen.set(rel, imageAcceptMatches.length);
      imageInputCount += imageAcceptMatches.length;

      for (const match of imageAcceptMatches) {
        const before = code.slice(Math.max(0, match.index - 300), match.index);
        const around = code.slice(Math.max(0, match.index - 300), match.index + 300);
        if (!/type="file"/.test(before)) missingType.push(rel);
        if (/(?<!-)capture=/.test(around)) captureOffenders.push(rel);
      }
    }

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_IMAGE_INPUT_OWNERS.has(rel));
    const missing = [...EXPECTED_IMAGE_INPUT_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_IMAGE_INPUT_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(imageInputCount).toBe(8);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
    expect(missingType).toEqual([]);
    expect(captureOffenders).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_IMG_OWNERS = [
  'src/components/CattleIcon.jsx',
  'src/components/PlannerIcon.jsx',
  'src/equipment/EquipmentDetail.jsx',
  'src/equipment/EquipmentMaintenanceModal.jsx',
  'src/equipment/ManualsCard.jsx',
  'src/shared/CommentsSection.jsx',
  'src/shared/DailyPhotoThumbnails.jsx',
  'src/tasks/TaskPhotoLightbox.jsx',
  'src/webforms/EquipmentFuelingWebform.jsx',
];

const USER_MEDIA_OWNERS = [
  'src/equipment/EquipmentDetail.jsx',
  'src/equipment/EquipmentMaintenanceModal.jsx',
  'src/shared/CommentsSection.jsx',
  'src/shared/DailyPhotoThumbnails.jsx',
  'src/tasks/TaskPhotoLightbox.jsx',
  'src/webforms/EquipmentFuelingWebform.jsx',
];

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

function read(rel) {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function imgBlocks(src) {
  return [...src.matchAll(/<img\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

describe('Lane J image alt-text policy', () => {
  it('keeps runtime image owners explicit', () => {
    const owners = listRuntimeSourceFiles(path.join(ROOT, 'src'))
      .map((file) => path.relative(ROOT, file).replace(/\\/g, '/'))
      .filter((rel) => imgBlocks(read(rel)).length > 0)
      .sort();

    expect(owners).toEqual(EXPECTED_IMG_OWNERS);
  });

  it('requires every runtime image to make an alt-text decision', () => {
    for (const rel of EXPECTED_IMG_OWNERS) {
      for (const block of imgBlocks(read(rel))) {
        expect(block, `${rel} image is missing alt`).toMatch(/\salt=/);
      }
    }
  });

  it('requires decorative empty-alt images to be hidden from assistive tech', () => {
    for (const rel of EXPECTED_IMG_OWNERS) {
      for (const block of imgBlocks(read(rel))) {
        if (/\salt=["']["']/.test(block)) {
          expect(block, `${rel} has decorative alt without aria-hidden`).toMatch(/aria-hidden=["']true["']/);
        }
      }
    }
  });

  it('uses shared contextual fallback text for user-uploaded image media', () => {
    for (const rel of USER_MEDIA_OWNERS) {
      const src = read(rel);
      expect(src).toContain("from '../lib/imageAlt.js'");
      expect(src).toContain('imageAltText(');
      expect(src).not.toMatch(/alt=\{[^}]*\.name(?:\s*\|\|\s*['"]['"])?\}/);
    }
  });
});

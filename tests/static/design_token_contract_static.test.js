import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TOKEN_LOCKED_FILES = [
  'src/lib/styles.js',
  'src/shared/ConfirmModal.jsx',
  'src/shared/DeleteModal.jsx',
  'src/shared/InlineNotice.jsx',
  'src/shared/RecordPageShell.jsx',
  'src/shared/RecordSequenceNav.jsx',
  'src/shared/WcfToggle.jsx',
  'src/shared/WcfYN.jsx',
  'src/shared/recordPageControls.jsx',
  'src/tasks/taskModalStyles.js',
  'src/webforms/LockedSubmitter.jsx',
];

const CANONICAL_FONT_SIZES = new Set([10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 26, 32, 34, 36, 48, 56]);
const CANONICAL_FONT_WEIGHTS = new Set([400, 500, 600, 700]);
const CANONICAL_RADII = new Set([4, 6, 10, 14, 999]);

function numericMatches(src, pattern) {
  return [...src.matchAll(pattern)].map((m) => Number(m[1]));
}

describe('Lane I token contract - shared primitive guard', () => {
  for (const rel of TOKEN_LOCKED_FILES) {
    const src = read(rel);

    it(`${rel} uses the canonical font-size scale`, () => {
      const values = [
        ...numericMatches(src, /fontSize:\s*(\d+(?:\.\d+)?)/g),
        ...numericMatches(src, /font-size:\s*(\d+(?:\.\d+)?)px/g),
      ];
      for (const value of values) {
        expect(CANONICAL_FONT_SIZES.has(value), `${rel} has non-canonical font size ${value}`).toBe(true);
      }
    });

    it(`${rel} uses the canonical font-weight scale`, () => {
      const values = [...numericMatches(src, /fontWeight:\s*(\d+)/g), ...numericMatches(src, /font-weight:\s*(\d+)/g)];
      for (const value of values) {
        expect(CANONICAL_FONT_WEIGHTS.has(value), `${rel} has non-canonical font weight ${value}`).toBe(true);
      }
    });

    it(`${rel} does not use retired 7px or 8px radii`, () => {
      const values = [
        ...numericMatches(src, /borderRadius:\s*(\d+)/g),
        ...numericMatches(src, /border-radius:\s*(\d+)px/g),
      ];
      for (const value of values) {
        expect(CANONICAL_RADII.has(value), `${rel} has non-canonical radius ${value}`).toBe(true);
      }
    });
  }

  it('shared button style tokens use the standard 10px 16px pad and 6px radius', () => {
    const src = read('src/lib/styles.js');
    for (const key of ['navBtn', 'addBtn', 'btnPrimary', 'btnDanger', 'btnGhost']) {
      const start = src.indexOf(`${key}`);
      const block = src.slice(start, start + 260);
      expect(block).toContain("padding: '10px 16px'");
      expect(block).toContain('borderRadius: 6');
    }
  });

  it('ConfirmModal and DeleteModal stay at the top destructive overlay z-index', () => {
    expect(read('src/shared/ConfirmModal.jsx')).toContain('zIndex: 9000');
    expect(read('src/shared/DeleteModal.jsx')).toContain('zIndex: 9000');
  });
});

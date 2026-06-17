import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Radius floor guard (CP0 §A3, Option A) — no sub-10px radius on UI element
// classes (buttons/inputs/chips/badges/cards/tiles/modals/rows/controls).
//
// Canonical radii are 10 / 12 / 14 / 999 / '50%' (and 0 = no rounding). Values
// 1–9 are RETIRED. The one carve-out is genuinely decorative sub-components
// (legend swatches, accent bars/LED strips, progress bars, dividers, inline
// <code> chips, small color dots) — a 10px corner on a 10px-tall swatch turns
// a square into a circle. Those keep their small radius ONLY when the line is
// explicitly tagged with the marker:  radius-allow
//
// Scope: all of src/ EXCEPT the sanctioned .home island (homeRedesign.css keeps
// its 9/12/18 per the ratified Intentional Non-Uniformity).
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const EXEMPT_FILES = new Set([
  'src/dashboard/homeRedesign.css', // ratified island — keeps 9/12/18
]);

const ALLOW_MARKER = 'radius-allow';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(jsx?|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

// inline:  borderRadius: 4    (single digit 1-9, not 10-99, not decimals)
const INLINE_RE = /borderRadius:\s*([1-9])(?![0-9.])/;
// css:     border-radius: 6px  (first value a single 1-9 digit)
const CSS_RE = /border-radius:\s*([1-9])(?![0-9])px/;

function collectViolations() {
  const violations = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (EXEMPT_FILES.has(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes(ALLOW_MARKER)) return; // documented decorative carve-out
      if (INLINE_RE.test(line) || CSS_RE.test(line)) {
        violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }
  return violations;
}

describe('Radius floor (CP0 §A3, Option A)', () => {
  it('has no sub-10px radius on UI elements (decorative bits use the radius-allow marker)', () => {
    const violations = collectViolations();
    expect(violations, `sub-10px radii found (${violations.length}):\n` + violations.join('\n')).toEqual([]);
  });
});

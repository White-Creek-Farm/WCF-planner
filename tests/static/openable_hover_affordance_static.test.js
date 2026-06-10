import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ============================================================================
// Global openable affordance contract (Build Queue: "CC - Global Openable
// Hover Affordance").
//
// Owner: the <style> block shared by the three Vite HTML entries. Contract:
//   .hoverable-tile — openable div-based card/tile/grid row: pointer cursor,
//     hover wash + subtle lift + shadow, :focus-visible ring, :active wash.
//   .hoverable-row  — openable <tr> inside a real <table>: pointer cursor,
//     hover/active wash on its cells (no transform — lifts are unreliable on
//     table rows), :focus-visible ring.
// Hover/focus/active may only change paint (background/box-shadow/outline/
// transform), never box metrics, so pointing at a row never shifts layout.
// ============================================================================

const HTML_ENTRIES = ['index.html', 'dailys.html', 'equipment.html'];

// Extract the affordance block: from the start of the marker comment line to
// the end of the :focus-visible rule line.
function affordanceBlock(rel) {
  const src = read(rel);
  const anchor = src.indexOf('Global openable affordance');
  expect(anchor, `${rel} is missing the openable-affordance block`).toBeGreaterThan(-1);
  const start = src.lastIndexOf('\n', anchor) + 1;
  const endAnchor = src.indexOf(':focus-visible', anchor);
  expect(endAnchor, `${rel} affordance block is missing the :focus-visible rule`).toBeGreaterThan(-1);
  const end = src.indexOf('\n', endAnchor);
  return src.slice(start, end + 1);
}

// Declarations a pointer/keyboard state may set: paint only. Anything outside
// this list (margin/padding/width/border-width/font/position/...) can move
// boxes and would violate the no-layout-shift contract.
const PAINT_ONLY_PROPS = new Set([
  'background',
  'background-color',
  'border-color',
  'box-shadow',
  'outline',
  'outline-offset',
  'transform',
]);

describe('Global openable affordance - HTML entry contract', () => {
  const blocks = Object.fromEntries(HTML_ENTRIES.map((rel) => [rel, affordanceBlock(rel)]));

  it('all three HTML entries carry a byte-identical affordance block', () => {
    expect(blocks['dailys.html']).toBe(blocks['index.html']);
    expect(blocks['equipment.html']).toBe(blocks['index.html']);
  });

  const block = blocks['index.html'];

  it('base classes own the pointer cursor (openable means clickable at rest)', () => {
    expect(block).toContain('.hoverable-tile{cursor:pointer;transition:');
    expect(block).toContain('.hoverable-row{cursor:pointer}');
  });

  it('hover is gated behind (hover:hover): tiles wash + lift + shadow, row cells wash', () => {
    expect(block).toContain('@media (hover:hover){');
    expect(block).toContain(
      '.hoverable-tile:hover{background:#f0fdf4 !important;transform:translateY(-1px);box-shadow:',
    );
    expect(block).toContain('.hoverable-row:hover td{background:#f0fdf4 !important}');
  });

  it('keyboard users get the same affordance via :focus-visible', () => {
    expect(block).toContain(
      '.hoverable-tile:focus-visible,.hoverable-row:focus-visible{outline:2px solid var(--green-500)',
    );
  });

  it('touch/click gets an :active wash (hover wash is unavailable on coarse pointers)', () => {
    expect(block).toContain('.hoverable-tile:active{background:#f0fdf4 !important');
    expect(block).toContain('.hoverable-row:active td{background:#f0fdf4 !important}');
  });

  it('hover/focus/active rules only change paint, never box metrics (no layout shift)', () => {
    const css = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      if (!/:(hover|focus-visible|active)/.test(selector)) continue;
      for (const decl of body.split(';')) {
        if (!decl.trim()) continue;
        const prop = decl.slice(0, decl.indexOf(':')).trim();
        expect(
          PAINT_ONLY_PROPS.has(prop),
          `"${selector.trim()}" sets non-paint property "${prop}" — hover/focus/active must not move boxes`,
        ).toBe(true);
      }
    }
  });
});

// ============================================================================
// Source ownership: .hoverable-row is the <tr> affordance, .hoverable-tile
// the div/card affordance. Transforms glitch on table rows, so a <tr> must
// never carry hoverable-tile (and hoverable-row exists only for <tr>s).
// ============================================================================

function walkJsx(dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsx(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function nearestPrecedingTag(src, index) {
  const head = src.slice(0, index);
  const tags = [...head.matchAll(/<([a-zA-Z][\w.]*)/g)];
  return tags.length ? tags[tags.length - 1][1] : null;
}

describe('Global openable affordance - source ownership', () => {
  const files = walkJsx(path.join(ROOT, 'src'));

  it('.hoverable-tile never sits on a <tr>; .hoverable-row only sits on a <tr>', () => {
    let tileCount = 0;
    let rowCount = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      for (const m of src.matchAll(/className=\{?["'`][^"'`}]*hoverable-(tile|row)/g)) {
        const tag = nearestPrecedingTag(src, m.index);
        if (m[1] === 'tile') {
          tileCount += 1;
          expect(tag, `${rel}: .hoverable-tile on <${tag}> — table rows must use .hoverable-row`).not.toBe('tr');
        } else {
          rowCount += 1;
          expect(tag, `${rel}: .hoverable-row on <${tag}> — non-<tr> openables use .hoverable-tile`).toBe('tr');
        }
      }
    }
    // Both classes must stay in real use so the global CSS keeps an owner.
    expect(tileCount).toBeGreaterThan(0);
    expect(rowCount).toBeGreaterThan(0);
  });
});

// ============================================================================
// Representative keyboard ownership: these surfaces were made focusable +
// Enter/Space-actionable in the affordance lane and must not drift back to
// mouse-only. (Remaining hoverable-tile call sites are documented follow-up.)
// ============================================================================

describe('Global openable affordance - representative keyboard surfaces', () => {
  for (const rel of ['src/shared/WeighInSessionListTile.jsx', 'src/equipment/EquipmentFleetView.jsx']) {
    it(`${rel} keeps button semantics + Enter/Space activation`, () => {
      const src = read(rel);
      expect(src).toMatch(/role(: '|=")button/);
      expect(src).toMatch(/tabIndex(: 0|=\{0\})/);
      expect(src).toContain('onKeyDown');
      expect(src).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
    });
  }
});

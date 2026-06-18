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

  it('hover is gated behind (hover:hover): tiles lift 3px + shadow + border, row cells wash + border emphasis', () => {
    expect(block).toContain('@media (hover:hover){');
    // CP0 WI-6: cards/tiles rise 3px over 300ms with a soft shadow + darker
    // border and NO background wash (the green wash was retired in the parity rollout).
    expect(block).toContain(
      '.hoverable-tile:hover{transform:translateY(-3px);box-shadow:var(--shadow-hover);border-color:var(--border-strong) !important}',
    );
    // Dense rows stay flat (no transform/shadow on <tr>) and raise via the
    // neutral row-hover wash + a stronger cell border on their cells.
    expect(block).toContain(
      '.hoverable-row:hover td{background:var(--row-hover) !important;border-color:var(--border-strong) !important}',
    );
  });

  it('keyboard users get the same affordance via :focus-visible (brand ring + row wash)', () => {
    expect(block).toContain(
      '.hoverable-tile:focus-visible,.hoverable-row:focus-visible{outline:2px solid var(--brand)',
    );
  });

  it('touch/click gets an :active state (tile resets, row cells wash — coarse pointers have no hover)', () => {
    expect(block).toContain('.hoverable-tile:active{transform:none;box-shadow:none}');
    expect(block).toContain('.hoverable-row:active td{background:var(--row-hover) !important}');
  });

  it('respects prefers-reduced-motion by dropping the tile lift transform (all three entries)', () => {
    for (const rel of HTML_ENTRIES) {
      const src = read(rel);
      const idx = src.indexOf('@media (prefers-reduced-motion: reduce){');
      expect(idx, `${rel} is missing the reduced-motion fallback for .hoverable-tile`).toBeGreaterThan(-1);
      expect(src.slice(idx, idx + 220)).toContain('.hoverable-tile:hover{transform:none}');
    }
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
// Keyboard ownership (source-wide rollout lane): every file that renders a
// .hoverable-tile / .hoverable-row openable must wire keyboard activation —
// either the shared helper (src/shared/openable.js openableProps) or the
// locked inline pattern (role="button" + tabIndex={0} + onKeyDown Enter/Space).
// Mouse-only openables must not come back.
// ============================================================================

describe('Global openable affordance - keyboard ownership', () => {
  it('src/shared/openable.js keeps the contract (button role, tabIndex 0, Enter/Space, self-target guard)', () => {
    const src = read('src/shared/openable.js');
    expect(src).toContain("role: 'button'");
    expect(src).toContain('tabIndex: 0');
    expect(src).toContain('onKeyDown');
    expect(src).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
    expect(src).toContain('e.preventDefault()');
    // Enter/Space on a nested control must not also open the parent row/tile.
    expect(src).toContain('e.target !== e.currentTarget');
  });

  it('every hoverable-tile/row file wires openableProps or the inline keyboard pattern', () => {
    const files = walkJsx(path.join(ROOT, 'src'));
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // Both JSX (className="...hoverable-x") and createElement
      // (className: 'hoverable-x') call-site forms count as usage.
      if (!/hoverable-(tile|row)/.test(src)) continue;
      const usesHelper = /openableProps\(/.test(src);
      const inlinePattern =
        /role(: '|=")button/.test(src) &&
        /tabIndex(: 0|=\{0\})/.test(src) &&
        /onKeyDown/.test(src) &&
        (/e\.key === 'Enter' \|\| e\.key === ' '/.test(src) || /e\.key !== 'Enter' && e\.key !== ' '/.test(src));
      if (!usesHelper && !inlinePattern) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders, `mouse-only hoverable openables in: ${offenders.join(', ')}`).toEqual([]);
  });

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

// ============================================================================
// Home affordance slices (approved home design owns its own classes):
//   - HomeWeatherCard collapsed card carries the approved `card weather-card
//     lift` treatment as a real <button> (native keyboard semantics).
//   - homeRedesign.css gives openable .litem.is-link rows a :focus-visible
//     ring so the keyboard affordance matches hover (paint-only).
// ============================================================================

describe('Global openable affordance - home design slices', () => {
  it('HomeWeatherCard collapsed card is a button with the card weather-card lift treatment', () => {
    const src = read('src/weather/HomeWeatherCard.jsx');
    const anchor = src.indexOf("'data-weather-card': 'collapsed'");
    expect(anchor).toBeGreaterThan(-1);
    // The createElement type immediately before the collapsed-card props must
    // be 'button' (native keyboard), not a mouse-only div.
    const head = src.slice(0, anchor);
    const lastCreate = [...head.matchAll(/createElement\(\s*'([a-z]+)'/g)].pop();
    expect(lastCreate && lastCreate[1]).toBe('button');
    const propsBlock = src.slice(anchor, src.indexOf('},', anchor));
    expect(src).toContain("className: 'card weather-card lift'");
    expect(propsBlock.length).toBeGreaterThan(0);
  });

  it('homeRedesign.css keeps the paint-only .litem.is-link focus ring', () => {
    const css = read('src/dashboard/homeRedesign.css');
    const idx = css.indexOf('.home .litem.is-link:focus-visible');
    expect(idx).toBeGreaterThan(-1);
    const body = css.slice(css.indexOf('{', idx) + 1, css.indexOf('}', idx));
    for (const decl of body.split(';')) {
      const prop = decl.slice(0, decl.indexOf(':')).trim();
      if (!prop) continue;
      expect(
        ['outline', 'outline-offset', 'background', 'background-color', 'box-shadow'].includes(prop),
        `.litem.is-link:focus-visible sets non-paint property "${prop}"`,
      ).toBe(true);
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const viewSrc = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerTimelineView.jsx'), 'utf8');
const modelSrc = fs.readFileSync(path.join(ROOT, 'src/lib/broilerTimelineRows.js'), 'utf8');

// ============================================================================
// Broiler timeline row-separation wiring guard
// ----------------------------------------------------------------------------
// Proves the view actually consumes the pure row-separation model, renders the
// single strong divider at the brooder/schooner boundary with the one
// constitutional border gray, and paints the alternating schooner fill on BOTH
// the sticky label cell and the grid body. Complements the pure-logic test in
// src/lib/broilerTimelineRows.test.js.
// ============================================================================

describe('broiler timeline row-separation — model', () => {
  it('derives the boundary from resource order, not a hard-coded index', () => {
    expect(modelSrc).toMatch(/RESOURCES\.findIndex\(\(r\) => r\.type === 'schooner'\)/);
    expect(modelSrc).toMatch(/export function timelineRowSeparation/);
    // Alternation keyed off schooner order.
    expect(modelSrc).toMatch(/pos % 2 === 1 \? 'shaded' : 'plain'/);
  });
});

describe('broiler timeline row-separation — view wiring', () => {
  it('consumes the model instead of the old ri===2 thick border', () => {
    expect(viewSrc).toMatch(/import \{timelineRowSeparation\} from '\.\.\/lib\/broilerTimelineRows\.js'/);
    expect(viewSrc).toMatch(/const \{boundaryTop, fill\} = timelineRowSeparation\(ri\)/);
    // The buggy placement and its second border gray are gone.
    expect(viewSrc).not.toMatch(/ri === 2/);
    expect(viewSrc).not.toMatch(/2px solid #ccc/);
  });

  it('renders one divider at the boundary using the constitutional border token', () => {
    expect(viewSrc).toMatch(/borderTop: boundaryTop \? '2px solid var\(--border\)' : '1px solid #eee'/);
    expect(viewSrc).toMatch(/data-row-divider=\{boundaryTop \? '1' : undefined\}/);
  });

  it('maps the fill band to the neutral surface / card tokens', () => {
    expect(viewSrc).toMatch(
      /const rowBg = fill === 'shaded' \? 'var\(--surface-2\)' : fill === 'plain' \? 'var\(--bg-card\)' : null/,
    );
  });

  it('paints the alternating fill on both the sticky label cell and the grid body', () => {
    // Sticky label: opaque fill, falls back to the sidebar surface for brooders.
    expect(viewSrc).toMatch(/data-row-region="label"/);
    expect(viewSrc).toMatch(/background: rowBg \|\| 'var\(--surface-2\)'/);
    expect(viewSrc).toMatch(/position: 'sticky'/);
    // Grid body: same band so a row reads left-to-right.
    expect(viewSrc).toMatch(/data-row-region="grid"[\s\S]*background: rowBg \|\| undefined/);
  });

  it('exposes stable per-row hooks for focused browser assertions', () => {
    expect(viewSrc).toMatch(/data-resource-row="1"/);
    expect(viewSrc).toMatch(/data-resource-type=\{res\.type\}/);
    expect(viewSrc).toMatch(/data-resource-label=\{res\.label\}/);
    expect(viewSrc).toMatch(/data-row-fill=\{fill\}/);
  });
});

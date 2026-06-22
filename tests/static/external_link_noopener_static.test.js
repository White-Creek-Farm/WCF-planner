import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Reverse-tabnabbing hygiene (2026-06-22 audit, frontend hardening)
// ============================================================================
// Every <a target="_blank"> must carry a rel that prevents the opened page
// from reaching window.opener. Either `noopener` or `noreferrer` satisfies
// this (noreferrer is a superset that also disables opener). This guard scans
// all client source and fails if any _blank link lacks both.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// For a target="_blank" on line i, accept a rel with noopener/noreferrer
// anywhere in the same opening <a ...> tag. JSX wraps attributes across lines,
// so scan a small window around the match.
const WINDOW = 6;
const REL_OK = /rel=\{?["'][^"'}]*(noopener|noreferrer)/;

describe('external links — no reverse tabnabbing', () => {
  const files = walk(SRC);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every target="_blank" has rel with noopener or noreferrer', () => {
    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/target=["']_blank["']/.test(line)) return;
        const from = Math.max(0, i - WINDOW);
        const to = Math.min(lines.length, i + WINDOW + 1);
        const windowText = lines.slice(from, to).join('\n');
        if (!REL_OK.test(windowText)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders, `target="_blank" without safe rel:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the two previously-unguarded webforms admin links are now safe', () => {
    const src = fs.readFileSync(path.join(SRC, 'webforms/WebformsAdminView.jsx'), 'utf8');
    // Both _blank anchors must now carry rel="noopener noreferrer".
    const blankAnchors = src.match(/<a[\s\S]*?target="_blank"[\s\S]*?>/g) || [];
    expect(blankAnchors.length).toBeGreaterThanOrEqual(2);
    for (const a of blankAnchors) {
      expect(a).toMatch(/rel="noopener noreferrer"/);
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// Audit-critical group/transfer fields (cattle.herd, sheep.flock) must never be
// written by a raw object-literal PostgREST update from UI/helper code. The
// sanctioned paths are transactional SECDEF RPCs: transfer_cattle_animal /
// transfer_sheep_animal for manual moves and migration 170's processing-detach
// RPCs for processing reversals.
//
// Scope note: this guard is intentionally NOT a blanket ban on
// .from('cattle').update. It targets the object-literal herd/flock write shape,
// which is the concrete c6a880d archetype. Variable-payload writes (for example
// update(rec)) are not matched by this scan by design. Live record-page writes
// are locked by adjacent transfer/static guards. CattleHerdsView's variable-
// payload edit branch remains unreachable dead code and is tracked separately.
//
// PR3 removed the obsolete client-side DETACH implementations. These two files
// remain narrowly allowlisted only for their live ATTACH path, which migration
// 096 does not yet expose to farm_team /weighins callers. Closing the final two
// exceptions requires a separately gated attach role-widen/reroute lane.
const ALLOWLIST = new Set(['src/lib/cattleProcessingBatch.js', 'src/lib/sheepProcessingBatch.js']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Object-literal update whose payload (single brace level) names the field.
const CATTLE_HERD_LITERAL = /\.from\(\s*['"]cattle['"]\s*\)\s*\.update\(\s*\{[^}]*\bherd\b[^}]*\}/;
const SHEEP_FLOCK_LITERAL = /\.from\(\s*['"]sheep['"]\s*\)\s*\.update\(\s*\{[^}]*\bflock\b[^}]*\}/;

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

describe('audit-critical field writes - herd/flock direct-write allowlist', () => {
  const files = walk(SRC);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no raw object-literal cattle.herd update outside the attach-only allowlist', () => {
    const offenders = files
      .filter((file) => !ALLOWLIST.has(rel(file)))
      .filter((file) => CATTLE_HERD_LITERAL.test(fs.readFileSync(file, 'utf8')))
      .map(rel);
    expect(
      offenders,
      `route herd changes through an audited RPC, not cattle.update({herd}); offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('has no raw object-literal sheep.flock update outside the attach-only allowlist', () => {
    const offenders = files
      .filter((file) => !ALLOWLIST.has(rel(file)))
      .filter((file) => SHEEP_FLOCK_LITERAL.test(fs.readFileSync(file, 'utf8')))
      .map(rel);
    expect(
      offenders,
      `route flock changes through an audited RPC, not sheep.update({flock}); offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps the two remaining exceptions limited to live processing attach helpers', () => {
    expect([...ALLOWLIST].sort()).toEqual(['src/lib/cattleProcessingBatch.js', 'src/lib/sheepProcessingBatch.js']);
    for (const relPath of ALLOWLIST) {
      const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      expect(CATTLE_HERD_LITERAL.test(source) || SHEEP_FLOCK_LITERAL.test(source)).toBe(true);
      expect(source).toContain('attachEntriesToBatch');
      expect(source).not.toMatch(/detachCowFromBatch|detachSheepFromBatch/);
    }
  });
});

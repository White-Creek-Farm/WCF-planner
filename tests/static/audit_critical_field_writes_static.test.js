import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// Audit-critical group/transfer fields (cattle.herd, sheep.flock) must never be
// written by a raw object-literal PostgREST update from UI/helper code. The
// sanctioned path is the transfer RPC (transfer_cattle_animal /
// transfer_sheep_animal, wrapped in src/lib/animalTransferApi.js, which use
// sb.rpc — not .update — so they are structurally exempt from this scan).
//
// The two processing helpers below still do a direct herd/flock revert and are
// PARKED for the verify-first / gated processing-detach lane (Build Queue item 2,
// PR3 + a gated migration). They are allowlisted here WITH that reason, not
// blessed as correct.
//
// Scope note: this guard is intentionally NOT a blanket ban on
// .from('cattle').update — it targets the object-literal herd/flock write shape,
// which is the concrete c6a880d archetype. Variable-payload writes (e.g.
// update(rec)) are not matched by this scan by design. The live writes are
// locked elsewhere: the sheep flock select in sheep_record_page_static.test.js,
// and the cattle record-page herd path by c6a880d (cattle_record_page_static.test.js,
// transactional-transfer block). The CattleHerdsView edit-cow branch still does a
// variable-payload update(rec) that carries herd, but it is currently UNREACHABLE
// dead code (openEdit is never wired; list rows open the record page), so it is
// neither matched here nor separately guarded — it is tracked for cleanup, not locked.
const ALLOWLIST = new Set([
  'src/lib/cattleProcessingBatch.js', // parked: processing attach/detach herd revert — PR3 / gated lane
  'src/lib/sheepProcessingBatch.js', // parked: processing attach/detach flock revert — PR3 / gated lane
]);

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

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

describe('audit-critical field writes — herd/flock direct-write allowlist', () => {
  const files = walk(SRC);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no raw object-literal cattle.herd update outside the sanctioned/parked allowlist', () => {
    const offenders = files
      .filter((f) => !ALLOWLIST.has(rel(f)))
      .filter((f) => CATTLE_HERD_LITERAL.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(
      offenders,
      `route herd changes through transferCattleAnimal, not a raw cattle.update({herd}); offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no raw object-literal sheep.flock update outside the sanctioned/parked allowlist', () => {
    const offenders = files
      .filter((f) => !ALLOWLIST.has(rel(f)))
      .filter((f) => SHEEP_FLOCK_LITERAL.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(
      offenders,
      `route flock changes through transferSheepAnimal, not a raw sheep.update({flock}); offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every allowlisted file still does a direct herd/flock update (else tighten the allowlist)', () => {
    // If a parked file is rerouted to the audited detach RPC (PR3), it should be
    // removed from the allowlist in that same change so the list cannot rot.
    for (const relPath of ALLOWLIST) {
      const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      const hit = CATTLE_HERD_LITERAL.test(src) || SHEEP_FLOCK_LITERAL.test(src);
      expect(
        hit,
        `${relPath} is allowlisted but no longer does a direct herd/flock update — remove it from the allowlist`,
      ).toBe(true);
    }
  });
});

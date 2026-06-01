import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ── Suite-Wide Seed Idempotency CP1 ──────────────────────────────────────────
// The highest-risk fixed-ID Playwright scenario seeds must use upsert, not
// plain insert, so a shared-DB worker-restart race (Playwright spawns a fresh
// worker after any failure, which can land a stale row after the new worker's
// TRUNCATE) cannot trip duplicate-primary-key errors. upsert(onConflict:'id')
// overwrites any stale row into the exact intended state; ignoreDuplicates
// would leave a stale row's wrong columns in place, so it is NOT allowed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SEED_FILES = [
  'tests/scenarios/cattle_processor_seed.js',
  'tests/scenarios/sheep_processor_seed.js',
  'tests/scenarios/cattle_herd_filters_seed.js',
  'tests/scenarios/cattle_soft_delete_seed.js',
  'tests/scenarios/admin_broiler_session_meta_seed.js',
  'tests/scenarios/broiler_timeline_seed.js',
];

describe('processor scenario seeds are idempotent (upsert, not insert)', () => {
  for (const rel of SEED_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

    it(`${rel} contains no plain .insert( calls`, () => {
      expect(src).not.toMatch(/\.insert\(/);
    });

    it(`${rel} writes rows via upsert(..., {onConflict: 'id'})`, () => {
      expect(src).toMatch(/\.upsert\(/);
      expect(src).toMatch(/onConflict:\s*'id'/);
    });

    it(`${rel} does not rely on ignoreDuplicates`, () => {
      expect(src).not.toMatch(/ignoreDuplicates/);
    });
  }
});

// ── CP2 fix — upsert payloads must clear known mutable stale state ────────────
// upsert only resets columns present in the payload; omitted nullable/mutable
// columns survive from a stale worker row. The seeds whose specs mutate those
// columns (soft-delete / restore, batch attachment, session completion, notes)
// must therefore seed the reset values explicitly so a re-seed produces the
// exact intended starting state, not a half-stale hybrid.
describe('CP2: upsert payloads reset known mutable stale columns', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  for (const rel of ['tests/scenarios/cattle_soft_delete_seed.js', 'tests/scenarios/cattle_herd_filters_seed.js']) {
    const src = read(rel);
    it(`${rel} explicitly resets soft-delete + attachment columns on seeded cattle`, () => {
      expect(src).toMatch(/deleted_at:\s*null/);
      expect(src).toMatch(/deleted_by:\s*null/);
      expect(src).toMatch(/processing_batch_id:\s*null/);
    });
  }

  it('admin_broiler_session_meta_seed.js resets completed_at + notes on seeded sessions', () => {
    const src = read('tests/scenarios/admin_broiler_session_meta_seed.js');
    expect(src).toMatch(/completed_at:\s*null/);
    expect(src).toMatch(/notes:\s*null/);
  });
});

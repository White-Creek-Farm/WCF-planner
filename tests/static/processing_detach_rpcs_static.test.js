import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig = fs.readFileSync(path.join(ROOT, 'supabase-migrations/081_processing_detach_activity_rpcs.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/processingDetachApi.js'), 'utf8');
const cattleSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBatchPage.jsx'), 'utf8');
const sheepSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepBatchPage.jsx'), 'utf8');
const webformSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WeighInsWebform.jsx'), 'utf8');

function fnBody(src, name) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$fn\\$;`);
  const m = src.match(re);
  return m ? m[0] : '';
}

const cattleFn = fnBody(mig, 'detach_cattle_from_processing_batch');
const sheepFn = fnBody(mig, 'detach_sheep_from_processing_batch');

describe('mig 081 — processing-detach SECDEF RPCs', () => {
  it('defines both detach RPCs', () => {
    expect(cattleFn).not.toBe('');
    expect(sheepFn).not.toBe('');
  });

  for (const [label, fn] of [
    ['cattle', cattleFn],
    ['sheep', sheepFn],
  ]) {
    describe(`${label} detach RPC`, () => {
      it('is SECURITY DEFINER with a pinned search_path', () => {
        expect(fn).toMatch(/SECURITY DEFINER/);
        expect(fn).toMatch(/SET search_path = public/);
      });

      it('requires an authenticated caller', () => {
        expect(fn).toMatch(/auth\.uid\(\)/);
        expect(fn).toMatch(/authenticated caller required/);
      });

      it('is admin OR management only (enforced in the RPC, not just UI)', () => {
        expect(fn).toMatch(/public\.profile_role\(\)/);
        expect(fn).toMatch(/NOT IN \('admin', 'management'\)/);
        expect(fn).toMatch(/cannot detach/);
      });

      it('reverts the animal and clears processing_batch_id', () => {
        expect(fn).toMatch(/processing_batch_id = NULL/);
      });

      it('writes an undo transfer audit row with reason processing_batch_undo', () => {
        expect(fn).toContain("'processing_batch_undo'");
      });

      it('clears matching weigh-ins: both the batch link and the processor flag', () => {
        expect(fn).toMatch(/target_processing_batch_id = NULL/);
        expect(fn).toMatch(/send_to_processor = false/);
      });

      it('recomputes batch totals from the remaining detail rows', () => {
        expect(fn).toMatch(/total_live_weight/);
        expect(fn).toMatch(/total_hanging_weight/);
        expect(fn).toMatch(/jsonb_array_elements/);
      });

      it('logs ONE field.updated Activity event in the same transaction', () => {
        expect(fn).toContain('INSERT INTO public.activity_events');
        expect(fn).toContain("'field.updated'");
        expect(fn).toContain("'Detached #'");
      });

      it('stores the processing batch label in Activity payload for global Activity rendering', () => {
        expect(fn).toContain("'entity_label', COALESCE(NULLIF(v_batch_label, ''), p_batch_id)");
        expect(fn).not.toContain("'entity_label', v_label");
      });

      it('never guesses a prior herd/flock — blocks with a clear reason', () => {
        // weigh_ins.prior_herd_or_flock first, then the transfer fallback.
        expect(fn).toMatch(/prior_herd_or_flock/);
        expect(fn).toMatch(/'processing_batch'/);
      });
    });
  }

  it('cattle RPC logs on cattle.processing and blocks with no_prior_herd', () => {
    expect(cattleFn).toContain("'cattle.processing'");
    expect(cattleFn).toContain("'no_prior_herd'");
    expect(cattleFn).toContain('public.cattle_transfers');
    expect(cattleFn).toContain('SELECT b.cows_detail, b.name');
  });

  it('sheep RPC logs on sheep.processing and blocks with no_prior_flock', () => {
    expect(sheepFn).toContain("'sheep.processing'");
    expect(sheepFn).toContain("'no_prior_flock'");
    expect(sheepFn).toContain('public.sheep_transfers');
    expect(sheepFn).toContain('SELECT b.sheep_detail, b.name');
  });

  it('does not filter deleted_at when loading the animal (admin-context resolve)', () => {
    expect(cattleFn).not.toMatch(/FROM public\.cattle c[\s\S]*?deleted_at/);
    expect(sheepFn).not.toMatch(/FROM public\.sheep s[\s\S]*?deleted_at/);
  });

  it('REVOKEs PUBLIC/anon, GRANTs authenticated, and reloads PostgREST', () => {
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.detach_cattle_from_processing_batch\(text, text, text\) FROM PUBLIC, anon/,
    );
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.detach_cattle_from_processing_batch\(text, text, text\) TO authenticated/,
    );
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.detach_sheep_from_processing_batch\(text, text, text\) FROM PUBLIC, anon/,
    );
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.detach_sheep_from_processing_batch\(text, text, text\) TO authenticated/,
    );
    expect(mig).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('processingDetachApi — client RPC wrappers', () => {
  it('exports detachCattleFromProcessingBatch calling the RPC', () => {
    expect(apiSrc).toMatch(/export async function detachCattleFromProcessingBatch/);
    expect(apiSrc).toContain("sb.rpc('detach_cattle_from_processing_batch'");
  });
  it('exports detachSheepFromProcessingBatch calling the RPC', () => {
    expect(apiSrc).toMatch(/export async function detachSheepFromProcessingBatch/);
    expect(apiSrc).toContain("sb.rpc('detach_sheep_from_processing_batch'");
  });
  it('returns an error object instead of throwing (pages do not try/catch)', () => {
    expect(apiSrc).toMatch(/if \(error\) return \{ok: false, reason: 'rpc_error'/);
  });
});

describe('record-page wiring', () => {
  it('CattleBatchPage detaches via the RPC wrapper, not the client helper', () => {
    expect(cattleSrc).toContain("from '../lib/processingDetachApi.js'");
    expect(cattleSrc).toContain('detachCattleFromProcessingBatch');
    expect(cattleSrc).not.toContain('detachCowFromBatch');
  });
  it('SheepBatchPage detaches via the RPC wrapper, not the client helper', () => {
    expect(sheepSrc).toContain("from '../lib/processingDetachApi.js'");
    expect(sheepSrc).toContain('detachSheepFromProcessingBatch');
    expect(sheepSrc).not.toContain("from '../lib/sheepProcessingBatch.js'");
  });
  it('both record pages provide a Retry action on the loadError branch', () => {
    expect(cattleSrc).toMatch(/if \(loadError\)[\s\S]*?onClick=\{loadAll\}[\s\S]*?Retry/);
    expect(sheepSrc).toMatch(/if \(loadError\)[\s\S]*?onClick=\{loadAll\}[\s\S]*?Retry/);
  });
});

describe('public webform anon path is intentionally NOT migrated', () => {
  it('WeighInsWebform still uses the client detach helpers (no RPC, no anon grant)', () => {
    expect(webformSrc).toContain('detachCowFromBatch');
    expect(webformSrc).toContain('detachSheepFromBatch');
    expect(webformSrc).not.toContain('detach_cattle_from_processing_batch');
    expect(webformSrc).not.toContain('detach_sheep_from_processing_batch');
  });
});

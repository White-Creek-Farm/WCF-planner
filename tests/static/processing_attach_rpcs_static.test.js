import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const migPath = path.join(ROOT, 'supabase-migrations/096_processing_attach_activity_rpcs.sql');
const mig = fs.readFileSync(migPath, 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/processingAttachApi.js'), 'utf8');
const cattleModalSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleSendToProcessorModal.jsx'), 'utf8');
const sheepModalSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepSendToProcessorModal.jsx'), 'utf8');
const sessionPageSrc = fs.readFileSync(path.join(ROOT, 'src/livestock/WeighInSessionPage.jsx'), 'utf8');
const publicWebformSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WeighInsWebform.jsx'), 'utf8');

function fnBody(src, name) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$fn\\$;`);
  const m = src.match(re);
  return m ? m[0] : '';
}

const cattleFn = fnBody(mig, 'attach_cattle_to_processing_batch');
const sheepFn = fnBody(mig, 'attach_sheep_to_processing_batch');

describe('mig 096 - processing-attach SECDEF RPCs', () => {
  it('defines both attach RPCs and reloads PostgREST', () => {
    expect(fs.existsSync(migPath)).toBe(true);
    expect(cattleFn).not.toBe('');
    expect(sheepFn).not.toBe('');
    expect(mig).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/);
    expect(mig).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });

  for (const [label, fn] of [
    ['cattle', cattleFn],
    ['sheep', sheepFn],
  ]) {
    describe(`${label} attach RPC`, () => {
      it('is SECURITY DEFINER with a pinned search_path', () => {
        expect(fn).toMatch(/SECURITY DEFINER/);
        expect(fn).toMatch(/SET search_path = public/);
      });

      it('requires an authenticated admin or management caller', () => {
        expect(fn).toMatch(/auth\.uid\(\)/);
        expect(fn).toMatch(/authenticated caller required/);
        expect(fn).toMatch(/public\.profile_role\(\)/);
        expect(fn).toMatch(/NOT IN \('admin', 'management'\)/);
        expect(fn).toMatch(/cannot attach/);
      });

      it('locks the session and entry rows during attach', () => {
        expect(fn).toMatch(/FROM public\.weigh_in_sessions[\s\S]*?FOR UPDATE/);
        expect(fn).toMatch(/FROM public\.weigh_ins[\s\S]*?FOR UPDATE/);
      });

      it('stamps weigh-ins, appends transfer audit rows, and logs one Activity event', () => {
        expect(fn).toMatch(/target_processing_batch_id = v_batch_id/);
        expect(fn).toMatch(/prior_herd_or_flock/);
        expect(fn).toContain("'processing_batch'");
        expect(fn).toContain('INSERT INTO public.activity_events');
        expect(fn).toContain("'field.updated'");
        expect(fn).toContain("'action', 'attach'");
        expect(fn).toContain("'attached', v_attached");
        expect(fn).toContain("'skipped', v_skipped");
      });

      it('preserves old helper skip reasons', () => {
        expect(fn).toContain("'tagless'");
        expect(fn).toContain("'already_in_batch'");
      });
    });
  }

  it('cattle attach promotes scheduled batches or creates active batches atomically', () => {
    expect(cattleFn).toContain('public.cattle_processing_batches');
    expect(cattleFn).toContain("v_batch.status = 'scheduled'");
    expect(cattleFn).toMatch(/SET status = 'active'/);
    expect(cattleFn).toMatch(/actual_process_date = v_processing_date/);
    expect(cattleFn).toContain("NULL, 'active', '[]'::jsonb");
    expect(cattleFn).toContain('public.cattle');
    expect(cattleFn).toMatch(/herd = 'processed'/);
    expect(cattleFn).toContain('public.cattle_transfers');
    expect(cattleFn).toContain("'cattle.processing'");
    expect(cattleFn).toContain("'field', 'cows_detail'");
    expect(cattleFn).toContain("'no_cow_for_tag'");
    expect(cattleFn).toContain("COALESCE(ot->>'source', '') <> 'import'");
  });

  it('sheep attach uses planned batches and moves sheep to processed atomically', () => {
    expect(sheepFn).toContain('public.sheep_processing_batches');
    expect(sheepFn).toContain("v_batch.status IS DISTINCT FROM 'planned'");
    expect(sheepFn).toContain("NULL, 'planned', '[]'::jsonb");
    expect(sheepFn).toContain('public.sheep');
    expect(sheepFn).toMatch(/flock = 'processed'/);
    expect(sheepFn).toContain('public.sheep_transfers');
    expect(sheepFn).toContain("'sheep.processing'");
    expect(sheepFn).toContain("'field', 'sheep_detail'");
    expect(sheepFn).toContain("'no_sheep_for_tag'");
    expect(sheepFn).toContain("COALESCE(ot->>'source', '') <> 'import'");
  });

  it('REVOKEs PUBLIC/anon and GRANTs authenticated for both functions', () => {
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.attach_cattle_to_processing_batch\(text, text\[\], text, text, date, text\) FROM PUBLIC, anon/,
    );
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.attach_cattle_to_processing_batch\(text, text\[\], text, text, date, text\) TO authenticated/,
    );
    expect(mig).toMatch(
      /REVOKE ALL ON FUNCTION public\.attach_sheep_to_processing_batch\(text, text\[\], text, text, date, text\) FROM PUBLIC, anon/,
    );
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.attach_sheep_to_processing_batch\(text, text\[\], text, text, date, text\) TO authenticated/,
    );
  });
});

describe('processingAttachApi - client RPC wrappers', () => {
  it('exports cattle and sheep attach wrappers with the expected RPC names', () => {
    expect(apiSrc).toMatch(/export async function attachCattleToProcessingBatch/);
    expect(apiSrc).toContain("sb.rpc('attach_cattle_to_processing_batch'");
    expect(apiSrc).toMatch(/export async function attachSheepToProcessingBatch/);
    expect(apiSrc).toContain("sb.rpc('attach_sheep_to_processing_batch'");
  });

  it('passes session, entry ids, target batch/new batch fields, dates, and team member', () => {
    for (const name of ['p_session_id', 'p_entry_ids', 'p_target_batch_id', 'p_batch_name', 'p_team_member']) {
      expect(apiSrc).toContain(name);
    }
    expect(apiSrc).toContain('p_processing_date');
    expect(apiSrc).toContain('p_planned_date');
  });

  it('throws on RPC transport or business failures so modal try/catch surfaces the error', () => {
    expect(apiSrc).toMatch(/if \(error\) throw new Error/);
    expect(apiSrc).toMatch(/if \(data\.ok !== true\)/);
  });
});

describe('authenticated attach wiring', () => {
  it('shared modals expose an opt-in RPC path and keep legacy helper fallback', () => {
    expect(cattleModalSrc).toContain("from '../lib/processingAttachApi.js'");
    expect(cattleModalSrc).toContain('useAttachRpc = false');
    expect(cattleModalSrc).toContain('attachCattleToProcessingBatch');
    expect(cattleModalSrc).toContain('attachEntriesToBatch');

    expect(sheepModalSrc).toContain("from '../lib/processingAttachApi.js'");
    expect(sheepModalSrc).toContain('useAttachRpc = false');
    expect(sheepModalSrc).toContain('attachSheepToProcessingBatch');
    expect(sheepModalSrc).toContain('attachEntriesToBatch');
  });

  it('authenticated weigh-in session record page opts both species into RPC attach', () => {
    expect(sessionPageSrc).toMatch(/SheepSendToProcessorModal[\s\S]*?authState,[\s\S]*?useAttachRpc: true/);
    expect(sessionPageSrc).toMatch(/CattleSendToProcessorModal[\s\S]*?authState,[\s\S]*?useAttachRpc: true/);
  });

  it('public webform does not opt into authenticated attach RPCs', () => {
    expect(publicWebformSrc).not.toContain('useAttachRpc');
    expect(publicWebformSrc).not.toContain('attach_cattle_to_processing_batch');
    expect(publicWebformSrc).not.toContain('attach_sheep_to_processing_batch');
  });
});

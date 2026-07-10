import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig081 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/081_processing_detach_activity_rpcs.sql'), 'utf8');
const mig170 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/170_processing_detach_farm_team.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/processingDetachApi.js'), 'utf8');
const cattleSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBatchPage.jsx'), 'utf8');
const sheepSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepBatchPage.jsx'), 'utf8');
const sessionSrc = fs.readFileSync(path.join(ROOT, 'src/livestock/WeighInSessionPage.jsx'), 'utf8');
const webformSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WeighInsWebform.jsx'), 'utf8');

function fnBody(src, name) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$fn\\$;`);
  const match = src.match(re);
  return match ? match[0] : '';
}

function occurrences(src, pattern) {
  return [...src.matchAll(pattern)].length;
}

function runtimeSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...runtimeSourceFiles(full));
    else if (entry.isFile() && /\\.(?:js|jsx)$/.test(entry.name) && !/\\.test\\.(?:js|jsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const cattleFn = fnBody(mig170, 'detach_cattle_from_processing_batch');
const sheepFn = fnBody(mig170, 'detach_sheep_from_processing_batch');

describe('migration 081 predecessor contract', () => {
  it('keeps the original atomic RPC foundation in migration history', () => {
    expect(fnBody(mig081, 'detach_cattle_from_processing_batch')).not.toBe('');
    expect(fnBody(mig081, 'detach_sheep_from_processing_batch')).not.toBe('');
  });
});

describe('migration 170 - effective processing-detach RPC contract', () => {
  it('replaces both migration-081 functions', () => {
    expect(cattleFn).not.toBe('');
    expect(sheepFn).not.toBe('');
  });

  for (const {label, fn, program, table, animalTable, idColumn, priorReason, entityType} of [
    {
      label: 'cattle',
      fn: cattleFn,
      program: 'cattle',
      table: 'cattle_processing_batches',
      animalTable: 'cattle',
      idColumn: 'cattle_id',
      priorReason: 'no_prior_herd',
      entityType: 'cattle.processing',
    },
    {
      label: 'sheep',
      fn: sheepFn,
      program: 'sheep',
      table: 'sheep_processing_batches',
      animalTable: 'sheep',
      idColumn: 'sheep_id',
      priorReason: 'no_prior_flock',
      entityType: 'sheep.processing',
    },
  ]) {
    describe(`${label} detach RPC`, () => {
      it('is authenticated SECURITY DEFINER with a pinned search_path', () => {
        expect(fn).toMatch(/SECURITY DEFINER/);
        expect(fn).toMatch(/SET search_path = public/);
        expect(fn).toMatch(/auth\.uid\(\)/);
        expect(fn).toMatch(/authenticated caller required/);
      });

      it('preserves admin/management and admits only farm_team from other roles', () => {
        expect(fn).toMatch(/v_role NOT IN \('admin', 'management', 'farm_team'\)/);
        expect(fn).toMatch(/caller role % cannot detach/);
        expect(fn).not.toMatch(/'light'|'equipment_tech'|'inactive'/);
      });

      it(`requires matching ${program} program access for farm_team`, () => {
        expect(fn).toMatch(/v_role = 'farm_team'/);
        expect(fn).toMatch(/v_program_access IS NOT NULL/);
        expect(fn).toMatch(/array_length\(v_program_access, 1\) IS NOT NULL/);
        expect(fn).toContain(`'${program}' = ANY(v_program_access)`);
        expect(fn).toContain(`${program} program access required`);
      });

      it('server-stamps transfer and Activity attribution from the caller profile', () => {
        expect(fn).toMatch(/FROM public\.profiles p[\s\S]*?WHERE p\.id = v_caller/);
        expect(fn).toMatch(/p\.full_name[\s\S]*?p\.email/);
        expect(fn).toMatch(new RegExp(`INSERT INTO public\\.${animalTable}_transfers[\\s\\S]*?v_actor_name`));
        expect(fn).toContain("'team_member', v_actor_name");
        // Compatibility parameter remains accepted but is never trusted in the body.
        expect(fn.match(/\bp_team_member\b/g)).toHaveLength(1);
      });

      it('uses the attach-compatible batch -> weigh-ins -> animal lock order and revalidates membership', () => {
        const batchLock = fn.indexOf(`FROM public.${table} b`);
        const weighInLock = fn.indexOf('PERFORM 1\n    FROM public.weigh_ins w');
        const animalLock = fn.lastIndexOf(`FROM public.${animalTable} `);
        expect(batchLock).toBeGreaterThan(-1);
        expect(weighInLock).toBeGreaterThan(batchLock);
        expect(animalLock).toBeGreaterThan(weighInLock);
        expect(occurrences(fn, /v_pbid IS DISTINCT FROM p_batch_id/g)).toBe(2);
      });

      it('preserves atomic batch, animal, transfer, weigh-in, and Activity mutations', () => {
        expect(fn).toMatch(/processing_batch_id = NULL/);
        expect(fn).toContain("'processing_batch_undo'");
        expect(fn).toMatch(/target_processing_batch_id = NULL/);
        expect(fn).toMatch(/send_to_processor = false/);
        expect(fn).toMatch(/total_live_weight/);
        expect(fn).toMatch(/total_hanging_weight/);
        expect(fn).toContain('INSERT INTO public.activity_events');
        expect(fn).toContain("'field.updated'");
        expect(fn).toContain("'Detached #'");
        expect(fn).toContain(`'${entityType}'`);
        expect(fn).toContain(`'${priorReason}'`);
        expect(fn).toContain(`elem->>'${idColumn}'`);
      });

      it('keeps the batch label in the Activity payload and never guesses a restore destination', () => {
        expect(fn).toContain("'entity_label', COALESCE(NULLIF(v_batch_label, ''), p_batch_id)");
        expect(fn).toMatch(/prior_herd_or_flock/);
        expect(fn).toMatch(/'processing_batch'/);
      });
    });
  }

  it('keeps authenticated-only grants, reloads PostgREST, and documents both RPCs', () => {
    for (const name of ['detach_cattle_from_processing_batch', 'detach_sheep_from_processing_batch']) {
      expect(mig170).toContain(`REVOKE ALL ON FUNCTION public.${name}(text, text, text) FROM PUBLIC, anon;`);
      expect(mig170).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(text, text, text) TO authenticated;`);
      expect(mig170).toContain(`COMMENT ON FUNCTION public.${name}(text, text, text)`);
    }
    expect(mig170).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('scopes its lock-order claim to migration 096 attach and leaves migration 100 as a follow-up', () => {
    expect(mig170).toContain('For the migration-096 attach / migration-170 detach pair');
    expect(mig170).toContain("migration 100's sheep batch");
    expect(mig170).toContain('excluded');
    expect(mig170).toContain('follow-up hardening lane');
  });
});

describe('processingDetachApi client wrappers', () => {
  it('exports both stable RPC wrappers', () => {
    expect(apiSrc).toMatch(/export async function detachCattleFromProcessingBatch/);
    expect(apiSrc).toContain("sb.rpc('detach_cattle_from_processing_batch'");
    expect(apiSrc).toMatch(/export async function detachSheepFromProcessingBatch/);
    expect(apiSrc).toContain("sb.rpc('detach_sheep_from_processing_batch'");
  });

  it('returns an error object instead of throwing so existing warnings remain usable', () => {
    expect(occurrences(apiSrc, /if \(error\) return \{ok: false, reason: 'rpc_error'/g)).toBe(2);
  });
});

describe('all live detach paths use the atomic RPC wrappers', () => {
  it('processing batch record pages use wrappers, not legacy client helpers', () => {
    expect(cattleSrc).toContain("from '../lib/processingDetachApi.js'");
    expect(cattleSrc).toContain('detachCattleFromProcessingBatch');
    expect(cattleSrc).not.toContain('detachCowFromBatch');
    expect(sheepSrc).toContain("from '../lib/processingDetachApi.js'");
    expect(sheepSrc).toContain('detachSheepFromProcessingBatch');
    expect(sheepSrc).not.toContain('detachSheepFromBatch');
  });

  it('WeighInSessionPage reroutes session-delete, toggle-clear, and entry-delete', () => {
    expect(sessionSrc).toContain("from '../lib/processingDetachApi.js'");
    expect(occurrences(sessionSrc, /detachCattleFromProcessingBatch\s*\(/g)).toBe(3);
    expect(occurrences(sessionSrc, /detachSheepFromProcessingBatch\s*\(/g)).toBe(3);
    expect(sessionSrc).not.toContain('detachCowFromBatch');
    expect(sessionSrc).not.toContain('detachSheepFromBatch');
    expect(sessionSrc).toMatch(
      /let detached = false;[\s\S]*?detached = r\.ok && r\.reason === 'detached';[\s\S]*?if \(detached\)[\s\S]*?result = \{ok: true\};[\s\S]*?else \{[\s\S]*?runMutation/,
    );
    expect(sessionSrc).toMatch(/if \(detached\)[\s\S]*?await activity\(\)/);
  });

  it('the login-gated WeighInsWebform reroutes toggle-clear and entry-delete', () => {
    expect(webformSrc).toContain("from '../lib/processingDetachApi.js'");
    expect(occurrences(webformSrc, /detachCattleFromProcessingBatch\s*\(/g)).toBe(2);
    expect(occurrences(webformSrc, /detachSheepFromProcessingBatch\s*\(/g)).toBe(2);
    expect(webformSrc).not.toContain('detachCowFromBatch');
    expect(webformSrc).not.toContain('detachSheepFromBatch');
    expect(webformSrc).toContain('This login-gated webform does not mount');
    expect(webformSrc).toMatch(
      /let detached = false;[\s\S]*?detached = r\.ok && r\.reason === 'detached';[\s\S]*?if \(!detached\) \{[\s\S]*?from\('weigh_ins'\)\.update/,
    );
    expect(webformSrc).toMatch(/target_processing_batch_id: detached \? null : e\.target_processing_batch_id/);
  });

  it('removes the obsolete multi-step detach helpers from runtime source', () => {
    const offenders = runtimeSourceFiles(path.join(ROOT, 'src'))
      .filter((file) => /detachCowFromBatch|detachSheepFromBatch/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });
});

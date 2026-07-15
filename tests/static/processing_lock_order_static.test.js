// Guards the canonical cattle/sheep processing lifecycle lock order:
//
//   weigh_in_sessions  ≺  processing batch row  ≺  weigh_ins  ≺  animal rows
//
// Effective holders: attach (mig 096), detach (mig 170), and the migration-179
// reissue of the two migration-100 unschedule/delete functions. Migration 100
// remains read-only history with the known inversion; 179 is the effective
// definition. If a later migration reissues any of these six functions, this
// guard must move with it in the same lane.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MIG_DIR = path.join(ROOT, 'supabase-migrations');

const mig096 = fs.readFileSync(path.join(MIG_DIR, '096_processing_attach_activity_rpcs.sql'), 'utf8');
const mig100 = fs.readFileSync(path.join(MIG_DIR, '100_processing_batch_lifecycle_rpcs.sql'), 'utf8');
const mig170 = fs.readFileSync(path.join(MIG_DIR, '170_processing_detach_farm_team.sql'), 'utf8');
const mig179 = fs.readFileSync(path.join(MIG_DIR, '179_processing_lifecycle_lock_order.sql'), 'utf8');

const LIFECYCLE_FNS = [
  'attach_cattle_to_processing_batch',
  'attach_sheep_to_processing_batch',
  'detach_cattle_from_processing_batch',
  'detach_sheep_from_processing_batch',
  'unschedule_cattle_processing_batch',
  'delete_sheep_processing_batch',
];

function fnBody(src, name) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$fn\\$;`);
  const m = src.match(re);
  return m ? m[0] : '';
}

function migrationNumber(file) {
  const m = file.match(/^(\d+)_/);
  return m ? Number(m[1]) : null;
}

describe('effective definition ownership', () => {
  it('no migration after 179 silently reissues a lifecycle function without moving this guard', () => {
    const owners = new Map(LIFECYCLE_FNS.map((fn) => [fn, 0]));
    for (const file of fs.readdirSync(MIG_DIR)) {
      const num = migrationNumber(file);
      if (num === null) continue;
      const src = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
      for (const fn of LIFECYCLE_FNS) {
        if (src.includes(`CREATE OR REPLACE FUNCTION public.${fn}`) && num > owners.get(fn)) {
          owners.set(fn, num);
        }
      }
    }
    expect(owners.get('attach_cattle_to_processing_batch')).toBe(96);
    expect(owners.get('attach_sheep_to_processing_batch')).toBe(96);
    expect(owners.get('detach_cattle_from_processing_batch')).toBe(170);
    expect(owners.get('detach_sheep_from_processing_batch')).toBe(170);
    expect(owners.get('unschedule_cattle_processing_batch')).toBe(179);
    expect(owners.get('delete_sheep_processing_batch')).toBe(179);
  });

  it('keeps migration 100 as unedited history containing the superseded definitions', () => {
    expect(fnBody(mig100, 'unschedule_cattle_processing_batch')).not.toBe('');
    expect(fnBody(mig100, 'delete_sheep_processing_batch')).not.toBe('');
  });
});

describe('canonical lock order: session -> batch -> weigh-ins -> animal', () => {
  for (const [label, fn, batchTable, animalTable] of [
    ['cattle attach (096)', fnBody(mig096, 'attach_cattle_to_processing_batch'), 'cattle_processing_batches', 'cattle'],
    ['sheep attach (096)', fnBody(mig096, 'attach_sheep_to_processing_batch'), 'sheep_processing_batches', 'sheep'],
  ]) {
    it(`${label} locks session before batch before weigh-ins before animal`, () => {
      const sessionLock = fn.indexOf('FROM public.weigh_in_sessions');
      const batchRef = fn.indexOf(`FROM public.${batchTable}`);
      const entryLock = fn.indexOf('FROM public.weigh_ins');
      const animalLock = fn.indexOf(`FROM public.${animalTable} `);
      expect(sessionLock).toBeGreaterThan(-1);
      expect(batchRef).toBeGreaterThan(sessionLock);
      expect(entryLock).toBeGreaterThan(batchRef);
      expect(animalLock).toBeGreaterThan(entryLock);
    });
  }

  for (const [label, fn, batchTable, animalTable] of [
    [
      'cattle detach (170)',
      fnBody(mig170, 'detach_cattle_from_processing_batch'),
      'cattle_processing_batches',
      'cattle',
    ],
    ['sheep detach (170)', fnBody(mig170, 'detach_sheep_from_processing_batch'), 'sheep_processing_batches', 'sheep'],
  ]) {
    it(`${label} locks batch before weigh-ins before animal`, () => {
      const batchLock = fn.indexOf(`FROM public.${batchTable} b`);
      const entryLock = fn.indexOf('FROM public.weigh_ins w');
      const animalLock = fn.lastIndexOf(`FROM public.${animalTable} `);
      expect(batchLock).toBeGreaterThan(-1);
      expect(entryLock).toBeGreaterThan(batchLock);
      expect(animalLock).toBeGreaterThan(entryLock);
    });
  }
});

describe('migration 179 - hardened unschedule/delete lock order', () => {
  const cattleFn = fnBody(mig179, 'unschedule_cattle_processing_batch');
  const sheepFn = fnBody(mig179, 'delete_sheep_processing_batch');

  it('reissues both migration-100 functions', () => {
    expect(cattleFn).not.toBe('');
    expect(sheepFn).not.toBe('');
  });

  for (const {label, fn, name, batchTable, animalTable, animalAlias} of [
    {
      label: 'cattle unschedule',
      fn: cattleFn,
      name: 'unschedule_cattle_processing_batch',
      batchTable: 'cattle_processing_batches',
      animalTable: 'cattle',
      animalAlias: 'c',
    },
    {
      label: 'sheep delete',
      fn: sheepFn,
      name: 'delete_sheep_processing_batch',
      batchTable: 'sheep_processing_batches',
      animalTable: 'sheep',
      animalAlias: 's',
    },
  ]) {
    describe(label, () => {
      it('is authenticated SECURITY DEFINER, admin/management only, with pinned search_path', () => {
        expect(fn).toMatch(/SECURITY DEFINER/);
        expect(fn).toMatch(/SET search_path = public/);
        expect(fn).toMatch(/auth\.uid\(\)/);
        expect(fn).toMatch(/authenticated caller required/);
        expect(fn).toMatch(/public\.profile_role\(\)/);
        expect(fn).toMatch(/NOT IN \('admin', 'management'\)/);
      });

      it('acquires the batch row lock FIRST, before any animal lock or write', () => {
        const batchLock = fn.search(
          new RegExp(`FROM public\\.${batchTable} b\\s+WHERE b\\.id = p_batch_id\\s+FOR UPDATE`),
        );
        const animalLock = fn.indexOf(`FROM public.${animalTable} ${animalAlias}`);
        const animalWrite = fn.indexOf(`UPDATE public.${animalTable}`);
        const batchDelete = fn.indexOf(`DELETE FROM public.${batchTable}`);
        expect(batchLock).toBeGreaterThan(-1);
        expect(animalLock).toBeGreaterThan(batchLock);
        expect(animalWrite).toBeGreaterThan(animalLock);
        expect(batchDelete).toBeGreaterThan(animalWrite);
      });

      it('locks dependent animal rows deterministically before the unlink update', () => {
        expect(fn).toMatch(
          new RegExp(
            `PERFORM 1\\s+FROM public\\.${animalTable} ${animalAlias}\\s+` +
              `WHERE ${animalAlias}\\.processing_batch_id = p_batch_id\\s+` +
              `ORDER BY ${animalAlias}\\.id\\s+FOR UPDATE`,
          ),
        );
      });

      it('audits record.deleted before the batch delete in the same transaction', () => {
        const audit = fn.indexOf('INSERT INTO public.activity_events');
        const batchDelete = fn.indexOf(`DELETE FROM public.${batchTable}`);
        expect(audit).toBeGreaterThan(-1);
        expect(batchDelete).toBeGreaterThan(audit);
        expect(fn).toContain("'record.deleted'");
      });

      it('keeps authenticated-only grants and the (text, text) signature', () => {
        expect(mig179).toContain(`REVOKE ALL ON FUNCTION public.${name}(text, text) FROM PUBLIC, anon;`);
        expect(mig179).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(text, text) TO authenticated;`);
        expect(mig179).toContain(`COMMENT ON FUNCTION public.${name}(text, text)`);
      });
    });
  }

  it('cattle unschedule revalidates the scheduled status UNDER the batch lock', () => {
    const batchLock = cattleFn.search(
      /FROM public\.cattle_processing_batches b\s+WHERE b\.id = p_batch_id\s+FOR UPDATE/,
    );
    const statusCheck = cattleFn.indexOf("IF v_status IS DISTINCT FROM 'scheduled' THEN");
    expect(batchLock).toBeGreaterThan(-1);
    expect(statusCheck).toBeGreaterThan(batchLock);
    expect(cattleFn).toContain("'reason', 'not_scheduled'");
  });

  it('preserves the migration-100 return shapes and reason strings', () => {
    for (const token of ["'reason', 'bad_args'", "'reason', 'no_batch'", "'event_id', v_ae_id"]) {
      expect(cattleFn).toContain(token);
      expect(sheepFn).toContain(token);
    }
    expect(cattleFn).toContain("'reason', 'unscheduled'");
    expect(cattleFn).toContain("'cattle_unlinked', v_unlinked");
    expect(cattleFn).toContain("'prior_status', v_status");
    expect(sheepFn).toContain("'reason', 'deleted'");
    expect(sheepFn).toContain("'sheep_unlinked', v_unlinked");
  });

  it('does not change role gates, lifecycle semantics, or client-facing names', () => {
    // No farm_team/light widening in either function.
    expect(cattleFn).not.toMatch(/'farm_team'|'light'|'equipment_tech'/);
    expect(sheepFn).not.toMatch(/'farm_team'|'light'|'equipment_tech'/);
    // Sheep delete stays status-agnostic (delete allowed regardless of status),
    // exactly as migration 100 behaved.
    expect(sheepFn).not.toContain('not_scheduled');
  });

  it('reloads PostgREST', () => {
    expect(mig179).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

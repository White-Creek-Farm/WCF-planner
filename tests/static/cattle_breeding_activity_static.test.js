import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const viewSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBreedingView.jsx'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/cattleBreedingCycleApi.js'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const activityViewSrc = fs.readFileSync(path.join(ROOT, 'src/activity/ActivityLogView.jsx'), 'utf8');
const mig078 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/078_cattle_breeding_activity_entity.sql'), 'utf8');
const mig094 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/094_audited_rpc_followups.sql'), 'utf8');

describe('Custom editable-table Activity - cattle breeding cycles', () => {
  it('CattleBreedingView saves and deletes cycles through audited RPC wrappers', () => {
    expect(viewSrc).toContain("from '../lib/cattleBreedingCycleApi.js'");
    expect(viewSrc).toContain('upsertCattleBreedingCycle(sb');
    expect(viewSrc).toContain('deleteCattleBreedingCycle(sb');
  });

  it('CattleBreedingView no longer does direct breeding-cycle mutations or best-effort Activity', () => {
    expect(viewSrc).not.toContain('recordBreedingActivity');
    expect(viewSrc).not.toContain('recordActivityEvent');
    expect(viewSrc).not.toMatch(/from\('cattle_breeding_cycles'\)[\s\S]{0,180}\.(insert|update|delete)\(/);
  });

  it('client wrapper calls the cattle breeding RPCs', () => {
    expect(apiSrc).toMatch(/export async function upsertCattleBreedingCycle/);
    expect(apiSrc).toContain("sb.rpc('upsert_cattle_breeding_cycle'");
    expect(apiSrc).toMatch(/export async function deleteCattleBreedingCycle/);
    expect(apiSrc).toContain("sb.rpc('delete_cattle_breeding_cycle'");
  });

  it('registry + global Activity recognize the cattle.breeding entity', () => {
    expect(registrySrc).toContain("CATTLE_BREEDING: 'cattle.breeding'");
    expect(registrySrc).toMatch(/CATTLE_BREEDING\]: \{[\s\S]*?route: \(\) => '\/cattle\/breeding'/);
    expect(activityViewSrc).toContain("'cattle.breeding': 'Cattle Breeding'");
  });
});

describe('CattleBreedingView — mounts the cattle.breeding Activity stream', () => {
  it('imports the shared collaboration section', () => {
    expect(viewSrc).toContain("from '../shared/RecordCollaborationSection.jsx'");
  });
  it('renders the cattle.breeding workflow stream (audit-only, no comments)', () => {
    expect(viewSrc).toContain('data-cattle-breeding-activity');
    expect(viewSrc).toMatch(/<RecordCollaborationSection[\s\S]*?entityType="cattle\.breeding"/);
    expect(viewSrc).toMatch(/<RecordCollaborationSection[\s\S]*?entityId="cattle-breeding"/);
    expect(viewSrc).toMatch(/<RecordCollaborationSection[\s\S]*?showComments=\{false\}/);
  });
  it('does not reintroduce legacy ActivityPanel/ActivityModal', () => {
    expect(viewSrc).not.toContain('ActivityPanel');
    expect(viewSrc).not.toContain('ActivityModal');
  });
});

describe('mig 078 - _activity_can_read cattle.breeding branch', () => {
  it('replaces _activity_can_read and adds a cattle.breeding branch gated on cattle program', () => {
    expect(mig078).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_can_read/);
    expect(mig078).toMatch(/IF p_entity_type = 'cattle\.breeding' THEN[\s\S]*?RETURN 'cattle' = ANY\(v_access\)/);
  });
  it('preserves the prior cattle.forecast + weighin.session branches (full-replace)', () => {
    expect(mig078).toContain("IF p_entity_type = 'cattle.forecast' THEN");
    expect(mig078).toContain("IF p_entity_type = 'weighin.session' THEN");
  });
  it('keeps anon revoked + authenticated granted and reloads PostgREST', () => {
    expect(mig078).toMatch(/REVOKE ALL ON FUNCTION public\._activity_can_read\(text, text\) FROM PUBLIC, anon/);
    expect(mig078).toMatch(/GRANT EXECUTE ON FUNCTION public\._activity_can_read\(text, text\) TO authenticated/);
    expect(mig078).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('mig 094 - cattle breeding cycle audited RPCs', () => {
  it('defines SECURITY DEFINER upsert/delete functions with pinned search_path', () => {
    expect(mig094).toMatch(/CREATE OR REPLACE FUNCTION public\.upsert_cattle_breeding_cycle/);
    expect(mig094).toMatch(/CREATE OR REPLACE FUNCTION public\.delete_cattle_breeding_cycle/);
    expect(mig094).toMatch(/SECURITY DEFINER/);
    expect(mig094).toMatch(/SET search_path = public/);
  });

  it('requires authenticated active callers and validates the required start date', () => {
    expect(mig094).toMatch(/upsert_cattle_breeding_cycle: authenticated caller required/);
    expect(mig094).toMatch(/delete_cattle_breeding_cycle: authenticated caller required/);
    expect(mig094).toMatch(/v_role IS NULL OR v_role = 'inactive'/);
    expect(mig094).toMatch(/bull exposure start required/);
  });

  it('mutates cattle_breeding_cycles and logs cattle.breeding Activity in the same transaction', () => {
    expect(mig094).toMatch(/INSERT INTO public\.cattle_breeding_cycles/);
    expect(mig094).toMatch(/UPDATE public\.cattle_breeding_cycles/);
    expect(mig094).toMatch(/DELETE FROM public\.cattle_breeding_cycles/);
    expect(mig094).toContain('INSERT INTO public.activity_events');
    expect(mig094).toContain("'cattle.breeding'");
    expect(mig094).toContain("'cattle-breeding'");
    expect(mig094).toContain("'record.created'");
    expect(mig094).toContain("'field.updated'");
    expect(mig094).toContain("'record.deleted'");
  });

  it('REVOKEs anon and GRANTs authenticated for both cattle breeding RPCs', () => {
    expect(mig094).toMatch(
      /REVOKE ALL ON FUNCTION public\.upsert_cattle_breeding_cycle\(text, text, date, text, text, text\) FROM PUBLIC, anon/,
    );
    expect(mig094).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.upsert_cattle_breeding_cycle\(text, text, date, text, text, text\) TO authenticated/,
    );
    expect(mig094).toMatch(/REVOKE ALL ON FUNCTION public\.delete_cattle_breeding_cycle\(text\) FROM PUBLIC, anon/);
    expect(mig094).toMatch(/GRANT EXECUTE ON FUNCTION public\.delete_cattle_breeding_cycle\(text\) TO authenticated/);
  });
});

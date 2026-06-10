import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig094 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/094_audited_rpc_followups.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/sheepLambingApi.js'), 'utf8');
const animalSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepAnimalPage.jsx'), 'utf8');

describe('mig 094 - delete_sheep_lambing_record RPC', () => {
  it('is SECURITY DEFINER with pinned search_path', () => {
    expect(mig094).toMatch(/CREATE OR REPLACE FUNCTION public\.delete_sheep_lambing_record[\s\S]*?SECURITY DEFINER/);
    expect(mig094).toMatch(/SET search_path = public/);
  });

  it('requires an authenticated active caller but is not admin-only', () => {
    expect(mig094).toMatch(/delete_sheep_lambing_record: authenticated caller required/);
    expect(mig094).toMatch(/v_role IS NULL OR v_role = 'inactive'/);
    expect(mig094).not.toMatch(/delete_sheep_lambing_record[\s\S]*?admin role required/);
  });

  it('deletes the row and logs record.deleted Activity scoped to the dam in one transaction', () => {
    expect(mig094).toMatch(/DELETE FROM public\.sheep_lambing_records WHERE id = p_record_id/);
    expect(mig094).toContain("'record.deleted'");
    expect(mig094).toContain("'sheep.animal'");
    expect(mig094).toContain('INSERT INTO public.activity_events');
    expect(mig094).toMatch(/FROM public\.sheep\s+WHERE tag = v_dam_tag AND deleted_at IS NULL/);
  });

  it('returns not_found without writing when the record is gone', () => {
    expect(mig094).toMatch(/IF NOT FOUND THEN[\s\S]*?'not_found'/);
  });

  it('REVOKEs anon and GRANTs authenticated; reloads PostgREST', () => {
    expect(mig094).toMatch(
      /REVOKE ALL ON FUNCTION public\.delete_sheep_lambing_record\(text, text\) FROM PUBLIC, anon/,
    );
    expect(mig094).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.delete_sheep_lambing_record\(text, text\) TO authenticated/,
    );
    expect(mig094).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('sheepLambingApi + record-page wiring', () => {
  it('exports deleteSheepLambingRecord calling the RPC', () => {
    expect(apiSrc).toMatch(/export async function deleteSheepLambingRecord/);
    expect(apiSrc).toContain("sb.rpc('delete_sheep_lambing_record'");
  });

  it('SheepAnimalPage deletes lambing records via the RPC, not a client delete', () => {
    expect(animalSrc).toContain('deleteSheepLambingRecord(sb, recId');
    const fn = animalSrc.match(/async function deleteLambingRecord\([\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).not.toMatch(/from\('sheep_lambing_records'\)\.delete\(\)/);
  });
});

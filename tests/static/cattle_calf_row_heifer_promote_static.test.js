import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const migrationSrc = fs.readFileSync(
  path.join(ROOT, 'supabase-migrations/110_cattle_calf_row_heifer_promote.sql'),
  'utf8',
);

describe('migration 110 - calf-row dam evidence promotes heifers', () => {
  it('adds a cattle-row trigger for new or changed dam_tag values', () => {
    expect(migrationSrc).toContain('cattle_promote_heifer_from_calf_row');
    expect(migrationSrc).toMatch(/AFTER INSERT OR UPDATE OF dam_tag ON public\.cattle/);
    expect(migrationSrc).toContain('EXECUTE FUNCTION public.cattle_promote_heifer_from_calf_row()');
  });

  it('promotes only heifer dams and writes a calving-source audit comment', () => {
    expect(migrationSrc).toContain("v_dam_sex <> 'heifer'");
    expect(migrationSrc).toMatch(/UPDATE public\.cattle\s+SET sex = 'cow'/);
    expect(migrationSrc).toContain(
      "'Automatically promoted from heifer to cow after calf row was linked to this dam.'",
    );
    expect(migrationSrc).toContain("'calving'");
    expect(migrationSrc).toContain('NEW.id');
  });

  it('matches retag-aware dam tags but excludes import purchase tags', () => {
    expect(migrationSrc).toContain("ot->>'tag' = v_dam_tag");
    expect(migrationSrc).toContain("COALESCE(ot->>'source', '') <> 'import'");
  });

  it('backfills existing heifers with linked calf rows idempotently', () => {
    expect(migrationSrc).toContain('existing calf row linked to this dam');
    expect(migrationSrc).toMatch(/dam\.sex = 'heifer'[\s\S]*?EXISTS \(/);
    expect(migrationSrc).toContain('calf.dam_tag = dam.tag');
  });
});

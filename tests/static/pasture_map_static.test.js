import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {VIEW_TO_PATH, PATH_TO_VIEW} from '../../src/lib/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig = read('supabase-migrations/116_pasture_map_land_areas.sql');
const mainSrc = read('src/main.jsx');
const viewSrc = read('src/pasture/PastureMapView.jsx');

describe('Pasture Map route + wiring', () => {
  it('registers the canonical /pasture-map path', () => {
    expect(VIEW_TO_PATH.pastureMap).toBe('/pasture-map');
    expect(PATH_TO_VIEW['/pasture-map']).toBe('pastureMap');
  });

  it('main.jsx imports, allows, renders, and excludes Light from the view', () => {
    expect(mainSrc).toContain("import PastureMapView from './pasture/PastureMapView.jsx'");
    expect(mainSrc).toMatch(/VALID_VIEWS\s*=\s*\[[\s\S]*?'pastureMap'/);
    expect(mainSrc).toContain("if (view === 'pastureMap')");
    const lightAllowedBlock = mainSrc.match(/const LIGHT_ALLOWED_VIEWS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
    expect(lightAllowedBlock).not.toContain("'pastureMap'");
  });
});

describe('Migration 116 — RLS / SECDEF / access', () => {
  it('all three tables are deny-all RLS with no direct anon/authenticated grants', () => {
    for (const t of ['land_areas', 'land_area_geometry_versions', 'pasture_import_batches']) {
      expect(mig).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
      expect(mig).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM PUBLIC, anon, authenticated`));
    }
    expect(mig).toContain('FOR ALL USING (false)');
  });

  it('client RPCs are SECURITY DEFINER and granted to authenticated only', () => {
    for (const fn of [
      'import_land_area_batch',
      'list_land_areas',
      'update_land_area',
      'close_land_area_outline',
      'delete_land_area',
    ]) {
      expect(mig).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(mig).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`));
    }
    expect(mig).toContain("v_role NOT IN ('farm_team', 'management', 'admin')");
  });
});

describe('Migration 116 — CP1 invariants', () => {
  it("kind CHECK includes 'unclassified' and import defaults polygons to it", () => {
    expect(mig).toMatch(/kind IN \([^)]*'unclassified'/);
    expect(mig).toContain("v_kind  := 'unclassified';");
  });

  it('LineStrings are NEVER auto-closed (import sets outline_candidate)', () => {
    expect(mig).toContain("v_kind  := 'outline_candidate';");
    expect(mig).toContain("v_gstatus := 'outline_candidate';");
  });

  it('parent assignment has a recursive-CTE cycle guard (A>B rejects B>A)', () => {
    expect(mig).toMatch(/WITH RECURSIVE ancestors/);
    expect(mig).toContain('parent assignment would create a cycle');
  });

  it('close reclassifies only outline candidates or fixed-invalid polygons', () => {
    expect(mig).toMatch(/v_row\.kind = 'outline_candidate' OR v_row\.geometry_status = 'invalid'/);
  });

  it('import creates the batch row BEFORE the loop so the FK resolves', () => {
    const lockIdx = mig.indexOf("pg_advisory_xact_lock(hashtext('land_areas_import')");
    const batchInsertIdx = mig.indexOf('INSERT INTO public.pasture_import_batches');
    const loopIdx = mig.indexOf('FOR v_pm IN SELECT * FROM jsonb_array_elements(p_placemarks)');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(batchInsertIdx).toBeGreaterThan(lockIdx);
    expect(batchInsertIdx).toBeLessThan(loopIdx);
  });

  it('acreage is geodesic (geography cast), not planar', () => {
    expect(mig).toMatch(/ST_Area\(p_geom::extensions\.geography\)/);
  });
});

describe('Pasture Map view — CP1 scope boundary', () => {
  it('only imports pasture-scoped data modules (no daily/move wiring in CP1)', () => {
    const libImports = [...viewSrc.matchAll(/import\s[^;]*?from\s+'(\.\.\/lib\/[^']+)'/g)].map((m) => m[1]);
    expect(libImports.length).toBeGreaterThan(0);
    expect(libImports.every((p) => /pastureMapApi|pastureKml/.test(p))).toBe(true);
  });

  it('exposes import + classify + close-outline actions', () => {
    expect(viewSrc).toContain('Import OnX KML');
    expect(viewSrc).toContain('Close outline');
    expect(viewSrc).toContain('classifyLandArea');
  });
});

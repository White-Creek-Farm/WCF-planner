import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {VIEW_TO_PATH, PATH_TO_VIEW} from '../../src/lib/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig = read('supabase-migrations/116_pasture_map_land_areas.sql');
const mig127 = read('supabase-migrations/127_pasture_map_draw_edit.sql');
const mig128 = read('supabase-migrations/128_pasture_map_move_ledger.sql');
const mig129 = read('supabase-migrations/129_pasture_map_planning_reports.sql');
const mig130 = read('supabase-migrations/130_pasture_map_field_tracks.sql');
const mig131 = read('supabase-migrations/131_pasture_map_line_style.sql');
const mig132 = read('supabase-migrations/132_pasture_map_line_patterns_and_defaults.sql');
const mig135 = read('supabase-migrations/135_pasture_map_temp_paddocks.sql');
// mig 135 with -- line comments stripped, so negative guards check SQL, not the
// header docs (which legitimately quote the sentinel copy, "light", "temp", etc).
const mig135Code = mig135.replace(/--[^\n]*/g, '');
const mainSrc = read('src/main.jsx');
const homeSrc = read('src/dashboard/HomeDashboard.jsx');
const viewSrc = read('src/pasture/PastureMapView.jsx');
const canvasSrc = read('src/pasture/PastureMapCanvas.jsx');
const pastureCss = read('src/pasture/pastureMap.css');
const apiSrc = read('src/lib/pastureMapApi.js');
const offlineSrc = read('src/lib/pastureOffline.js');
const pasturePwConfig = read('playwright.pasture.config.js');

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

  it('home page exposes the Pasture Map field button', () => {
    const fieldBlock = homeSrc.slice(homeSrc.indexOf('field-tools'), homeSrc.indexOf('Utility row'));
    expect(fieldBlock).toContain("setView('pastureMap')");
    expect(fieldBlock).toContain('Pasture Map');
    expect(fieldBlock).toContain('HomeWeatherCard');
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

describe('Pasture Map view - CP1/CP3 scope boundary', () => {
  it('uses the shared app Header instead of a pasture-only topbar', () => {
    expect(viewSrc).toMatch(/export default function PastureMapView\(\{Header, authState\}\)/);
    expect(viewSrc).toContain('{Header ? <Header /> : null}');
    expect(viewSrc).not.toContain('className="pm-topbar"');
    expect(viewSrc).not.toContain('<h1 className="pm-title">WCF Planner</h1>');
    expect(pastureCss).not.toContain('.pm-topbar');
  });

  it('keeps top mode tabs black until the selected filled pill turns white-on-black', () => {
    const tabButtonBlock = pastureCss.match(/\.pm-tabs button \{[\s\S]*?\n\}/)?.[0] || '';
    const activeTabBlock = pastureCss.match(/\.pm-tabs button\.is-active \{[\s\S]*?\n\}/)?.[0] || '';

    expect(tabButtonBlock).toContain('color: #000;');
    expect(activeTabBlock).toContain('background: #000;');
    expect(activeTabBlock).toContain('color: #fff;');
  });

  it('only imports pasture-scoped data modules (no daily report coupling)', () => {
    const libImports = [...viewSrc.matchAll(/import\s[^;]*?from\s+'(\.\.\/lib\/[^']+)'/g)].map((m) => m[1]);
    expect(libImports.length).toBeGreaterThan(0);
    expect(
      libImports.every((p) => /pastureMapApi|pastureKml|pastureOffline|pastureGeometry|pasturePlannerGroups/.test(p)),
    ).toBe(true);
  });

  it('exposes import + classify + close-outline actions', () => {
    expect(viewSrc).toContain('Import OnX KML');
    expect(viewSrc).toContain('Close outline');
    expect(viewSrc).toContain('classifyLandArea');
  });
});

describe('Migration 127 — CP2 draw/edit RPCs', () => {
  it('create_land_area + update_land_area_geometry are SECDEF, authenticated-only, mgmt/admin gated', () => {
    for (const fn of ['create_land_area', 'update_land_area_geometry']) {
      expect(mig127).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(mig127).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`));
    }
    expect(mig127).toContain("v_role NOT IN ('management', 'admin')");
  });

  it('reuses the append-only version helper and rejects invalid polygons', () => {
    expect(mig127).toContain('_land_area_add_version');
    expect(mig127).toMatch(/ST_IsValid/);
  });

  it('an edited area records its new version as a human draw, not the original source', () => {
    expect(mig127).toMatch(/_land_area_add_version\(\s*p_id,\s*v_geom,\s*'drawn'/);
    expect(mig127).toContain("'origin_source', v_row.source");
  });
});

describe('CP2 API wrappers + draw/edit UI', () => {
  it('pastureMapApi exposes create/update-geometry wrappers over the mig 127 RPCs', () => {
    expect(apiSrc).toContain('export async function createLandArea');
    expect(apiSrc).toContain('export async function updateLandAreaGeometry');
    expect(apiSrc).toContain('export function newLandAreaId');
    expect(apiSrc).toContain("sb.rpc('create_land_area'");
    expect(apiSrc).toContain("sb.rpc('update_land_area_geometry'");
  });

  it('view has move/select/draw/edit/measure modes and an in-app name+kind save form', () => {
    for (const m of ['move', 'select', 'draw', 'edit', 'measure']) {
      expect(viewSrc).toContain(`data-mode="${m}"`);
    }
    expect(viewSrc).toContain('data-pasture-drawform-name');
    expect(viewSrc).toContain('data-pasture-drawform-kind');
    expect(viewSrc).toContain('createLandArea');
    expect(viewSrc).toContain('updateLandAreaGeometry');
  });

  it('keeps a completed draw visible while the save form is open', () => {
    const createHandler = canvasSrc.match(/map\.on\('pm:create'[\s\S]*?cbRef\.current\.onDrawComplete/)?.[0] || '';
    const drawBranch = createHandler.match(/} else \{[\s\S]*?cbRef\.current\.onDrawComplete/)?.[0] || '';
    expect(drawBranch).toContain('tempRef.current = layer');
    expect(drawBranch).not.toContain('map.removeLayer(layer)');
  });

  it('uses NO raw browser alert/confirm/prompt in the view or canvas', () => {
    for (const src of [viewSrc, canvasSrc]) {
      expect(src).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
    }
  });

  it('disables Edit for selections without a polygon (outline candidates must be closed first)', () => {
    expect(viewSrc).toContain('function hasPolygonGeom');
    expect(viewSrc).toContain('!selectedEditable');
  });
});

describe('Migration 128 - CP3 move ledger / occupancy / rest', () => {
  it('adds append-only move tables with deny-all RLS and no direct grants', () => {
    for (const t of ['pasture_move_events', 'pasture_move_impacts']) {
      expect(mig128).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
      expect(mig128).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
      expect(mig128).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM PUBLIC, anon, authenticated`));
      expect(mig128).toContain('FOR ALL USING (false)');
    }
  });

  it('keeps animal groups decoupled from land and livestock tables', () => {
    expect(mig128).toContain("animal_type IN ('cattle_herd', 'sheep_flock'");
    expect(mig128).toContain('group_key');
    expect(mig128).toContain('group_label');
    expect(mig128).not.toMatch(/REFERENCES public\.(?:cattle|sheep|pig|pigs|app_store)/);
  });

  it('records destination, overlap, and departure impacts for rest resets', () => {
    for (const kind of ["'destination'", "'overlap'", "'departure'"]) {
      expect(mig128).toContain(kind);
    }
    expect(mig128).toContain('ST_Intersects');
    expect(mig128).toContain('baseline_no_history = false');
  });

  it('exposes move RPCs as SECDEF authenticated-only and farm-team readable/writeable', () => {
    for (const fn of ['list_pasture_moves', 'record_pasture_move']) {
      expect(mig128).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(mig128).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)\\s+TO authenticated`));
    }
    expect(mig128).toContain("v_role NOT IN ('farm_team', 'management', 'admin')");
    expect(mig128).toContain('feeder pig area already occupied');
  });

  it('extends land area summaries with current occupancy and rest state', () => {
    for (const field of [
      'current_occupants',
      'current_occupancy_count',
      'last_touched_at',
      'last_moved_out_at',
      'rest_days',
      'rest_state',
    ]) {
      expect(mig128).toContain(field);
    }
  });
});

describe('CP3 API + UI wiring', () => {
  it('pastureMapApi wraps the CP3 move RPCs and ids', () => {
    expect(apiSrc).toContain('export function newPastureMoveId');
    expect(apiSrc).toContain('export async function listPastureMoves');
    expect(apiSrc).toContain('export async function recordPastureMove');
    expect(apiSrc).toContain("sb.rpc('list_pasture_moves'");
    expect(apiSrc).toContain("sb.rpc('record_pasture_move'");
  });

  it('view renders move form, occupancy, rest, and recent moves without raw browser prompts', () => {
    for (const marker of [
      'data-pasture-selected-panel',
      'data-pasture-move-form',
      'data-pasture-move-save',
      'data-pasture-occupancy',
      'data-pasture-rest-state',
      'data-pasture-recent-moves',
    ]) {
      expect(viewSrc).toContain(marker);
    }
    expect(viewSrc).toContain('recordPastureMove');
    expect(viewSrc).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  });

  it('canvas colors by CP3 occupancy/rest state', () => {
    for (const marker of ['rest_state', 'current_occupancy_count', 'occupied', 'resting', 'rested', 'baseline']) {
      expect(canvasSrc).toContain(marker);
    }
  });

  it('allows field-level over-zoom on NAIP imagery', () => {
    expect(canvasSrc).toContain('const MAP_MAX_ZOOM = 26');
    expect(canvasSrc).toContain('const IMAGERY_NATIVE_MAX_ZOOM = 19');
    expect(canvasSrc).toContain('maxNativeZoom: IMAGERY_NATIVE_MAX_ZOOM');
    expect(canvasSrc).toContain('maxZoom: MAP_MAX_ZOOM');
    expect(canvasSrc).toContain('zoomSnap: 0.25');
  });

  it('does not refit the map on occupancy-only refreshes', () => {
    expect(canvasSrc).toContain('fitSignatureRef');
    expect(canvasSrc).toContain('fitSignature !== fitSignatureRef.current');
  });
});

describe('Migration 129 - CP4 planned moves / reports', () => {
  it('adds planned moves with deny-all RLS and no direct grants', () => {
    expect(mig129).toContain('CREATE TABLE IF NOT EXISTS public.pasture_planned_moves');
    expect(mig129).toContain('ALTER TABLE public.pasture_planned_moves ENABLE ROW LEVEL SECURITY');
    expect(mig129).toMatch(/REVOKE ALL ON TABLE public\.pasture_planned_moves FROM PUBLIC, anon, authenticated/);
    expect(mig129).toContain('FOR ALL USING (false)');
  });

  it('keeps planned animal groups decoupled from livestock tables', () => {
    expect(mig129).toContain("animal_type IN ('cattle_herd', 'sheep_flock'");
    expect(mig129).toContain('group_key');
    expect(mig129).toContain('group_label');
    expect(mig129).not.toMatch(/REFERENCES public\.(?:cattle|sheep|pig|pigs|app_store)/);
  });

  it('exposes CP4 RPCs as SECDEF authenticated-only farm-team-readable/writeable APIs', () => {
    for (const fn of [
      'list_pasture_planned_moves',
      'create_pasture_planned_move',
      'update_pasture_planned_move_status',
      'list_pasture_history_report',
      'list_pasture_rest_report',
      'list_pasture_stocking_report',
    ]) {
      expect(mig129).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(mig129).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)\\s+TO authenticated`));
    }
    expect(mig129).toContain("v_role NOT IN ('farm_team', 'management', 'admin')");
  });

  it('reports paddock/group history, rest state, and animal-days per acre', () => {
    expect(mig129).toContain('list_pasture_history_report');
    expect(mig129).toContain('list_pasture_rest_report');
    expect(mig129).toContain('list_pasture_stocking_report');
    expect(mig129).toContain('animal_days_per_acre');
    expect(mig129).toContain('impact_kind IN (');
  });
});

describe('CP4 API + UI wiring', () => {
  it('pastureMapApi wraps planned move and report RPCs', () => {
    for (const marker of [
      'newPasturePlanId',
      'listPasturePlannedMoves',
      'createPasturePlannedMove',
      'updatePasturePlannedMoveStatus',
      'listPastureHistoryReport',
      'listPastureRestReport',
      'listPastureStockingReport',
    ]) {
      expect(apiSrc).toContain(marker);
    }
  });

  it('view renders CP4 forms/reports and same-day prompt without raw browser prompts', () => {
    for (const marker of [
      'data-pasture-plan-form',
      'data-pasture-plan-save',
      'data-pasture-planned-moves',
      'data-pasture-same-day-prompt',
      'data-pasture-density',
      'data-pasture-use-facts',
      'data-pasture-history-report',
      'data-pasture-rest-report',
      'data-pasture-stocking-report',
    ]) {
      expect(viewSrc).toContain(marker);
    }
    expect(viewSrc).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  });

  it('shows exact rested day counts instead of threshold text', () => {
    expect(viewSrc).toContain('area.rest_days');
    expect(viewSrc).toMatch(/area\.rest_days[\s\S]{0,140}rested/);
    expect(viewSrc).not.toMatch(/Rested\s+\d+\+\s+days/);
  });

  it('pasture Playwright lane includes CP4 coverage', () => {
    expect(pasturePwConfig).toContain('pasture_map_cp4.spec.js');
  });
});

describe('Migration 130 - CP6 field GPS tracks', () => {
  it('adds a field-track RPC that saves LineStrings as outline candidates', () => {
    expect(mig130).toContain('CREATE OR REPLACE FUNCTION public.create_land_area_track');
    expect(mig130).toContain("v_role NOT IN ('farm_team', 'management', 'admin')");
    expect(mig130).toContain("v_gtype NOT IN ('ST_LineString', 'ST_MultiLineString')");
    expect(mig130).toContain("'outline_candidate'");
    expect(mig130).toContain('ST_NPoints');
    expect(mig130).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_land_area_track\(text, text, jsonb, text\)\s+TO authenticated/,
    );
  });
});

describe('CP6 API + UI wiring', () => {
  it('pastureMapApi wraps the field-track RPC and id', () => {
    expect(apiSrc).toContain('export function newPastureTrackId');
    expect(apiSrc).toContain('export async function createLandAreaTrack');
    expect(apiSrc).toContain("sb.rpc('create_land_area_track'");
  });

  it('renders mobile field-track controls and map preview wiring', () => {
    for (const marker of [
      'data-mode="track"',
      'data-pasture-track-panel',
      'data-pasture-track-start',
      'data-pasture-track-stop',
      'data-pasture-track-save',
      'trackGeometry={activeTrackGeometry}',
    ]) {
      expect(viewSrc).toContain(marker);
    }
    expect(viewSrc).toContain('navigator.geolocation.watchPosition');
    expect(canvasSrc).toContain('trackGeometry');
  });

  it('pasture Playwright lane includes CP6 coverage', () => {
    expect(pasturePwConfig).toContain('pasture_map_cp6.spec.js');
  });
});

describe('Migration 131 - CP7 boundary line styling', () => {
  it('adds constrained line_color / line_weight fields and exposes them in summaries', () => {
    expect(mig131).toContain('ADD COLUMN IF NOT EXISTS line_color text');
    expect(mig131).toContain('ADD COLUMN IF NOT EXISTS line_weight integer');
    expect(mig131).toContain('land_areas_line_color_check');
    expect(mig131).toContain('land_areas_line_weight_check');
    expect(mig131).toContain("'line_color', a.line_color");
    expect(mig131).toContain("'line_weight', a.line_weight");
    expect(mig131).toContain("'current_occupants', v_current");
    expect(mig131).toContain("'rest_state', v_rest_state");
  });

  it('extends update_land_area with authenticated manager/admin style args', () => {
    expect(mig131).toContain('p_line_color');
    expect(mig131).toContain('p_line_weight');
    expect(mig131).toContain('p_clear_line_style');
    expect(mig131).toContain("v_role NOT IN ('management', 'admin')");
    expect(mig131).toMatch(/GRANT EXECUTE ON FUNCTION public\.update_land_area\([^)]*\)\s+TO authenticated/);
    expect(mig131).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe('Migration 132 - CP8 line patterns and defaults', () => {
  it('adds constrained line_pattern and exposes it in summaries', () => {
    expect(mig132).toContain('ADD COLUMN IF NOT EXISTS line_pattern text');
    expect(mig132).toContain('land_areas_line_pattern_check');
    expect(mig132).toContain("'line_pattern', a.line_pattern");
    expect(mig132).toContain("'current_occupants', v_current");
    expect(mig132).toContain("'rest_state', v_rest_state");
  });

  it('restyles imported OnX lines and defaults field tracks to white dashed 5px', () => {
    expect(mig132).toContain("source = 'onx_kml'");
    expect(mig132).toContain("IN ('ST_LineString', 'ST_MultiLineString')");
    expect(mig132).toContain("line_color = '#dc2626'");
    expect(mig132).toContain('line_weight = 5');
    expect(mig132).toContain("line_pattern = 'solid'");
    expect(mig132).toContain("'#ffffff', 5, 'dashed'");
  });

  it('exposes a dedicated authenticated manager/admin line-style RPC', () => {
    expect(mig132).toContain('CREATE OR REPLACE FUNCTION public.update_land_area_line_style');
    expect(mig132).toContain('p_line_color');
    expect(mig132).toContain('p_line_weight');
    expect(mig132).toContain('p_line_pattern');
    expect(mig132).toContain("v_role NOT IN ('management', 'admin')");
    expect(mig132).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.update_land_area_line_style\(text, text, integer, text, boolean\)\s+TO authenticated/,
    );
    expect(mig132).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe('CP7 API + UI wiring', () => {
  it('pastureMapApi wraps line style updates over update_land_area_line_style', () => {
    expect(apiSrc).toContain('export async function updateLandAreaStyle');
    expect(apiSrc).toContain("sb.rpc('update_land_area_line_style'");
    expect(apiSrc).toContain('p_line_color');
    expect(apiSrc).toContain('p_line_weight');
    expect(apiSrc).toContain('p_line_pattern');
    expect(apiSrc).toContain('p_clear');
  });

  it('canvas applies optional line_color / line_weight / line_pattern stroke overrides', () => {
    expect(canvasSrc).toContain('line_color');
    expect(canvasSrc).toContain('line_weight');
    expect(canvasSrc).toContain('line_pattern');
    expect(canvasSrc).toContain('applyLineStyle');
    expect(canvasSrc).toContain("dashed: '10,8'");
    expect(canvasSrc).toContain("color: '#ffffff', weight: 5");
    expect(canvasSrc).toContain("color: '#dc2626', weight: 5");
  });

  it('baseline / no-history pastures render solid by default (no forced dashArray)', () => {
    // A missing move history is not an outline candidate. The baseline/no_history
    // branch must NOT hardcode a dash; dashed is reserved for outline candidates,
    // retired/invalid states, GPS field tracks, and explicit line_pattern='dashed'.
    const baselineBranch = canvasSrc.match(/rest_state === 'baseline'[\s\S]*?fillOpacity: 0\.08\}\)/);
    expect(baselineBranch).toBeTruthy();
    expect(baselineBranch[0]).not.toContain('dashArray');
    // Explicit saved line_pattern='dashed' still maps to a dash via applyLineStyle.
    expect(canvasSrc).toContain("dashed: '10,8'");
    // Outline candidates remain intentionally dashed.
    expect(canvasSrc).toMatch(/outline_candidate[\s\S]*?dashArray: '6,6'/);
  });

  it('view renders manager line-style controls and list chips', () => {
    for (const marker of [
      'data-pasture-style-panel',
      'data-pasture-style-color',
      'data-pasture-style-pattern',
      'data-pasture-style-weight',
      'data-pasture-style-weight-number',
      'data-pasture-style-save',
      'data-pasture-style-reset',
      'data-pasture-line-style',
      'data-pasture-editbar-exit',
    ]) {
      expect(viewSrc).toContain(marker);
    }
    expect(viewSrc).toContain('LINE_STYLE_COLORS');
    expect(viewSrc).toContain('LINE_STYLE_PATTERNS');
    expect(viewSrc).toContain('Exit edit');
  });

  it('pasture Playwright lane includes CP7 coverage', () => {
    expect(pasturePwConfig).toContain('pasture_map_cp7.spec.js');
  });
});

describe('CP5 offline field use wiring', () => {
  it('reuses the shared offline queue owner instead of opening IndexedDB directly', () => {
    expect(offlineSrc).toContain("from './offlineQueue.js'");
    expect(offlineSrc).not.toMatch(/from 'idb'/);
    expect(offlineSrc).not.toMatch(/\bopenDB\s*\(/);
    expect(offlineSrc).not.toMatch(/\bindexedDB\b/);
    expect(offlineSrc).toContain("PASTURE_OFFLINE_FORM_KIND = 'pasture_map'");
  });

  it('caches vector outlines separately from imagery and does not cache map tiles', () => {
    expect(offlineSrc).toContain('PASTURE_VECTOR_CACHE_KEY');
    expect(offlineSrc).toContain('cachePastureSnapshot');
    expect(offlineSrc).toContain('loadPastureSnapshot');
    expect(offlineSrc).not.toMatch(/tile|NAIP|Imagery|cacheStorage|caches\.open/i);
  });

  it('queues move logging, field-created paddocks, temp paddocks, and field tracks', () => {
    expect(offlineSrc).toContain("op === 'record_move'");
    expect(offlineSrc).toContain("op === 'create_area'");
    expect(offlineSrc).toContain("op === 'create_temp_area'");
    expect(offlineSrc).toContain("op === 'create_track'");
    expect(viewSrc).toContain("op: 'record_move'");
    expect(viewSrc).toContain("op: 'create_area'");
    // A walked temp paddock queues as create_temp_area; a 2-point trace as create_track.
    expect(viewSrc).toContain("? 'create_temp_area' : 'create_track'");
    expect(viewSrc).toContain('queued_offline');
  });

  it('renders offline field status and queue controls', () => {
    for (const marker of ['data-pasture-offline-panel', 'data-pasture-offline-queued', 'data-pasture-offline-stuck']) {
      expect(viewSrc).toContain(marker);
    }
  });

  it('pasture Playwright lane includes CP5 offline coverage', () => {
    expect(pasturePwConfig).toContain('pasture_map_cp5.spec.js');
  });
});

describe('P0 temp-paddock lifecycle (mig 135) API + role/occupancy contract', () => {
  it('mig 135 defines the temp lifecycle RPCs + internal occupancy helper', () => {
    for (const fn of [
      'FUNCTION public._land_area_is_occupied(p_id text)',
      'FUNCTION public.create_temp_land_area(',
      'FUNCTION public.update_temp_land_area_geometry(',
      'FUNCTION public.rename_temp_land_area(',
      'FUNCTION public.archive_land_area(',
      'FUNCTION public.restore_land_area(',
      'FUNCTION public.hard_delete_land_area(',
    ]) {
      expect(mig135).toContain('CREATE OR REPLACE ' + fn);
    }
  });

  it('temp paddock = kind=paddock + permanence=temporary (D1: no kind=temp)', () => {
    // The create INSERT sets kind='paddock' and permanence='temporary'.
    expect(mig135).toMatch(/INSERT INTO public\.land_areas[\s\S]*?'paddock', btrim\(p_name\), 'temporary'/);
    // No new kind='temp' is introduced (the table CHECK is untouched).
    expect(mig135Code).not.toMatch(/kind\b[^\n]*=\s*'temp'/);
    expect(mig135Code).not.toMatch(/'temp'\s*,/);
  });

  it('create_temp_land_area admits farm_team/management/admin; permanent create stays mgmt/admin', () => {
    expect(mig135).toMatch(/create_temp_land_area[\s\S]*?NOT IN \('farm_team', 'management', 'admin'\)/);
    // Regression: existing create_land_area is NOT loosened (D2).
    expect(mig127).toMatch(/create_land_area[\s\S]*?NOT IN \('management', 'admin'\)/);
  });

  it('temp edit/rename refuse non-temp areas and gate owner-or-manager', () => {
    for (const rpc of ['update_temp_land_area_geometry', 'rename_temp_land_area']) {
      const body = mig135.match(new RegExp(rpc + '\\([\\s\\S]*?\\$fn\\$;'))?.[0] || '';
      expect(body).toContain("permanence IS DISTINCT FROM 'temporary'");
      expect(body).toContain('created_by IS DISTINCT FROM v_caller');
    }
  });

  it('archive uses status=retired (restorable) and restore returns to active', () => {
    const archive = mig135.match(/archive_land_area\([\s\S]*?\$fn\$;/)?.[0] || '';
    const restore = mig135.match(/restore_land_area\([\s\S]*?\$fn\$;/)?.[0] || '';
    expect(archive).toContain("status = 'retired'");
    expect(restore).toContain("status = 'active'");
    // Archive does NOT use the deleted_at path (that is hard delete only).
    expect(archive).not.toContain('deleted_at = now()');
  });

  it('archive + hard delete block occupied areas with the PM_AREA_OCCUPIED sentinel', () => {
    for (const rpc of ['archive_land_area', 'hard_delete_land_area']) {
      const body = mig135.match(new RegExp(rpc + '\\([\\s\\S]*?\\$fn\\$;'))?.[0] || '';
      expect(body).toContain('public._land_area_is_occupied(p_id)');
      expect(body).toContain('PM_VALIDATION: PM_AREA_OCCUPIED');
    }
    // The human sentence is NOT hardcoded server-side; the client owns the copy.
    expect(mig135Code).not.toContain('Move animals out of this temp paddock');
  });

  it('hard delete is admin-only, detaches children, uses deleted_at (D3 no purge)', () => {
    const body = mig135.match(/hard_delete_land_area\([\s\S]*?\$fn\$;/)?.[0] || '';
    expect(body).toMatch(/v_role <> 'admin'/);
    expect(body).toContain('SET parent_id = NULL WHERE parent_id = p_id');
    expect(body).toContain('deleted_at = now(), deleted_by = v_caller');
    // v1 keeps geometry: no DELETE of land_area_geometry_versions / land_areas.
    expect(body).not.toMatch(/DELETE FROM public\.land_area/);
  });

  it('every new public RPC is granted to authenticated only (no anon/PUBLIC/light)', () => {
    for (const sig of [
      'create_temp_land_area(text, text, jsonb, text)',
      'update_temp_land_area_geometry(text, jsonb)',
      'rename_temp_land_area(text, text)',
      'archive_land_area(text)',
      'restore_land_area(text)',
      'hard_delete_land_area(text)',
    ]) {
      expect(mig135).toContain('REVOKE ALL ON FUNCTION public.' + sig + ' FROM PUBLIC, anon');
      expect(mig135).toContain('GRANT EXECUTE ON FUNCTION public.' + sig + ' TO authenticated');
    }
    expect(mig135Code).not.toMatch(/\blight\b/);
  });

  it('pastureMapApi wraps every temp lifecycle RPC + exports the occupancy sentinel', () => {
    expect(apiSrc).toContain("sb.rpc('create_temp_land_area'");
    expect(apiSrc).toContain("sb.rpc('update_temp_land_area_geometry'");
    expect(apiSrc).toContain("sb.rpc('rename_temp_land_area'");
    expect(apiSrc).toContain("sb.rpc('archive_land_area'");
    expect(apiSrc).toContain("sb.rpc('restore_land_area'");
    expect(apiSrc).toContain("sb.rpc('hard_delete_land_area'");
    expect(apiSrc).toContain("export const PM_AREA_OCCUPIED = 'PM_AREA_OCCUPIED'");
    expect(apiSrc).toContain(
      "export const PM_AREA_OCCUPIED_COPY = 'Move animals out of this temp paddock before archiving it.'",
    );
  });
});

describe('P1 planner-group roster wiring', () => {
  const helperSrc = read('src/lib/pasturePlannerGroups.js');

  it('helper derives the roster from real records with the canonical identity contract', () => {
    expect(helperSrc).toContain('export function computePlannerGroupRoster');
    expect(helperSrc).toContain("animalType: 'cattle_herd'");
    expect(helperSrc).toContain("animalType: 'sheep_flock'");
    expect(helperSrc).toContain("animalType: 'breeder_pigs'");
    expect(helperSrc).toContain("animalType: 'feeder_pigs'");
    expect(helperSrc).toContain('groupKey: `sow-${g}`');
    expect(helperSrc).toContain("groupKey: 'boars'");
    // Reuses the shared pig ledger helper; counts are never user-entered.
    expect(helperSrc).toContain("from './pig.js'");
    expect(helperSrc).toContain('computeSubCurrentCount');
    // Feeder group_key is the stable sub id, not the (mutable) name.
    expect(helperSrc).toContain('String(sub.id).trim()');
  });

  it('view consumes the roster + domain contexts and drops the demo group data', () => {
    expect(viewSrc).toContain("from '../lib/pasturePlannerGroups.js'");
    expect(viewSrc).toContain('usePig()');
    expect(viewSrc).toContain('useCattleHome()');
    expect(viewSrc).toContain('useSheepHome()');
    expect(viewSrc).toContain('computePlannerGroupRoster(');
    // Demo placeholders are gone (no fake Main Herd / preset keys).
    expect(viewSrc).not.toContain('DEFAULT_GROUPS');
    expect(viewSrc).not.toContain('GROUP_PRESETS');
    expect(viewSrc).not.toContain('Main Herd');
  });

  it('current-group location is derived from the move ledger by (animal_type, group_key)', () => {
    expect(viewSrc).toContain('m.animal_type === g.animalType && m.group_key === g.groupKey');
    expect(viewSrc).toContain('Not placed');
    expect(viewSrc).toContain('data-pasture-current-groups');
  });

  it('move/plan group pickers are a single flat roster list with locked read-only counts', () => {
    expect(viewSrc).toContain('updateMoveGroup');
    expect(viewSrc).toContain('updatePlanGroup');
    expect(viewSrc).toContain('rosterGroupId');
    // No species pre-selector (grouped/flat collapsed to one flat Group list).
    expect(viewSrc).not.toContain('rosterGroupsForType');
    expect(viewSrc).not.toContain('data-pasture-move-animal-type');
    expect(viewSrc).not.toContain('data-pasture-plan-animal-type');
    expect(viewSrc).toContain('readOnly data-pasture-move-count="1"');
    expect(viewSrc).toContain('readOnly data-pasture-plan-count="1"');
  });
});

describe('P2 Map tab', () => {
  it('renames the View tab to Map', () => {
    expect(viewSrc).toMatch(/id: 'view', label: 'Map'/);
    expect(viewSrc).not.toContain("label: 'View / Map'");
  });

  it('Map panel header uses the roster placed-count copy', () => {
    expect(viewSrc).toContain('MAP - WHERE THINGS ARE');
    expect(viewSrc).toContain('groups placed - tap a group or area');
    expect(viewSrc).toContain('data-pasture-map-header');
  });

  it('Current groups rows expose group key + location for select/zoom', () => {
    expect(viewSrc).toContain('data-pasture-current-group');
    expect(viewSrc).toContain('data-pasture-group-location');
    expect(viewSrc).toContain('selectGroupAndLocation');
    // Selecting a placed group zooms; an unplaced one clears the selection.
    expect(viewSrc).toMatch(/selectGroupAndLocation[\s\S]*?setZoomSignal/);
  });

  it('Area detail derives the designation and flags temp/archived', () => {
    expect(viewSrc).toContain('<div className="pm-kicker">Area detail</div>');
    expect(viewSrc).toContain('designationLabel');
    expect(viewSrc).toContain("return 'Temp paddock'");
    expect(viewSrc).toContain('data-pasture-area-detail');
    expect(viewSrc).toContain('pm-chip-temp');
  });

  it('Map area detail is read-only; recording lives in Plan and line-style in Setup', () => {
    const selBody = viewSrc.slice(
      viewSrc.indexOf('function renderSelectedPanel'),
      viewSrc.indexOf('function selectGroupAndLocation'),
    );
    expect(selBody).not.toContain('renderMoveAndPlanForms');
    expect(selBody).not.toContain('renderLineStylePanel');

    const planBody = viewSrc.slice(
      viewSrc.indexOf('function renderPlanPanel'),
      viewSrc.indexOf('function renderSetupPanel'),
    );
    expect(planBody).toContain('renderMoveAndPlanForms()');

    const setupBody = viewSrc.slice(
      viewSrc.indexOf('function renderSetupPanel'),
      viewSrc.indexOf('function renderPlannedMoves'),
    );
    expect(setupBody).toContain('renderLineStylePanel()');
  });
});

describe('One-shot redesign: Setup lifecycle / Reports tags / Plan conflict / Field temp / canvas', () => {
  it('view wires the P0 temp-paddock lifecycle RPCs + occupancy sentinel copy', () => {
    for (const fn of [
      'createTempLandArea',
      'updateTempLandAreaGeometry',
      'renameTempLandArea',
      'archiveLandArea',
      'restoreLandArea',
      'hardDeleteLandArea',
    ]) {
      expect(viewSrc).toContain(fn);
    }
    expect(viewSrc).toContain('PM_AREA_OCCUPIED_COPY');
    expect(viewSrc).toMatch(/PM_AREA_OCCUPIED'.*\?.*PM_AREA_OCCUPIED_COPY/);
  });

  it('Setup: exactly three designations + archive/restore/admin hard-delete with exact copy, no raw prompts', () => {
    expect(viewSrc).toContain('classifyDesignation');
    expect(viewSrc).toContain('>Pasture<');
    expect(viewSrc).toContain('>Paddock<');
    expect(viewSrc).toContain('>Temp paddock<');
    expect(viewSrc).toContain('Archive temp paddock');
    // JSX text wraps in source; the rendered sentence collapses to the exact copy.
    expect(viewSrc).toContain('Hard delete this area permanently?');
    expect(viewSrc).toMatch(/History will keep text snapshots/);
    expect(viewSrc).toMatch(/the map shape\s+will be removed/);
    expect(viewSrc).toContain('data-pasture-archive');
    expect(viewSrc).toContain('data-pasture-restore');
    expect(viewSrc).toContain('data-pasture-hard-delete');
    expect(viewSrc).toContain('isAdmin &&');
    expect(viewSrc).not.toMatch(/window\.(confirm|alert|prompt)\(/);
  });

  it('Reports: status/type tags incl. Deleted, archived included by default', () => {
    expect(viewSrc).toContain('reportAreaTag');
    expect(viewSrc).toContain('incl. archived');
    expect(viewSrc).toContain('Archived temp');
    expect(viewSrc).toContain('pm-report-tag deleted');
  });

  it('Plan: conflict warning when the next area is occupied by another group', () => {
    expect(viewSrc).toContain('data-pasture-plan-conflict');
    expect(viewSrc).toContain('is currently occupied by');
  });

  it('Field: walked track becomes a real temp paddock + same-day duplicate Record-anyway', () => {
    expect(viewSrc).toContain('closeOutlineToPolygon(trackForm.geometry)');
    expect(viewSrc).toContain('const asTemp = closed.valid');
    expect(viewSrc).toContain('fieldMovedToday');
    expect(viewSrc).toContain('data-pasture-field-dupe');
    expect(viewSrc).toContain('Record anyway');
  });

  it('canvas fills occupied polygons by animal type + renders a group marker', () => {
    expect(canvasSrc).toContain('occupants');
    expect(canvasSrc).toContain('pm-occupant-marker');
    expect(canvasSrc).toContain('occupant.color');
    expect(canvasSrc).toContain('occupant.ink');
    expect(canvasSrc).toContain('Occupied - Cattle');
  });
});

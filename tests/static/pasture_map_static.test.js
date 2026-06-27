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
const mig136 = read('supabase-migrations/136_pasture_map_light_read.sql');
// Code-only (header docs legitimately mention the write RPCs that stay gated).
const mig136Code = mig136.replace(/--[^\n]*/g, '');
const mig139 = read('supabase-migrations/139_pasture_map_light_farm_team.sql');
// Code-only (header docs legitimately enumerate the must-not-widen RPCs).
const mig139Code = mig139.replace(/--[^\n]*/g, '');
const mig140 = read('supabase-migrations/140_pasture_map_rotations.sql');
const mig140Code = mig140.replace(/--[^\n]*/g, '');
const mig141 = read('supabase-migrations/141_pasture_map_measurements.sql');
const mig141Code = mig141.replace(/--[^\n]*/g, '');
const mig143 = read('supabase-migrations/143_pasture_map_reset_area_history.sql');
const mig143Code = mig143.replace(/--[^\n]*/g, '');
const mig147 = read('supabase-migrations/147_pasture_map_grazing_entry_delete_and_parent_overlap.sql');
// Code-only (the header docs legitimately quote 'overlap'/'departure'/'occupied').
const mig147Code = mig147.replace(/--[^\n]*/g, '');
const mig148 = read('supabase-migrations/148_pasture_map_group_records_weight_and_planned_move_cleanup.sql');
const mig148Code = mig148.replace(/--[^\n]*/g, '');
const mig149 = read('supabase-migrations/149_pasture_map_rest_history_reconciliation.sql');
const mig149Code = mig149.replace(/--[^\n]*/g, '');
const mainSrc = read('src/main.jsx');
const homeSrc = read('src/dashboard/HomeDashboard.jsx');
const plannerIconsSrc = read('src/lib/plannerIcons.js');
const viewSrc = read('src/pasture/PastureMapView.jsx');
const modalSrc = read('src/pasture/PastureAreaModal.jsx');
const canvasSrc = read('src/pasture/PastureMapCanvas.jsx');
const pastureCss = read('src/pasture/pastureMap.css');
const apiSrc = read('src/lib/pastureMapApi.js');
const offlineSrc = read('src/lib/pastureOffline.js');
const imagerySrc = read('src/lib/pastureImagery.js');
const pasturePwConfig = read('playwright.pasture.config.js');

describe('Pasture Map route + wiring', () => {
  it('registers the canonical /pasture-map path', () => {
    expect(VIEW_TO_PATH.pastureMap).toBe('/pasture-map');
    expect(PATH_TO_VIEW['/pasture-map']).toBe('pastureMap');
  });

  it('main.jsx imports, allows, renders, and includes Light (farm_team-level pasture) in the view', () => {
    expect(mainSrc).toContain("import PastureMapView from './pasture/PastureMapView.jsx'");
    expect(mainSrc).toMatch(/VALID_VIEWS\s*=\s*\[[\s\S]*?'pastureMap'/);
    expect(mainSrc).toContain("if (view === 'pastureMap')");
    // V1 reset: Light reaches the Pasture Map view (allowlist) and gets
    // farm_team-level pasture access there (tabs/writes gated below + server-side).
    const lightAllowedBlock = mainSrc.match(/const LIGHT_ALLOWED_VIEWS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
    expect(lightAllowedBlock).toContain("'pastureMap'");
  });

  it('Light has farm_team-level Pasture Map access (all tabs + writes, V1 reset)', () => {
    // V1 reset: Light is treated as farm_team for pasture ONLY. The old isLight
    // Map-only gating is gone; participant predicates include 'light' and are kept
    // in lockstep with migration 139's DB-gate widening.
    expect(viewSrc).not.toContain('isLight');
    expect(viewSrc).toContain(
      "const canRecordMoves = role === 'farm_team' || role === 'management' || role === 'admin' || role === 'light'",
    );
    expect(viewSrc).toContain(
      "const canCreateTrack = role === 'farm_team' || role === 'management' || role === 'admin' || role === 'light'",
    );
    expect(viewSrc).toContain(
      "const canViewPlanning = role === 'farm_team' || role === 'management' || role === 'admin' || role === 'light'",
    );
    // All tabs render for every pasture role (no Light filter, no mode block).
    expect(viewSrc).toContain('{MODE_TABS.map((tab) => (');
    expect(viewSrc).not.toContain('MODE_TABS.filter');
    // Planning/report/history reads now run for all pasture roles (incl. Light);
    // planned moves were deleted in mig 148, so the broad history ledger replaces
    // that fetch.
    expect(viewSrc).toMatch(/canViewPlanning\s*\?\s*listPastureHistoryReport\(\{limit: 1000\}\)/);
    expect(viewSrc).toMatch(/canViewPlanning\s*\?\s*listPastureRotations/);
    expect(viewSrc).toMatch(/canViewPlanning\s*\?\s*listPastureMeasurements/);
    // The canonical Area Record (Map modal OR Reports record) lazily loads the
    // open area's grazing history off selectedId (still farm_team+/light gated).
    expect(viewSrc).toMatch(/if \(!selectedId \|\| !canViewPlanning\)/);
    // Move writes stay hard-gated on canRecordMoves (which now includes light).
    expect(viewSrc).toMatch(/async function recordGroupMove[\s\S]*?if \(!canRecordMoves\) return;/);
    expect(viewSrc).toContain('const disabled = !group.active || !canRecordMoves || !next || saving');
  });

  it('home page exposes the Pasture Map field button', () => {
    const fieldBlock = homeSrc.slice(homeSrc.indexOf('field-tools'), homeSrc.indexOf('Utility row'));
    expect(fieldBlock).toContain("setView('pastureMap')");
    expect(fieldBlock).toContain('Pasture Map');
    expect(fieldBlock).toContain('PLANNER_ICON_KEYS.pastureMap');
    expect(fieldBlock).toContain('HomeWeatherCard');
    expect(plannerIconsSrc).toContain("pastureMap: 'pasture-map'");
    expect(fs.existsSync(path.join(ROOT, 'public/icons/planner/pasture-map.png'))).toBe(true);
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

describe('Migration 136 — light read-only Pasture Map access', () => {
  it('widens ONLY the two Map-view read RPCs to include light', () => {
    // Both read RPCs are replaced with light added to the read gate.
    for (const fn of ['list_land_areas', 'list_pasture_moves']) {
      expect(mig136).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
    const gates = mig136Code.match(/NOT IN \('farm_team', 'management', 'admin', 'light'\)/g) || [];
    expect(gates.length).toBe(2);
    // It does NOT define/replace any write or planning/report RPC.
    for (const fn of [
      'record_pasture_move',
      'create_land_area',
      'update_land_area',
      'delete_land_area',
      'archive_land_area',
      'create_temp_land_area',
      'update_land_area_style',
      'create_pasture_planned_move',
      'list_pasture_planned_moves',
      'list_pasture_rest_report',
      'list_pasture_stocking_report',
      'list_pasture_history_report',
    ]) {
      expect(mig136Code).not.toContain(`FUNCTION public.${fn}`);
    }
    // No write/grant widening to light beyond execute-to-authenticated (the gate
    // is the real guard; light is authenticated).
    expect(mig136Code).not.toMatch(/GRANT[\s\S]*?TO light/i);
  });
});

describe('Migration 139 — light gets farm_team-level pasture access (V1 reset)', () => {
  const WIDENED = [
    'record_pasture_move',
    'list_pasture_planned_moves',
    'create_pasture_planned_move',
    'update_pasture_planned_move_status',
    'list_pasture_history_report',
    'list_pasture_rest_report',
    'list_pasture_stocking_report',
    'create_land_area_track',
    'create_temp_land_area',
    'update_temp_land_area_geometry',
    'rename_temp_land_area',
    'archive_land_area',
    'restore_land_area',
  ];
  const MUST_NOT_WIDEN = [
    'import_land_area_batch',
    'create_land_area',
    'update_land_area',
    'update_land_area_geometry',
    'close_land_area_outline',
    'delete_land_area',
    'update_land_area_line_style',
    'hard_delete_land_area',
  ];

  it('widens exactly the 13 farm_team-level pasture RPCs to include light', () => {
    for (const fn of WIDENED) {
      expect(mig139).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
    // Every widened gate now lists light; exactly 13, and no bare 3-role gate
    // remains in the SQL body.
    const widened = mig139Code.match(/NOT IN \('farm_team', 'management', 'admin', 'light'\)/g) || [];
    expect(widened.length).toBe(13);
    const bare = mig139Code.match(/NOT IN \('farm_team', 'management', 'admin'\)/g) || [];
    expect(bare.length).toBe(0);
    // Schema reload so PostgREST picks up the replaced signatures.
    expect(mig139).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });

  it('does NOT widen any management/admin or admin-only RPC, and grants no light role', () => {
    for (const fn of MUST_NOT_WIDEN) {
      expect(mig139Code).not.toMatch(new RegExp(`FUNCTION public\\.${fn}\\(`));
    }
    // No direct grant to light (the role gate is the guard; light is authenticated).
    expect(mig139Code).not.toMatch(/GRANT[\s\S]*?TO light/i);
  });
});

describe('Migration 140 — shared persisted pasture rotations (V1 reset)', () => {
  it('creates a deny-all pasture_rotations table keyed by (animal_type, group_key)', () => {
    expect(mig140).toContain('CREATE TABLE IF NOT EXISTS public.pasture_rotations');
    expect(mig140).toContain('PRIMARY KEY (animal_type, group_key)');
    expect(mig140).toContain('ALTER TABLE public.pasture_rotations ENABLE ROW LEVEL SECURITY');
    expect(mig140).toMatch(/REVOKE ALL ON TABLE public\.pasture_rotations FROM PUBLIC, anon, authenticated/);
    expect(mig140Code).toContain('FOR ALL USING (false) WITH CHECK (false)');
  });

  it('exposes list/upsert/clear RPCs gated to farm_team-level incl. light, granted to authenticated only', () => {
    for (const fn of ['list_pasture_rotations', 'upsert_pasture_rotation', 'clear_pasture_rotation']) {
      expect(mig140).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(mig140).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`));
    }
    expect(mig140).toContain('SECURITY DEFINER');
    // farm_team-level (incl. light) gate on every rotation RPC; exactly 3.
    const gates = mig140Code.match(/NOT IN \('farm_team', 'management', 'admin', 'light'\)/g) || [];
    expect(gates.length).toBe(3);
    // The role gate is the guard; no direct grant to the light role.
    expect(mig140Code).not.toMatch(/GRANT[\s\S]*?TO light/i);
    expect(mig140).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });
});

describe('Migration 141 — saved distance measurements (V1 reset)', () => {
  it('creates a deny-all pasture_measurements table with list/create/delete RPCs', () => {
    expect(mig141).toContain('CREATE TABLE IF NOT EXISTS public.pasture_measurements');
    expect(mig141).toContain('ALTER TABLE public.pasture_measurements ENABLE ROW LEVEL SECURITY');
    expect(mig141).toMatch(/REVOKE ALL ON TABLE public\.pasture_measurements FROM PUBLIC, anon, authenticated/);
    for (const fn of ['list_pasture_measurements', 'create_pasture_measurement', 'delete_pasture_measurement']) {
      expect(mig141).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(mig141).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`));
    }
    // Read/create are farm_team-level incl. light; delete is creator-or-management.
    expect(mig141Code).toContain("v_role NOT IN ('farm_team', 'management', 'admin', 'light')");
    expect(mig141Code).toContain("v_role NOT IN ('management', 'admin') AND v_owner IS DISTINCT FROM v_caller");
    // No direct grant to light; geometry is LineString-only.
    expect(mig141Code).not.toMatch(/GRANT[\s\S]*?TO light/i);
    expect(mig141).toContain("p_geometry->>'type' <> 'LineString'");
    expect(mig141).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });
});

describe('V1 reset — saved distance measurements client (CP-E)', () => {
  it('measure can be saved, listed on a layer, and deleted; never a land area', () => {
    expect(apiSrc).toContain("sb.rpc('list_pasture_measurements'");
    expect(apiSrc).toContain("sb.rpc('create_pasture_measurement'");
    expect(apiSrc).toContain("sb.rpc('delete_pasture_measurement'");
    expect(viewSrc).toContain('function onSaveMeasurement');
    expect(viewSrc).toContain('function saveMeasurement');
    expect(viewSrc).toContain('function deleteMeasurement');
    expect(viewSrc).toContain('data-pasture-measure-form');
    expect(viewSrc).toContain('data-pasture-measurements');
    // Canvas saves the measured line + renders saved measurements as a layer on the
    // working Map + Field (Reports has no canvas).
    expect(canvasSrc).toContain('data-pasture-measure-save');
    expect(canvasSrc).toContain('measureLayerRef');
    expect(canvasSrc).toMatch(/if \(!measurements\.length\) return/);
  });
});

describe('V1 reset — rotations are server-backed, user-controlled, persisted', () => {
  it('loads rotations from the server and derives the per-group view (no auto-seed)', () => {
    expect(viewSrc).toContain('listPastureRotations()');
    expect(viewSrc).toContain('const [serverRotations, setServerRotations]');
    expect(viewSrc).toContain('serverRotationByKey');
    expect(viewSrc).not.toContain('buildInitialRotation');
    expect(viewSrc).not.toContain('setRotations');
    expect(viewSrc).not.toContain('advanceRotation');
  });

  it('persists edits via upsert/clear with offline replay + API wrappers', () => {
    expect(viewSrc).toContain('function persistRotation');
    expect(viewSrc).toContain('upsertPastureRotation(payload)');
    expect(viewSrc).toContain('clearPastureRotation({animalType, groupKey})');
    expect(viewSrc).toMatch(/op: areaIds\.length \? 'upsert_rotation' : 'clear_rotation'/);
    expect(offlineSrc).toContain("row.record.op === 'upsert_rotation'");
    expect(offlineSrc).toContain("row.record.op === 'clear_rotation'");
    expect(apiSrc).toContain("sb.rpc('list_pasture_rotations'");
    expect(apiSrc).toContain("sb.rpc('upsert_pasture_rotation'");
    expect(apiSrc).toContain("sb.rpc('clear_pasture_rotation'");
  });
});

describe('V1 reset — Field stateful GPS location (CP-D)', () => {
  it('My Location is a stateful button (off->follow->heading) via watchPosition; map stays north-up', () => {
    expect(canvasSrc).toContain('function cycleLocate');
    expect(canvasSrc).toContain('navigator.geolocation.watchPosition');
    expect(canvasSrc).toContain('data-pasture-locate-state');
    expect(canvasSrc).toContain("setLocateState('heading')");
    expect(canvasSrc).toContain('pm-gps-cone');
    // Panning pauses follow; the map is NEVER rotated (north-up in v1).
    expect(canvasSrc).toContain("map.on('dragstart'");
    expect(canvasSrc).not.toContain('setBearing');
  });
});

describe('V1 reset — review patch fixes (PR #31)', () => {
  it('1) Field temp paddock draw form is allowed for farm_team/light (canCreateTrack); permanent stays manager-only', () => {
    expect(viewSrc).toContain('if (!isManager && !(drawIsTemp && canCreateTrack)) return null;');
  });

  it('2) offline draw replays a temp paddock via create_temp_area, permanent via create_area', () => {
    expect(viewSrc).toContain("op: 'create_temp_area'");
    expect(viewSrc).toContain("op: 'create_area'");
    // the temp branch keys off drawIsTemp (so a farm_team/light offline temp draw
    // does not replay through the mgmt-only create_area).
    expect(viewSrc).toMatch(/if \(drawIsTemp\)[\s\S]{0,200}op: 'create_temp_area'/);
  });

  it('3) migration 140 preserves manual rotation order with ORDER BY elem.ord', () => {
    expect(mig140).toContain('jsonb_agg(elem.value ORDER BY elem.ord)');
  });

  it('4) offline imagery never reports a clean save on a partial/failed cache', () => {
    // putCachedTile reports success/failure
    expect(imagerySrc).toContain('return true');
    expect(imagerySrc).toContain('return false');
    // a tile counts only if BOTH the fetch and the cache write succeed
    expect(imagerySrc).toContain('res.ok && (await putCachedTile(');
    // partial when any tile failed; downloaded only when the cache is complete
    expect(imagerySrc).toContain("state = 'partial'");
    expect(imagerySrc).toContain("else state = 'downloaded'");
    // the Field surfaces partial as a warning state
    expect(viewSrc).toContain("s.state === 'partial'");
  });
});

describe('V1 reset — basemaps + offline imagery (CP-F)', () => {
  it('basemap switcher offers satellite/topo/hybrid; offline imagery uses public-domain NAIP', () => {
    expect(canvasSrc).toContain('data-pasture-basemap');
    expect(canvasSrc).toContain('data-pasture-basemap-option={b}');
    expect(canvasSrc).toContain('ESRI_TOPO_URL');
    expect(canvasSrc).toContain('ESRI_REFERENCE_URL');
    // Offline + satellite serves cached NAIP tiles from IndexedDB.
    expect(canvasSrc).toContain('OfflineImageryLayer');
    expect(canvasSrc).toContain('getCachedTile');
    // Offline imagery is public-domain NAIP (no token); fail-closed download + status.
    expect(imagerySrc).toContain('USGSNAIPImagery');
    expect(imagerySrc).toContain('function downloadFarmImagery');
    expect(imagerySrc).toContain('function getOfflineImageryStatus');
    expect(imagerySrc).toContain("state = 'failed'");
    expect(viewSrc).toContain('data-pasture-offline-imagery');
    expect(viewSrc).toContain('data-pasture-imagery-download');
    expect(viewSrc).toContain('function downloadImagery');
  });

  it('Hybrid is visibly distinct from Satellite: imagery + labels + roads, overlays in front', () => {
    // Hybrid stacks the imagery base with the place/boundary labels AND the
    // road/highway transportation overlay (same Esri provider — no new licensing).
    expect(canvasSrc).toContain('ESRI_TRANSPORTATION_URL');
    const hybridBlock = canvasSrc.slice(
      canvasSrc.indexOf("basemap === 'hybrid'"),
      canvasSrc.indexOf('} else if (!online)'),
    );
    expect(hybridBlock).toContain('ESRI_IMAGERY_URL');
    expect(hybridBlock).toContain('ESRI_REFERENCE_URL');
    expect(hybridBlock).toContain('ESRI_TRANSPORTATION_URL');
    // Overlays render in a dedicated pane ABOVE the imagery (deterministic) — relying
    // on bringToFront within the single tile pane left the labels behind the imagery,
    // so Hybrid looked identical to Satellite.
    expect(canvasSrc).toContain("createPane('pm-hybrid-overlay')");
    expect(hybridBlock).toContain("pane: 'pm-hybrid-overlay'");
  });
});

describe('V1 reset — Walk tracker Pause/Resume + live duration (CP-D)', () => {
  it('tracker supports Start/Pause/Resume/Stop with a live duration + recording state', () => {
    expect(viewSrc).toContain('function pauseTrack');
    expect(viewSrc).toContain('function resumeTrack');
    expect(viewSrc).toContain('function beginTrackWatch');
    expect(viewSrc).toContain('data-pasture-track-pause');
    expect(viewSrc).toContain('data-pasture-track-resume');
    expect(viewSrc).toContain('data-pasture-track-duration');
    expect(viewSrc).toContain('data-pasture-track-state');
    expect(viewSrc).toContain('activeSeconds');
    // Paused keeps the watch alive but stops growing the track.
    expect(viewSrc).toMatch(/if \(t\.paused \|\| !t\.recording\) return/);
  });
});

describe('V1 reset — Field Drop Point crosshair (CP-D)', () => {
  it('custom drop-point draw: crosshair + Drop point / Undo / Save / Cancel bar, no Geoman vertex internals', () => {
    expect(canvasSrc).toContain('data-pasture-crosshair');
    expect(canvasSrc).toContain('data-pasture-drop-point');
    expect(canvasSrc).toContain('data-pasture-drop-save');
    expect(canvasSrc).toContain('function dropPoint');
    // Custom drop-point mode owns its vertices (Geoman-independent): Drop point adds
    // the map center, tap-to-place adds map clicks, Save closes the ring upward.
    expect(canvasSrc).toContain("mode === 'droppin'");
    expect(canvasSrc).toContain('function renderDropShape');
    expect(canvasSrc).toContain('map.getCenter()');
    expect(canvasSrc).toContain('onDrawComplete(gj, metrics)');
    // Field "Draw paddock" drives the custom drop-point mode.
    expect(viewSrc).toContain("switchToolMode('droppin')");
  });
});

describe('Merged Map is a bottom-sheet on phones (touch)', () => {
  it('layout gets an is-plan class and a touch bottom-sheet treatment', () => {
    expect(viewSrc).toContain("(appMode === 'view' && selectedId ? ' is-plan' : '')");
    expect(pastureCss).toMatch(/@media \(hover: none\) and \(pointer: coarse\) and \(max-width: 980px\)/);
    expect(pastureCss).toContain('.pm-layout.is-plan .pm-side-panel');
  });
});

describe('Reports = every-area grazing records, read-only to all pasture users', () => {
  it('Reports lists every area (grouped, archived tagged) and drills into a per-area record', () => {
    const body = viewSrc.slice(viewSrc.indexOf('function renderReportsPanel'), viewSrc.indexOf('function renderPanel'));
    // Area list + drill-down record, replacing the old rest/stocking/history cards.
    expect(body).toContain('data-pasture-report-areas');
    expect(body).toContain('data-pasture-report-area-row');
    expect(body).toContain('data-pasture-report-record');
    expect(body).toContain('data-pasture-report-back');
    expect(body).toContain('data-pasture-report-timeline');
    expect(body).toContain('data-pasture-report-stay');
    expect(body).toContain('data-pasture-report-status');
    expect(body).toContain('data-pasture-report-totals');
    // The old report cards + flat moves log are gone.
    expect(body).not.toContain('data-pasture-rest-report');
    expect(body).not.toContain('data-pasture-stocking-report');
    expect(body).not.toContain('data-pasture-history-report');
    expect(body).not.toContain('renderRecentMoves');
    // Planned/future moves live in Plan, never in Reports.
    expect(body).not.toContain('renderPlannedMoves');
    expect(body).not.toContain('data-pasture-planned-moves');
    // The record header carries the status line + lifetime totals (times grazed,
    // animal-days, avg density) and rest days.
    expect(body).toContain('times grazed');
    expect(body).toContain('animal-days');
    expect(body).toContain('avg head/ac');
  });

  it('grazing records derive stays + density/animal-days from the move history (no new DB)', () => {
    // Per-area record is computed client-side from list_pasture_history_report; no new
    // migration/RPC. Stays pair each move-in with that group's next move-out.
    expect(viewSrc).toContain('function buildGrazingStays');
    expect(viewSrc).toContain('function grazingRecordTotals');
    expect(viewSrc).toContain('ev.to_land_area_id !== areaId');
    expect(viewSrc).toContain('nx.from_land_area_id === areaId');
    expect(viewSrc).toContain('listPastureHistoryReport({landAreaId: selectedId');
    // Grouped list: pastures/feeder areas carry child paddocks (parent_id) nested.
    expect(viewSrc).toContain('const reportGroups = React.useMemo');
    expect(viewSrc).toContain('a.parent_id === id');
  });

  it('Reports renders areas as pop-out openable tiles + a maintenance card for review actions', () => {
    const body = viewSrc.slice(
      viewSrc.indexOf('function renderReportAreaList'),
      viewSrc.indexOf('function renderAreaRecord'),
    );
    // Areas are launcher tiles that POP OUT (shared .hoverable-tile) like the Home
    // tiles, opening the area record; section/depth metadata keeps hierarchy.
    expect(body).toContain('data-surface="pasture-report-area-table"');
    expect(body).toContain('pm-open-tile pm-area-tile hoverable-tile');
    expect(body).toContain('data-pasture-report-area-row');
    expect(body).toContain('reportDepth');
    expect(body).toContain("children.forEach((child) => pushArea(child, area.name || 'Paddocks', 1))");
    // Parentless paddocks, unclassified polygons, tracks/lines, and archived areas
    // live in the Area maintenance card with manager actions into the Area modal.
    expect(body).toContain('data-pasture-report-review');
    expect(body).toContain('data-pasture-report-needs-row');
    expect(body).toContain('data-pasture-report-assign-pasture');
    expect(body).toContain('openAreaModal(area.id)');
    expect(body).toContain('data-pasture-track-line');
    expect(body).toContain('data-pasture-archived-row');
    expect(body).not.toContain('renderPastureMapCanvas');
  });

  it('Reports renders NO map: full-width reports surface, canvas only in the non-reports branch', () => {
    // Reports is a separate read/report surface — the layout swaps the map column +
    // side panel for a single full-width reports column; the canvas is not mounted.
    expect(viewSrc).toContain("(appMode === 'reports' ? ' is-reports' : '')");
    expect(viewSrc).toContain("appMode === 'reports' ? (");
    expect(viewSrc).toContain('className="pm-reports-col"');
    expect(viewSrc).toContain('data-pasture-reports-col');
    // The canvas render lives in the non-reports branch only (slice the reports
    // ternary's truthy branch: from its start to the NEXT ') : (' after it).
    const rStart = viewSrc.indexOf("appMode === 'reports' ? (");
    const reportsBranch = viewSrc.slice(rStart, viewSrc.indexOf(') : (', rStart));
    expect(reportsBranch).not.toContain('renderPastureMapCanvas');
    expect(reportsBranch).toContain('renderReportsPanel()');
    expect(pastureCss).toContain('.pm-reports-col');
  });
});

describe('Group-record move flow (no clear placement utility)', () => {
  it('removes the old null-destination clear placement wrapper and UI', () => {
    // API wrapper forces toLandAreaId null over the existing record_pasture_move RPC.
    expect(apiSrc).not.toContain('export async function clearPasturePlacement');
    expect(apiSrc).not.toContain('recordPastureMove({...payload, toLandAreaId: null})');
    // View: a Clear current area control + handler that builds a null-destination
    // record_move payload, calls clearPasturePlacement, and queues offline as the SAME
    // record_move op.
    expect(viewSrc).not.toContain('data-pasture-clear-placement');
    expect(viewSrc).not.toContain('function clearPlacement');
    expect(viewSrc).not.toContain('clearPasturePlacement(movePayload)');
    expect(viewSrc).not.toMatch(/clearPlacement[\s\S]*?toLandAreaId: null/);
    expect(viewSrc).not.toMatch(/clearPlacement[\s\S]*?op: 'record_move'/);
    // Hidden when the group is already Not placed (only rendered when currentArea).
    expect(viewSrc).toContain('function renderGroupMoveBox');
  });

  it('Clear itself adds NO undo / reversal of the clear (it reuses record_pasture_move)', () => {
    // The Clear control is append-only: it records a null-destination move, never
    // an undo/reverse RPC. (Per-entry grazing DELETE is a SEPARATE management-only
    // lane via delete_pasture_move, asserted in the mig 147 block below.)
    for (const banned of ['undo_pasture_move', 'reverse_pasture_move', 'data-pasture-undo']) {
      expect(viewSrc).not.toContain(banned);
      expect(apiSrc).not.toContain(banned);
    }
    // Clear reuses record_pasture_move (mig 128) — no new clear RPC was wrapped.
    expect(apiSrc).not.toContain("sb.rpc('clear_pasture_placement'");
  });

  it('Light stays farm-team-level for Pasture Map moves', () => {
    expect(viewSrc).toContain(
      "const canRecordMoves = role === 'farm_team' || role === 'management' || role === 'admin' || role === 'light'",
    );
    expect(viewSrc).toMatch(/async function recordGroupMove[\s\S]*?if \(!canRecordMoves\) return;/);
  });
});

describe('V1 reset — Plan shows all groups rotation paths (next-stop toggle)', () => {
  it('view passes all groups paths to the canvas without a next-stop-only UI toggle', () => {
    expect(viewSrc).toContain('const rotationPaths = React.useMemo');
    expect(viewSrc).toContain("rotationPaths: appMode === 'view' ? rotationPaths : []");
    expect(viewSrc).toContain('nextStopOnly: false');
    expect(viewSrc).toContain('showRotationPath: true');
    expect(viewSrc).not.toContain('setNextStopOnly');
    expect(viewSrc).not.toContain('data-pasture-next-stop-only');
  });

  it('canvas draws one path per group (species color, active emphasis, label, next-only)', () => {
    expect(canvasSrc).toContain('rotationPaths.forEach');
    expect(canvasSrc).toContain('function rotationLabelIcon');
    expect(canvasSrc).toContain('nextStopOnly');
    expect(canvasSrc).toContain('path.isActive');
    expect(canvasSrc).not.toContain('rotationAreaIds');
  });
});

describe('Merged Map: hover readout + click-to-open Area modal', () => {
  it('Map renders the Current groups overview, then always the planning cockpit', () => {
    // Slim side panel ALWAYS shows the Current groups overview + the planning cockpit
    // (renderPlanPanel); per-area editing opens in the Area modal (renderAreaModal)
    // instead of swapping the panel to an inline inspector.
    expect(viewSrc).toContain('{renderViewPanel()}');
    expect(viewSrc).toContain('{renderPlanPanel()}');
    expect(viewSrc).not.toContain('renderPlanAreaInspector');
    // The old touch-only read-only popover is retired.
    expect(viewSrc).not.toContain('function renderMapPopover');
    expect(viewSrc).not.toContain('data-pasture-map-popover');
  });

  it('Map click opens the Area modal; desktop hover keeps the clamped read-only readout', () => {
    // Canvas: clicking an area selects it (no desktop no-op guard anymore).
    expect(canvasSrc).not.toContain("if (appMode === 'view' && !isTouch) return;");
    expect(canvasSrc).toContain('function areaHoverTip');
    expect(canvasSrc).toContain('pm-area-hover-tip');
    // The readout is still edge-aware: clamped inside the map container so it cannot
    // clip off-screen, and wider than the old narrow tooltip.
    expect(canvasSrc).toContain('function clampTooltipWithin');
    expect(canvasSrc).toContain("lyr.on('tooltipopen', clampTip)");
    expect(pastureCss).toMatch(/\.pm-area-hover-tip \{[\s\S]*?max-width: min\(300px/);
  });

  it('Map status strip adds Unplaced groups + Queued/unsynced field items', () => {
    expect(viewSrc).toContain('data-pasture-status-unplaced');
    expect(viewSrc).toContain('data-pasture-status-queued');
    expect(viewSrc).toContain('dot unplaced');
    expect(viewSrc).toContain('dot queued');
    expect(viewSrc).toMatch(/unplacedGroupCount = groups\.filter\(\(g\) => !groupLocation\[g\.id\]\)\.length/);
    expect(viewSrc).toMatch(/queuedItemCount = \(queueState\.queuedCount/);
  });

  it('Animal Groups tiles show location + time-in-area for placed groups', () => {
    expect(viewSrc).toContain('data-surface="pasture-group-table"');
    expect(viewSrc).toContain('pm-open-tile-sub');
    expect(viewSrc).toMatch(/loc && loc\.movedAt \? formatTimeInArea\(loc\.movedAt\) : null/);
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
      libImports.every((p) =>
        /pastureMapApi|pastureKml|pastureOffline|pastureGeometry|pasturePlannerGroups|pastureImagery/.test(p),
      ),
    ).toBe(true);
  });

  it('exposes import + classify + close-into-temp actions', () => {
    expect(viewSrc).toContain('Import OnX KML');
    expect(viewSrc).toContain('Close into temp paddock');
    expect(viewSrc).toContain('function classifyDesignation');
    expect(viewSrc).toContain("kind: 'pasture'");
    expect(viewSrc).toContain("kind: 'paddock'");
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

  it('view supports draw/edit/measure flows and an in-app name+kind save form', () => {
    // The Map boundary-tools grid is gone; draw/edit/measure are reached via the
    // rotation editor (Draw temp paddock), the Area modal (Redraw), and the Field
    // toolbar (Walk / Draw / Measure). The transient save forms still live on Map.
    expect(viewSrc).toContain('data-pasture-draw-temp');
    expect(viewSrc).toContain('data-pasture-redraw');
    expect(viewSrc).toContain('data-pasture-field-measure');
    expect(viewSrc).toContain("switchToolMode('draw')");
    expect(viewSrc).toContain("switchToolMode('measure')");
    expect(viewSrc).toContain('startEdit');
    expect(viewSrc).toContain('data-pasture-drawform-name');
    expect(viewSrc).toContain('data-pasture-drawform-kind');
    expect(viewSrc).toContain('createLandArea');
    expect(viewSrc).toContain('updateLandAreaGeometry');
  });

  it('keeps a completed draw visible while the save form is open', () => {
    // Draw and measure now have separate pm:create handlers; the draw one is the
    // one that calls onDrawComplete and keeps the layer (tempRef), not removing it.
    const drawHandler = canvasSrc.match(/map\.on\('pm:create'[\s\S]*?cbRef\.current\.onDrawComplete/)?.[0] || '';
    expect(drawHandler).toContain('tempRef.current = layer');
    expect(drawHandler).not.toContain('map.removeLayer(layer)');
  });

  it('uses NO raw browser alert/confirm/prompt in the view or canvas', () => {
    for (const src of [viewSrc, canvasSrc]) {
      expect(src).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
    }
  });

  it('disables Redraw for selections without a polygon (outline candidates must be closed first)', () => {
    expect(viewSrc).toContain('function hasPolygonGeom');
    // The Area modal Redraw button is disabled when the area has no polygon geometry.
    expect(viewSrc).toContain('!hasPolygonGeom(area)');
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

  it('group record records rotation-derived moves; modal keeps occupancy/rest', () => {
    for (const marker of [
      'data-pasture-selected-panel',
      'data-pasture-move="1"',
      'data-pasture-group-move-at',
      'function renderGroupMoveBox',
      'nextAreaForGroup(group)',
      'data-pasture-occupancy',
      'data-pasture-rest-state',
    ]) {
      expect(viewSrc).toContain(marker);
    }
    expect(viewSrc).toContain('recordPastureMove');
    expect(viewSrc).toContain('totalWeightLbs: group.totalWeightLbs || null');
    expect(viewSrc).not.toContain('function renderMoveControls');
    expect(viewSrc).not.toContain('data-pasture-move-form');
    expect(viewSrc).not.toContain('function renderMoveAndPlanForms');
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
  it('pastureMapApi keeps report RPCs and removes planned-move wrappers', () => {
    for (const marker of ['listPastureHistoryReport', 'listPastureRestReport', 'listPastureStockingReport']) {
      expect(apiSrc).toContain(marker);
    }
    for (const removed of [
      'newPasturePlanId',
      'listPasturePlannedMoves',
      'createPasturePlannedMove',
      'updatePasturePlannedMoveStatus',
    ]) {
      expect(apiSrc).not.toContain(removed);
    }
  });

  it('view removes planned-move UI; rotation editor drives the move box', () => {
    for (const removed of [
      'data-pasture-planned-moves',
      'data-pasture-plan-form',
      'data-pasture-plan-area',
      'data-pasture-plan-save',
      'createPasturePlannedMove',
      'async function applyPlan',
      'updatePasturePlannedMoveStatus',
    ]) {
      expect(viewSrc).not.toContain(removed);
    }
    for (const marker of ['data-pasture-density', 'data-pasture-use-facts', 'function renderRotationEditor']) {
      expect(viewSrc).toContain(marker);
    }
    expect(viewSrc).not.toContain('data-pasture-same-day-prompt');
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

describe('Migration 148 - group records / planned move cleanup', () => {
  it('adds actual total weight snapshots to pasture moves and returns them in history', () => {
    expect(mig148).toContain('ADD COLUMN IF NOT EXISTS total_weight_lbs numeric');
    expect(mig148).toContain('p_total_weight_lbs numeric DEFAULT NULL');
    expect(mig148).toContain('p_total_weight_lbs, NULLIF');
    expect(mig148).toContain("'total_weight_lbs', m.total_weight_lbs");
    expect(mig148).toContain('m.total_weight_lbs');
    expect(mig148Code).toMatch(/CHECK \(total_weight_lbs IS NULL OR total_weight_lbs > 0\)/);
  });

  it('drops the planned-move table and RPCs in favor of rotation-driven moves', () => {
    for (const marker of [
      'DROP FUNCTION IF EXISTS public.update_pasture_planned_move_status',
      'DROP FUNCTION IF EXISTS public.create_pasture_planned_move',
      'DROP FUNCTION IF EXISTS public.list_pasture_planned_moves',
      'DROP FUNCTION IF EXISTS public._pasture_planned_move_summary',
      'DROP TABLE IF EXISTS public.pasture_planned_moves',
    ]) {
      expect(mig148).toContain(marker);
    }
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
      'data-pasture-field-walk',
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
    const baselineBranch = canvasSrc.match(/rest_state === 'baseline'\) \{[\s\S]*?fillOpacity: 0\.08\}/);
    expect(baselineBranch).toBeTruthy();
    expect(baselineBranch[0]).not.toContain('dashArray');
    // Explicit saved line_pattern='dashed' still maps to a dash via applyLineStyle.
    expect(canvasSrc).toContain("dashed: '10,8'");
    // Outline candidates remain intentionally dashed.
    expect(canvasSrc).toMatch(/outline_candidate[\s\S]*?dashArray: '6,6'/);
  });

  it('view renders manager line-style controls', () => {
    // The Land areas list (and its per-row line-style chip, data-pasture-line-style)
    // was removed from Map; the line-style editing CONTROLS live in the Plan
    // Area inspector's Line style section.
    for (const marker of [
      'data-pasture-style-panel',
      'data-pasture-style-color',
      'data-pasture-style-pattern',
      'data-pasture-style-weight',
      'data-pasture-style-weight-number',
      'data-pasture-style-save',
      'data-pasture-style-reset',
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
    expect(viewSrc).toContain('pm-open-tile-sub');
    expect(viewSrc).toContain('data-pasture-group-row');
    expect(viewSrc).not.toContain('data-pasture-current-groups');
  });

  it('move placement is a selected group-record control, not in the Area modal', () => {
    expect(viewSrc).toContain('function renderGroupRecord');
    expect(viewSrc).toContain('function renderGroupMoveBox');
    expect(viewSrc).toContain('data-pasture-group-move-at');
    expect(viewSrc).toContain('data-pasture-move="1"');
    expect(viewSrc).not.toContain('data-pasture-move-form');
    expect(viewSrc).not.toContain('data-pasture-plan-form');
    expect(viewSrc).not.toContain('data-pasture-clear-placement');
    expect(viewSrc).not.toContain('data-pasture-planned-moves');
    // No per-species pre-selector; counts stay locked to the roster (groupSizeCount).
    expect(viewSrc).not.toContain('data-pasture-move-animal-type');
    expect(viewSrc).toContain('animalCount: groupSizeCount(group)');
    expect(viewSrc).toContain('computePlannerGroupRoster(');
  });
});

describe('P2 Map tab', () => {
  it('renames the View tab to Map', () => {
    expect(viewSrc).toMatch(/id: 'view', label: 'Map'/);
    expect(viewSrc).not.toContain("label: 'View / Map'");
  });

  it('Map panel header removes the roster placed-count instruction copy', () => {
    expect(viewSrc).toContain('MAP - WHERE THINGS ARE');
    expect(viewSrc).not.toContain('hover to read, click an area to work; tap on a phone');
    expect(viewSrc).toContain('data-pasture-map-header');
  });

  it('Animal Groups render as pop-out openable tiles with no map hover/focus preview', () => {
    expect(viewSrc).toContain('data-surface="pasture-group-table"');
    expect(viewSrc).toContain('data-pasture-group-row');
    expect(viewSrc).not.toContain('selectGroupAndLocation');
    expect(viewSrc).not.toContain('function previewGroupArea');
    expect(viewSrc).not.toContain('onMouseEnter={() => previewGroupArea(group)}');
    expect(viewSrc).not.toContain('onFocus={() => previewGroupArea(group)}');
    expect(viewSrc).not.toContain('onMouseLeave={clearGroupPreview}');
    expect(viewSrc).not.toContain('onBlur={clearGroupPreview}');
    expect(viewSrc).toContain('openableProps(() => openGroupRecord(group))');
  });

  it('Area detail derives the designation and flags temp/archived', () => {
    expect(viewSrc).toContain('<div className="pm-kicker">Area</div>');
    expect(viewSrc).toContain('designationLabel');
    expect(viewSrc).toContain("return 'Temp paddock'");
    expect(viewSrc).toContain('data-pasture-area-detail');
    expect(viewSrc).toContain('pm-chip-temp');
  });

  it('read-only facts panel never embeds forms; the Area modal owns recording + line style + parent', () => {
    const selBody = viewSrc.slice(
      viewSrc.indexOf('function renderSelectedPanel'),
      viewSrc.indexOf('function renderOccupiedExplain'),
    );
    // The read-only Area detail facts panel never embeds the move or line-style forms.
    expect(selBody).not.toContain('renderMoveAndPlanForms');
    expect(selBody).not.toContain('renderLineStylePanel');

    // Per-area editing now lives in an accessible centered Area modal (role=dialog,
    // aria-modal, focus-trapped backdrop) opened by clicking a map area.
    expect(viewSrc).toContain('function renderAreaModal');
    expect(viewSrc).toContain('<PastureAreaModal');
    expect(viewSrc).toContain("import PastureAreaModal from './PastureAreaModal.jsx'");
    expect(modalSrc).toContain('role="dialog"');
    expect(modalSrc).toContain('aria-modal="true"');
    expect(modalSrc).toContain('useModalFocusTrap');
    expect(modalSrc).toContain('data-pasture-area-modal');
    expect(modalSrc).toContain('data-pasture-area-modal-backdrop');
    expect(modalSrc).toContain('pm-modal-backdrop');
    expect(modalSrc).toContain('data-pasture-area-modal-close');

    // The Map modal hosts the ONE canonical Area Record body (renderAreaRecordContent
    // — detail + grazing history + management/line style/classification/parent); the
    // single header X owns the debounced save/review close. The inner wrapper keeps
    // the legacy data-pasture-plan-inspector hook. Move/animal placement is NOT here.
    const modalBody = viewSrc.slice(
      viewSrc.indexOf('function renderAreaModal'),
      viewSrc.indexOf('function reportAreaTag'),
    );
    expect(modalBody).toContain('renderAreaRecordContent()');
    expect(modalBody).toContain('data-pasture-plan-inspector');
    expect(modalBody).toContain('onClose={closeAreaModal}');
    expect(modalBody).toContain('closeDisabled={areaModalCloseSaving}');
    expect(viewSrc).toContain('AREA_MODAL_CLOSE_DEBOUNCE_MS');
    expect(viewSrc).toContain('function closeAreaModal');
    expect(modalBody).not.toContain('data-pasture-area-modal-save');
    expect(modalBody).not.toContain('pm-modal-footer');
    expect(modalBody).not.toContain('renderMoveAndPlanForms');
    expect(modalBody).not.toContain('data-pasture-move-form');
    expect(modalBody).not.toContain('data-pasture-modal-move');
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

  it('Setup: permanent designation select + temp promotion, archive/restore/admin hard-delete copy, no raw prompts', () => {
    expect(viewSrc).toContain('classifyDesignation');
    // Permanent areas pick Pasture/Paddock; temp areas are promoted explicitly
    // (no free "Temp paddock" <option> that could silently demote a permanent area).
    expect(viewSrc).toContain('>Pasture<');
    expect(viewSrc).toContain('>Paddock<');
    expect(viewSrc).not.toMatch(/<option value="temp">/);
    expect(viewSrc).toContain('Archive temp paddock');
    // Hard delete moved to a deliberate admin-only Danger zone (renderDangerZone),
    // not adjacent to archive/restore/redraw.
    expect(viewSrc).toContain('function renderDangerZone');
    expect(viewSrc).toContain('data-pasture-danger-zone');
    expect(viewSrc).toMatch(/Permanently hard delete /);
    expect(viewSrc).toMatch(/History keeps text snapshots/);
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

  it('Map group record removes the old next-area conflict warning card', () => {
    expect(viewSrc).not.toContain('data-pasture-plan-conflict');
    expect(viewSrc).not.toContain('is currently occupied by');
    expect(viewSrc).toContain('occupantsByArea');
  });

  it('Field: walked GPS track becomes a real temp paddock; OnX-style spatial build/measure tool', () => {
    // GPS walk -> temp paddock save path is preserved.
    expect(viewSrc).toContain('closeOutlineToPolygon(trackForm.geometry)');
    expect(viewSrc).toContain('const asTemp = closed.valid');
    // OnX-style field chrome: Walk paddock / Draw paddock / Measure / Layers + real online state.
    expect(viewSrc).toContain('data-pasture-field-chrome');
    expect(viewSrc).toContain('data-pasture-field-walk');
    expect(viewSrc).toContain('data-pasture-field-draw');
    expect(viewSrc).toContain('data-pasture-field-measure');
    expect(viewSrc).toContain('data-pasture-field-online');
    // The fake phone mockup + field move-recording are gone (moves live in Plan).
    expect(viewSrc).not.toContain('data-pasture-field-confirm');
    expect(viewSrc).not.toContain('pm-phone-groups');
  });

  it('canvas fills occupied polygons by animal type + renders a group marker', () => {
    expect(canvasSrc).toContain('occupants');
    expect(canvasSrc).toContain('pm-occupant-marker');
    expect(canvasSrc).toContain('occupant.color');
    expect(canvasSrc).toContain('occupant.ink');
    expect(canvasSrc).toContain('Occupied - Cattle');
  });
});

describe('Designation boundary styling + promotion + boundary overlay (lane)', () => {
  it('canvas hardcodes fixed permanent pasture (blue) and paddock (green) 4px strokes', () => {
    expect(canvasSrc).toContain('PERMANENT_PASTURE_STROKE');
    expect(canvasSrc).toContain('PERMANENT_PADDOCK_STROKE');
    expect(canvasSrc).toMatch(/PERMANENT_PASTURE_STROKE = \{color: '#1d4ed8', weight: 4\}/);
    expect(canvasSrc).toMatch(/PERMANENT_PADDOCK_STROKE = \{color: '#4ade80', weight: 4\}/);
    // Fixed permanent strokes are forced and ignore saved line styles.
    expect(canvasSrc).toContain('function isPermanentPasture');
    expect(canvasSrc).toContain('function isPermanentPaddock');
    expect(canvasSrc).toContain('function withDesignationStroke');
  });

  it('canvas keeps temp paddock default white dashed 5px and editable via applyLineStyle', () => {
    expect(canvasSrc).toContain('TEMP_PADDOCK_DEFAULT_STROKE');
    expect(canvasSrc).toMatch(/TEMP_PADDOCK_DEFAULT_STROKE = \{color: '#ffffff', weight: 5/);
    // Temp branch layers the saved line style on top of the white-dashed default.
    expect(canvasSrc).toMatch(
      /isTempPaddock\(a\)[\s\S]*?applyLineStyle\(a, \{\.\.\.style, \.\.\.TEMP_PADDOCK_DEFAULT_STROKE\}\)/,
    );
  });

  it('canvas boundary overlay hides only strokes (keeps occupancy fill) and labels are hover-only', () => {
    expect(canvasSrc).toContain('function boundaryCategory');
    expect(canvasSrc).toContain('function applyBoundaryVisibility');
    // stroke:false hides the outline while leaving the fill polygon + marker.
    expect(canvasSrc).toContain('return {...style, stroke: false}');
    // Clean default: only the selected area is permanently labeled (no always-on
    // labels for every area).
    expect(canvasSrc).toContain('permanent: a.id === selectedId');
    expect(canvasSrc).not.toContain('permanent: !compact && g.kind');
    // boundaryFilter feeds styleForArea + the toggle control exists.
    expect(canvasSrc).toContain('styleForArea(a, a.id === selectedId, primaryOcc, boundaryFilter)');
    expect(canvasSrc).toContain('data-pasture-boundary-toggle');
    expect(canvasSrc).toContain('data-pasture-boundary');
  });

  it('view passes the boundary filter to the canvas and toggles categories', () => {
    expect(viewSrc).toContain('boundaryFilter');
    expect(viewSrc).toContain('function toggleBoundary');
    expect(viewSrc).toContain('onToggleBoundary: toggleBoundary');
    expect(viewSrc).toMatch(
      /boundaryFilter, setBoundaryFilter\] = React\.useState\(\{pasture: true, paddock: true, temp: true\}\)/,
    );
  });

  it('view gates line-style editing to temp paddocks + GPS field tracks only', () => {
    expect(viewSrc).toContain('function canEditLineStyle');
    expect(viewSrc).toContain('function isFixedStyleArea');
    // Editable line-style section (Plan inspector) is gated on canEditLineStyle;
    // permanent fixed-style areas get a small inline locked note instead.
    expect(viewSrc).toContain('isManager && canEditLineStyle(area)');
    expect(viewSrc).toContain('data-pasture-setup-linestyle-locked');
    expect(viewSrc).toContain('isFixedStyleArea(area)');
  });

  it('view creates new drawn land as temp paddocks (permanent comes from promotion)', () => {
    // "Draw temp paddock" lives in the rotation editor (the Map boundary-tools grid is gone).
    expect(viewSrc).toContain('Draw temp paddock');
    expect(viewSrc).toMatch(/setDrawIsTemp\(true\);\s*\n\s*switchToolMode\('draw'\)/);
    // Draw form hides the permanent Type select while drawing a temp paddock.
    expect(viewSrc).toContain('data-pasture-drawform-temp');
  });

  it('view promotes temp -> permanent via mgmt/admin update_land_area with explicit confirm', () => {
    expect(viewSrc).toContain('function promoteTempArea');
    expect(viewSrc).toMatch(/updateLandArea\(a\.id, \{kind, permanence: 'permanent'/);
    expect(viewSrc).toContain('data-pasture-promote');
    expect(viewSrc).toContain('data-pasture-promote-pasture');
    expect(viewSrc).toContain('data-pasture-promote-paddock');
    expect(viewSrc).toContain('data-pasture-promote-confirm');
    // Promotion lives in the manager-only area manage actions (renderAreaManageActions
    // returns null unless isManager) and warns the style locks.
    expect(viewSrc).toMatch(
      /function renderAreaManageActions\(area\) \{\s*\n\s*if \(!area \|\| !isManager\) return null/,
    );
    expect(viewSrc).toContain('boundary style locks to the fixed permanent style');
  });
});

describe('Pasture Map tweaks #2: default labels / occupancy / dismissal / open outlines', () => {
  it('default map is clean: only the selected area is permanently labeled', () => {
    expect(canvasSrc).toContain('permanent: a.id === selectedId');
    expect(canvasSrc).not.toContain('permanent: !compact');
  });

  it('occupancy fill + group marker survive the boundary overlay (stroke-only hide)', () => {
    // Overlay toggle hides strokes only; fill + the separate occupant marker stay.
    expect(canvasSrc).toContain('return {...style, stroke: false}');
    expect(canvasSrc).toContain('pm-occupant-marker');
    // The occupant marker is gated only on the destination occupant (primaryOcc),
    // never on boundaryFilter.
    const markerBlock = canvasSrc.slice(
      canvasSrc.indexOf('if (primaryOcc && g.kind'),
      canvasSrc.indexOf('group.addTo(map)'),
    );
    expect(markerBlock).not.toContain('boundaryFilter');
  });

  it('renders ONE current-location marker per group: overlap-only impacts get no second marker', () => {
    // primaryOcc = the destination occupant. An overlap-only impact (the same
    // canonical group, but its real placement is a different overlapping area) must
    // never paint a second full "Ewes - 58" marker or occupancy fill.
    expect(canvasSrc).toContain('const primaryOcc = occList.find((o) => !o.overlap) || null');
    expect(canvasSrc).toContain('if (primaryOcc && g.kind');
    // The fill also uses primaryOcc (not occList[0]) so an overlap-only area is not
    // colored as if the group lived there.
    expect(canvasSrc).toContain('styleForArea(a, a.id === selectedId, primaryOcc, boundaryFilter)');
    // The marker no longer renders an "overlap" tag/full marker for overlap impacts.
    expect(canvasSrc).not.toContain('\'<span class="pm-occ-tag">overlap</span>\'');
    // Overlap context still rides along in the hover/tap readout (full occList).
    expect(canvasSrc).toContain('areaHoverTip(a, occList)');
  });

  it('canvas clears selection on empty-background click (guarded against feature clicks)', () => {
    expect(canvasSrc).toContain("map.on('click'");
    expect(canvasSrc).toContain('featureClickRef');
    expect(canvasSrc).toContain('cbRef.current.onSelect(null)');
    // Feature clicks set the guard flag so they do not also clear.
    expect(canvasSrc).toContain('featureClickRef.current = true');
    // Background click is suppressed while drawing/editing/measuring/tracking.
    expect(canvasSrc).toMatch(/\['draw', 'edit', 'measure', 'track', 'droppin'\]\.includes\(modeRef\.current\)/);
  });

  it('view keeps one visible area-modal close control and removes inner clear/zoom actions', () => {
    expect(viewSrc).toMatch(/e\.key !== 'Escape'/);
    expect(viewSrc).toContain('if (e.defaultPrevented) return');
    expect(viewSrc).toContain("window.addEventListener('keydown'");
    expect(modalSrc).toContain('data-pasture-area-modal-close');
    expect(viewSrc).not.toContain('data-pasture-clear-selection');
    expect(viewSrc).not.toContain('pm-selected-close');
    expect(viewSrc).not.toContain('Clear selection');
    expect(viewSrc).not.toContain('Zoom to this pasture');
  });

  it('Reports surfaces Tracks / Lines in Area maintenance with close-into-temp and delete (no map zoom)', () => {
    // Tracks / Lines relocated OFF the Map side panel into the Reports maintenance card.
    expect(viewSrc).toContain('data-pasture-report-review');
    expect(viewSrc).toContain('data-pasture-track-line');
    expect(viewSrc).toContain('data-pasture-track-line-close');
    expect(viewSrc).toContain('data-pasture-track-line-delete');
    expect(viewSrc).toContain('Track / line');
    expect(viewSrc).toContain('trackLineAreas');
    // Reports renders no map, so the old map-zoom action is gone, and the standalone
    // Map-side-panel Tracks/Lines card no longer exists.
    expect(viewSrc).not.toContain('data-pasture-tracks-lines');
    expect(viewSrc).not.toContain('data-pasture-tracks-lines-count');
    expect(viewSrc).not.toContain('data-pasture-track-line-zoom');
    expect(viewSrc).not.toContain('function renderTracksLines');
  });
});

describe('Tracks / Lines lane (no-DB option B)', () => {
  it('Tracks/Lines = outline candidates only, split out of the Area Setup list + destinations', () => {
    // Draft lines are excluded from Area Setup, move destinations, and rotation seeding.
    expect(viewSrc).toMatch(/setupAreas = React\.useMemo\([\s\S]*?!isOutlineCandidateArea/);
    expect(viewSrc).toMatch(
      /destinationAreas = React\.useMemo\([\s\S]*?activeAreas\.filter\(\(area\) => !isOutlineCandidateArea/,
    );
    expect(viewSrc).toContain(
      'trackLineAreas = React.useMemo(() => activeAreas.filter((area) => isOutlineCandidateArea',
    );
    // V1 reset: rotations are server-backed + user-controlled (no generated seed).
    expect(viewSrc).not.toContain('buildInitialRotation');
    expect(viewSrc).toContain('serverRotationByKey');
    // appendToRotation refuses a draft line as a destination.
    expect(viewSrc).toContain('isOutlineCandidateArea(area)');
    // Move destinations exclude draft lines (destinationAreas filter).
    expect(viewSrc).toMatch(/destinationAreas = React\.useMemo\([\s\S]*?!isOutlineCandidateArea/);
  });

  it('Close into temp paddock uses existing RPCs (no Edit, no new SQL) and is mgmt/admin', () => {
    expect(viewSrc).toContain('async function closeIntoTempPaddock');
    expect(viewSrc).toMatch(/closeLandAreaOutline\(a\.id, res\.polygon, 'paddock'\)/);
    expect(viewSrc).toMatch(/updateLandArea\(a\.id, \{permanence: 'temporary'/);
    // close + delete actions live in the Reports Tracks / Lines section, wrapped in
    // an isManager && gate.
    expect(viewSrc).toContain('onClick={() => closeIntoTempPaddock(a)}');
    expect(viewSrc).toContain('data-pasture-track-line-close');
    // Edit is intentionally NOT in this lane.
    expect(viewSrc).not.toContain('data-pasture-track-line-edit');
  });

  it('canvas shows draft lines on the working Map; Field has a Draft-lines toggle', () => {
    expect(canvasSrc).toContain(
      "appMode === 'view' || (appMode === 'field' && draftLinesVisible) || a.id === selectedId",
    );
    expect(canvasSrc).toContain('data-pasture-draftlines-toggle');
    // Draft-lines toggle lives behind the Field "Layers" button now.
    expect(canvasSrc).toContain("appMode === 'field' && fieldLayersOpen && onToggleDraftLines");
    expect(viewSrc).toContain('draftLinesVisible');
    expect(viewSrc).toContain('onToggleDraftLines: toggleDraftLines');
  });
});

describe('Pasture Map tweaks #3-#5: Plan card, Setup classification, map controls', () => {
  it('does not reintroduce abbreviation/day/progress copy', () => {
    expect(viewSrc).not.toContain('Mark ${activeGroup.short} moved');
    expect(viewSrc).not.toContain('Move due now');
    expect(viewSrc).not.toMatch(/Day \{activeGroup\.day\}/);
    expect(viewSrc).not.toContain('Record / plan for');
    expect(viewSrc).not.toContain('manualAcres');
    expect(canvasSrc).not.toContain('Zoom Selected');
    expect(canvasSrc).not.toContain('function zoomSelected');
  });

  it('Group record shows details, rotation editor, move box, date, and grazing history', () => {
    expect(viewSrc).toMatch(
      /renderGroupDetails\(group\)[\s\S]*?renderRotationEditor\(group\)[\s\S]*?renderGroupMoveBox\(group\)[\s\S]*?renderGroupGrazingHistory\(group\)/,
    );
    expect(viewSrc).toContain('data-pasture-group-move');
    expect(viewSrc).toContain('data-pasture-move="1"');
    expect(viewSrc).toContain('data-pasture-group-move-at');
    expect(viewSrc).toContain('function formatTimeInArea');
    expect(viewSrc).toContain('time in area');
    expect(viewSrc).not.toContain('data-pasture-move-notes');
    // The move button copy is exactly "Move" (no abbreviation).
    expect(viewSrc).toMatch(/saving \? 'Saving\.\.\.' : 'Move'/);
  });

  it('current placement is derived from the move ledger only, never from the rotation array', () => {
    // The old bug: top-level `const nowArea`/`const nextArea` read
    // activeRotation[0]/[1] as the current/next location. Those declarations and
    // the rotation[1] "next" derivation must be gone.
    expect(viewSrc).not.toContain('const nowArea =');
    expect(viewSrc).not.toContain('const nextArea =');
    expect(viewSrc).not.toMatch(/areaById\.get\(activeRotation\[1\]\)/);
    // Current area comes from the move ledger; next is derived relative to actual
    // placement for the selected group record.
    expect(viewSrc).toContain('function currentAreaForGroup');
    expect(viewSrc).toContain('function nextAreaForGroup');
    expect(viewSrc).toContain('locationForGroup(group)');
    // The rotation NOW chip/label is gated on actual placement, not index 0.
    expect(viewSrc).not.toMatch(/index === 0 \? ' is-now' : ''/);
    expect(viewSrc).not.toMatch(/index === 0 \? 'NOW - ' : ''/);
    expect(viewSrc).toContain('const isNow = !!currentArea && areaId === currentArea.id');
    // Move / Confirm record to the derived next destination (first rotation stop
    // for an unplaced group), not rotation[1].
    expect(viewSrc).toContain('recordGroupMove(group, next && next.id, groupMoveAt)');
  });

  it('Plan panel is the slim group/rotation cockpit; per-area tools moved to the modal/Reports', () => {
    const planBody = viewSrc.slice(
      viewSrc.indexOf('function renderPlanPanel'),
      viewSrc.indexOf('function renderAreaManageActions'),
    );
    expect(planBody).not.toContain('renderAreaIndex');
    expect(planBody).not.toContain('data-pasture-plan-destinations');
    // Slim cockpit keeps the group table, transient tool save forms, and ONE
    // bottom Import KML entry point. The rotation editor opens inside a group record.
    expect(planBody).toContain('renderGroupSwitcher()');
    expect(planBody).toContain('if (selectedRecordGroup) return renderGroupRecord(selectedRecordGroup,');
    expect(planBody).not.toContain('data-pasture-clear-placement');
    expect(planBody).toContain('data-pasture-import-kml');
    // The relocated cards (boundary-tools grid, tracks/lines, classification queue)
    // are GONE from the side panel. Manual move lives in the Area modal.
    expect(planBody).not.toContain('renderBoundaryTools()');
    expect(planBody).not.toContain('renderTracksLines()');
    expect(planBody).not.toContain('renderClassificationQueue()');
    expect(planBody).not.toContain('data-pasture-manual-move');
  });

  it('classification + acreage live in the area modal: read-only acreage, classification selector', () => {
    expect(viewSrc).toContain('data-pasture-acres-readonly');
    // No editable acreage input anywhere.
    expect(viewSrc).not.toMatch(/saveAreaPatch\(area, \{manualAcres/);
    expect(viewSrc).not.toContain('clearManual: true');
    // Classification select exposes the unclassified state + Pasture/Paddock.
    expect(viewSrc).toContain('<span>Classification</span>');
    expect(viewSrc).toMatch(/<option value="unclassified" disabled>/);
  });

  it('map: legend collapsed by default and boundary toggle sits clear of the zoom control', () => {
    expect(viewSrc).toMatch(/legendOpen, setLegendOpen\] = React\.useState\(false\)/);
    // Boundary toggle repositioned below the Leaflet zoom control (no overlap).
    expect(pastureCss).toMatch(/\.pm-boundary-toggle \{[\s\S]*?top: 84px/);
  });
});

describe('Merged Map IA: tabs are Map / Field / Reports, with an Area modal', () => {
  it('Setup and Plan are gone from the tabs; tabs are Map / Field / Reports', () => {
    const tabsBlock = viewSrc.match(/const MODE_TABS = \[[\s\S]*?\];/)?.[0] || '';
    expect(tabsBlock).not.toContain("id: 'setup'");
    expect(tabsBlock).not.toContain("id: 'plan'");
    expect(tabsBlock).not.toContain("label: 'Plan'");
    expect(tabsBlock).toContain("label: 'Map'");
    expect(tabsBlock).toContain("label: 'Field'");
    expect(tabsBlock).toContain("label: 'Reports'");
    expect(viewSrc).not.toContain('function renderSetupPanel');
    expect(viewSrc).not.toContain("appMode === 'setup'");
    expect(viewSrc).not.toContain("setAppMode('setup')");
  });

  it('Map opens the Area modal on selection; the cockpit stays below', () => {
    // Per-area editing opens an accessible Area modal (renderAreaModal) over the map.
    expect(viewSrc).toContain('function renderAreaModal');
    expect(viewSrc).toContain('renderAreaModal()');
    expect(viewSrc).toContain('<PastureAreaModal');
    expect(modalSrc).toContain('data-pasture-area-modal');
    expect(modalSrc).toContain('data-pasture-area-modal-backdrop');
    expect(modalSrc).toContain('pm-modal-backdrop');
    // The slim side panel always shows the overview + cockpit (no inline inspector swap).
    expect(viewSrc).toContain('{renderViewPanel()}');
    expect(viewSrc).toContain('{renderPlanPanel()}');
    expect(viewSrc).not.toContain('renderPlanAreaInspector');
    // The old read-only touch popover is retired.
    expect(viewSrc).not.toContain('function renderMapPopover');
    expect(viewSrc).not.toContain('data-pasture-map-popover');
    // The single modal X owns the close path; the old inner clear-selection hook is gone.
    expect(viewSrc).toContain('closeAreaModal');
    expect(modalSrc).toContain('data-pasture-area-modal-close');
    expect(viewSrc).not.toContain('data-pasture-clear-selection');
  });

  it('Per-area Manage actions live in the Area modal; boundary-tools grid + classify queue left the side panel', () => {
    // Manage actions render inside the modal (via renderAreaManageActions).
    expect(viewSrc).toContain('function renderAreaManageActions');
    expect(viewSrc).toContain('data-pasture-area-manage');
    // The boundary-tools grid + classification-queue cards are removed from the panel.
    expect(viewSrc).not.toContain('function renderBoundaryTools');
    expect(viewSrc).not.toContain('data-pasture-boundary-tools');
    expect(viewSrc).not.toContain('data-pasture-boundary-tools-toggle');
    expect(viewSrc).not.toContain('function renderClassificationQueue');
    expect(viewSrc).not.toContain('data-pasture-classify-queue');
    // Classification review relocated to the Reports tab.
    expect(viewSrc).toContain('data-pasture-report-needs-classification');
    // Roster card dropped; no rest-days input survives.
    expect(viewSrc).not.toContain('Locked roster - counts come from real animal records');
    expect(viewSrc).not.toContain('<span>Rest days</span>');
  });
});

describe('Tool lifecycle hardening (Measure P0, exits, archived recovery)', () => {
  it('measure is transient with Clear / Done controls and never persists', () => {
    expect(canvasSrc).toContain('function clearMeasure');
    expect(canvasSrc).toContain('data-pasture-measure-clear');
    expect(canvasSrc).toContain('data-pasture-measure-done');
    expect(canvasSrc).toContain("hud.mode === 'measure'");
    // Done exits the tool via the onExitTool callback.
    expect(canvasSrc).toContain('onExitTool');
    expect(viewSrc).toContain('onExitTool: () => switchToolMode(');
    // Switching tools tears down the transient layer + HUD.
    expect(canvasSrc).toContain('clearTemp()');
    expect(canvasSrc).toContain('setHud(null)');
  });

  it('Field Measure is a TWO-point distance ruler only (no Geoman line, no 3+ points)', () => {
    // Custom 2-click flow (point A, point B -> auto-freeze), NOT a Geoman line draw
    // and NOT a multi-segment/area tool.
    expect(canvasSrc).toContain('function beginMeasure');
    expect(canvasSrc).not.toContain("enableDraw('Line'");
    // Ignores clicks past the second point, and freezes to exactly two coordinates.
    expect(canvasSrc).toContain('if (measureVertsRef.current.length >= 2) return');
    expect(canvasSrc).toContain("type: 'LineString', coordinates: verts.slice(0, 2)");
    // Distance-only HUD (no acres/perimeter for measure).
    expect(canvasSrc).toContain("mode: 'measure', isLine: true");
  });

  it('GPS/current-location marker renders above map overlays via a dedicated high-z pane', () => {
    expect(canvasSrc).toContain("createPane('pm-locate-pane')");
    expect(canvasSrc).toContain("pane: 'pm-locate-pane'");
  });

  it('Escape exits an active map tool (draw/edit/measure/track) before clearing selection', () => {
    expect(viewSrc).toMatch(
      /\['draw', 'edit', 'measure', 'track', 'droppin'\]\.includes\(escStateRef\.current\.mapMode\)\) \{\s*\n\s*switchToolMode\('select'\)/,
    );
  });

  it('removes confusing "was Move/Track/Edit" helper subtext', () => {
    expect(viewSrc).not.toContain('was Move');
    expect(viewSrc).not.toContain('was Track');
    expect(viewSrc).not.toContain('was Edit');
  });

  it('archived areas have a recovery surface in the Reports tab', () => {
    // Archived recovery relocated OFF the Map side panel into the Reports accordion.
    expect(viewSrc).not.toContain('function renderArchivedAreas');
    expect(viewSrc).toContain('data-pasture-archived');
    expect(viewSrc).toContain('data-pasture-archived-restore');
    expect(viewSrc).toContain('restoreArea(a)');
    expect(viewSrc).toMatch(/archivedAreas = React\.useMemo\([\s\S]*?status === 'retired'/);
  });
});

describe('Pasture Map: Area modal + parent-pasture assignment', () => {
  it('the Area modal is an accessible centered dialog with the contract selectors', () => {
    expect(modalSrc).toContain("import {useModalFocusTrap} from '../shared/useModalFocusTrap.js'");
    expect(modalSrc).toContain('role="dialog"');
    expect(modalSrc).toContain('aria-modal="true"');
    expect(modalSrc).toContain('aria-labelledby="pasture-area-modal-title"');
    expect(modalSrc).toContain('data-pasture-area-modal-backdrop');
    expect(modalSrc).toContain('data-pasture-area-modal=');
    expect(modalSrc).toContain('data-pasture-area-modal-close');
    expect(modalSrc).toContain('data-overlay-dismiss="disabled"');
    expect(modalSrc).toContain('handleDialogKeyDown(e)');
    expect(modalSrc).toContain('closeDisabled');
    // Backdrop click no longer closes; the header X is the single visible close control.
    expect(modalSrc).not.toContain('if (e.target === e.currentTarget) onClose()');
  });

  it('the view opens the modal from a map click (onSelect), gated to the Map tab in select mode', () => {
    expect(viewSrc).toContain('onSelect: handleAreaClick');
    expect(viewSrc).toContain('function renderAreaModal');
    expect(viewSrc).toMatch(/appMode === 'view' &&\s*selectedArea &&\s*!addMode/);
    expect(viewSrc).toContain("!['draw', 'edit', 'measure', 'track', 'droppin'].includes(mapMode)");
  });

  it('permanent paddocks carry a parent-pasture select scoped to permanent pastures', () => {
    expect(viewSrc).toContain('data-pasture-area-parent-select');
    expect(viewSrc).toContain('const parentPastureOptions = React.useMemo');
    expect(viewSrc).toMatch(/a\.kind === 'pasture' && a\.permanence !== 'temporary'/);
    // Assign / clear go through the existing update_land_area mapping (no new RPC).
    expect(viewSrc).toContain('saveAreaPatch(a, parentId ? {parentId} : {clearParent: true})');
    expect(apiSrc).toContain("parentId: 'p_parent_id'");
    expect(apiSrc).toContain("clearParent: 'p_clear_parent'");
  });

  it('a reviewed permanent paddock requires a parent pasture before save/review (no auto-backfill)', () => {
    expect(viewSrc).toContain('function needsParentAssignment');
    expect(viewSrc).toMatch(/isPermanentPaddock\(a\) && !a\.parent_id/);
    // The modal X save/review path is debounced and surfaces the reason when a parent is missing.
    expect(viewSrc).toContain('AREA_MODAL_CLOSE_DEBOUNCE_MS');
    expect(viewSrc).toContain('areaModalCloseRef.current.running');
    expect(viewSrc).toContain('function closeAreaModal');
    expect(viewSrc).toContain("area.review_status !== 'reviewed'");
    expect(viewSrc).toContain('saveAreaReview(area)');
    expect(viewSrc).not.toContain('data-pasture-area-modal-save');
    expect(viewSrc).not.toContain('disabled={saveBlocked');
    expect(viewSrc).toContain('Assign a parent pasture before saving this paddock.');
    // classifyDesignation only marks a permanent paddock reviewed when it has a parent.
    expect(viewSrc).toMatch(/a\.parent_id \? \{reviewStatus: 'reviewed'\} : \{\}/);
    // Parentless permanent paddocks surface in the Reports "Needs pasture assignment".
    expect(viewSrc).toContain('data-pasture-report-needs-pasture');
    expect(viewSrc).toContain('Needs pasture assignment');
  });
});

describe('Pasture Map: reset grazing history (mig 143) + move forms removed from modal', () => {
  it('mig 143 RPC stays deployed (per-area reset) but is no longer wired in the UI', () => {
    // The reset RPC remains in the migration history (deployed, harmless) — Build
    // Queue item 1 removed its UI in favor of a per-ENTRY delete (mig 147).
    expect(mig143Code).toContain('CREATE OR REPLACE FUNCTION public.delete_land_area_grazing_history');
    expect(mig143Code).toContain('SECURITY DEFINER');
    expect(mig143Code).toMatch(/NOT IN \('management', 'admin'\)/);
    expect(mig143Code).toMatch(
      /REVOKE ALL ON FUNCTION public\.delete_land_area_grazing_history\(text\) FROM PUBLIC, anon/,
    );
    expect(mig143Code).toContain(
      'GRANT EXECUTE ON FUNCTION public.delete_land_area_grazing_history(text) TO authenticated',
    );
  });

  it('the per-AREA reset UI + frontend wiring are fully removed', () => {
    // Reset button, handler, state, and the api wrapper are all gone; the RPC is
    // deployed-but-unused.
    expect(apiSrc).not.toContain('deleteLandAreaGrazingHistory');
    expect(apiSrc).not.toContain("sb.rpc('delete_land_area_grazing_history'");
    expect(viewSrc).not.toContain('deleteLandAreaGrazingHistory');
    expect(viewSrc).not.toContain('resetAreaHistory');
    expect(viewSrc).not.toContain('confirmResetId');
    expect(viewSrc).not.toContain('data-pasture-report-reset-history');
    expect(viewSrc).not.toContain('Reset grazing history');
  });

  it('the Area modal hosts no move/plan form (moves live in the side panel); Use records a plan directly', () => {
    expect(viewSrc).not.toContain('function renderMoveAndPlanForms');
    const modalBody = viewSrc.slice(
      viewSrc.indexOf('function renderAreaModal'),
      viewSrc.indexOf('function reportAreaTag'),
    );
    expect(modalBody).not.toContain('data-pasture-move-form');
    expect(modalBody).not.toContain('data-pasture-plan-form');
    expect(modalBody).not.toContain('data-pasture-modal-move');
    // Moves are now in the selected group record; planned moves are removed.
    expect(viewSrc).toContain('function renderGroupMoveBox');
    expect(viewSrc).toContain('data-pasture-group-move-at');
    expect(viewSrc).not.toContain('function renderMoveControls');
    expect(viewSrc).not.toContain('data-pasture-plan-form');
  });
});

describe('Pasture Map: per-entry grazing delete + parent-from-child coloring (mig 147)', () => {
  it('mig 147 adds delete_pasture_move: SECDEF, management/admin gate, REVOKE/GRANT, cascade', () => {
    expect(mig147Code).toContain('CREATE OR REPLACE FUNCTION public.delete_pasture_move');
    expect(mig147Code).toContain('SECURITY DEFINER');
    expect(mig147Code).toContain('public.profile_role()');
    expect(mig147Code).toMatch(/NOT IN \('management', 'admin'\)/);
    // Deletes exactly one move event; impacts cascade via the mig 128 FK.
    expect(mig147Code).toContain('DELETE FROM public.pasture_move_events WHERE id = p_move_id');
    expect(mig147Code).toMatch(/REVOKE ALL ON FUNCTION public\.delete_pasture_move\(text\) FROM PUBLIC, anon/);
    expect(mig147Code).toContain('GRANT EXECUTE ON FUNCTION public.delete_pasture_move(text) TO authenticated');
    // New SECDEF return shape -> PostgREST reload.
    expect(mig147Code).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('mig 147 delete also clears the NEXT move’s linked departures (completed-stay, no drift)', () => {
    // A completed stay's later move-OUT wrote departure impacts derived from this
    // move's touched areas. Deleting only the move-IN would orphan them and leave
    // the area "resting" while Reports shows no stay. The RPC captures this move's
    // destination/overlap areas, finds the next move for the same group, and clears
    // that move's matching departure impacts (preserving the later move event).
    expect(mig147Code).toMatch(/array_agg\(land_area_id\)[\s\S]*?impact_kind IN \('destination', 'overlap'\)/);
    expect(mig147Code).toMatch(
      /animal_type = v_event\.animal_type[\s\S]*?group_key = v_event\.group_key[\s\S]*?\(moved_at, created_at\) > \(v_event\.moved_at, v_event\.created_at\)/,
    );
    expect(mig147Code).toMatch(
      /DELETE FROM public\.pasture_move_impacts[\s\S]*?move_id = v_next_id[\s\S]*?impact_kind = 'departure'[\s\S]*?land_area_id = ANY \(v_touched\)/,
    );
    // The later move event itself is preserved (only its departure impacts go).
    expect(mig147Code).not.toMatch(/DELETE FROM public\.pasture_move_events WHERE id = v_next_id/);
    expect(mig147Code).toContain('linked_departure_impacts_cleared');
    // Serializes the group like record_pasture_move (advisory lock).
    expect(mig147Code).toContain('pg_advisory_xact_lock');
  });

  it('mig 147 suppresses CHILD-derived state on a parent in _land_area_summary', () => {
    expect(mig147Code).toContain('CREATE OR REPLACE FUNCTION public._land_area_summary');
    // Occupancy: ignore overlap impacts whose move destination is a child of p_id.
    expect(mig147Code).toMatch(
      /i\.impact_kind = 'overlap'[\s\S]*?c\.id = l\.to_land_area_id[\s\S]*?c\.parent_id = p_id/,
    );
    // Resting: ignore departures whose move from-area is a child of p_id.
    expect(mig147Code).toMatch(/c\.id = e\.from_land_area_id[\s\S]*?c\.parent_id = p_id/);
    // Designation strokes are NOT changed server-side (still client-locked).
    expect(mig147Code).not.toContain('#1d4ed8');
    expect(mig147Code).not.toContain('#4ade80');
  });

  it('mig 149 ignores orphan (NULL-link) impacts in _land_area_summary', () => {
    // Defect: FP3 / FP3A1 read "Resting / Last grazed" while Reports showed no
    // stay, because overlap/departure impacts whose move event lost its
    // to/from link (143-reset or area hard-delete FK SET NULL) still drove
    // rest_state. mig 149 ignores those orphan impacts in all three derivations.
    expect(mig149Code).toContain('CREATE OR REPLACE FUNCTION public._land_area_summary');
    // Occupancy + last-touch: require the move's destination link (to) be present.
    expect(mig149Code).toContain('l.to_land_area_id IS NOT NULL');
    expect(mig149Code).toContain('e.to_land_area_id IS NOT NULL');
    // Resting: require the departure move's from link be present.
    expect(mig149Code).toMatch(/impact_kind = 'departure'[\s\S]*?e\.from_land_area_id IS NOT NULL/);
    // Preserves mig 147's child-from-parent suppression (keyed on parent_id = p_id).
    expect(mig149Code).toContain('c.parent_id = p_id');
    // Read function only: no schema / RLS / designation-stroke change.
    expect(mig149Code).not.toContain('ALTER TABLE');
    expect(mig149Code).not.toContain('#1d4ed8');
    expect(mig149Code).not.toContain('#4ade80');
    // Return shape unchanged (same keys the client reads).
    expect(mig149Code).toContain("'rest_state', v_rest_state");
    expect(mig149Code).toContain("'last_touched_at', v_last_touch");
    expect(mig149Code).toContain("'last_moved_out_at', v_last_departure");
  });

  it('api exposes deletePastureMove over the new RPC', () => {
    expect(apiSrc).toContain('export async function deletePastureMove');
    expect(apiSrc).toContain("sb.rpc('delete_pasture_move'");
  });

  it('Reports renames the card to Grazing History and adds a per-stay delete (mgmt/admin)', () => {
    expect(viewSrc).toContain('Grazing History');
    expect(viewSrc).not.toContain('Grazing timeline');
    // Per-stay delete targets s.id (the move-IN event id from buildGrazingStays),
    // management/admin only, inline confirm (no window.confirm).
    expect(viewSrc).toContain('async function deleteGrazingStay');
    expect(viewSrc).toContain('deletePastureMove(stay.id)');
    expect(viewSrc).toContain('data-pasture-report-stay-delete');
    expect(viewSrc).toContain('data-pasture-report-stay-delete-yes');
    expect(viewSrc).toContain('confirmDeleteStayId');
    // Gated to management/admin (isManager), reusing the existing role flag.
    expect(viewSrc).toMatch(/isManager && \(\s*<div className="pm-record-stay-actions"/);
    expect(viewSrc).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  });

  it('the side-panel cockpit header text is removed', () => {
    expect(viewSrc).not.toContain('Plan / Grazing cockpit');
    expect(viewSrc).not.toContain('Move planner');
    expect(viewSrc).not.toContain('Pick a group, then build its rotation');
  });

  it('Animal Groups tiles show location + open an inline group record on click', () => {
    expect(viewSrc).toContain('data-surface="pasture-group-table"');
    expect(viewSrc).toContain('pm-open-tile pm-group-tile hoverable-tile');
    expect(viewSrc).toContain('formatTimeInArea(loc.movedAt)');
    expect(viewSrc).toContain('openableProps(() => openGroupRecord(group))');
    expect(viewSrc).toContain('function openGroupRecord');
    expect(viewSrc).toContain('function renderGroupRecord');
    expect(viewSrc).not.toContain('<PastureGroupHistoryModal');
    expect(viewSrc).toMatch(/listPastureHistoryReport\(\{\s*animalType: groupAnimalType\(openRecordGroup\)/);
    expect(viewSrc).toContain('groupKey: openRecordGroup.groupKey || openRecordGroup.id');
  });

  it('the inline group grazing-history table shows grazing stays + metrics', () => {
    expect(viewSrc).toContain('function buildGroupGrazingStays');
    expect(viewSrc).toContain('data-pasture-group-grazing-history');
    expect(viewSrc).toContain('surfaceKey="pasture-group-grazing-history"');
    expect(viewSrc).toContain("label: 'Head/ac'");
    expect(viewSrc).toContain("label: 'Animal-days'");
    expect(viewSrc).toContain("label: 'Lbs/ac'");
    expect(viewSrc).toContain('lbsPerAcre');
    expect(viewSrc).toContain('totalWeightLbs: group.totalWeightLbs || null');
  });
});

describe('Feeder-pig destinations prefer the permanent pig-pasture paddocks', () => {
  it('add-from-map steers a feeder-pig group off the parent ~5ac pasture to a paddock', () => {
    // V1 reset: no rotation auto-seed; the feeder-pig preference is enforced when a
    // user adds a stop (appendToRotation refuses the parent pasture that has paddocks).
    expect(viewSrc).toContain('isPigPastureWithPaddocks(area, destinationAreas)');
    expect(viewSrc).toMatch(/animalType === 'feeder_pigs'/);
  });

  it('helpers exist in the planner-groups lib (feeder filter + parent guard)', () => {
    const planner = read('src/lib/pasturePlannerGroups.js');
    expect(planner).toContain('export function destinationsForGroup');
    expect(planner).toContain("designation === 'feeder_pig'");
    expect(planner).toContain('export function isPigPastureWithPaddocks');
  });

  it('the Map canvas still renders every area (parent pig pastures are NOT removed)', () => {
    // Areas are sorted for click order but none are filtered out by kind.
    expect(canvasSrc).toContain('ordered.forEach');
    expect(canvasSrc).not.toMatch(/areas\.filter\([^)]*kind !== 'pasture'/);
  });
});

describe('Pasture Map pop-out tiles + inline area name editor', () => {
  it('the 3 launcher surfaces are openable POP-OUT tiles (.hoverable-tile + openableProps), not flat rows', () => {
    // Ronnie direction: the Map Animal-groups + Reports Areas + Reports Animal-groups
    // lists must POP OUT on hover like the Home tiles / Pasture Map button. The shared
    // .hoverable-tile lift belongs on a div (never a <tr>), wired via openableProps for
    // keyboard row-open, with the shared chevron.
    for (const surface of [
      'data-surface="pasture-group-table"',
      'data-surface="pasture-report-area-table"',
      'data-surface="pasture-report-group-table"',
    ]) {
      expect(viewSrc).toContain(surface);
    }
    expect(viewSrc).toContain("import {openableProps} from '../shared/openable.js'");
    expect(viewSrc).toContain('pm-open-tile pm-group-tile hoverable-tile');
    expect(viewSrc).toContain('pm-open-tile pm-area-tile hoverable-tile');
    expect(viewSrc).toContain('openableProps(() => openGroupRecord(group))');
    expect(viewSrc).toContain("openableProps(() => openGroupRecord(group, 'reports'))");
    expect(viewSrc).toContain('<span className="chev" aria-hidden="true">');
    // The three launcher surfaces no longer render as DataTables.
    expect(viewSrc).not.toContain('surfaceKey="pasture-group-table"');
    expect(viewSrc).not.toContain('surfaceKey="pasture-report-area-table"');
    expect(viewSrc).not.toContain('surfaceKey="pasture-report-group-table"');
  });

  it('the pop-out lift never lands on a <tr> (affordance contract: hoverable-tile is for divs)', () => {
    expect(viewSrc).not.toMatch(/<tr[^>]*hoverable-tile/);
  });

  it('area name editing is explicit Save/Cancel (no blur-save), shared by the Map modal + Reports record', () => {
    expect(viewSrc).toContain('function AreaNameEditor');
    // The fragile defaultValue + onBlur name save is gone.
    expect(viewSrc).not.toContain('isTemp ? renameTemp(area, value) : saveAreaPatch(area, {name: value})');
    expect(viewSrc).toMatch(/data-pasture-area-name-save/);
    expect(viewSrc).toMatch(/data-pasture-area-name-cancel/);
    expect(viewSrc).toMatch(/data-pasture-area-name-input/);
    // Enter saves; Escape cancels and does not bubble to close the host modal.
    expect(viewSrc).toMatch(/e\.key === 'Enter'[\s\S]*?save\(\)/);
    expect(viewSrc).toMatch(/e\.key === 'Escape'[\s\S]*?e\.stopPropagation\(\)[\s\S]*?cancel\(\)/);
    // Visible saving / saved / error state.
    expect(viewSrc).toContain("status === 'saving' ? 'Saving");
    expect(viewSrc).toContain('pm-name-edit-status is-saved');
    expect(viewSrc).toContain('pm-name-edit-status is-error');
    // Canonical: ONE AreaNameEditor lives in the shared Manage-area section, which
    // renderAreaRecordContent renders in BOTH shells (Map modal + Reports record).
    expect((viewSrc.match(/<AreaNameEditor/g) || []).length).toBe(1);
    expect(viewSrc).toContain('canEdit={canManageArea}');
    // Permanent areas save via updateLandArea; temp via renameTempLandArea.
    expect(viewSrc).toMatch(
      /async function saveAreaName[\s\S]*?renameTempLandArea\(a\.id, name\)[\s\S]*?updateLandArea\(a\.id, \{name\}\)/,
    );
  });

  it('the area name editor only renames — move recording stays in the group workflow', () => {
    const editor = viewSrc.slice(
      viewSrc.indexOf('function AreaNameEditor'),
      viewSrc.indexOf('export default function PastureMapView'),
    );
    expect(editor).not.toContain('record_pasture_move');
    expect(editor).not.toContain('recordMove');
  });

  it('the area record is ONE canonical body (renderAreaRecordContent) rendered in BOTH shells', () => {
    expect(viewSrc).toContain('function renderAreaRecordContent');
    expect(viewSrc).toContain('function renderAreaGrazingHistory');
    // Both shells render the canonical content.
    const modalBody = viewSrc.slice(
      viewSrc.indexOf('function renderAreaModal'),
      viewSrc.indexOf('function reportAreaTag'),
    );
    expect(modalBody).toContain('renderAreaRecordContent()');
    const recordShell = viewSrc.slice(
      viewSrc.indexOf('function renderAreaRecord()'),
      viewSrc.indexOf('function renderPanel'),
    );
    expect(recordShell).toContain('renderAreaRecordContent()');
    // The canonical body composes the merged Area summary + grazing history +
    // line style + danger, so the Reports record gains management and the Map
    // modal gains grazing history.
    const content = viewSrc.slice(
      viewSrc.indexOf('function renderAreaRecordContent'),
      viewSrc.indexOf('function renderAreaRecord()'),
    );
    expect(content).toContain('renderAreaSummary()');
    expect(content).toContain('renderAreaGrazingHistory()');
    expect(content).toContain('renderDangerZone(area)');
    // Area detail + Manage area are MERGED into one section (renderAreaSummary):
    // the management controls render inside the detail card, not a separate one.
    const summary = viewSrc.slice(
      viewSrc.indexOf('function renderAreaSummary'),
      viewSrc.indexOf('function renderOccupiedExplain'),
    );
    expect(summary).toContain('renderAreaManageActions(area)');
    expect(summary).toContain('<div className="pm-kicker">Area</div>');
    // The redundant read-only "Type" row is gone (Classification names the kind).
    expect(summary).not.toContain('<span>Type</span>');
    // The standalone "Manage area" section/title is gone.
    expect(viewSrc).not.toContain('<div className="pm-modal-section-label">Manage area</div>');
    // Opening an area from Reports sets selectedId so the shared body (built on the
    // selected area) renders in the Reports shell too.
    expect(viewSrc).toContain('function openAreaRecord');
    expect(viewSrc).toMatch(/function openAreaRecord[\s\S]*?setReportAreaId\(areaId\)[\s\S]*?setSelectedId\(areaId\)/);
    expect(viewSrc).toContain('openableProps(() => openAreaRecord(area.id))');
  });
});

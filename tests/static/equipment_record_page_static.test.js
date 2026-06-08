import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const fleetView = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentFleetView.jsx'), 'utf8');
const detail = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentDetail.jsx'), 'utf8');
const home = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentHome.jsx'), 'utf8');
const registry = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const fuelLog = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentFuelLogView.jsx'), 'utf8');
const csvExport = fs.readFileSync(path.join(ROOT, 'src/lib/csvExport.js'), 'utf8');
const savedViewsApi = fs.readFileSync(path.join(ROOT, 'src/lib/savedViewsApi.js'), 'utf8');

describe('EquipmentFleetView — no legacy Activity surfaces', () => {
  it('does not import ActivityPanel', () => {
    expect(fleetView).not.toMatch(/^import ActivityPanel/m);
  });
  it('does not import ActivityModal', () => {
    expect(fleetView).not.toMatch(/^import ActivityModal/m);
  });
  it('does not render ActivityPanel', () => {
    expect(fleetView).not.toContain('ActivityPanel');
  });
  it('does not render ActivityModal', () => {
    expect(fleetView).not.toContain('ActivityModal');
  });
  it('does not have activityTarget state', () => {
    expect(fleetView).not.toContain('setActivityTarget');
  });
  it('does not have deep-link listener', () => {
    expect(fleetView).not.toContain('wcf-entity-deep-link');
  });
});

describe('EquipmentDetail — record page structure', () => {
  it('uses shared RecordPageBody and RecordTitle chrome for the loaded detail body', () => {
    expect(detail).toContain("from '../shared/RecordPageShell.jsx'");
    expect(detail).toMatch(/<RecordPageBody[^>]*data-equipment-record-loaded="true"/);
    expect(detail).toContain('<RecordTitle fontSize={20} margin="0"');
  });

  it('renders RecordCollaborationSection with equipment.item', () => {
    expect(detail).toContain('RecordCollaborationSection');
    expect(detail).toContain('entityType="equipment.item"');
  });
  it('passes entityId and entityLabel to the collaboration section', () => {
    expect(detail).toContain('entityId={eq.id}');
    expect(detail).toContain('entityLabel={eq.name}');
  });
  it('does not import ActivityPanel or ActivityModal', () => {
    expect(detail).not.toMatch(/^import ActivityPanel/m);
    expect(detail).not.toMatch(/^import ActivityModal/m);
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(detail).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(detail).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('imports useLocation for hash-scroll', () => {
    expect(detail).toContain("from 'react-router-dom'");
    expect(detail).toContain('useLocation');
  });
  it('handles hash anchors for comment deep-links', () => {
    expect(detail).toContain('location.hash');
    expect(detail).toContain('scrollIntoView');
  });
});

describe('EquipmentHome — ID and slug routing', () => {
  it('resolves detail by slug', () => {
    expect(home).toContain('e.slug === detailSlug');
  });
  it('falls back to resolving by ID', () => {
    expect(home).toContain('e.id === detailSlug');
  });
});

describe('activityRegistry — equipment.item route', () => {
  it('routes to /fleet/<id> by entity id', () => {
    expect(registry).toContain('route: (id) => `/fleet/${id}`');
  });
  it('does not require slug context for routing', () => {
    expect(registry).not.toMatch(/EQUIPMENT_ITEM[\s\S]*?ctx\.slug/);
  });
});

describe('EquipmentFuelLogView — CSV export (Lane K CP2)', () => {
  it('uses the shared csvExport owner for browser download mechanics', () => {
    expect(csvExport).toContain('export function rowsToCsv');
    expect(csvExport).toContain('export function csvFilename');
    expect(csvExport).toContain('export function downloadCsv');
    expect(csvExport).toContain('new Blob');
    expect(csvExport).toContain('URL.createObjectURL');
  });

  it('imports the shared csvExport helpers (no local download mechanics)', () => {
    expect(fuelLog).toMatch(/import\s*\{[^}]*\}\s*from\s*'\.\.\/lib\/csvExport\.js'/);
    for (const name of ['csvFilename', 'downloadCsv', 'rowsToCsv']) {
      expect(fuelLog).toContain(name);
    }
  });

  it('defines handleExportCsv and a toolbar Export CSV button with the marker', () => {
    expect(fuelLog).toContain('function handleExportCsv');
    expect(fuelLog).toContain('data-equipment-fuel-log-export-csv="1"');
    expect(fuelLog).toContain('Export CSV');
    expect(fuelLog).toContain('onClick={handleExportCsv}');
  });

  it('exports the current filtered rows, not raw fuelings, and is NOT capped to the 500-row render slice', () => {
    expect(fuelLog).toContain('rowsToCsv(columns, filtered)');
    expect(fuelLog).not.toContain('rowsToCsv(columns, fuelings)');
    expect(fuelLog).not.toContain('rowsToCsv(columns, filtered.slice');
  });

  it('strips Podio HTML from the comments column', () => {
    expect(fuelLog).toContain('stripPodioHtml(f.comments)');
  });

  it('includes the key fuel-log export headers', () => {
    for (const header of [
      'Date',
      'Equipment name',
      'Equipment ID',
      'Fuel type',
      'Gallons',
      'DEF gallons',
      'Fuel cost per gallon',
      'Estimated fuel cost',
      'Hours reading',
      'KM reading',
      'Team member',
      'Comments',
      'Record ID',
    ]) {
      expect(fuelLog).toContain(`'${header}'`);
    }
  });

  it('keeps the fallback browser-only and free of window.alert/confirm', () => {
    expect(fuelLog).toContain('CSV export is only available in the browser.');
    expect(fuelLog).not.toContain('window.alert');
    expect(fuelLog).not.toContain('window.confirm');
  });
});

describe('EquipmentFuelLogView - saved views (Lane F)', () => {
  it('receives sb/authState from EquipmentHome for saved-view ownership', () => {
    expect(home).toContain('<EquipmentFuelLogView');
    expect(home).toContain('sb={sb}');
    expect(home).toContain('authState={authState}');
  });

  it('uses the shared app_saved_views API owner and equipment fuel-log surface', () => {
    expect(savedViewsApi).toContain("from('app_saved_views')");
    expect(fuelLog).toContain("from '../lib/savedViewsApi.js'");
    expect(fuelLog).toContain("const EQUIPMENT_FUEL_LOG_SURFACE_KEY = 'equipment.fuelLog'");
    expect(fuelLog).toContain('listSavedViews(sb, EQUIPMENT_FUEL_LOG_SURFACE_KEY)');
    expect(fuelLog).toContain('surfaceKey: EQUIPMENT_FUEL_LOG_SURFACE_KEY');
    expect(fuelLog).toContain('createSavedView(sb, {');
    expect(fuelLog).toContain('updateSavedView(sb, selectedView.id');
    expect(fuelLog).toContain('deleteSavedView(sb, view.id)');
  });

  it('saves and restores every fuel-log filter', () => {
    expect(fuelLog).toContain('function equipmentFuelLogViewState()');
    for (const field of ['eqFilter', 'fuelFilter', 'teamFilter', 'fromDate', 'toDate']) {
      expect(fuelLog).toContain(`${field}: ${field} || ''`);
      expect(fuelLog).toContain(`typeof st.${field} === 'string' ? st.${field} : ''`);
    }
  });

  it('renders the saved-view control and degrades saved-view failures locally', () => {
    const savedViewBlock = fuelLog.slice(
      fuelLog.indexOf('async function loadSavedViews'),
      fuelLog.indexOf('const totals = {'),
    );
    for (const marker of [
      'data-equipment-fuel-log-saved-views-row',
      'data-equipment-fuel-log-saved-view-select',
      'data-equipment-fuel-log-saved-view-save-open',
      'data-equipment-fuel-log-saved-view-form',
      'data-equipment-fuel-log-saved-view-name',
      'data-equipment-fuel-log-saved-view-visibility="private"',
      'data-equipment-fuel-log-saved-view-visibility="public"',
      'data-equipment-fuel-log-saved-view-save',
      'data-equipment-fuel-log-saved-view-update',
      'data-equipment-fuel-log-saved-view-delete',
      'data-equipment-fuel-log-saved-views-error',
    ]) {
      expect(fuelLog).toContain(marker);
    }
    expect(fuelLog).toContain('Saved views unavailable. Filters still work.');
    expect(savedViewBlock).toContain('setSavedViewsError(e.message || String(e))');
    expect(fuelLog).toContain('window._wcfConfirmDelete');
    expect(fuelLog).not.toContain('window.confirm');
    expect(fuelLog).not.toContain('window.prompt');
  });
});

describe('EquipmentHome cold-boot readiness', () => {
  it('tracks loadError separately from the intentional missing-schema banner', () => {
    expect(home).toMatch(/const \[loadError, setLoadError\] = React\.useState\(null\)/);
    expect(home).toMatch(/const \[missingSchema, setMissingSchema\] = React\.useState\(false\)/);
    expect(home).toContain('data-equipment-load-error="true"');
  });

  it('checks all required equipment query errors before rendering fleet/detail data', () => {
    expect(home).toMatch(/if \(eR\.error\) throw new Error\('equipment: ' \+ eR\.error\.message\)/);
    expect(home).toMatch(/if \(fR\.error\) throw new Error\('equipment_fuelings: ' \+ fR\.error\.message\)/);
    expect(home).toMatch(/if \(mR\.error\) throw new Error\('equipment_maintenance_events: ' \+ mR\.error\.message\)/);
  });

  it('clears stale equipment arrays on load failure and gates subviews on !loadError', () => {
    expect(home).toMatch(/setEquipment\(\[\]\);\s*\n\s*setFuelings\(\[\]\);\s*\n\s*setMaintenance\(\[\]\);/);
    expect(home).toMatch(/setLoadError\(\{kind: 'error', message: 'Could not load equipment data: '/);
    expect(home).toMatch(/!loading && !missingSchema && !loadError && subView === 'fleet'/);
    expect(home).toMatch(/!loading && !missingSchema && !loadError && subView === 'detail'/);
  });

  it('exposes a loaded marker only when not loading, not schema-missing, and not in loadError', () => {
    expect(home).toMatch(/data-equipment-home-loaded=\{!loading && !loadError && !missingSchema \? 'true' : 'false'\}/);
  });
});

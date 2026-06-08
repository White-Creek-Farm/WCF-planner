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

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Record Page Visual Consistency CP4 - EquipmentDetail adopts shared control
// styling on the expanded fueling-history edit row, while keeping the 800ms
// autosave for editable fields, photos/manuals/lightbox, the meter panel, and
// service/materials/warranty math.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentDetail.jsx'), 'utf8');

describe('CP4: EquipmentDetail fueling edit row uses shared controls', () => {
  it('imports + uses shared record controls', () => {
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    expect(src).toContain('style={recordControl}');
    expect(src).toContain('recordTextarea');
  });

  it('preserves the 800ms autosave on spec + editable fueling saves', () => {
    expect(src).toContain('function queueFieldSave');
    expect(src).toContain('function queueFuelingSave');
    expect((src.match(/}, 800\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('flushes pending EquipmentDetail autosaves on blur, pagehide, and unmount/navigation', () => {
    expect(src).toContain('const pendingFieldSaves = React.useRef({})');
    expect(src).toContain('const pendingFuelingSaves = React.useRef({})');
    expect(src).toContain('async function flushFieldSave(field)');
    expect(src).toContain('async function flushFuelingSave(key)');
    expect(src).toContain('async function flushAllEquipmentAutosaves()');
    expect(src).toContain("window.addEventListener('pagehide', flush)");
    expect(src).toContain("document.addEventListener('visibilitychange', flushOnVisibility)");
    expect(src).toContain("onBlur={() => flushFuelingFieldSave(f.id, 'date')}");
    expect(src).toContain("onBlur={() => flushFuelingFieldSave(f.id, 'gallons')}");
    expect(src).toContain("onBlur={() => flushFuelingFieldSave(f.id, 'comments')}");
  });

  it('fueling saves still write editable equipment_fuelings fields via queueFuelingSave', () => {
    expect(src).toContain("from('equipment_fuelings')");
    expect(src).toContain("queueFuelingSave(f.id, 'date'");
    expect(src).toContain("queueFuelingSave(f.id, 'gallons'");
    expect(src).toContain("queueFuelingSave(f.id, 'comments'");
  });

  it('locks the fueling Team field to the saved submitter display', () => {
    expect(src).toContain('LockedTeamMemberField');
    expect(src).toContain("value: f.team_member || ''");
    expect(src).not.toContain("queueFuelingSave(f.id, 'team_member'");
    expect(src).not.toContain('legacy - not currently assigned');
    expect(src).not.toContain('No team members assigned');
    expect(src).not.toContain('TeamMemberSelect');
  });

  it('keeps photos / manuals / lightbox / meter / collaboration intact', () => {
    expect(src).toContain('EquipmentMeterStatusPanel');
    expect(src).toContain('ManualsCard');
    expect(src).toContain('setLightbox');
    expect(src).toContain('RecordCollaborationSection');
    expect(src).toContain('f.photos');
    expect(src).toContain('m.photos');
  });
});

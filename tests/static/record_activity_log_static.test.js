import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const componentSrc = fs.readFileSync(path.join(ROOT, 'src/shared/RecordActivityLog.jsx'), 'utf8');

describe('RecordActivityLog — shared component contract', () => {
  it('exports a default function', () => {
    expect(componentSrc).toMatch(/export default function RecordActivityLog/);
  });
  it('accepts sb, entityType, entityId, and optional limit props', () => {
    expect(componentSrc).toMatch(/RecordActivityLog\(\{sb, entityType, entityId, limit/);
  });
  it('defaults limit to 50', () => {
    expect(componentSrc).toContain('limit = 50');
  });
  it('imports listActivityEvents and ACTIVITY_CHANGE_EVENT', () => {
    expect(componentSrc).toContain('listActivityEvents');
    expect(componentSrc).toContain('ACTIVITY_CHANGE_EVENT');
  });
  it('filters out comment.posted events', () => {
    expect(componentSrc).toContain("event_type !== 'comment.posted'");
  });
  it('counts only non-deleted events', () => {
    expect(componentSrc).toContain('!e.deleted_at');
  });
  it('has data-activity-log-toggle hook', () => {
    expect(componentSrc).toContain('data-activity-log-toggle="1"');
  });
  it('has data-activity-audit-log hook', () => {
    expect(componentSrc).toContain('data-activity-audit-log="1"');
  });
  it('renders nothing when entityId or entityType is missing', () => {
    expect(componentSrc).toContain('if (!entityType || !entityId) return null');
  });
  it('soft-fails on activity load errors', () => {
    expect(componentSrc).toContain('/* soft-fail */');
  });
  it('listens for ACTIVITY_CHANGE_EVENT to refresh', () => {
    expect(componentSrc).toContain('addEventListener(ACTIVITY_CHANGE_EVENT');
  });
});

describe('Record pages use shared RecordCollaborationSection (Comments + RecordActivityLog)', () => {
  const pages = [
    {name: 'CattleDailyPage', path: 'src/cattle/CattleDailyPage.jsx', entity: 'cattle.daily'},
    {name: 'CattleAnimalPage', path: 'src/cattle/CattleAnimalPage.jsx', entity: 'cattle.animal'},
    {name: 'CattleForecastView', path: 'src/cattle/CattleForecastView.jsx', entity: 'cattle.forecast'},
    {name: 'SheepAnimalPage', path: 'src/sheep/SheepAnimalPage.jsx', entity: 'sheep.animal'},
    {name: 'SheepDailyPage', path: 'src/sheep/SheepDailyPage.jsx', entity: 'sheep.daily'},
    {name: 'PoultryDailyPage', path: 'src/broiler/PoultryDailyPage.jsx', entity: 'poultry.daily'},
    {name: 'LayerDailyPage', path: 'src/layer/LayerDailyPage.jsx', entity: 'layer.daily'},
    {name: 'EggDailyPage', path: 'src/layer/EggDailyPage.jsx', entity: 'egg.daily'},
    {name: 'PigDailyPage', path: 'src/pig/PigDailyPage.jsx', entity: 'pig.daily'},
    {name: 'EquipmentDetail', path: 'src/equipment/EquipmentDetail.jsx', entity: 'equipment.item'},
    {name: 'TaskInstancePage', path: 'src/tasks/TaskInstancePage.jsx', entity: 'task.instance'},
  ];

  for (const p of pages) {
    const src = fs.readFileSync(path.join(ROOT, p.path), 'utf8');
    it(`${p.name} imports RecordCollaborationSection`, () => {
      expect(src).toContain('RecordCollaborationSection');
    });
    it(`${p.name} passes entityType="${p.entity}"`, () => {
      expect(src).toContain(`entityType="${p.entity}"`);
    });
    it(`${p.name} does not import CommentsSection or RecordActivityLog directly`, () => {
      expect(src).not.toContain("from '../shared/CommentsSection.jsx'");
      expect(src).not.toContain("from '../shared/RecordActivityLog.jsx'");
    });
    it(`${p.name} does not directly import listActivityEvents`, () => {
      expect(src).not.toContain('listActivityEvents');
    });
    it(`${p.name} does not directly import ACTIVITY_CHANGE_EVENT`, () => {
      expect(src).not.toContain('ACTIVITY_CHANGE_EVENT');
    });
  }
});

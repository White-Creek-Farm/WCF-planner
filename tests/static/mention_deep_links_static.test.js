import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig063 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/063_notification_activity_resolution.sql'), 'utf8');
const notifApi = fs.readFileSync(path.join(ROOT, 'src/lib/notificationsApi.js'), 'utf8');
const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');
const broilerList = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerListView.jsx'), 'utf8');
const layerBatches = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchesView.jsx'), 'utf8');
const cattleHerds = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
const sheepFlocks = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepFlocksView.jsx'), 'utf8');
const equipFleet = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentFleetView.jsx'), 'utf8');

describe('Migration 063 — list_recent_notifications RPC', () => {
  it('creates SECURITY DEFINER RPC', () => {
    expect(mig063).toContain('list_recent_notifications');
    expect(mig063).toContain('SECURITY DEFINER');
  });

  it('joins activity_events for entity resolution', () => {
    expect(mig063).toContain('LEFT JOIN public.activity_events');
    expect(mig063).toContain('activity_entity_type');
    expect(mig063).toContain('activity_entity_id');
    expect(mig063).toContain('activity_entity_label');
  });

  it('filters by auth.uid() recipient', () => {
    expect(mig063).toContain('auth.uid()');
    expect(mig063).toContain('recipient_profile_id = v_caller');
  });

  it('grants to authenticated only', () => {
    expect(mig063).toMatch(/GRANT EXECUTE.*TO authenticated/);
    expect(mig063).toMatch(/REVOKE ALL.*FROM PUBLIC, anon/);
  });

  it('ends with schema reload', () => {
    expect(mig063).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe('notificationsApi — RPC loader with fallback', () => {
  it('calls list_recent_notifications RPC', () => {
    expect(notifApi).toContain("'list_recent_notifications'");
  });

  it('falls back to direct table query only for missing-function errors', () => {
    expect(notifApi).toContain("from('notifications')");
    expect(notifApi).toContain('MISSING_FN_CODES');
  });

  it('allows PGRST202 as a missing-function code', () => {
    expect(notifApi).toContain('PGRST202');
  });

  it('allows 42883 as a missing-function code', () => {
    expect(notifApi).toContain('42883');
  });

  it('throws on non-missing RPC errors', () => {
    expect(notifApi).toMatch(/!MISSING_FN_CODES\.includes.*throw/s);
  });

  it('does not directly query activity_events', () => {
    expect(notifApi).not.toContain("from('activity_events')");
  });
});

describe('Header — resolved entity routing', () => {
  it('passes activity_entity_type/id to resolveNotificationRoute', () => {
    expect(headerSrc).toContain('n.activity_entity_type');
    expect(headerSrc).toContain('n.activity_entity_id');
  });

  it('sets _wcfEntityDeepLink for non-task entities', () => {
    expect(headerSrc).toContain('_wcfEntityDeepLink');
  });

  it('dispatches wcf-entity-deep-link event', () => {
    expect(headerSrc).toContain('wcf-entity-deep-link');
  });
});

describe('Per-surface deep-link handlers', () => {
  const surfaces = [
    {name: 'BroilerListView', src: broilerList, entity: 'broiler.batch'},
    {name: 'LayerBatchesView', src: layerBatches, entity: 'layer.batch'},
    {name: 'CattleHerdsView', src: cattleHerds, entity: 'cattle.animal'},
    {name: 'SheepFlocksView', src: sheepFlocks, entity: 'sheep.animal'},
    {name: 'EquipmentFleetView', src: equipFleet, entity: 'equipment.item'},
  ];

  for (const s of surfaces) {
    it(`${s.name} listens for wcf-entity-deep-link`, () => {
      expect(s.src).toContain('wcf-entity-deep-link');
      expect(s.src).toContain('addEventListener');
    });

    it(`${s.name} checks for ${s.entity} entity type`, () => {
      expect(s.src).toContain(`'${s.entity}'`);
      expect(s.src).toContain('_wcfEntityDeepLink');
    });

    it(`${s.name} opens ActivityModal on deep-link match`, () => {
      expect(s.src).toContain('setActivityTarget');
    });
  }

  it('LayerBatchesView also handles layer.housing deep-links', () => {
    expect(layerBatches).toContain("'layer.housing'");
  });

  it('EquipmentFleetView passes slug in entityCtx on deep-link', () => {
    expect(equipFleet).toMatch(/slug:\s*eq\.slug/);
  });
});

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

  it('direct-routes record-page notifications via headerNavigate', () => {
    expect(headerSrc).toContain('isRecordPageRoute');
    expect(headerSrc).toContain('headerNavigate(route)');
  });

  it('no longer sets _wcfEntityDeepLink or dispatches the legacy bridge event', () => {
    expect(headerSrc).not.toContain('_wcfEntityDeepLink');
    expect(headerSrc).not.toContain('wcf-entity-deep-link');
  });
});

describe('Per-surface deep-link handlers', () => {
  // pig.batch retired its inline-modal deep-link path in CP5 — its
  // activity/comment notifications now route straight to /pig/batches/<id>.
  const pigBatches = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');

  it('PigBatchesView no longer wires wcf-entity-deep-link, ActivityModal, or setActivityTarget', () => {
    expect(pigBatches).not.toContain('wcf-entity-deep-link');
    expect(pigBatches).not.toContain('ActivityModal');
    expect(pigBatches).not.toContain('setActivityTarget');
  });

  it('pig.batch routes by encoded id to its record page (registry)', () => {
    const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
    expect(registrySrc).toMatch(
      /PIG_BATCH[\s\S]*?route:\s*\(id\)\s*=>\s*'\/pig\/batches\/'\s*\+\s*encodeURIComponent\(id\)/,
    );
  });

  it('BroilerListView no longer wires wcf-entity-deep-link', () => {
    expect(broilerList).not.toContain('wcf-entity-deep-link');
  });

  it('broiler.batch routes by encoded name to record page (registry)', () => {
    const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
    expect(registrySrc).toMatch(
      /BROILER_BATCH[\s\S]*?route:\s*\(id\)\s*=>\s*'\/broiler\/batches\/'\s*\+\s*encodeURIComponent\(id\)/,
    );
  });

  it('CattleHerdsView no longer wires wcf-entity-deep-link and routes tiles to its record page', () => {
    expect(cattleHerds).not.toContain('wcf-entity-deep-link');
    expect(cattleHerds).toContain("navigate('/cattle/herds/'");
  });

  it('SheepFlocksView no longer wires wcf-entity-deep-link and routes tiles to its record page', () => {
    expect(sheepFlocks).not.toContain('wcf-entity-deep-link');
    expect(sheepFlocks).toContain("navigate('/sheep/flocks/'");
  });

  it('layer.batch routes by ID to record page (registry)', () => {
    const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
    expect(registrySrc).toMatch(/LAYER_BATCH[\s\S]*?route:\s*\(id\)\s*=>\s*'\/layer\/batches\/'\s*\+\s*id/);
  });

  it('layer.housing routes by ID to record page (registry)', () => {
    const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
    expect(registrySrc).toMatch(/LAYER_HOUSING[\s\S]*?route:\s*\(id\)\s*=>\s*'\/layer\/housings\/'\s*\+\s*id/);
  });

  it('LayerBatchesView no longer wires wcf-entity-deep-link', () => {
    expect(layerBatches).not.toContain('wcf-entity-deep-link');
  });

  it('equipment.item routes by ID (record page, not modal)', () => {
    const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
    expect(registrySrc).toContain('route: (id) => `/fleet/${id}`');
  });
});

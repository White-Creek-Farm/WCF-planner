import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {ENTITY_TYPES, ACTIVITY_REGISTRY} from '../../src/lib/activityRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig064 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/064_activity_entity_phase2.sql'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const pigBatches = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');
const cattleBatches = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBatchesView.jsx'), 'utf8');
const cattleBatchPage = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBatchPage.jsx'), 'utf8');
const sheepBatches = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepBatchesView.jsx'), 'utf8');
const sheepBatchPage = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepBatchPage.jsx'), 'utf8');

const NEW_TYPES = ['pig.batch', 'cattle.processing', 'sheep.processing'];

describe('activityRegistry — Phase 2 entity types', () => {
  for (const t of NEW_TYPES) {
    it(`exports ${t} in ENTITY_TYPES`, () => {
      expect(Object.values(ENTITY_TYPES)).toContain(t);
    });

    it(`has registry entry for ${t}`, () => {
      expect(ACTIVITY_REGISTRY[t]).toBeTruthy();
      expect(typeof ACTIVITY_REGISTRY[t].route).toBe('function');
    });
  }

  it('pig.batch uses batchName for displayLabel', () => {
    expect(ACTIVITY_REGISTRY['pig.batch'].displayLabel('id', {batchName: 'P-26-01'})).toBe('P-26-01');
  });

  it('routeToView maps pig/cattle/sheep batch routes', () => {
    expect(registrySrc).toContain("'/pig/batches': 'pigbatches'");
    expect(registrySrc).toContain("'/cattle/batches': 'cattlebatches'");
    expect(registrySrc).toContain("'/sheep/batches': 'sheepbatches'");
  });
});

describe('Migration 064 — Phase 2 resolvers', () => {
  for (const t of NEW_TYPES) {
    it(`has _activity_can_read branch for ${t}`, () => {
      expect(mig064).toContain(`'${t}'`);
    });
  }

  it('pig.batch resolves via app_store ppp-feeders-v1', () => {
    expect(mig064).toContain('ppp-feeders-v1');
    expect(mig064).toContain("jsonb_build_array(jsonb_build_object('id', p_entity_id))");
  });

  it('cattle.processing resolves via cattle_processing_batches', () => {
    expect(mig064).toContain('cattle_processing_batches');
  });

  it('sheep.processing resolves via sheep_processing_batches', () => {
    expect(mig064).toContain('sheep_processing_batches');
  });

  it('enforces program_access for new types', () => {
    for (const program of ['pig', 'cattle', 'sheep']) {
      expect(mig064).toContain(`'${program}' = ANY(v_access)`);
    }
  });

  it('preserves role gate', () => {
    expect(mig064).toContain('profile_role()');
    expect(mig064).toMatch(/v_role = 'inactive'/);
  });
});

describe('Activity wiring — Phase 2 legacy surfaces (pig.batch remains inline ActivityPanel)', () => {
  it('PigBatchesView renders ActivityPanel compact for pig.batch', () => {
    expect(pigBatches).toContain("entityType: 'pig.batch'");
    expect(pigBatches).toContain("mode: 'compact'");
  });

  it('PigBatchesView renders ActivityModal', () => {
    expect(pigBatches).toContain('ActivityModal');
    expect(pigBatches).toContain('activityTarget');
  });

  it('PigBatchesView has data-activity-surface hook', () => {
    expect(pigBatches).toContain('pig.batch');
    expect(pigBatches).toContain('data-activity-surface');
  });

  it('PigBatchesView has stopPropagation on chip', () => {
    expect(pigBatches).toContain('stopPropagation');
  });

  it('PigBatchesView has deep-link listener', () => {
    expect(pigBatches).toContain('wcf-entity-deep-link');
    expect(pigBatches).toContain('addEventListener');
  });

  it('pig.batch uses g.id as entityId', () => {
    expect(pigBatches).toMatch(/entityId:\s*g\.id/);
  });
});

describe('cattle.processing — migrated to record page', () => {
  it('CattleBatchesView no longer has ActivityPanel or ActivityModal', () => {
    expect(cattleBatches).not.toContain('ActivityPanel');
    expect(cattleBatches).not.toContain('ActivityModal');
    expect(cattleBatches).not.toContain('activityTarget');
  });

  it('CattleBatchPage uses RecordCollaborationSection for Comments + Activity', () => {
    expect(cattleBatchPage).toContain('RecordCollaborationSection');
    expect(cattleBatchPage).toContain('entityType="cattle.processing"');
  });

  it('CattleBatchPage does not use ActivityPanel or ActivityModal', () => {
    expect(cattleBatchPage).not.toContain('ActivityPanel');
    expect(cattleBatchPage).not.toContain('ActivityModal');
  });

  it('CattleBatchesView navigates to /cattle/batches/<id> for real batches', () => {
    expect(cattleBatches).toContain("navigate('/cattle/batches/' + b.id)");
  });

  it('CattleBatchesView has CattleBatchesRouter wrapper', () => {
    expect(cattleBatches).toContain('CattleBatchesRouter');
    expect(cattleBatches).toContain("location.pathname.startsWith('/cattle/batches/')");
  });
});

describe('sheep.processing — migrated to record page', () => {
  it('SheepBatchesView no longer has ActivityPanel, ActivityModal, or activityTarget', () => {
    expect(sheepBatches).not.toContain('ActivityPanel');
    expect(sheepBatches).not.toContain('ActivityModal');
    expect(sheepBatches).not.toContain('activityTarget');
  });

  it('SheepBatchesView no longer listens for wcf-entity-deep-link', () => {
    expect(sheepBatches).not.toContain('wcf-entity-deep-link');
  });

  it('SheepBatchPage uses RecordCollaborationSection for Comments + Activity', () => {
    expect(sheepBatchPage).toContain('RecordCollaborationSection');
    expect(sheepBatchPage).toContain('entityType="sheep.processing"');
  });

  it('SheepBatchPage does not use ActivityPanel or ActivityModal', () => {
    expect(sheepBatchPage).not.toContain('ActivityPanel');
    expect(sheepBatchPage).not.toContain('ActivityModal');
  });

  it('SheepBatchesView navigates to /sheep/batches/<id> for tile clicks', () => {
    expect(sheepBatches).toContain("navigate('/sheep/batches/' + b.id)");
  });

  it('SheepBatchesView has SheepBatchesRouter wrapper', () => {
    expect(sheepBatches).toContain('SheepBatchesRouter');
    expect(sheepBatches).toContain("location.pathname.startsWith('/sheep/batches/')");
  });
});

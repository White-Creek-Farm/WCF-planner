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
const sheepBatches = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepBatchesView.jsx'), 'utf8');

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

describe('Activity wiring — Phase 2 surfaces', () => {
  const surfaces = [
    {name: 'PigBatchesView', src: pigBatches, entity: 'pig.batch'},
    {name: 'CattleBatchesView', src: cattleBatches, entity: 'cattle.processing'},
    {name: 'SheepBatchesView', src: sheepBatches, entity: 'sheep.processing'},
  ];

  for (const s of surfaces) {
    it(`${s.name} renders ActivityPanel compact for ${s.entity}`, () => {
      expect(s.src).toContain(`entityType: '${s.entity}'`);
      expect(s.src).toContain("mode: 'compact'");
    });

    it(`${s.name} renders ActivityModal`, () => {
      expect(s.src).toContain('ActivityModal');
      expect(s.src).toContain('activityTarget');
    });

    it(`${s.name} has data-activity-surface hook`, () => {
      expect(s.src).toContain(s.entity);
      expect(s.src).toContain('data-activity-surface');
    });

    it(`${s.name} has stopPropagation on chip`, () => {
      expect(s.src).toContain('stopPropagation');
    });

    it(`${s.name} has deep-link listener`, () => {
      expect(s.src).toContain('wcf-entity-deep-link');
      expect(s.src).toContain('addEventListener');
    });
  }

  it('pig.batch uses g.id as entityId', () => {
    expect(pigBatches).toMatch(/entityId:\s*g\.id/);
  });

  it('cattle.processing uses batch.id as entityId', () => {
    expect(cattleBatches).toMatch(/entityId:\s*batch\.id/);
  });

  it('sheep.processing uses b.id as entityId', () => {
    expect(sheepBatches).toMatch(/entityId:\s*b\.id/);
  });
});

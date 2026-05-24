import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {ENTITY_TYPES, ACTIVITY_REGISTRY} from '../../src/lib/activityRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const broilerDailys = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerDailysView.jsx'), 'utf8');
const layerDailys = fs.readFileSync(path.join(ROOT, 'src/layer/LayerDailysView.jsx'), 'utf8');
const eggDailys = fs.readFileSync(path.join(ROOT, 'src/layer/EggDailysView.jsx'), 'utf8');
const pigDailys = fs.readFileSync(path.join(ROOT, 'src/pig/PigDailysView.jsx'), 'utf8');
const cattleDailys = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleDailysView.jsx'), 'utf8');
const sheepDailys = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepDailysView.jsx'), 'utf8');

const DAILY_TYPES = ['poultry.daily', 'layer.daily', 'egg.daily', 'pig.daily', 'cattle.daily', 'sheep.daily'];

describe('activityRegistry — daily entity types', () => {
  for (const t of DAILY_TYPES) {
    it(`exports ${t} in ENTITY_TYPES`, () => {
      expect(Object.values(ENTITY_TYPES)).toContain(t);
    });

    it(`has registry entry for ${t}`, () => {
      expect(ACTIVITY_REGISTRY[t]).toBeTruthy();
      expect(typeof ACTIVITY_REGISTRY[t].route).toBe('function');
    });
  }
});

describe('Activity wiring — daily view surfaces', () => {
  const surfaces = [
    {name: 'BroilerDailysView', src: broilerDailys, entity: 'poultry.daily'},
    {name: 'LayerDailysView', src: layerDailys, entity: 'layer.daily'},
    {name: 'EggDailysView', src: eggDailys, entity: 'egg.daily'},
    {name: 'PigDailysView', src: pigDailys, entity: 'pig.daily'},
    {name: 'CattleDailysView', src: cattleDailys, entity: 'cattle.daily'},
    {name: 'SheepDailysView', src: sheepDailys, entity: 'sheep.daily'},
  ];

  for (const s of surfaces) {
    it(`${s.name} imports ActivityPanel`, () => {
      expect(s.src).toContain("import ActivityPanel from '../shared/ActivityPanel.jsx'");
    });

    it(`${s.name} imports ActivityModal`, () => {
      expect(s.src).toContain("import ActivityModal from '../shared/ActivityModal.jsx'");
    });

    it(`${s.name} renders ActivityPanel compact for ${s.entity}`, () => {
      expect(s.src).toContain(`entityType: '${s.entity}'`);
      expect(s.src).toContain("mode: 'compact'");
    });

    it(`${s.name} renders ActivityModal with activityTarget`, () => {
      expect(s.src).toContain('ActivityModal');
      expect(s.src).toContain('activityTarget');
      expect(s.src).toContain('setActivityTarget');
    });

    it(`${s.name} has data-activity-surface="${s.entity}"`, () => {
      expect(s.src).toContain(`data-activity-surface="${s.entity}"`);
    });

    it(`${s.name} has stopPropagation on chip wrapper`, () => {
      expect(s.src).toContain('stopPropagation');
    });

    it(`${s.name} uses d.id as entityId`, () => {
      expect(s.src).toMatch(/entityId:\s*d\.id/);
    });

    it(`${s.name} has deep-link listener for ${s.entity}`, () => {
      expect(s.src).toContain('wcf-entity-deep-link');
      expect(s.src).toContain('addEventListener');
      expect(s.src).toContain(`dl.entityType !== '${s.entity}'`);
    });

    it(`${s.name} clears deep-link after opening`, () => {
      expect(s.src).toContain('window._wcfEntityDeepLink = null');
    });
  }
});

describe('Activity wiring — no direct table access in daily views', () => {
  const allSrc = [broilerDailys, layerDailys, eggDailys, pigDailys, cattleDailys, sheepDailys];
  for (const src of allSrc) {
    it('does not reference .from(activity_events)', () => {
      expect(src).not.toMatch(/\.from\(['"]activity_events['"]\)/);
    });
    it('does not reference .from(activity_mentions)', () => {
      expect(src).not.toMatch(/\.from\(['"]activity_mentions['"]\)/);
    });
  }
});

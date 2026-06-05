import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {buildMaterialChecklist, HOURS_WINDOW, KM_WINDOW} from '../../src/lib/equipmentMaterials.js';

// ============================================================================
// Equipment Materials Rolling Checklist — mig 048 + UI wiring + helper logic
// ============================================================================
// Mig 048 ships two auth-only tables (equipment_service_materials +
// equipment_material_clears) plus an idempotent seed of the approved list.
// The admin Materials editor + the home dashboard Materials Needed card
// read these tables. The standalone /fleet/materials operator page was
// retired 2026-05-14 — its surface now lives on the home card. Codex-
// mandated locks:
//
//   1. Mig contract — table shapes, FK, structural-identity unique index
//      (Codex amendment 3: identity excludes service_label), authenticated-
//      only RLS, no anon policies.
//   2. Seed locks — 5065 50h has Grease + Loctite 567; 5065 50h does NOT
//      seed any "air cleaner" / "air filter" material (Codex's curation
//      rule that "knock out air cleaner" cleaning-only lines stay out of
//      the materials list).
//   3. Helper logic — due windows: hours+100, km+5000; never-completed
//      vs previously-completed clear-bucket math (Codex amendment 4);
//      'use' interval always present; clear-one hides only that material;
//      crossing the next_due milestone makes a stale clear no longer match.
//   4. UI wiring — admin editor writes to equipment_service_materials, NOT
//      to equipment.service_intervals JSONB (Codex amendment 3).
//      EquipmentHome /fleet/materials route is aliased to /fleet in
//      routes.js; the sub-nav has no Materials button.
//   5. Editor stays internal — no anon policies on the new tables.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const migSrc = fs.readFileSync(path.join(ROOT, 'supabase-migrations/048_equipment_service_materials.sql'), 'utf8');
const helperSrc = fs.readFileSync(path.join(ROOT, 'src/lib/equipmentMaterials.js'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'src/admin/EquipmentMaterialsEditor.jsx'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'src/admin/EquipmentWebformsAdmin.jsx'), 'utf8');
const homeSrc = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentHome.jsx'), 'utf8');
const routesSrc = fs.readFileSync(path.join(ROOT, 'src/lib/routes.js'), 'utf8');
const dashboardSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');

describe('Mig 048 — equipment_service_materials table contract', () => {
  it('CREATE TABLE IF NOT EXISTS equipment_service_materials with FK to equipment', () => {
    expect(migSrc).toMatch(/CREATE TABLE IF NOT EXISTS public\.equipment_service_materials/);
    expect(migSrc).toMatch(/equipment_id\s+text\s+NOT NULL\s+REFERENCES public\.equipment\(id\)\s+ON DELETE CASCADE/);
  });

  it('source_kind CHECK constraint allows service_interval and attachment_checklist only', () => {
    expect(migSrc).toMatch(
      /source_kind\s+text\s+NOT NULL\s+CHECK \(source_kind IN \('service_interval', 'attachment_checklist'\)\)/,
    );
  });

  it('interval_unit CHECK constraint allows hours, km, use only', () => {
    expect(migSrc).toMatch(/interval_unit\s+text\s+NOT NULL\s+CHECK \(interval_unit IN \('hours', 'km', 'use'\)\)/);
  });

  it('structural identity unique index excludes service_label (Codex amendment 3)', () => {
    expect(migSrc).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS equipment_service_materials_identity[\s\S]*?\(\s*equipment_id, source_kind, interval_unit, interval_value, attachment_name, material_name\s*\)\s*NULLS NOT DISTINCT/,
    );
    // Defensive: the unique index must NOT contain service_label.
    const idxMatch = migSrc.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS equipment_service_materials_identity[\s\S]*?NULLS NOT DISTINCT/,
    );
    expect(idxMatch).not.toBeNull();
    expect(idxMatch[0]).not.toMatch(/service_label/);
  });
});

describe('Mig 048 — equipment_material_clears table contract', () => {
  it('CREATE TABLE IF NOT EXISTS equipment_material_clears with FKs to materials + equipment', () => {
    expect(migSrc).toMatch(/CREATE TABLE IF NOT EXISTS public\.equipment_material_clears/);
    expect(migSrc).toMatch(
      /material_id\s+text\s+NOT NULL\s+REFERENCES public\.equipment_service_materials\(id\)\s+ON DELETE CASCADE/,
    );
  });

  it('due_bucket_unit CHECK allows hours, km, use', () => {
    expect(migSrc).toMatch(/due_bucket_unit\s+text\s+NOT NULL\s+CHECK \(due_bucket_unit IN \('hours', 'km', 'use'\)\)/);
  });

  it('one clear per (material, due bucket) — unique index with NULLS NOT DISTINCT', () => {
    expect(migSrc).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS equipment_material_clears_identity[\s\S]*?\(material_id, due_bucket_value, due_bucket_unit\)\s*NULLS NOT DISTINCT/,
    );
  });
});

describe('Mig 048 — RLS (authenticated-only, no anon)', () => {
  it('enables RLS on both tables', () => {
    expect(migSrc).toMatch(/ALTER TABLE public\.equipment_service_materials ENABLE ROW LEVEL SECURITY/);
    expect(migSrc).toMatch(/ALTER TABLE public\.equipment_material_clears ENABLE ROW LEVEL SECURITY/);
  });

  it('grants FOR ALL TO authenticated on each table', () => {
    expect(migSrc).toMatch(
      /CREATE POLICY equipment_service_materials_auth_all ON public\.equipment_service_materials\s+FOR ALL TO authenticated USING \(true\) WITH CHECK \(true\)/,
    );
    expect(migSrc).toMatch(
      /CREATE POLICY equipment_material_clears_auth_all ON public\.equipment_material_clears\s+FOR ALL TO authenticated USING \(true\) WITH CHECK \(true\)/,
    );
  });

  it('NO anon policies on either materials table', () => {
    expect(migSrc).not.toMatch(/CREATE POLICY[\s\S]*?ON public\.equipment_service_materials[\s\S]*?TO anon/);
    expect(migSrc).not.toMatch(/CREATE POLICY[\s\S]*?ON public\.equipment_material_clears[\s\S]*?TO anon/);
  });
});

describe('Mig 048 — approved seed locks', () => {
  it('5065 50h interval has Grease', () => {
    expect(migSrc).toMatch(/'5065',\s*'service_interval',\s*NULL,\s*50::numeric,\s*'hours',[^,]*,\s*'Grease'/);
  });

  it('5065 50h interval has Loctite 567', () => {
    expect(migSrc).toMatch(/'5065',\s*'service_interval',\s*NULL,\s*50::numeric,\s*'hours',[^,]*,\s*'Loctite 567'/);
  });

  it("5065 50h interval does NOT seed any 'air cleaner' or 'air filter' material (knock-out cleaning lines excluded)", () => {
    // Walk every 5065 50h-interval seed row and assert the material name
    // doesn't match air cleaner / air filter.
    const lines = migSrc.split(/\r?\n/).filter((l) => /'5065',\s*'service_interval',\s*NULL,\s*50::numeric/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toMatch(/air cleaner/i);
      expect(l).not.toMatch(/air filter/i);
    }
  });

  it('Ventrac AERO-Vator Every Use has Blaster Multi-Max spray (interval_unit=use, value=NULL)', () => {
    expect(migSrc).toMatch(
      /'ventrac',\s*'attachment_checklist',\s*'AERO-Vator',\s*NULL,\s*'use',[^,]*,\s*'Blaster Multi-Max spray'/,
    );
  });

  it('Hijet 2018 has 5000km Engine oil + 60000km Timing belt', () => {
    expect(migSrc).toMatch(/'hijet-2018',\s*'service_interval',\s*NULL,\s*5000::numeric,\s*'km',[^,]*,\s*'Engine oil'/);
    expect(migSrc).toMatch(
      /'hijet-2018',\s*'service_interval',\s*NULL,\s*60000::numeric,\s*'km',[^,]*,\s*'Timing belt'/,
    );
  });

  it('Toro 100h has Engine oil (post-curation: First-75 maps to interval_value=500 separately)', () => {
    expect(migSrc).toMatch(/'toro',\s*'service_interval',\s*NULL,\s*100::numeric,\s*'hours',[^,]*,\s*'Engine oil'/);
    expect(migSrc).toMatch(/'toro',\s*'service_interval',\s*NULL,\s*500::numeric,\s*'hours',[^,]*,\s*'Hydraulic oil'/);
  });

  it('seed uses ON CONFLICT DO NOTHING keyed on the structural identity (idempotent re-apply)', () => {
    expect(migSrc).toMatch(
      /ON CONFLICT \(equipment_id, source_kind, interval_unit, interval_value, attachment_name, material_name\) DO NOTHING/,
    );
  });

  it('seeds set auto_seeded=true so admin edits stay safe on re-apply', () => {
    // The seed INSERT explicitly sets auto_seeded to true (the literal
    // value in the SELECT projection). The static lock asserts the literal
    // appears in the seed block.
    const seedBlock = migSrc.match(/INSERT INTO public\.equipment_service_materials[\s\S]*?ON CONFLICT/);
    expect(seedBlock).not.toBeNull();
    expect(seedBlock[0]).toMatch(/true\s*--\s*auto_seeded|true\s*\)?\s*$/m);
  });
});

describe('equipmentMaterials.js — rolling-checklist helper', () => {
  it('exports HOURS_WINDOW=100 and KM_WINDOW=5000', () => {
    expect(HOURS_WINDOW).toBe(100);
    expect(KM_WINDOW).toBe(5000);
  });

  it('exports buildMaterialChecklist', () => {
    expect(typeof buildMaterialChecklist).toBe('function');
  });

  it('uses computeIntervalStatus from equipment.js (Codex amendment 4 — do not duplicate interval math)', () => {
    expect(helperSrc).toMatch(/import\s*\{[^}]*\bcomputeIntervalStatus\b[^}]*\}\s*from\s*'\.\/equipment\.js'/);
  });

  it('uses latestSaneReading defensively', () => {
    expect(helperSrc).toMatch(/latestSaneReading\(eq, fuelings\)/);
  });
});

describe('equipmentMaterials.js — never-completed vs previously-completed bucket math', () => {
  // Codex amendment 4: assert both branches.
  const hoursEq = (current_hours) => ({
    id: 'eq-test',
    slug: 'test',
    name: 'Test',
    status: 'active',
    tracking_unit: 'hours',
    current_hours,
    current_km: null,
    service_intervals: [{kind: 'hours', hours_or_km: 50, label: 'Every 50h'}],
    attachment_checklists: [],
  });
  const material = (id, overrides = {}) => ({
    id,
    equipment_id: 'eq-test',
    source_kind: 'service_interval',
    service_label: 'Every 50h',
    attachment_name: null,
    interval_value: 50,
    interval_unit: 'hours',
    material_name: 'Grease',
    active: true,
    sort_order: 10,
    ...overrides,
  });

  it('never-completed at current=80, 50h interval → bucket=50, overdue=true, in-window', () => {
    const result = buildMaterialChecklist({
      equipment: [hoursEq(80)],
      fuelingsBy: new Map([['eq-test', []]]),
      materials: [material('m1')],
      clears: [],
    });
    expect(result).toHaveLength(1);
    const g = result[0].groups[0];
    expect(g.status.next_due).toBe(50);
    expect(g.status.overdue).toBe(true);
    expect(g.due_bucket_value).toBe(50);
    expect(g.due_bucket_unit).toBe('hours');
  });

  it('previously-completed at 80 (snaps to milestone 100), current=80 → next_due=150, in-window since until_due=70', () => {
    const fuelingsBy = new Map([
      [
        'eq-test',
        [
          {
            id: 'f1',
            equipment_id: 'eq-test',
            date: '2026-04-01',
            hours_reading: 80,
            km_reading: null,
            service_intervals_completed: [
              {
                interval: 50,
                kind: 'hours',
                label: 'Every 50h',
                completed_at: '2026-04-01',
                items_completed: [],
                total_tasks: 0,
              },
            ],
          },
        ],
      ],
    ]);
    const result = buildMaterialChecklist({
      equipment: [hoursEq(80)],
      fuelingsBy,
      materials: [material('m1')],
      clears: [],
    });
    expect(result).toHaveLength(1);
    const g = result[0].groups[0];
    expect(g.status.next_due).toBe(150);
    expect(g.status.overdue).toBe(false);
    expect(g.due_bucket_value).toBe(150);
  });

  it('material outside the 100h window is omitted (e.g. 1200h interval at current=200)', () => {
    const eq = {
      id: 'eq-test',
      slug: 'test',
      name: 'Test',
      status: 'active',
      tracking_unit: 'hours',
      current_hours: 200,
      current_km: null,
      service_intervals: [{kind: 'hours', hours_or_km: 1200, label: 'Every 1200h'}],
      attachment_checklists: [],
    };
    const m = material('m-far', {interval_value: 1200, material_name: 'Coolant'});
    const result = buildMaterialChecklist({
      equipment: [eq],
      fuelingsBy: new Map([['eq-test', []]]),
      materials: [m],
      clears: [],
    });
    expect(result).toHaveLength(0); // until_due=1000 > 100h window → out
  });

  it('hijet km-tracked: 5000km material at current=4500 IS in-window (until_due=500 <= 5000)', () => {
    const eq = {
      id: 'eq-hijet',
      slug: 'hijet-2020',
      name: 'Hijet 2020',
      status: 'active',
      tracking_unit: 'km',
      current_hours: null,
      current_km: 4500,
      service_intervals: [{kind: 'km', hours_or_km: 5000, label: 'Every 5000km'}],
      attachment_checklists: [],
    };
    const m = {
      id: 'mh',
      equipment_id: 'eq-hijet',
      source_kind: 'service_interval',
      service_label: 'Every 5000km',
      attachment_name: null,
      interval_value: 5000,
      interval_unit: 'km',
      material_name: 'Engine oil',
      active: true,
      sort_order: 10,
    };
    const result = buildMaterialChecklist({
      equipment: [eq],
      fuelingsBy: new Map([['eq-hijet', []]]),
      materials: [m],
      clears: [],
    });
    expect(result).toHaveLength(1);
  });
});

describe('equipmentMaterials.js — attachment completions are scoped per-attachment (Codex review)', () => {
  // Equipment with BOTH a main 50h interval AND an AERO-Vator 50h attachment.
  // A fueling with an attachment completion at hours_reading=80 must:
  //   1. roll the AERO-Vator 50h material to bucket=150 (snap to milestone 100, next_due=150);
  //   2. NOT advance the main 50h service material (still bucket=50/overdue at current=80, never-completed);
  //   3. invalidate a stale attachment clear at bucket=50 once the bucket rolls.
  const baseEq = {
    id: 'eq-attach',
    slug: 'eq-attach',
    name: 'AttachTest',
    status: 'active',
    tracking_unit: 'hours',
    current_hours: 80,
    current_km: null,
    service_intervals: [{kind: 'hours', hours_or_km: 50, label: 'Every 50h'}],
    attachment_checklists: [
      {name: 'AERO-Vator', kind: 'hours', hours_or_km: 50, label: 'AERO-Vator -- Every 50 Hours'},
    ],
  };
  const mainMat = {
    id: 'm-main-50',
    equipment_id: 'eq-attach',
    source_kind: 'service_interval',
    service_label: 'Every 50h',
    attachment_name: null,
    interval_value: 50,
    interval_unit: 'hours',
    material_name: 'Grease (main)',
    active: true,
    sort_order: 10,
  };
  const attachMat = {
    id: 'm-attach-50',
    equipment_id: 'eq-attach',
    source_kind: 'attachment_checklist',
    service_label: 'AERO-Vator 50h',
    attachment_name: 'AERO-Vator',
    interval_value: 50,
    interval_unit: 'hours',
    material_name: 'Grease (AERO-Vator)',
    active: true,
    sort_order: 10,
  };

  // A fueling at reading=80 with an attachment-tagged completion for AERO-Vator 50h.
  // computeIntervalStatus snaps 80 to milestone 100 → next_due=150 for the
  // attachment. The main 50h interval has no completion (attachment_name set
  // means main filter excludes this completion) → next_due stays at 50 / overdue.
  const fuelingsBy = new Map([
    [
      'eq-attach',
      [
        {
          id: 'f-attach',
          equipment_id: 'eq-attach',
          date: '2026-04-01',
          hours_reading: 80,
          km_reading: null,
          service_intervals_completed: [
            {
              interval: 50,
              kind: 'hours',
              label: 'AERO-Vator -- Every 50 Hours',
              attachment_name: 'AERO-Vator',
              completed_at: '2026-04-01',
              items_completed: [],
              total_tasks: 0,
            },
          ],
        },
      ],
    ],
  ]);

  it('attachment 50h completion at reading 80 advances ONLY that attachment to bucket=150', () => {
    const result = buildMaterialChecklist({
      equipment: [baseEq],
      fuelingsBy,
      materials: [attachMat],
      clears: [],
    });
    expect(result).toHaveLength(1);
    const g = result[0].groups.find((x) => x.attachment_name === 'AERO-Vator');
    expect(g, 'expected AERO-Vator group').toBeDefined();
    expect(g.status.next_due).toBe(150);
    expect(g.due_bucket_value).toBe(150);
  });

  it('attachment completion does NOT advance the main equipment 50h service bucket', () => {
    const result = buildMaterialChecklist({
      equipment: [baseEq],
      fuelingsBy,
      materials: [mainMat],
      clears: [],
    });
    // Main 50h is still overdue at current=80 (no main completion), bucket=50.
    expect(result).toHaveLength(1);
    const g = result[0].groups.find((x) => x.source_kind === 'service_interval');
    expect(g, 'expected main service group').toBeDefined();
    expect(g.status.next_due).toBe(50);
    expect(g.status.overdue).toBe(true);
    expect(g.due_bucket_value).toBe(50);
  });

  it('stale attachment clear at bucket=50 no longer hides material once bucket advances', () => {
    // Pre-existing clear keyed to attachment bucket=50 — should NOT match the
    // post-completion bucket=150.
    const staleClear = [{material_id: 'm-attach-50', due_bucket_value: 50, due_bucket_unit: 'hours'}];
    const result = buildMaterialChecklist({
      equipment: [baseEq],
      fuelingsBy,
      materials: [attachMat],
      clears: staleClear,
    });
    expect(result).toHaveLength(1);
    const names = result[0].groups[0].materials.map((m) => m.material_name);
    expect(names).toEqual(['Grease (AERO-Vator)']);
  });
});

describe('equipmentMaterials.js — clear-one behavior', () => {
  const baseEq = {
    id: 'eq-x',
    slug: 'x',
    name: 'X',
    status: 'active',
    tracking_unit: 'hours',
    current_hours: 80,
    current_km: null,
    service_intervals: [{kind: 'hours', hours_or_km: 50, label: 'Every 50h'}],
    attachment_checklists: [],
  };
  const m1 = {
    id: 'm1',
    equipment_id: 'eq-x',
    source_kind: 'service_interval',
    service_label: 'Every 50h',
    attachment_name: null,
    interval_value: 50,
    interval_unit: 'hours',
    material_name: 'Grease',
    active: true,
    sort_order: 10,
  };
  const m2 = {...m1, id: 'm2', material_name: 'Loctite 567', sort_order: 20};

  it('clearing m1 in bucket=50 hides m1 only; m2 still visible', () => {
    const clears = [{material_id: 'm1', due_bucket_value: 50, due_bucket_unit: 'hours'}];
    const result = buildMaterialChecklist({
      equipment: [baseEq],
      fuelingsBy: new Map([['eq-x', []]]),
      materials: [m1, m2],
      clears,
    });
    expect(result).toHaveLength(1);
    const names = result[0].groups[0].materials.map((m) => m.material_name);
    expect(names).toEqual(['Loctite 567']);
  });

  it('crossing the next_due milestone makes a stale clear no longer match (material reappears)', () => {
    // Bucket at current=80 (never completed) is 50 (overdue). After we
    // simulate a completion at 80 snapping to milestone 100, next_due=150.
    // A clear keyed to bucket=50 should NOT match the new bucket=150.
    const fuelingsBy = new Map([
      [
        'eq-x',
        [
          {
            id: 'f1',
            equipment_id: 'eq-x',
            date: '2026-04-01',
            hours_reading: 80,
            km_reading: null,
            service_intervals_completed: [
              {
                interval: 50,
                kind: 'hours',
                label: 'Every 50h',
                completed_at: '2026-04-01',
                items_completed: [],
                total_tasks: 0,
              },
            ],
          },
        ],
      ],
    ]);
    const staleClear = [{material_id: 'm1', due_bucket_value: 50, due_bucket_unit: 'hours'}];
    const result = buildMaterialChecklist({
      equipment: [baseEq],
      fuelingsBy,
      materials: [m1, m2],
      clears: staleClear,
    });
    expect(result).toHaveLength(1);
    const names = result[0].groups[0].materials.map((m) => m.material_name);
    // m1 reappears in the new bucket=150 because the stale clear at 50 doesn't match.
    expect(names).toEqual(expect.arrayContaining(['Grease', 'Loctite 567']));
  });

  it("'use' interval clear persists indefinitely (bucket=NULL,'use')", () => {
    const eq = {
      id: 'eq-vt',
      slug: 'ventrac',
      name: 'Ventrac',
      status: 'active',
      tracking_unit: 'hours',
      current_hours: 100,
      current_km: null,
      service_intervals: [],
      attachment_checklists: [{name: 'AERO-Vator', kind: 'hours', hours_or_km: 0, label: 'AERO-Vator -- Every Use'}],
    };
    const useMat = {
      id: 'mu',
      equipment_id: 'eq-vt',
      source_kind: 'attachment_checklist',
      service_label: 'AERO-Vator Every Use',
      attachment_name: 'AERO-Vator',
      interval_value: null,
      interval_unit: 'use',
      material_name: 'Blaster Multi-Max spray',
      active: true,
      sort_order: 10,
    };
    // Without clear → in list.
    const before = buildMaterialChecklist({
      equipment: [eq],
      fuelingsBy: new Map([['eq-vt', []]]),
      materials: [useMat],
      clears: [],
    });
    expect(before[0]?.groups[0]?.materials.map((m) => m.material_name)).toEqual(['Blaster Multi-Max spray']);
    // With NULL-bucket 'use' clear → vanishes.
    const after = buildMaterialChecklist({
      equipment: [eq],
      fuelingsBy: new Map([['eq-vt', []]]),
      materials: [useMat],
      clears: [{material_id: 'mu', due_bucket_value: null, due_bucket_unit: 'use'}],
    });
    expect(after).toHaveLength(0);
  });
});

describe('Admin editor wiring — writes to materials table, not service_intervals JSONB', () => {
  it('EquipmentMaterialsEditor inserts to equipment_service_materials', () => {
    expect(editorSrc).toMatch(/sb\.from\('equipment_service_materials'\)\.insert/);
  });

  it('EquipmentMaterialsEditor patches via update on equipment_service_materials', () => {
    expect(editorSrc).toMatch(/sb\s*\.\s*from\('equipment_service_materials'\)\s*\.update/);
  });

  it('EquipmentMaterialsEditor un-clear deletes from equipment_material_clears (only un-clear surface)', () => {
    expect(editorSrc).toMatch(/sb\.from\('equipment_material_clears'\)\.delete\(\)\.eq\('material_id'/);
  });

  it('EquipmentMaterialsEditor does NOT modify equipment.service_intervals JSONB', () => {
    expect(editorSrc).not.toMatch(/sb\.from\('equipment'\)\.update/);
  });

  it('EquipmentMaterialsEditor keeps material edit order stable without reload-on-blur', () => {
    expect(editorSrc).toMatch(/\.order\('sort_order',\s*\{ascending:\s*true\}\)/);
    const patchFn = editorSrc.match(/async\s+function\s+patchMaterial\([\s\S]*?\n\s{2}\}/);
    expect(patchFn, 'expected patchMaterial function').not.toBeNull();
    expect(patchFn[0]).toMatch(/setMaterials\(\(prev\)\s*=>\s*prev\.map/);
    expect(patchFn[0]).not.toMatch(/await reload\(\)/);
  });

  it('EquipmentWebformsAdmin applies successful text saves locally instead of modal reload', () => {
    expect(adminSrc).toMatch(/function applySavedEquipmentPatch/);
    expect(adminSrc).toMatch(/const patchEquipmentLocal = React\.useCallback/);
    expect(adminSrc).toMatch(/onLocalPatch=\{\(patch\) => patchEquipmentLocal\(selected\.id, patch\)\}/);
    expect(adminSrc).toMatch(/applySavedEquipmentPatch\(onLocalPatch, onReload/);
  });

  it('EquipmentWebformsAdmin slot includes <EquipmentMaterialsEditor>', () => {
    expect(adminSrc).toMatch(/import EquipmentMaterialsEditor from '\.\/EquipmentMaterialsEditor\.jsx'/);
    expect(adminSrc).toMatch(/<EquipmentMaterialsEditor\s+equipment=\{selected\}\s+onReload=\{loadAll\}\s*\/>/);
  });

  it('EquipmentWebformsAdmin reloads equipment in-place after the initial load', () => {
    expect(adminSrc).toMatch(/const didInitialLoadRef = React\.useRef\(false\)/);
    expect(adminSrc).toMatch(/const isInitialLoad = !didInitialLoadRef\.current/);
    expect(adminSrc).toMatch(/if \(isInitialLoad\) \{\s*setLoading\(true\);/);
    expect(adminSrc).toMatch(/didInitialLoadRef\.current = true/);
    expect(adminSrc).not.toMatch(/const loadAll = React\.useCallback\(async \(\) => \{\s*setLoading\(true\)/);
  });

  it('EquipmentWebformsAdmin preserves modal scroll during background reloads', () => {
    expect(adminSrc).toMatch(/const modalScrollRef = React\.useRef\(null\)/);
    expect(adminSrc).toMatch(/const pendingReloadScrollTopRef = React\.useRef\(null\)/);
    expect(adminSrc).toMatch(/pendingReloadScrollTopRef\.current = modalScrollRef\.current\.scrollTop/);
    expect(adminSrc).toMatch(/React\.useLayoutEffect\(\(\) => \{[\s\S]*modalScrollRef\.current\.scrollTop = top/);
    expect(adminSrc).toMatch(/ref=\{modalScrollRef\}/);
  });
});

describe('EquipmentHome — standalone /fleet/materials retired (2026-05-14)', () => {
  it('EquipmentHome no longer imports EquipmentMaterialListView', () => {
    expect(homeSrc).not.toMatch(/import\s+EquipmentMaterialListView/);
  });

  it('EquipmentHome path-routing no longer recognizes /fleet/materials as a subView', () => {
    expect(homeSrc).not.toMatch(/path === '\/fleet\/materials'/);
    expect(homeSrc).not.toMatch(/subView === 'materials'/);
  });

  it('sub-nav has no Materials button', () => {
    expect(homeSrc).not.toMatch(/navigate\('\/fleet\/materials'\)/);
    expect(homeSrc).not.toMatch(/📋 Materials/);
  });

  it('/fleet/materials is aliased to /fleet in routes.js so old bookmarks redirect cleanly', () => {
    expect(routesSrc).toMatch(/'\/fleet\/materials'\s*:\s*'\/fleet'/);
  });
});

describe('HomeDashboard Materials Needed card (lane amendment)', () => {
  it('imports buildMaterialChecklist from the helper', () => {
    expect(dashboardSrc).toMatch(
      /import\s*\{\s*buildMaterialChecklist\s*\}\s*from\s*'\.\.\/lib\/equipmentMaterials\.js'/,
    );
  });

  it('loads materials + clears from the new tables', () => {
    expect(dashboardSrc).toMatch(/sb\.from\('equipment_service_materials'\)\.select/);
    expect(dashboardSrc).toMatch(/sb\.from\('equipment_material_clears'\)\.select/);
  });

  it('inserts into equipment_material_clears with due_bucket_value + due_bucket_unit on Clear', () => {
    expect(dashboardSrc).toMatch(/sb\.from\('equipment_material_clears'\)\.insert/);
    expect(dashboardSrc).toMatch(/due_bucket_value:\s*group\.due_bucket_value/);
    expect(dashboardSrc).toMatch(/due_bucket_unit:\s*group\.due_bucket_unit/);
  });

  it('renders the card section with data-home-materials-card hook', () => {
    expect(dashboardSrc).toMatch(/data-home-materials-card="1"/);
  });

  it('renders caught-up notices when maintenance and material queues are empty', () => {
    expect(dashboardSrc).toMatch(/showEquipmentMaintenanceCaughtUp/);
    expect(dashboardSrc).toMatch(/data-home-equipment-maintenance-caught-up="1"/);
    expect(dashboardSrc).toMatch(/showEquipmentMaterialsCaughtUp/);
    expect(dashboardSrc).toMatch(/data-home-materials-caught-up="1"/);
    expect(dashboardSrc).toMatch(/activeMaterialsCount\s*>\s*0/);
    expect(dashboardSrc).toMatch(/!materialsTablesMissing/);
  });

  it('exposes a per-row Clear button hook (one-material-at-a-time)', () => {
    expect(dashboardSrc).toMatch(/data-home-material-clear=\{m\.id\}/);
  });

  it('does NOT include any "Clear All" / bulk-clear control on the home card', () => {
    // Identifier-level guard — a future bulk-clear would surface as a
    // setBulkClear / clearAll handler or a literal "Clear All" button.
    expect(dashboardSrc).not.toMatch(/clearAllMaterials|setClearAllMaterials/);
    expect(dashboardSrc).not.toMatch(/data-home-materials-clear-all/);
  });

  it('does NOT link to /fleet/materials (standalone page retired 2026-05-14)', () => {
    expect(dashboardSrc).not.toMatch(/data-home-materials-link/);
    expect(dashboardSrc).not.toMatch(/navigate\('\/fleet\/materials'\)/);
    expect(dashboardSrc).not.toMatch(/View full list/);
  });

  it('includes attachment_checklists in the equipment select so attachment-source materials resolve', () => {
    expect(dashboardSrc).toMatch(/from\('equipment'\)\s*\.select\(\s*[\s\S]{0,400}?attachment_checklists/);
  });

  it('handles equipment_material_clears load failure defensively (does not resurface cleared rows)', () => {
    // The dashboard load path must NOT fall back to setMaterialClears([])
    // on a clears RLS / transient error — that would resurface cleared
    // materials. Guard: branch on clrRes.error and refuse to render.
    expect(dashboardSrc).toMatch(/if \(clrRes\.error\)/);
  });
});

// The two describe blocks that previously locked the operator list view
// (load-failure defensive guard + cleared-rows-vanish behavior + ✓ Clear
// label + clears-table insert shape) lived in src/equipment/
// EquipmentMaterialListView.jsx. That file was deleted on 2026-05-14
// when the standalone /fleet/materials page was retired. The equivalent
// operator surface lives on the home dashboard Materials Needed card —
// its clrRes.error guard, single Clear button per material, and clears
// insert shape are all locked by the "HomeDashboard Materials Needed
// card" describe above.

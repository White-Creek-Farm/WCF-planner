import {test, expect} from './fixtures.js';

// ============================================================================
// Equipment Materials Rolling Checklist (mig 048) — focused Playwright
// ============================================================================
// Locks the operator-facing Materials Needed surface + Clear-one-material
// behavior. After the 2026-05-14 retirement of the standalone /fleet/
// materials page, the home dashboard Materials Needed card is the only
// operator surface — every assertion below visits "/" and uses the
// data-home-* hooks.
//
// Uses a fresh test-owned equipment piece + materials inserted via
// service_role between specs (resetDb cascades equipment + the new
// materials/clears tables).
// ============================================================================

const ADMIN_STORAGE = 'tests/.auth/admin.json';
test.use({storageState: ADMIN_STORAGE});

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const seedKey = (value) => `${value}-${RUN_ID}`;
const uniqueSeed = (value) => `${seedKey(value)}-${Math.random().toString(36).slice(2, 8)}`;

async function seedEquipment(supabaseAdmin, overrides = {}) {
  const id = overrides.id || uniqueSeed('eq-mat');
  const row = {
    id,
    name: overrides.name || 'Mat Test Tractor',
    slug: overrides.slug || uniqueSeed('mat'),
    category: 'tractors',
    status: 'active',
    tracking_unit: 'hours',
    current_hours: 80,
    current_km: null,
    fuel_type: 'diesel',
    every_fillup_items: [],
    service_intervals: [{kind: 'hours', hours_or_km: 50, label: 'Every 50h'}],
    attachment_checklists: [],
    manuals: [],
    documents: [],
    team_members: [],
    ...overrides,
  };
  const {error} = await supabaseAdmin.from('equipment').upsert(row, {onConflict: 'id'});
  if (error) throw new Error(`seedEquipment: ${error.message}`);
  return row;
}

async function seedMaterial(supabaseAdmin, equipment_id, overrides = {}) {
  const id = overrides.id || uniqueSeed('esm-mat');
  const row = {
    id,
    equipment_id,
    source_kind: 'service_interval',
    service_label: 'Every 50h',
    attachment_name: null,
    interval_value: 50,
    interval_unit: 'hours',
    material_name: 'Grease',
    qty: null,
    unit: null,
    notes: null,
    active: true,
    sort_order: 10,
    auto_seeded: false,
    ...overrides,
  };
  const {error} = await supabaseAdmin.from('equipment_service_materials').upsert(row, {onConflict: 'id'});
  if (error) throw new Error(`seedMaterial: ${error.message}`);
  return row;
}

async function waitForHomeBoot(page) {
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
}

async function waitForMaterialsCard(page) {
  const card = page.locator('[data-home-materials-card="1"]');
  try {
    await expect(card).toBeVisible({timeout: 10_000});
  } catch (_error) {
    await page.reload();
    await waitForHomeBoot(page);
    await expect(card).toBeVisible({timeout: 10_000});
  }
  return card;
}

async function gotoHomeWithMaterialsCard(page) {
  await page.goto('/');
  await waitForHomeBoot(page);
  return waitForMaterialsCard(page);
}

// Test 1 — overdue equipment with parts shows up on home card; Clear hides one row only.
test('home card: overdue piece appears; Clear hides only that material', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedEquipment(supabaseAdmin, {slug: seedKey('mat-overdue'), name: 'MatOverdue', current_hours: 80});
  // Two materials at the 50h interval — both should land on the rolling list
  // because current=80 > next_due=50 (overdue, never completed).
  const m1 = await seedMaterial(supabaseAdmin, eq.id, {
    id: seedKey('esm-grease'),
    material_name: 'Grease',
    sort_order: 10,
  });
  const m2 = await seedMaterial(supabaseAdmin, eq.id, {
    id: seedKey('esm-loctite'),
    material_name: 'Loctite 567',
    sort_order: 20,
  });

  await gotoHomeWithMaterialsCard(page);

  // Both materials visible on the home card.
  await expect(page.locator(`[data-home-material-row="${m1.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-home-material-row="${m2.id}"]`)).toBeVisible();
  // Group is OVERDUE — scope to this equipment's block since the seeded
  // fleet may have other overdue groups visible at the same time.
  await expect(page.locator(`[data-home-material-equipment="${eq.slug}"]`).getByText('OVERDUE').first()).toBeVisible();

  // Clear m1 only.
  await page.locator(`[data-home-material-clear="${m1.id}"]`).click();

  // m1 vanishes; m2 stays.
  await expect(page.locator(`[data-home-material-row="${m1.id}"]`)).toHaveCount(0, {timeout: 5_000});
  await expect(page.locator(`[data-home-material-row="${m2.id}"]`)).toBeVisible();

  // DB clear row landed in the right bucket.
  const {data: clears} = await supabaseAdmin.from('equipment_material_clears').select('*').eq('material_id', m1.id);
  expect(clears).toHaveLength(1);
  expect(Number(clears[0].due_bucket_value)).toBe(50);
  expect(clears[0].due_bucket_unit).toBe('hours');
});

// Test 2 — equipment outside the 100h window is NOT on the home card.
test('home card: material due outside the 100h window does not appear', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedEquipment(supabaseAdmin, {
    slug: seedKey('mat-far'),
    name: 'MatFar',
    current_hours: 200, // far below the 1200h next_due
    service_intervals: [{kind: 'hours', hours_or_km: 1200, label: 'Every 1200h'}],
  });
  await seedMaterial(supabaseAdmin, eq.id, {
    interval_value: 1200,
    service_label: 'Every 1200h',
    material_name: 'Coolant',
  });

  await page.goto('/');
  await waitForHomeBoot(page);
  // The MatFar equipment block must not render — its materials are out of window.
  await expect(page.locator(`[data-home-material-equipment="${eq.slug}"]`)).toHaveCount(0);
  await expect(page.locator('[data-home-materials-caught-up="1"]')).toBeVisible();
});

// Test 3 — hijet km-tracked piece with material due within 5000km appears.
test('home card: hijet within 5000km window appears', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedEquipment(supabaseAdmin, {
    slug: seedKey('mat-hijet'),
    name: 'MatHijet',
    category: 'hijets',
    tracking_unit: 'km',
    current_hours: null,
    current_km: 4500,
    service_intervals: [{kind: 'km', hours_or_km: 5000, label: 'Every 5000km'}],
  });
  const m = await seedMaterial(supabaseAdmin, eq.id, {
    id: seedKey('esm-hijet-oil'),
    interval_value: 5000,
    interval_unit: 'km',
    service_label: 'Every 5000km',
    material_name: 'Engine oil',
  });

  await gotoHomeWithMaterialsCard(page);
  await expect(page.locator(`[data-home-material-equipment="${eq.slug}"]`)).toBeVisible();
  await expect(page.locator(`[data-home-material-row="${m.id}"]`)).toBeVisible();
});

// Test 4 — HomeDashboard Materials card surfaces a due material + Clear hides
// only that row + clear persists on refresh. (Previously this test also
// followed a "View full list" link into /fleet/materials; that link was
// removed when the standalone page was retired 2026-05-14.)
test('home card: shows due materials, clears one without affecting siblings, persists on refresh', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEquipment(supabaseAdmin, {slug: seedKey('mat-home'), name: 'MatHome', current_hours: 80});
  const m1 = await seedMaterial(supabaseAdmin, eq.id, {id: seedKey('esm-home-grease'), material_name: 'Grease'});
  const m2 = await seedMaterial(supabaseAdmin, eq.id, {
    id: seedKey('esm-home-loctite'),
    material_name: 'Loctite 567',
    sort_order: 20,
  });

  await gotoHomeWithMaterialsCard(page);

  // Both materials visible on the home card.
  await expect(page.locator(`[data-home-material-row="${m1.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-home-material-row="${m2.id}"]`)).toBeVisible();

  // Clear m1 only.
  await page.locator(`[data-home-material-clear="${m1.id}"]`).click();
  await expect(page.locator(`[data-home-material-row="${m1.id}"]`)).toHaveCount(0, {timeout: 5_000});
  await expect(page.locator(`[data-home-material-row="${m2.id}"]`)).toBeVisible();

  // Persists on refresh.
  await page.reload();
  await waitForHomeBoot(page);
  await waitForMaterialsCard(page);
  await expect(page.locator(`[data-home-material-row="${m1.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-home-material-row="${m2.id}"]`)).toBeVisible();
});

// Test 5 — crossing the next_due milestone makes a stale clear no longer
// match (cleared material reappears in the new bucket on the home card).
test('home card: clear expires when next_due milestone advances', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedEquipment(supabaseAdmin, {
    slug: seedKey('mat-cross'),
    name: 'MatCross',
    current_hours: 80, // never-completed at 80, 50h interval → next_due=50, overdue
  });
  const m = await seedMaterial(supabaseAdmin, eq.id, {id: seedKey('esm-cross-grease')});

  // Pre-insert a clear in bucket=50 (overdue, never-completed).
  await supabaseAdmin.from('equipment_material_clears').upsert(
    {
      id: seedKey('emc-pre'),
      material_id: m.id,
      equipment_id: eq.id,
      due_bucket_value: 50,
      due_bucket_unit: 'hours',
    },
    {onConflict: 'id'},
  );

  // First load — material is hidden by the clear.
  await page.goto('/');
  await waitForHomeBoot(page);
  await expect(page.locator(`[data-home-material-row="${m.id}"]`)).toHaveCount(0);

  // Now record a completion at hours_reading=80 — service_intervals_completed
  // for the 50h interval. computeIntervalStatus snaps 80 to milestone 100;
  // next_due jumps to 150. The pre-existing clear at bucket=50 no longer
  // matches.
  await supabaseAdmin.from('equipment_fuelings').upsert(
    {
      id: seedKey('ef-cross'),
      equipment_id: eq.id,
      date: '2026-04-01',
      team_member: 'BMAN',
      fuel_type: 'diesel',
      gallons: 5,
      hours_reading: 80,
      km_reading: null,
      every_fillup_check: [],
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
      photos: [],
      source: 'fuel_log_webform',
    },
    {onConflict: 'id'},
  );

  // Reload — bucket has shifted; material reappears.
  await page.reload();
  await waitForHomeBoot(page);
  await waitForMaterialsCard(page);
  await expect(page.locator(`[data-home-material-row="${m.id}"]`)).toBeVisible({timeout: 10_000});
});

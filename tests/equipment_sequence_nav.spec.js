import {test, expect} from './fixtures.js';

// CP4 — record-page sequence navigation for equipment.item (/fleet/<slug>).
// Equipment is the novel case: slug-keyed routes, prop-driven EquipmentDetail,
// nav owned by EquipmentHome. Slug == id here for a clean URL assertion.

async function seedEquipment(supabaseAdmin, {id, name}) {
  // slug == id (deterministic + UNIQUE) so upsert-on-id fully protects against
  // a stale worker row; reset the attention-trigger columns to a neutral shape.
  const {error} = await supabaseAdmin.from('equipment').upsert(
    {
      id,
      slug: id,
      name,
      category: 'tractors',
      tracking_unit: 'hours',
      status: 'active',
      current_hours: null,
      current_km: null,
      warranty_expiration: null,
      service_intervals: [],
      attachment_checklists: [],
      every_fillup_items: [],
      notes: null,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error('seedEquipment(' + id + '): ' + error.message);
}

test.describe('Equipment record-page sequence navigation', () => {
  test('fleet tile opens with Prev/Next; Next advances to the labeled neighbor', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    // Sorted by name within the category → visible order Aaa, Bbb, Ccc.
    await seedEquipment(supabaseAdmin, {id: 'eq-a', name: 'Aaa Tractor'});
    await seedEquipment(supabaseAdmin, {id: 'eq-b', name: 'Bbb Tractor'});
    await seedEquipment(supabaseAdmin, {id: 'eq-c', name: 'Ccc Tractor'});

    await page.goto('/fleet');
    await expect(page.locator('[data-equipment-tile]').first()).toBeVisible({timeout: 15_000});
    await page.locator('[data-equipment-tile]').first().click();

    await expect(page).toHaveURL(/\/fleet\/eq-a$/, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toBeVisible();
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

    const nextBtn = page.locator('[data-record-seq-next="1"]');
    const nextLabel = (await nextBtn.innerText()).replace(/[‹›]/g, '').trim();
    expect(nextLabel).toBe('Bbb Tractor');

    await nextBtn.click();
    await expect(page).toHaveURL(/\/fleet\/eq-b$/, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
  });

  test('direct URL open hides the sequence controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedEquipment(supabaseAdmin, {id: 'eq-a', name: 'Aaa Tractor'});
    await seedEquipment(supabaseAdmin, {id: 'eq-b', name: 'Bbb Tractor'});

    await page.goto('/fleet/eq-a');
    // Detail header shows the equipment name; no sequence controls without state.
    await expect(page.getByText('Aaa Tractor').first()).toBeVisible({timeout: 15_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });
});

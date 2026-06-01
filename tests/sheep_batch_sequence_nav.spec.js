import {test, expect} from './fixtures.js';

// CP4 — record-page sequence navigation for sheep.processing (/sheep/batches/<id>).

async function seedBatch(supabaseAdmin, {id, name, status = 'planned'}) {
  const {error} = await supabaseAdmin.from('sheep_processing_batches').upsert(
    {
      id,
      name,
      status,
      sheep_detail: [],
      // Resets so a stale worker row can't keep prior dates/weights/notes.
      documents: [],
      planned_process_date: null,
      actual_process_date: null,
      total_live_weight: null,
      total_hanging_weight: null,
      processing_cost: null,
      notes: null,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error('seedBatch(' + id + '): ' + error.message);
}

test.describe('Sheep processing-batch record-page sequence navigation', () => {
  test('list tile opens with Prev/Next; Next advances to the labeled neighbor', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedBatch(supabaseAdmin, {id: 'sb-1', name: 'SB-One'});
    await seedBatch(supabaseAdmin, {id: 'sb-2', name: 'SB-Two'});
    await seedBatch(supabaseAdmin, {id: 'sb-3', name: 'SB-Three'});

    await page.goto('/sheep/batches');
    await expect(page.locator('[data-batch-row]').first()).toBeVisible({timeout: 15_000});
    await page.locator('[data-batch-row]').first().click();

    await expect(page).toHaveURL(/\/sheep\/batches\/sb-/, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toBeVisible();
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

    const nextBtn = page.locator('[data-record-seq-next="1"]');
    const nextLabel = (await nextBtn.innerText()).replace(/[‹›]/g, '').trim();
    expect(nextLabel).toMatch(/^SB-/);

    await nextBtn.click();
    await expect(page.locator('[data-record-title="1"]')).toHaveText(nextLabel, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
  });

  test('direct URL open hides the sequence controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedBatch(supabaseAdmin, {id: 'sb-1', name: 'SB-One'});
    await seedBatch(supabaseAdmin, {id: 'sb-2', name: 'SB-Two'});

    await page.goto('/sheep/batches/sb-1');
    await expect(page.locator('[data-record-title="1"]')).toHaveText('SB-One', {timeout: 15_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });
});

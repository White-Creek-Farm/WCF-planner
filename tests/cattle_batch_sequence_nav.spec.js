import {test, expect} from './fixtures.js';

// CP3 record-page sequence navigation — cattle.processing (representative batch
// family). cattle_processing_batches list tile → /cattle/batches/<id>.

async function seedBatch(supabaseAdmin, {id, name, status = 'active'}) {
  const {error} = await supabaseAdmin
    .from('cattle_processing_batches')
    .insert({id, name, status, cows_detail: [], documents: []});
  if (error) throw new Error('seedBatch(' + id + '): ' + error.message);
}

test.describe('Cattle processing-batch record-page sequence navigation', () => {
  test('list tile opens with Prev/Next; Next advances to the labeled neighbor', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedBatch(supabaseAdmin, {id: 'cb-1', name: 'CB-One'});
    await seedBatch(supabaseAdmin, {id: 'cb-2', name: 'CB-Two'});
    await seedBatch(supabaseAdmin, {id: 'cb-3', name: 'CB-Three'});

    await page.goto('/cattle/batches');
    await expect(page.locator('[data-batch-row]').first()).toBeVisible({timeout: 15_000});

    await page.locator('[data-batch-row]').first().click();

    await expect(page).toHaveURL(/\/cattle\/batches\/cb-/, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toBeVisible();
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

    const nextBtn = page.locator('[data-record-seq-next="1"]');
    const nextLabel = (await nextBtn.innerText()).replace(/[‹›]/g, '').trim();
    expect(nextLabel).toMatch(/^CB-/);

    await nextBtn.click();
    await expect(page.locator('[data-record-title="1"]')).toHaveText(nextLabel, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
  });

  test('direct URL open hides the sequence controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedBatch(supabaseAdmin, {id: 'cb-1', name: 'CB-One'});
    await seedBatch(supabaseAdmin, {id: 'cb-2', name: 'CB-Two'});

    await page.goto('/cattle/batches/cb-1');
    await expect(page.locator('[data-record-title="1"]')).toHaveText('CB-One', {timeout: 15_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });

  test('collapsed processed batches are excluded — single active batch hides controls', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedBatch(supabaseAdmin, {id: 'cb-active', name: 'CB-Active'});
    await seedBatch(supabaseAdmin, {id: 'cb-done', name: 'CB-Done', status: 'complete'});

    await page.goto('/cattle/batches');
    await expect(page.locator('[data-batch-row="cb-active"]')).toBeVisible({timeout: 15_000});
    // Show Processed Batches stays collapsed, so the processed batch is not in
    // the visible sequence — clicking the lone active batch shows no controls.
    await page.locator('[data-batch-row="cb-active"]').click();

    await expect(page).toHaveURL(/\/cattle\/batches\/cb-active/, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });
});

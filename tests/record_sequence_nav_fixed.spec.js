import {test, expect} from './fixtures.js';

// Fixed record-sequence navigation — proves the shared RecordSequenceNav side
// controls stay reachable while scrolled down, on a normal record page
// (cattle processing batch) and on broiler batch (newly adopted into the
// shared contract; its former custom BatchForm side-nav was retired).

async function seedCattleBatch(supabaseAdmin, {id, name, status = 'active'}) {
  const {error} = await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id,
      name,
      status,
      cows_detail: [],
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
  if (error) throw new Error('seedCattleBatch(' + id + '): ' + error.message);
}

test('cattle batch: fixed prev/next navigate while scrolled to the bottom', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedCattleBatch(supabaseAdmin, {id: 'fb-1', name: 'FB-One'});
  await seedCattleBatch(supabaseAdmin, {id: 'fb-2', name: 'FB-Two'});
  await seedCattleBatch(supabaseAdmin, {id: 'fb-3', name: 'FB-Three'});

  await page.goto('/cattle/batches');
  await expect(page.locator('[data-batch-row]').first()).toBeVisible({timeout: 15_000});
  await page.locator('[data-batch-row]').first().click();

  await expect(page).toHaveURL(/\/cattle\/batches\/fb-/, {timeout: 10_000});
  const nav = page.locator('[data-record-seq-nav="1"]');
  await expect(nav).toBeVisible();
  await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
  await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

  // Scroll to the bottom — the fixed controls must remain in the viewport.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const nextBtn = page.locator('[data-record-seq-next="1"]');
  await expect(nextBtn).toBeInViewport();

  const nextLabel = (await nextBtn.innerText()).replace(/[‹›]/g, '').trim();
  await nextBtn.click();
  await expect(page.locator('[data-record-title="1"]')).toHaveText(nextLabel, {timeout: 10_000});
  await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
  await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
});

async function seedBroilerBatches(supabaseAdmin, batches) {
  const {error} = await supabaseAdmin.from('app_store').upsert({key: 'ppp-v4', data: batches}, {onConflict: 'key'});
  if (error) throw new Error('seedBroilerBatches: ' + error.message);
}

test('broiler batch: shared fixed prev/next navigate while scrolled', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedBroilerBatches(supabaseAdmin, [
    {
      id: 'fbb-1',
      name: 'FBB-01',
      breed: 'CC',
      hatchery: 'Meyer Hatchery',
      status: 'active',
      hatchDate: '2026-01-01',
      birdCount: 700,
      notes: '',
    },
    {
      id: 'fbb-2',
      name: 'FBB-02',
      breed: 'CC',
      hatchery: 'Meyer Hatchery',
      status: 'active',
      hatchDate: '2026-01-02',
      birdCount: 700,
      notes: '',
    },
    {
      id: 'fbb-3',
      name: 'FBB-03',
      breed: 'CC',
      hatchery: 'Meyer Hatchery',
      status: 'active',
      hatchDate: '2026-01-03',
      birdCount: 700,
      notes: '',
    },
  ]);

  await page.goto('/broiler/batches');
  await expect(page.locator('[data-broiler-batches-loaded="true"]')).toBeVisible({timeout: 15_000});

  // Click the first active row to open it WITH the visible-order sequence.
  await page.locator('tr', {hasText: 'FBB-01'}).first().click();
  await expect(page).toHaveURL(/\/broiler\/batches\/FBB-01/, {timeout: 10_000});

  const nav = page.locator('[data-record-seq-nav="1"]');
  await expect(nav).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
  await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

  // Scroll down (the embedded BatchForm is tall) — fixed Next stays reachable.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const nextBtn = page.locator('[data-record-seq-next="1"]');
  await expect(nextBtn).toBeInViewport();
  await nextBtn.click();

  await expect(page).toHaveURL(/\/broiler\/batches\/FBB-02/, {timeout: 10_000});
  await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
  await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
});

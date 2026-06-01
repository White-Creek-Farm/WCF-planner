import {test, expect} from './fixtures.js';

// ============================================================================
// Record-page sequence navigation (CP2) — representative daily path
// (cattle.daily). Mirrors the cattle.animal CP1 spec.
//
// Proves: list row opens with Prev/Next + neighbor label/position, Prev
// disabled at the first record, Next advances to the labeled neighbor; and a
// direct URL open (no route state) hides the controls.
// ============================================================================

async function seedDaily(supabaseAdmin, {id, date, herd = 'finishers'}) {
  const r = await supabaseAdmin
    .from('cattle_dailys')
    .upsert(
      {id, date, herd, deleted_at: null, deleted_by: null, client_submission_id: null, photos: []},
      {onConflict: 'id'},
    );
  if (r.error) throw new Error('seedDaily(' + id + '): ' + r.error.message);
}

test.describe('Cattle daily record-page sequence navigation', () => {
  test('list row opens with Prev/Next; Next advances to the labeled neighbor', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    // Newest first by date → visible order cd-1, cd-2, cd-3.
    await seedDaily(supabaseAdmin, {id: 'cd-1', date: '2026-05-03'});
    await seedDaily(supabaseAdmin, {id: 'cd-2', date: '2026-05-02'});
    await seedDaily(supabaseAdmin, {id: 'cd-3', date: '2026-05-01'});

    await page.goto('/cattle/dailys');
    await expect(page.locator('[data-daily-row="cd-1"]')).toBeVisible({timeout: 15_000});
    await page.locator('[data-daily-row="cd-1"]').click();

    // Title is date + " · herd"; we open at position 1 so Prev is disabled.
    await expect(page.locator('[data-record-title="1"]')).toHaveText('2026-05-03 · finishers', {timeout: 10_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toBeVisible();
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

    const nextBtn = page.locator('[data-record-seq-next="1"]');
    const nextLabel = (await nextBtn.innerText()).replace(/[‹›]/g, '').trim();
    expect(nextLabel).toBe('2026-05-02 · finishers');

    await nextBtn.click();
    await expect(page).toHaveURL(/\/cattle\/dailys\/cd-2$/, {timeout: 10_000});
    await expect(page.locator('[data-record-title="1"]')).toHaveText('2026-05-02 · finishers');
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
  });

  test('direct URL open hides the sequence controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedDaily(supabaseAdmin, {id: 'cd-1', date: '2026-05-03'});
    await seedDaily(supabaseAdmin, {id: 'cd-2', date: '2026-05-02'});

    await page.goto('/cattle/dailys/cd-1');
    await expect(page.locator('[data-record-title="1"]')).toHaveText('2026-05-03 · finishers', {timeout: 15_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });
});

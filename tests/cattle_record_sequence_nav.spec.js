import {test, expect} from './fixtures.js';

// ============================================================================
// Record-page sequence navigation (CP1) — cattle.animal.
//
// Proves:
//   1. Opening a cow record from the herds list shows Previous/Next controls
//      with neighbor labels + position, Prev disabled at the first record,
//      and Next advances to the labeled neighbor (carrying the sequence).
//   2. Opening a cow record by DIRECT URL (no originating list order in route
//      state) hides the sequence controls.
// ============================================================================

async function seedCow(supabaseAdmin, {id, tag, herd = 'mommas', sex = 'cow'}) {
  // upsert(onConflict:'id') + explicit resets so a worker-restart stale row is
  // overwritten into the exact intended (active, unattached) shape.
  const {error} = await supabaseAdmin
    .from('cattle')
    .upsert(
      {id, tag, sex, herd, old_tags: [], deleted_at: null, deleted_by: null, processing_batch_id: null},
      {onConflict: 'id'},
    );
  if (error) throw new Error(`seedCow(${id}): ${error.message}`);
}

async function waitForCattleLoaded(page) {
  await expect(page.locator('[data-cattle-match-count]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-cattle-match-count]')).not.toHaveText(/^0 /, {timeout: 15_000});
}

// Herd tiles on /cattle/herds default to collapsed and cow rows mount only
// when a tile is expanded (fdfd1dc). Wait for the grouped view, then click
// each collapsed toggle until every herd table is open.
async function expandAllHerds(page) {
  await expect(page.locator('[data-cattle-grouped-herds="1"]')).toBeVisible({timeout: 15_000});
  const collapsed = page.locator('[data-cattle-herd-toggle][data-cattle-herd-collapsed="1"]');
  for (let n = await collapsed.count(); n > 0; n = await collapsed.count()) {
    await collapsed.first().click();
  }
}

test.describe('Cattle record-page sequence navigation', () => {
  test('list row opens with Prev/Next controls; Next advances to the labeled neighbor', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedCow(supabaseAdmin, {id: 'seq-a', tag: 'SEQ-A'});
    await seedCow(supabaseAdmin, {id: 'seq-b', tag: 'SEQ-B'});
    await seedCow(supabaseAdmin, {id: 'seq-c', tag: 'SEQ-C'});

    await page.goto('/cattle/herds');
    await waitForCattleLoaded(page);
    await expandAllHerds(page);

    // Click the SEQ-A row (sorts first by tag, so it opens at position 1).
    await expect(page.locator('[data-cow-row-tag="SEQ-A"]')).toBeVisible();
    await page.locator('[data-cow-row-tag="SEQ-A"]').click();

    await expect(page.locator('[data-cattle-animal-page="1"]')).toBeVisible({timeout: 15_000});

    // Sequence controls render; we are at position 1 of 3 so Prev is disabled.
    const nav = page.locator('[data-record-seq-nav="1"]');
    await expect(nav).toBeVisible();
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

    const nextBtn = page.locator('[data-record-seq-next="1"]');
    await expect(nextBtn).toBeEnabled();
    // The Next label is the neighbor's tag (e.g. "#SEQ-B").
    const nextAria = await nextBtn.getAttribute('aria-label');
    expect(nextAria).toMatch(/^Next record: /);
    const nextLabel = nextAria.replace(/^Next record: /, '');
    expect(nextLabel).toMatch(/^#SEQ-[ABC]$/);

    await nextBtn.click();

    // Title now matches the neighbor we were promised, and position advanced.
    await expect(page.locator('[data-record-title="1"]')).toHaveText(nextLabel, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
  });

  test('direct URL open hides the sequence controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedCow(supabaseAdmin, {id: 'seq-a', tag: 'SEQ-A'});
    await seedCow(supabaseAdmin, {id: 'seq-b', tag: 'SEQ-B'});

    // No originating list order in route state → no sequence controls.
    await page.goto('/cattle/herds/seq-a');
    await expect(page.locator('[data-cattle-animal-page="1"]')).toBeVisible({timeout: 15_000});
    await expect(page.locator('[data-record-title="1"]')).toHaveText('#SEQ-A');
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });
});

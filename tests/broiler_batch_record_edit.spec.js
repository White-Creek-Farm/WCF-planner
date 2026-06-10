import {test, expect} from './fixtures.js';

// ============================================================================
// Broiler record-page edit regression — /broiler/batches/<encoded name>.
// Guards against the "text fields don't accept entries / dropdown changes
// don't stick" hotfix: typed values and select changes must hold immediately,
// and the debounced autosave must persist them into app_store ppp-v4.
// ============================================================================

const BATCH_NAME = 'B-26-77';
const NOTES_PLACEHOLDER = 'Farm team, transporter, distribution notes…';

async function seedBatch(supabaseAdmin) {
  const batch = {
    // Real broiler batches carry an id (submit stamps `editId || String(Date.now())`);
    // include one so the editId-gated autosave path is exercised realistically.
    id: 'b-26-77-test',
    name: BATCH_NAME,
    schooner: '2&3',
    breed: 'CC',
    hatchery: 'Meyer Hatchery',
    status: 'active',
    hatchDate: '2026-01-01',
    birdCount: 750,
    week4Lbs: 1.5,
    week6Lbs: 4.25,
    notes: '',
  };
  const {error} = await supabaseAdmin.from('app_store').upsert({key: 'ppp-v4', data: [batch]}, {onConflict: 'key'});
  if (error) throw new Error(`seed ppp-v4: ${error.message}`);
}

async function readBatch(supabaseAdmin) {
  const {data} = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-v4').maybeSingle();
  return (data?.data || []).find((b) => b.name === BATCH_NAME) || null;
}

test('broiler record page: text + select edits stick and autosave persists', async ({supabaseAdmin, resetDb, page}) => {
  await resetDb();
  await seedBatch(supabaseAdmin);

  await page.goto('/broiler/batches/' + encodeURIComponent(BATCH_NAME));
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('[data-record-title]').first()).toHaveText(BATCH_NAME, {timeout: 15_000});
  await expect(page.locator('[data-broiler-week4-weight-readonly="1"]')).toHaveText('1.5 lbs');
  await expect(page.locator('[data-broiler-week6-weight-readonly="1"]')).toHaveText('4.25 lbs');

  // ── Text field: typed value must remain (not be replayed/reset) ──
  const notes = page.getByPlaceholder(NOTES_PLACEHOLDER);
  await expect(notes).toBeVisible({timeout: 15_000});
  await notes.fill('transporter Joe, dist Tuesday');
  await expect(notes).toHaveValue('transporter Joe, dist Tuesday');

  // ── Select: a changed value must stick immediately. Status is a derived
  // field (calcPoultryStatus recomputes it from dates on save), so this
  // asserts immediate UI stickiness only. ──
  const statusSelect = page
    .locator('select')
    .filter({has: page.locator('option[value="planned"]')})
    .first();
  await statusSelect.selectOption('planned');
  await expect(statusSelect).toHaveValue('planned');

  // ── Select that PERSISTS as-typed: Hatchery is a stored (non-computed)
  // field. Change Meyer Hatchery → Welp Hatchery and assert it sticks. ──
  const hatcherySelect = page
    .locator('select')
    .filter({has: page.locator('option[value="Meyer Hatchery"]')})
    .first();
  await hatcherySelect.selectOption('Welp Hatchery');
  await expect(hatcherySelect).toHaveValue('Welp Hatchery');

  // ── Autosave (debounce 1.5s) must persist the text + stored-select edits. ──
  await expect
    .poll(async () => (await readBatch(supabaseAdmin))?.notes, {timeout: 10_000})
    .toBe('transporter Joe, dist Tuesday');
  await expect.poll(async () => (await readBatch(supabaseAdmin))?.hatchery, {timeout: 10_000}).toBe('Welp Hatchery');
});

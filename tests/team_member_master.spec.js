import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Team Member Master List Cleanup spec — 2026-04-29 (revised)
// ============================================================================
// Locks the post-cleanup + post-availability-filter contract:
//   - webform_config.team_roster is the canonical shape; new entries are
//     {id, name} only. Legacy {id, name, active: false} entries are
//     passively dropped by normalizeRoster on read.
//   - webform_config.team_members is the all-names mirror (no active filter).
//   - Sheep weigh-in admin selector populates from the master roster.
//   - Fuel Supply public dropdown reads master roster narrowed by the new
//     team_availability filter (see team_availability.spec.js).
//
// Soft-delete (active/inactive) UX retired 2026-04-29 — hard delete via
// the central editor is the only removal path. Coverage for the delete
// cascade lives in team_availability.spec.js.
// ============================================================================

const ROSTER_SEED = [
  {id: 'tm-bman', name: 'BMAN', active: true},
  {id: 'tm-brian', name: 'BRIAN', active: true},
  {id: 'tm-old', name: 'OLDGUY', active: false},
];

async function seedRoster(supabaseAdmin) {
  // Mirror what saveRoster writes: both canonical + legacy mirror.
  const activeMirror = ROSTER_SEED.filter((e) => e.active).map((e) => e.name);
  const r1 = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'team_roster', data: ROSTER_SEED}, {onConflict: 'key'});
  if (r1.error) throw new Error(`seedRoster: roster upsert failed: ${r1.error.message}`);
  const r2 = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'team_members', data: activeMirror}, {onConflict: 'key'});
  if (r2.error) throw new Error(`seedRoster: legacy mirror upsert failed: ${r2.error.message}`);
}

// --------------------------------------------------------------------------
// Test 1 — Fuel Supply public dropdown reads master roster (not per-form)
// --------------------------------------------------------------------------
test('fuel supply: public dropdown shows active master roster only', async ({
  page,
  supabaseAdmin,
  resetDb,
  browser,
}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);

  // Anon context — public webform path. The fuel_supplies RLS only grants
  // anon INSERT, so the suite-default admin storageState would hit 42501.
  const anonContext = await browser.newContext({storageState: undefined});
  const anonPage = await anonContext.newPage();
  try {
    await anonPage.goto('/fueling/supply');
    await expect(anonPage.getByText('Fuel Supply Log')).toBeVisible({timeout: 15_000});
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

    // The team-member dropdown should contain BMAN + BRIAN, NOT OLDGUY.
    const teamSelect = anonPage.getByRole('combobox').first();
    const optionTexts = await teamSelect.locator('option').allTextContents();
    expect(optionTexts).toContain('BMAN');
    expect(optionTexts).toContain('BRIAN');
    expect(optionTexts).not.toContain('OLDGUY');
  } finally {
    await anonContext.close();
  }
  void page;
});

// --------------------------------------------------------------------------
// Test 2 — Sheep weigh-in admin selector populates from master roster
// --------------------------------------------------------------------------
test('sheep weigh-in admin: New Weigh-In modal dropdown populates', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);

  await page.goto('/sheep/weighins');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Open the New Weigh-In modal.
  await page.getByRole('button', {name: /New Weigh-In/i}).click();
  await expect(page.getByText('New Sheep Weigh-In')).toBeVisible({timeout: 5_000});

  // The team-member dropdown should populate with active master names.
  // Poll because loadRoster is async and the modal renders before it
  // resolves on the first tick.
  const teamSelect = page.getByRole('combobox').first();
  await expect
    .poll(async () => await teamSelect.locator('option').allTextContents(), {timeout: 10_000})
    .toContain('BMAN');
  const optionTexts = await teamSelect.locator('option').allTextContents();
  expect(optionTexts).toContain('BRIAN');
  expect(optionTexts).not.toContain('OLDGUY');
});

// --------------------------------------------------------------------------
// Test 3 — Master add via central editor flows to public dropdowns
// --------------------------------------------------------------------------
test('central editor: add propagates to fuel supply public form', async ({page, supabaseAdmin, resetDb, browser}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);

  await page.goto('/admin');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  // Webforms tab is the default admin tab.

  // Add NEWGUY via the central editor.
  await page.locator('[data-roster-add-input="1"]').fill('NEWGUY');
  await page.locator('[data-roster-add-button="1"]').click();

  // Wait for the chip to render — saveRoster writes both keys + setWfRoster
  // updates state; the chip is the operator-visible signal.
  await expect(page.locator('[data-roster-active="1"]', {hasText: 'NEWGUY'})).toBeVisible({
    timeout: 10_000,
  });

  // Verify roster persisted to DB with both keys.
  const {data: rosterRow} = await supabaseAdmin
    .from('webform_config')
    .select('data')
    .eq('key', 'team_roster')
    .maybeSingle();
  // Canonical write is slim {id, name} — no active field after the
  // 2026-04-29 cleanup. Legacy active:false entries are passively dropped.
  const rosterNames = (rosterRow.data || []).map((e) => e.name);
  expect(rosterNames).toContain('NEWGUY');

  const {data: legacyRow} = await supabaseAdmin
    .from('webform_config')
    .select('data')
    .eq('key', 'team_members')
    .maybeSingle();
  expect(legacyRow.data).toContain('NEWGUY');

  // Public form sees NEWGUY in its dropdown (anon context — fuel_supplies
  // RLS only grants anon INSERT, so we use a fresh anonymous context).
  const anonContext = await browser.newContext({storageState: undefined});
  const anonPage = await anonContext.newPage();
  try {
    await anonPage.goto('/fueling/supply');
    await expect(anonPage.getByText('Fuel Supply Log')).toBeVisible({timeout: 15_000});
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    // The roster fetch on /fueling/supply is async after mount. Snapshotting
    // option texts the instant the boot loader clears races the fetch in CI.
    // Poll the specific option into existence instead.
    const teamSelect = anonPage.getByRole('combobox').first();
    await expect(teamSelect.locator('option', {hasText: 'NEWGUY'})).toHaveCount(1, {timeout: 15_000});
  } finally {
    await anonContext.close();
  }
});

// Test 4 (Deactivate UX) was retired 2026-04-29 alongside the active/inactive
// soft-delete UX. Hard-delete cascade is locked by team_availability.spec.js
// Test 5 ("delete: cascades to availability + equipment + mirror; ...").

// Reference the createClient import so the lint plugin doesn't drop it.
void createClient;

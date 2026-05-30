import {test, expect} from './fixtures.js';
import {waitForWeighInListLoaded, waitForWeighInSessionLoaded} from './helpers/weighInReady.js';

// ============================================================================
// Record-page sequence navigation (CP2) — representative weigh-in path.
// Cattle weigh-in list → /weigh-in-sessions/<id>. The session record page is
// shared across species, so this also exercises the shared wiring.
//
// Proves: list tile opens with Prev/Next + position, Prev disabled at the
// first record, Next advances within the sequence to the labeled neighbor;
// and a direct URL open (no route state) hides the controls.
// ============================================================================

async function seedRoster(supabaseAdmin) {
  await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'team_roster', data: [{id: 'tm-bman', name: 'BMAN'}]}, {onConflict: 'key'});
  await supabaseAdmin.from('webform_config').upsert({key: 'team_members', data: ['BMAN']}, {onConflict: 'key'});
}

async function seedSession(supabaseAdmin, {id, herd, date}) {
  const r = await supabaseAdmin.from('weigh_in_sessions').insert({
    id,
    species: 'cattle',
    herd,
    date,
    team_member: 'BMAN',
    status: 'draft',
    started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  if (r.error) throw new Error('seedSession(' + id + '): ' + r.error.message);
}

test.describe('Weigh-in session sequence navigation', () => {
  test('list tile opens with Prev/Next; Next advances within the sequence', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedRoster(supabaseAdmin);
    // Newest first by date → visible order ws-1, ws-2, ws-3.
    await seedSession(supabaseAdmin, {id: 'ws-1', herd: 'finishers', date: '2026-05-03'});
    await seedSession(supabaseAdmin, {id: 'ws-2', herd: 'mommas', date: '2026-05-02'});
    await seedSession(supabaseAdmin, {id: 'ws-3', herd: 'backgrounders', date: '2026-05-01'});

    await page.goto('/cattle/weighins');
    await waitForWeighInListLoaded(page);
    await expect(page.locator('[data-weighin-session-tile="ws-1"]')).toBeVisible({timeout: 15_000});
    await page.locator('[data-weighin-session-tile="ws-1"]').click();

    await expect(page).toHaveURL(/\/weigh-in-sessions\/ws-1$/, {timeout: 10_000});
    await waitForWeighInSessionLoaded(page);
    await expect(page.locator('[data-record-seq-nav="1"]')).toBeVisible();
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

    // Label rule: "<date> · <group>"; group = HERD_LABELS[herd] for cattle.
    const nextBtn = page.locator('[data-record-seq-next="1"]');
    const nextLabel = (await nextBtn.innerText()).replace(/[‹›]/g, '').trim();
    expect(nextLabel).toBe('2026-05-02 · Mommas');

    await nextBtn.click();
    await expect(page).toHaveURL(/\/weigh-in-sessions\/ws-2$/, {timeout: 10_000});
    await waitForWeighInSessionLoaded(page);
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
  });

  test('direct URL open hides the sequence controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedRoster(supabaseAdmin);
    await seedSession(supabaseAdmin, {id: 'ws-1', herd: 'finishers', date: '2026-05-03'});
    await seedSession(supabaseAdmin, {id: 'ws-2', herd: 'mommas', date: '2026-05-02'});

    await page.goto('/weigh-in-sessions/ws-1');
    await waitForWeighInSessionLoaded(page);
    await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });
});

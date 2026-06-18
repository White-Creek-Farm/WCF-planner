import {test, expect} from './fixtures.js';

// ============================================================================
// Daily Report Photos UI — 2026-04-29
// ============================================================================
// Locks the post-build contract for photo capture on the 5 supported daily
// reports (cattle, sheep, pig, poultry/broiler, layer). Egg excluded.
//
// Coverage:
//   1  Public submit with photos lands a row + photo paths in the locked
//      <form_kind>/<csid>/<photo_key>.jpg scheme; storage objects exist.
//   2  Public submit without photos still works (photos: []).
//   3  11th photo cap regression — UI rejects, count chip stays at 10.
//   4  Admin display: chip on tile + thumbnails in edit modal.
//   5  Photo upload failure aborts the submission (no row insert).
//   6  Multi-row daily block: photos + Add-Group rejected; no row inserted
//      (Codex pre-commit regression — broiler/layer/pig daily forms can
//      submit multiple rows via the Add-Group feature; until the
//      daily_submissions parent table lands, photos + extras are blocked
//      to avoid silent attribution to the primary row only).
//
// Tests 1-5 + 6's primary path use the sheep / broiler webforms because
// they're the cleanest single-row vs multi-row exemplars; the photo
// pipeline itself is shared across all 5 supported daily forms.
//
// Per-spec storage cleanup is wired into resetTestDatabase via the
// cleanupDailyPhotosStorage helper added in tests/setup/reset.js.
//
// Login-required conversion: the daily-report webforms now lock the submitter
// to the signed-in user, so /webforms/<slug> is login-required. The public-
// submit tests used to drive an anonymous browser.newContext; an anon context
// now lands on the LoginScreen, so they run on the default authenticated admin
// page instead. The submitter is the admin profile's full_name ('Test Admin').
//
// Daily-photos RLS (resolved): the daily-photos storage bucket previously
// lacked a `FOR INSERT TO authenticated` policy (migration 031 granted anon
// INSERT only), so once these forms became login-required, authenticated photo
// uploads 403'd with "new row violates row-level security policy". Migration
// 099 (`daily_photos_auth_insert`) added the authenticated-INSERT policy, so
// the authenticated photo webforms now upload correctly and the upload-
// dependent tests here run.
// ============================================================================

// Tiny 1x1 transparent PNG, ~67 bytes once decoded. The browser decodes it
// via createImageBitmap inside photoCompress and re-encodes as JPEG.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG = Buffer.from(TINY_PNG_B64, 'base64');

function tinyImageFile(name) {
  return {name, mimeType: 'image/png', buffer: TINY_PNG};
}

// Sheep form is the simplest of the 5 supported daily forms — only
// requires date (auto-fills today), team_member, and flock. Date and the
// dropdown selectors are stable; the photo capture renders just above the
// Submit button regardless of which program is being tested.
async function gotoSheepWebform(page) {
  await page.goto('/webforms/sheep');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('[data-daily-photo-capture="1"]')).toBeVisible({timeout: 10_000});
}

async function fillSheepRequiredFields(page) {
  // Submitter is now a locked auto-filled field (signed-in user), not a select,
  // so the flock dropdown is the first <select>. Wait for it to populate (the
  // form's webform_config read is async) before selecting.
  const flockSelect = page.locator('select').first();
  await expect.poll(async () => await flockSelect.locator('option').count(), {timeout: 10_000}).toBeGreaterThan(1);
  await flockSelect.selectOption({value: 'ewes'});
}

// --------------------------------------------------------------------------
// Test 1 — Public submit WITH photos lands the row + storage objects
// --------------------------------------------------------------------------
test('public sheep daily submit with 2 photos: row + storage objects land', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();

  await gotoSheepWebform(page);
  await fillSheepRequiredFields(page);

  await page
    .locator('[data-daily-photo-capture="1"] [data-photo-input="1"]')
    .setInputFiles([tinyImageFile('a.png'), tinyImageFile('b.png')]);

  // Selected count chip rendered.
  await expect(page.locator('[data-daily-photo-capture="1"]')).toContainText('2 of 10');

  // Submit. Wait for the success state — WebformHub.sheep sets done=true.
  await page.getByRole('button', {name: /Submit Report/i}).click();
  await expect(page.getByText(/Thanks|Submitted|Daily logged|saved/i).first()).toBeVisible({
    timeout: 15_000,
  });

  // DB row landed with photos.
  const {data, error} = await supabaseAdmin.from('sheep_dailys').select('*');
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  expect(data[0].photos).toHaveLength(2);
  expect(data[0].client_submission_id).toBeTruthy();

  // Path scheme conformance.
  const csid = data[0].client_submission_id;
  expect(data[0].photos[0].path).toBe(`sheep_dailys/${csid}/photo-1.jpg`);
  expect(data[0].photos[1].path).toBe(`sheep_dailys/${csid}/photo-2.jpg`);
  expect(data[0].photos[0].mime).toBe('image/jpeg');

  // Storage objects exist (service-role list).
  const list = await supabaseAdmin.storage.from('daily-photos').list(`sheep_dailys/${csid}`);
  expect(list.error).toBeNull();
  expect((list.data || []).map((f) => f.name).sort()).toEqual(['photo-1.jpg', 'photo-2.jpg']);
});

// --------------------------------------------------------------------------
// Test 2 — Public submit WITHOUT photos still works
// --------------------------------------------------------------------------
test('public sheep daily submit without photos works (photos: [])', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();

  await gotoSheepWebform(page);
  await fillSheepRequiredFields(page);

  // No photos selected. Submit.
  await page.getByRole('button', {name: /Submit Report/i}).click();
  await expect(page.getByText(/Thanks|Submitted|Daily logged|saved/i).first()).toBeVisible({
    timeout: 15_000,
  });

  const {data, error} = await supabaseAdmin.from('sheep_dailys').select('*');
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  expect(data[0].photos).toEqual([]);
});

// --------------------------------------------------------------------------
// Test 3 — 11-photo cap regression (UI rejects)
// --------------------------------------------------------------------------
test('photo cap regression: 11th photo selection caps at 10', async ({page, resetDb}) => {
  await resetDb();

  await gotoSheepWebform(page);
  await fillSheepRequiredFields(page);

  const eleven = Array.from({length: 11}, (_, i) => tinyImageFile(`p${i + 1}.png`));
  await page.locator('[data-daily-photo-capture="1"] [data-photo-input="1"]').setInputFiles(eleven);

  // Component caps the selection at 10 — chip text confirms.
  await expect(page.locator('[data-daily-photo-capture="1"]')).toContainText('10 of 10');
  await expect(page.locator('[data-daily-photo-capture="1"]')).toContainText('max reached');

  // The Add Photos button is disabled at the cap.
  await expect(page.locator('[data-add-photos="1"]')).toBeDisabled();
});

// --------------------------------------------------------------------------
// Test 4 — Admin display: chip on tile + thumbnails in modal
// --------------------------------------------------------------------------
test('admin display: photo chip on tile + thumbnails in edit modal (signed URL)', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();

  // Seed a sheep daily row with 2 photos via service-role. We don't actually
  // upload files to storage here — the chip + thumbnail display only needs
  // the photo metadata on the row. The signed-URL fetch will return a URL
  // even for a non-existent storage path; the IMG src will 404 but the
  // thumbnail wrapper still renders.
  const csid = 'csid-admin-display-test';
  await supabaseAdmin.from('sheep_dailys').upsert(
    {
      id: 'sd-admin-display',
      deleted_at: null,
      deleted_by: null,
      client_submission_id: csid,
      date: '2026-04-29',
      team_member: 'BMAN',
      flock: 'ewes',
      feeds: [],
      minerals: [],
      fence_voltage_kv: null,
      waterers_working: true,
      mortality_count: 0,
      comments: null,
      source: 'daily_webform',
      photos: [
        {
          path: `sheep_dailys/${csid}/photo-1.jpg`,
          name: 'a.jpg',
          mime: 'image/jpeg',
          size_bytes: 50,
          captured_at: '2026-04-29T10:00:00.000Z',
        },
        {
          path: `sheep_dailys/${csid}/photo-2.jpg`,
          name: 'b.jpg',
          mime: 'image/jpeg',
          size_bytes: 50,
          captured_at: '2026-04-29T10:00:01.000Z',
        },
      ],
    },
    {onConflict: 'id'},
  );

  await page.goto('/sheep/dailys');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Row chip renders with the count.
  await expect(page.locator('[data-photo-chip="1"][data-photo-count="2"]').first()).toBeVisible({timeout: 10_000});

  // Click the daily row to open the record page (Build Queue 5: the list row now
  // renders as a shared DailyRecordCard .hoverable-tile div carrying data-daily-row).
  await page.locator('[data-daily-row]').first().click();

  // Thumbnails render — 2 thumbs.
  await expect(page.locator('[data-photo-thumbnails="1"]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-photo-thumb]')).toHaveCount(2);
});

// --------------------------------------------------------------------------
// Test 4b — Daily-report hotfix: the Home "Last 5 Days" tile opens the
// dedicated RECORD PAGE (not the legacy dailys-hub edit modal), with a
// locked saved-submitter display and read-only photo thumbnails inline.
// --------------------------------------------------------------------------
test('hotfix: Home Last-5-Days tile → record page with locked submitter + photo thumbnails', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();

  // Seed inside the home "Last 5 Days" window (today's date). team_member is
  // intentionally NOT in the seeded roster; record pages preserve the saved
  // submitter text without needing a roster option.
  const today = new Date().toISOString().slice(0, 10);
  const csid = 'csid-home-route-test';
  await supabaseAdmin.from('sheep_dailys').upsert(
    {
      id: 'sd-home-route',
      deleted_at: null,
      deleted_by: null,
      client_submission_id: csid,
      date: today,
      team_member: 'SIMON',
      flock: 'ewes',
      feeds: [],
      minerals: [],
      fence_voltage_kv: null,
      waterers_working: true,
      mortality_count: 0,
      comments: null,
      source: 'daily_webform',
      photos: [
        {
          path: `sheep_dailys/${csid}/photo-1.jpg`,
          name: 'a.jpg',
          mime: 'image/jpeg',
          size_bytes: 50,
          captured_at: today + 'T10:00:00.000Z',
        },
      ],
    },
    {onConflict: 'id'},
  );

  await page.goto('/');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Home reads the recent-dailys contexts loaded once at boot; tolerate a
  // cold-boot data race (home has no in-page self-heal) with a single reload
  // before asserting the tile.
  const tile = page.locator('[data-daily-report-tile="sd-home-route"]');
  if (!(await tile.isVisible().catch(() => false))) {
    await page.waitForTimeout(1500);
    if (!(await tile.isVisible().catch(() => false))) {
      await page.reload();
      await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    }
  }
  await expect(tile).toBeVisible({timeout: 15_000});
  await tile.click();

  // Direct record-page route — the URL changes (a modal would not), and the
  // record page renders. No legacy edit modal.
  await expect(page).toHaveURL(/\/sheep\/dailys\/sd-home-route/, {timeout: 10_000});
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 10_000});

  // Team Member is a locked display that preserves the saved value.
  const teamSelect = page.locator('[data-team-member-select="1"]');
  await expect(teamSelect).toBeVisible();
  await expect(teamSelect).toHaveAttribute('data-team-member-select-locked', '1');
  await expect(teamSelect).toContainText('SIMON');

  // Read-only photo thumbnails render inline in the record page body.
  await expect(page.locator('[data-photo-thumbnails="1"]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-photo-thumb]')).toHaveCount(1);
});

// --------------------------------------------------------------------------
// Test 5 — Photo upload failure routes through the offline queue (1D-B)
// --------------------------------------------------------------------------
// Pre-1D-B (Phase 1B canary contract): an aborted storage upload surfaced
// "Photo upload failed: ... Submission aborted" inline and the row was
// dropped. Phase 1D-B routes the same scenario through the hook's network
// branch — sheep_dailys submission now lands in state:'queued', the row
// is persisted in IDB, and no row lands in sheep_dailys until the queue
// drains. This test locks the new contract.
test('photo upload failure routes to state="queued" (no row inserted yet)', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();

  await page.route('**/storage/v1/object/daily-photos/**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  await gotoSheepWebform(page);
  await fillSheepRequiredFields(page);

  await page.locator('[data-daily-photo-capture="1"] [data-photo-input="1"]').setInputFiles([tinyImageFile('a.png')]);

  await page.getByRole('button', {name: /Submit Report/i}).click();

  // 1D-B contract: state="queued" rendered on the done screen.
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  // No row landed in sheep_dailys yet (queue hasn't drained).
  const {data, error} = await supabaseAdmin.from('sheep_dailys').select('*');
  expect(error).toBeNull();
  expect(data).toHaveLength(0);

  await page.unroute('**/storage/v1/object/daily-photos/**');
});

// --------------------------------------------------------------------------
// Test 6 — Multi-row daily block: photos + Add-Group rejected; no row inserted
// --------------------------------------------------------------------------
// Codex regression — pre-commit 2026-04-29.
//
// Photos + extra-groups can't be reconciled cleanly without the
// daily_submissions parent table (which is the deferred Add-Feed design).
// In the meantime, broiler / layer / pig daily forms BLOCK submit if both
// photos AND extra groups are present. This test exercises the broiler
// branch end-to-end (authenticated, real form). No upload fires; no row
// lands; operator gets a clear error.
test('multi-row daily block: photos + extra group rejected, no row inserted', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();

  // Broiler-specific seed: a couple of batches + Add-Group enabled. The form is
  // login-required now, so it renders inside the authenticated admin app whose
  // boot re-syncs webform_config from app_store (buildBroilerPublicMirror +
  // syncWebformConfig). That sync clobbers bare broiler_groups (rebuilt from
  // ppp-v4, EARLY) and webform_settings.allowAddGroup (rebuilt from
  // ppp-webforms-v1). Seed those canonical stores too so the batch dropdown +
  // Add-Group survive the boot sync.
  await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'broiler_groups', data: ['B-26-01', 'B-26-02']}, {onConflict: 'key'});
  await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'webform_settings', data: {allowAddGroup: {'broiler-dailys': true}}}, {onConflict: 'key'});
  await supabaseAdmin.from('app_store').upsert(
    {
      key: 'ppp-v4',
      data: [
        {name: 'B-26-01', schooner: '1', breed: 'CC', hatchery: 'CREDO FARMS', status: 'active'},
        {name: 'B-26-02', schooner: '1', breed: 'CC', hatchery: 'CREDO FARMS', status: 'active'},
      ],
    },
    {onConflict: 'key'},
  );
  await supabaseAdmin
    .from('app_store')
    .upsert(
      {key: 'ppp-webforms-v1', data: {webforms: [{id: 'broiler-dailys', allowAddGroup: true, sections: []}]}},
      {onConflict: 'key'},
    );

  await page.goto('/webforms/broiler');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('[data-daily-photo-capture="1"]')).toBeVisible({timeout: 10_000});

  // Fill primary group: submitter is locked (no team select), so the batch is
  // the first <select>. Wait for it to populate before selecting.
  const batchSelect = page.locator('select').first();
  await expect.poll(async () => await batchSelect.locator('option').count(), {timeout: 10_000}).toBeGreaterThan(1);
  await batchSelect.selectOption({value: 'B-26-01'});

  // Add an extra group, fill its batch dropdown (now the second <select>).
  await page.getByRole('button', {name: /Add Another Group/i}).click();
  const extraBatchSelect = page.locator('select').nth(1);
  await extraBatchSelect.selectOption({value: 'B-26-02'});

  // Pick one photo.
  await page.locator('[data-daily-photo-capture="1"] [data-photo-input="1"]').setInputFiles([tinyImageFile('a.png')]);

  // Submit. Block fires before any upload.
  await page.getByRole('button', {name: /Submit Report/i}).click();

  await expect(page.getByText(/Photos can only be attached when submitting one group at a time/i)).toBeVisible({
    timeout: 10_000,
  });

  // No row landed in poultry_dailys.
  const {data, error} = await supabaseAdmin.from('poultry_dailys').select('*');
  expect(error).toBeNull();
  expect(data).toHaveLength(0);

  // No storage objects under poultry_dailys/* either.
  const list = await supabaseAdmin.storage.from('daily-photos').list('poultry_dailys');
  expect(list.error).toBeNull();
  expect(list.data || []).toHaveLength(0);
});

import {test, expect} from './fixtures.js';

// ============================================================================
// Tasks v2 T6 + T7 — New Task + Complete Task + Photos.
//
// Operational surfaces. Every DB write hits a v2 SECDEF RPC:
//   create_one_time_task_instance(p_instance, p_creation_photo_paths)
//   complete_task_instance(p_instance_id, p_completion_note, p_completion_photo_paths)
//
// We deliberately avoid asserting on photo BYTES (lightbox rendering
// requires a signed URL fetch, and we keep the test deterministic by
// only asserting on the photo affordance + lightbox open / close).
// ============================================================================

// Known-good 1x1 PNG that browsers' createImageBitmap reliably decodes.
// Borrowed verbatim from daily_report_photos.spec.js (the
// alternate 1x1 used by some other specs decodes inconsistently across
// Chromium versions and trips compressImage's "image decode failed").
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tinyImageFile(name) {
  return {name, mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_B64, 'base64')};
}

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;

async function seedAdminProfile(supabaseAdmin) {
  const {data: u} = await supabaseAdmin.auth.admin.listUsers();
  const adminUser = (u && u.users ? u.users : []).find(
    (x) => (x.email || '').toLowerCase() === (TEST_ADMIN_EMAIL || '').toLowerCase(),
  );
  if (!adminUser) throw new Error('admin auth user not found in TEST DB');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: adminUser.id, email: adminUser.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  return adminUser.id;
}

async function profileIdByName(supabaseAdmin, fullName) {
  const {data} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', fullName).limit(1);
  if (!data || data.length === 0) throw new Error(`profile "${fullName}" not found in TEST DB`);
  return data[0].id;
}

async function signInAsSimon(page) {
  await page.context().clearCookies();
  await page.goto('/');
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (_e) {
      /* test cleanup */
    }
  });
  await page.goto('/');
  await page.getByPlaceholder('your@email.com').first().fill('simon.tasks@wcfplanner.test');
  await page.getByPlaceholder('••••••••').fill('apply_test_mig_052_placeholder_password');
  await page.getByRole('button', {name: /^sign in$/i}).click();
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});
}

test.describe('Tasks v2 T6 — New Task modal', () => {
  test('admin creates a one-time task; it lands in the My Tasks list and bumps the Header badge', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    // Simon ensured present so the assignee dropdown is non-empty even if
    // we only assign to admin in this test.
    await profileIdByName(supabaseAdmin, 'Simon');

    await page.goto('/tasks');
    await page.locator('[data-tasks-new-task-button="1"]').click();

    const modal = page.locator('[data-new-task-modal="1"]');
    await expect(modal).toBeVisible();
    await modal.locator('[data-new-task-field="title"]').fill('T6 admin-created one-time');
    await modal.locator('[data-new-task-field="description"]').fill('seeded by tasks_v2_t6_t7 spec');
    await modal.locator('[data-new-task-field="assignee"]').selectOption(adminId);
    // Force a past due_date so the new task counts toward the Header
    // badge (caller-due-or-overdue) regardless of when the test runs.
    await modal.locator('[data-new-task-field="due-date"]').fill('2025-01-01');
    await modal.locator('[data-new-task-save="1"]').click();

    // Modal closes and a new row appears in My open tasks.
    await expect(modal).toHaveCount(0);
    const mine = page.locator('[data-tasks-section="mine"]');
    await expect(mine).toBeVisible();
    await expect(mine.getByText('T6 admin-created one-time')).toBeVisible();

    // Header badge updates without focus/navigation thanks to the
    // TASK_CHANGE_EVENT listener.
    const badge = page.locator('[data-tasks-header-link="1"] [data-tasks-header-badge]');
    await expect(badge).toBeVisible();
    const badgeText = await badge.innerText();
    expect(parseInt(badgeText, 10)).toBeGreaterThan(0);
  });

  test('non-admin (Simon) creates a task assigned to self and sees it in My Tasks', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');

    await signInAsSimon(page);
    await page.goto('/tasks');
    await page.locator('[data-tasks-new-task-button="1"]').click();

    const modal = page.locator('[data-new-task-modal="1"]');
    await expect(modal).toBeVisible();
    await modal.locator('[data-new-task-field="title"]').fill('T6 Simon self-assigned');
    await modal.locator('[data-new-task-field="description"]').fill('Simon assigns a task to himself');
    await modal.locator('[data-new-task-field="assignee"]').selectOption(simonId);
    await modal.locator('[data-new-task-field="due-date"]').fill('2099-12-31');
    await modal.locator('[data-new-task-save="1"]').click();

    await expect(modal).toHaveCount(0);
    const mine = page.locator('[data-tasks-section="mine"]');
    await expect(mine.getByText('T6 Simon self-assigned')).toBeVisible();
  });

  test('creation with photos writes a paperclip affordance and opens the lightbox on click', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);

    await page.goto('/tasks');
    await page.locator('[data-tasks-new-task-button="1"]').click();
    const modal = page.locator('[data-new-task-modal="1"]');
    await modal.locator('[data-new-task-field="title"]').fill('T6 photos');
    await modal.locator('[data-new-task-field="description"]').fill('with two creation photos');
    await modal.locator('[data-new-task-field="assignee"]').selectOption(adminId);
    await modal.locator('[data-new-task-field="due-date"]').fill('2099-12-31');
    await modal
      .locator('[data-new-task-field="photos"]')
      .setInputFiles([tinyImageFile('p1.png'), tinyImageFile('p2.png')]);
    await modal.locator('[data-new-task-save="1"]').click();
    await expect(modal).toHaveCount(0);

    // Click the paperclip on the new row to open the lightbox. The
    // newly-created row sits at the bottom of My open tasks (sorted by
    // due_date asc, and 2099 is the latest).
    const mine = page.locator('[data-tasks-section="mine"]');
    const newRow = mine.locator('[data-task-row]').filter({hasText: 'T6 photos'});
    await expect(newRow).toBeVisible();
    await newRow.locator('[data-task-photo-open="1"]').click();

    const lightbox = page.locator('[data-task-photo-lightbox="1"]');
    await expect(lightbox).toBeVisible();
    // Two photos seeded; lightbox renders the position counter.
    await expect(lightbox.locator('[data-lightbox-position="1/2"]')).toBeVisible();
    await lightbox.locator('[data-lightbox-next="1"]').click();
    await expect(lightbox.locator('[data-lightbox-position="2/2"]')).toBeVisible();
    await lightbox.locator('[data-lightbox-close="1"]').click();
    await expect(lightbox).toHaveCount(0);
  });
});

test.describe('Tasks v2 T7 — Complete Task modal', () => {
  test('empty completion note is blocked client-side', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await supabaseAdmin.from('task_instances').upsert(
      {
        id: 'tic-t7-blocked-empty',
        template_id: null,
        assignee_profile_id: adminId,
        due_date: '2099-12-31',
        title: 'T7 empty-note guard',
        description: 'admin clicks Complete then Save without typing a note',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
        completed_at: null,
        completed_by_profile_id: null,
        completion_note: null,
        completion_photo_path: null,
        request_photo_path: null,
      },
      {onConflict: 'id'},
    );

    await page.goto('/tasks');
    const row = page.locator('[data-task-row="tic-t7-blocked-empty"]');
    await expect(row).toBeVisible();
    await row.locator('[data-task-complete-button="1"]').click();

    const modal = page.locator('[data-complete-task-modal="1"]');
    await expect(modal).toBeVisible();
    // Click Save without typing a note → client-side validation fires.
    await modal.locator('[data-complete-task-save="1"]').click();
    await expect(modal.locator('[data-complete-task-error="1"]')).toContainText(/completion note is required/i);
    // Modal stays open; the row is still in My open tasks.
    await expect(modal).toBeVisible();
    await expect(row).toBeVisible();
  });

  test('completing own task with note moves it from open into Completed', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await supabaseAdmin.from('task_instances').upsert(
      {
        id: 'tic-t7-complete-mine',
        template_id: null,
        assignee_profile_id: adminId,
        due_date: '2025-04-01',
        title: 'T7 admin completes own task',
        description: 'admin finishes a self-assigned task',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
        completed_at: null,
        completed_by_profile_id: null,
        completion_note: null,
        completion_photo_path: null,
        request_photo_path: null,
      },
      {onConflict: 'id'},
    );

    await page.goto('/tasks');
    const row = page.locator('[data-task-row="tic-t7-complete-mine"]');
    await expect(row).toBeVisible();
    await row.locator('[data-task-complete-button="1"]').click();

    const modal = page.locator('[data-complete-task-modal="1"]');
    await modal.locator('[data-complete-task-field="note"]').fill('Done — verified equipment cleaned and stored.');
    await modal.locator('[data-complete-task-save="1"]').click();
    await expect(modal).toHaveCount(0);

    // Row no longer in open My open tasks.
    await expect(page.locator('[data-task-row="tic-t7-complete-mine"]')).toHaveCount(0);

    // Switch to Completed tab — the row appears there with the note.
    await page.locator('[data-tasks-tab-button="completed"]').click();
    const completedTab = page.locator('[data-tasks-tab="completed"]');
    const completedRow = completedTab.locator('[data-task-row="tic-t7-complete-mine"]');
    await expect(completedRow).toBeVisible();
    await expect(completedRow.locator('[data-completion-note="1"]')).toContainText('verified equipment cleaned');
  });

  test('completion with photos surfaces the paperclip and opens the lightbox', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await supabaseAdmin.from('task_instances').upsert(
      {
        id: 'tic-t7-complete-photos',
        template_id: null,
        assignee_profile_id: adminId,
        due_date: '2025-06-01',
        title: 'T7 admin completes with photos',
        description: 'attach completion photos',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
        completed_at: null,
        completed_by_profile_id: null,
        completion_note: null,
        completion_photo_path: null,
        request_photo_path: null,
      },
      {onConflict: 'id'},
    );

    await page.goto('/tasks');
    await page.locator('[data-task-row="tic-t7-complete-photos"] [data-task-complete-button="1"]').click();

    const modal = page.locator('[data-complete-task-modal="1"]');
    await modal.locator('[data-complete-task-field="note"]').fill('Done — photos attached.');
    // The photos input stays DISABLED until the modal's async photo-slot
    // count loads; a real user cannot pick files before then. setInputFiles
    // bypasses the disabled affordance and the selection is dropped by the
    // slot guard — wait for the enabled state exactly like a real user.
    const photosInput = modal.locator('[data-complete-task-field="photos"]');
    await expect(photosInput).toBeEnabled();
    await photosInput.setInputFiles([tinyImageFile('c1.png'), tinyImageFile('c2.png')]);
    // Two selected files register before save (guards against silent drops).
    await expect(modal.locator('[data-complete-task-photo]')).toHaveCount(2);
    await modal.locator('[data-complete-task-save="1"]').click();
    await expect(modal).toHaveCount(0);

    await page.locator('[data-tasks-tab-button="completed"]').click();
    const completedTab = page.locator('[data-tasks-tab="completed"]');
    const completedRow = completedTab.locator('[data-task-row="tic-t7-complete-photos"]');
    await expect(completedRow).toBeVisible();
    await completedRow.locator('[data-task-photo-open="1"]').click();

    const lightbox = page.locator('[data-task-photo-lightbox="1"]');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator('[data-lightbox-position="1/2"]')).toBeVisible();
    await lightbox.locator('[data-lightbox-close="1"]').click();
    await expect(lightbox).toHaveCount(0);
  });

  test('regular user does NOT see Complete on another user’s task; admin DOES on a regular user’s task', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');

    // Two open tasks: one assigned to admin, one assigned to Simon.
    await supabaseAdmin.from('task_instances').upsert(
      [
        {
          id: 'tic-t7-admin-row',
          template_id: null,
          assignee_profile_id: adminId,
          due_date: '2099-12-31',
          title: 'admin row visible to Simon',
          submission_source: 'admin_manual',
          status: 'open',
          from_recurring_template: false,
          completed_at: null,
          completed_by_profile_id: null,
          completion_note: null,
          completion_photo_path: null,
          request_photo_path: null,
        },
        {
          id: 'tic-t7-simon-row',
          template_id: null,
          assignee_profile_id: simonId,
          due_date: '2099-12-31',
          title: 'simon row visible to admin',
          submission_source: 'admin_manual',
          status: 'open',
          from_recurring_template: false,
          completed_at: null,
          completed_by_profile_id: null,
          completion_note: null,
          completion_photo_path: null,
          request_photo_path: null,
        },
      ],
      {onConflict: 'id'},
    );

    // ── Simon (regular) signs in: cannot complete the admin's row ──
    await signInAsSimon(page);
    await page.goto('/tasks');
    // Expand the admin group inside others to see the admin row.
    const adminGroup = page.locator(`[data-tasks-group="${adminId}"]`);
    await adminGroup.locator('button').first().click();
    const adminRowAsSimon = page.locator('[data-task-row="tic-t7-admin-row"]');
    await expect(adminRowAsSimon).toBeVisible();
    await expect(adminRowAsSimon.locator('[data-task-complete-button="1"]')).toHaveCount(0);

    // Simon's own row in the highlighted top section gets the button.
    const ownRow = page.locator('[data-task-row="tic-t7-simon-row"]');
    await expect(ownRow).toBeVisible();
    await expect(ownRow.locator('[data-task-complete-button="1"]')).toBeVisible();

    // ── Admin signs back in (the global setup's admin storage state is
    // overwritten in this page, so we just type the credentials again
    // rather than juggling Playwright contexts mid-test). ──
    await page.context().clearCookies();
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_e) {
        /* test cleanup */
      }
    });
    await page.goto('/');
    await page.getByPlaceholder('your@email.com').first().fill(TEST_ADMIN_EMAIL);
    await page.getByPlaceholder('••••••••').fill(process.env.VITE_TEST_ADMIN_PASSWORD || 'admin_password_unset_in_env');
    await page.getByRole('button', {name: /^sign in$/i}).click();
    await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});

    await page.goto('/tasks');
    // Admin sees Simon's row in the others section AND the Complete button.
    const simonGroup = page.locator(`[data-tasks-group="${simonId}"]`);
    await simonGroup.locator('button').first().click();
    const simonRowAsAdmin = page.locator('[data-task-row="tic-t7-simon-row"]');
    await expect(simonRowAsAdmin).toBeVisible();
    await expect(simonRowAsAdmin.locator('[data-task-complete-button="1"]')).toBeVisible();

    // Admin completes Simon's task.
    await simonRowAsAdmin.locator('[data-task-complete-button="1"]').click();
    const modal = page.locator('[data-complete-task-modal="1"]');
    await modal.locator('[data-complete-task-field="note"]').fill('Admin completed on behalf of Simon for the spec.');
    await modal.locator('[data-complete-task-save="1"]').click();
    await expect(modal).toHaveCount(0);

    // Simon's row is no longer open.
    await expect(page.locator('[data-task-row="tic-t7-simon-row"]')).toHaveCount(0);
  });
});

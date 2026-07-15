import {test, expect} from './fixtures.js';

// CP3 record-page sequence navigation — task.instance (grouped list surface).

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

async function seedTask(supabaseAdmin, {id, title, assigneeId}) {
  const {error} = await supabaseAdmin.from('task_instances').upsert(
    {
      id,
      assignee_profile_id: assigneeId,
      due_date: '2026-12-15',
      title,
      description: 'CP3 task sequence seed',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
      created_by_profile_id: assigneeId,
      client_submission_id: 'csid-' + id,
      // Resets so a stale worker row a prior run completed/reassigned is
      // overwritten back into the intended open, unannotated shape.
      completed_at: null,
      completed_by_profile_id: null,
      completion_photo_path: null,
      completion_note: null,
      request_photo_path: null,
      template_id: null,
      designation: null,
      from_system_rule_id: null,
      from_system_source_event_key: null,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error('seedTask(' + id + '): ' + error.message);
}

async function profileIdByName(supabaseAdmin, fullName) {
  const {data} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', fullName).limit(1);
  if (!data || data.length === 0) throw new Error('profile "' + fullName + '" not found in TEST DB');
  return data[0].id;
}

test.describe('Task record-page sequence navigation', () => {
  test('list row opens with Prev/Next; Next advances to the labeled neighbor', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedTask(supabaseAdmin, {id: 'tseq-1', title: 'Seq Task One', assigneeId: adminId});
    await seedTask(supabaseAdmin, {id: 'tseq-2', title: 'Seq Task Two', assigneeId: adminId});
    await seedTask(supabaseAdmin, {id: 'tseq-3', title: 'Seq Task Three', assigneeId: adminId});

    await page.goto('/tasks');
    await expect(page.locator('[data-task-row]').first()).toBeVisible({timeout: 15_000});

    // Open the first rendered task → its record page (position 1). Task rows
    // are whole-row openables (.hoverable-tile + openableProps role="button");
    // the old inner [role="link"] title anchor is retired.
    await page.locator('[data-task-row]').first().click();

    await expect(page).toHaveURL(/\/tasks\/tseq-/, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toBeVisible();
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

    const nextBtn = page.locator('[data-record-seq-next="1"]');
    const nextAria = await nextBtn.getAttribute('aria-label');
    expect(nextAria).toMatch(/^Next record: /);
    const nextLabel = nextAria.replace(/^Next record: /, '');
    expect(nextLabel).toMatch(/^Seq Task /);

    await nextBtn.click();
    await expect(page.locator('[data-record-title="1"]')).toHaveText(nextLabel, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
  });

  test('direct URL open hides the sequence controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedTask(supabaseAdmin, {id: 'tseq-1', title: 'Seq Task One', assigneeId: adminId});
    await seedTask(supabaseAdmin, {id: 'tseq-2', title: 'Seq Task Two', assigneeId: adminId});

    await page.goto('/tasks/tseq-1');
    await expect(page.locator('[data-record-title="1"]')).toHaveText('Seq Task One', {timeout: 15_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });

  test('collapsed solo other-assignee group is excluded — single visible row hides controls', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    const makId = await profileIdByName(supabaseAdmin, 'Mak');
    // One task visible in "My open tasks"; one in a collapsed solo other group.
    await seedTask(supabaseAdmin, {id: 'tseq-mine', title: 'My Only Task', assigneeId: adminId});
    await seedTask(supabaseAdmin, {id: 'tseq-other', title: 'Other Collapsed Task', assigneeId: makId});

    await page.goto('/tasks');
    await expect(page.locator('[data-task-row="tseq-mine"]')).toBeVisible({timeout: 15_000});
    // Whole-row openable (openableProps role="button") — no inner link anchor.
    await page.locator('[data-task-row="tseq-mine"]').click();

    await expect(page).toHaveURL(/\/tasks\/tseq-mine/, {timeout: 10_000});
    // Mak's task sits in a collapsed solo group (not rendered), so the visible
    // sequence has length 1 → no controls.
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });
});

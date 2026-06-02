import {test, expect} from './fixtures.js';

// ============================================================================
// Global Activity Log (/activity) — read-only timeline + record-page routing.
//
// What this spec proves (post legacy-composer retirement):
//   1. A row whose entity_type has a registered route navigates to that
//      entity's dedicated record page on click — it does NOT open the old
//      ActivityModal/ActivityPanel composer.
//   2. /activity exposes no comment composer: there is no post button and no
//      activity modal anywhere on the page.
//
// The legacy modal/chip composer (driven by tests/activity_phase1.spec.js)
// was deleted with ActivityModal.jsx / ActivityPanel.jsx. Comments are the
// live discussion path now (CommentsSection on each record page); Activity is
// read-only audit/system history.
// ============================================================================

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

async function seedOpenTask(supabaseAdmin, {id, title, assigneeId, createdById}) {
  const {error} = await supabaseAdmin.from('task_instances').upsert(
    {
      id,
      assignee_profile_id: assigneeId,
      due_date: '2026-06-15',
      title,
      description: 'Activity navigation spec seed',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
      created_by_profile_id: createdById,
      client_submission_id: `csid-actnav-${id}`,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error(`seedOpenTask(${id}): ${error.message}`);
}

// Insert an activity_event directly via service_role (the tables are RLS
// locked-down for authenticated; service_role bypasses RLS). This is the
// timeline row the spec clicks.
async function seedActivityEvent(supabaseAdmin, {id, entityType, entityId, actorId, body}) {
  const {error} = await supabaseAdmin.from('activity_events').upsert(
    {
      id,
      entity_type: entityType,
      entity_id: entityId,
      actor_profile_id: actorId,
      event_type: 'comment.posted',
      body,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error(`seedActivityEvent(${id}): ${error.message}`);
}

test.describe('Global Activity Log — record-page navigation', () => {
  test('row click navigates to the entity record page (no legacy modal)', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await seedOpenTask(supabaseAdmin, {
      id: 'tic-act-nav',
      title: 'Activity nav target task',
      assigneeId: adminId,
      createdById: adminId,
    });
    await seedActivityEvent(supabaseAdmin, {
      id: 'ae-act-nav',
      entityType: 'task.instance',
      entityId: 'tic-act-nav',
      actorId: adminId,
      body: 'Routing target comment.',
    });

    await page.goto('/activity');

    const row = page.locator('[data-activity-log-row="ae-act-nav"]');
    await expect(row).toBeVisible({timeout: 10_000});
    await expect(row).toHaveAttribute('data-activity-log-routable', '1');

    // /activity is read-only — no composer surface.
    await expect(page.locator('[data-activity-post-button="1"]')).toHaveCount(0);
    await expect(page.locator('[data-activity-modal="1"]')).toHaveCount(0);

    await row.click();

    // Navigated to the task's dedicated record page; no modal opened.
    await expect(page).toHaveURL(/\/tasks\/tic-act-nav$/, {timeout: 10_000});
    await expect(page.locator('[data-activity-modal="1"]')).toHaveCount(0);
  });
});

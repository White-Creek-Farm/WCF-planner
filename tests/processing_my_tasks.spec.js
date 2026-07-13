// ============================================================================
// REQUIRES supabase-migrations 175-177 applied to TEST — run only after the
// gated apply; run this file ALONE.
// ============================================================================
// My Tasks 'Processing work' section + processing_subtask_assigned
// notification — browser TEST proof (planner-integration lane, mig 175
// list_my_processing_subtasks + mig 177 notification type).
//
//   1. an open Processing subtask assigned to the signed-in admin surfaces as
//      a LINK-ONLY 'Processing work (1)' row on /tasks (no complete/assign/
//      due-date controls) and clicking it deep-links to the record's drawer;
//   2. a processing_subtask_assigned notification (linked to a
//      processing.record Activity event, exactly as _processing_notify_assignment
//      writes it) deep-links from the Header bell to /processing?record=<id>.
//
// Shared TEST DB: resetDb truncates shared tables — run this file ALONE.
import {test, expect} from './fixtures.js';

const REC_ID = 'ptest-mywork-1';
const SUB_ID = 'ptest-mywork-sub-1';
const REC_TITLE = 'TEST My Tasks Broilers';

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;

// The assignee must be THE signed-in admin (global.setup storageState), not
// just any admin profile row — resolve by the auth email and upsert the
// profile so list_my_processing_subtasks scopes to auth.uid().
async function signedInAdminProfileId(supabaseAdmin) {
  const r = await supabaseAdmin.auth.admin.listUsers();
  const u = r.data?.users?.find((x) => (x.email || '').toLowerCase() === (TEST_ADMIN_EMAIL || '').toLowerCase());
  if (!u) throw new Error('test admin user missing from auth.users');
  const {error} = await supabaseAdmin
    .from('profiles')
    .upsert({id: u.id, email: u.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  expect(error, error && error.message).toBeFalsy();
  return u.id;
}

// Pin the freshness stamp so /processing loads skip the planner reconcile —
// the seeds here are sweep-immune (asana_historical) and a reconcile is noise.
async function stampFreshnessNow(supabaseAdmin) {
  const {error} = await supabaseAdmin
    .from('processing_asana_sync_settings')
    .update({last_planner_reconcile_at: new Date().toISOString()})
    .eq('id', 'singleton');
  expect(error, error && error.message).toBeFalsy();
}

// Seed a processing record + one OPEN subtask assigned to the admin.
async function seedAssignedProcessingWork(supabaseAdmin, adminId) {
  const {error: recErr} = await supabaseAdmin.from('processing_records').upsert(
    {
      id: REC_ID,
      record_type: 'asana_historical',
      program: 'broiler',
      title: REC_TITLE,
      processing_date: '2026-08-20',
      status: 'planned',
      match_status: 'unmatched',
      created_by: adminId,
    },
    {onConflict: 'id'},
  );
  expect(recErr, recErr && recErr.message).toBeFalsy();
  const {error: subErr} = await supabaseAdmin.from('processing_subtasks').upsert(
    {
      id: SUB_ID,
      record_id: REC_ID,
      label: 'TEST assigned step',
      done: false,
      completed_at: null,
      sort_order: 1,
      assignee_profile_id: adminId,
      created_by: adminId,
    },
    {onConflict: 'id'},
  );
  expect(subErr, subErr && subErr.message).toBeFalsy();
}

test("My Tasks shows the link-only 'Processing work' section and opens the record drawer", async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await signedInAdminProfileId(supabaseAdmin);
  await seedAssignedProcessingWork(supabaseAdmin, adminId);
  await stampFreshnessNow(supabaseAdmin);

  await page.goto('/tasks');
  await page.waitForSelector('[data-tasks-my-loaded="true"]');

  const section = page.locator('[data-tasks-section="processing"]');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Processing work (1)');
  const row = section.locator(`[data-processing-work-row="${SUB_ID}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('TEST assigned step');
  await expect(row).toContainText(REC_TITLE);
  await expect(row.locator(`[data-processing-work-date]`)).toContainText('2026-08-20');

  // LINK-ONLY: none of the task_instances row controls render here, and the
  // rows never join the due-state buckets.
  for (const gone of [
    '[data-task-complete-button]',
    '[data-task-edit-due-button]',
    '[data-task-assign-button]',
    '[data-task-delete-button]',
    '[data-tasks-due-bucket]',
  ]) {
    await expect(section.locator(gone)).toHaveCount(0);
  }

  // Clicking the row deep-links to the record's drawer.
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/processing\\?record=${REC_ID}`), {timeout: 15_000});
  await page.waitForSelector('[data-processing-deeplink-ready="1"]');
  await expect(page.locator(`[data-processing-drawer="${REC_ID}"]`)).toBeVisible();
});

test('processing_subtask_assigned notification deep-links from the Header bell to the record drawer', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await signedInAdminProfileId(supabaseAdmin);
  await seedAssignedProcessingWork(supabaseAdmin, adminId);
  await stampFreshnessNow(supabaseAdmin);

  // The exact rows _processing_notify_assignment writes (mig 177): a
  // processing.record Activity event + a notification linking it, so
  // list_recent_notifications resolves activity_entity_type/id and
  // resolveNotificationRoute deep-links to /processing?record=<id>.
  const {error: aeErr} = await supabaseAdmin.from('activity_events').upsert(
    {
      id: 'ae-ptest-assign-1',
      entity_type: 'processing.record',
      entity_id: REC_ID,
      event_type: 'field.updated',
      actor_profile_id: null,
      body: 'Assigned processing work: TEST assigned step',
      payload: {action: 'assign_subtask', subtask_id: SUB_ID, assignee_profile_id: adminId},
    },
    {onConflict: 'id'},
  );
  expect(aeErr, aeErr && aeErr.message).toBeFalsy();
  const {error: ntfErr} = await supabaseAdmin.from('notifications').upsert(
    {
      id: 'ntf-ptest-assign-1',
      recipient_profile_id: adminId,
      actor_profile_id: null,
      type: 'processing_subtask_assigned',
      title: 'Processing work assigned',
      body: `TEST assigned step — ${REC_TITLE}`,
      activity_event_id: 'ae-ptest-assign-1',
      read_at: null,
    },
    {onConflict: 'id'},
  );
  expect(ntfErr, ntfErr && ntfErr.message).toBeFalsy();

  // Open the bell (mirrors tests/cattle_log_mention_deeplink.spec.js).
  await page.goto('/');
  await page.locator('[data-notifications-header-link="1"]').click();
  await expect(page.locator('[data-notifications-panel-loaded="1"]')).toBeVisible({timeout: 15_000});

  const notifRow = page.locator('[data-notifications-row="ntf-ptest-assign-1"]');
  await expect(notifRow).toBeVisible({timeout: 10_000});
  await expect(notifRow).toContainText('Processing work assigned');
  await expect(notifRow).toContainText('TEST assigned step');
  await notifRow.click();

  // Deep link: /processing?record=<id> with the drawer open.
  await expect(page).toHaveURL(new RegExp(`/processing\\?record=${REC_ID}`), {timeout: 15_000});
  await page.waitForSelector('[data-processing-deeplink-ready="1"]');
  await expect(page.locator(`[data-processing-drawer="${REC_ID}"]`)).toBeVisible();

  // The click marked it read.
  await expect
    .poll(async () => {
      const {data} = await supabaseAdmin
        .from('notifications')
        .select('read_at')
        .eq('id', 'ntf-ptest-assign-1')
        .single();
      return data && data.read_at != null;
    })
    .toBe(true);
});

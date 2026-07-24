// ============================================================================
// REQUIRES supabase-migrations 175-177 applied to TEST — run only after the
// gated apply; run this file ALONE.
// ============================================================================
// Task Center EXCLUDES Processing Center work (Build Queue item 5) +
// processing_subtask_assigned notification — browser TEST proof.
//
//   1. an open Processing subtask assigned to the signed-in admin does NOT
//      surface anywhere in the Task Center: /tasks renders no Processing work
//      section while an ordinary open task_instance for the same user still
//      shows (proves the My Tasks list itself is intact, not broken);
//   2. a processing_subtask_assigned notification (linked to a
//      processing.record Activity event, exactly as _processing_notify_assignment
//      writes it) still deep-links from the Header bell to /processing?record=,
//      so assigned processing work remains reachable from the Processing Center.
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

test('Task Center shows no Processing work section for an assigned processing subtask; ordinary tasks still render', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await signedInAdminProfileId(supabaseAdmin);
  // A processing subtask assigned to the signed-in admin — exactly the row the
  // retired 'Processing work' section used to surface in the Task Center.
  await seedAssignedProcessingWork(supabaseAdmin, adminId);
  // An ordinary open task_instance for the same admin so we can prove the My
  // Tasks list is intact (not simply broken/empty) with the section removed.
  const {error: tiErr} = await supabaseAdmin.from('task_instances').upsert(
    {
      id: 'ptest-ordinary-task-1',
      assignee_profile_id: adminId,
      due_date: '2026-08-20',
      title: 'TEST ordinary task',
      submission_source: 'admin_manual',
      status: 'open',
    },
    {onConflict: 'id'},
  );
  expect(tiErr, tiErr && tiErr.message).toBeFalsy();

  await page.goto('/tasks');
  await page.waitForSelector('[data-tasks-my-loaded="true"]');

  // The ordinary task_instance renders in the My Tasks list.
  await expect(page.locator('[data-task-row="ptest-ordinary-task-1"]')).toBeVisible();

  // Processing Center work is excluded: no section, and no processing-work row
  // anywhere on the page — even though an assigned subtask exists for the user.
  await expect(page.locator('[data-tasks-section="processing"]')).toHaveCount(0);
  await expect(page.locator('[data-processing-work-row]')).toHaveCount(0);
  await expect(page.locator(`[data-processing-work-row="${SUB_ID}"]`)).toHaveCount(0);
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

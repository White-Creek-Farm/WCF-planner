import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// task_completed notification — cross-user completion (migration 057)
// ============================================================================
// complete_task_instance inserts a 'task_completed' notification for the task
// CREATOR, but only when the completer is a DIFFERENT user. This locks that
// fragile cross-user signal (and the self-completion exclusion), which has had
// no e2e coverage.
//   1  Another user completes my task  -> exactly one notification for me
//   2  I complete my own task          -> no notification (self-exclusion)
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;
const MGMT_EMAIL = 'test-mgmt-notif@wcfplanner.test';
const MGMT_PASSWORD = 'NotifMgmt123!';

function newAnonClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
}
async function newAdminAuthedClient() {
  const sb = newAnonClient();
  const {error} = await sb.auth.signInWithPassword({email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD});
  if (error) throw new Error(`admin signIn failed: ${error.message}`);
  return sb;
}
async function ensureManagementUser(supabaseAdmin) {
  const existing = await supabaseAdmin.auth.admin.listUsers();
  let u = existing.data?.users?.find((x) => x.email === MGMT_EMAIL);
  if (!u) {
    const created = await supabaseAdmin.auth.admin.createUser({
      email: MGMT_EMAIL,
      password: MGMT_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error(`create mgmt: ${created.error.message}`);
    u = created.data?.user;
  }
  await supabaseAdmin
    .from('profiles')
    .upsert({id: u.id, email: MGMT_EMAIL, role: 'management', full_name: 'Notif Mgmt'}, {onConflict: 'id'});
  return u;
}
async function newManagementAuthedClient() {
  const sb = newAnonClient();
  const {error} = await sb.auth.signInWithPassword({email: MGMT_EMAIL, password: MGMT_PASSWORD});
  if (error) throw new Error(`mgmt signIn failed: ${error.message}`);
  return sb;
}
async function adminProfileId(supabaseAdmin) {
  const r = await supabaseAdmin.auth.admin.listUsers();
  const u = r.data?.users?.find((x) => (x.email || '').toLowerCase() === TEST_ADMIN_EMAIL.toLowerCase());
  if (!u) throw new Error('test admin user missing');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: u.id, email: u.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  return u.id;
}
// Seed an open task directly (lets us set created_by independent of completer).
// Deleting first cascades any prior notifications/photos for the id.
async function seedTask(supabaseAdmin, {id, creatorId, assigneeId, title}) {
  await supabaseAdmin.from('task_instances').delete().eq('id', id);
  const {error} = await supabaseAdmin.from('task_instances').insert({
    id,
    template_id: null,
    assignee_profile_id: assigneeId,
    due_date: '2026-12-31',
    title,
    description: 'notif e2e',
    submission_source: 'admin_manual',
    status: 'open',
    created_by_profile_id: creatorId,
    created_by_display_name: 'Test Admin',
  });
  if (error) throw new Error(`seed task: ${error.message}`);
  return id;
}

// --------------------------------------------------------------------------
// Test 1 — another user completing my task notifies me
// --------------------------------------------------------------------------
test('task_completed: another user completing my task notifies the creator', async ({supabaseAdmin}) => {
  const mgmt = await ensureManagementUser(supabaseAdmin);
  const adminId = await adminProfileId(supabaseAdmin);
  const id = 'ti-notif-cross';
  await seedTask(supabaseAdmin, {id, creatorId: adminId, assigneeId: mgmt.id, title: 'Notif cross-user task'});

  const mgmtSb = await newManagementAuthedClient();
  const done = await mgmtSb.rpc('complete_task_instance', {
    p_instance_id: id,
    p_completion_note: 'done by mgmt',
    p_completion_photo_paths: [],
  });
  expect(done.error).toBeNull();

  const {data: notifs} = await supabaseAdmin
    .from('notifications')
    .select('recipient_profile_id,actor_profile_id,type,task_instance_id,read_at')
    .eq('task_instance_id', id);
  expect(notifs).toHaveLength(1);
  expect(notifs[0]).toMatchObject({
    recipient_profile_id: adminId,
    actor_profile_id: mgmt.id,
    type: 'task_completed',
    task_instance_id: id,
  });
  expect(notifs[0].read_at).toBeNull();

  await supabaseAdmin.from('task_instances').delete().eq('id', id);
});

// --------------------------------------------------------------------------
// Test 2 — completing my own task does not notify me (self-exclusion)
// --------------------------------------------------------------------------
test('task_completed: completing my own task creates no notification', async ({supabaseAdmin}) => {
  const adminId = await adminProfileId(supabaseAdmin);
  const id = 'ti-notif-self';
  await seedTask(supabaseAdmin, {id, creatorId: adminId, assigneeId: adminId, title: 'Notif self task'});

  const adminSb = await newAdminAuthedClient();
  const done = await adminSb.rpc('complete_task_instance', {
    p_instance_id: id,
    p_completion_note: 'done by self',
    p_completion_photo_paths: [],
  });
  expect(done.error).toBeNull();

  const {data: notifs} = await supabaseAdmin.from('notifications').select('id').eq('task_instance_id', id);
  expect(notifs || []).toHaveLength(0);

  await supabaseAdmin.from('task_instances').delete().eq('id', id);
});

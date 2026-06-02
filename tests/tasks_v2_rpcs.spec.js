import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Tasks v2 — RPC contract verification (T1)
// ============================================================================
// Mig 053 ships six SECURITY DEFINER RPCs. This spec drives each through
// admin (signed-in via TEST credentials), anon (REVOKE check), and the
// service-role bypass path for generate_system_task_instance. Behavior
// under regular-user (non-admin) auth is verified through the existing
// admin-only happy paths plus the SECDEF function's own RAISE assertions
// (e.g., "regular-user edit limit reached") which fire identically
// regardless of who calls — admin paths exercise the alternate branch.
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

function newAnonClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
}

async function newAdminAuthedClient() {
  const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
  const {error} = await sb.auth.signInWithPassword({
    email: TEST_ADMIN_EMAIL,
    password: TEST_ADMIN_PASSWORD,
  });
  if (error) throw new Error(`signInWithPassword failed: ${error.message}`);
  return sb;
}

// Regular (non-admin) authenticated client. Reuses the Simon test profile
// created by apply_test_mig_052.cjs (role='farm_team', NOT admin). Password
// matches the placeholder set during apply.
const REGULAR_USER_EMAIL = 'simon.tasks@wcfplanner.test';
const REGULAR_USER_PASSWORD = 'apply_test_mig_052_placeholder_password';
async function newRegularAuthedClient() {
  const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
  const {error} = await sb.auth.signInWithPassword({
    email: REGULAR_USER_EMAIL,
    password: REGULAR_USER_PASSWORD,
  });
  if (error) throw new Error(`regular signInWithPassword failed: ${error.message}`);
  return sb;
}

async function regularUserId(supabaseAdmin) {
  const {data} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', 'Simon').limit(1);
  if (!data || data.length === 0) throw new Error('regular Simon profile not found');
  return data[0].id;
}

async function seedAdminProfile(supabaseAdmin) {
  const {data: u} = await supabaseAdmin.auth.admin.listUsers();
  const adminUser = (u && u.users ? u.users : []).find(
    (x) => (x.email || '').toLowerCase() === TEST_ADMIN_EMAIL.toLowerCase(),
  );
  if (!adminUser) throw new Error('admin auth user not found in TEST DB');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: adminUser.id, email: adminUser.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  return adminUser.id;
}

async function seedOpenTaskForAdmin(supabaseAdmin, adminId, overrides = {}) {
  const id = overrides.id || `ti-test-${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id,
    template_id: null,
    assignee_profile_id: adminId,
    due_date: overrides.due_date || '2026-06-01',
    title: overrides.title || 'Test task',
    description: overrides.description || 'Test description',
    submission_source: 'admin_manual',
    status: 'open',
    created_by_profile_id: adminId,
    created_by_display_name: 'Test Admin',
    ...overrides.extra,
  };
  await supabaseAdmin.from('task_instances').insert(row);
  return row;
}

// ── 1. Anon EXECUTE rejection ──────────────────────────────────────────────

test('anon cannot call any of the six new SECURITY DEFINER RPCs', async ({resetDb}) => {
  await resetDb();
  const anon = newAnonClient();
  const calls = [
    {name: 'complete_task_instance', args: {p_instance_id: 'x', p_completion_note: 'note'}},
    {
      name: 'create_one_time_task_instance',
      args: {
        p_instance: {
          id: 'x',
          client_submission_id: 'cs',
          title: 'T',
          description: 'D',
          due_date: '2026-06-01',
          assignee_profile_id: '00000000-0000-0000-0000-000000000000',
        },
      },
    },
    {name: 'update_task_instance_due_date', args: {p_instance_id: 'x', p_new_due_date: '2026-06-01'}},
    {
      name: 'assign_task_instance',
      args: {p_instance_id: 'x', p_assignee_profile_id: '00000000-0000-0000-0000-000000000000'},
    },
    {name: 'delete_task_instance', args: {p_instance_id: 'x'}},
    {
      name: 'generate_system_task_instance',
      args: {p_rule_id: 'broiler-4wk-weighin', p_due_date: '2026-06-01', p_source_event_key: 'k'},
    },
  ];
  for (const c of calls) {
    const {error} = await anon.rpc(c.name, c.args);
    // Anon EXECUTE was REVOKEd; PostgREST returns a permission error.
    expect(error, `anon call to ${c.name} should fail`).not.toBeNull();
    expect(error.message + ' ' + (error.code || '')).toMatch(/permission|denied|404|42501|PGRST/i);
  }
});

// ── 2. Transparency SELECT — any authenticated user sees all tasks ────────

test('authenticated user can SELECT every open task_instances row (transparency)', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-trans-1', title: 'Visible'});
  const sb = await newAdminAuthedClient();
  const {data, error} = await sb.from('task_instances').select('id,title,status').eq('id', 'ti-trans-1');
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  expect(data[0].title).toBe('Visible');
});

// ── 3. complete_task_instance v2 ──────────────────────────────────────────

test('complete_task_instance v2: requires non-empty completion_note', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-cv2-1'});
  const sb = await newAdminAuthedClient();
  const {error} = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-cv2-1',
    p_completion_note: '',
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/completion_note required/);
});

test('complete_task_instance v2: rejects > 5 completion photos', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-cv2-2'});
  const sb = await newAdminAuthedClient();
  const {error} = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-cv2-2',
    p_completion_note: 'note',
    p_completion_photo_paths: [
      'task-photos/' + adminId + '/ti-cv2-2/p1.jpg',
      'task-photos/' + adminId + '/ti-cv2-2/p2.jpg',
      'task-photos/' + adminId + '/ti-cv2-2/p3.jpg',
      'task-photos/' + adminId + '/ti-cv2-2/p4.jpg',
      'task-photos/' + adminId + '/ti-cv2-2/p5.jpg',
      'task-photos/' + adminId + '/ti-cv2-2/p6.jpg',
    ],
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/max 5 completion photos/);
});

test('complete_task_instance v2: happy path completes + writes sidecar rows + replays idempotently', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-cv2-3'});
  const sb = await newAdminAuthedClient();
  const photos = ['task-photos/' + adminId + '/ti-cv2-3/c1.jpg', 'task-photos/' + adminId + '/ti-cv2-3/c2.jpg'];
  const r1 = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-cv2-3',
    p_completion_note: 'all done',
    p_completion_photo_paths: photos,
  });
  expect(r1.error).toBeNull();
  expect(r1.data.ok).toBe(true);
  expect(r1.data.idempotent_replay).toBe(false);

  // Sidecar got two rows. The slot at sort_order=0 must show the actual
  // caller as uploaded_by_profile_id — not NULL — proving the v2 RPC
  // reclaimed the slot the AFTER trigger pre-occupied (Codex T1 reclaim).
  const {data: sidecarRows} = await supabaseAdmin
    .from('task_instance_photos')
    .select('storage_path,kind,sort_order,uploaded_by_profile_id')
    .eq('instance_id', 'ti-cv2-3')
    .eq('kind', 'completion')
    .order('sort_order');
  expect(sidecarRows).toHaveLength(2);
  expect(sidecarRows[0].storage_path).toBe(photos[0]);
  expect(sidecarRows[0].sort_order).toBe(0);
  expect(sidecarRows[0].uploaded_by_profile_id).toBe(adminId);
  expect(sidecarRows[1].storage_path).toBe(photos[1]);
  expect(sidecarRows[1].uploaded_by_profile_id).toBe(adminId);

  // Legacy single-path column got the first photo for back-compat.
  const {data: ti} = await supabaseAdmin
    .from('task_instances')
    .select('status,completion_note,completion_photo_path')
    .eq('id', 'ti-cv2-3')
    .single();
  expect(ti.status).toBe('completed');
  expect(ti.completion_note).toBe('all done');
  expect(ti.completion_photo_path).toBe(photos[0]);

  // Idempotent replay.
  const r2 = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-cv2-3',
    p_completion_note: 'replayed',
  });
  expect(r2.error).toBeNull();
  expect(r2.data.idempotent_replay).toBe(true);
});

// ── 4. create_one_time_task_instance ───────────────────────────────────────

test('create_one_time_task_instance: enforces title min 3 chars and required fields', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  const sb = await newAdminAuthedClient();
  const base = {
    id: 'ti-c1-1',
    client_submission_id: 'csid-c1-1',
    title: 'Hi',
    description: 'desc',
    due_date: '2026-06-01',
    assignee_profile_id: adminId,
  };
  const {error} = await sb.rpc('create_one_time_task_instance', {p_instance: base});
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/title required \(min 3 chars\)/);
});

test('create_one_time_task_instance: locks creator + writes creation photos to sidecar', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  const sb = await newAdminAuthedClient();
  const photos = ['task-request-photos/ti-c1-2/photo-1.jpg'];
  const r = await sb.rpc('create_one_time_task_instance', {
    p_instance: {
      id: 'ti-c1-2',
      client_submission_id: 'csid-c1-2',
      title: 'Real title',
      description: 'desc',
      due_date: '2026-06-01',
      assignee_profile_id: adminId,
    },
    p_creation_photo_paths: photos,
  });
  expect(r.error).toBeNull();
  expect(r.data.ok).toBe(true);
  expect(r.data.created_by_profile_id).toBe(adminId);
  expect(r.data.created_by_display_name).toBe('Test Admin');

  const {data: ti} = await supabaseAdmin
    .from('task_instances')
    .select('created_by_profile_id,created_by_display_name,request_photo_path')
    .eq('id', 'ti-c1-2')
    .single();
  expect(ti.created_by_profile_id).toBe(adminId);
  expect(ti.created_by_display_name).toBe('Test Admin');
  expect(ti.request_photo_path).toBe(photos[0]);

  // The single creation photo must land at sort_order=0 with the caller
  // as uploaded_by_profile_id — proving the v2 RPC reclaimed the slot
  // the AFTER trigger pre-occupied with NULL (Codex T1 reclaim).
  const {data: sidecar} = await supabaseAdmin
    .from('task_instance_photos')
    .select('storage_path,kind,sort_order,uploaded_by_profile_id')
    .eq('instance_id', 'ti-c1-2');
  expect(sidecar).toHaveLength(1);
  expect(sidecar[0].kind).toBe('creation');
  expect(sidecar[0].sort_order).toBe(0);
  expect(sidecar[0].storage_path).toBe(photos[0]);
  expect(sidecar[0].uploaded_by_profile_id).toBe(adminId);
});

// ── 5. update_task_instance_due_date — admin path (unlimited) ─────────────

test('update_task_instance_due_date: admin path bumps due_date without consuming the regular cap', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-u-1', due_date: '2026-06-01'});
  const sb = await newAdminAuthedClient();
  // Three admin edits — would exceed regular-user cap (2). All should
  // succeed and audit rows should be present.
  for (const newDate of ['2026-06-15', '2026-07-01', '2026-08-01']) {
    const {error} = await sb.rpc('update_task_instance_due_date', {
      p_instance_id: 'ti-u-1',
      p_new_due_date: newDate,
    });
    expect(error).toBeNull();
  }
  const {data: ti} = await supabaseAdmin
    .from('task_instances')
    .select('due_date,due_date_edit_count')
    .eq('id', 'ti-u-1')
    .single();
  expect(ti.due_date).toBe('2026-08-01');
  // Admin edits do NOT bump the regular-user counter.
  expect(ti.due_date_edit_count).toBe(0);

  const {data: audit} = await supabaseAdmin
    .from('task_instance_due_date_edits')
    .select('prior_due_date,new_due_date,edited_by_role')
    .eq('instance_id', 'ti-u-1')
    .order('edited_at');
  expect(audit).toHaveLength(3);
  expect(audit.every((r) => r.edited_by_role === 'admin')).toBe(true);
});

test('update_task_instance_due_date: completed tasks reject', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {
    id: 'ti-u-2',
    extra: {status: 'completed', completed_at: new Date().toISOString(), completion_note: 'x'},
  });
  const sb = await newAdminAuthedClient();
  const {error} = await sb.rpc('update_task_instance_due_date', {
    p_instance_id: 'ti-u-2',
    p_new_due_date: '2026-09-01',
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/completed tasks are read-only/);
});

// ── 6. assign_task_instance — admin only ──────────────────────────────────

test('assign_task_instance: admin can change assignee on an open task', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-a-1'});
  // Use the Mak profile created by apply_test_mig_052 as the new assignee.
  const {data: maks} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', 'Mak').limit(1);
  expect(maks).toHaveLength(1);
  const makId = maks[0].id;

  const sb = await newAdminAuthedClient();
  const {error, data} = await sb.rpc('assign_task_instance', {
    p_instance_id: 'ti-a-1',
    p_assignee_profile_id: makId,
  });
  expect(error).toBeNull();
  expect(data.assignee_profile_id).toBe(makId);

  const {data: ti} = await supabaseAdmin
    .from('task_instances')
    .select('assignee_profile_id')
    .eq('id', 'ti-a-1')
    .single();
  expect(ti.assignee_profile_id).toBe(makId);
});

// ── 7. delete_task_instance ───────────────────────────────────────────────

test('delete_task_instance: admin can delete open; rejects completed', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-d-open'});
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {
    id: 'ti-d-complete',
    extra: {status: 'completed', completed_at: new Date().toISOString(), completion_note: 'x'},
  });
  const sb = await newAdminAuthedClient();

  const r1 = await sb.rpc('delete_task_instance', {p_instance_id: 'ti-d-open'});
  expect(r1.error).toBeNull();
  expect(r1.data.ok).toBe(true);

  const {data: gone} = await supabaseAdmin.from('task_instances').select('id').eq('id', 'ti-d-open');
  expect(gone).toHaveLength(0);

  const r2 = await sb.rpc('delete_task_instance', {p_instance_id: 'ti-d-complete'});
  expect(r2.error).not.toBeNull();
  expect(r2.error.message).toMatch(/completed tasks cannot be deleted/);
});

// ── 8. generate_system_task_instance — service role + idempotency ────────

test('generate_system_task_instance: service-role caller + idempotent on (rule, due_date)', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await seedAdminProfile(supabaseAdmin);

  // Re-apply mig 052 to ensure system rules exist after the reset wiped them.
  // Lightweight: just upsert the rules directly via service role since
  // resetDb may have truncated task_system_rules.
  const {data: simons} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', 'Simon').limit(1);
  expect(simons).toHaveLength(1);
  const simonId = simons[0].id;
  await supabaseAdmin.from('task_system_rules').upsert(
    {
      id: 'broiler-4wk-weighin',
      name: 'Broiler 4-week weigh-in',
      description: 'desc',
      assignee_profile_id: simonId,
      generator_kind: 'broiler_4wk_weighin',
      lead_time_days: 3,
      active: true,
    },
    {onConflict: 'id'},
  );

  // Service role calls the RPC directly.
  const r1 = await supabaseAdmin.rpc('generate_system_task_instance', {
    p_rule_id: 'broiler-4wk-weighin',
    p_due_date: '2026-07-15',
    p_source_event_key: 'broiler-B-26-09',
  });
  expect(r1.error).toBeNull();
  expect(r1.data.ok).toBe(true);
  expect(r1.data.instance_id).toBe('tisys-broiler-4wk-weighin-broiler-B-26-09');

  // Idempotent on retry.
  const r2 = await supabaseAdmin.rpc('generate_system_task_instance', {
    p_rule_id: 'broiler-4wk-weighin',
    p_due_date: '2026-07-15',
    p_source_event_key: 'broiler-B-26-09',
  });
  expect(r2.error).toBeNull();

  // Confirm exactly one row exists.
  const {data: insts} = await supabaseAdmin
    .from('task_instances')
    .select('id,from_system_rule_id,due_date,designation')
    .eq('from_system_rule_id', 'broiler-4wk-weighin')
    .eq('due_date', '2026-07-15');
  expect(insts).toHaveLength(1);
  expect(insts[0].designation).toBe('system');
});

// ── 9. Same rule + same due_date + different event keys → two tasks (Codex #1)

test('generate_system_task_instance: same rule + same due_date with two event keys yields two tasks', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await seedAdminProfile(supabaseAdmin);
  const {data: simons} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', 'Simon').limit(1);
  const simonId = simons[0].id;
  await supabaseAdmin.from('task_system_rules').upsert(
    {
      id: 'broiler-4wk-weighin',
      name: 'Broiler 4-week weigh-in',
      description: 'desc',
      assignee_profile_id: simonId,
      generator_kind: 'broiler_4wk_weighin',
      lead_time_days: 3,
      active: true,
    },
    {onConflict: 'id'},
  );

  const r1 = await supabaseAdmin.rpc('generate_system_task_instance', {
    p_rule_id: 'broiler-4wk-weighin',
    p_due_date: '2026-09-01',
    p_source_event_key: 'broiler-B-26-09',
  });
  expect(r1.error).toBeNull();
  const r2 = await supabaseAdmin.rpc('generate_system_task_instance', {
    p_rule_id: 'broiler-4wk-weighin',
    p_due_date: '2026-09-01', // same date, different event
    p_source_event_key: 'broiler-B-26-10',
  });
  expect(r2.error).toBeNull();
  expect(r1.data.instance_id).not.toBe(r2.data.instance_id);

  const {data: rows} = await supabaseAdmin
    .from('task_instances')
    .select('id,from_system_source_event_key')
    .eq('from_system_rule_id', 'broiler-4wk-weighin')
    .eq('due_date', '2026-09-01');
  expect(rows).toHaveLength(2);
  const keys = rows.map((r) => r.from_system_source_event_key).sort();
  expect(keys).toEqual(['broiler-B-26-09', 'broiler-B-26-10']);
});

// ── 10. Regular-user RPC coverage (Codex #5) ──────────────────────────────

test("regular user can complete their own task; rejects completing someone else's", async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  const simonId = await regularUserId(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, simonId, {
    id: 'ti-reg-c-own',
    extra: {assignee_profile_id: simonId, created_by_profile_id: simonId},
  });
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {
    id: 'ti-reg-c-other',
    extra: {assignee_profile_id: adminId, created_by_profile_id: adminId},
  });

  const sb = await newRegularAuthedClient();
  const own = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-reg-c-own',
    p_completion_note: 'simon done',
  });
  expect(own.error).toBeNull();
  expect(own.data.ok).toBe(true);

  const other = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-reg-c-other',
    p_completion_note: 'should fail',
  });
  expect(other.error).not.toBeNull();
  expect(other.error.message).toMatch(/is not the assignee or admin/);
});

test('regular user: due-date edit own succeeds twice, third rejects (2-edit cap)', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedAdminProfile(supabaseAdmin);
  const simonId = await regularUserId(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, simonId, {
    id: 'ti-reg-due-1',
    due_date: '2026-09-01',
    extra: {assignee_profile_id: simonId, created_by_profile_id: simonId},
  });
  const sb = await newRegularAuthedClient();
  const r1 = await sb.rpc('update_task_instance_due_date', {
    p_instance_id: 'ti-reg-due-1',
    p_new_due_date: '2026-09-08',
  });
  expect(r1.error).toBeNull();
  const r2 = await sb.rpc('update_task_instance_due_date', {
    p_instance_id: 'ti-reg-due-1',
    p_new_due_date: '2026-09-15',
  });
  expect(r2.error).toBeNull();
  const r3 = await sb.rpc('update_task_instance_due_date', {
    p_instance_id: 'ti-reg-due-1',
    p_new_due_date: '2026-09-22',
  });
  expect(r3.error).not.toBeNull();
  expect(r3.error.message).toMatch(/regular-user edit limit reached \(2\/2\)/);
});

test('regular user cannot edit due_date on a task assigned to someone else', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await regularUserId(supabaseAdmin); // ensure simon profile exists
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {
    id: 'ti-reg-due-other',
    extra: {assignee_profile_id: adminId, created_by_profile_id: adminId},
  });
  const sb = await newRegularAuthedClient();
  const {error} = await sb.rpc('update_task_instance_due_date', {
    p_instance_id: 'ti-reg-due-other',
    p_new_due_date: '2026-10-01',
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/is not the assignee/);
});

test('regular user delete: self-created AND self-assigned succeeds', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedAdminProfile(supabaseAdmin);
  const simonId = await regularUserId(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, simonId, {
    id: 'ti-reg-del-own',
    extra: {assignee_profile_id: simonId, created_by_profile_id: simonId},
  });
  const sb = await newRegularAuthedClient();
  const r = await sb.rpc('delete_task_instance', {p_instance_id: 'ti-reg-del-own'});
  expect(r.error).toBeNull();
  expect(r.data.ok).toBe(true);
  const {data: gone} = await supabaseAdmin.from('task_instances').select('id').eq('id', 'ti-reg-del-own');
  expect(gone).toHaveLength(0);
});

test('regular user delete: self-created but assigned-to-other rejects (Codex #2)', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  const simonId = await regularUserId(supabaseAdmin);
  // Simon creates a task assigned to admin.
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {
    id: 'ti-reg-del-foreign',
    extra: {assignee_profile_id: adminId, created_by_profile_id: simonId},
  });
  const sb = await newRegularAuthedClient();
  const {error} = await sb.rpc('delete_task_instance', {p_instance_id: 'ti-reg-del-foreign'});
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/regular users can delete only open tasks they assigned to themselves/);
  const {data: stillThere} = await supabaseAdmin.from('task_instances').select('id').eq('id', 'ti-reg-del-foreign');
  expect(stillThere).toHaveLength(1);
});

// ── 11. complete_task_instance v2 auth-before-replay (Codex #3) ───────────

test('complete_task_instance v2: rejects non-assignee even on already-completed task (auth before replay)', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await regularUserId(supabaseAdmin);
  // Admin creates and completes a task assigned to admin.
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {
    id: 'ti-replay-other',
    extra: {
      status: 'completed',
      completed_at: new Date().toISOString(),
      completion_note: 'admin done',
      assignee_profile_id: adminId,
      created_by_profile_id: adminId,
    },
  });
  const sb = await newRegularAuthedClient();
  const {error} = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-replay-other',
    p_completion_note: 'simon should not see ok',
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/is not the assignee or admin/);
});

// ── 12. Photo path validation (Codex #4) ──────────────────────────────────

test('complete_task_instance v2: rejects photo path with wrong prefix', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-pp-1'});
  const sb = await newAdminAuthedClient();
  const {error} = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-pp-1',
    p_completion_note: 'note',
    p_completion_photo_paths: ['wrong-bucket/' + adminId + '/ti-pp-1/p.jpg'],
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/must start with task-photos\//);
});

test('complete_task_instance v2: rejects photo path with empty filename', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-pp-2'});
  const sb = await newAdminAuthedClient();
  const {error} = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-pp-2',
    p_completion_note: 'note',
    p_completion_photo_paths: ['task-photos/' + adminId + '/ti-pp-2/'],
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/empty filename/);
});

test('complete_task_instance v2: rejects photo path with slash in filename', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-pp-3'});
  const sb = await newAdminAuthedClient();
  const {error} = await sb.rpc('complete_task_instance', {
    p_instance_id: 'ti-pp-3',
    p_completion_note: 'note',
    p_completion_photo_paths: ['task-photos/' + adminId + '/ti-pp-3/sub/p.jpg'],
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/filename must not contain/);
});

test('create_one_time_task_instance: rejects creation photo path with wrong prefix', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  const sb = await newAdminAuthedClient();
  const {error} = await sb.rpc('create_one_time_task_instance', {
    p_instance: {
      id: 'ti-pp-4',
      client_submission_id: 'csid-pp-4',
      title: 'Real title',
      description: 'desc',
      due_date: '2026-06-01',
      assignee_profile_id: adminId,
    },
    p_creation_photo_paths: ['wrong-bucket/ti-pp-4/p.jpg'],
  });
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/must start with task-request-photos\//);
});

// ── 13. Triggers: legacy paths mirror to sidecar; recurring rows get flags

test('AFTER trigger: legacy request_photo_path INSERT mirrors into sidecar with NULL uploaded_by (Codex #8)', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  // Direct insert simulating submit_task_instance (which keeps its
  // signature unchanged). No explicit sidecar write.
  await supabaseAdmin.from('task_instances').insert({
    id: 'ti-trig-r',
    template_id: null,
    assignee_profile_id: adminId,
    due_date: '2026-09-01',
    title: 'Public submit lookalike',
    description: 'd',
    submission_source: 'public_webform',
    status: 'open',
    request_photo_path: 'task-request-photos/ti-trig-r/photo-1.jpg',
  });
  const {data: photos} = await supabaseAdmin
    .from('task_instance_photos')
    .select('kind,storage_path,sort_order,uploaded_by_profile_id')
    .eq('instance_id', 'ti-trig-r');
  expect(photos).toHaveLength(1);
  expect(photos[0].kind).toBe('creation');
  expect(photos[0].storage_path).toBe('task-request-photos/ti-trig-r/photo-1.jpg');
  expect(photos[0].sort_order).toBe(0);
  // Legacy/public path has no caller-id source — trigger leaves it NULL.
  // (The reclaim contract is: only v2 RPCs fill in uploaded_by.)
  expect(photos[0].uploaded_by_profile_id).toBeNull();
});

test('AFTER trigger: legacy completion_photo_path UPDATE mirrors into sidecar with NULL uploaded_by', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedOpenTaskForAdmin(supabaseAdmin, adminId, {id: 'ti-trig-c'});
  // Direct UPDATE simulating v1 complete_task_instance (mig 040), which
  // writes completion_photo_path on the existing row. The AFTER UPDATE
  // trigger should mirror it into the sidecar.
  const {error} = await supabaseAdmin
    .from('task_instances')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      completion_photo_path: 'task-photos/' + adminId + '/ti-trig-c/legacy.jpg',
    })
    .eq('id', 'ti-trig-c');
  expect(error).toBeNull();
  const {data: photos} = await supabaseAdmin
    .from('task_instance_photos')
    .select('kind,storage_path,sort_order,uploaded_by_profile_id')
    .eq('instance_id', 'ti-trig-c');
  expect(photos).toHaveLength(1);
  expect(photos[0].kind).toBe('completion');
  expect(photos[0].storage_path).toBe('task-photos/' + adminId + '/ti-trig-c/legacy.jpg');
  expect(photos[0].sort_order).toBe(0);
  expect(photos[0].uploaded_by_profile_id).toBeNull();
});

test('BEFORE trigger: row inserted with template_id auto-gets recurring designation (Codex #7)', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const adminId = await seedAdminProfile(supabaseAdmin);
  // Make a template the FK can resolve.
  await supabaseAdmin.from('task_templates').upsert(
    {
      id: 'tmpl-trig-1',
      title: 'T',
      description: 'd',
      assignee_profile_id: adminId,
      recurrence: 'weekly',
      recurrence_interval: 1,
      first_due_date: '2026-09-01',
      notes: '',
      active: true,
    },
    {onConflict: 'id'},
  );
  // Direct insert simulating generate_task_instances (which keeps its
  // signature unchanged). No explicit designation.
  await supabaseAdmin.from('task_instances').insert({
    id: 'ti-trig-rec',
    template_id: 'tmpl-trig-1',
    assignee_profile_id: adminId,
    due_date: '2026-09-15',
    title: 'T',
    description: 'd',
    submission_source: 'generated',
    status: 'open',
  });
  const {data} = await supabaseAdmin
    .from('task_instances')
    .select('from_recurring_template,designation')
    .eq('id', 'ti-trig-rec')
    .single();
  expect(data.from_recurring_template).toBe(true);
  expect(data.designation).toBe('recurring');
});

test('generate_system_task_instance: refuses inactive rules', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedAdminProfile(supabaseAdmin);
  const {data: simons} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', 'Simon').limit(1);
  expect(simons).toHaveLength(1);
  const simonId = simons[0].id;
  await supabaseAdmin.from('task_system_rules').upsert(
    {
      id: 'broiler-6wk-weighin',
      name: 'Broiler 6-week weigh-in',
      description: 'desc',
      assignee_profile_id: simonId,
      generator_kind: 'broiler_6wk_weighin',
      lead_time_days: 3,
      active: false,
    },
    {onConflict: 'id'},
  );
  const r = await supabaseAdmin.rpc('generate_system_task_instance', {
    p_rule_id: 'broiler-6wk-weighin',
    p_due_date: '2026-08-01',
    p_source_event_key: 'k',
  });
  expect(r.error).not.toBeNull();
  expect(r.error.message).toMatch(/is inactive/);
});

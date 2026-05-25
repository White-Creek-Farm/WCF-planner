// ============================================================================
// Cattle soft-delete scenario seed — for tests/cattle_soft_delete.spec.js
// ============================================================================
// Seeds a small cattle population for soft-delete / restore workflow testing:
//
//   - Active momma (M-DEL) — will be deleted and restored
//   - Active finisher (F-TAG-CONFLICT) — used for tag conflict on restore
//   - Sold cow (SOLD-DUP) — shares tag with M-DEL after reuse; tests that
//     sold/processed/deceased restore does not conflict with active tags
//   - Deceased cow (DEAD-RESTORE) — will be soft-deleted then restored without
//     tag conflict (outcome herd, same-tag reuse ok)
//   - A pre-existing cattle_comment on M-DEL to verify it survives delete
//   - A cattle_transfer on M-DEL to verify it survives delete
//
// All rows are active-herd unless noted. Tests will soft-delete via the RPC
// and verify UI behavior.
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';

function must(result, label) {
  if (result?.error) {
    throw new Error(`cattleSoftDeleteSeed [${label}]: ${result.error.message}`);
  }
  return result;
}

async function ensureAdminProfile(supabaseAdmin) {
  const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('cattleSoftDeleteSeed: VITE_TEST_ADMIN_EMAIL must be set in .env.test.local.');
  }
  const usersResult = await supabaseAdmin.auth.admin.listUsers();
  if (usersResult.error) {
    throw new Error(`cattleSoftDeleteSeed [auth.listUsers]: ${usersResult.error.message}`);
  }
  const adminUser = usersResult.data?.users?.find((u) => u.email === adminEmail);
  if (!adminUser) {
    throw new Error(
      `cattleSoftDeleteSeed: test admin user "${adminEmail}" missing from auth.users. ` +
        'Re-create via Supabase Auth dashboard.',
    );
  }
  must(
    await supabaseAdmin
      .from('profiles')
      .upsert({id: adminUser.id, email: adminUser.email, role: 'admin'}, {onConflict: 'id'}),
    'profiles upsert',
  );
  return {adminEmail, adminId: adminUser.id};
}

const COWS = [
  {
    id: 'sd-momma-del',
    tag: 'SD-100',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    birth_date: '2021-03-01',
    old_tags: [],
  },
  {
    id: 'sd-finisher-conflict',
    tag: 'SD-200',
    sex: 'steer',
    herd: 'finishers',
    breed: 'Hereford',
    birth_date: '2024-06-01',
    old_tags: [],
  },
  {
    id: 'sd-sold-dup',
    tag: 'SD-SOLD',
    sex: 'cow',
    herd: 'sold',
    sale_date: '2026-01-15',
    old_tags: [],
  },
  {
    id: 'sd-dead-restore',
    tag: 'SD-DEAD',
    sex: 'steer',
    herd: 'deceased',
    death_date: '2026-02-10',
    death_reason: 'test scenario',
    old_tags: [],
  },
];

export async function seedCattleSoftDelete(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const {adminId} = await ensureAdminProfile(supabaseAdmin);

  must(await supabaseAdmin.from('cattle').insert(COWS), 'cattle insert');

  must(
    await supabaseAdmin.from('cattle_comments').insert({
      id: 'sd-comment-1',
      cattle_id: 'sd-momma-del',
      cattle_tag: 'SD-100',
      comment: 'Test comment on SD-100',
      team_member: 'Test',
      source: 'manual',
    }),
    'cattle_comments insert',
  );

  must(
    await supabaseAdmin.from('cattle_transfers').insert({
      id: 'sd-transfer-1',
      cattle_id: 'sd-momma-del',
      from_herd: 'backgrounders',
      to_herd: 'mommas',
      reason: 'manual',
      team_member: 'Test',
    }),
    'cattle_transfers insert',
  );

  return {
    adminId,
    cowIds: COWS.map((c) => c.id),
    delCowId: 'sd-momma-del',
    delCowTag: 'SD-100',
    conflictCowId: 'sd-finisher-conflict',
    conflictCowTag: 'SD-200',
    soldCowId: 'sd-sold-dup',
    deadCowId: 'sd-dead-restore',
    deadCowTag: 'SD-DEAD',
  };
}

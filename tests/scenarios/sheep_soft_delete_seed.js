// ============================================================================
// Sheep soft-delete scenario seed — for tests/sheep_soft_delete.spec.js
// ============================================================================
// Mirrors tests/scenarios/cattle_soft_delete_seed.js for sheep.animal
// (migration 074). Seeds a small sheep population for soft-delete / restore
// workflow testing:
//
//   - Active ewe (SD-100) — deleted and restored
//   - Active feeder (SD-200) — stays active; the "still visible" control
//   - Sold sheep (SD-SOLD) — outside active-flock scope
//   - Deceased sheep (SD-DEAD) — soft-deleted then restored without tag
//     conflict (outcome flock, same-tag reuse ok)
//   - A sheep_comment + sheep_transfer on SD-100 to confirm soft-delete keeps
//     FK children that a hard delete would CASCADE away
//
// Active flocks are rams/ewes/feeders. Tests soft-delete via the RPC and
// verify UI + RLS behavior.
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';

function must(result, label) {
  if (result?.error) {
    throw new Error(`sheepSoftDeleteSeed [${label}]: ${result.error.message}`);
  }
  return result;
}

async function ensureAdminProfile(supabaseAdmin) {
  const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('sheepSoftDeleteSeed: VITE_TEST_ADMIN_EMAIL must be set in .env.test.local.');
  }
  const usersResult = await supabaseAdmin.auth.admin.listUsers();
  if (usersResult.error) {
    throw new Error(`sheepSoftDeleteSeed [auth.listUsers]: ${usersResult.error.message}`);
  }
  const adminUser = usersResult.data?.users?.find((u) => u.email === adminEmail);
  if (!adminUser) {
    throw new Error(
      `sheepSoftDeleteSeed: test admin user "${adminEmail}" missing from auth.users. ` +
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

const SHEEP = [
  {
    id: 'sd-ewe-del',
    tag: 'SD-100',
    sex: 'ewe',
    flock: 'ewes',
    breed: 'Katahdin',
    birth_date: '2021-03-01',
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'sd-feeder-keep',
    tag: 'SD-200',
    sex: 'wether',
    flock: 'feeders',
    breed: 'Dorper',
    birth_date: '2024-06-01',
    old_tags: [],
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'sd-sold-dup',
    tag: 'SD-SOLD',
    sex: 'ewe',
    flock: 'sold',
    sale_date: '2026-01-15',
    old_tags: [],
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'sd-dead-restore',
    tag: 'SD-DEAD',
    sex: 'wether',
    flock: 'deceased',
    death_date: '2026-02-10',
    death_reason: 'test scenario',
    old_tags: [],
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
];

export async function seedSheepSoftDelete(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const {adminId} = await ensureAdminProfile(supabaseAdmin);

  must(await supabaseAdmin.from('sheep').upsert(SHEEP, {onConflict: 'id'}), 'sheep insert');

  must(
    await supabaseAdmin.from('sheep_comments').upsert(
      {
        id: 'sd-sheep-comment-1',
        sheep_id: 'sd-ewe-del',
        sheep_tag: 'SD-100',
        comment: 'Test comment on SD-100',
        team_member: 'Test',
        source: 'manual',
      },
      {onConflict: 'id'},
    ),
    'sheep_comments insert',
  );

  must(
    await supabaseAdmin.from('sheep_transfers').upsert(
      {
        id: 'sd-sheep-transfer-1',
        sheep_id: 'sd-ewe-del',
        from_flock: 'feeders',
        to_flock: 'ewes',
        reason: 'manual',
        team_member: 'Test',
      },
      {onConflict: 'id'},
    ),
    'sheep_transfers insert',
  );

  return {
    adminId,
    sheepIds: SHEEP.map((s) => s.id),
    delSheepId: 'sd-ewe-del',
    delSheepTag: 'SD-100',
    keepSheepTag: 'SD-200',
    soldSheepId: 'sd-sold-dup',
    deadSheepId: 'sd-dead-restore',
    deadSheepTag: 'SD-DEAD',
  };
}

// ============================================================================
// Animal transfer scenario seed — for tests/animal_transfer.spec.js
// ============================================================================
// Seeds one active cattle.animal and one active sheep.animal for exercising
// the migration 075 transactional transfer RPCs (transfer_cattle_animal /
// transfer_sheep_animal).
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';

function must(result, label) {
  if (result?.error) throw new Error(`animalTransferSeed [${label}]: ${result.error.message}`);
  return result;
}

async function ensureAdminProfile(supabaseAdmin) {
  const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!adminEmail) throw new Error('animalTransferSeed: VITE_TEST_ADMIN_EMAIL must be set');
  const usersResult = await supabaseAdmin.auth.admin.listUsers();
  if (usersResult.error) throw new Error(`animalTransferSeed [listUsers]: ${usersResult.error.message}`);
  const adminUser = usersResult.data?.users?.find((u) => u.email === adminEmail);
  if (!adminUser) throw new Error(`animalTransferSeed: test admin "${adminEmail}" missing from auth.users`);
  must(
    await supabaseAdmin
      .from('profiles')
      .upsert({id: adminUser.id, email: adminUser.email, role: 'admin'}, {onConflict: 'id'}),
    'profiles upsert',
  );
  return {adminId: adminUser.id};
}

export async function seedAnimalTransfer(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const {adminId} = await ensureAdminProfile(supabaseAdmin);

  must(
    await supabaseAdmin.from('cattle').upsert(
      {
        id: 'xfer-cow',
        tag: 'XF-100',
        sex: 'cow',
        herd: 'mommas',
        old_tags: [],
        deleted_at: null,
        deleted_by: null,
        processing_batch_id: null,
      },
      {onConflict: 'id'},
    ),
    'cattle upsert',
  );

  must(
    await supabaseAdmin.from('sheep').upsert(
      {
        id: 'xfer-ewe',
        tag: 'XF-200',
        sex: 'ewe',
        flock: 'ewes',
        old_tags: [],
        deleted_at: null,
        deleted_by: null,
        processing_batch_id: null,
      },
      {onConflict: 'id'},
    ),
    'sheep upsert',
  );

  return {
    adminId,
    cowId: 'xfer-cow',
    cowTag: 'XF-100',
    eweId: 'xfer-ewe',
    eweTag: 'XF-200',
  };
}

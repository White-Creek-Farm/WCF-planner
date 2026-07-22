// ============================================================================
// Animal transfer scenario seed — for tests/animal_transfer.spec.js
// ============================================================================
// Seeds one active cattle.animal and one active sheep.animal for exercising
// the migration 075 transactional transfer RPCs (transfer_cattle_animal /
// transfer_sheep_animal).
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';
import {ensureTestAdminProfile} from '../setup/testAdminIdentity.js';

function must(result, label) {
  if (result?.error) throw new Error(`animalTransferSeed [${label}]: ${result.error.message}`);
  return result;
}

export async function seedAnimalTransfer(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');

  // Barrier 1 — profile (reference/independent).
  const {id: adminId} = await ensureTestAdminProfile(supabaseAdmin);

  // Barrier 2 — the two animal rows are in different tables with no FK between
  // them, so they upsert together.
  await Promise.all([
    supabaseAdmin
      .from('cattle')
      .upsert(
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
      )
      .then((r) => must(r, 'cattle upsert')),
    supabaseAdmin
      .from('sheep')
      .upsert(
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
      )
      .then((r) => must(r, 'sheep upsert')),
  ]);

  return {
    adminId,
    cowId: 'xfer-cow',
    cowTag: 'XF-100',
    eweId: 'xfer-ewe',
    eweTag: 'XF-200',
  };
}

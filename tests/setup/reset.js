import {createClient} from '@supabase/supabase-js';
import {assertTestDatabase} from './assertTestDatabase.js';

// ============================================================================
// Truncate test-owned tables. Called from per-spec beforeAll to reset state.
// ============================================================================
// HARD GUARDS (defense in depth):
//   1. assertTestDatabase() — refuses unless WCF_TEST_DATABASE=1 AND URL
//      doesn't match prod project ref.
//   2. Hardcoded TEST_OWNED_TABLES whitelist below — schema introspection
//      explicitly avoided. A new table cannot be truncated until added here.
//   3. Service role key required (not the anon key) — only set in
//      .env.test.local on a developer machine.
//
// TRUNCATE is executed via the public.exec_sql(text) function defined in the
// test project (see Phase A1 instructions). The function is SECURITY DEFINER
// + revoked from anon/authenticated/public so only service_role can call it.
// ============================================================================

const TEST_OWNED_TABLES = [
  // Children (FK to other test-owned tables) — truncate first via CASCADE.
  'cattle_comments',
  'cattle_calving_records',
  'cattle_feed_tests',
  'cattle_feed_inputs',
  'cattle_transfers',
  // Mig 043 forecast children — FK cattle(id) ON DELETE CASCADE. Truncate
  // BEFORE cattle so explicit row removal stays clean even if cascade is
  // deferred. Settings is a singleton — truncate then re-seed via the helper.
  'cattle_forecast_hidden',
  'cattle_forecast_heifer_includes',
  'cattle_forecast_settings',
  'sheep_lambing_records',
  'sheep_transfers',
  'weigh_ins',
  'weigh_in_sessions',
  'cattle_processing_batches',
  'sheep_processing_batches',
  'fuel_bill_lines',
  'fuel_bills',
  'equipment_maintenance_events',
  'equipment_fuelings',
  'fuel_supplies',
  // Mig 048 equipment materials sidecar tables — clears FK to materials,
  // both FK to equipment with CASCADE so child-first ordering is mostly
  // for readability. Truncating both wipes admin-edited materials AND any
  // operator-applied clears between specs.
  'equipment_material_clears',
  'equipment_service_materials',
  // Processing Calendar (mig 156). Children FK processing_records(id) CASCADE;
  // CASCADE on the TRUNCATE handles FK so child-first ordering is for readability.
  // processing_asana_sync_settings (singleton, seeded once at migration time) is
  // intentionally NOT truncated — wiping it would make get_processing_settings
  // return an empty object with no re-seed path.
  'processing_subtasks',
  'processing_attachments',
  'processing_templates',
  'processing_import_exceptions',
  'processing_asana_sync_runs',
  'processing_records',
  // Parents.
  'cattle',
  'sheep',
  'cattle_dailys',
  'sheep_dailys',
  'pig_dailys',
  'poultry_dailys',
  'layer_dailys',
  'egg_dailys',
  'layer_housings',
  'layer_batches',
  'equipment',
  'app_store',
  'webform_config',
  // Mig 095 generic saved views. FK owner_profile_id → profiles (NOT truncated),
  // so no ordering concern. Reset between specs so a saved view created by the
  // cattle-herd-filters spec doesn't leak into the next run's picker.
  'app_saved_views',
  // Mig 034 parent of Add Feed multi-row submissions. Children link via
  // daily_submission_id (no FK). Truncating after the 5 daily child tables
  // is a no-op for cascade purposes; ordering kept for readability.
  'daily_submissions',
  // Tasks v1 (migs 036-039). task_instances FK to task_templates (RESTRICT);
  // CASCADE on the TRUNCATE handles the FK so child-before-parent ordering
  // is just for readability. task_cron_runs has no FK.
  // notifications (mig 057): FK task_instance_id ON DELETE CASCADE, so
  // truncating task_instances already clears notification rows. Listed
  // explicitly so the table is recognized as test-owned and so a future
  // spec that seeds notifications directly (no parent task) still gets
  // a clean slate. Order: before task_instances would be redundant — keep
  // after for readability with the rest of the parents list.
  'notifications',
  // Mig 058 activity tables. activity_mentions FK → activity_events
  // ON DELETE CASCADE, so truncating activity_events first is sufficient;
  // listing both keeps the whitelist explicit so a future spec that
  // seeds mentions directly still gets a clean slate. Must reset between
  // specs — entity_id is a plain text reference (not an FK), so rows
  // posted against, e.g., 'tic-act-plain' in one spec survive a
  // task_instances TRUNCATE and would inflate the next spec's chip
  // counts (which proved to be a real cross-spec bleed).
  'activity_mentions',
  'activity_events',
  'task_instances',
  'task_cron_runs',
  'task_templates',
];
// NOT truncated:
//   profiles    — would orphan the test admin user; reseed manually if needed
//   auth.users  — never touched
//   storage.*   — buckets handled separately if/when a spec needs them

let cachedAdminClient = null;

export function getTestAdminClient() {
  if (cachedAdminClient) return cachedAdminClient;
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'getTestAdminClient: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY ' +
        'required in .env.test.local for test reset/seed operations.',
    );
  }
  assertTestDatabase(url);
  cachedAdminClient = createClient(url, key, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
  return cachedAdminClient;
}

// Storage cleanup. Codex A8a originally suggested
//   DELETE FROM storage.objects WHERE bucket_id = 'fuel-bills'
// via exec_sql, but Supabase blocks direct DELETE on storage tables —
// the API returns "Direct deletion from storage tables is not allowed.
// Use the Storage API instead." So we recurse through the bucket and
// .remove() the file paths via the Storage API.
//
// FAIL CLOSED: any list or remove error rejects the reset. A swept object that
// survives a reset is cross-test residue (a stale PDF/photo bleeds into the
// next test), so a partial cleanup must never report success. An empty bucket
// is the normal success path — only a real API error rejects. Error messages
// name the bucket + operation and carry only the API message (no credentials).
function storageCleanupError(bucket, op, error) {
  return new Error(`resetTestDatabase storage cleanup [${bucket} ${op}]: ${error?.message || error}`);
}

async function cleanupFuelBillsStorage(client) {
  const bucket = 'fuel-bills';
  const top = await client.storage.from(bucket).list();
  if (top.error) throw storageCleanupError(bucket, 'list', top.error);
  // Production layout is `fb-{id}/{filename}.pdf`. Recurse one level.
  for (const dir of top.data || []) {
    const inner = await client.storage.from(bucket).list(dir.name);
    if (inner.error) throw storageCleanupError(bucket, `list ${dir.name}`, inner.error);
    const files = inner.data || [];
    if (files.length) {
      const removed = await client.storage.from(bucket).remove(files.map((f) => `${dir.name}/${f.name}`));
      if (removed.error) throw storageCleanupError(bucket, 'remove', removed.error);
    }
  }
}

// daily-photos bucket cleanup. Layout is
// `<form_kind>/<client_submission_id>/<photo_key>.jpg` — two levels deep.
// Same Supabase-blocks-DELETE-on-storage.objects rule, same fail-closed rule.
async function cleanupDailyPhotosStorage(client) {
  const bucket = 'daily-photos';
  const top = await client.storage.from(bucket).list();
  if (top.error) throw storageCleanupError(bucket, 'list', top.error);
  for (const formKindDir of top.data || []) {
    const subs = await client.storage.from(bucket).list(formKindDir.name);
    if (subs.error) throw storageCleanupError(bucket, `list ${formKindDir.name}`, subs.error);
    for (const csidDir of subs.data || []) {
      const prefix = `${formKindDir.name}/${csidDir.name}`;
      const inner = await client.storage.from(bucket).list(prefix);
      if (inner.error) throw storageCleanupError(bucket, `list ${prefix}`, inner.error);
      const files = inner.data || [];
      if (files.length) {
        const removed = await client.storage.from(bucket).remove(files.map((f) => `${prefix}/${f.name}`));
        if (removed.error) throw storageCleanupError(bucket, 'remove', removed.error);
      }
    }
  }
}

export async function resetTestDatabase(client = getTestAdminClient()) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const tables = TEST_OWNED_TABLES.map((t) => `public."${t}"`).join(', ');
  // CONCURRENCY SAFETY (proven, not assumed):
  //   • The TRUNCATE names ONLY public.* tables (TEST_OWNED_TABLES above) and
  //     RESTART IDENTITY resets only sequences owned by those public tables.
  //   • TRUNCATE ... CASCADE follows only FKs that REFERENCE the truncated set.
  //     storage.objects has exactly one FK (bucket_id → storage.buckets) and no
  //     column referencing any public table, so CASCADE cannot reach it. This
  //     is a fixed Supabase platform invariant; user migrations cannot add an
  //     FK into storage.objects.
  //   • The two sweeps issue ZERO SQL against public.* — they call only the
  //     Storage API (list/remove on storage.objects).
  //   Write sets are therefore disjoint: {public tables + their public CASCADE
  //   closure} vs {storage.objects in two buckets}. No shared table, FK,
  //   sequence, or lock — so the three run concurrently.
  //
  // Promise.all (NOT allSettled): a rejection from ANY of the three members —
  // the TRUNCATE or either fail-closed Storage sweep — rejects the whole reset.
  // No member suppresses its own error, so a partial reset can never report
  // success and leave cross-test residue behind.
  const truncate = client
    .rpc('exec_sql', {sql: `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`})
    .then(({error}) => {
      if (error) throw new Error(`resetTestDatabase: TRUNCATE failed: ${error.message}`);
    });
  await Promise.all([truncate, cleanupFuelBillsStorage(client), cleanupDailyPhotosStorage(client)]);
}

export const _TEST_OWNED_TABLES = TEST_OWNED_TABLES;

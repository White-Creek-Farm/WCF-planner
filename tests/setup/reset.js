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
// .remove() the file paths via the Storage API. Best-effort (warns on
// failure rather than aborting reset) since storage cruft is harmless
// across runs and shouldn't block other tests on transient issues.
async function cleanupFuelBillsStorage(client) {
  try {
    const top = await client.storage.from('fuel-bills').list();
    if (top.error || !top.data?.length) return;
    // Production layout is `fb-{id}/{filename}.pdf`. Recurse one level.
    for (const dir of top.data) {
      const inner = await client.storage.from('fuel-bills').list(dir.name);
      if (inner.data?.length) {
        const paths = inner.data.map((f) => `${dir.name}/${f.name}`);
        await client.storage.from('fuel-bills').remove(paths);
      }
    }
  } catch (e) {
    console.warn(`cleanupFuelBillsStorage: ${e.message || e} (tolerating)`);
  }
}

// daily-photos bucket cleanup. Layout is
// `<form_kind>/<client_submission_id>/<photo_key>.jpg` — two levels deep.
// Same Supabase-blocks-DELETE-on-storage.objects rule as fuel-bills, so we
// recurse via the Storage API and .remove() the file paths.
async function cleanupDailyPhotosStorage(client) {
  try {
    const top = await client.storage.from('daily-photos').list();
    if (top.error || !top.data?.length) return;
    for (const formKindDir of top.data) {
      const subs = await client.storage.from('daily-photos').list(formKindDir.name);
      if (!subs.data?.length) continue;
      for (const csidDir of subs.data) {
        const inner = await client.storage.from('daily-photos').list(`${formKindDir.name}/${csidDir.name}`);
        if (inner.data?.length) {
          const paths = inner.data.map((f) => `${formKindDir.name}/${csidDir.name}/${f.name}`);
          await client.storage.from('daily-photos').remove(paths);
        }
      }
    }
  } catch (e) {
    console.warn(`cleanupDailyPhotosStorage: ${e.message || e} (tolerating)`);
  }
}

export async function resetTestDatabase() {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const client = getTestAdminClient();
  const tables = TEST_OWNED_TABLES.map((t) => `public."${t}"`).join(', ');
  const {error} = await client.rpc('exec_sql', {
    sql: `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`,
  });
  if (error) {
    throw new Error(`resetTestDatabase: TRUNCATE failed: ${error.message}`);
  }
  await cleanupFuelBillsStorage(client);
  await cleanupDailyPhotosStorage(client);
}

export const _TEST_OWNED_TABLES = TEST_OWNED_TABLES;

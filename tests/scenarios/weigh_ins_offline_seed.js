// Phase 1C-D scenario for the WeighIns RPC offline queue.
//
// Seeds the minimum webform_config + app_store entries WeighInsWebform reads
// when the operator picks pig or broiler:
//   - active_groups          : pig batches (filtered by component to skip SOWS/BOARS)
//   - broiler_groups         : broiler batch labels
//   - broiler_batch_meta     : public schooner mirror — Array<{name, schooners[]}>
//                              (the public form's column-label source)
//   - app_store/ppp-v4       : full broiler batch records (admin-side weigh-ins
//                              view still reads this; not consulted by the
//                              public form post-hotfix)
//
// Mirrors add_feed_offline_seed.js + pig_dailys_offline_seed.js shapes.

// The authenticated app re-derives active_groups on load
// (main.jsx syncWebformConfig: ['SOWS','BOARS', ...activePigFeederDailyTargets])
// and upserts it back to webform_config. Seed BOTH the canonical app_store
// feeder group (so the derivation contains P-26-01) AND a mirror value that is
// byte-identical to that derivation (so upsertWebformConfigIfChanged writes
// nothing mid-test). Without the canonical source, the app's own sync clobbered
// the mirror to just SOWS/BOARS — filtered out by the webform — and pig tests
// raced the sync for the batch option.
const PIG_GROUPS = ['SOWS', 'BOARS', 'P-26-01'];
const BROILER_GROUPS = ['B-26-01'];

// Minimal active feeder group whose single active sub-batch (pigs remaining)
// derives the daily/weigh-in target named P-26-01. Mirrors p2601_seed.js.
const PPP_FEEDERS = [
  {
    id: 'wof-p2601',
    batchName: 'P-26-01',
    cycleId: '',
    giltCount: 5,
    boarCount: 5,
    originalPigCount: 10,
    startDate: '2026-01-01',
    status: 'active',
    notes: '',
    perLbFeedCost: 0.3,
    legacyFeedLbs: 0,
    feedAllocatedToTransfers: 0,
    pigMortalities: [],
    processingTrips: [],
    subBatches: [
      {
        id: 'wof-p2601-sub',
        name: 'P-26-01',
        status: 'active',
        giltCount: 5,
        boarCount: 5,
        originalPigCount: 10,
        notes: '',
        legacyFeedLbs: 0,
      },
    ],
  },
];

// The grid renders one column per schooner, so we provide a 2-schooner record.
// Public form reads the parsed shape from broiler_batch_meta below; ppp-v4
// retains the raw '&'-joined string for admin parity.
const BROILER_BATCH_META = [{name: 'B-26-01', schooners: ['A', 'B']}];

const PPPV4 = [
  {
    name: 'B-26-01',
    schooner: 'A & B',
    breed: 'CC',
    hatchery: 'CREDO FARMS',
    status: 'active',
  },
];

export async function seedWeighInsOffline(supabaseAdmin) {
  const r1 = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'active_groups', data: PIG_GROUPS}, {onConflict: 'key'});
  if (r1.error) throw new Error(`seedWeighInsOffline: active_groups upsert failed: ${r1.error.message}`);

  const r2 = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'broiler_groups', data: BROILER_GROUPS}, {onConflict: 'key'});
  if (r2.error) throw new Error(`seedWeighInsOffline: broiler_groups upsert failed: ${r2.error.message}`);

  const rMeta = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'broiler_batch_meta', data: BROILER_BATCH_META}, {onConflict: 'key'});
  if (rMeta.error) throw new Error(`seedWeighInsOffline: broiler_batch_meta upsert failed: ${rMeta.error.message}`);

  // Broiler batch full record (admin-side weigh-ins view still reads ppp-v4).
  const r5 = await supabaseAdmin.from('app_store').upsert({key: 'ppp-v4', data: PPPV4}, {onConflict: 'key'});
  if (r5.error) throw new Error(`seedWeighInsOffline: ppp-v4 upsert failed: ${r5.error.message}`);

  // Canonical pig feeder source — keeps the app's own active_groups
  // re-derivation identical to the mirror seeded above.
  const r6 = await supabaseAdmin
    .from('app_store')
    .upsert({key: 'ppp-feeders-v1', data: PPP_FEEDERS}, {onConflict: 'key'});
  if (r6.error) throw new Error(`seedWeighInsOffline: ppp-feeders-v1 upsert failed: ${r6.error.message}`);

  return {
    pigGroups: PIG_GROUPS,
    broilerGroups: BROILER_GROUPS,
    broilerBatchMeta: BROILER_BATCH_META,
    pppv4: PPPV4,
    pppFeeders: PPP_FEEDERS,
  };
}

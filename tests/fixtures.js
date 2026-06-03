import {test as base} from '@playwright/test';
import {getTestAdminClient, resetTestDatabase} from './setup/reset.js';
import {seedP2601Scenario} from './scenarios/p2601_seed.js';
import {
  seedCattleSendToProcessor,
  seedCattleMultiCowPreAttached,
  seedCattlePreAttachedForFallback,
} from './scenarios/cattle_processor_seed.js';
import {
  seedSheepSendToProcessor,
  seedSheepBatchPreAttached,
  seedSheepPreAttachedForFallback,
} from './scenarios/sheep_processor_seed.js';
import {seedBroilerTimeline} from './scenarios/broiler_timeline_seed.js';
import {seedPigFCRScenario} from './scenarios/pig_fcr_seed.js';
import {seedFuelBillScenario} from './scenarios/fuel_bill_seed.js';
import {seedFuelReconcile} from './scenarios/fuel_reconcile_seed.js';
import {seedHomeDashboardEquipment, seedHomeDashboardEquipmentMix} from './scenarios/home_dashboard_equipment_seed.js';
import {seedFuelSupplyOffline} from './scenarios/fuel_supply_offline_seed.js';
import {seedAddFeedOffline} from './scenarios/add_feed_offline_seed.js';
import {seedPigDailysOffline} from './scenarios/pig_dailys_offline_seed.js';
import {seedWeighInsOffline} from './scenarios/weigh_ins_offline_seed.js';
import {seedPigDailysPhotosOffline} from './scenarios/pig_dailys_photos_offline_seed.js';
import {seedWebformHubDailysPhotosOffline} from './scenarios/webform_hub_dailys_photos_offline_seed.js';
import {seedBroilerWeighInSchooners} from './scenarios/broiler_weigh_in_schooners_seed.js';
import {seedAdminBroilerSessionMeta} from './scenarios/admin_broiler_session_meta_seed.js';
import {seedCattleHerdFilters} from './scenarios/cattle_herd_filters_seed.js';
import {seedCattleForecast, seedCattleForecastSendFlow} from './scenarios/cattle_forecast_seed.js';
import {seedCattleSoftDelete} from './scenarios/cattle_soft_delete_seed.js';
import {seedSheepSoftDelete} from './scenarios/sheep_soft_delete_seed.js';

// ============================================================================
// Per-spec fixtures: authenticated page (via global.setup storageState),
// test-side Supabase admin client (service_role), and a reset hook.
//
// Usage:
//   import { test, expect } from '../fixtures.js';
//
//   test.beforeAll(async ({ resetDb, supabaseAdmin }) => {
//     await resetDb();
//     await supabaseAdmin.from('app_store').insert({ key: 'k', data: {} });
//   });
//
//   test('something', async ({ page }) => { ... });
// ============================================================================

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- canonical Playwright fixture pattern
  supabaseAdmin: async ({}, use) => {
    await use(getTestAdminClient());
  },
  // eslint-disable-next-line no-empty-pattern -- canonical Playwright fixture pattern
  resetDb: async ({}, use) => {
    await use(async () => {
      await resetTestDatabase();
    });
  },
  // p2601Scenario — resets the test DB then seeds the P-26-01 pig batch
  // scenario fresh for the spec. beforeEach-style isolation per Codex's
  // A4 review (pick beforeEach reset + reseed; accumulating state would
  // make accounting regressions harder to interpret).
  p2601Scenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedP2601Scenario(supabaseAdmin);
    await use(ids);
  },
  // cattleSendToProcessorScenario — happy-path A5 setup (3 finishers + empty
  // planned batch + draft session + 3 flagged weigh-ins). Used by the tests
  // that exercise the full UI attach + the "no manual bypass" assertion.
  cattleSendToProcessorScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedCattleSendToProcessor(supabaseAdmin);
    await use(ids);
  },
  // cattleMultiCowPreAttachedScenario — 3 cows pre-attached with valid
  // prior_herd_or_flock + audit rows. Used by the multi-cow detach loop
  // tests (session-delete + batch-delete) so the iteration is actually
  // exercised — single-cow seeds would let those loops "pass" with N=1.
  cattleMultiCowPreAttachedScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedCattleMultiCowPreAttached(supabaseAdmin);
    await use(ids);
  },
  // cattlePreAttachedScenario — pre-attached state for the §7 detach fallback
  // hierarchy tests. Returns a factory because the same spec exercises three
  // modes (with_audit_row | null_from_herd | no_audit_row) and Playwright
  // fixtures don't natively parameterise; the factory lets each test pick
  // its mode after the reset.
  cattlePreAttachedScenario: async ({supabaseAdmin}, use) => {
    await use(async (mode) => {
      await resetTestDatabase();
      return seedCattlePreAttachedForFallback(supabaseAdmin, {mode});
    });
  },
  // sheepSendToProcessorScenario — happy-path A6 setup. Factory accepts an
  // optional `flock` so Test 9 (looser-gate regression) can reuse the same
  // shape with flock='rams' instead of the default 'feeders'.
  sheepSendToProcessorScenario: async ({supabaseAdmin}, use) => {
    await use(async ({flock = 'feeders'} = {}) => {
      await resetTestDatabase();
      return seedSheepSendToProcessor(supabaseAdmin, {flock});
    });
  },
  // sheepBatchPreAttachedScenario — 3 sheep pre-attached with valid
  // prior_herd_or_flock + audit rows. Used by the multi-row detach loop
  // tests (session-delete + batch-delete).
  sheepBatchPreAttachedScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedSheepBatchPreAttached(supabaseAdmin);
    await use(ids);
  },
  // sheepPreAttachedScenario — fallback-hierarchy state. Factory pattern
  // mirrors cattlePreAttachedScenario; modes: with_audit_row |
  // null_from_flock | no_audit_row.
  sheepPreAttachedScenario: async ({supabaseAdmin}, use) => {
    await use(async (mode) => {
      await resetTestDatabase();
      return seedSheepPreAttachedForFallback(supabaseAdmin, {mode});
    });
  },
  // broilerTimelineScenario — A7 range / auto-scroll / today-line setup.
  // Factory accepts { withActiveLayer, withRetirement } so Tests 1 and 2
  // share the seed but pick different layer compositions.
  broilerTimelineScenario: async ({supabaseAdmin}, use) => {
    await use(async (opts = {}) => {
      await resetTestDatabase();
      return seedBroilerTimeline(supabaseAdmin, opts);
    });
  },
  // pigFCRScenario — A9 fcrCached clear-on-null contract setup. Factory
  // accepts { withCredits, withCachedValue } so the three modes (populate,
  // clear-on-null, delete-trip-clear) reuse one seed shape.
  pigFCRScenario: async ({supabaseAdmin}, use) => {
    await use(async (opts = {}) => {
      await resetTestDatabase();
      return seedPigFCRScenario(supabaseAdmin, opts);
    });
  },
  // fuelBillScenario — A8a PDF parser end-to-end setup. Reset clears
  // fuel_bills + fuel_bill_lines + storage objects in the fuel-bills
  // bucket; seed ensures the admin profile exists. The PDF file itself
  // is checked in at tests/fixtures/ODBIN-0195942_2.PDF.
  fuelBillScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedFuelBillScenario(supabaseAdmin);
    await use(ids);
  },
  // fuelReconcileScenario — A8b banding + cell-exclusion setup. Factory
  // accepts { band, fuelType?, includeCellRow? } so the four tests reuse
  // one seed shape; each picks its own band / cell-row mode.
  fuelReconcileScenario: async ({supabaseAdmin}, use) => {
    await use(async (opts = {}) => {
      await resetTestDatabase();
      return seedFuelReconcile(supabaseAdmin, opts);
    });
  },
  // homeDashboardEquipmentScenario — A1 follow-up (HomeDashboard equipment
  // attention regression coverage). Factory accepts { kind: 'overdue' |
  // 'upcoming' | 'missed_fueling' | 'fillup_streak' | 'warranty' } and
  // seeds exactly one piece of equipment positioned to trigger that kind.
  homeDashboardEquipmentScenario: async ({supabaseAdmin}, use) => {
    await use(async (opts = {}) => {
      await resetTestDatabase();
      return seedHomeDashboardEquipment(supabaseAdmin, opts);
    });
  },
  // homeDashboardEquipmentMixScenario — sort-order coverage. Seeds three
  // distinct pieces (overdue + fillup_streak + warranty) so the spec can
  // assert HomeDashboard renders them in the documented KIND_ORDER. Sibling
  // to the kind-keyed scenario above; existing 5 single-kind tests are
  // unaffected.
  homeDashboardEquipmentMixScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedHomeDashboardEquipmentMix(supabaseAdmin);
    await use(ids);
  },
  // fuelSupplyOfflineScenario — Phase 1B canary setup. Resets DB +
  // seeds the webform_config team_members the FuelSupplyWebform needs
  // to render a usable dropdown. Each test inside the canary spec
  // wipes the browser-side IndexedDB queue separately via
  // wipeOfflineQueue() so queued rows don't bleed across tests.
  fuelSupplyOfflineScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedFuelSupplyOffline(supabaseAdmin);
    await use(ids);
  },
  // addFeedOfflineScenario — Phase 1C-A parent-aware RPC queue setup.
  // Resets DB + seeds broiler_groups + allowAddGroup so the public
  // /addfeed form can drive a 2-batch broiler submission. Each test
  // wipes the browser-side IndexedDB queue separately.
  addFeedOfflineScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedAddFeedOffline(supabaseAdmin);
    await use(ids);
  },
  // pigDailysOfflineScenario — Phase 1C-B no-photo flat queue setup.
  // Resets DB + seeds active_groups + roster so /webform's PigDailys
  // form has a usable Pig group dropdown + Team member dropdown.
  pigDailysOfflineScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedPigDailysOffline(supabaseAdmin);
    await use(ids);
  },
  // weighInsOfflineScenario — Phase 1C-D RPC queue setup. Resets DB + seeds
  // active_groups + broiler_groups + ppp-v4 + roster so /weighins can drive
  // both pig and broiler fresh-session flows offline + online.
  weighInsOfflineScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedWeighInsOffline(supabaseAdmin);
    await use(ids);
  },
  // pigDailysPhotosOfflineScenario — Phase 1D-A photo queue setup.
  // Resets DB + seeds active_groups + roster so /webform PigDailys form
  // can drive both photo and no-photo paths through the hook.
  pigDailysPhotosOfflineScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedPigDailysPhotosOffline(supabaseAdmin);
    await use(ids);
  },
  // webformHubDailysPhotosOfflineScenario — Phase 1D-B photo queue setup
  // for the WebformHub broiler/pig/cattle/sheep paths. Seeds team_roster
  // + broiler_groups + active_groups + cattle_feed_inputs so all 4
  // in-scope forms render submit-able. Layer + egg negative-lock tests
  // share this fixture (egg has no extra reqs; layer's negative-lock
  // doesn't actually submit so its lack of layer_groups doesn't matter).
  webformHubDailysPhotosOfflineScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedWebformHubDailysPhotosOffline(supabaseAdmin);
    await use(ids);
  },
  // broilerWeighInSchoonersScenario — public broiler weigh-in schooner mapping
  // hotfix setup. Seeds 3 broiler batches in webform_config (two-schooner,
  // one-schooner, zero-schooner) plus matching ppp-v4 rows for the admin
  // hydration assertion. The public form is independent of app_store; the
  // spec proves that with a network-route lock + the static lock vitest
  // (tests/static/weighinswebform_no_app_store.test.js).
  broilerWeighInSchoonersScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedBroilerWeighInSchooners(supabaseAdmin);
    await use(ids);
  },
  // adminBroilerSessionMetaScenario — admin broiler session metadata edit
  // (WK + team_member). One active broiler batch with pre-stamped wk4Lbs,
  // a draft + a complete broiler session for it, and the standard
  // BMAN/JANE roster. Tests that need legacy / second-complete-session
  // shapes layer additional rows via supabaseAdmin inside the test body.
  adminBroilerSessionMetaScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedAdminBroilerSessionMeta(supabaseAdmin);
    await use(ids);
  },
  // cattleHerdFiltersScenario — composable filter / sort + smart-input
  // setup. Seeds 11 cattle covering 4 active herds, mixed sexes, varied
  // calving status, blacklist, weight tiers (fresh/stale/none), one
  // historical breed (Heritage Wagyu) absent from cattle_breeds.
  cattleHerdFiltersScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedCattleHerdFilters(supabaseAdmin);
    await use(ids);
  },
  // cattleForecastScenario — base seed for the Cattle Forecast tab spec.
  // Includes finishers / momma cohorts / processed / backgrounder, full
  // cattle row shape (DOB, sex, herd, breed, origin, old_tags), and a set
  // of weigh-ins anchored to the spec's notional "today" so the rolling
  // 3-week ADG ladder and DOB+birth-weight fallback both exercise.
  cattleForecastScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedCattleForecast(supabaseAdmin);
    await use(ids);
  },
  // cattleForecastSendFlowScenario — base seed plus a draft cattle session
  // with three send_to_processor=true flagged entries (F1 + F-AT-MAX +
  // F-HIDE). Used by the Send-to-Processor name-match + gate-block tests.
  cattleForecastSendFlowScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedCattleForecastSendFlow(supabaseAdmin);
    await use(ids);
  },
  // cattleSoftDeleteScenario — seeds cattle for soft-delete/restore workflow
  // testing: active cow to delete, tag-conflict cow, sold/deceased for
  // outcome-herd restore, plus child records (comment, transfer).
  cattleSoftDeleteScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedCattleSoftDelete(supabaseAdmin);
    await use(ids);
  },
  // sheepSoftDeleteScenario — sheep.animal parity (migration 074): active ewe
  // to delete, "stays visible" feeder control, sold/deceased for outcome-flock
  // restore, plus child records (sheep_comment, sheep_transfer).
  sheepSoftDeleteScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedSheepSoftDelete(supabaseAdmin);
    await use(ids);
  },
});

export {expect} from '@playwright/test';

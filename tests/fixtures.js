import {test as base} from '@playwright/test';
import {getTestAdminClient, resetTestDatabase} from './setup/reset.js';
import {waitForAppReady} from './helpers/appReady.js';
import {LOCAL_APP_ORIGIN, WARMUP_PROBE_DB, assertLocalTestOrigin} from './setup/warmup.js';
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
import {seedAnimalTransfer} from './scenarios/animal_transfer_seed.js';

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

// Treat localhost and 127.0.0.1 as the same app origin — baseURL is
// http://localhost:5173 while dev:test binds 127.0.0.1, and specs use both.
function appOriginKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname === '127.0.0.1' ? 'localhost' : url.hostname;
    return `${host}:${url.port}`;
  } catch {
    return null; // about:blank, data:, chrome-error:, malformed
  }
}

export const test = base.extend({
  // ==========================================================================
  // Cold-start warm-up — worker-scoped, automatic, once per worker.
  // ==========================================================================
  // CI telemetry (run 29954947453, 4 vCPU) showed the early cold-start window
  // (Vite first-compile + browser IDB init) starving tests near the top of a
  // shard. This pays that one-time cost UP FRONT, once per worker, on a
  // throwaway context — so the real tests start against a warm module graph.
  //
  // The app has NO route code-splitting (the only dynamic import in the whole
  // app is import('xlsx')); every view is a static import of main.jsx. So one
  // logged-out navigation to '/' transforms the ENTIRE module graph — the
  // weigh-in, Task Center, and offline-queue modules included — with no auth
  // and no per-route visits needed.
  //
  // Contract: separate 60s fixture timeout (the ordinary test budget stays
  // 30s); uses the worker's own browser; creates and always closes a temporary
  // context; logged out; read-only (no reset/seed/insert/update/upload/delete,
  // no real-user auth, no queue-record mutation); fails VISIBLY (no swallow,
  // retry, reload, or sleep). Pasture is out of scope — it runs on its own
  // config and does not import this fixture module.
  _coldStartWarmUp: [
    async ({browser}, use) => {
      // Worker-scoped: cannot use the test-scoped `baseURL` fixture, so read the
      // config-mirrored constant and validate it is a local TEST origin.
      const origin = assertLocalTestOrigin(LOCAL_APP_ORIGIN);
      const context = await browser.newContext(); // logged out — no storageState
      try {
        const page = await context.newPage();
        // Prime the Vite module graph. Logged out, '/' renders LoginScreen; its
        // marker appearing proves main.jsx and its static import graph compiled.
        await page.goto(new URL('/', origin).href, {waitUntil: 'domcontentloaded'});
        await page.locator('[data-login-screen]').waitFor({state: 'visible', timeout: 45_000});
        // Warm the browser IndexedDB code path with a throwaway DB — never the
        // real offline-queue DB, and no records written.
        await page.evaluate(
          (dbName) =>
            new Promise((resolve, reject) => {
              let req;
              try {
                req = indexedDB.open(dbName);
              } catch (err) {
                reject(err);
                return;
              }
              req.onsuccess = () => {
                try {
                  req.result.close();
                } catch {
                  /* already closing */
                }
                resolve();
              };
              req.onerror = () => reject(new Error('warm-up IndexedDB open failed'));
              req.onblocked = () => resolve();
            }),
          WARMUP_PROBE_DB,
        );
      } finally {
        await context.close();
      }
      await use();
    },
    {scope: 'worker', auto: true, timeout: 60_000},
  ],

  // ==========================================================================
  // Navigation readiness (see tests/helpers/appReady.js for the mechanism).
  // ==========================================================================
  // Specs raced the fail-closed cold-boot gate: page.goto() resolves as soon as
  // the document loads, but the app then renders "Loading your farm data..."
  // until loadAllData settles. Any assertion made in that window fails with
  // "element(s) not found" on whatever surface marker it wanted. Under CI load
  // the window outlived the 5s default expect budget, so the failing spec name
  // rotated run to run while the mechanism stayed constant.
  //
  // Requiring every spec to remember a readiness call does not scale — the two
  // specs that failed in run 29840170206 had no readiness gate at all and never
  // referenced the boot splash, so no lint-style prohibition could have caught
  // them. Readiness is therefore part of navigation itself, in one place.
  //
  // Scope and limits:
  //   • Applies to page.goto() on the standard `page` fixture only.
  //   • Keyed on page.url() AFTER navigation, so in-app redirects are covered.
  //   • Skips non-app origins (external URLs, about:blank, data:).
  //   • Returns the original Response and never swallows a navigation error.
  //   • Fails closed: a boot that never completes raises, it is not retried,
  //     reloaded, slept through, or downgraded to a warning.
  //   • NOT covered: popups (page.waitForEvent('popup')), pages from a manually
  //     created context/browser, page.goBack/goForward/reload, and history
  //     navigation driven by in-app clicks. Those still need an explicit
  //     waitForAppReady() call, which is why the helper stays exported.
  wcfAutoReady: [true, {option: true}],
  wcfAutoReadyReason: ['', {option: true}],

  page: async ({page, baseURL, wcfAutoReady, wcfAutoReadyReason}, use) => {
    if (!wcfAutoReady && !String(wcfAutoReadyReason).trim()) {
      throw new Error(
        'wcfAutoReady:false requires a non-empty wcfAutoReadyReason. Declare both together, e.g.\n' +
          "  test.use({wcfAutoReady: false, wcfAutoReadyReason: 'asserts the pre-ready loading state'});",
      );
    }
    const appOrigin = appOriginKey(baseURL || 'http://localhost:5173');
    const nativeGoto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const response = await nativeGoto(url, options);
      if (wcfAutoReady && appOriginKey(page.url()) === appOrigin) {
        await waitForAppReady(page);
      }
      return response;
    };
    await use(page);
  },

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
  // for the WebformHub broiler/pig/cattle/sheep paths. Seeds
  // broiler_groups + active_groups + webform_settings + cattle_feed_inputs
  // so all 4 in-scope forms render submit-able. Layer + egg negative-lock tests
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
  // setup. Seeds active + outcome cattle covering mixed sexes, varied calving
  // status, blacklist, weight tiers (fresh/stale/none), one historical breed
  // (Heritage Wagyu) absent from cattle_breeds.
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
  // animalTransferScenario — one active cow + one active ewe for the
  // migration 075 transactional transfer RPCs.
  animalTransferScenario: async ({supabaseAdmin}, use) => {
    await resetTestDatabase();
    const ids = await seedAnimalTransfer(supabaseAdmin);
    await use(ids);
  },
});

export {expect} from '@playwright/test';

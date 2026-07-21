import {expect} from '@playwright/test';

// ============================================================================
// Shared cold-boot readiness signal.
// ============================================================================
// There are TWO distinct boot signals and they are NOT interchangeable:
//
//   1. #wcf-boot-loader — the static HTML splash in index.html. src/main.jsx
//      removes it two animation frames after React's FIRST PAINT. That paint
//      is frequently the fail-closed data gate itself, so the splash can be
//      gone while the app still has no farm data.
//
//   2. [data-farm-data-loading] — the React cold-boot gate rendered while
//      `dataLoaded` is false (src/main.jsx, "Loading your farm data..."). This
//      is the signal that actually means "farm data has resolved".
//
// Specs that waited only on (1) and then asserted data-dependent DOM were
// racing the farm-data fetch: under a loaded CI runner the fetch outlived the
// 5s default expect budget and the assertion failed on the boot gate. That is
// the mechanism behind the rotating root-shard failures (whichever spec
// happened to be running during a slow window lost, so the failing spec name
// changed run to run while the failure count stayed flat).
//
// Waiting for both is safe on every route: on public / login-gated surfaces the
// React gate never mounts, so `toHaveCount(0)` resolves immediately rather than
// adding latency.
//
// This is a readiness signal, not a retry or a timeout bump — it waits for a
// state the app already publishes, and still fails closed if that state never
// arrives.
export async function waitForAppReady(page, {timeout = 15_000} = {}) {
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout});
  await expect(page.locator('[data-farm-data-loading]')).toHaveCount(0, {timeout});
}

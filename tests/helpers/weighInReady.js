import {expect} from '@playwright/test';

// Weigh-in readiness waiters — block until the weigh-in list view or session
// record page has actually finished its async load, instead of racing
// per-assertion timeouts against a cold Vite compile + the app's farm-data
// load. Modeled on layerReady.js / pigReady.js; see those for the rationale.
//
//   data-weighin-list-loaded="true"            — a weigh-in list view resolved its session query
//   data-weighin-session-record-loaded="true"  — the session record page resolved past loading/not-found

export async function waitForWeighInListLoaded(page, timeout = 30_000) {
  await expect(page.locator('[data-weighin-list-loaded="true"]')).toBeVisible({timeout});
}

export async function waitForWeighInSessionLoaded(page, timeout = 30_000) {
  await expect(page.locator('[data-weighin-session-record-loaded="true"]')).toBeVisible({timeout});
}

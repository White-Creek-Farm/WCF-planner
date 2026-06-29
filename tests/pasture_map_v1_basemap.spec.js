// Pasture Map — V1 reset: basemap switcher (satellite / topo) inside the Layers
// popover + offline imagery status (public-domain NAIP). The download itself is
// network-dependent and fails closed; this validates the switcher + the status/
// download UI. (Hybrid was removed — it read identically to Satellite.)
import {test, expect} from '@playwright/test';

test('basemap switcher (satellite/topo) + offline imagery status in Field', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // The base map lives inside the right-rail Layers popover now — open it first.
  await page.locator('[data-pasture-layers-toggle]').click();
  await expect(page.locator('[data-pasture-basemap]')).toBeVisible();
  await expect(page.locator('[data-pasture-basemap-option="satellite"]')).toHaveClass(/is-active/);
  await page.locator('[data-pasture-basemap-option="topo"]').click();
  await expect(page.locator('[data-pasture-basemap-option="topo"]')).toHaveClass(/is-active/);
  // Hybrid was removed; only satellite + topo remain.
  await expect(page.locator('[data-pasture-basemap-option="hybrid"]')).toHaveCount(0);

  // Offline imagery status + download live in the Field "Offline setup" affordance
  // (a secondary control, not a peer of Walk/Draw/Measure). Warns when missing.
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-offline-setup-toggle]').click();
  await expect(page.locator('[data-pasture-offline-imagery]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-pasture-imagery-state]')).toHaveAttribute('data-pasture-imagery-state', 'missing');
  await expect(page.locator('[data-pasture-imagery-download]')).toBeVisible();
});

// Pasture Map — V1 reset: basemap switcher (satellite / topo / hybrid) + offline
// imagery status (public-domain NAIP). The download itself is network-dependent
// and fails closed; this validates the switcher + the status/download UI.
import {test, expect} from '@playwright/test';

test('basemap switcher (satellite/topo/hybrid) + offline imagery status in Field', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Basemap switcher: satellite is the default; switching activates the option.
  await expect(page.locator('[data-pasture-basemap]')).toBeVisible();
  await expect(page.locator('[data-pasture-basemap-option="satellite"]')).toHaveClass(/is-active/);
  await page.locator('[data-pasture-basemap-option="topo"]').click();
  await expect(page.locator('[data-pasture-basemap-option="topo"]')).toHaveClass(/is-active/);
  await page.locator('[data-pasture-basemap-option="hybrid"]').click();
  await expect(page.locator('[data-pasture-basemap-option="hybrid"]')).toHaveClass(/is-active/);

  // Offline imagery status + download live in Field > Layers (warns when missing).
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-layers]').click();
  await expect(page.locator('[data-pasture-offline-imagery]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-pasture-imagery-state]')).toHaveAttribute('data-pasture-imagery-state', 'missing');
  await expect(page.locator('[data-pasture-imagery-download]')).toBeVisible();
});

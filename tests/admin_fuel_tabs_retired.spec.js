import {test, expect} from './fixtures.js';

// ============================================================================
// Admin tab row — retired fuel reporting tabs stay hidden (browser contract).
// ============================================================================
// Commit 5bae452 removed the Admin `Fuel Log` and `Cost by Month` tab buttons
// from src/webforms/WebformsAdminView.jsx (an approved product-contract change;
// the dormant panels + data are retained under PROJECT.md Build Queue item 6).
//
// The two Playwright specs that drove those now-unreachable surfaces
// (fuel_bill_pdf, fuel_reconcile) were retired from collected coverage; this
// spec replaces them with a contract-ACCURATE browser proof: an authenticated
// admin sees the approved admin tabs but NOT the retired fuel reporting tabs.
// The source-level guard lives in tests/static/client_errors_review_static.js;
// this is the rendered-UI counterpart.
// ============================================================================

test.describe('Admin tab row — retired fuel reporting tabs', () => {
  test('authenticated admin does not see Fuel Log or Cost by Month', async ({page}) => {
    await page.goto('/admin');

    // Anchor: an approved admin tab renders, proving the tab row mounted (so a
    // count of 0 below means "hidden", not "page failed to load"). Client Errors
    // is the last approved tab in the row.
    await expect(page.getByRole('button', {name: 'Client Errors'})).toBeVisible({timeout: 30_000});

    // Contract: the retired fuel reporting tab buttons are absent from the row.
    await expect(page.getByRole('button', {name: 'Fuel Log', exact: true})).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Cost by Month', exact: true})).toHaveCount(0);
  });
});

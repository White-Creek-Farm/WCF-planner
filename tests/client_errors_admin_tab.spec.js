import {test, expect} from './fixtures.js';

// Focused runtime proof for the Client Errors Admin-tab relocation: Client
// Errors moved from the header hamburger into the Admin tab row (after Deleted),
// reusing the extracted ClientErrorsPanel without mounting a second Header.
//
// list_client_errors is routed to deterministic canned data so this spec never
// reads or mutates real TEST rows. Auth still uses the shared admin session, so
// run it through the standard TEST-DB lease wrapper:
//   node scripts/test_db_lease_run.cjs -- npx playwright test tests/client_errors_admin_tab.spec.js

const CANNED_ERRORS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-07-20T12:00:00.000Z',
    source: 'window.onerror',
    error_kind: 'TypeError',
    message: 'Canned client error row (Admin-tab runtime proof)',
    route: '/broiler/batches',
    app_version: 'test-canned',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-07-20T11:00:00.000Z',
    source: 'unhandledrejection',
    error_kind: 'Error',
    message: 'Second canned client error row',
    route: '/pig/sows',
    app_version: 'test-canned',
  },
];

test.describe('Client Errors — Admin tab (relocated from the hamburger)', () => {
  test.beforeEach(async ({page}) => {
    // Deterministic canned data for the admin-only list_client_errors RPC so
    // the reused panel renders identically without touching real TEST rows.
    await page.route('**/rest/v1/rpc/list_client_errors**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CANNED_ERRORS),
      });
    });
  });

  test('renders in the Admin tab row after Deleted, mounts the reused panel, keeps one Header', async ({page}) => {
    await page.goto('/admin');

    // The admin surface mounts exactly one global Header.
    await expect(page.locator('[data-header-menu-toggle="1"]')).toHaveCount(1);

    // Admin tab row: both tabs render; Client Errors is positioned after Deleted.
    const deletedTab = page.getByRole('button', {name: 'Deleted', exact: true});
    const clientErrorsTab = page.getByRole('button', {name: 'Client Errors', exact: true});
    await expect(deletedTab).toBeVisible();
    await expect(clientErrorsTab).toBeVisible();
    const deletedBox = await deletedTab.boundingBox();
    const clientErrorsBox = await clientErrorsTab.boundingBox();
    expect(deletedBox).not.toBeNull();
    expect(clientErrorsBox).not.toBeNull();
    // Same horizontal tab row; Client Errors sits to the right of Deleted.
    expect(clientErrorsBox.x).toBeGreaterThan(deletedBox.x);

    // Activate the tab → the reused ClientErrorsPanel mounts and finishes loading.
    await clientErrorsTab.click();
    await expect(page.locator('[data-client-errors-loaded="true"]')).toBeVisible();

    // The panel must NOT mount its own Header — still exactly one on the page.
    await expect(page.locator('[data-header-menu-toggle="1"]')).toHaveCount(1);

    // The canned rows render through the reused loading/RPC path.
    await expect(page.locator('[data-client-errors-table="1"]')).toBeVisible();
    await expect(page.locator('[data-client-error-row]')).toHaveCount(CANNED_ERRORS.length);

    // The Client Errors entry is gone from the hamburger (relocated to the tab).
    await page.locator('[data-header-menu-toggle="1"]').click();
    await expect(page.locator('[data-header-menu-item="admin"]')).toBeVisible();
    await expect(page.locator('[data-header-menu-item="client-errors"]')).toHaveCount(0);
  });

  test('standalone /admin/client-errors route still renders the reused panel', async ({page}) => {
    await page.goto('/admin/client-errors');
    await expect(page.locator('[data-client-errors-loaded="true"]')).toBeVisible();
    await expect(page.locator('[data-client-errors-table="1"]')).toBeVisible();
    // Backward-compatible standalone page keeps exactly one global Header.
    await expect(page.locator('[data-header-menu-toggle="1"]')).toHaveCount(1);
  });
});

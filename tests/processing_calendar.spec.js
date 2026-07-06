// Processing Calendar — browser TEST proof.
//
// Seeds native processing rows via the service-role admin client (bypasses the
// deny-all RLS), then drives the real /processing page as the authenticated
// admin and asserts: route loads, program-section grouping, row -> drawer,
// subtasks render, and the completion gate is visible (Mark complete disabled
// while a processor is missing + a subtask is open). The RPC round-trip
// (set processor -> mark complete) is proven separately in
// scripts/apply_test_mig_156.cjs; this spec proves the UI layer.
import {test, expect} from './fixtures.js';

const BATCH_ID = 'ptest-batch-1';
const SUB_ID = 'ptest-sub-1';
const MILE_ID = 'ptest-mile-1';

test.describe('Processing Calendar', () => {
  test('loads, groups by program, opens the drawer with subtasks + a gated completion, admin controls visible', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();

    // created_by is NOT NULL FK to profiles(id) — use a real admin profile.
    const {data: prof, error: pErr} = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .limit(1)
      .single();
    expect(pErr, pErr && pErr.message).toBeFalsy();
    const adminId = prof.id;

    // A cattle planner_batch (processor missing → completion blocked) + a pig
    // milestone (second program section). processing_date 2026 → shows under the
    // default current-year view. upsert(onConflict:'id') keeps the fixed-id seed
    // idempotent under a Playwright worker-restart race (stale row after TRUNCATE).
    const {error: recErr} = await supabaseAdmin.from('processing_records').upsert(
      [
        {
          id: BATCH_ID,
          record_type: 'planner_batch',
          program: 'cattle',
          title: 'TEST Cattle Steers',
          processing_date: '2026-09-15',
          status: 'planned',
          source_kind: 'cattle',
          source_id: 'srctest-1',
          number_processed: 3,
          created_by: adminId,
        },
        {
          id: MILE_ID,
          record_type: 'milestone',
          program: 'pig',
          title: 'TEST Pig Milestone',
          processing_date: '2026-08-01',
          status: 'planned',
          created_by: adminId,
        },
      ],
      {onConflict: 'id'},
    );
    expect(recErr, recErr && recErr.message).toBeFalsy();

    const {error: subErr} = await supabaseAdmin.from('processing_subtasks').upsert(
      {
        id: SUB_ID,
        record_id: BATCH_ID,
        label: 'TEST cut list',
        done: false,
        completed_at: null,
        sort_order: 1,
        created_by: adminId,
      },
      {onConflict: 'id'},
    );
    expect(subErr, subErr && subErr.message).toBeFalsy();

    await page.goto('/processing');
    await page.waitForSelector('[data-processing-loaded="1"]');

    // Grouped by program — both seeded programs render a section.
    await expect(page.locator('[data-processing-section="cattle"]')).toBeVisible();
    await expect(page.locator('[data-processing-section="pig"]')).toBeVisible();

    // Both seeded rows are visible; admin sees the Templates + Add-milestone controls.
    const row = page.locator(`[data-processing-row="${BATCH_ID}"]`);
    await expect(row).toBeVisible();
    await expect(page.locator(`[data-processing-row="${MILE_ID}"]`)).toBeVisible();
    await expect(page.locator('[data-processing-templates-btn]')).toBeVisible();
    await expect(page.locator('[data-processing-add-milestone-btn]')).toBeVisible();

    // Open the drawer.
    await row.click();
    const drawer = page.locator(`[data-processing-drawer="${BATCH_ID}"]`);
    await expect(drawer).toBeVisible();

    // Subtask renders inside the drawer.
    await expect(page.locator(`[data-processing-subtask="${SUB_ID}"]`)).toBeVisible();

    // Completion is gated: processor missing + an open subtask ⇒ Mark complete
    // is present but disabled (the blocker list is what disables it).
    const markBtn = page.locator('[data-processing-mark-complete]');
    await expect(markBtn).toBeVisible();
    await expect(markBtn).toBeDisabled();
  });
});

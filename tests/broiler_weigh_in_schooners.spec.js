import {test, expect} from './fixtures.js';

// ============================================================================
// Broiler public WeighIns schooner mapping hotfix
// ============================================================================
// The public broiler weigh-in form previously read app_store.ppp-v4 directly
// for per-batch schooner data; anon RLS blocked that read so the form
// silently fell back to a single column literally labeled "(no schooner)".
// The fix routes the public form through webform_config.broiler_batch_meta
// (mirrored by the admin app on load + syncWebformConfig). On admin misconfig
// (no schooners assigned), Start Session and Resume both block with an
// explicit inline error — no '(no schooner)' fallback, no ['1','2'] fallback.
// The done-screen "New Weigh-In" CTA is hidden for broiler outcomes (both
// queued and online done branches).
//
// Independence from app_store is proven at the source level by
// tests/static/weighinswebform_no_app_store.test.js (vitest): WeighInsWebform.jsx
// and all of src/webforms contain no 'app_store' / 'ppp-v4' literals. (A former
// runtime network-route lock, T_negative, was removed once the form became
// login-required and renders inside the authed admin shell, whose boot does a
// legitimate bulk app_store read — making a page-level "zero app_store requests"
// assertion structurally impossible and unrelated to the form's isolation.)
// ============================================================================

const DB_NAME = 'wcf-offline-queue';

async function wipeOfflineQueue(page) {
  await page.evaluate(
    (dbName) =>
      new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      }),
    DB_NAME,
  );
}

async function startBroilerSession(page, batchName, week = 4) {
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await page.getByText('Broiler', {exact: true}).click();
  // Submitter is locked to the signed-in user (no team dropdown), so the batch
  // select is now the first combobox.
  await page.getByRole('combobox').first().selectOption(batchName);
  await page.getByRole('button', {name: `Week ${week}`}).click();
  await page.getByRole('button', {name: 'Start Session'}).click();
}

// =============================================================================
// Public weigh-in flows. The /weighins form submitter is now locked to the
// signed-in user, so the form is login-required — these run under the default
// admin storageState (no anon override). The schooner mapping behavior under
// test is identical when authed.
// =============================================================================
test.describe('public broiler weigh-in', () => {
  // Each test navigates inside its body — Playwright fixtures (incl. the
  // scenario reset+seed) only run when destructured by the test, so
  // navigation must happen AFTER seeding or the form's once-on-mount
  // effects fire against stale DB state.

  // T1 — Two-schooner batch shows two columns labeled exactly Schooner 2/3
  test('T1: two-schooner batch renders two columns with correct labels and 15 inputs each', async ({
    page,
    broilerWeighInSchoonersScenario,
  }) => {
    void broilerWeighInSchoonersScenario;
    await page.goto('/weighins');
    await wipeOfflineQueue(page);
    await startBroilerSession(page, 'B-26-01');

    await expect(page.getByText('Bird weights (lbs)')).toBeVisible({timeout: 10_000});

    // Grid header cell renders as 'Schooner ' + label; meta seed has bare
    // labels '2'/'3' so the visible text is exactly 'Schooner 2' / 'Schooner 3'.
    await expect(page.getByText('Schooner 2', {exact: true})).toBeVisible();
    await expect(page.getByText('Schooner 3', {exact: true})).toBeVisible();

    // 30 number inputs total = 2 columns × 15 rows.
    const inputs = page.locator('input[type="number"]');
    await expect(inputs).toHaveCount(30);

    // No '(no schooner)' literal anywhere on the page.
    await expect(page.getByText('(no schooner)')).toHaveCount(0);
  });

  // T2 — One-schooner batch
  test('T2: one-schooner batch renders one column and 15 inputs', async ({page, broilerWeighInSchoonersScenario}) => {
    void broilerWeighInSchoonersScenario;
    await page.goto('/weighins');
    await wipeOfflineQueue(page);
    await startBroilerSession(page, 'B-26-02');

    await expect(page.getByText('Bird weights (lbs)')).toBeVisible({timeout: 10_000});
    await expect(page.getByText('Schooner 1', {exact: true})).toBeVisible();
    await expect(page.locator('input[type="number"]')).toHaveCount(15);
    await expect(page.getByText('(no schooner)')).toHaveCount(0);
  });

  // T3 — Empty-schooner batch must block at Start Session with explicit error
  test('T3: empty-schooner batch blocks Start Session with explicit error', async ({
    page,
    broilerWeighInSchoonersScenario,
  }) => {
    void broilerWeighInSchoonersScenario;
    await page.goto('/weighins');
    await wipeOfflineQueue(page);
    await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    await page.getByText('Broiler', {exact: true}).click();

    // B-26-03 is an ACTIVE batch with empty schooners — still visible in the
    // dropdown so admin misconfig surfaces at Start Session rather than
    // silently hiding the batch (Q2 answer; helper filter is active-only).
    // Submitter is locked (no team dropdown) so the batch select is the first
    // combobox.
    const batchSelect = page.getByRole('combobox').first();
    await expect(batchSelect.locator('option', {hasText: 'B-26-03'})).toHaveCount(1);

    await batchSelect.selectOption('B-26-03');
    await page.getByRole('button', {name: 'Week 4'}).click();
    await page.getByRole('button', {name: 'Start Session'}).click();

    // Inline error visible; setStage stays 'select' (Bird-weights grid never appears).
    await expect(page.getByText(/no schooners assigned/i)).toBeVisible({timeout: 5_000});
    await expect(page.getByText('Bird weights (lbs)')).toHaveCount(0);
    await expect(page.getByText('(no schooner)')).toHaveCount(0);
    // No ['1','2'] fallback either — the grid headers under that fallback would
    // read "Schooner 1" / "Schooner 2"; under T3 there are no grid headers at all.
  });

  // T4 — Submit two-schooner session online → DB rows have right tags + null csid
  test('T4: submit two-schooner online → weigh_ins tag landed correctly + child csid NULL', async ({
    page,
    supabaseAdmin,
    broilerWeighInSchoonersScenario,
  }) => {
    void broilerWeighInSchoonersScenario;
    await page.goto('/weighins');
    await wipeOfflineQueue(page);
    await startBroilerSession(page, 'B-26-01');
    await expect(page.getByText('Bird weights (lbs)')).toBeVisible({timeout: 10_000});

    const inputs = page.locator('input[type="number"]');
    await inputs.nth(0).fill('1.4'); // schooner '2' row 1
    await inputs.nth(1).fill('1.5'); // schooner '2' row 2
    await inputs.nth(15).fill('1.6'); // schooner '3' row 1
    await inputs.nth(16).fill('1.7'); // schooner '3' row 2

    await page.getByRole('button', {name: 'Save Weights'}).click();
    await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 15_000});

    const {data: sessions} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('species', 'broiler');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].batch_id).toBe('B-26-01');

    const {data: rows} = await supabaseAdmin.from('weigh_ins').select('*').eq('session_id', sessions[0].id);
    expect(rows).toHaveLength(4);
    // weigh_ins.tag stores bare schooner labels (matches admin hydrateGrid lookup).
    const tagCounts = rows.reduce((acc, r) => {
      acc[r.tag] = (acc[r.tag] || 0) + 1;
      return acc;
    }, {});
    expect(tagCounts).toEqual({2: 2, 3: 2});
    expect(rows.every((r) => r.client_submission_id === null)).toBe(true);
  });

  // T6 — Done-screen broiler CTA hidden (online done path + queued path)
  test('T6: broiler done screen hides "New Weigh-In" CTA + keeps "Back to Forms"', async ({
    page,
    broilerWeighInSchoonersScenario,
  }) => {
    void broilerWeighInSchoonersScenario;
    await page.goto('/weighins');
    await wipeOfflineQueue(page);
    await startBroilerSession(page, 'B-26-01');
    await expect(page.getByText('Bird weights (lbs)')).toBeVisible({timeout: 10_000});

    await page.locator('input[type="number"]').nth(0).fill('1.4');
    await page.getByRole('button', {name: 'Save Weights'}).click();
    await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 15_000});

    // Now flip status to complete via Complete Weigh-In to get to the done screen.
    await page.getByRole('button', {name: /Complete Weigh-In/}).click();
    await expect(page.getByText('Session Complete')).toBeVisible({timeout: 10_000});

    await expect(page.getByRole('button', {name: 'New Weigh-In'})).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Back to Forms'})).toBeVisible();
  });

  // T8 — Public completion stamps week4Lbs onto app_store.ppp-v4 via the
  // stamp_broiler_batch_avg RPC (mig 055). Pre-055 the public form called
  // writeBroilerBatchAvg client-side, which silently no-op'd because anon
  // RLS blocks app_store reads. This test fails if anything regresses that
  // server-side stamp path (RPC missing, anon EXECUTE revoked, RLS lock
  // re-applied without an RPC bypass, etc.).
  test('T8: public completion stamps week4Lbs on app_store.ppp-v4', async ({
    page,
    supabaseAdmin,
    broilerWeighInSchoonersScenario,
  }) => {
    void broilerWeighInSchoonersScenario;
    await page.goto('/weighins');
    await wipeOfflineQueue(page);
    await startBroilerSession(page, 'B-26-01', 4);
    await expect(page.getByText('Bird weights (lbs)')).toBeVisible({timeout: 10_000});

    const inputs = page.locator('input[type="number"]');
    // 1.4 + 1.5 + 1.6 + 1.7 = 6.2 / 4 = 1.55. Rounded to 2dp = 1.55.
    await inputs.nth(0).fill('1.4');
    await inputs.nth(1).fill('1.5');
    await inputs.nth(15).fill('1.6');
    await inputs.nth(16).fill('1.7');

    await page.getByRole('button', {name: 'Save Weights'}).click();
    await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 15_000});

    await page.getByRole('button', {name: /Complete Weigh-In/}).click();
    await expect(page.getByText('Session Complete')).toBeVisible({timeout: 10_000});

    const {data: row, error} = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-v4').maybeSingle();
    expect(error).toBeNull();
    expect(Array.isArray(row && row.data)).toBe(true);
    const batch = row.data.find((b) => b && b.name === 'B-26-01');
    expect(batch).toBeTruthy();
    expect(Number(batch.week4Lbs)).toBe(1.55);
    // Sibling batches must remain untouched (jsonb walk in the RPC must
    // re-emit non-matching rows verbatim, not strip them).
    expect(row.data.find((b) => b && b.name === 'B-26-02')).toBeTruthy();
    expect(row.data.find((b) => b && b.name === 'B-26-03')).toBeTruthy();
  });

  // T9 — Same coverage for week 6.
  test('T9: public completion stamps week6Lbs on app_store.ppp-v4', async ({
    page,
    supabaseAdmin,
    broilerWeighInSchoonersScenario,
  }) => {
    void broilerWeighInSchoonersScenario;
    await page.goto('/weighins');
    await wipeOfflineQueue(page);
    await startBroilerSession(page, 'B-26-02', 6);
    await expect(page.getByText('Bird weights (lbs)')).toBeVisible({timeout: 10_000});

    const inputs = page.locator('input[type="number"]');
    // B-26-02 is one schooner -> 15 inputs total. 4.0+4.2+4.4+4.6 = 17.2 / 4 = 4.3.
    await inputs.nth(0).fill('4.0');
    await inputs.nth(1).fill('4.2');
    await inputs.nth(2).fill('4.4');
    await inputs.nth(3).fill('4.6');

    await page.getByRole('button', {name: 'Save Weights'}).click();
    await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 15_000});

    await page.getByRole('button', {name: /Complete Weigh-In/}).click();
    await expect(page.getByText('Session Complete')).toBeVisible({timeout: 10_000});

    const {data: row, error} = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-v4').maybeSingle();
    expect(error).toBeNull();
    const batch = row.data.find((b) => b && b.name === 'B-26-02');
    expect(batch).toBeTruthy();
    expect(Number(batch.week6Lbs)).toBe(4.3);
  });

  // (Former T_negative — a runtime "public flow makes zero /rest/v1/app_store
  // requests" lock — was removed here. Once the /weighins form became
  // login-required it renders inside the authed admin shell, whose boot does a
  // legitimate bulk app_store read, so a page-level zero-request assertion is
  // structurally impossible and no longer measures the form. The form's
  // app_store independence is locked at the source level by
  // tests/static/weighinswebform_no_app_store.test.js, and the positive
  // server-side stamp path is covered by T8/T9 below.)

  // T7 — Resume of a draft for a now-empty-schooner batch is blocked
  test('T7: resume of a zero-schooner batch blocks with explicit error', async ({
    page,
    supabaseAdmin,
    broilerWeighInSchoonersScenario,
  }) => {
    void broilerWeighInSchoonersScenario;

    // Pre-seed a draft session for B-26-03 (empty schooners) so the form
    // surfaces it under "Resume a draft session". Backdate started_at by
    // 1 hour so it's clearly within the 7-day cutoff.
    const now = new Date();
    const startedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const today = now.toISOString().slice(0, 10);
    const draftId = 'wsd-' + Math.random().toString(36).slice(2, 10);
    const ins = await supabaseAdmin.from('weigh_in_sessions').insert({
      id: draftId,
      species: 'broiler',
      status: 'draft',
      date: today,
      team_member: 'BMAN',
      batch_id: 'B-26-03',
      broiler_week: 4,
      started_at: startedAt,
    });
    expect(ins.error).toBeNull();

    await page.goto('/weighins');
    await wipeOfflineQueue(page);
    await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    await page.getByText('Broiler', {exact: true}).click();

    await expect(page.getByText('Resume a draft session')).toBeVisible({timeout: 10_000});
    await page.getByText('B-26-03', {exact: false}).first().click();

    await expect(page.getByText(/no schooners assigned/i)).toBeVisible({timeout: 5_000});
    await expect(page.getByText('Bird weights (lbs)')).toHaveCount(0);
    await expect(page.getByText('(no schooner)')).toHaveCount(0);
  });
});

// =============================================================================
// T5 — Admin hydration: authenticated session reading the just-created session
// in LivestockWeighInsView (broiler). Uses default authenticated storageState.
// =============================================================================
test.describe('admin broiler weigh-ins view (authenticated)', () => {
  test('T5: admin LivestockWeighInsView hydrates schooner columns for the new session', async ({
    page,
    supabaseAdmin,
    broilerWeighInSchoonersScenario,
  }) => {
    void broilerWeighInSchoonersScenario;

    // Build the session + 4 weigh_ins directly (avoids re-driving the public form
    // under authenticated storage). Tags match what saveBatch would have written.
    const sessionId = 'wis-' + Math.random().toString(36).slice(2, 10);
    const today = new Date().toISOString().slice(0, 10);
    const startedAt = new Date().toISOString();
    let r = await supabaseAdmin.from('weigh_in_sessions').insert({
      id: sessionId,
      species: 'broiler',
      status: 'draft',
      date: today,
      team_member: 'BMAN',
      batch_id: 'B-26-01',
      broiler_week: 4,
      started_at: startedAt,
    });
    expect(r.error).toBeNull();

    const enteredAt = new Date().toISOString();
    const rows = [
      {weight: 1.4, tag: '2'},
      {weight: 1.5, tag: '2'},
      {weight: 1.6, tag: '3'},
      {weight: 1.7, tag: '3'},
    ].map((e, i) => ({
      id: `wie-${sessionId}-${i}`,
      session_id: sessionId,
      tag: e.tag,
      weight: e.weight,
      note: null,
      new_tag_flag: false,
      entered_at: enteredAt,
    }));
    r = await supabaseAdmin.from('weigh_ins').insert(rows);
    expect(r.error).toBeNull();

    // Visit admin LivestockWeighInsView for broilers.
    await page.goto('/broiler/weighins');
    await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

    // The session row collapses by default — expand it.
    await expect(page.getByText('B-26-01').first()).toBeVisible({timeout: 15_000});
    await page.getByText('B-26-01').first().click();

    // Both column headers visible. Admin's deriveLabels reads ppp-v4 schooner
    // = '2&3' → ['2','3'] (per src/lib/broiler.js SCHOONERS); the grid cell
    // renders 'Schooner ' + label so the visible text is "Schooner 2" / "Schooner 3".
    await expect(page.getByText('Schooner 2').first()).toBeVisible({timeout: 10_000});
    await expect(page.getByText('Schooner 3').first()).toBeVisible({timeout: 10_000});

    // Hydrated weights end up in number inputs under the matching columns.
    // Round-trip lock: each weight string appears at least once in the form.
    for (const w of ['1.4', '1.5', '1.6', '1.7']) {
      await expect(page.locator(`input[value="${w}"]`).first()).toBeVisible({timeout: 5_000});
    }

    // No '(no schooner)' on the admin view for this session.
    await expect(page.getByText('(no schooner)')).toHaveCount(0);
  });
});

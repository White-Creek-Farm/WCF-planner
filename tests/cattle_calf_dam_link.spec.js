import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle calf dam-link — 2026-04-29
// ============================================================================
// Locks the post-build contract:
//   - mig 033 AFTER-INSERT trigger on cattle_calving_records sets the
//     matching calf cattle row's dam_tag when currently null/blank.
//   - Never overwrites an existing non-blank dam_tag (admin work survives,
//     conflicting calving records surface naturally).
//   - Backfill DO block is callable + idempotent — uses deterministic
//     row_number() over (calving_date, created_at, id) to pick a single
//     dam when multiple calving records reference the same calf_tag.
//   - Calf herd tile renders "dam #<damTag>" subtitle once the trigger
//     populates dam_tag (UI symptom test).
//
// Pre-flight: mig 033 must be applied to the test project.
// ============================================================================

const DAM = {
  id: 'cow-dam-001',
  tag: 'M-DAM-001',
  sex: 'cow',
  herd: 'mommas',
  breed: 'Angus',
};

const CALF_BLANK = {
  id: 'calf-blank-001',
  tag: 'C-CALF-001',
  sex: 'heifer',
  herd: 'mommas',
  breed: 'Angus',
  dam_tag: null,
};

const CALF_EXISTING_DAM = {
  id: 'calf-existing-001',
  tag: 'C-CALF-002',
  sex: 'heifer',
  herd: 'mommas',
  breed: 'Angus',
  dam_tag: 'M-OTHER-001',
};

// Inline copy of the mig 033 backfill DO block, callable via exec_sql for
// the idempotency regression test. Must mirror the migration's backfill
// shape exactly — if the migration's backfill changes, this constant must
// be updated too.
const BACKFILL_SQL = `
DO $$
BEGIN
  WITH ranked AS (
    SELECT
      calf_tag,
      dam_tag,
      row_number() OVER (
        PARTITION BY calf_tag
        ORDER BY calving_date ASC NULLS LAST,
                 created_at  ASC NULLS LAST,
                 id          ASC
      ) AS rn
    FROM cattle_calving_records
    WHERE calf_tag IS NOT NULL
      AND calf_tag <> ''
      AND dam_tag  IS NOT NULL
      AND dam_tag  <> ''
  )
  UPDATE cattle c
     SET dam_tag = r.dam_tag
    FROM ranked r
   WHERE r.rn = 1
     AND c.tag = r.calf_tag
     AND (c.dam_tag IS NULL OR c.dam_tag = '');
END $$;
`;

// --------------------------------------------------------------------------
// Test 1 — Trigger sets blank dam_tag on calf row
// --------------------------------------------------------------------------
test('trigger: calf with blank dam_tag gets linked on calving record insert', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert([DAM, CALF_BLANK], {onConflict: 'id'});

  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-link-test-1',
    dam_tag: DAM.tag,
    calving_date: '2026-04-29',
    calf_tag: CALF_BLANK.tag,
    total_born: 1,
    deaths: 0,
  });

  const {data: calfRow, error} = await supabaseAdmin
    .from('cattle')
    .select('id, dam_tag')
    .eq('id', CALF_BLANK.id)
    .maybeSingle();
  expect(error).toBeNull();
  expect(calfRow.dam_tag).toBe(DAM.tag);
});

// --------------------------------------------------------------------------
// Test 2 — Trigger does NOT overwrite existing dam_tag
// --------------------------------------------------------------------------
test('trigger: calf with existing dam_tag is left alone on calving record insert', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert([DAM, CALF_EXISTING_DAM], {onConflict: 'id'});

  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-link-test-2',
    dam_tag: DAM.tag,
    calving_date: '2026-04-29',
    calf_tag: CALF_EXISTING_DAM.tag,
    total_born: 1,
    deaths: 0,
  });

  const {data: calfRow} = await supabaseAdmin
    .from('cattle')
    .select('dam_tag')
    .eq('id', CALF_EXISTING_DAM.id)
    .maybeSingle();
  expect(calfRow.dam_tag).toBe('M-OTHER-001');
});

// --------------------------------------------------------------------------
// Test 3 — Trigger no-op when calf_tag has no matching cattle row
// --------------------------------------------------------------------------
test('trigger: missing calf row is silent no-op', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert(DAM, {onConflict: 'id'});

  // calf_tag references no existing cattle row — should not error.
  const {error} = await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-link-test-3',
    dam_tag: DAM.tag,
    calving_date: '2026-04-29',
    calf_tag: 'NONEXISTENT-999',
    total_born: 1,
    deaths: 0,
  });
  expect(error).toBeNull();
});

// --------------------------------------------------------------------------
// Test 4 — Backfill links existing calving + is idempotent
// --------------------------------------------------------------------------
// Mirrors mig 032 spec test 3: insert calving record (trigger fires + sets
// dam_tag), reset calf.dam_tag back to null to simulate pre-mig-033 data,
// run backfill DO block, assert dam_tag is restored. Re-run is a no-op.
test('backfill: links existing calf with blank dam_tag; idempotent on re-run', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert([DAM, CALF_BLANK], {onConflict: 'id'});
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-backfill-1',
    dam_tag: DAM.tag,
    calving_date: '2026-01-15',
    calf_tag: CALF_BLANK.tag,
    total_born: 1,
    deaths: 0,
  });

  // Reset to null to simulate a pre-mig-033 row (calving record exists,
  // calf row was never linked).
  await supabaseAdmin.from('cattle').update({dam_tag: null}).eq('id', CALF_BLANK.id);

  const before = await supabaseAdmin.from('cattle').select('dam_tag').eq('id', CALF_BLANK.id).maybeSingle();
  expect(before.data.dam_tag).toBeNull();

  // First backfill run — sets the link.
  const {error: bf1Err} = await supabaseAdmin.rpc('exec_sql', {sql: BACKFILL_SQL});
  expect(bf1Err).toBeNull();

  const after1 = await supabaseAdmin.from('cattle').select('dam_tag').eq('id', CALF_BLANK.id).maybeSingle();
  expect(after1.data.dam_tag).toBe(DAM.tag);

  // Second run — idempotent, no further changes.
  const {error: bf2Err} = await supabaseAdmin.rpc('exec_sql', {sql: BACKFILL_SQL});
  expect(bf2Err).toBeNull();

  const after2 = await supabaseAdmin.from('cattle').select('dam_tag').eq('id', CALF_BLANK.id).maybeSingle();
  expect(after2.data.dam_tag).toBe(DAM.tag);
});

// --------------------------------------------------------------------------
// Test 5 — UI: calf tile shows "dam #<damTag>" after trigger fires
// --------------------------------------------------------------------------
// Codex revision: assert the visible symptom (calf herd record showing the
// dam) — not just the DB field. Confirms the DB fix actually resolves the
// reported issue.
test('UI: calf herd tile shows dam tag after trigger links it', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert([DAM, CALF_BLANK], {onConflict: 'id'});

  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-ui-test',
    dam_tag: DAM.tag,
    calving_date: '2026-04-29',
    calf_tag: CALF_BLANK.tag,
    total_born: 1,
    deaths: 0,
  });

  await page.goto('/cattle/herds');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // The list is always flat now; enable the Dam Tag column (off by default) to
  // verify the calf→dam link renders on the calf's row.
  await page.locator('[data-cattle-herds-columns-toggle="1"]').click();
  await page.locator('[data-cattle-column-toggle="damTag"]').click();
  await page.locator('[data-cattle-herds-columns-toggle="1"]').click();

  const calfTile = page.locator(`#cow-${CALF_BLANK.id}`).first();
  await expect(calfTile).toBeVisible({timeout: 10_000});
  await expect(calfTile).toContainText(`#${DAM.tag}`);
});

// --------------------------------------------------------------------------
// Test 6 — UI: CowDetail Lineage keeps dam editable when dam_tag is set
// --------------------------------------------------------------------------
// Locks the correction contract: when the trigger (or any prior write) has
// populated cattle.dam_tag, CowDetail still renders an editable input for
// dam_tag. The View link is navigation only, not the sole authoring surface.
// Contract update (2026-06-11 triage): clicking a herd-list cow row navigates
// to the /cattle/herds/<id> record page (CattleAnimalPage composes CowDetail);
// the old inline-expand-inside-#cow-<id> flow was retired with the record-page
// lanes, so lineage assertions now run against the record page.
test('UI: CowDetail Lineage shows editable dam input when dam_tag is set', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert([DAM, CALF_BLANK], {onConflict: 'id'});
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-ui-readonly',
    dam_tag: DAM.tag,
    calving_date: '2026-04-29',
    calf_tag: CALF_BLANK.tag,
    total_born: 1,
    deaths: 0,
  });

  await page.goto('/cattle/herds');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  await expect(page.locator('[data-cattle-flat-list]')).toBeVisible({timeout: 15_000});

  const calfRow = page.locator(`#cow-${CALF_BLANK.id}`).first();
  await expect(calfRow).toBeVisible({timeout: 10_000});
  // Clicking the cow row opens the cattle animal record page.
  await calfRow.click();
  await expect(page).toHaveURL(new RegExp('/cattle/herds/' + CALF_BLANK.id + '$'), {timeout: 10_000});

  const record = page.locator('[data-cattle-animal-page="1"]');
  await expect(record).toBeVisible({timeout: 10_000});
  const lineage = record.locator('[data-lineage-section="1"]');
  await expect(lineage).toBeVisible({timeout: 10_000});
  // Dam input is the first text input in the lineage grid (sire is second).
  // (The retired inline-flow spec used getByDisplayValue, which is not a
  // Playwright Locator API — that line never ran because the old expansion
  // assert failed first.)
  await expect(lineage.locator('input[type="text"]').first()).toHaveValue(DAM.tag);
  await expect(lineage.getByRole('button', {name: `View #${DAM.tag}`})).toBeVisible();
  // Dam and sire inputs remain editable even when dam_tag is populated.
  await expect(lineage.locator('input[type="text"]')).toHaveCount(2);
});

// --------------------------------------------------------------------------
// Test 7 — UI: CowDetail Lineage shows editable dam input when dam_tag blank
// --------------------------------------------------------------------------
test('UI: CowDetail Lineage shows editable dam input when dam_tag is blank', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  // Seed the calf with no dam_tag and no calving record.
  await supabaseAdmin.from('cattle').upsert([DAM, CALF_BLANK], {onConflict: 'id'});

  await page.goto('/cattle/herds');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  await expect(page.locator('[data-cattle-flat-list]')).toBeVisible({timeout: 15_000});

  const calfRow = page.locator(`#cow-${CALF_BLANK.id}`).first();
  await expect(calfRow).toBeVisible({timeout: 10_000});
  await calfRow.click();
  await expect(page).toHaveURL(new RegExp('/cattle/herds/' + CALF_BLANK.id + '$'), {timeout: 10_000});

  const record = page.locator('[data-cattle-animal-page="1"]');
  await expect(record).toBeVisible({timeout: 10_000});
  const lineage = record.locator('[data-lineage-section="1"]');
  await expect(lineage).toBeVisible({timeout: 10_000});
  // Both dam and sire inputs render in the blank state.
  await expect(lineage.locator('input[type="text"]')).toHaveCount(2);
  // No View link when dam_tag is blank.
  await expect(lineage.getByRole('button', {name: /^View #/})).toHaveCount(0);
});

// --------------------------------------------------------------------------
// Test 8 — UI: calving list omits born/died summary; form omits the inputs
// --------------------------------------------------------------------------
// The born/died feature is retired entirely. New calvings stop publishing the
// auto-comment that read "X born, Y died, calf #Z" on the dam's timeline.
// Locks: (a) record list never renders the count phrase even with non-zero
// data, (b) + Add Calving form has no Total born / Deaths inputs.
test('UI: calving record list and form omit born/died entirely', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert([DAM, CALF_BLANK], {onConflict: 'id'});
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-no-counts-display',
    dam_tag: DAM.tag,
    calving_date: '2026-04-29',
    calf_tag: CALF_BLANK.tag,
    total_born: 2,
    deaths: 1,
  });

  await page.goto('/cattle/herds');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  await expect(page.locator('[data-cattle-flat-list]')).toBeVisible({timeout: 15_000});

  // Calving list lives on the dam's record page (CowDetail composed there).
  const damRow = page.locator(`#cow-${DAM.id}`).first();
  await expect(damRow).toBeVisible({timeout: 10_000});
  await damRow.click();
  await expect(page).toHaveURL(new RegExp('/cattle/herds/' + DAM.id + '$'), {timeout: 10_000});

  const record = page.locator('[data-cattle-animal-page="1"]');
  await expect(record).toBeVisible({timeout: 10_000});

  // Calf link still renders; count phrase is gone even with non-zero values.
  await expect(record.getByRole('button', {name: `calf #${CALF_BLANK.tag}`})).toBeVisible({timeout: 10_000});
  await expect(record).not.toContainText('2 born, 1 died');
  await expect(record).not.toContainText('born,');

  // + Add Calving form should not render Total born / Deaths inputs.
  await record.getByRole('button', {name: '+ Add Calving'}).click();
  await expect(record.getByText('Total born', {exact: true})).toHaveCount(0);
  await expect(record.getByText('Deaths', {exact: true})).toHaveCount(0);
});

// --------------------------------------------------------------------------
// Test 9 — Form submit writes no auto-comment to the dam's timeline
// --------------------------------------------------------------------------
// addCalvingRecord previously published a "X born, Y died, calf #Z" comment
// to cattle_comments on every calving submission. With the born/died feature
// retired, the auto-comment is gone entirely. Locks: a UI-driven calving
// submission inserts the cattle_calving_records row but writes NO row into
// cattle_comments for that dam.
test('UI: + Add Calving submit writes no auto-comment to the dam timeline', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert([DAM, CALF_BLANK], {onConflict: 'id'});

  await page.goto('/cattle/herds');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  await expect(page.locator('[data-cattle-flat-list]')).toBeVisible({timeout: 15_000});

  const damRow = page.locator(`#cow-${DAM.id}`).first();
  await expect(damRow).toBeVisible({timeout: 10_000});
  await damRow.click();
  await expect(page).toHaveURL(new RegExp('/cattle/herds/' + DAM.id + '$'), {timeout: 10_000});

  const record = page.locator('[data-cattle-animal-page="1"]');
  await expect(record).toBeVisible({timeout: 10_000});

  // Open + submit the form. calving_date defaults to today; no other fields required.
  await record.getByRole('button', {name: '+ Add Calving'}).click();
  await record.getByRole('button', {name: 'Save Calving'}).click();

  // Form closes on successful save.
  await expect(record.getByRole('button', {name: 'Save Calving'})).toHaveCount(0, {timeout: 10_000});

  // The calving record was written, the auto-comment was not.
  const {data: records} = await supabaseAdmin
    .from('cattle_calving_records')
    .select('id, dam_tag')
    .eq('dam_tag', DAM.tag);
  expect(records.length).toBe(1);

  const {data: comments, error: commentsErr} = await supabaseAdmin
    .from('cattle_comments')
    .select('id, source')
    .eq('cattle_id', DAM.id);
  expect(commentsErr).toBeNull();
  expect(comments).toEqual([]);
});

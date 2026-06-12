import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Log — unmatched-tag calf notes + the resolver trigger.
// ============================================================================
// An online submit with a tag that matches NO active cow forces the calf-note
// panel (required: herd, DOB(+est), sex, origin) and forces Issue checked.
// The entry lands with an unresolved link carrying the calf-note fields and a
// derived unresolved system note on the log page. When a cow with that tag is
// later created (here through the Herds '+ Add Cow' flow), the AFTER INSERT
// resolver trigger links it: mirror created, cattle_id/mirror_comment_id set,
// is_issue untouched. The cow page then shows the mirror and the log row's
// unresolved note clears.
// ============================================================================

async function clearCattleLogData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('comments').delete().neq('id', '__never__');
  if (error) throw new Error('clear comments: ' + error.message);
}

// The calf panel's Origin (required) and Breed (optional) selects are built
// from DISTINCT values on the active herd, so at least one cow must carry
// them before the panel is usable.
async function seedOriginCow(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('cattle').upsert(
    {
      id: 'cow-origin-500',
      tag: '500',
      herd: 'mommas',
      sex: 'cow',
      origin: 'WCF',
      breed: 'Wagyu',
      old_tags: [],
      deleted_at: null,
      deleted_by: null,
      processing_batch_id: null,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error('seedOriginCow: ' + error.message);
}

async function waitForLogLoaded(page) {
  await expect(page.locator('[data-cattle-log-loaded="1"]')).toBeVisible({timeout: 15_000});
}

const COMPOSER_TEXTAREA = '[data-cattle-log-composer="1"] [data-mention-textarea="1"]';

test('unmatched tag forces calf panel + Issue; creating the cow in Herds resolves the link and mirrors', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(120_000);
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedOriginCow(supabaseAdmin);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  // ── 1. Unmatched tag → calf panel + forced Issue + blocked submit ──
  const body = 'New calf #888 found with momma 500 this morning';
  await page.locator(COMPOSER_TEXTAREA).fill(body);

  // Preview marks #888 unmatched once the active-cattle list is in.
  await expect(page.getByText('#888 — no active cow (calf details below)')).toBeVisible({timeout: 15_000});
  const panel = page.locator('[data-cattle-log-calf-panel="888"]');
  await expect(panel).toBeVisible();

  // Issue checkbox: forced checked + disabled while an unmatched tag exists.
  // Scoped by accessible name to stay unambiguous against any future
  // checkbox inside the composer.
  const issueBox = page.locator('[data-cattle-log-composer="1"]').getByRole('checkbox', {name: /^Issue/});
  await expect(issueBox).toBeChecked();
  await expect(issueBox).toBeDisabled();
  await expect(page.getByText('(required for unknown tags)')).toBeVisible();

  // Submit is blocked until the required calf fields are complete.
  await expect(page.locator('[data-cattle-log-submit="1"]')).toBeDisabled();
  await expect(page.getByText('Complete calf details for #888')).toBeVisible();

  // ── 2. Complete the calf note (required + optional fields) ──
  // Panel selects in DOM order: Herd, Sex, Origin, Breed.
  await panel.locator('select').nth(0).selectOption('mommas');
  await panel.locator('input[type="date"]').fill('2026-06-01');
  await panel.locator('select').nth(1).selectOption('heifer');
  await panel.locator('select').nth(2).selectOption('WCF');
  await panel.locator('select').nth(3).selectOption('Wagyu');
  await panel.getByPlaceholder("Momma's tag").fill('500');
  await panel.getByPlaceholder('Anything else').fill('Born overnight');

  const submit = page.locator('[data-cattle-log-submit="1"]');
  await expect(submit).toBeEnabled({timeout: 10_000});
  await submit.click();
  await expect(page.getByText('Log entry submitted.')).toBeVisible({timeout: 10_000});

  // ── 3. Entry renders with the derived unresolved system note ──
  const row = page.locator('[data-cattle-log-row]').filter({hasText: 'New calf'});
  await expect(row).toBeVisible({timeout: 10_000});
  const unresolvedNote = row.locator('[data-cattle-log-unresolved-note="1"]');
  await expect(unresolvedNote).toBeVisible();
  await expect(unresolvedNote).toContainText('#888');

  // DB: unresolved link row carries the calf-note fields; issue forced true.
  const {data: entries, error: entriesErr} = await supabaseAdmin
    .from('comments')
    .select('id')
    .eq('entity_type', 'cattle.log');
  expect(entriesErr).toBeNull();
  expect(entries).toHaveLength(1);
  const entryId = entries[0].id;

  const {data: links, error: linkErr} = await supabaseAdmin
    .from('cattle_log_tag_links')
    .select(
      'tag, cattle_id, mirror_comment_id, calf_herd, calf_dob, calf_sex, calf_origin, calf_dam_tag, calf_breed, calf_note',
    )
    .eq('comment_id', entryId);
  expect(linkErr).toBeNull();
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({
    tag: '888',
    cattle_id: null,
    mirror_comment_id: null,
    calf_herd: 'mommas',
    calf_dob: '2026-06-01',
    calf_sex: 'heifer',
    calf_origin: 'WCF',
    calf_dam_tag: '500',
    calf_breed: 'Wagyu',
    calf_note: 'Born overnight',
  });

  const {data: issueRow, error: issueErr} = await supabaseAdmin
    .from('cattle_log_issue_state')
    .select('is_issue')
    .eq('comment_id', entryId)
    .single();
  expect(issueErr).toBeNull();
  expect(issueRow.is_issue).toBe(true);

  // ── 4. Create cow #888 through the Herds Add Cow flow ──
  await page.goto('/cattle/herds');
  await expect(page.locator('[data-cattle-match-count]')).toBeVisible({timeout: 15_000});
  await page.getByRole('button', {name: '+ Add Cow'}).click();
  await page.getByPlaceholder('Required (or blank for unweaned calf)').fill('888');
  // Defaults: sex 'cow', herd 'mommas' (an active herd) — both fine for the
  // resolver; only the tag drives matching.
  await page.getByRole('button', {name: 'Add Cow', exact: true}).click();

  let newCowId = null;
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin.from('cattle').select('id').eq('tag', '888').is('deleted_at', null);
        if (data && data.length === 1) {
          newCowId = data[0].id;
          return true;
        }
        return false;
      },
      {timeout: 15_000},
    )
    .toBe(true);

  // ── 5. Resolver (AFTER INSERT trigger): link resolves + mirror created ──
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin
          .from('cattle_log_tag_links')
          .select('cattle_id, mirror_comment_id')
          .eq('comment_id', entryId)
          .eq('tag', '888');
        return data && data.length === 1 ? data[0] : null;
      },
      {timeout: 15_000},
    )
    .toMatchObject({cattle_id: newCowId, mirror_comment_id: `clog-${entryId}--${newCowId}`});

  // Resolver never touches is_issue.
  const {data: issueAfter} = await supabaseAdmin
    .from('cattle_log_issue_state')
    .select('is_issue')
    .eq('comment_id', entryId)
    .single();
  expect(issueAfter.is_issue).toBe(true);

  // ── 6. New cow's record page shows the mirror ──
  await page.goto('/cattle/herds/' + newCowId);
  await expect(page.locator('[data-cattle-animal-page="1"]')).toBeVisible({timeout: 15_000});
  const mirrorRow = page.locator(`[data-comment-id="clog-${entryId}--${newCowId}"]`);
  await expect(mirrorRow).toBeVisible({timeout: 10_000});
  await expect(mirrorRow).toContainText('New calf');
  await expect(mirrorRow).toContainText('From Cattle Log');

  // ── 7. Log row's unresolved note cleared; entry still an open issue ──
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  const resolvedRow = page.locator(`[data-cattle-log-row="${entryId}"]`);
  await expect(resolvedRow).toBeVisible({timeout: 10_000});
  await expect(resolvedRow.locator('[data-cattle-log-unresolved-note="1"]')).toHaveCount(0);
  await expect(resolvedRow.locator(`[data-cattle-log-issue-toggle="${entryId}"]`)).toBeChecked();
});

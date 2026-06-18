import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle herd small-win — 2026-04-29
// ============================================================================
// Locks the post-build contract:
//   - Calves on the Mommas herd cow tile = SUM(total_born) across calving
//     records, falling back to 1 per record when total_born is null/0.
//     Twins double-count.
//   - Display reads "Calves: N" (always rendered for mommas, including 0).
//   - Heifer auto-promotes to cow on calving record insert via the mig 032
//     trigger. Audit comment with source='calving' is written.
//   - Backfill DO block is callable + idempotent — re-running finds no
//     heifers-with-calvings and adds no new comments.
//
// Pre-flight: mig 032 must be applied to the test project. The migration's
// DO block can't run via exec_sql (same Postgres limitation that hit mig
// 031); apply via Supabase SQL Editor manually.
// ============================================================================

const MOMMA = {
  id: 'cow-momma-001',
  tag: 'M-001',
  sex: 'cow',
  herd: 'mommas',
  breed: 'Angus',
};

const HEIFER = {
  id: 'heifer-test-001',
  tag: 'H-001',
  sex: 'heifer',
  herd: 'mommas',
  breed: 'Angus',
};

const HEIFER_BACKFILL = {
  id: 'heifer-backfill-001',
  tag: 'H-002',
  sex: 'heifer',
  herd: 'mommas',
  breed: 'Angus',
};

// The migration's backfill DO block, callable via exec_sql for the
// idempotency regression test. Mirrors mig 032 lines for the
// FOR ... LOOP — kept inline so the spec doesn't have to re-read the
// migration file. If the migration's backfill shape changes, this
// constant must be updated too.
const BACKFILL_SQL = `
DO $$
DECLARE
  promoted_cow RECORD;
BEGIN
  FOR promoted_cow IN
    SELECT DISTINCT c.id AS cattle_id, c.tag AS cattle_tag
      FROM cattle c
      JOIN cattle_calving_records cr ON cr.dam_tag = c.tag
     WHERE c.sex = 'heifer'
  LOOP
    UPDATE cattle SET sex = 'cow' WHERE id = promoted_cow.cattle_id;

    INSERT INTO cattle_comments (id, cattle_id, cattle_tag, comment, source, reference_id)
    VALUES (
      replace(gen_random_uuid()::text, '-', ''),
      promoted_cow.cattle_id,
      promoted_cow.cattle_tag,
      'Automatically promoted from heifer to cow (backfill 2026-04-29 — existing calving records found).',
      'calving',
      NULL
    );
  END LOOP;
END $$;
`;

// --------------------------------------------------------------------------
// Test 1 — Calf count = SUM(total_born) with twins double-counting
// --------------------------------------------------------------------------
// Codex revision: seed a cow with 2 calving records, one with total_born=2,
// one with total_born=1. Tile must show "Calves: 3" — locking the
// "calves not calvings" rule.
test('momma tile shows Calves: SUM(total_born) — twins double-count', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();

  await supabaseAdmin.from('cattle').upsert(MOMMA, {onConflict: 'id'});
  await supabaseAdmin.from('cattle_calving_records').insert([
    {
      id: 'cr-twins',
      dam_tag: MOMMA.tag,
      calving_date: '2026-01-15',
      total_born: 2,
      deaths: 0,
    },
    {
      id: 'cr-singleton',
      dam_tag: MOMMA.tag,
      calving_date: '2025-04-20',
      total_born: 1,
      deaths: 0,
    },
  ]);

  await page.goto('/cattle/herds');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // The list is always flat now; the momma row renders directly with its
  // Calf Count column (on by default).
  const cowTile = page.locator(`#cow-${MOMMA.id}`).first();
  await expect(cowTile).toBeVisible({timeout: 10_000});

  await expect(cowTile.locator('[data-calf-count]')).toHaveText('3');
  await expect(cowTile.locator('[data-calf-count]')).toHaveAttribute('data-calf-count', '3');
});

// --------------------------------------------------------------------------
// Test 1b — Empty mommas tile renders "Calves: 0"
// --------------------------------------------------------------------------
// Codex: show zero for consistency.
test('momma tile shows Calves: 0 when no calving records', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert({...MOMMA, id: 'cow-zero', tag: 'M-ZERO'}, {onConflict: 'id'});

  await page.goto('/cattle/herds');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  const cowTile = page.locator(`#cow-cow-zero`).first();
  await expect(cowTile).toBeVisible({timeout: 10_000});
  await expect(cowTile.locator('[data-calf-count]')).toHaveText('0');
});

// --------------------------------------------------------------------------
// Test 2 — Trigger promotes heifer + writes auto-promote comment
// --------------------------------------------------------------------------
test('trigger: heifer auto-promotes to cow on calving record insert', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert(HEIFER, {onConflict: 'id'});

  // Insert a calving record. The mig 032 AFTER-INSERT trigger should fire,
  // promoting H-001 to sex='cow' and writing an auto-promote comment.
  const calvingId = 'cr-trigger-test';
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: calvingId,
    dam_tag: HEIFER.tag,
    calving_date: '2026-04-29',
    total_born: 1,
    deaths: 0,
  });

  // Cow row sex should now be 'cow'.
  const {data: cowRow, error: cowErr} = await supabaseAdmin
    .from('cattle')
    .select('id, sex')
    .eq('id', HEIFER.id)
    .maybeSingle();
  expect(cowErr).toBeNull();
  expect(cowRow.sex).toBe('cow');

  // Audit comment with source='calving' AND reference_id=calvingId AND
  // text mentioning "automatically promoted" should exist.
  const {data: comments, error: cErr} = await supabaseAdmin
    .from('cattle_comments')
    .select('*')
    .eq('cattle_id', HEIFER.id)
    .eq('source', 'calving');
  expect(cErr).toBeNull();
  const promoteComment = (comments || []).find((c) => /automatically promoted from heifer to cow/i.test(c.comment));
  expect(promoteComment).toBeTruthy();
  expect(promoteComment.reference_id).toBe(calvingId);
});

// --------------------------------------------------------------------------
// Test 3 — Backfill promotes existing heifer + is idempotent
// --------------------------------------------------------------------------
// Set up a heifer with an existing calving record but sex='heifer' (data
// pre-trigger). The mig 032 backfill should promote her on first run; a
// second run should be a no-op (no new heifers found, no new comments).
test('backfill: promotes existing heifer with calving history; idempotent on re-run', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await supabaseAdmin.from('cattle').upsert(HEIFER_BACKFILL, {onConflict: 'id'});

  // Insert a calving record. The trigger fires and promotes her — undo the
  // promote (UPDATE sex back to 'heifer') so we can test the backfill path
  // independently. This simulates a heifer that existed before mig 032 was
  // applied: a calving record exists, but classification was never updated.
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-backfill-1',
    dam_tag: HEIFER_BACKFILL.tag,
    calving_date: '2026-01-01',
    total_born: 1,
    deaths: 0,
  });
  await supabaseAdmin.from('cattle').update({sex: 'heifer'}).eq('id', HEIFER_BACKFILL.id);

  // Sanity check: she's reset to heifer.
  const before = await supabaseAdmin.from('cattle').select('sex').eq('id', HEIFER_BACKFILL.id).maybeSingle();
  expect(before.data.sex).toBe('heifer');

  // Run the backfill DO block (first time).
  const {error: bf1Err} = await supabaseAdmin.rpc('exec_sql', {sql: BACKFILL_SQL});
  expect(bf1Err).toBeNull();

  // She's been promoted.
  const after1 = await supabaseAdmin.from('cattle').select('sex').eq('id', HEIFER_BACKFILL.id).maybeSingle();
  expect(after1.data.sex).toBe('cow');

  // Count auto-promote comments for her — should be exactly 1 backfill row
  // plus the trigger-generated row from when we first inserted the calving
  // record (the UPDATE to reset sex didn't remove that comment).
  const {data: comments1} = await supabaseAdmin
    .from('cattle_comments')
    .select('*')
    .eq('cattle_id', HEIFER_BACKFILL.id)
    .eq('source', 'calving');
  const backfillCount1 = (comments1 || []).filter((c) => /backfill/i.test(c.comment)).length;
  expect(backfillCount1).toBe(1);

  // Run the backfill again. Idempotent — no new heifers found, no new
  // comments added.
  const {error: bf2Err} = await supabaseAdmin.rpc('exec_sql', {sql: BACKFILL_SQL});
  expect(bf2Err).toBeNull();

  const {data: comments2} = await supabaseAdmin
    .from('cattle_comments')
    .select('*')
    .eq('cattle_id', HEIFER_BACKFILL.id)
    .eq('source', 'calving');
  const backfillCount2 = (comments2 || []).filter((c) => /backfill/i.test(c.comment)).length;
  expect(backfillCount2).toBe(1);
});

// --------------------------------------------------------------------------
// Test 4 — Mig 044: trigger flips breeding_status PREGNANT → OPEN on calving
// --------------------------------------------------------------------------
test('trigger: pregnant cow flips breeding_status to OPEN on calving record insert', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const PREG_COW = {
    id: 'cow-preg-001',
    tag: 'P-001',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    breeding_status: 'PREGNANT',
  };
  await supabaseAdmin.from('cattle').upsert(PREG_COW, {onConflict: 'id'});

  const calvingId = 'cr-bs-trigger-1';
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: calvingId,
    dam_tag: PREG_COW.tag,
    calving_date: '2026-05-04',
    total_born: 1,
    deaths: 0,
  });

  // breeding_status must now be OPEN.
  const {data: after} = await supabaseAdmin
    .from('cattle')
    .select('sex, breeding_status')
    .eq('id', PREG_COW.id)
    .maybeSingle();
  expect(after.sex).toBe('cow');
  expect(after.breeding_status).toBe('OPEN');

  // A calving-source audit comment was written referencing the calving id.
  const {data: comments} = await supabaseAdmin
    .from('cattle_comments')
    .select('*')
    .eq('cattle_id', PREG_COW.id)
    .eq('source', 'calving');
  const flipComment = (comments || []).find(
    (c) => /breeding status set to open on calving record/i.test(c.comment) && c.reference_id === calvingId,
  );
  expect(flipComment).toBeTruthy();
});

// --------------------------------------------------------------------------
// Test 5 — Mig 044: pregnant heifer gets BOTH promote + breeding_status flip
// --------------------------------------------------------------------------
test('trigger: pregnant heifer promotes to cow AND flips PREGNANT → OPEN; both audit comments written', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const PREG_HEIFER = {
    id: 'heifer-preg-001',
    tag: 'PH-001',
    sex: 'heifer',
    herd: 'mommas',
    breed: 'Angus',
    breeding_status: 'PREGNANT',
  };
  await supabaseAdmin.from('cattle').upsert(PREG_HEIFER, {onConflict: 'id'});

  const calvingId = 'cr-bs-trigger-2';
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: calvingId,
    dam_tag: PREG_HEIFER.tag,
    calving_date: '2026-05-04',
    total_born: 1,
    deaths: 0,
  });

  const {data: after} = await supabaseAdmin
    .from('cattle')
    .select('sex, breeding_status')
    .eq('id', PREG_HEIFER.id)
    .maybeSingle();
  expect(after.sex).toBe('cow');
  expect(after.breeding_status).toBe('OPEN');

  const {data: comments} = await supabaseAdmin
    .from('cattle_comments')
    .select('*')
    .eq('cattle_id', PREG_HEIFER.id)
    .eq('source', 'calving');
  const promoteComment = (comments || []).find((c) => /automatically promoted from heifer to cow/i.test(c.comment));
  const flipComment = (comments || []).find((c) => /breeding status set to open on calving record/i.test(c.comment));
  expect(promoteComment).toBeTruthy();
  expect(flipComment).toBeTruthy();
  expect(promoteComment.reference_id).toBe(calvingId);
  expect(flipComment.reference_id).toBe(calvingId);
});

// --------------------------------------------------------------------------
// Test 6 — Mig 044: trigger leaves non-PREGNANT cows alone on calving
// --------------------------------------------------------------------------
test('trigger: cow whose breeding_status is OPEN/null is unchanged on calving insert', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const OPEN_COW = {
    id: 'cow-open-001',
    tag: 'O-001',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    breeding_status: 'OPEN',
  };
  await supabaseAdmin.from('cattle').upsert(OPEN_COW, {onConflict: 'id'});
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-bs-trigger-3',
    dam_tag: OPEN_COW.tag,
    calving_date: '2026-05-04',
    total_born: 1,
    deaths: 0,
  });

  const {data: after} = await supabaseAdmin
    .from('cattle')
    .select('breeding_status')
    .eq('id', OPEN_COW.id)
    .maybeSingle();
  expect(after.breeding_status).toBe('OPEN');

  // No "Breeding status set to OPEN" audit comment because nothing flipped.
  const {data: comments} = await supabaseAdmin
    .from('cattle_comments')
    .select('*')
    .eq('cattle_id', OPEN_COW.id)
    .eq('source', 'calving');
  const flipComment = (comments || []).find((c) => /breeding status set to open/i.test(c.comment));
  expect(flipComment).toBeFalsy();
});

// --------------------------------------------------------------------------
// Test 7 — Mig 044 backfill: existing PREGNANT cow with calving record →
// flipped to OPEN with backfill audit comment; idempotent on re-run.
// --------------------------------------------------------------------------
const BREEDING_BACKFILL_SQL = `
DO $$
DECLARE
  flipped_cow RECORD;
BEGIN
  FOR flipped_cow IN
    SELECT DISTINCT c.id AS cattle_id, c.tag AS cattle_tag
      FROM cattle c
      JOIN cattle_calving_records cr ON cr.dam_tag = c.tag
     WHERE c.breeding_status = 'PREGNANT'
       AND NOT EXISTS (
         SELECT 1 FROM cattle_comments cc
          WHERE cc.cattle_id = c.id
            AND cc.source = 'calving'
            AND cc.comment LIKE 'Breeding status set to OPEN%'
       )
  LOOP
    UPDATE cattle SET breeding_status = 'OPEN' WHERE id = flipped_cow.cattle_id;

    INSERT INTO cattle_comments (id, cattle_id, cattle_tag, comment, source, reference_id)
    VALUES (
      replace(gen_random_uuid()::text, '-', ''),
      flipped_cow.cattle_id,
      flipped_cow.cattle_tag,
      'Breeding status set to OPEN (backfill 2026-05-04 — existing calving records found).',
      'calving',
      NULL
    );
  END LOOP;
END $$;
`;

test('backfill: pregnant cow with calving history flips to OPEN; idempotent', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const COW = {
    id: 'cow-bf-preg-001',
    tag: 'BF-001',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    breeding_status: 'PREGNANT',
  };
  await supabaseAdmin.from('cattle').upsert(COW, {onConflict: 'id'});
  await supabaseAdmin.from('cattle_calving_records').insert({
    id: 'cr-bs-backfill-1',
    dam_tag: COW.tag,
    calving_date: '2026-01-01',
    total_born: 1,
    deaths: 0,
  });
  // Trigger fires and flips her — undo so we can exercise the backfill path.
  await supabaseAdmin.from('cattle').update({breeding_status: 'PREGNANT'}).eq('id', COW.id);
  // Also remove the trigger-generated 'set to OPEN' comment so the backfill
  // guard sees her as un-flipped.
  await supabaseAdmin
    .from('cattle_comments')
    .delete()
    .eq('cattle_id', COW.id)
    .like('comment', 'Breeding status set to OPEN%');

  // Sanity: she's PREGNANT again with no flip-comment.
  const before = await supabaseAdmin.from('cattle').select('breeding_status').eq('id', COW.id).maybeSingle();
  expect(before.data.breeding_status).toBe('PREGNANT');

  // Run the backfill.
  const {error: bf1Err} = await supabaseAdmin.rpc('exec_sql', {sql: BREEDING_BACKFILL_SQL});
  expect(bf1Err).toBeNull();

  const after1 = await supabaseAdmin.from('cattle').select('breeding_status').eq('id', COW.id).maybeSingle();
  expect(after1.data.breeding_status).toBe('OPEN');

  const {data: comments1} = await supabaseAdmin
    .from('cattle_comments')
    .select('*')
    .eq('cattle_id', COW.id)
    .eq('source', 'calving');
  const backfillComments1 = (comments1 || []).filter((c) => /\(backfill 2026-05-04/i.test(c.comment));
  expect(backfillComments1.length).toBe(1);

  // Re-run — idempotent: no new flip, no new comment.
  const {error: bf2Err} = await supabaseAdmin.rpc('exec_sql', {sql: BREEDING_BACKFILL_SQL});
  expect(bf2Err).toBeNull();

  const {data: comments2} = await supabaseAdmin
    .from('cattle_comments')
    .select('*')
    .eq('cattle_id', COW.id)
    .eq('source', 'calving');
  const backfillComments2 = (comments2 || []).filter((c) => /\(backfill 2026-05-04/i.test(c.comment));
  expect(backfillComments2.length).toBe(1);
});

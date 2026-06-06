import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const forecastSrc = fs.readFileSync(path.join(ROOT, 'src/lib/cattleForecast.js'), 'utf8');
const batchesViewSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBatchesView.jsx'), 'utf8');
const batchPageSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBatchPage.jsx'), 'utf8');
const sendModalSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleSendToProcessorModal.jsx'), 'utf8');
const processingHelperSrc = fs.readFileSync(path.join(ROOT, 'src/lib/cattleProcessingBatch.js'), 'utf8');
const migrationPath = path.join(ROOT, 'supabase-migrations/054_cattle_processing_scheduled_status.sql');

// ============================================================================
// Migration 054 lands the 'scheduled' status enum.
// ============================================================================

describe('Migration 054 — cattle_processing_batches.status accepts scheduled', () => {
  it('migration file exists at supabase-migrations/054_*.sql', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration drops the old CHECK and adds active/complete/scheduled', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS cattle_processing_batches_status_check/);
    expect(sql).toMatch(
      /ADD CONSTRAINT cattle_processing_batches_status_check\s*CHECK \(status IN \('active', 'complete', 'scheduled'\)\)/,
    );
    // Transaction bracketing (BEGIN/COMMIT) with the DDL inside.
    expect(sql).toMatch(/BEGIN;[\s\S]*ADD CONSTRAINT[\s\S]*COMMIT;/);
    // No DDL on other tables, no RLS rewrites, no DEFAULT change.
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/ALTER POLICY/);
    expect(sql).not.toMatch(/ALTER COLUMN status SET DEFAULT/);
  });
});

// ============================================================================
// buildForecast splits scheduled rows from active+complete.
// ============================================================================

describe('cattleForecast.buildForecast — scheduled split', () => {
  it('accepts a scheduledBatches param distinct from realBatches', () => {
    expect(forecastSrc).toMatch(/scheduledBatches\s*=\s*\[\]/);
    expect(forecastSrc).toMatch(/realBatches\s*=\s*\[\]/);
  });

  it('attaches scheduled rows to bucket.scheduledBatches, not actualBatches', () => {
    // Defensive filter: scheduled rows never land in actualBatches even
    // if a caller leaks them into realBatches.
    expect(forecastSrc).toMatch(/if \(rb\.status === 'scheduled'\) continue;/);
    // scheduledBatches loop pushes onto bucket.scheduledBatches.
    expect(forecastSrc).toMatch(/for \(const sb of scheduledBatches \|\| \[\]\)/);
    expect(forecastSrc).toMatch(/bucket\.scheduledBatches\.push\(sb\)/);
  });

  it('virtual batches are suppressed for months that already have a scheduled row', () => {
    expect(forecastSrc).toMatch(
      /virtualMonths\s*=\s*monthBuckets\.filter\([\s\S]*?scheduledBatches \|\| \[\]\)\.length === 0/,
    );
  });

  it('buildVirtualBatchNames assigns chronologically — scheduled rows reserve slots but never push earlier virtuals', () => {
    // Codex 2026-05-12 correction: real batches set the per-year cursor
    // FLOOR (realMax + 1), but scheduled rows are only a reservation set
    // the cursor skips over while walking chronologically. A later
    // scheduled C-26-03 must not bump May/June virtual numbers.
    const fn = forecastSrc.match(
      /export function buildVirtualBatchNames\(\{realBatches, scheduledBatches = \[\][\s\S]*?\n {2}return out;\s*\n\}/,
    );
    expect(fn, 'expected buildVirtualBatchNames body').not.toBeNull();
    expect(fn[0]).toMatch(/scheduledReservedByYear/);
    expect(fn[0]).toMatch(/const realMax = highestStoredNumberForYear\(realBatches, yy\);/);
    expect(fn[0]).toMatch(/next = realMax \+ 1/);
    expect(fn[0]).toMatch(/while \(reserved\.has\(next\)\) next \+= 1/);
    // The legacy "max-of-real-and-scheduled" floor that allowed late-
    // scheduled rows to push earlier virtuals upward must be gone from
    // this body. (Math.max(realMax, schedMax) still lives inside
    // nextRealBatchName, which has different semantics.)
    expect(fn[0]).not.toMatch(/Math\.max\(realMax, schedMax\)/);
  });

  it('nextProcessorBatch chronologically merges scheduled + virtual cohorts', () => {
    expect(forecastSrc).toMatch(/candidatePool/);
    expect(forecastSrc).toMatch(/source:\s*'scheduled'/);
    expect(forecastSrc).toMatch(/source:\s*'virtual'/);
    // The pool is sorted by monthKey ascending so the earliest in-line
    // cohort wins, regardless of whether it's scheduled or virtual.
    expect(forecastSrc).toMatch(
      /candidatePool\.sort\(\(a, b\) => \(a\.monthKey \|\| ''\)\.localeCompare\(b\.monthKey \|\| ''\)\)/,
    );
    expect(forecastSrc).toMatch(/scheduledId/);
  });

  it('nextRealBatchName takes scheduledBatches into account so new names skip reserved slots', () => {
    expect(forecastSrc).toMatch(
      /export function nextRealBatchName\(realBatches, processingDateISO, scheduledBatches = \[\]\)/,
    );
    expect(forecastSrc).toMatch(/Math\.max\(realMax, schedMax\) \+ 1/);
  });

  it('buildForecast returns scheduledBatches alongside virtualBatches', () => {
    expect(forecastSrc).toMatch(
      /return \{\s*summary,\s*monthBuckets,\s*animalRows,\s*watchlist,\s*virtualBatches,\s*scheduledBatches:\s*scheduledBatchesEnriched/,
    );
  });

  it('eligibility is still driven by cattle.herd — scheduled never touches it', () => {
    // The scheduledBatches loop only mutates bucket.scheduledBatches, not
    // cattle, not animalRows, not includesSet.
    const schedLoop = forecastSrc.match(
      /for \(const sb of scheduledBatches \|\| \[\]\)[\s\S]*?bucket\.scheduledBatches\.push\(sb\);\s*\}/,
    );
    expect(schedLoop, 'expected scheduledBatches attach loop').not.toBeNull();
    expect(schedLoop[0]).not.toMatch(/cattle\.herd/);
    expect(schedLoop[0]).not.toMatch(/processing_batch_id/);
    expect(schedLoop[0]).not.toMatch(/animalRows/);
  });
});

// ============================================================================
// CattleBatchesView — 4 sections + Schedule + Unschedule (no destructive
// surprises) + UI "Processed" while DB stays 'complete'.
// ============================================================================

describe('CattleBatchesView — Planned / Scheduled / Active / Processed', () => {
  it('passes realBatches (active+complete only) and scheduledBatches separately to buildForecast', () => {
    expect(batchesViewSrc).toMatch(
      /realBatchesOnly = batches\.filter\(\(b\) => b\.status === 'active' \|\| b\.status === 'complete'\)/,
    );
    expect(batchesViewSrc).toMatch(/scheduledBatchesOnly = batches\.filter\(\(b\) => b\.status === 'scheduled'\)/);
    expect(batchesViewSrc).toMatch(/realBatches:\s*realBatchesOnly/);
    expect(batchesViewSrc).toMatch(/scheduledBatches:\s*scheduledBatchesOnly/);
  });

  it('renders a Scheduled section anchor when at least one scheduled row exists', () => {
    expect(batchesViewSrc).toMatch(/data-scheduled-section/);
    expect(batchesViewSrc).toMatch(/data-scheduled-batch=\{sb2\.name\}/);
  });

  it('Schedule action is only offered when canEdit and writes status=scheduled with empty cows_detail', () => {
    expect(batchesViewSrc).toMatch(/async function scheduleVirtualBatch\(vb\)/);
    const fn = batchesViewSrc.match(/async function scheduleVirtualBatch\(vb\)[\s\S]*?\}\s*\n\n {2}const active/);
    expect(fn, 'expected scheduleVirtualBatch helper').not.toBeNull();
    expect(fn[0]).toMatch(/if \(!canEdit\) return;/);
    expect(fn[0]).toMatch(/status:\s*'scheduled'/);
    expect(fn[0]).toMatch(/cows_detail:\s*\[\]/);
    // The schedule path must NOT update cattle herd or processing_batch_id.
    expect(fn[0]).not.toMatch(/from\('cattle'\)\.update/);
  });

  it('Unschedule uses a guarded inline warning and only deletes scheduled rows (record page)', () => {
    expect(batchPageSrc).toMatch(/async function handleUnschedule\(\)/);
    expect(batchPageSrc).toMatch(/status !== 'scheduled'/);
    // The handleUnschedule function guards on scheduled status before deleting.
    expect(batchPageSrc).toMatch(/handleUnschedule[\s\S]*?status !== 'scheduled'[\s\S]*?\.delete\(\)/);
    // Inline two-step pattern: warning toggled via unscheduling state,
    // confirmed via Confirm unschedule button. No window.confirm.
    expect(batchPageSrc).toMatch(/data-scheduled-batch-unschedule=/);
    expect(batchPageSrc).toMatch(/data-scheduled-batch-unschedule-warning=/);
    expect(batchPageSrc).toMatch(/data-scheduled-batch-unschedule-cancel=/);
    expect(batchPageSrc).toMatch(/data-scheduled-batch-unschedule-confirm=/);
    expect(batchPageSrc).not.toMatch(/window\.confirm/);
    // Codex's required label: "Unschedule", not "Delete".
    expect(batchPageSrc).toContain('Unschedule');
    expect(batchPageSrc).toContain('Confirm unschedule');
  });

  it('UI surfaces "Processed" while DB storage value stays complete', () => {
    expect(batchesViewSrc).toMatch(/Show Processed Batches/);
    expect(batchesViewSrc).toMatch(/dataKey="processed"/);
    // The completed filter still uses status === 'complete'; storage
    // value is unchanged.
    expect(batchesViewSrc).toMatch(/completed = batches\.filter\(\(b\) => b\.status === 'complete'\)/);
  });
});

// ============================================================================
// Send-to-Processor promote-or-create
// ============================================================================

describe('CattleSendToProcessorModal — promote-or-create', () => {
  it('loads forecast with realBatches and scheduledBatches split', () => {
    expect(sendModalSrc).toMatch(
      /realBatches = allBatches\.filter\(\(b\) => b\.status === 'active' \|\| b\.status === 'complete'\)/,
    );
    expect(sendModalSrc).toMatch(/scheduledBatches = allBatches\.filter\(\(b\) => b\.status === 'scheduled'\)/);
  });

  it('promotes a scheduled row to active when nextProcessorBatch.source === "scheduled"', () => {
    expect(sendModalSrc).toMatch(/promoteScheduledBatch/);
    expect(sendModalSrc).toMatch(/if \(next\.source === 'scheduled' && next\.scheduledId\)/);
    expect(sendModalSrc).toMatch(
      /batch = await promoteScheduledBatch\(sb, scheduledRow, \{processingDate: sessionDate\}\)/,
    );
  });

  it('falls back to createProcessingBatch when no scheduled row exists', () => {
    expect(sendModalSrc).toMatch(/batch = await createProcessingBatch\(sb,\s*\{/);
  });

  it('routes authenticated attach through RPC while keeping the legacy helper fallback', () => {
    expect(sendModalSrc).toContain('useAttachRpc = false');
    expect(sendModalSrc).toMatch(/if \(useAttachRpc\)/);
    expect(sendModalSrc).toContain('attachCattleToProcessingBatch');
    expect(sendModalSrc).toMatch(/attachEntriesToBatch\(sb,\s*\{/);
  });

  it('outside-projection tags are a warning, not a hard block, when next batch exists', () => {
    // hardBlocked is false when reason is tags_outside_next_batch — the
    // amber data-send-modal-outside-tags panel renders and Confirm stays
    // enabled. Tolerant of Prettier wrapping across lines.
    expect(sendModalSrc).toMatch(
      /hardBlocked\s*=[\s\S]*?!hasNextBatch[\s\S]*?gate\.reason !== 'tags_outside_next_batch'/,
    );
    expect(sendModalSrc).toMatch(/data-send-modal-outside-tags/);
    expect(sendModalSrc).not.toMatch(/data-send-modal-blocked/);
  });

  it('empty_next_batch is a warning when the next batch is scheduled', () => {
    // Codex 2026-05-12 round 2: a scheduled row with zero projected
    // cattle still allows Send-to-Processor through. The actual sent
    // cattle override projection.
    expect(sendModalSrc).toMatch(/isScheduledNext\s*=\s*hasNextBatch && next\.source === 'scheduled'/);
    expect(sendModalSrc).toMatch(
      /isEmptyScheduled\s*=\s*isScheduledNext && !gate\.ok && gate\.reason === 'empty_next_batch'/,
    );
    // hardBlocked excludes the empty-scheduled case.
    expect(sendModalSrc).toMatch(/gate\.reason !== 'tags_outside_next_batch'[\s\S]*?!isEmptyScheduled/);
    // Warning copy references the scheduled-empty case.
    expect(sendModalSrc).toMatch(/no projected cattle for this scheduled batch/);
    expect(sendModalSrc).toMatch(/No cattle are currently projected for this scheduled batch/);
  });
});

// ============================================================================
// cattleProcessingBatch helper — promoteScheduledBatch contract
// ============================================================================

describe('cattleProcessingBatch.promoteScheduledBatch', () => {
  it('exists and refuses non-scheduled rows', () => {
    expect(processingHelperSrc).toMatch(
      /export async function promoteScheduledBatch\(sb, scheduledRow, \{processingDate\}\)/,
    );
    expect(processingHelperSrc).toMatch(/scheduledRow\.status !== 'scheduled'/);
  });

  it('writes status=active and actual_process_date, keeping name and id intact', () => {
    const fn = processingHelperSrc.match(
      /export async function promoteScheduledBatch[\s\S]*?return \{\.\.\.scheduledRow, \.\.\.update\};\s*\}/,
    );
    expect(fn, 'expected promoteScheduledBatch body').not.toBeNull();
    expect(fn[0]).toMatch(/status:\s*'active'/);
    expect(fn[0]).toMatch(/actual_process_date:\s*processingDate/);
    // No name or id rewrite — the scheduled row's name reservation stays.
    expect(fn[0]).not.toMatch(/name:/);
    expect(fn[0]).not.toMatch(/id:/);
  });
});
